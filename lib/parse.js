import { SESSION_REFERENCE_SCHEME, parseSessionReferenceText } from './mention.js';
const BARE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const POSITIVE_INT_PATTERN = /^[0-9]+$/;
/** 可转发的消息类型短名；--kind 只吸收这些词，其余留给说明文字。 */
const PICK_KIND_WORDS = ['user', 'assistant', 'tool-result', 'tool-call', 'summary'];
/** 紧贴当前位置的整枚 mention，用于容纳标签内部的空格。 */
const MENTION_TOKEN_PATTERN = /@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)/uy;
const USAGE_HINT = '用法：/ref [--draft|--send] <会话 id 或 dsh-session: 引用> ... [说明]；' +
    '列举消息用 /ref <会话 id> --list [--limit N] [--before SEQ] [--after SEQ]；' +
    '转发指定消息用 /ref <会话 id> --pick <seq>... [--kind 短名,...] [--compact]';
const LIST_ONLY_FLAGS = '开关 --limit / --before / --after 只能与 --list 一起使用。';
function isSpace(char) {
    return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v' || char === '\u00a0' || char === '\u3000';
}
function skipSpaces(input, from) {
    let index = from;
    while (index < input.length && isSpace(input[index]))
        index += 1;
    return index;
}
function readWordEnd(input, from) {
    let index = from;
    while (index < input.length && !isSpace(input[index]))
        index += 1;
    return index;
}
function classifyWord(word) {
    if (word.startsWith(SESSION_REFERENCE_SCHEME))
        return 'uri';
    if (BARE_ID_PATTERN.test(word))
        return 'bare';
    return undefined;
}
/** 正整数（1 及以上），非法时返回 undefined。 */
function parsePositiveInt(word) {
    if (!POSITIVE_INT_PATTERN.test(word))
        return undefined;
    const value = Number.parseInt(word, 10);
    if (!Number.isSafeInteger(value) || value <= 0)
        return undefined;
    return value;
}
/** 返回整枚 mention 的结束位置；不是可解析的 mention 时返回起始位置。 */
function matchMentionEnd(input, start) {
    if (input[start] !== '@' || input[start + 1] !== '[')
        return start;
    MENTION_TOKEN_PATTERN.lastIndex = start;
    const matched = MENTION_TOKEN_PATTERN.exec(input);
    if (matched === null)
        return start;
    const end = start + matched[0].length;
    if (end < input.length && !isSpace(input[end]))
        return start;
    try {
        if (parseSessionReferenceText(matched[0]).references.length === 0)
            return start;
    }
    catch {
        return start;
    }
    return end;
}
/** 模式开关（--draft / --send）的互斥与重复检查，命中错误时返回错误文案。 */
function checkModeFlag(mode, word) {
    if (mode === undefined)
        return undefined;
    const flagMode = word === '--draft' ? 'draft' : 'send';
    const reason = mode === flagMode ? '开关 ' + word + ' 重复给出' : '--draft 与 --send 互斥';
    return reason + '。' + USAGE_HINT;
}
export function parseRefInput(rawInput) {
    const input = typeof rawInput === 'string' ? rawInput.trim() : '';
    let mode;
    let position = 0;
    for (;;) {
        const start = skipSpaces(input, position);
        const end = readWordEnd(input, start);
        const word = input.slice(start, end);
        if (word !== '--draft' && word !== '--send')
            break;
        const error = checkModeFlag(mode, word);
        if (error !== undefined)
            return { ok: false, error };
        mode = word === '--draft' ? 'draft' : 'send';
        position = end;
    }
    const tokens = [];
    for (;;) {
        const start = skipSpaces(input, position);
        if (start >= input.length) {
            position = start;
            break;
        }
        const mentionEnd = matchMentionEnd(input, start);
        if (mentionEnd > start) {
            tokens.push({ raw: input.slice(start, mentionEnd), kind: 'mention' });
            position = mentionEnd;
            continue;
        }
        const end = readWordEnd(input, start);
        const word = input.slice(start, end);
        const kind = classifyWord(word);
        if (kind === undefined) {
            position = start;
            break;
        }
        tokens.push({ raw: word, kind });
        position = end;
    }
    // 引用 token 之后的新开关。它们在说明文字之前结束，之后的原文一律归入说明。
    let list;
    let pendingLimit;
    let pendingBefore;
    let pendingAfter;
    let pick;
    let kinds;
    let compact;
    for (;;) {
        const start = skipSpaces(input, position);
        if (start >= input.length) {
            position = start;
            break;
        }
        const end = readWordEnd(input, start);
        const word = input.slice(start, end);
        if (!word.startsWith('--')) {
            position = start;
            break;
        }
        if (word === '--draft' || word === '--send') {
            const error = checkModeFlag(mode, word);
            if (error !== undefined)
                return { ok: false, error };
            mode = word === '--draft' ? 'draft' : 'send';
            position = end;
            continue;
        }
        if (word === '--list') {
            if (list !== undefined)
                return { ok: false, error: '开关 --list 重复给出。' + USAGE_HINT };
            list = {};
            position = end;
            continue;
        }
        if (word === '--compact') {
            if (compact !== undefined)
                return { ok: false, error: '开关 --compact 重复给出。' + USAGE_HINT };
            compact = true;
            position = end;
            continue;
        }
        if (word === '--kind') {
            if (kinds !== undefined)
                return { ok: false, error: '开关 --kind 重复给出。' + USAGE_HINT };
            // 零参数即使用默认类型；多参数可空格或逗号分隔。
            // 只吸收已知短名，遇到 -- 开关或非类型词就停，剩下的留给说明文字。
            const collected = [];
            position = end;
            for (;;) {
                const valueStart = skipSpaces(input, position);
                if (valueStart >= input.length) {
                    position = valueStart;
                    break;
                }
                const valueEnd = readWordEnd(input, valueStart);
                const value = input.slice(valueStart, valueEnd);
                if (value.startsWith('--')) {
                    position = valueStart;
                    break;
                }
                const parts = value
                    .split(',')
                    .map((part) => part.trim())
                    .filter((part) => part !== '');
                if (parts.length === 0) {
                    position = valueStart;
                    break;
                }
                const unknown = parts.filter((part) => !PICK_KIND_WORDS.includes(part));
                if (unknown.length > 0) {
                    // 第一个词就不认识时视为拼写错误并报错，避免静默忽略。
                    if (collected.length === 0) {
                        return {
                            ok: false,
                            error: '未知的消息类型短名 ' +
                                JSON.stringify(unknown[0]) +
                                '。可用：' +
                                PICK_KIND_WORDS.join(' / ') +
                                '。' +
                                USAGE_HINT,
                        };
                    }
                    position = valueStart;
                    break;
                }
                collected.push(...parts);
                position = valueEnd;
            }
            kinds = collected;
            continue;
        }
        if (word === '--limit' || word === '--before' || word === '--after') {
            const repeated = (word === '--limit' ? pendingLimit : word === '--before' ? pendingBefore : pendingAfter) !== undefined;
            if (repeated)
                return { ok: false, error: '开关 ' + word + ' 重复给出。' + USAGE_HINT };
            const valueStart = skipSpaces(input, end);
            const valueEnd = readWordEnd(input, valueStart);
            const value = input.slice(valueStart, valueEnd);
            const seq = parsePositiveInt(value);
            if (seq === undefined) {
                const shown = value === '' ? '（缺失）' : JSON.stringify(value);
                return { ok: false, error: '开关 ' + word + ' 需要一个正整数，收到 ' + shown + '。' + USAGE_HINT };
            }
            if (word === '--limit')
                pendingLimit = seq;
            else if (word === '--before')
                pendingBefore = seq;
            else
                pendingAfter = seq;
            position = valueEnd;
            continue;
        }
        if (word === '--pick') {
            if (pick !== undefined)
                return { ok: false, error: '开关 --pick 重复给出。' + USAGE_HINT };
            const picked = [];
            let cursor = end;
            for (;;) {
                const valueStart = skipSpaces(input, cursor);
                const valueEnd = readWordEnd(input, valueStart);
                const value = input.slice(valueStart, valueEnd);
                if (!POSITIVE_INT_PATTERN.test(value))
                    break;
                const seq = parsePositiveInt(value);
                if (seq === undefined) {
                    return { ok: false, error: '开关 --pick 的序号必须是正整数，收到 ' + JSON.stringify(value) + '。' + USAGE_HINT };
                }
                picked.push(seq);
                cursor = valueEnd;
            }
            if (picked.length === 0) {
                return { ok: false, error: '开关 --pick 之后至少要有一个消息序号，例如 --pick 12 13。' + USAGE_HINT };
            }
            pick = picked;
            position = cursor;
            continue;
        }
        return { ok: false, error: '未知开关 ' + word + '。' + USAGE_HINT };
    }
    const note = input.slice(position).trim();
    if (list !== undefined && pick !== undefined) {
        return { ok: false, error: '--list 与 --pick 互斥，列举与转发请只选一种。' + USAGE_HINT };
    }
    if (list !== undefined && mode !== undefined) {
        return { ok: false, error: '--list 与 --draft / --send 互斥，列举模式不会转发任何内容。' + USAGE_HINT };
    }
    if (pendingLimit !== undefined || pendingBefore !== undefined || pendingAfter !== undefined) {
        if (list === undefined)
            return { ok: false, error: LIST_ONLY_FLAGS + USAGE_HINT };
        if (pendingLimit !== undefined)
            list.limit = pendingLimit;
        if (pendingBefore !== undefined)
            list.before = pendingBefore;
        if (pendingAfter !== undefined)
            list.after = pendingAfter;
    }
    if (tokens.length === 0) {
        return { ok: false, error: '没有识别到会话引用。' + USAGE_HINT + '。例：/ref sess-1 这个会话里的构建脚本' };
    }
    // 只有真正给出过的开关才落到返回结构上，保持旧调用方看到的形状不变。
    const parsed = { ok: true, mode, tokens, note };
    if (list !== undefined)
        parsed.list = list;
    if (pick !== undefined)
        parsed.pick = pick;
    if (kinds !== undefined)
        parsed.kinds = kinds;
    if (compact !== undefined)
        parsed.compact = compact;
    return parsed;
}
