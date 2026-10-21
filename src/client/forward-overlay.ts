/**
 * 转发面板的界面层：会话选择 + 转发弹窗 + 待回填队列消费。
 *
 * 与 forward-panel 的分工：那边是按钮与面板状态（无 UI），这边是 visual 部分。
 * 全部用 React.createElement，不引入任何新依赖；配色走 dsh 的 CSS 变量，取不到时回落到中性色。
 */

import {
  buildDraftMentions,
  buildForwardText,
  defaultSelection,
  kindStats,
  mustCompact,
  putPending,
  rowLabel,
  selectedWeight,
  takePending,
  toggleKind,
} from "./forward-logic.js";
import { toSessionOptions } from "./session-picker.js";
import { closeForward, chooseTarget, getForwardState, subscribeForward } from "./forward-panel.js";
import { EMPTY_ARCHIVED, loadArchivedIds } from "./archive-status.js";

declare const require: (spec: string) => any;

const React: any = (() => {
  try {
    return require("react");
  } catch {
    return null;
  }
})();

/** apply 时注入：客户端上下文与草稿写入函数（避免与 client.tsx 形成循环依赖）。 */
let runtimeCtx: any = null;
let applyDraftFn: any = null;

/** 绑定插件上下文与草稿写入函数。 */
export function bindForwardContext(ctx: any, applyDraft: any): void {
  runtimeCtx = ctx;
  applyDraftFn = applyDraft;
}

/** 探测会话导航服务（服务名随版本可能不同，逐个试）。 */
function findWorkspace(): any {
  if (runtimeCtx === null) return undefined;
  for (const name of ["workspace", "uiWorkspace", "workspaces"]) {
    const service = typeof runtimeCtx.get === "function" ? runtimeCtx.get(name) : runtimeCtx[name];
    if (service !== undefined && service !== null && typeof service.openSession === "function") return service;
  }
  return undefined;
}

/** 客户端会话快照，与裸 /ref 共用同一数据源。 */
function findSessions(): any {
  if (runtimeCtx === null) return undefined;
  const sessions = typeof runtimeCtx.get === "function" ? runtimeCtx.get("sessions") : runtimeCtx.sessions;
  return sessions?.list?.getSnapshot?.();
}

const BORDER = "1px solid var(--dsh-border, rgba(255,255,255,0.14))";

/** 卡片：定位在输入区上方。 */
function cardStyle(): any {
  return {
    position: "fixed",
    left: "50%",
    // 输入框贴近视口底部，卡片要明显高于它才像上拉列表。
    bottom: 168,
    transform: "translateX(-50%)",
    width: "min(760px, 92vw)",
    maxHeight: "70vh",
    display: "flex",
    flexDirection: "column",
    background: "var(--dsh-surface, #1f2124)",
    border: BORDER,
    borderRadius: 12,
    boxShadow: "0 18px 48px rgba(0,0,0,0.38)",
    zIndex: 2147000000,
    overflow: "hidden",
    fontSize: 13,
  };
}

function maskStyle(): any {
  return { position: "fixed", inset: 0, background: "rgba(0,0,0,0.32)", zIndex: 2146999999 };
}

function actionStyle(primary: boolean): any {
  return {
    padding: "6px 14px",
    borderRadius: 8,
    border: BORDER,
    background: primary ? "var(--dsh-accent, #3b82f6)" : "transparent",
    color: primary ? "#fff" : "inherit",
    cursor: "pointer",
    fontSize: 13,
  };
}

/** 第一步：选目标会话。 */
function PickerStage(props: any): any {
  const [query, setQuery] = React.useState("");
  // 选中已归档会话时先落到这里：非空即渲染确认视图。
  const [pending, setPending] = React.useState(null);
  // 归档集合异步加载：没装归档插件或请求失败时保持空集，列表行为与之前一致。
  const [archived, setArchived] = React.useState(EMPTY_ARCHIVED);
  React.useEffect(() => {
    let alive = true;
    loadArchivedIds()
      .then((ids: ReadonlySet<string>) => {
        if (alive) setArchived(ids);
      })
      .catch(() => {
        // 降级：保持空集。
      });
    return () => {
      alive = false;
    };
  }, []);
  const options = toSessionOptions(findSessions(), props.state.sourceId, undefined, archived);
  const keyword = query.trim().toLowerCase();
  const filtered = keyword === "" ? options : options.filter((o: any) => o.label.toLowerCase().includes(keyword));

  // 归档会话的二次确认：列表整体换成确认视图，避免和列表同屏造成误点。
  if (pending !== null) {
    const target = pending as { id: string; label: string };
    return React.createElement(
      "div",
      { style: cardStyle() },
      React.createElement("div", { style: { padding: "14px 16px 4px", fontWeight: 600, fontSize: 14 } }, "该会话已归档"),
      React.createElement(
        "div",
        { style: { padding: "0 16px 14px", opacity: 0.78, lineHeight: 1.7, fontSize: 13 } },
        React.createElement("div", { style: { opacity: 0.9 } }, target.label),
        React.createElement(
          "div",
          { style: { marginTop: 8 } },
          "归档只做记账、不清内容，但该会话通常已不可正常读取。引用它可能失败。",
        ),
      ),
      React.createElement(
        "div",
        { style: { display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 16px 14px", borderTop: BORDER } },
        React.createElement("button", { type: "button", onClick: () => setPending(null), style: actionStyle(false) }, "返回选别的"),
        React.createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              setPending(null);
              chooseTarget(target.id, target.label.split(" · ")[0] ?? target.label);
            },
            style: actionStyle(true),
          },
          "仍然选择",
        ),
      ),
    );
  }

  return React.createElement(
    "div",
    { style: cardStyle() },
    React.createElement("div", { style: { padding: "10px 14px 6px", opacity: 0.72 } }, "选择要转发到的会话"),
    React.createElement("input", {
      type: "text",
      value: query,
      autoFocus: true,
      placeholder: "搜索会话标题或 id…",
      onChange: (e: any) => setQuery(e.target.value),
      style: { margin: "0 14px 8px", padding: "8px 10px", borderRadius: 8, border: BORDER, background: "transparent", color: "inherit", fontSize: 13 },
    }),
    React.createElement("div", { style: { overflowY: "auto", maxHeight: "46vh" } },
      filtered.length === 0
        ? React.createElement("div", { style: { padding: "12px 14px", opacity: 0.6 } }, "没有匹配的会话")
        : filtered.map((option: any) =>
            React.createElement("button", {
              key: option.id,
              type: "button",
              onClick: () => {
                const target = option;
                // 归档会话先确认再跳转：它多半已经读不出来，误触的代价是白跑一趟。
                if (target.archived === true) setPending(target);
                else chooseTarget(target.id, target.label.split(" · ")[0] ?? target.label);
              },
              style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                width: "100%",
                padding: "8px 14px",
                border: "none",
                background: "transparent",
                color: "inherit",
                cursor: "pointer",
                fontSize: 13,
                textAlign: "left",
                // 已归档行整体变淡：仍可点，但视觉上明确退到背景里。
                opacity: option.archived === true ? 0.48 : 1,
              },
            },
              React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
                React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, option.label),
                option.archived === true
                  ? React.createElement("span", { style: { flex: "none", fontSize: 11, padding: "1px 6px", borderRadius: 999, border: BORDER, opacity: 0.8 } }, "已归档")
                  : null,
              ),
              option.detail === undefined ? null : React.createElement("span", { style: { opacity: 0.55, flex: "none" } }, option.detail),
            ),
          ),
    ),
  );
}

/** 第二步：勾消息、写附言、决定压缩与去向。 */
function DialogStage(props: any): any {
  const state = props.state;
  const config = props.config;
  const [selected, setSelected] = React.useState(() => defaultSelection(state.rows));
  const [note, setNote] = React.useState("");
  const [compact, setCompact] = React.useState(false);
  const totalWeight = selectedWeight(state.rows, selected, config.asciiWeight);
  const forced = mustCompact(totalWeight, config.maxChars);
  const effectiveCompact = forced || compact;
  const stats = kindStats(state.rows, selected);

  const apply = (mode: "draft" | "send") => {
    const rows = state.rows.filter((row: any) => selected.has(row.seq));
    if (rows.length === 0 || state.targetId === undefined) return;
    const label = state.targetLabel ?? state.targetId;
    // 两条路径的取舍：
    //   draft                     → 一律 message mention（chip），内容提交时由 pre-step 展开；
    //   send 且未压缩             → 直接拼转发块提交，不依赖 pre-step，链路面最窄；
    //   send 且压缩               → 必须走 mention，因为只有 pre-step 那侧能调模型做摘要。
    const useMention = mode === "draft" || effectiveCompact;
    const text = useMention
      ? buildDraftMentions({
          sessionId: state.sourceId,
          rows,
          note,
          compact: effectiveCompact,
        })
      : // header 必须写**源**会话：消息序号属于源会话，写目标会话会让模型误以为
        // 这些 #seq 是该会话自己的消息（render.ts 的「来自会话」就是这个语义）。
        buildForwardText({
          sessionId: state.sourceId,
          label: state.sourceLabel === "" ? state.sourceId : state.sourceLabel,
          rows,
          note,
        });
    putPending(state.targetId, { text, mode, label });
    try {
      findWorkspace()?.openSession?.(state.targetId);
    } catch {
      // 跳转失败时队列保留，目标会话下次挂载仍会回填。
    }
    closeForward();
  };

  return React.createElement(
    "div",
    { style: cardStyle() },
    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "10px 14px 6px" } },
      React.createElement("strong", { style: { fontWeight: 600 } }, "转发到「" + (state.targetLabel ?? "") + "」"),
      React.createElement("span", { style: { opacity: 0.6 } }, "本轮 " + state.rows.length + " 条可转发 · 已选 " + selected.size + " 条"),
    ),
    React.createElement("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", padding: "0 14px 8px" } },
      stats.map((stat: any) =>
        React.createElement("button", {
          key: stat.kind,
          type: "button",
          title: stat.all ? "取消该类全部" : "选中该类全部",
          onClick: () => setSelected((prev: Set<number>) => toggleKind(state.rows, new Set(prev), stat.kind)),
          style: { padding: "3px 9px", borderRadius: 999, border: BORDER, background: stat.all ? "rgba(59,130,246,0.22)" : "transparent", color: "inherit", cursor: "pointer", fontSize: 12 },
        }, stat.kind + " " + stat.selected + "/" + stat.total),
      ),
    ),
    React.createElement("div", { style: { overflowY: "auto", maxHeight: "38vh" } },
      state.rows.map((row: any) =>
        React.createElement("label", { key: row.seq, style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", cursor: "pointer" } },
          React.createElement("input", {
            type: "checkbox",
            checked: selected.has(row.seq),
            onChange: (e: any) => setSelected((prev: Set<number>) => {
              const next = new Set(prev);
              if (e.target.checked) next.add(row.seq);
              else next.delete(row.seq);
              return next;
            }),
          }),
          React.createElement("span", null, rowLabel(row)),
        ),
      ),
    ),
    React.createElement("textarea", {
      value: note,
      rows: 2,
      placeholder: "转发附言（可选）",
      onChange: (e: any) => setNote(e.target.value),
      style: { margin: "8px 14px", padding: "8px 10px", borderRadius: 8, border: BORDER, background: "transparent", color: "inherit", fontSize: 13, resize: "vertical" },
    }),
    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, padding: "8px 14px 12px", borderTop: "1px solid var(--dsh-border, rgba(255,255,255,0.08))", fontSize: 12 } },
      React.createElement("span", { style: { opacity: 0.75 } }, "折合 " + Math.round(totalWeight) + " 字 / 上限 " + config.maxChars),
      React.createElement("label", { style: { display: "flex", alignItems: "center", gap: 6, opacity: forced ? 0.6 : 1 } },
        React.createElement("input", { type: "checkbox", checked: effectiveCompact, disabled: forced, onChange: (e: any) => setCompact(e.target.checked) }),
        "压缩" + (forced ? "（超上限，已强制开启）" : ""),
      ),
      React.createElement("div", { style: { flex: 1 } }),
      React.createElement("button", { type: "button", onClick: () => apply("draft"), style: actionStyle(false) }, "草稿"),
      React.createElement("button", { type: "button", onClick: () => apply("send"), style: actionStyle(true) }, "直接发送"),
    ),
  );
}

/**
 * 面板占位者：conversation.input.overlay。
 * 同时负责消费待回填队列（目标会话挂载后在这里取走内容）。
 */
export function ForwardOverlay(props: any): any {
  const [snapshot, setSnapshot] = React.useState(() => getForwardState());
  React.useEffect(() => subscribeForward(() => setSnapshot(getForwardState())), []);

  React.useEffect(() => {
    const sessionId = typeof props?.sessionId === "string" ? props.sessionId : undefined;
    if (sessionId === undefined) return;
    const pending = takePending(sessionId);
    if (pending === undefined) return;
    const actions = props?.inputActions;
    if (actions === undefined || typeof actions.setDraft !== "function") return;
    try {
      applyDraftFn?.(actions, pending.text);
    } catch {
      return;
    }
    if (pending.mode !== "send") return;
    if (typeof actions.submit !== "function") return;
    globalThis.setTimeout(() => {
      try {
        actions.submit();
      } catch {
        // 提交失败时草稿仍在，用户可手动发送。
      }
    }, 220);
  }, [props?.sessionId, props?.inputActions]);

  if (snapshot.stage === "closed") return null;
  const config = {
    asciiWeight: typeof props?.pickAsciiWeight === "number" ? props.pickAsciiWeight : 0.25,
    maxChars: typeof props?.pickMaxChars === "number" ? props.pickMaxChars : 4000,
  };
  const body =
    snapshot.stage === "picker"
      ? React.createElement(PickerStage, { state: snapshot })
      : React.createElement(DialogStage, { state: snapshot, config });
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("div", { style: maskStyle(), onClick: closeForward }),
    body,
  );
}
