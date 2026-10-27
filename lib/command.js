import { formatSessionReferenceMention } from './mention.js';
import { createUserMessage } from './message.js';
import { formatMessageReferenceMention } from './message-reference.js';
import { listMessageEvents, normalizePickKinds, previewMessages, readMessages } from './messages.js';
import { parseRefInput } from './parse.js';
import { buildRefMessage, DEFAULT_GUIDANCE, renderForwardedMessages, renderMessageList } from './render.js';
import { summarizeMessages } from './summarize.js';
import { resolveTargets } from './targets.js';
/** /ref 命令的执行链路：解析参数 → 分派到会话级 / 消息级 / 列表三条路径。 */
export const REF_COMMAND_NAME = 'ref';
export const REF_DESCRIPTION = '把另一个会话（或其中的指定消息）作为只读引用带入本轮对话；支持压缩摘要与分页浏览。';
export const REF_INPUT_HINT = '用法：/ref [--draft|--send] <会话 id> [--list [--limit N] [--before/--after SEQ]] [--pick <seq>...] [--compact] [说明]';
/** 消息级列表的默认窗口与上限。 */
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 50;
/** --list 默认只列对话消息；想看工具往来需显式 --kind 放开。 */
const LIST_DEFAULT_KINDS = ['user', 'assistant'];
/** chip 上摘要的最大字符数：比 --list 的 40 更短，一条草稿放多个 chip 才不臃肿。 */
const CHIP_SUMMARY_LIMIT = 18;
/**
 * 生成 chip 标签：#序号 类型 · 摘要。
 * 摘要与 --list 同口径（tool-call 取参数要点、tool-result 跳过噪音行取代表行），
 * 只是截得更短。
 * @param item - 已读取的消息条目。
 * @returns chip 显示文本。
 */
function chipLabel(item) {
    const head = '#' + item.seq + ' ' + item.kind;
    let summary = typeof item.summary === 'string' ? item.summary.trim() : '';
    // tool-call 摘要自带「工具 xxx：」前缀，与 chip 的类型标重复；去掉「工具 」保留工具名。
    if (summary.startsWith('工具 '))
        summary = summary.slice(3);
    if (summary === '')
        return head;
    const chars = Array.from(summary);
    const clipped = chars.length <= CHIP_SUMMARY_LIMIT ? summary : chars.slice(0, CHIP_SUMMARY_LIMIT).join('') + '…';
    return head + ' · ' + clipped;
}
/**
 * 把 ASCII 折合权重渲染成便于阅读的文案：1/4 用分数，其余用小数。
 * @param weight - 配置的权重。
 * @returns 文案片段。
 */
function describeWeight(weight) {
    if (Math.abs(weight - 0.25) < 1e-9)
        return '1/4';
    if (Math.abs(weight - 0.5) < 1e-9)
        return '1/2';
    if (Math.abs(weight - 1) < 1e-9)
        return '1';
    return String(weight);
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 取会话 id 的缩略形式（去掉 session- 前缀取前 8 位），用于显示区分同标题会话。 */
function shortenSessionId(sessionId) {
    return sessionId.replace(/^session-/u, '').slice(0, 8);
}
/** 夹紧分页窗口大小。 */
function clampLimit(raw) {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0)
        return LIST_DEFAULT_LIMIT;
    return Math.min(raw, LIST_MAX_LIMIT);
}
function errorResult(text) {
    return { kind: 'error', text };
}
/**
 * --list：按原始日志列出该会话可转发的消息，分页返回。
 * 用原始日志而非 surface，压缩前的旧消息同样可见。
 */
async function executeList(deps, invocation, parsed) {
    if (deps.sessionQuery === undefined) {
        return errorResult('当前 profile 未启用会话查询，无法列出消息。会话级引用（不带 --list）仍然可用。');
    }
    const resolved = await resolveTargets({
        agentId: invocation.agent.id,
        tokens: parsed.tokens,
        maxReferences: deps.config.maxReferences,
        listCandidates: deps.listCandidates,
        // --list 只读日志，引用自己也无害（看本会话的消息清单）。
        allowSelf: true,
    });
    if (!resolved.ok)
        return errorResult(resolved.error);
    if (resolved.refs.length !== 1) {
        return errorResult('--list 只支持单个会话，请给出一个会话 id。');
    }
    const ref = resolved.refs[0];
    // 类型过滤：--kind 显式给出则用它，零参数或不给则默认只列对话消息（user + assistant）。
    const listKinds = parsed.kinds !== undefined && parsed.kinds.length > 0
        ? normalizePickKinds(parsed.kinds)
        : LIST_DEFAULT_KINDS;
    let rows;
    try {
        // forwardable 仍由配置的 pickKinds 决定；本次列出的范围由 listKinds 决定。
        rows = await listMessageEvents(deps.sessionQuery, ref.id, deps.config.pickKinds);
    }
    catch (error) {
        return errorResult('读取会话事件失败：' + messageOf(error) + '。请稍后重试。');
    }
    rows = rows.filter((row) => listKinds.includes(row.kind));
    if (rows.length === 0) {
        return errorResult('会话「' + ref.label + '」里没有可转发的消息（可用 pickKinds 放开更多类型）。');
    }
    const limit = clampLimit(parsed.list.limit);
    const before = parsed.list.before;
    const after = parsed.list.after;
    let pool = rows;
    if (typeof after === 'number')
        pool = pool.filter((row) => row.seq > after);
    if (typeof before === 'number')
        pool = pool.filter((row) => row.seq < before);
    if (pool.length === 0) {
        return errorResult('该窗口内没有可转发的消息（共 ' + rows.length + ' 条，seq ' + rows[0].seq + '–' + rows[rows.length - 1].seq + '）。');
    }
    // 空内容条目（纯工具调用的 assistant 轮次、无正文的注入型 user 消息）会在补预览后剔除。
    // 因此先取更宽的候选池，剔除后再装满一页 —— 否则一页可能被工具调用占满，看不到对话正文。
    const forward = typeof after === 'number';
    const candidateLimit = Math.min(limit * 2, LIST_MAX_LIMIT * 2);
    const candidates = forward ? pool.slice(0, candidateLimit) : pool.slice(-candidateLimit);
    const previews = await previewMessages(deps.sessionQuery, ref.id, candidates).catch(() => new Map());
    const enriched = candidates.map((row) => {
        const preview = previews.get(row.seq);
        // 展开整个 preview：bytes / summary 之外还带 injected 标记，漏掉它注入上下文就不会被过滤。
        return preview === undefined ? row : { ...row, ...preview };
    });
    const withText = enriched.filter((row) => {
        const extras = row;
        // 读体失败（bytes 缺失）时保守保留，避免因读取故障把有效消息藏起来。
        if (extras.bytes === undefined)
            return true;
        if (extras.bytes <= 0)
            return false;
        // 系统注入的上下文（agent-instructions / runtime-context / 各类目录）不是用户发言，
        // 体积往往很大且转发无意义，默认不列。
        return extras.injected !== true;
    });
    const skipped = enriched.length - withText.length;
    const visible = forward ? withText.slice(0, limit) : withText.slice(-limit);
    const windowStart = visible.length > 0 ? visible[0].seq : candidates[0].seq;
    const windowEnd = visible.length > 0 ? visible[visible.length - 1].seq : candidates[candidates.length - 1].seq;
    return {
        kind: 'success',
        text: renderMessageList({
            sessionId: ref.id,
            label: ref.label,
            rows: visible,
            ...(skipped > 0 ? { skipped } : {}),
            kinds: listKinds,
            total: rows.length,
            windowStart,
            windowEnd,
            hasEarlier: rows.some((row) => row.seq < windowStart),
            hasLater: rows.some((row) => row.seq > windowEnd),
        }),
    };
}
/**
 * --pick：把指定消息转发进当前轮次；--compact 时先由模型压缩。
 * 未开 --compact 且总字符数超过 pickMaxChars 时报错，不静默截断。
 */
async function executePick(deps, invocation, parsed) {
    if (deps.sessionQuery === undefined) {
        return errorResult('当前 profile 未启用会话查询，无法按 seq 转发消息。会话级引用（不带 --pick）仍然可用。');
    }
    const resolved = await resolveTargets({
        agentId: invocation.agent.id,
        tokens: parsed.tokens,
        maxReferences: deps.config.maxReferences,
        listCandidates: deps.listCandidates,
        // 消息级转发由本插件自己的 pre-step 展开，不经过 dsh 的会话级快照准备，
        // 所以「把本会话某几条消息搬进本会话」是可行的。
        allowSelf: true,
    });
    if (!resolved.ok)
        return errorResult(resolved.error);
    if (resolved.refs.length !== 1) {
        return errorResult('消息级转发只支持单个会话，请给出一个会话 id。');
    }
    const ref = resolved.refs[0];
    const read = await readMessages(deps.sessionQuery, ref.id, parsed.pick, {
        asciiWeight: deps.config.pickAsciiWeight,
        kinds: deps.config.pickKinds,
        readBytes: deps.config.pickReadBytes,
    });
    if (!read.ok)
        return errorResult(read.error);
    if (invocation.signal?.aborted === true) {
        return errorResult('已取消：没有转发任何内容。');
    }
    const compact = parsed.compact === true;
    let summary;
    if (compact) {
        if (deps.llm === undefined) {
            return errorResult('当前 profile 未启用模型调用，--compact 摘要不可用。可去掉 --compact 改为原文转发。');
        }
        const provider = invocation.agent.options?.provider;
        const model = invocation.agent.options?.model;
        if (typeof provider !== 'string' || typeof model !== 'string' || provider === '' || model === '') {
            return errorResult('当前会话没有可用的模型路由，无法摘要。请先在界面选择模型，或去掉 --compact 改为原文转发。');
        }
        const signal = invocation.signal ?? new AbortController().signal;
        const summarized = await summarizeMessages({ llm: deps.llm, provider, model }, { items: read.items, sessionLabel: ref.label, signal });
        if (!summarized.ok) {
            return errorResult('摘要失败：' + summarized.error + '。可去掉 --compact 改为原文转发。');
        }
        summary = summarized.text;
    }
    else if (read.totalWeight > deps.config.pickMaxChars) {
        // 按折合字判定：ASCII 记 1/4、中文记 1，避免英文内容被同一道闸明显冤枉。
        return errorResult('所选 ' +
            read.items.length +
            ' 条消息折合 ' +
            Math.round(read.totalWeight) +
            ' 字（原文 ' +
            read.totalChars +
            ' 字，英文按 ' +
            describeWeight(deps.config.pickAsciiWeight) +
            ' 计），超过原文转发上限 ' +
            deps.config.pickMaxChars +
            ' 字。请加 --compact 走摘要压缩，或减少选取的消息。');
    }
    const text = renderForwardedMessages({
        sessionId: ref.id,
        label: ref.label,
        shortId: shortenSessionId(ref.id),
        items: read.items,
        note: parsed.note,
        guidance: '',
        ...(summary === undefined ? {} : { summary }),
        originalChars: read.totalChars,
        ...(read.omitted > 0 ? { omitted: read.omitted } : {}),
    });
    const mode = parsed.mode ?? deps.config.mode;
    if (mode === 'draft') {
        // 草稿里只放引用：客户端把每个 mention 渲染成一行 chip（#9 user、#136 user），
        // 真正的转发内容由 agent/pre-step 在发送那一刻展开，因此草稿保持短小可编辑。
        const mentions = read.items
            .map((item) => formatMessageReferenceMention({
            sessionId: ref.id,
            seq: item.seq,
            label: chipLabel(item),
        }))
            .join('\n');
        return { kind: 'success', text: mentions };
    }
    if (mode === 'send' || mode === undefined) {
        const message = createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
        });
        try {
            invocation.agent.followup(message);
        }
        catch (error) {
            return errorResult('提交转发失败：' + messageOf(error) + '。请重试。');
        }
        const state = invocation.agent.status === 'running' ? '已排队到下一轮' : '已开启新一轮';
        const kindLabel = compact ? '摘要' : '原文';
        return {
            kind: 'success',
            text: '已转发 ' +
                read.items.length +
                ' 条消息（' +
                kindLabel +
                '，来自「' +
                ref.label +
                '」，' +
                state +
                '）。',
        };
    }
    return errorResult('未知的发送模式。');
}
export async function executeRef(deps, invocation) {
    const parsed = parseRefInput(invocation.rawInput);
    if (!parsed.ok)
        return errorResult(parsed.error);
    // 分支一：--list（只列消息，不引用也不发送）
    if (parsed.list !== undefined) {
        return executeList(deps, invocation, {
            tokens: parsed.tokens,
            note: parsed.note,
            list: parsed.list,
            ...(parsed.kinds === undefined ? {} : { kinds: parsed.kinds }),
        });
    }
    // 分支二：--pick（消息级转发）
    if (parsed.pick !== undefined) {
        return executePick(deps, invocation, {
            tokens: parsed.tokens,
            note: parsed.note,
            pick: parsed.pick,
            ...(parsed.compact === undefined ? {} : { compact: parsed.compact }),
            ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
        });
    }
    // 分支三：会话级引用（原有行为）
    const resolved = await resolveTargets({
        agentId: invocation.agent.id,
        tokens: parsed.tokens,
        maxReferences: deps.config.maxReferences,
        listCandidates: deps.listCandidates,
    });
    if (!resolved.ok)
        return errorResult(resolved.error);
    if (invocation.signal?.aborted === true) {
        return errorResult('已取消：/ref 没有提交任何引用，需要时可以重新执行。');
    }
    const mentions = resolved.refs.map((ref) => formatSessionReferenceMention({ sessionId: ref.id, label: ref.label }));
    const mode = parsed.mode ?? deps.config.mode;
    if (mode === 'draft') {
        return { kind: 'success', text: buildRefMessage({ note: parsed.note, mentions, guidance: '' }) };
    }
    const guidance = deps.config.guidance.trim() === '' ? DEFAULT_GUIDANCE : deps.config.guidance;
    const message = createUserMessage({
        content: [{ type: 'text', text: buildRefMessage({ note: parsed.note, mentions, guidance }) }],
        source: { kind: 'user' },
    });
    try {
        invocation.agent.followup(message);
    }
    catch (error) {
        return errorResult('提交引用失败：' + messageOf(error) + '。请重试；若持续失败，可以在对话里直接说明需要参考哪个会话。');
    }
    const labels = resolved.refs.map((ref) => ref.label).join('、');
    const state = invocation.agent.status === 'running' ? '已排队到下一轮' : '已开启新一轮';
    return { kind: 'success', text: '已引用 ' + resolved.refs.length + ' 个会话：' + labels + '（' + state + '）。' };
}
