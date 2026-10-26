/**
 * 轮次「转发」按钮与转发面板。
 *
 * 三个界面角色：
 *   1. TurnForwardButton —— 挂在 conversation.chat.turnTail，渲染按钮。
 *      选这个 slot 而不是 assistant-actions，是因为只有它拿得到 { turn, hooks.turnData }；
 *      代价是渲染位置在按钮行之前（dsh 的按钮行顺序固定，没有「分支之后」的挂载点）。
 *   2. ForwardOverlay —— 挂在 conversation.input.overlay，承载会话选择与转发弹窗。
 *   3. 二者的连接：模块级 store（按钮写、overlay 读）。
 *
 * 全部用 React.createElement，不依赖 tsconfig 的 jsx 设置，也不引入任何新依赖。
 */

import {
  DEFAULT_ASCII_WEIGHT,
  buildForwardText,
  defaultSelection,
  kindStats,
  mustCompact,
  putPending,
  rowLabel,
  selectedWeight,
  toggleKind,
} from "./forward-logic.js";
import type { ForwardRow } from "./forward-logic.js";
import { toSessionOptions, shortSessionId } from "./session-picker.js";
import { fetchTurnRows } from "./turn-source.js";

declare const require: (spec: string) => any;

const React: any = (() => {
  try {
    return require("react");
  } catch {
    return null;
  }
})();

/** 面板状态：closed → picker（选会话）→ dialog（勾消息）。 */
type PanelState = {
  stage: "closed" | "picker" | "dialog";
  /** 本轮可转发的消息（chat 快照：Host 路由不可用时的回退来源）。 */
  rows: ForwardRow[];
  /** 源会话（当前会话）。 */
  sourceId: string;
  sourceLabel: string;
  /** 源会话的这一轮编号：面板据此向 Host 取原始日志消息。 */
  turn?: number;
  /** 多轮模式：参与合并的轮次（升序）；单轮时不设置。 */
  turns?: number[];
  /** 多轮读取进度：done/total 与失败的轮次。 */
  multiLoading?: { done: number; total: number; failed: number[] };
  /** 该轮自带的 seq 边界，省掉 Host 侧的边界查找。 */
  fromSeq?: number;
  toSeq?: number;
  /** 目标会话。 */
  targetId?: string;
  targetLabel?: string;
  /** 排障用：取不到数据时给用户看的原因。 */
  unavailable?: string;
};

const CLOSED: PanelState = { stage: "closed", rows: [], sourceId: "", sourceLabel: "" };

let state: PanelState = CLOSED;
const listeners = new Set<() => void>();
/** 搬家失败只告警一次，避免每轮渲染刷屏。 */
let warnedMove = false;

/** 订阅面板状态变化。 */
export function subscribeForward(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 读取当前状态。 */
export function getForwardState(): PanelState {
  return state;
}

function setState(next: PanelState): void {
  state = next;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 单个订阅者报错不影响其它。
    }
  }
}

/** 关闭面板。 */
export function closeForward(): void {
  setState(CLOSED);
}

// ===== 多轮勾选（轮级）=====
// 只存轮次号，不存 DOM 元素：消息区是分页渲染的，行随时可能被卸载，
// DOM 引用不可靠；按轮次号存才能「滚出去再滚回来仍然选中」。
let selectedTurns: Set<number> = new Set();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 单个订阅者报错不影响其它。
    }
  }
}

/** 已勾选的轮次（升序）。 */
export function getSelectedTurns(): number[] {
  return [...selectedTurns].sort((a, b) => a - b);
}

/** 某一轮是否已勾选。 */
export function isTurnSelected(turn: number): boolean {
  return selectedTurns.has(turn);
}

/**
 * 切换某一轮的勾选状态。
 * 超过上限时拒绝并返回 false，由调用方提示。
 * @param turn - 轮次号。
 * @returns 是否接受了这次切换。
 */
export function toggleTurn(turn: number): boolean {
  if (selectedTurns.has(turn)) {
    selectedTurns.delete(turn);
    notify();
    return true;
  }
  if (selectedTurns.size >= MAX_SELECTED_TURNS) return false;
  selectedTurns.add(turn);
  notify();
  return true;
}

/** 清空勾选（转发完成、切换会话、手动清除时调用）。 */
export function clearSelectedTurns(): void {
  if (selectedTurns.size === 0) return;
  selectedTurns = new Set();
  notify();
}

/** 一次最多勾选多少轮：5 轮冷缓存约 2.5 分钟，再多多半是误操作。 */
export const MAX_SELECTED_TURNS = 5;

/**
 * 从 useChat 的快照里取本轮消息。
 *
 * slot props 实测键为 useChat/sessionId/turn/seq/openFile（没有 hooks），
 * 所以数据只能从 useChat 快照来。快照形状随版本可能变化，这里逐个尝试常见的
 * 节点容器（views.get().nodes / timeline.nodes / nodes），取不到就返回 undefined
 * 让调用方回退到 turnData 路径。
 * @param chat - useChat 返回的快照。
 * @param turn - 目标轮次。
 * @returns 消息行；无法解析时 undefined。
 */
function rowsFromChat(chat: any, turn: any): ForwardRow[] | undefined {
  if (chat === undefined || chat === null) return undefined;
  const nodes = collectNodes(chat);
  if (nodes.length === 0) return undefined;
  const rows: ForwardRow[] = [];
  for (const node of nodes) {
    const nodeTurn = node?.location?.turn ?? node?.data?.turn ?? node?.turn;
    if (turn !== undefined && nodeTurn !== undefined && nodeTurn !== turn) continue;
    const row = toRow(node);
    if (row !== null) rows.push(row);
  }
  if (rows.length === 0) return undefined;
  // 快照里的节点顺序是渲染顺序，同一轮内可能与 seq 不一致（assistant 的锚点排在
  // 它引用的 user 之前）。转发列表必须按 seq 升序，否则 chip 顺序会看起来错乱。
  rows.sort((a, b) => a.seq - b.seq);
  return rows;
}

/**
 * 在快照里找节点数组。
 * @param chat - chat 快照。
 * @returns 节点数组（找不到时空数组）。
 */
function collectNodes(chat: any): any[] {
  const reads: Array<() => any> = [
    () => chat?.views?.get?.()?.nodes?.values?.(),
    () => chat?.views?.get?.()?.nodes,
    () => chat?.timeline?.nodes,
    () => chat?.nodes,
  ];
  for (const read of reads) {
    try {
      const value = read();
      if (Array.isArray(value)) return value;
      if (value !== undefined && value !== null && typeof value.values === "function") {
        const list = value.values();
        if (Array.isArray(list)) return list;
      }
    } catch {
      // 换下一个容器继续找。
    }
  }
  return [];
}

/**
 * 从 turnData 钩子里提取本轮消息（旧路径，保留作后备）。
 *
 * turnData 是 chat 包注入的 hook，其返回值形状随 node 类型不同，因此这里做防御式解析：
 * 依次尝试 nodes / messages / blocks 三种常见字段，任何异常都退化为空数组（按钮禁用）。
 * @param props - turnTail slot 的 props。
 * @returns 可转发的消息行。
 */
export function collectRows(props: any): ForwardRow[] {
  const hooks = props?.hooks ?? {};
  const turn = props?.turn ?? hooks.turn;
  const readTurn =
    typeof hooks.turnData === "function"
      ? hooks.turnData
      : typeof props?.turnData === "function"
        ? props.turnData
        : undefined;

  // 诊断只在点击时打印（不在渲染期刷屏），便于对照真实 slot 契约。
  if (readTurn === undefined) {
    const propsKeys = JSON.stringify(Object.keys(props ?? {}));
    const hookKeys = JSON.stringify(Object.keys(hooks));
    console.warn("[dsh-session-cite] 转发：props 没有 turnData 钩子；props 键 = " + propsKeys + "，hooks 键 = " + hookKeys);
    return [];
  }

  let data: any;
  try {
    data = readTurn(turn);
  } catch (error) {
    console.warn("[dsh-session-cite] 转发：turnData 抛错", error);
    return [];
  }

  const nodes = pickNodes(data);
  if (nodes.length === 0) {
    const shape = data === null ? "null" : Array.isArray(data) ? "array(" + data.length + ")" : "object 键=" + JSON.stringify(Object.keys(data ?? {}));
    console.warn("[dsh-session-cite] 转发：turnData 里没有 nodes，返回形状 = " + shape);
    return [];
  }

  const rows: ForwardRow[] = [];
  for (const node of nodes) {
    const row = toRow(node);
    if (row !== null) rows.push(row);
  }
  if (rows.length === 0) {
    const first = nodes[0] ?? {};
    console.warn(
      "[dsh-session-cite] 转发：" +
        nodes.length +
        " 个 node 里没有可用消息；首个 node 的 kind = " +
        JSON.stringify(first.kind) +
        "，data 键 = " +
        JSON.stringify(Object.keys(first.data ?? {})),
    );
  }
  rows.sort((a, b) => a.seq - b.seq);
  // 压缩摘要节点没有 turn 字段，逃得过「按轮号过滤」，只能按 seq 区间裁。
  // 边界来自 turnTail 的 props.turn（{ turn, start:{seq}, end:{seq} }）；
  // 拿不到边界（例如调用方只给了轮号）时不过滤，保持旧行为。
  const bounds = turnInfo(props?.turn ?? hooks.turn);
  const from = bounds.from;
  const to = bounds.to;
  if (from === undefined || to === undefined) return rows;
  return rows.filter((row) => row.seq >= from && row.seq <= to);
}

/**
 * 从 turnData 的返回值里挑出 node 数组。
 * 依次尝试常见字段与一层包裹；都不匹配则返回空数组。
 * @param data - turnData 的返回值。
 * @returns node 数组。
 */
function pickNodes(data: any): any[] {
  if (Array.isArray(data)) return data;
  for (const key of ["nodes", "messages", "entries", "items", "children"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  for (const key of ["timeline", "data", "turn"]) {
    const nested = data?.[key];
    if (nested !== undefined && nested !== null && nested !== data) {
      const found = pickNodes(nested);
      if (found.length > 0) return found;
    }
  }
  return [];
}

/**
 * chat 视图节点类型 → PickKind 的映射。
 *
 * chat 快照里的 kind 是视图概念（user-message / assistant-step …），
 * 而默认勾选与类型分组都按 PickKind 判断，不映射的话会「一个都不选」。
 */
const KIND_MAP: Record<string, string> = {
  "user-message": "user",
  user: "user",
  "assistant-step": "assistant",
  assistant: "assistant",
  "tool-call": "tool-call",
  "tool-result": "tool-result",
  summary: "summary",
  compaction: "summary",
  "compaction-summary": "summary",
};

/**
 * 不作为消息参与转发的节点类型。
 *
 * context 是注入的上下文（workspace 说明、技能清单等），Host 侧 --list 同样排除它们，
 * 两边口径必须一致，否则面板与命令看到的消息集合不同。
 */
const SKIP_KINDS = new Set([
  "turn-tail",
  "turn-start",
  "step-start",
  "step-end",
  "usage",
  "error",
  "context",
  "system-prompt",
]);

/**
 * 把一个 chat node 映射成转发行；不是消息节点则返回 null。
 *
 * 三类节点的形状完全不同（依据 dsh 的 chat-nodes / records 契约）：
 *   - user / context：data 就是消息本身，带 seq 与 content；
 *   - assistant-step：data = { status, turn, step, blocks, finalNode? }，没有 seq，
 *     真正的 assistant/message 序号在 data.finalNode.seq，只有无 finalNode 时才退回 anchorSeq；
 *   - tool：data = { root }，名字/参数/结果全在 root 里，没有顶层正文。
 * @param node - chat 快照里的一个节点。
 * @returns 转发行，或 null。
 */
function toRow(node: any): ForwardRow | null {
  const data = node?.data ?? node;
  const rawKind = typeof node?.kind === "string" ? node.kind : typeof data?.kind === "string" ? data.kind : "";
  if (SKIP_KINDS.has(rawKind)) return null;

  // 压缩摘要节点（dsh 的 CompactionSummaryNode）：
  //   { kind: 'compaction', seq, time, summary: string|null, summaryEventSeq: number|null, … }
  // 两处和普通消息不同：
  //   1. 正文是一个字符串字段 summary，不是 blocks/content 块数组；
  //   2. 节点的 seq 指向「落地 checkpoint 的 user/message」，真正属于摘要的是
  //      summaryEventSeq——转发必须用后者，否则按 seq 读到的是别的消息。
  // summary 为 null 表示摘要事件落在窗口外，此时没有可转发正文，直接跳过。
  if (rawKind === "compaction" || typeof data?.summaryEventSeq === "number") {
    const summaryText = typeof data?.summary === "string" ? data.summary.trim() : "";
    const seq = firstNumber(data?.summaryEventSeq ?? undefined, data?.seq, node?.seq);
    if (seq === undefined || summaryText === "") return null;
    return { seq, kind: "summary", text: summaryText, summary: firstLine(summaryText) };
  }

  const tool = toolRow(data, node);
  if (tool !== null) return tool;

  // seq 的优先级按「能否被 Host 侧原始日志读出内容」排：
  // finalNode.seq 是 assistant/message 自己的序号，anchorSeq 只是渲染锚点，
  // 拿 anchorSeq 去 --pick 可能读到 step/start 之类的事件。
  const seq = firstNumber(data?.seq, data?.finalNode?.seq, node?.anchorSeq, data?.anchorSeq, node?.seq);
  if (seq === undefined) return null;
  // 只取 text 块：reasoning 是模型的思考过程，不属于可转发正文。
  const text =
    blocksText(data?.blocks, ["text"]) ||
    blocksText(data?.content, ["text"]) ||
    (typeof data?.text === "string" ? data.text : "");
  if (text === "") return null;
  const kind = KIND_MAP[rawKind] ?? (rawKind === "" ? "message" : rawKind);
  return { seq, kind, text, summary: firstLine(text) };
}

/**
 * 工具节点 → 转发行。
 *
 * ToolChatData 只有 root（ToolCallBlock = ToolResultNode | RunningToolCall）：
 *   - 有结果时 root.kind === 'tool-result'，正文在 root.content，错误在 root.isError；
 *   - 未完成时 root.phase 为 preparing/start，参数在 root.argsRaw 或 root.call.argsRaw。
 * 结果行优先用 root.seq（tool/result 事件自身的序号），调用行没有序号时退回 anchorSeq。
 * @param data - chat 节点的 data。
 * @param node - 原始节点（取 anchorSeq 兜底）。
 * @returns 转发行；不是工具节点时 null。
 */
function toolRow(data: any, node: any): ForwardRow | null {
  const root = data?.root;
  if (root === undefined || root === null || typeof root !== "object") return null;
  const isResult = root.kind === "tool-result";
  const name =
    typeof root.name === "string" && root.name !== ""
      ? root.name
      : typeof root.call?.name === "string"
        ? root.call.name
        : "";
  const argsRaw =
    typeof root.call?.argsRaw === "string"
      ? root.call.argsRaw
      : typeof root.argsRaw === "string"
        ? root.argsRaw
        : "";
  const body = isResult ? blocksText(root.content, ["text"]) : "";
  // 面板里一个 tool 节点代表整条工具生命周期（调用 + 结果），所以正文要同时带参数与
  // 输出，否则「只有结果不知道调了什么」——Host 侧是靠 tool/call 与 tool/result 两条
  // 事件配对解决的，chat 快照把它们合并成了一个节点。
  const parts: string[] = [];
  if (name !== "") parts.push(name);
  if (argsRaw !== "") parts.push(argsRaw);
  if (body !== "") parts.push(body);
  const text = parts.join("\n");
  if (text === "") return null;
  const seq = firstNumber(root.seq, data?.seq, node?.anchorSeq, data?.anchorSeq);
  if (seq === undefined) return null;
  // 与原始日志路径对齐：一次调用就是一行，类型统一为 tool。
  // （快照里这是「调用+结果」的合并节点；原始日志里由两条事件合并而成。）
  const kind = "tool";
  // 列表摘要取参数的语义字段（与 Host 侧 --list 同口径），正文仍是完整参数与结果。
  const summary = isResult
    ? summarizeToolArgs(argsRaw) || firstLine(body)
    : summarizeToolArgs(argsRaw) || firstLine(text);
  return { seq, kind, text, summary };
}

/**
 * 从工具参数 JSON 里提炼一句可读摘要。
 * @param argsRaw - 原始参数串。
 * @returns 摘要；无法提炼时空串。
 */
function summarizeToolArgs(argsRaw: string): string {
  if (argsRaw === "") return "";
  let parsed: any;
  try {
    parsed = JSON.parse(argsRaw);
  } catch {
    return "";
  }
  if (parsed === null || typeof parsed !== "object") return "";
  const keys = [
    "description",
    "command",
    "query",
    "pattern",
    "path",
    "file_path",
    "url",
    "prompt",
    "task",
    "code",
  ];
  for (const key of keys) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim() !== "") return firstLine(value);
  }
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim() !== "") return firstLine(value);
  }
  return "";
}

/**
 * 从 content/block 数组里抽文本段。
 *
 * 必须按类型过滤：assistant 的 blocks 里同时有 text 与 reasoning，
 * 不分类型会把模型的思考过程当成正文转发出去（长度也完全失真）。
 * 两个契约的判别字段不同——AssistantBlock 用 kind，ContentBlock 用 type。
 * @param blocks - block 数组。
 * @param kinds - 允许的类型；省略表示全取。
 * @returns 用换行拼接的文本。
 */
function blocksText(blocks: any, kinds?: readonly string[]): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    const tag = typeof block?.kind === "string" ? block.kind : typeof block?.type === "string" ? block.type : "";
    if (kinds !== undefined && !kinds.includes(tag)) continue;
    if (typeof block?.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * 取第一个是数字的候选值。
 * @param values - 候选。
 * @returns 第一个 number，或 undefined。
 */
function firstNumber(...values: any[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * 打开多轮合并面板：由「转发按钮 + 已有其它轮被勾选」触发。
 *
 * 逐轮串行读取（dsh 的 readEvent 内部本就串行，并发不会缩短总时长，只会让进度条失真），
 * 合并后去重，再交给同一个 DialogStage。读取期间面板已打开，标题里显示进度。
 * @param input - 源会话、参与合并的轮次（含按钮所在轮）。
 */
export async function openMultiForward(input: {
  sourceId: string;
  sourceLabel: string;
  turns: number[];
}): Promise<void> {
  const turns = [...new Set(input.turns)].filter((t) => Number.isSafeInteger(t) && t >= 0).sort((a, b) => a - b);
  if (turns.length === 0) return;
  setState({
    // 先进「选目标会话」这一步：合并读取在后台并行，用户选完目标时数据通常已就绪；
    // 若尚未读完，弹窗里显示进度。
    stage: "picker",
    rows: [],
    sourceId: input.sourceId,
    sourceLabel: input.sourceLabel,
    turns,
    multiLoading: { done: 0, total: turns.length, failed: [] },
  });
  const collected: ForwardRow[] = [];
  const seen = new Set<number>();
  const failed: number[] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    const payload = await fetchTurnRows(input.sourceId, turn);
    if (payload === undefined) {
      failed.push(turn);
    } else {
      for (const row of payload.rows) {
        // 同一 seq 只保留首次出现（跨轮理论上不会重复，防御性去重）。
        if (seen.has(row.seq)) continue;
        seen.add(row.seq);
        collected.push({ ...row, turn });
      }
    }
    // 面板可能已被用户关掉：那时不再回写，避免把状态又拉起来。
    if (state.stage === "closed") return;
    setState({ ...state, multiLoading: { done: i + 1, total: turns.length, failed: [...failed] } });
  }
  if (state.stage === "closed") return;
  if (collected.length === 0) {
    setState({
      ...state,
      rows: [],
      multiLoading: undefined,
      unavailable: failed.length === turns.length ? "这些轮次都读不出来（Host 未重启或日志不可读）" : "选中轮次没有可转发的消息",
    });
    return;
  }
  setState({ ...state, rows: collected, multiLoading: undefined, unavailable: undefined });
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").trim();
}

/**
 * 打开面板：由按钮调用。
 * @param input - 源会话与可选消息。
 */
export function openForward(input: {
  sourceId: string;
  sourceLabel: string;
  rows: ForwardRow[];
  turn?: number;
  fromSeq?: number;
  toSeq?: number;
  unavailable?: string;
}): void {
  // 排障用：面板为空或类型不对时，能直接看到拿到哪些行、seq 是多少。
  console.warn(
    "[dsh-session-cite] 转发候选 " + input.rows.length + " 条：" +
      (input.rows.length === 0 ? "（空）" : input.rows.map((row) => row.seq + ":" + row.kind).join(" ")),
  );
  setState({
    stage: "picker",
    rows: input.rows,
    sourceId: input.sourceId,
    sourceLabel: input.sourceLabel,
    ...(typeof input.turn === "number" ? { turn: input.turn } : {}),
    ...(typeof input.fromSeq === "number" ? { fromSeq: input.fromSeq } : {}),
    ...(typeof input.toSeq === "number" ? { toSeq: input.toSeq } : {}),
    ...(input.unavailable === undefined ? {} : { unavailable: input.unavailable }),
  });
}

/** 选定目标会话，进入弹窗阶段。 */
export function chooseTarget(targetId: string, targetLabel: string): void {
  setState({ ...state, stage: "dialog", targetId, targetLabel });
}

/** 回到会话选择。 */
export function backToPicker(): void {
  setState({ ...state, stage: "picker" });
}

/**
 * 勾选框里的对勾（仅选中时渲染）。
 * 与转发图标同一套规范：16 视口、currentColor、round cap/join。
 * @returns SVG 元素。
 */
function CheckIcon(): any {
  return React.createElement("svg", {
    viewBox: "0 0 16 16",
    width: 11,
    height: 11,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
    children: [React.createElement("path", { key: "check", d: "M3.2 8.6 6.4 11.8 12.8 4.6" })],
  });
}

/**
 * 渲染转发图标。
 *
 * 与同一按钮行里的原生图标保持同一套规范（实测原生是 viewBox 0 0 16 16、
 * 描边 1、round cap/join）。之前用 24 视口画在 16px 的盒子里，等于整体缩到
 * 2/3，所以看起来偏小偏细。
 *
 * 形状是一条从底部左侧升起、折向右侧的弧线加箭头——表达「内容被带到别处」；
 * 箭头朝右上而不是朝左，避免被读成撤销/回复。
 * @returns SVG 元素。
 */
function ForwardIcon(): any {
  return React.createElement("svg", {
    viewBox: "0 0 16 16",
    width: 16,
    height: 16,
    fill: "none",
    stroke: "currentColor",
    // 原生是 1，但这里是一条开放曲线（原生全是封闭图形），同等描边下视觉更轻，
    // 所以略加粗到 1.2 来补偿重量差。
    strokeWidth: 1.2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
    children: [
      // 从底部左侧升起、折向右侧：把「这一轮的内容带出去」画满整个 16 视口。
      React.createElement("path", { key: "arc", d: "M2 13.2C2 8.4 5.3 5.4 9.8 5.4h3.4" }),
      // 箭头尖端落在弧线终点上，比原来大一圈，缩小后仍清晰。
      React.createElement("path", { key: "tip", d: "M10.4 2.8 13.2 5.4l-2.8 2.8" }),
    ],
  });
}

/**
 * 从 slot 的 turn 里取出轮次编号与它自带的 seq 边界。
 *
 * 实测 turnTail 的 props.turn 不是数字，而是
 * `{ turn: 12, start: { seq, data: { turn } }, end: { seq, ... } }`。
 * 它自带边界，正好能省掉 Host 侧「逐个读 turn 事件找边界」的开销。
 * @param value - props.turn 的原始值。
 * @returns 可用的 turn / from / to（缺哪项就省哪项）。
 */
export function turnInfo(value: any): { turn?: number; from?: number; to?: number } {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return { turn: value };
  if (value === null || typeof value !== "object") return {};
  const turn = value.turn;
  const from = value.start?.seq;
  const to = value.end?.seq;
  return {
    ...(typeof turn === "number" && Number.isSafeInteger(turn) && turn >= 0 ? { turn } : {}),
    ...(typeof from === "number" && Number.isSafeInteger(from) && from >= 0 ? { from } : {}),
    ...(typeof to === "number" && Number.isSafeInteger(to) && to >= 0 ? { to } : {}),
  };
}

/**
 * 轮次尾部按钮（turnTail slot occupant）。
 * @param props - slot props（含 turn 与 hooks）。
 * @returns 按钮元素。
 */
export function TurnForwardButton(props: any): any {
  const label = "转发此轮到其他会话";
  // useChat 是 slot 注入的 React hook，只能在渲染期调用；点击时不能再取。
  const readChat = typeof props?.useChat === "function" ? props.useChat : undefined;
  const chat = readChat !== undefined ? readChat((snapshot: any) => snapshot) : undefined;
  const rows = React.useMemo(
    () => rowsFromChat(chat, props?.turn) ?? collectRows(props),
    [chat, props?.turn],
  );

  // 勾选态与悬停态都由 store 驱动：消息区是分页渲染的，勾选状态不能挂在 DOM 上。
  const [, setTick] = React.useState(0);
  React.useEffect(() => subscribeForward(() => setTick((value) => value + 1)), []);

  const info = turnInfo(props?.turn);
  const turn = info.turn;
  const selected = turn !== undefined && isTurnSelected(turn);
  const selectedCount = getSelectedTurns().length;
  // 其它已勾选的轮次；按钮所在轮不在这里（它由本次点击补上）。
  const otherTurns = getSelectedTurns().filter((value) => value !== turn);
  const otherKey = otherTurns.join(",");

  const onClick = (): void => {
    const sourceId = typeof props?.sessionId === "string" ? props.sessionId : "";
    const sourceLabel =
      typeof props?.sessionLabel === "string" && props.sessionLabel !== ""
        ? props.sessionLabel
        : sourceId !== ""
          ? shortSessionId(sourceId)
          : "当前会话";
    // 诊断：面板能否改走 Host 原始日志，取决于这里能否解析出轮次。
    console.warn(
      "[dsh-session-cite] 转发按钮 props：turn=" + String(props?.turn) + "（" + typeof props?.turn + "）" +
        " 解析=" + JSON.stringify(info) + " rows=" + rows.length + " 已勾选=" + selectedCount,
    );
    // 有其它轮被勾选时走合并：勾选轮 ∪ 按钮所在轮（无论该轮是否勾选）。
    if (turn !== undefined && otherTurns.length > 0) {
      void openMultiForward({ sourceId, sourceLabel, turns: [...otherTurns, turn] });
      return;
    }
    openForward({
      sourceId,
      sourceLabel,
      rows,
      ...info,
      ...(rows.length === 0 ? { unavailable: "本轮没有可转发的消息" } : {}),
    });
  };

  const onToggle = (event: any): void => {
    event.stopPropagation();
    event.preventDefault();
    if (turn === undefined) return;
    // 超过上限时拒绝：提示放在 title 与一次告警里，不打断操作。
    if (!toggleTurn(turn)) {
      console.warn("[dsh-session-cite] 一次最多勾选 " + MAX_SELECTED_TURNS + " 轮");
    }
  };

  // 把「勾选框 + 按钮」整组搬进按钮行：turnTail slot 的容器是按钮行的兄弟，
  // 直接渲染只能落在按钮行上方单独一行。用注释占位保留 React 的挂载位置，
  // 卸载时先搬回原位，React 才能正常移除节点。
  //
  // 为什么要重试：slot 的注册经 ctx.slots.inject 异步落地，首次 effect 执行时
  // 按钮行的 [data-clock] 有可能还没挂载（实测就卡在这里，静默 return 导致永不搬家）。
  // 因此最多试 4 次、间隔 60ms，全部失败才告警一次。
  const hostRef = React.useRef(null);
  React.useEffect(() => {
    if (typeof document === "undefined") return undefined;
    let placeholder: any = null;
    let moved: any = null;
    let tries = 0;
    let timer: any = null;
    const attempt = (): void => {
      const element = hostRef.current as any;
      if (element === null || element === undefined) return;
      const tail = element.closest?.('[data-dsh-part="turn-tail"]');
      const actions = tail?.querySelector?.('[data-clock]');
      if (actions === null || actions === undefined) {
        tries += 1;
        if (tries < 4) {
          timer = setTimeout(attempt, 60);
        } else if (!warnedMove) {
          warnedMove = true;
          console.warn("[dsh-session-cite] 转发按钮未能移入按钮行：找不到 [data-clock]（按钮仍在 turnTail slot 内）");
        }
        return;
      }
      const parent = element.parentNode;
      if (parent === null) return;
      placeholder = document.createComment("session-cite-forward");
      parent.insertBefore(placeholder, element);
      // 插到「在新对话中分支」之后、用量信息之前：那才是与兄弟按钮同组的位置。
      // appendChild 会落到 clock 末尾（用量与耗时之后），看起来像被推到最右端。
      const branch = actions.querySelector?.('button[aria-label*="分支"]') as any;
      actions.insertBefore(element, branch === null || branch === undefined ? null : branch.nextSibling);
      // 取相邻按钮的颜色写进 CSS 变量，让图标与兄弟按钮同色（含主题切换）。
      const sample = (branch ?? actions.querySelector?.("button")) as any;
      if (sample !== null && sample !== undefined && typeof getComputedStyle === "function") {
        try {
          element.style.setProperty("--cite-color", getComputedStyle(sample).color);
        } catch {
          // 取不到样式时用 CSS 里的兜底颜色。
        }
      }
      moved = element;
    };
    attempt();
    return () => {
      if (timer !== null) clearTimeout(timer);
      if (moved !== null && placeholder !== null) {
        try {
          placeholder.parentNode?.replaceChild(moved, placeholder);
        } catch {
          // 父节点已随会话销毁：忽略。
        }
      }
    };
  }, [props?.turn]);

  return React.createElement(
    "span",
    { ref: hostRef, className: "dsh-session-cite-actions" },
    React.createElement(
      "button",
      {
        type: "button",
        className: "dsh-session-cite-forward",
        onClick,
        "aria-label": label,
        title: label,
        // 不传内联 style：尺寸/内边距/圆角/颜色统一由注入的 CSS 类决定，
        // 否则内联值会盖掉类里的设置（之前就是内联 24×24 盖住了 28×28）。
      },
      ForwardIcon(),
    ),
    // 勾选框放在转发按钮**右侧**：展开时只推动右侧的「用量/时间」文字，
    // 转发按钮自身位置不变（点击位置不跳），也不会盖住左侧的「分支」按钮。
    // 外面这层 slot 负责「占不占宽度」：收起 width 0，悬停/选中时过渡到 22px，
    // 内层按钮固定 20px 不参与布局计算，宽度动画才不会被按钮尺寸干扰。
    turn === undefined
      ? null
      : React.createElement(
          "span",
          {
            className: "dsh-session-cite-pick-slot",
            // 只保留「已勾选常驻」；出现与否由 CSS 的 :hover 决定，不再由消息悬停驱动。
            "data-on": selected ? "true" : "false",
          },
          React.createElement(
            "button",
            {
              type: "button",
              className: "dsh-session-cite-pick",
              "aria-pressed": selected,
              "aria-label": selected ? "取消选中本轮" : "选中本轮",
              title: selected
                ? "取消选中本轮"
                : "选中本轮（可与其它轮合并转发）· 已选 " + selectedCount + "/" + MAX_SELECTED_TURNS + " 轮",
              onClick: onToggle,
            },
            selected ? CheckIcon() : null,
          ),
        ),
  );
}
