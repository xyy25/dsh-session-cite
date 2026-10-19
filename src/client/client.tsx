// dsh-session-cite 客户端源码：把本会话最近一次 /ref 命令结果回填进输入框草稿。
//
// 设计约束：
//   1) 运行时零外部依赖：本文件不 import 任何 @deepseek-ai 包（也不 import react），
//      只通过浏览器模块加载器提供的 require 取 react 平台 seed，因此编译产物里
//      不会残留任何 `from '@deepseek-ai/...'`。类型一律用结构式鸭子类型，规避
//      本机缺失的客户端 .d.ts 包。
//   2) 只用公开面：
//      - 会话作用域 slot 的 standard props 带 inputActions（InputActions，含 setDraft）
//        与 useConversation / useInput 选择器钩子；
//      - 命令结果以 chat 视图快照里的 command 节点公开（outcome.text）。
//   3) 组件渲染 null：只做副作用（回填草稿），不占据任何可见位置。

declare const require: (spec: string) => any;

/** react 平台 seed：加载失败时置空，让整个插件安静降级。 */
const React: any = (() => {
  try {
    return require("react");
  } catch {
    return null;
  }
})();

/** 已回填过的命令结果（commandId → 文本），用于去重。 */
const filled = new Map<string, string>();

/** 最近一次回填的文本；用户没改动草稿时允许下一次回填覆盖它。 */
let lastFilled = "";

/** 结果文本里必须出现的引用载荷前缀；没有它就说明这次 /ref 没产出引用。 */
const MENTION_PREFIX = "dsh-session:";
/** 规范 mention 的扫描正则；与服务端 dsh-session-reference 的解析规则一致。 */
const MENTION_RE = /@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)/gu;

/** 一次 mention 命中：坐标是 UTF-16 下标，与 dsh 的 Occurrence 契约一致。 */
type MentionHit = {
  offset: number;
  length: number;
  clipboardText: string;
  label: string;
  /** mention 里编码的会话 id；解码失败时为 undefined（此时不做缩略前缀）。 */
  sessionId?: string;
};

/**
 * 扫描文本里的规范 mention，供构造结构化草稿使用。
 * 不做任何 IO，纯函数，便于测试。
 * @param text - 命令结果文本。
 * @returns 按出现顺序排列的命中列表。
 */
export function scanMentions(text: string): MentionHit[] {
  const hits: MentionHit[] = [];
  if (typeof text !== "string" || text.length === 0) return hits;
  MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null = MENTION_RE.exec(text);
  while (match !== null) {
    const sessionId = decodeSessionId(match[2]);
    hits.push({
      offset: match.index,
      length: match[0].length,
      clipboardText: match[0],
      // label 里 \ 与 ] 被转义过，回显前要还原。
      label: match[1].replace(/\\(.)/gu, "$1"),
      ...sessionId === undefined ? {} : { sessionId },
    });
    if (MENTION_RE.lastIndex === match.index) MENTION_RE.lastIndex += 1;
    match = MENTION_RE.exec(text);
  }
  return hits;
}

/** 缩略 id 的显示长度：取 UUID 首段的前 8 位，足以区分同标题会话。 */
const SHORT_ID_LENGTH = 8;

/**
 * 从 dsh-session: URI 解出原始会话 id。
 * 编码是 base64url(JSON.stringify(sessionId))；浏览器没有 Buffer，用 atob + TextDecoder。
 * @param uri - 完整的 dsh-session: URI。
 * @returns 会话 id；载荷非法时返回 undefined。
 */
export function decodeSessionId(uri: string): string | undefined {
  if (typeof uri !== "string" || !uri.startsWith(MENTION_PREFIX)) return undefined;
  const payload = uri.slice(MENTION_PREFIX.length);
  if (payload.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(payload)) return undefined;
  try {
    const base64 = payload.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "string" && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 取会话 id 的缩略形式（去掉 session- 前缀后取前 8 位）。
 * @param sessionId - 完整会话 id。
 * @returns 缩略 id；无法缩略时返回空串。
 */
export function shortenSessionId(sessionId: string): string {
  if (typeof sessionId !== "string") return "";
  return sessionId.replace(/^session-/u, "").slice(0, SHORT_ID_LENGTH);
}

/**
 * chip 上显示的文字：缩略 id + 标题，用于区分标题相同的不同会话。
 * 标题本身就是这个 id、或已以它开头时不重复加前缀。
 * 注意只改显示 label，clipboardText 仍是原 mention 全文，
 * 因此复制与持久化投影（以及 snapshotSchema 校验）都不受影响。
 * @param label - mention 里的原始标题。
 * @param sessionId - 解码出的会话 id。
 * @returns 供 chip 显示的标签。
 */
export function displayLabel(label: string, sessionId: string | undefined): string {
  if (sessionId === undefined) return label;
  const short = shortenSessionId(sessionId);
  if (short.length === 0) return label;
  if (label === sessionId || label.startsWith(short)) return label;
  return short + " · " + label;
}

/** 结构化草稿被宿主拒绝时只告警一次，避免每次回填刷屏。 */
let warnedStructure = false;

function warnStructureRejected(error: unknown): void {
  if (warnedStructure) return;
  warnedStructure = true;
  console.warn("[dsh-session-cite] 结构化草稿被宿主拒绝，已回退纯文本：", error);
}

/**
 * 把回填文本写进输入框。
 *
 * 优先传结构化草稿快照：dsh 的 setDraft 接受 DraftInput（string | DraftSnapshot），
 * 带 references 时会走 restoreDraft，把 offset/length 区间替换成原生
 * ReferenceChipNode —— 即与 @ 选择会话插入的 chip 同款（蓝色、悬停背景）。
 * 若宿主只接受纯文本（旧版或收紧该行为），回退为字符串：功能不变，仅失去样式。
 * @param inputActions - 会话作用域 slot 的 InputActions。
 * @param text - 命令结果文本。
 */
export function applyDraft(inputActions: any, text: string): void {
  const hits = scanMentions(text);
  if (hits.length > 0) {
    const snapshot = {
      text,
      references: hits.map((hit) => ({
        // 与 dsh-client-ui-reference 插入的 session 引用同形：
        // ref 与 clipboardText 都是 mention 全文，appearance 决定蓝色 chip 样式。
        source: "reference",
        ref: hit.clipboardText,
        // 显示用缩略 id 前缀；ref/clipboardText 保持 mention 全文不变。
        label: displayLabel(hit.label, hit.sessionId),
        appearance: "session",
        offset: hit.offset,
        length: hit.length,
        clipboardText: hit.clipboardText,
      })),
    };
    try {
      inputActions.setDraft(snapshot);
      return;
    } catch (error) {
      warnStructureRejected(error);
    }
  }
  inputActions.setDraft(text);
}


/** 选择器只能返回稳定原始值，用该分隔符把命令 id 与文本拼成一个字符串。 */
const SEP = "\u0000";

/**
 * 从会话快照里挑出最新一条 **成功的** /ref 命令结果，编码成 "id\0提交行\0text"；没有则返回 null。
 *
 * 判据必须是「outcome 成功 且 能解析出规范 mention」：
 * 失败/用法提示里同样会出现 dsh-session: 字样（例如"请改用 dsh-session: 形式的引用"），
 * 凭文本包含关系猜测会把错误输出当引用回填。
 * @param snapshot - 会话视图快照。
 * @returns 编码串或 null。
 */
export function pickLatestRef(snapshot: any): string | null {
  const chat = snapshot?.views?.get?.("chat");
  const nodes = chat?.nodes;
  if (nodes === undefined || nodes === null || typeof nodes.values !== "function") return null;
  let best: any = null;
  for (const node of nodes.values()) {
    // chat 视图的节点是包装过的：kind/target 等视图元数据在顶层，
    // 命令本身的 {kind,seq,commandId,name,args,outcome} 在 node.data 里。
    if (node?.kind !== "command") continue;
    const data = node.data;
    if (data === undefined || data === null || data.kind !== "command") continue;
    if (data.name !== "ref") continue;
    const outcome = data.outcome;
    if (outcome === undefined || outcome === null) continue;
    // 只有成功结果才可能是引用载荷；错误结果即使含 dsh-session: 也必须排除。
    if (outcome.kind !== "success") continue;
    if (typeof outcome.text !== "string") continue;
    // 再要求真的能解析出规范 mention，避免把"恰好提到 dsh-session:"的成功文本当成引用。
    if (scanMentions(outcome.text).length === 0) continue;
    if (best === null || (data.seq ?? 0) >= (best.seq ?? 0)) best = data;
  }
  if (best === null) return null;
  const id = typeof best.commandId === "string" ? best.commandId : "seq:" + String(best.seq ?? 0);
  // 提交行用于识别「输入框里残留的正是这条命令本身」。
  const submittedLine = "/" + String(best.name ?? "") + String(best.args ?? "");
  return id + SEP + submittedLine + SEP + best.outcome.text;
}

/** /ref 结果 → 草稿的会话作用域 slot occupant（不可见）。 */
function DraftBackfill(props: any) {
  const inputActions = props?.inputActions;
  const useConversation = props?.useConversation;
  const useInput = props?.useInput;
  const selectLatest = React.useCallback((snapshot: any): string | null => pickLatestRef(snapshot), []);
  const selectDraft = React.useCallback((state: any): string => (typeof state?.draft === "string" ? state.draft : ""), []);
  const latest = typeof useConversation === "function" ? useConversation(selectLatest) : null;
  const draft = typeof useInput === "function" ? useInput(selectDraft) : "";

  React.useEffect(() => {
    if (typeof latest !== "string" || latest.length === 0) return;
    const cut = latest.indexOf(SEP);
    if (cut <= 0) return;
    const commandId = latest.slice(0, cut);
    const rest = latest.slice(cut + SEP.length);
    const cut2 = rest.indexOf(SEP);
    if (cut2 < 0) return;
    const submittedLine = rest.slice(0, cut2);
    const text = rest.slice(cut2 + SEP.length);
    if (filled.has(commandId)) return;
    const current = typeof draft === "string" ? draft : "";
    // 命令结果可能比输入框重置先到：此时 draft 里残留的正是刚提交的那行命令，
    // 它不算用户草稿，允许覆盖成引用。其它非空草稿一律不动。
    const isOwnSubmission = current.trim() !== "" && current.trim() === submittedLine.trim();
    if (current.length > 0 && current !== lastFilled && !isOwnSubmission) {
      filled.set(commandId, text);
      return;
    }
    if (typeof inputActions.setDraft !== "function") {
      filled.set(commandId, text);
      return;
    }
    if (isOwnSubmission) {
      // 提交后的输入框重置晚于命令结果到达：立刻写会被重置清掉，
      // 因此等一拍再写；即便如此也只写插件自己刚提交的那条命令。
      filled.set(commandId, text);
      globalThis.setTimeout(() => {
        try {
          applyDraft(inputActions, text);
          lastFilled = text;
        } catch {
          // 编辑器不可写时保持原状，不影响用户继续输入。
        }
      }, 120);
      return;
    }
    try {
      applyDraft(inputActions, text);
      lastFilled = text;
    } catch {
      // 编辑器尚未挂载或被提交锁定：不重试，避免和用户输入抢草稿。
    }
    filled.set(commandId, text);
  }, [latest, draft, inputActions]);

  return null;
}

export const inject = ["slots"];

export function apply(ctx: any): void {
  if (React === null) {
    console.warn("[dsh-session-cite] 缺少 react 平台 seed，draft 回填不可用");
    return;
  }
  if (ctx?.slots === undefined || ctx.slots === null) {
    console.warn("[dsh-session-cite] 缺少 slots 服务，draft 回填不可用");
    return;
  }
  try {
    ctx.slots.inject("conversation.input.dock", () =>
      ctx.slots.register(
        {
          name: "conversation.input.dock",
          id: "session-cite-draft",
          order: 0,
        },
        DraftBackfill,
      ),
    );
  } catch (error) {
    console.warn("[dsh-session-cite] 注册 draft 回填槽失败：", error);
  }
}
