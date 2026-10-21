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
import { EMPTY_INVENTORY, loadInventory } from "./archive-status.js";
import { buildSessionTree, filterOptions } from "./session-tree.js";

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

/** 分支会话诊断只打一次，避免每次开面板刷屏。 */
let warnedBranches = false;

/**
 * 卡片：视口居中，与 dsh 设置弹窗同一套对齐方式。
 *
 * 之前用「固定下边距 + 上拉列表」的定位，但那个前提是输入框贴在视口底部；
 * 一旦视口变高或变窄（浏览器窗口拉长、竖屏），卡片就明显偏下，观感很怪。
 * 居中定位与视口尺寸无关，任何宽高比下都稳定。
 */
function cardStyle(): any {
  return {
    position: "fixed",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: "min(760px, 92vw)",
    maxHeight: "min(80vh, 820px)",
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

/** 选择列表的一行：工作区分组 / 主会话 / 子代理 / 空提示。 */
type PickerRow =
  | { kind: "group"; id: string; title: string; count: number; collapsed: boolean }
  | { kind: "session"; option: any; childCount: number; expanded: boolean }
  | { kind: "child"; option: any }
  | { kind: "empty"; text: string };

/** 列表行的公共排版；各层只覆盖缩进与字重。 */
const PICKER_BASE_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "7px 14px",
  border: "none",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 13,
  textAlign: "left",
};

/** 行内小标签（已归档）。 */
function tagSpan(text: string): any {
  return React.createElement(
    "span",
    { style: { flex: "none", fontSize: 11, padding: "1px 6px", borderRadius: 999, border: BORDER, opacity: 0.8 } },
    text,
  );
}

/** 第一步：选目标会话（工作区 → 主会话 → 子代理）。 */
function PickerStage(props: any): any {
  const [query, setQuery] = React.useState("");
  // 选中已归档会话时先落到这里：非空即渲染确认视图。
  const [pending, setPending] = React.useState(null);
  // 清单异步加载：拿不到时是空清单，退化为「未分组 + 平铺」，列表照样能用。
  const [inventory, setInventory] = React.useState(EMPTY_INVENTORY);
  // 默认全部展开：记「被折叠的工作区」与「被展开的子代理」，省掉异步初始化。
  const [collapsedGroups, setCollapsedGroups] = React.useState(() => new Set());
  const [expandedNodes, setExpandedNodes] = React.useState(() => new Set());
  React.useEffect(() => {
    let alive = true;
    loadInventory()
      .then((loaded: any) => {
        if (alive) setInventory(loaded);
      })
      .catch(() => {
        // 降级：保持空清单。
      });
    return () => {
      alive = false;
    };
  }, []);

  const options = toSessionOptions(findSessions(), props.state.sourceId, undefined, inventory.archivedIds);
  const keyword = query.trim().toLowerCase();

  // 排障用：分支会话（带 parentId 但 origin≠subagent）必须留在顶层，
  // 这里统计一次，方便确认它们没有被当成子代理嵌下去。
  if (!warnedBranches && options.length > 0) {
    warnedBranches = true;
    const branches = options.filter(
      (option: any) => typeof option.parentId === "string" && option.parentId !== "" && option.origin !== "subagent",
    );
    const subagents = options.filter((option: any) => option.origin === "subagent");
    console.warn(
      "[dsh-session-cite] 转发会话类型：分支 " + branches.length + " 个（应并列），子代理 " + subagents.length + " 个（应折叠），共 " + options.length + " 个",
    );
  }

  const toggleIn = (setter: any, id: string): void => {
    setter((previous: Set<string>) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pick = (option: any): void => {
    // 归档会话先确认再跳转：它多半已经读不出来，误触的代价是白跑一趟。
    if (option.archived === true) setPending(option);
    else chooseTarget(option.id, option.label.split(" · ")[0] ?? option.label);
  };

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

  // 行模型：树状浏览与搜索平铺共用同一套渲染。
  let rows: PickerRow[];
  if (keyword !== "") {
    // 搜索时拍平：关键词已经收窄了范围，再要求逐层展开只会碍事。
    const hits = filterOptions(options, keyword, inventory);
    rows = hits.length === 0
      ? [{ kind: "empty", text: "没有匹配的会话" }]
      : hits.map((option: any) => ({ kind: "session", option, childCount: 0, expanded: false }));
  } else {
    rows = [];
    for (const group of buildSessionTree(options, inventory)) {
      const collapsed = collapsedGroups.has(group.id);
      rows.push({ kind: "group", id: group.id, title: group.title, count: group.count, collapsed });
      if (collapsed) continue;
      for (const node of group.nodes) {
        const expanded = expandedNodes.has(node.option.id);
        rows.push({ kind: "session", option: node.option, childCount: node.children.length, expanded });
        if (!expanded) continue;
        for (const child of node.children) rows.push({ kind: "child", option: child });
      }
    }
    if (rows.length === 0) rows.push({ kind: "empty", text: "还没有可转发的会话" });
  }

  return React.createElement(
    "div",
    { style: cardStyle() },
    React.createElement("div", { style: { padding: "10px 14px 6px", opacity: 0.72 } }, "选择要转发到的会话"),
    React.createElement("input", {
      type: "text",
      value: query,
      autoFocus: true,
      placeholder: "搜索会话标题、id 或工作区…",
      onChange: (e: any) => setQuery(e.target.value),
      style: { margin: "0 14px 8px", padding: "8px 10px", borderRadius: 8, border: BORDER, background: "transparent", color: "inherit", fontSize: 13 },
    }),
    React.createElement("div", { style: { overflowY: "auto", maxHeight: "46vh" } },
      rows.map((row: PickerRow) => {
        if (row.kind === "empty") {
          return React.createElement("div", { key: "empty", style: { padding: "12px 14px", opacity: 0.6 } }, row.text);
        }
        if (row.kind === "group") {
          // 第一级：工作区，点击折叠/展开。
          return React.createElement("button", {
            key: "g:" + row.id,
            type: "button",
            onClick: () => toggleIn(setCollapsedGroups, row.id),
            style: { ...PICKER_BASE_STYLE, padding: "8px 14px", fontWeight: 600, opacity: 0.86 },
          },
            React.createElement("span", { style: { width: 10, flex: "none", opacity: 0.55, fontSize: 11 } }, row.collapsed ? "▸" : "▾"),
            React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.title),
            React.createElement("span", { style: { marginLeft: "auto", flex: "none", opacity: 0.4, fontSize: 11 } }, String(row.count)),
          );
        }
        if (row.kind === "child") {
          // 第三级：子代理只能看不能选——它不能作为转发目标。
          return React.createElement(
            "div",
            { key: "c:" + row.option.id, style: { ...PICKER_BASE_STYLE, padding: "5px 14px 5px 40px", opacity: 0.45, fontSize: 12, cursor: "default" } },
            React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.option.label),
          );
        }
        // 第二级：主会话。左侧选中，右侧是子代理展开开关，两者互不干扰。
        const option = row.option;
        return React.createElement(
          "div",
          { key: "s:" + option.id, style: { display: "flex", alignItems: "stretch" } },
          React.createElement(
            "button",
            {
              type: "button",
              onClick: () => pick(option),
              style: { ...PICKER_BASE_STYLE, flex: 1, minWidth: 0, paddingLeft: 26, opacity: option.archived === true ? 0.48 : 1 },
            },
            React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, option.label),
            option.archived === true ? tagSpan("已归档") : null,
            option.detail === undefined
              ? null
              : React.createElement("span", { style: { marginLeft: "auto", flex: "none", opacity: 0.45, fontSize: 11 } }, option.detail),
          ),
          row.childCount === 0
            ? null
            : React.createElement(
                "button",
                {
                  type: "button",
                  title: row.expanded ? "收起子代理" : "展开子代理",
                  onClick: () => toggleIn(setExpandedNodes, option.id),
                  style: { ...PICKER_BASE_STYLE, width: "auto", flex: "none", padding: "5px 12px", fontSize: 11, opacity: 0.55 },
                },
                (row.expanded ? "▾ " : "▸ ") + row.childCount + " 个子代理",
              ),
        );
      }),
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
