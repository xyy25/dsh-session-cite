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

import { draftForSession, toSessionOptions } from "./session-picker.js";
import { loadArchivedIds } from "./archive-status.js";
import { TurnForwardButton } from "./forward-panel.js";
import { ForwardOverlay, bindForwardContext } from "./forward-overlay.js";

// 供测试与调试取用（bundle 的 factory 只暴露本文件的 exports）。
export { encodeSessionId, formatSessionMention, relativeTime, shortSessionId } from "./session-picker.js";
export { draftForSession, toSessionOptions };
export { loadArchivedIds, parseArchivedIds, parseInventory, resetArchiveCache } from "./archive-status.js";
export { buildSessionTree, filterOptions, ARCHIVED_ID, UNGROUPED_ID } from "./session-tree.js";
export * from "./forward-logic.js";
export {
  TurnForwardButton,
  closeForward,
  collectRows,
  getForwardState,
  openForward,
} from "./forward-panel.js";
export { ForwardOverlay, bindForwardContext } from "./forward-overlay.js";

declare const require: (spec: string) => any;

/**
 * 会话作用域输入框动作的登记表。
 *
 * inputActions 只在 slot 组件的 props 里出现，而 popupSelect 的 onSelect 拿到的是
 * 根层 ClientSessionContext（只带 sessionId）。因此由组件挂载时登记，选中时按
 * sessionId 取用；拿不到 sessionId 的组件退到通配键，保证单会话标签页仍可用。
 */
const inputActionsBySession = new Map<string, any>();
const INPUT_ACTIONS_FALLBACK = "*";

/**
 * 取某个会话的输入框动作。
 * @param sessionId - 目标会话 id。
 * @returns 已登记的 InputActions；没有则 undefined。
 */
function pickInputActions(sessionId: string | undefined): any {
  if (typeof sessionId === "string" && inputActionsBySession.has(sessionId)) {
    return inputActionsBySession.get(sessionId);
  }
  return inputActionsBySession.get(INPUT_ACTIONS_FALLBACK);
}

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

/**
 * 消息级 --draft 的转发块标记。
 *
 * 会话级 --draft 的结果里带 mention，可以直接 chip 化；消息级 --pick 的结果是纯转发文本，
 * 没有任何 mention，所以改用这对成对标记识别——只有 --draft 会同时输出起止两行，
 * --send 的简短确认里不会出现，因此不会把已发送的结果错填进草稿。
 */
const FORWARD_START = "【转发内容】";
const FORWARD_END = "【转发内容结束】";
/**
 * 规范 mention 的扫描正则，覆盖两种 scheme：
 *   - dsh-session:         会话级引用（内建 dsh-session-reference 处理，首轮就会 chip 化）
 *   - dsh-session-message: 消息级引用（本插件的 agent/pre-step 展开）
 */
const MENTION_RE = /@\[((?:\\.|[^\\\]])*)\]\((dsh-session(?:-message)?:[^\s)]*)\)/gu;

/** mention 的两种来源。 */
type MentionScheme = "session" | "message";

/** 一次 mention 命中：坐标是 UTF-16 下标，与 dsh 的 Occurrence 契约一致。 */
type MentionHit = {
  offset: number;
  length: number;
  clipboardText: string;
  label: string;
  /** mention 里编码的会话 id；解码失败或消息级引用时为 undefined。 */
  sessionId?: string;
  /** 会话级还是消息级。 */
  scheme: MentionScheme;
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
    const uri = match[2];
    // 消息级载荷是 {s,q} 而不是裸 id，不能走会话级解码。
    const isMessage = uri.startsWith("dsh-session-message:");
    const sessionId = isMessage ? undefined : decodeSessionId(uri);
    hits.push({
      scheme: isMessage ? "message" : "session",
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
        // 消息级的 label 本身已是「#9 user」，再拼会话短 id 只会变长。
        label: hit.scheme === "message" ? hit.label : displayLabel(hit.label, hit.sessionId),
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
    // 会话级：必须能解析出规范 mention，避免把"恰好提到 dsh-session:"的成功文本当成引用。
    // 消息级：--draft --pick 输出的是纯转发文本，用成对的转发块标记识别。
    const hasMention = scanMentions(outcome.text).length > 0;
    const hasForwardBlock = outcome.text.includes(FORWARD_START) && outcome.text.includes(FORWARD_END);
    if (!hasMention && !hasForwardBlock) continue;
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

  // 登记给 popupSelect 的 onSelect 用：选中会话后要把草稿写回这个输入框。
  const sessionId = typeof props?.sessionId === "string" ? props.sessionId : INPUT_ACTIONS_FALLBACK;
  React.useEffect(() => {
    if (inputActions === undefined || inputActions === null) return undefined;
    inputActionsBySession.set(sessionId, inputActions);
    return () => {
      if (inputActionsBySession.get(sessionId) === inputActions) inputActionsBySession.delete(sessionId);
    };
  }, [sessionId, inputActions]);

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

/**
 * 注入按钮自身样式。
 *
 * 曾经试过用 [data-turn-tail] 改布局把按钮挪进按钮行，但该属性在很多块上都有
 * （工具调用卡片等），全局 !important 会把整个尾部布局压歪，已回退。
 * 现在只给自己的按钮加样式，位置由 slot 决定。
 */
function injectForwardStyles(): void {
  try {
    const id = "dsh-session-cite-style";
    if (document.getElementById(id) !== null) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = [
      // 与同一按钮行里的原生按钮保持完全一致的排版：实测原生为 28×28、
      // padding 6、圆角 8、颜色 rgb(173,178,184)。颜色由 effect 从相邻按钮读出来
      // 写进 --cite-color，这样主题切换时也能跟着走。
      // 刻意不加 margin-left:auto —— 那会把按钮顶到按钮行最右端。
      ".dsh-session-cite-forward{display:flex;align-items:center;justify-content:center;",
      "width:28px;height:28px;padding:6px;border:0;border-radius:8px;background:transparent;",
      "color:var(--cite-color,rgb(173,178,184));cursor:pointer;opacity:1;",
      "transition:background .15s ease,color .15s ease;}",
      ".dsh-session-cite-forward:hover{background:rgba(127,127,127,.14);}",
    ].join("");
    document.head.appendChild(style);
  } catch {
    // 没有 document（非浏览器环境）时静默跳过。
  }
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

  bindForwardContext(ctx, applyDraft);
  injectForwardStyles();

  // 轮次尾部「转发」按钮：挂在 turnTail 而不是 assistant-actions，
  // 因为只有 turnTail 的 props 带 { turn, hooks.turnData }，能拿到本轮消息。
  try {
    ctx.slots.inject("conversation.chat.turnTail", () =>
      ctx.slots.register(
        {
          name: "conversation.chat.turnTail",
          id: "session-cite-forward-button",
          order: 0,
        },
        TurnForwardButton,
      ),
    );
  } catch (error) {
    console.warn("[dsh-session-cite] 注册转发按钮失败：", error);
  }

  // 面板（会话选择 + 转发弹窗）挂在输入区 overlay。
  try {
    ctx.slots.inject("conversation.input.overlay", () =>
      ctx.slots.register(
        {
          name: "conversation.input.overlay",
          id: "session-cite-forward-panel",
          order: 0,
        },
        ForwardOverlay,
      ),
    );
  } catch (error) {
    console.warn("[dsh-session-cite] 注册转发面板失败：", error);
  }

  // 裸 /ref（未给任何会话）时弹出会话选择器。
  // 注意契约：装饰只替换「裸调用」，带参数的 /ref ... 完全走原路径。
  // 选中后只回填草稿（/ref + mention chip），不直接提交，让用户确认后再发送。
  // 装饰必须在 commandUi 就绪后注册：服务晚于插件 apply 时，ctx.get 取不到。
  const withCommandUi = (scoped: any) => {
    const ui = typeof scoped.get === "function" ? scoped.get("commandUi") : scoped.commandUi;
    if (ui === undefined || ui === null || typeof ui.decorate !== "function") {
      console.warn("[dsh-session-cite] 缺少 commandUi 服务，/ref 会话选择器不可用");
      return;
    }
    registerDecoration(scoped, ui);
  };
  try {
    if (typeof ctx.inject === "function") {
      ctx.inject(["commandUi"], withCommandUi);
    } else {
      withCommandUi(ctx);
    }
  } catch (error) {
    console.warn("[dsh-session-cite] 注册会话选择器失败：", error);
  }
}

/**
 * 注册 /ref 的裸调用装饰：弹出会话选择器，选中后只回填草稿。
 * @param ctx - 已具备 commandUi 的（作用域）客户端上下文。
 * @param commandUi - 命令 UI 服务。
 */
function registerDecoration(ctx: any, commandUi: any): void {
  try {
    const register =
      typeof ctx.effect === "function"
        ? (fn: () => any, label: string) => ctx.effect(fn, label)
        : (fn: () => any) => fn();
    register(
      () =>
        commandUi.decorate({
          name: "ref",
          available: () => true,
          ui: {
            kind: "popupSelect",
            searchMode: "substring",
            searchLabels: () => ({
              placeholder: "搜索会话标题或 id…",
              empty: "还没有任何会话",
              noResults: "没有匹配的会话",
            }),
            options: async (session: any) => {
              const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : ctx.sessions;
              const state = sessions?.list?.getSnapshot?.();
              // 已归档会话仍留在 sessions.list 里（归档只记账、不搬文件），
              // 拿归档集合让它们沉底并标记；插件没装或请求失败时为空集。
              const archived = await loadArchivedIds();
              return toSessionOptions(state, session?.sessionId, undefined, archived);
            },
            onSelect: (option: any, session: any) => {
              const actions = pickInputActions(session?.sessionId);
              if (actions === undefined || actions === null || typeof actions.setDraft !== "function") {
                console.warn("[dsh-session-cite] 找不到输入框，无法回填会话引用");
                return;
              }
              const text = draftForSession(option);
              applyDraft(actions, text);
              lastFilled = text;
            },
          },
        }),
      "session-cite: /ref popupSelect",
    );
  } catch (error) {
    console.warn("[dsh-session-cite] 注册会话选择器失败：", error);
  }
}
