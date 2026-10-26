/**
 * 按轮次取消息：转发面板的消息列表改用与 `/ref --list / --pick` 相同的原始日志。
 *
 * 为什么需要它：面板原先读客户端 chat 快照，而快照把「一次工具调用」的
 * tool/call 与 tool/result 合并成一个节点，于是列表里永远只有 tool-result，
 * 看起来像缺了一半。换到原始日志后，两种事件各自成行，与命令侧完全一致。
 *
 * 边界：一个 turn 由 `turn/start` 与 `turn/end` 标出，它们的 `data.turn` 是轮次编号。
 * 客户端能从 slot 的 turn 对象里直接拿到这两个事件的 seq，传进来就完全不用查；
 * 只有在没传时才按需 readEvent 反查，且轮次编号递增、读到更大的就停。
 *
 * 性能：`readMessages` 是逐事件 readEvent 的，大轮次（50+ 条消息）会变成几十次
 * 整份日志解压。这里先用一次窗口读取把该轮事件读进内存，再把包装后的 query
 * 交给它——命中缓存就不再触盘，未命中自动回落，行为与命令侧保持一致。
 */

import { listMessageEvents, readMessages } from './messages.js';
import type { PickKind } from './messages.js';

/** 读原始日志需要的最小能力（与 dsh 的 sessionQuery 对齐）。 */
export type TurnQueryLike = {
  listEvents(sessionId: string): Promise<Array<{ seq: number; type: string; time: number }>>;
  readEvent(request: {
    sessionId: string;
    seq: number;
    before?: number;
    after?: number;
  }): Promise<{ target: any; events: any[] }>;
};

/** 面板可以直接消费的一行。 */
export type TurnRow = {
  seq: number;
  kind: string;
  text: string;
  summary: string;
};

/** 一轮的读取结果。 */
export type TurnMessagesResult =
  | {
      ok: true;
      startSeq: number;
      endSeq: number;
      rows: TurnRow[];
      /** 因正文为空而未列出的条数（纯工具轮次、无正文的注入消息等）。 */
      skipped: number;
    }
  | { ok: false; error: string };

/** 调用方可选的边界提示（来自 slot 的 turn.start.seq / turn.end.seq）。 */
export type TurnRange = { from?: number; to?: number };

/**
 * 预读并发度。
 *
 * 实测单次 readEvent 会解压整份会话日志（百毫秒级），所以并发是唯一有效的
 * 加速手段：126 条消息串行要 12 秒，8 路并发压到 2 秒上下。
 */
const PREFETCH_CONCURRENCY = 8;

/**
 * 跨请求的事件缓存（按会话）。
 *
 * 一轮的事件内容一旦落盘就不会再变，所以历史轮次读一次就可以长期复用：
 * 首次打开某轮要解压整份日志（大轮次十几秒），之后同一轮几乎瞬时。
 * 只缓存会话级 Map，最多 8 个会话，超出按插入顺序淘汰最旧的一个。
 */
const EVENT_CACHE = new Map<string, Map<number, any>>();
const EVENT_CACHE_LIMIT = 8;

/**
 * 每个会话「已经完整读过哪些轮」。
 *
 * 用于回答「现在再读这一轮是否很快」——冷缓存下要逐事件解压整份日志，
 * 大轮次十几秒；已读过的轮次几乎瞬时。只按轮次记账，不存内容。
 * 会话被 EVENT_CACHE 淘汰时同步清理，保证不会误报。
 */
const READ_TURNS = new Map<string, Set<number>>();

/**
 * 取（或创建）某个会话的事件缓存。
 * @param sessionId - 会话 id。
 * @returns 该会话的 seq → 事件 映射。
 */
function cacheFor(sessionId: string): Map<number, any> {
  let map = EVENT_CACHE.get(sessionId);
  if (map !== undefined) return map;
  if (EVENT_CACHE.size >= EVENT_CACHE_LIMIT) {
    const oldest = EVENT_CACHE.keys().next().value;
    if (oldest !== undefined) {
      EVENT_CACHE.delete(oldest);
      // 会话被淘汰时，它「读过哪些轮」的记录必须一起失效，否则探测会误报已缓存。
      READ_TURNS.delete(oldest);
    }
  }
  map = new Map<number, any>();
  EVENT_CACHE.set(sessionId, map);
  return map;
}

/**
 * 探测某一轮的日志现在是否已在缓存里（即再读会很快）。
 *
 * 不读日志、不查事件表，只查记账：命中说明这一轮在本进程内完整读过一次。
 * 运行中的一轮消息还在增加，所以只有「已结束的轮次」才会被记账——这也是
 * 前端判断能否沿用「原始日志」偏好的依据。
 * @param sessionId - 会话 id。
 * @param turn - 轮次号。
 * @returns 命中返回 true。
 */
export function probeTurnCache(sessionId: string, turn: number): boolean {
  if (!Number.isSafeInteger(turn) || turn < 0) return false;
  return READ_TURNS.get(sessionId)?.has(turn) === true;
}

/**
 * 记下「这一轮已完整读过」。
 *
 * 只有找到 turn/end 才会走到这里，所以运行中的轮次不会被记账——
 * 它的消息还在增加，下次读必然要补新事件，不能算「很快」。
 * @param sessionId - 会话 id。
 * @param turn - 轮次号。
 */
function markTurnRead(sessionId: string, turn: number): void {
  let set = READ_TURNS.get(sessionId);
  if (set === undefined) {
    set = new Set();
    READ_TURNS.set(sessionId, set);
  }
  set.add(turn);
}

/** 清空事件缓存（测试用）。 */
export function resetEventCache(): void {
  EVENT_CACHE.clear();
  READ_TURNS.clear();
  TURN_SKELETON_CACHE.clear();
}

/** 合并后统一使用的类型短名：一次调用就是一行，不再区分「调用」与「结果」。 */
export const TOOL_ROW_KIND = 'tool';

/**
 * 把成对的 tool-call / tool-result 合并成一行。
 *
 * 为什么要合并：原始日志里一次调用是两个事件（call 在前、result 紧随其后），
 * 而 chat 快照里它本来就是一个节点。不合并的话，切换数据源会让同一个面板
 * 出现两种粒度，看起来像少了一半或多了一半。
 *
 * 配对依据「相邻」而不是 callId：`readMessages` 已经保证配对项紧随其后
 * （它按 callId 找到后立即补进序列），所以这里按相邻判断即可。
 *
 * 合并行的 seq 取 **call 的序号**：语义上这一行代表「一次调用」；
 * 转发时 `readMessages` 会把配对的结果一并带出，信息不会丢。
 *
 * 残缺情况照常保留：只有 call（执行中断）或只有 result（call 已滑出窗口）
 * 都会单独成行，类型同样是 `tool`——不能因为配对不全就把它们藏起来。
 * @param rows - 原始日志产出的行（按 seq 升序）。
 * @returns 合并后的行。
 */
export function mergeToolRows(rows: readonly TurnRow[]): TurnRow[] {
  const out: TurnRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as TurnRow;
    const next = rows[index + 1] as TurnRow | undefined;
    if (row.kind === 'tool-call' && next !== undefined && next.kind === 'tool-result') {
      out.push({
        seq: row.seq,
        kind: TOOL_ROW_KIND,
        text: row.text + '\n' + next.text,
        summary: row.summary !== '' ? row.summary : next.summary,
      });
      index += 1;
      continue;
    }
    if (row.kind === 'tool-call' || row.kind === 'tool-result') {
      out.push({ seq: row.seq, kind: TOOL_ROW_KIND, text: row.text, summary: row.summary });
      continue;
    }
    out.push(row);
  }
  return out;
}

/**
 * 在一类 turn 边界事件里找出某一轮对应的 seq。
 *
 * turn 编号单调递增，所以读到比目标更大的编号就可以停止——不必把整段日志的
 * turn 事件都读一遍（长会话能省掉大量 readEvent）。
 * @param query - 原始日志读取能力。
 * @param sessionId - 目标会话。
 * @param events - 已列好的事件表。
 * @param type - `turn/start` 或 `turn/end`。
 * @param turn - 目标轮次编号。
 * @returns 该边界事件的 seq；找不到时 undefined。
 */
async function findBoundarySeq(
  query: TurnQueryLike,
  sessionId: string,
  events: readonly { seq: number; type: string }[],
  type: string,
  turn: number,
): Promise<number | undefined> {
  const candidates = events
    .filter((event) => event.type === type)
    .map((event) => event.seq)
    .sort((left, right) => left - right);
  for (const seq of candidates) {
    let target: any;
    try {
      target = (await query.readEvent({ sessionId, seq })).target;
    } catch {
      continue;
    }
    const value = target?.data?.turn;
    if (typeof value !== 'number') continue;
    if (value === turn) return seq;
    if (value > turn) return undefined;
  }
  return undefined;
}

/**
 * 并发预读指定 seq，把结果放进缓存。
 *
 * 为什么不用「一次大窗口读取」：实测 dsh 的 readEvent 窗口并不会返回整轮事件，
 * 未命中的条目仍会逐条读，于是 126 条消息变成 126 次整份日志解压（12 秒以上）。
 * 这里改成固定并发的小批读取，把串行等待压成几轮，且失败只影响单条。
 * @param cache - 目标缓存。
 * @param query - 原始查询。
 * @param sessionId - 目标会话。
 * @param seqs - 待预读的序号。
 * @param concurrency - 并发度。
 */
async function prefetchInto(
  cache: Map<number, any>,
  query: TurnQueryLike,
  sessionId: string,
  seqs: readonly number[],
  concurrency: number,
): Promise<void> {
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < seqs.length) {
      const seq = seqs[index];
      index += 1;
      if (seq === undefined || cache.has(seq)) continue;
      try {
        const result = await query.readEvent({ sessionId, seq });
        const target = result?.target;
        if (typeof target?.seq === "number") cache.set(target.seq, target);
      } catch {
        // 单条失败：交给 readMessages 自己重试或降级。
      }
    }
  };
  const width = Math.max(1, Math.min(concurrency, seqs.length));
  await Promise.all(Array.from({ length: width }, worker));
}

/** 一轮的骨架：边界 + 可转发消息的 seq/kind；正文另取。 */
type TurnSkeleton = { startSeq: number; endSeq: number; items: Array<{ seq: number; kind: string }> };

/**
 * 每一轮骨架的缓存（按 `session:turn`）。
 *
 * 列骨架只要 listEvents 一次（约 0.4 秒），而正文要逐 seq 解压（每个约 180ms）。
 * 面板先拿骨架渲染占位、再分批取正文，用户就不用面对一个空转的圈；
 * 分批取正文时也能靠这份缓存跳过重复的 listEvents。
 */
const TURN_SKELETON_CACHE = new Map<string, TurnSkeleton>();
const TURN_SKELETON_LIMIT = 16;

/**
 * 解析某一轮的骨架（边界 + 可转发消息的 seq/kind），带进程内缓存。
 * @param query - 原始日志读取能力。
 * @param sessionId - 目标会话。
 * @param turn - 轮次编号。
 * @param kinds - 类型白名单。
 * @returns 骨架或错误。
 */
async function resolveTurnSkeleton(
  query: TurnQueryLike,
  sessionId: string,
  turn: number,
  kinds: readonly PickKind[],
  range?: TurnRange,
): Promise<{ ok: true; value: TurnSkeleton } | { ok: false; error: string }> {
  // 前端给了完整边界时：不必查 turn 事件，也**不能**把结果写进缓存——
  // 那不是该轮的真实边界，只是这一次请求的窗口。
  const bounded =
    typeof range?.from === 'number' && Number.isSafeInteger(range.from) &&
    typeof range?.to === 'number' && Number.isSafeInteger(range.to);
  const key = sessionId + ':' + turn;
  if (!bounded) {
    const cached = TURN_SKELETON_CACHE.get(key);
    if (cached !== undefined) return { ok: true, value: cached };
  }

  let events: Array<{ seq: number; type: string; time: number }>;
  try {
    events = await query.listEvents(sessionId);
  } catch (error) {
    return { ok: false, error: '无法列出会话事件：' + (error instanceof Error ? error.message : String(error)) };
  }
  if (!Array.isArray(events)) return { ok: false, error: '会话事件不可用' };

  const startSeq = bounded ? (range!.from as number) : await findBoundarySeq(query, sessionId, events, 'turn/start', turn);
  if (startSeq === undefined) return { ok: false, error: '找不到该轮次的起点' };
  const endSeq = bounded ? (range!.to as number) : await findBoundarySeq(query, sessionId, events, 'turn/end', turn);
  if (endSeq === undefined) return { ok: false, error: '该轮次尚未结束' };
  if (endSeq < startSeq) return { ok: false, error: '轮次边界不合法' };

  const listed = await listMessageEvents(query, sessionId, kinds);
  const items = listed
    .filter((row) => row.forwardable && row.seq >= startSeq && row.seq <= endSeq)
    .map((row) => ({ seq: row.seq, kind: row.kind }));
  const value: TurnSkeleton = { startSeq, endSeq, items };
  if (!bounded) {
    TURN_SKELETON_CACHE.set(key, value);
    if (TURN_SKELETON_CACHE.size > TURN_SKELETON_LIMIT) {
      const oldest = TURN_SKELETON_CACHE.keys().next().value;
      if (oldest !== undefined) TURN_SKELETON_CACHE.delete(oldest);
    }
  }
  return { ok: true, value };
}

/**
 * 只取某一轮的骨架（不读正文）。
 *
 * 面板用它立刻渲染「本轮 N 条 · 类型分布」的占位列表，再分批取正文，
 * 这样大轮次也不至于让输入框上方空转十几秒。
 * @param query - 原始日志读取能力。
 * @param sessionId - 目标会话。
 * @param turn - 轮次编号。
 * @param kinds - 类型白名单。
 * @returns 骨架或错误。
 */
export async function readTurnMeta(
  query: TurnQueryLike,
  sessionId: string,
  turn: number,
  kinds: readonly PickKind[],
  range?: TurnRange,
): Promise<{ ok: true; startSeq: number; endSeq: number; items: Array<{ seq: number; kind: string }> } | { ok: false; error: string }> {
  if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: '缺少会话 id' };
  if (!Number.isSafeInteger(turn) || turn < 0) return { ok: false, error: '轮次编号不合法' };
  const skeleton = await resolveTurnSkeleton(query, sessionId, turn, kinds, range);
  if (!skeleton.ok) return skeleton;
  // 骨架按「一次调用一行」合并，和正文最终呈现的粒度一致——
  // 否则 tool-call/tool-result 会各自占一行，加载完成后行数突然缩水。
  const items = mergeToolRows(
    skeleton.value.items.map((item) => ({ seq: item.seq, kind: item.kind, text: '', summary: '' })),
  ).map((row) => ({ seq: row.seq, kind: row.kind }));
  return { ok: true, startSeq: skeleton.value.startSeq, endSeq: skeleton.value.endSeq, items };
}

/**
 * 读取某一轮里可转发的消息。
 *
 * 取数路径与命令侧完全一致：`listMessageEvents` 决定「哪些事件算消息」，
 * `readMessages` 负责正文、tool 配对与读取预算，因此面板与 `--list` 看到的
 * 类型、摘要、字数都同源。
 * @param query - 原始日志读取能力。
 * @param sessionId - 目标会话。
 * @param turn - 轮次编号。
 * @param options - 类型白名单、读取预算与折合权重（与插件配置一致）。
 * @param range - 可选的边界提示；给了就跳过边界查找。
 * @returns 该轮的消息行；边界缺失时返回错误。
 */
export async function readTurnMessages(
  query: TurnQueryLike,
  sessionId: string,
  turn: number,
  options: { kinds: readonly PickKind[]; readBytes: number; asciiWeight?: number },
  range?: TurnRange,
): Promise<TurnMessagesResult> {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, error: '缺少会话 id' };
  }
  if (!Number.isSafeInteger(turn) || turn < 0) {
    return { ok: false, error: '轮次编号不合法' };
  }

  // 骨架（边界 + seq/kind 列表）走缓存：分批取正文时不必重复 listEvents。
  const skeleton = await resolveTurnSkeleton(query, sessionId, turn, options.kinds, range);
  if (!skeleton.ok) return skeleton;
  const startSeq = skeleton.value.startSeq;
  const endSeq = skeleton.value.endSeq;

  // listEvents 只解压一次，listMessageEvents 与 readMessages 共用这份结果；
  // 事件缓存跨请求保留，同一轮第二次打开就基本不再触盘。
  let listedEvents: Array<{ seq: number; type: string; time: number }> | undefined;
  const cache = cacheFor(sessionId);
  const wrapped: TurnQueryLike = {
    async listEvents(id: string) {
      if (id !== sessionId) return query.listEvents(id);
      if (listedEvents === undefined) listedEvents = await query.listEvents(sessionId);
      return listedEvents;
    },
    async readEvent(request) {
      const hit = cache.get(request.seq);
      if (hit !== undefined) return { target: hit, events: [] };
      const result = await query.readEvent(request);
      const target = result?.target;
      if (typeof target?.seq === "number") cache.set(target.seq, target);
      return result;
    },
  };

  // 窗口过滤：分批取正文时前端传 from/to（那一批的 seq 首尾）。
  const winFrom = typeof range?.from === 'number' ? range.from : startSeq;
  const winTo = typeof range?.to === 'number' ? range.to : endSeq;
  if (winFrom > winTo) return { ok: false, error: '轮次边界不合法' };
  const seqs = skeleton.value.items
    .filter((item) => item.seq >= winFrom && item.seq <= winTo)
    .map((item) => item.seq);
  if (seqs.length === 0) {
    markTurnRead(sessionId, turn);
    return { ok: true, startSeq, endSeq, rows: [], skipped: 0 };
  }

  // 并发预读，把 N 次串行解压压成几轮；readMessages 随后全部命中缓存。
  await prefetchInto(cache, query, sessionId, seqs, PREFETCH_CONCURRENCY);

  const read = await readMessages(wrapped, sessionId, seqs, {
    kinds: options.kinds,
    readBytes: options.readBytes,
    ...(options.asciiWeight === undefined ? {} : { asciiWeight: options.asciiWeight }),
  });
  if (!read.ok) return { ok: false, error: read.error };

  const rows: TurnRow[] = read.items.map((item) => ({
    seq: item.seq,
    kind: item.kind,
    text: item.text,
    summary: item.summary,
  }));
  // 与 chat 快照的粒度对齐：一次调用只留一行，类型统一成 tool。
  const merged = mergeToolRows(rows);
  // 先合并再过滤：参数为空但有结果的调用合并后就有正文了，不能提前丢掉。
  // 纯工具轮次（只有 reasoning + tool-call 块）在这里被滤掉——命令行侧 --list
  // 同样不列它们，只是那边叫 skipped。
  const visible = merged.filter((row) => row.text.trim() !== "");
  markTurnRead(sessionId, turn);
  return { ok: true, startSeq, endSeq, rows: visible, skipped: merged.length - visible.length };
}
