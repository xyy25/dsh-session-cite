import { SESSION_REFERENCE_SCHEME, parseSessionReferenceText } from './mention.js';

/** /ref 的参数解析：先吸收模式开关，再吸收连续的引用 token，其余原文作为说明。 */

export type RefTokenKind = 'bare' | 'uri' | 'mention';

export type RefToken = { raw: string; kind: RefTokenKind };

export type ParsedRefInput =
  | { ok: true; mode?: 'send' | 'draft'; tokens: RefToken[]; note: string }
  | { ok: false; error: string };

const BARE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** 紧贴当前位置的整枚 mention，用于容纳标签内部的空格。 */
const MENTION_TOKEN_PATTERN = /@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)/uy;

const USAGE_HINT = '用法：/ref [--draft|--send] <会话 id 或 dsh-session: 引用> ... [说明]';

function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v' || char === '\u00a0' || char === '\u3000';
}

function skipSpaces(input: string, from: number): number {
  let index = from;
  while (index < input.length && isSpace(input[index])) index += 1;
  return index;
}

function readWordEnd(input: string, from: number): number {
  let index = from;
  while (index < input.length && !isSpace(input[index])) index += 1;
  return index;
}

function classifyWord(word: string): RefTokenKind | undefined {
  if (word.startsWith(SESSION_REFERENCE_SCHEME)) return 'uri';
  if (BARE_ID_PATTERN.test(word)) return 'bare';
  return undefined;
}

/** 返回整枚 mention 的结束位置；不是可解析的 mention 时返回起始位置。 */
function matchMentionEnd(input: string, start: number): number {
  if (input[start] !== '@' || input[start + 1] !== '[') return start;
  MENTION_TOKEN_PATTERN.lastIndex = start;
  const matched = MENTION_TOKEN_PATTERN.exec(input);
  if (matched === null) return start;
  const end = start + matched[0].length;
  if (end < input.length && !isSpace(input[end])) return start;
  try {
    if (parseSessionReferenceText(matched[0]).references.length === 0) return start;
  } catch {
    return start;
  }
  return end;
}

export function parseRefInput(rawInput: string): ParsedRefInput {
  const input = typeof rawInput === 'string' ? rawInput.trim() : '';
  let mode: 'send' | 'draft' | undefined;
  let position = 0;

  for (;;) {
    const start = skipSpaces(input, position);
    const end = readWordEnd(input, start);
    const word = input.slice(start, end);
    if (word !== '--draft' && word !== '--send') break;
    const flagMode = word === '--draft' ? 'draft' : 'send';
    if (mode !== undefined) {
      const reason = mode === flagMode ? '开关 ' + word + ' 重复给出' : '--draft 与 --send 互斥';
      return { ok: false, error: reason + '。' + USAGE_HINT };
    }
    mode = flagMode;
    position = end;
  }

  const tokens: RefToken[] = [];
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

  const note = input.slice(position).trim();
  if (tokens.length === 0) {
    return { ok: false, error: '没有识别到会话引用。' + USAGE_HINT + '。例：/ref sess-1 这个会话里的构建脚本' };
  }
  return { ok: true, mode, tokens, note };
}
