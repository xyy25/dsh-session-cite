/**
 * 消息级转发取数层：把会话原始日志（listEvents）映射成可转发的消息条目，
 * 并按需读取单个事件（readEvent）的正文。
 *
 * 设计要点：
 * - 零运行时依赖：不 import 任何 @deepseek-ai 包（连类型导入都没有），
 *   会话查询服务由调用方注入，本模块不负责判断服务是否可用。
 * - 事件 data 字段按 dsh-session / dsh-llm 的真实声明读取：
 *   user/message、assistant/message → { turn, step, message: { content: ContentBlock[] } }
 *   tool/call → { turn, step, callId, name, arguments }
 *   tool/result → { turn, step, message: { content, toolCallId, isError? }, error?, meta? }
 *   compaction/summary → { summary: ContentBlock[], rawOutput?, ... }
 * - 正文永远受 UTF-8 字节预算约束；截断只落在字符边界上，不会产生替换字符。
 */

export type PickKind = 'user' | 'assistant' | 'tool-result' | 'tool-call' | 'summary';

/** 默认开放的五种消息类型。 */
export const DEFAULT_PICK_KINDS: readonly PickKind[] = ['user', 'assistant', 'tool-result', 'tool-call', 'summary'];

/** 事件类型 → 消息短名；未列出的类型不参与消息级转发。 */
const EVENT_KIND: Readonly<Record<string, PickKind>> = {
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool-result',
  'tool/call': 'tool-call',
  'compaction/summary': 'summary',
};

/** 消息短名 → 展示角色。 */
const ROLE_OF_KIND: Readonly<Record<PickKind, string>> = {
  user: 'user',
  assistant: 'assistant',
  'tool-result': 'tool',
  'tool-call': 'tool',
  summary: 'summary',
};

/** 单条正文的 UTF-8 字节上限：超过即截断并标记 truncated。 */
const MAX_ITEM_BYTES = 8192;
/** options.readBytes 非法时的兜底总预算。 */
const DEFAULT_READ_BYTES = 65536;
/** 查找 tool 配对项时最多检查的候选事件数。 */
const MAX_PAIR_SCAN = 40;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

/** 按 UTF-8 计算字节数。 */
function byteLength(text: string): number {
  return TEXT_ENCODER.encode(text).length;
}

/** 按 UTF-8 字节上限安全切片，绝不切在多字节字符中间。 */
function sliceUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text === '') return '';
  const bytes = TEXT_ENCODER.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = Math.floor(maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return TEXT_DECODER.decode(bytes.subarray(0, end));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  const text = String(error);
  return text === '' ? '未知错误' : text;
}

function isPickKind(value: unknown): value is PickKind {
  return value === 'user' || value === 'assistant' || value === 'tool-result' || value === 'tool-call' || value === 'summary';
}

/**
 * 归一化调用方传入的 pickKinds：
 * 过滤未知项；非数组或过滤后为空时回落默认（未知项不进结果，顺序保持原样）。
 */
export function normalizePickKinds(raw: unknown): readonly PickKind[] {
  if (!Array.isArray(raw)) return DEFAULT_PICK_KINDS;
  const kept: PickKind[] = [];
  for (const entry of raw) {
    if (isPickKind(entry)) kept.push(entry);
  }
  return kept.length > 0 ? kept : DEFAULT_PICK_KINDS;
}

export type MessageEventRow = { seq: number; kind: PickKind; forwardable: boolean };

export type MessageItem = {
  seq: number;
  kind: PickKind;
  /** 'user' | 'assistant' | 'tool' | 'summary' */
  role: string;
  text: string;
  /** 字符数（按 JS 字符串长度计）。 */
  chars: number;
  /** UTF-8 字节数。 */
  bytes: number;
  /** 该条是为语义完整自动补上的配对项。 */
  paired?: boolean;
  /** 该条正文因超过单条上限被截断。 */
  truncated?: boolean;
};

export type ReadMessagesResult =
  | { ok: true; items: MessageItem[]; totalChars: number; totalBytes: number; omitted: number }
  | { ok: false; error: string };

type EventMeta = { seq: number; type: string; time: number };
type RawEvent = { seq?: number; type?: string; time?: number; data?: unknown };
type LoadOutcome = { ok: true; event: RawEvent | undefined } | { ok: false; error: string };

/** 从 readEvent 的返回里取出目标事件（target 优先，退回窗口内按 seq 查找）。 */
function pickEvent(window: unknown, seq: number): RawEvent | undefined {
  if (!isRecord(window)) return undefined;
  const target = window.target;
  if (isRecord(target) && typeof target.seq === 'number') return target as RawEvent;
  const events = window.events;
  if (Array.isArray(events)) {
    for (const event of events) {
      if (isRecord(event) && event.seq === seq && typeof event.type === 'string') return event as RawEvent;
    }
  }
  return undefined;
}

/** 拼接内容块正文：text 原样拼接，图片与文件用占位符，其余结构性块（思考、工具调用）跳过。 */
function textFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  let text = '';
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === 'text') {
      if (typeof block.text === 'string') text += block.text;
      continue;
    }
    if (block.type === 'image') {
      text += '{图片}';
      continue;
    }
    if (block.type === 'file') text += '{文件}';
  }
  return text;
}

function dataOf(event: RawEvent): Record<string, unknown> {
  return isRecord(event.data) ? event.data : {};
}

/** 取出 tool/call 或 tool/result 的配对键（callId / toolCallId）。 */
function callIdOf(event: RawEvent, kind: PickKind): string | undefined {
  const data = dataOf(event);
  if (kind === 'tool-call') return typeof data.callId === 'string' ? data.callId : undefined;
  if (kind === 'tool-result') {
    const message = data.message;
    return isRecord(message) && typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
  }
  return undefined;
}

/** 按事件类型抽取正文文本。 */
function textOfEvent(event: RawEvent, kind: PickKind): string {
  const data = dataOf(event);
  if (kind === 'user') {
    // 真实日志里 user/message 的 data 就是 UserMessage 本身（content 直接挂在 data 上），
    // 没有 assistant 那样的 { message } 包装。两种形态都兼容，否则 user 消息会一律被判为空。
    if (Array.isArray(data.content)) return textFromBlocks(data.content);
    const wrapped = data.message;
    return textFromBlocks(isRecord(wrapped) ? wrapped.content : undefined);
  }
  if (kind === 'assistant') {
    const message = data.message;
    return textFromBlocks(isRecord(message) ? message.content : undefined);
  }
  if (kind === 'tool-call') {
    const name = typeof data.name === 'string' && data.name !== '' ? data.name : '(未命名工具)';
    const args = typeof data.arguments === 'string' ? data.arguments : '';
    return '工具 ' + name + ' 参数：' + args;
  }
  if (kind === 'tool-result') {
    const message = data.message;
    const body = textFromBlocks(isRecord(message) ? message.content : undefined);
    const failed = isRecord(message) && message.isError === true;
    return failed ? '（工具执行失败）' + body : body;
  }
  if (kind === 'summary') {
    const summary = textFromBlocks(data.summary);
    return summary !== '' ? summary : textFromBlocks(data.rawOutput);
  }
  return '';
}

/**
 * 该 user 消息是否来自系统注入（而非用户真实发言）。
 * 真实发言的 source.kind 是 'user'；注入内容的 kind 是 agent-instructions、
 * runtime-context、skill-catalog、*tool-catalog 等由各插件声明的来源。
 * @param event - user/message 事件。
 * @returns 注入型为 true。
 */
function isInjectedUserMessage(event: RawEvent): boolean {
  const source = dataOf(event).source;
  if (!isRecord(source)) return false;
  return typeof source.kind === 'string' && source.kind !== 'user';
}

/** 列表行的预览信息：字节数与首行摘要。 */
export type MessagePreview = {
  bytes: number;
  summary: string;
  /**
   * user 消息是否是系统注入的上下文（agent-instructions / runtime-context /
   * skill-catalog / 工具目录等）。注入内容同样走 user 消息通道，但 source.kind
   * 不是 'user'；它们对转发没有价值，默认不在列表里出现。
   */
  injected?: boolean;
};

/** 取首行并压掉多余空白，供列表摘要列使用（render 侧还会再截断）。 */
function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.trim();
}

/** 参数里最能说明"这次调用想干什么"的字段，按优先级排列。 */
const SUMMARY_ARG_KEYS = [
  'description',
  'command',
  'query',
  'pattern',
  'path',
  'file_path',
  'filePath',
  'url',
  'prompt',
  'task',
  'code',
];

/**
 * 从工具调用的 JSON 参数里提炼一句可读摘要。
 *
 * 工具参数是 JSON（如 run_code 的 {"code":"…","description":"…"}），按首行截断只会
 * 露出 `{"code": "\nconst sh = awa…` 这种噪音，所以优先取语义字段（描述/命令/路径…）。
 * 仅供列表展示：转发正文仍使用完整参数。
 * @param raw - 原始参数 JSON 字符串。
 * @returns 一句摘要；无法解析时退回首行。
 */
function summarizeArguments(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (!trimmed.startsWith('{')) return firstLine(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return firstLine(trimmed);
  }
  if (!isRecord(parsed)) return firstLine(trimmed);
  for (const key of SUMMARY_ARG_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim() !== '') return firstLine(value);
  }
  // 白名单都没命中时，取第一个非空字符串值，仍比裸 JSON 可读。
  for (const value of Object.values(parsed)) {
    if (typeof value === 'string' && value.trim() !== '') return firstLine(value);
  }
  const keys = Object.keys(parsed);
  return keys.length > 0 ? '参数：' + keys.join(', ') : '';
}

/** 纯分隔行（--- / ==== / *** 等），对摘要没有信息量。 */
const SEPARATOR_LINE = /^[-=*#_~`\s]{3,}$/u;

/** 纯括号/竖线之类只有结构的行，同样跳过。 */
const STRUCTURE_ONLY_LINE = /^[\[\]{}()<>|]+$/u;

/**
 * 多行输出里挑一行最有代表性的：跳过空行、分隔行、纯结构行、省略号行，
 * 取第一条真正含文字或数字的行。
 * @param lines - 已 trim 并去掉空行的行数组。
 * @returns 代表行；全无内容时返回空串。
 */
function pickRepresentativeLine(lines: readonly string[]): string {
  for (const line of lines) {
    if (SEPARATOR_LINE.test(line)) continue;
    if (STRUCTURE_ONLY_LINE.test(line)) continue;
    if (/^(\.\.\.|…)$/u.test(line)) continue;
    if (/[\p{L}\p{N}]/u.test(line)) return line;
  }
  // 整段只有分隔符/结构符号时，视为没有可读内容。
  return '';
}

/**
 * tool-result 的列表摘要：跳过噪音行取代表行，并附上总行数，
 * 让"这条输出是什么、有多大"一眼可见。
 * @param event - tool/result 事件。
 * @returns 摘要文本（长度受控，render 侧还会再截断）。
 */
function summarizeToolResult(event: RawEvent): string {
  const data = dataOf(event);
  const message = data.message;
  const body = textFromBlocks(isRecord(message) ? message.content : undefined);
  const failed = isRecord(message) && message.isError === true;
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const representative = pickRepresentativeLine(lines);
  // 后缀用紧凑写法，主体才有足够宽度；render 侧按 40 字截断，这里刚好留出余量。
  const suffix = lines.length > 1 ? ' (' + lines.length + '行)' : '';
  const head = failed ? '（失败）' : '';
  if (representative === '') return head + '(空输出)' + suffix;
  const room = Math.max(10, 40 - suffix.length - head.length);
  return head + representative.slice(0, room) + suffix;
}

/** tool-call 的列表摘要：工具名 + 提炼后的参数要点。 */
function summarizeToolCall(event: RawEvent): string {
  const data = dataOf(event);
  const name = typeof data.name === 'string' && data.name !== '' ? data.name : '(未命名工具)';
  const args = typeof data.arguments === 'string' ? data.arguments : '';
  const detail = summarizeArguments(args);
  return detail === '' ? '工具 ' + name : '工具 ' + name + '：' + detail;
}

/**
 * 为已选定的行补上预览（字节数 + 首行摘要）。
 *
 * 只对传入的行读事件体，所以**调用方应先分页再调用**，否则一次会读上千条。
 * 单条读取失败静默跳过（该行没有预览，列表仍然可用）。
 * @param sessionQuery - 会话查询服务（需要 readEvent）。
 * @param sessionId - 目标会话。
 * @param rows - 已分页的行。
 * @returns seq → 预览信息的映射。
 */
export async function previewMessages(
  sessionQuery: {
    readEvent(request: {
      sessionId: string;
      seq: number;
      before?: number;
      after?: number;
    }): Promise<{ target: unknown; events: unknown[] }>;
  },
  sessionId: string,
  rows: readonly MessageEventRow[],
): Promise<Map<number, MessagePreview>> {
  const previews = new Map<number, MessagePreview>();
  for (const row of rows) {
    let window: unknown;
    try {
      window = await sessionQuery.readEvent({ sessionId, seq: row.seq });
    } catch {
      continue;
    }
    const event = pickEvent(window, row.seq);
    if (event === undefined) continue;
    const full = textOfEvent(event, row.kind);
    previews.set(row.seq, {
      // 字节数按完整体量算，让列表反映这条消息真实多大。
      bytes: byteLength(full),
      // 摘要对 tool-call 走参数提炼，避免露出 JSON 噪音；其余类型仍取首行。
      summary:
        row.kind === 'tool-call'
          ? summarizeToolCall(event)
          : row.kind === 'tool-result'
            ? summarizeToolResult(event)
            : firstLine(full),
      ...(row.kind === 'user' && isInjectedUserMessage(event) ? { injected: true } : {}),
    });
  }
  return previews;
}

/**
 * 列出可参与消息级转发的事件：只保留映射到五种短名的事件，按 seq 升序。
 * forwardable 表示该类型是否在 kinds 中被开放（未开放的类型仍列出，供交互层提示）。
 */
export async function listMessageEvents(
  sessionQuery: { listEvents(sessionId: string): Promise<Array<{ seq: number; type: string; time: number }>> },
  sessionId: string,
  kinds: readonly PickKind[],
): Promise<MessageEventRow[]> {
  const allowed = normalizePickKinds(kinds);
  const events = await sessionQuery.listEvents(sessionId);
  const rows: MessageEventRow[] = [];
  if (!Array.isArray(events)) return rows;
  for (const event of events) {
    if (!isRecord(event) || typeof event.seq !== 'number' || typeof event.type !== 'string') continue;
    const kind = EVENT_KIND[event.type];
    if (kind === undefined) continue;
    rows.push({ seq: event.seq, kind, forwardable: allowed.includes(kind) });
  }
  rows.sort((left, right) => left.seq - right.seq);
  return rows;
}

/**
 * 读取指定 seq 的消息正文。
 *
 * 规则：
 * - 顺序以调用方给出的 seq 为准；tool 类条目自动补上配对项（紧随其后，标 paired）。
 * - 配对项不受 options.kinds 限制；配对缺失不报错。
 * - 累计字节超过 options.readBytes 时从尾部丢弃尚未加入的条目并计入 omitted；
 *   单条超过 8 KB 先按 UTF-8 边界截断并标 truncated。
 */
export async function readMessages(
  sessionQuery: {
    listEvents(sessionId: string): Promise<Array<{ seq: number; type: string; time: number }>>;
    readEvent(request: { sessionId: string; seq: number; before?: number; after?: number }): Promise<{ target: any; events: any[] }>;
  },
  sessionId: string,
  seqs: readonly number[],
  options: { kinds: readonly PickKind[]; readBytes: number },
): Promise<ReadMessagesResult> {
  const kinds = normalizePickKinds(options.kinds);
  const budget =
    typeof options.readBytes === 'number' && Number.isFinite(options.readBytes) && options.readBytes > 0
      ? Math.floor(options.readBytes)
      : DEFAULT_READ_BYTES;

  let events: EventMeta[];
  try {
    const listed = await sessionQuery.listEvents(sessionId);
    events = Array.isArray(listed) ? listed : [];
  } catch (error) {
    return { ok: false, error: '无法列出会话事件：' + messageOf(error) };
  }

  const typeBySeq = new Map<number, string>();
  const toolSeqs: number[] = [];
  let maxSeq = 0;
  for (const event of events) {
    if (!isRecord(event) || typeof event.seq !== 'number' || typeof event.type !== 'string') continue;
    typeBySeq.set(event.seq, event.type);
    if (event.seq > maxSeq) maxSeq = event.seq;
    const kind = EVENT_KIND[event.type];
    if (kind === 'tool-call' || kind === 'tool-result') toolSeqs.push(event.seq);
  }
  toolSeqs.sort((left, right) => left - right);

  const requested: number[] = [];
  const requestedSeen = new Set<number>();
  for (const seq of Array.isArray(seqs) ? seqs : []) {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) continue;
    if (requestedSeen.has(seq)) continue;
    requestedSeen.add(seq);
    requested.push(seq);
  }

  const kindBySeq = new Map<number, PickKind>();
  for (const seq of requested) {
    const type = typeBySeq.get(seq);
    if (type === undefined) {
      return { ok: false, error: '该 seq 不存在（会话最大 seq 为 ' + maxSeq + '）' };
    }
    const kind = EVENT_KIND[type];
    if (kind === undefined) {
      return { ok: false, error: '该 seq（#' + seq + '）不是可转发的消息事件（类型 ' + type + '）' };
    }
    if (!kinds.includes(kind)) {
      return {
        ok: false,
        error: '该 seq（#' + seq + '）的类型 ' + kind + '（' + type + '）未在 pickKinds 中开放，请调整 pickKinds 后重试',
      };
    }
    kindBySeq.set(seq, kind);
  }

  const cache = new Map<number, LoadOutcome>();
  const load = async (seq: number): Promise<LoadOutcome> => {
    const cached = cache.get(seq);
    if (cached !== undefined) return cached;
    let outcome: LoadOutcome;
    try {
      const window = await sessionQuery.readEvent({ sessionId, seq });
      outcome = { ok: true, event: pickEvent(window, seq) };
    } catch (error) {
      outcome = { ok: false, error: messageOf(error) };
    }
    cache.set(seq, outcome);
    return outcome;
  };

  /** 找配对项：从最近的候选开始向两侧扫描，返回配对键相同的那个 seq。 */
  const findPair = async (seq: number, pairKind: PickKind, callId: string): Promise<number | undefined> => {
    const candidates = toolSeqs
      .filter((candidate) => EVENT_KIND[typeBySeq.get(candidate) ?? ''] === pairKind)
      .sort((left, right) => Math.abs(left - seq) - Math.abs(right - seq))
      .slice(0, MAX_PAIR_SCAN);
    for (const candidate of candidates) {
      const outcome = await load(candidate);
      if (!outcome.ok || outcome.event === undefined) continue;
      if (callIdOf(outcome.event, pairKind) === callId) return candidate;
    }
    return undefined;
  };

  const planned: Array<{ seq: number; kind: PickKind; paired: boolean }> = [];
  const taken = new Set<number>(requested);
  for (const seq of requested) {
    const kind = kindBySeq.get(seq);
    if (kind === undefined) continue;
    planned.push({ seq, kind, paired: false });
    if (kind !== 'tool-call' && kind !== 'tool-result') continue;
    const outcome = await load(seq);
    if (!outcome.ok || outcome.event === undefined) continue;
    const callId = callIdOf(outcome.event, kind);
    if (callId === undefined) continue;
    const pairKind: PickKind = kind === 'tool-call' ? 'tool-result' : 'tool-call';
    const pairSeq = await findPair(seq, pairKind, callId);
    if (pairSeq === undefined || taken.has(pairSeq)) continue;
    taken.add(pairSeq);
    planned.push({ seq: pairSeq, kind: pairKind, paired: true });
  }

  const items: MessageItem[] = [];
  let totalChars = 0;
  let totalBytes = 0;
  let omitted = 0;

  for (let index = 0; index < planned.length; index += 1) {
    const entry = planned[index];
    const outcome = await load(entry.seq);
    if (!outcome.ok) {
      if (entry.paired) continue;
      return { ok: false, error: '读取 seq #' + entry.seq + ' 的事件失败：' + outcome.error };
    }
    if (outcome.event === undefined) {
      if (entry.paired) continue;
      return { ok: false, error: '读取 seq #' + entry.seq + ' 的事件失败：返回里没有该事件' };
    }

    const raw = textOfEvent(outcome.event, entry.kind);
    let text = raw;
    let truncated = false;
    if (byteLength(raw) > MAX_ITEM_BYTES) {
      text = sliceUtf8(raw, MAX_ITEM_BYTES);
      truncated = true;
    }
    const bytes = byteLength(text);
    if (totalBytes + bytes > budget) {
      omitted = planned.length - index;
      break;
    }

    const item: MessageItem = {
      seq: entry.seq,
      kind: entry.kind,
      role: ROLE_OF_KIND[entry.kind],
      text,
      chars: text.length,
      bytes,
    };
    if (entry.paired) item.paired = true;
    if (truncated) item.truncated = true;
    items.push(item);
    totalChars += item.chars;
    totalBytes += bytes;
  }

  return { ok: true, items, totalChars, totalBytes, omitted };
}
