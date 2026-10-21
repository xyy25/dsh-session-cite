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
  /** 本轮可转发的消息。 */
  rows: ForwardRow[];
  /** 源会话（当前会话）。 */
  sourceId: string;
  sourceLabel: string;
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
  return rows;
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
  const kind = isResult ? "tool-result" : "tool-call";
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
 * 渲染转发图标（24x24 viewBox，currentColor 描边）。
 * @returns SVG 元素。
 */
function ForwardIcon(): any {
  return React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: 16,
    height: 16,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
    children: [
      React.createElement("path", { key: "a", d: "M4 8h9a4 4 0 0 1 4 4v7" }),
      React.createElement("path", { key: "b", d: "M15 16l2 3 2-3" }),
      React.createElement("path", { key: "c", d: "M8 5l-4 3 4 3" }),
    ],
  });
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
  const onClick = React.useCallback(() => {
    openForward({
      sourceId: typeof props?.sessionId === "string" ? props.sessionId : "",
      sourceLabel:
        typeof props?.sessionLabel === "string" && props.sessionLabel !== ""
          ? props.sessionLabel
          : typeof props?.sessionId === "string"
            ? shortSessionId(props.sessionId)
            : "当前会话",
      rows,
      ...(rows.length === 0 ? { unavailable: "本轮没有可转发的消息" } : {}),
    });
  }, [props, rows]);
  // 把按钮搬进按钮行末尾：turnTail slot 的容器是按钮行的兄弟，
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
    "button",
    {
      ref: hostRef,
      type: "button",
      className: "dsh-session-cite-forward",
      onClick,
      "aria-label": label,
      title: label,
      // 不传内联 style：尺寸/内边距/圆角/颜色统一由注入的 CSS 类决定，
      // 否则内联值会盖掉类里的设置（之前就是内联 24×24 盖住了 28×28）。
    },
    ForwardIcon(),
  );
}
