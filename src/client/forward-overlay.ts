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
  dropPending,
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
import { fetchTurnRows } from "./turn-source.js";

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

/** 消息来源偏好的存储键。 */
const SOURCE_PREF_KEY = "dsh-session-cite:forward-source";

/**
 * 读取上次选用的消息来源。
 *
 * 刻意只在「曾经成功加载过原始日志」时写下偏好：没有记录就默认快照，
 * 于是首次使用、或 Host 重启导致缓存清空后加载失败，都会回到快照。
 * @returns `host` 或 `snapshot`。
 */
function readSourcePref(): "host" | "snapshot" {
  try {
    return globalThis.localStorage?.getItem(SOURCE_PREF_KEY) === "host" ? "host" : "snapshot";
  } catch {
    return "snapshot";
  }
}

/**
 * 记录消息来源偏好；传 `snapshot` 表示清除记录。
 * @param value - 目标来源。
 */
function writeSourcePref(value: "host" | "snapshot"): void {
  try {
    if (value === "host") globalThis.localStorage?.setItem(SOURCE_PREF_KEY, "host");
    else globalThis.localStorage?.removeItem(SOURCE_PREF_KEY);
  } catch {
    // 隐私模式等禁写场景：忽略，行为退化为「每次默认快照」。
  }
}

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

/** 行内小标签（已归档 / 当前）。accent 用于「当前会话」这种需要一眼看到的标记。 */
function tagSpan(text: string, accent?: boolean): any {
  return React.createElement(
    "span",
    {
      style: {
        flex: "none",
        fontSize: 11,
        padding: "1px 6px",
        borderRadius: 999,
        border: accent === true ? "1px solid var(--dsh-accent, #3b82f6)" : BORDER,
        color: accent === true ? "var(--dsh-accent, #3b82f6)" : "inherit",
        opacity: accent === true ? 0.9 : 0.8,
      },
    },
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
            // 「当前」用强调色，因为它回答的是「我现在在哪个会话」；
            // 它和「已归档」可以并存（当前会话也可能被归档过）。
            option.current === true ? tagSpan("当前", true) : null,
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
  // 消息来源：优先 Host 原始日志（与 /ref --list 同源，tool-call 与 tool-result
  // 各自成行）；路由不可用（Host 未重启 / 非 web 形态 / 请求失败）时回退到
  // chat 快照，面板不会因此变空。
  // 消息来源：单一三态视图，而不是 (wanted, loading) 两个布尔。
  // 之前用两个布尔时，切回快照会触发 effect cleanup 把 alive 置 false，
  // 于是 `.then` 里的 setLoading(false) 永远不执行，标题就一直卡在「读取中」。
  // 现在 loading 只是 view 的一个取值，切走就自然不成立。
  const [view, setView] = React.useState(() => (readSourcePref() === "host" ? "loading" : "snapshot"));
  const [hostData, setHostData] = React.useState(null);
  const rows = view === "host" && hostData !== null ? hostData.rows : state.rows;
  // 原始日志里被跳过的条数（正文为空的纯工具轮次等），与 --list 的口径一致。
  const skipped: number = view === "host" && hostData !== null ? hostData.skipped : 0;
  const [selected, setSelected] = React.useState(() => defaultSelection(state.rows));
  const [note, setNote] = React.useState("");
  const [compact, setCompact] = React.useState(false);
  // 展开的行：与勾选状态彼此独立，展开只是为了看全文。
  const [expandedRows, setExpandedRows] = React.useState(() => new Set());
  const toggleRow = (seq: number): void => {
    setExpandedRows((prev: Set<number>) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  /**
   * 切换数据源。
   * 已有原始日志缓存时直接显示，不再发请求；切回快照会立刻结束 loading 状态。
   */
  const toggleSource = (): void => {
    if (view === "snapshot") {
      setView(hostData !== null ? "host" : "loading");
      writeSourcePref("host");
      return;
    }
    setView("snapshot");
    writeSourcePref("snapshot");
  };

  // 来源切换后选中集会变，重新按默认规则选一次（user/assistant）。
  React.useEffect(() => {
    setSelected(defaultSelection(rows));
  }, [rows]);

  React.useEffect(() => {
    if (view !== "loading") return undefined;
    // 已经取过就直接用缓存，避免重复解压日志。
    if (hostData !== null) {
      setView("host");
      return undefined;
    }
    const turn = state.turn;
    if (typeof turn !== "number") {
      setView("snapshot");
      return undefined;
    }
    let alive = true;
    fetchTurnRows(state.sourceId, turn, state.fromSeq, state.toSeq)
      .then((loaded) => {
        // 期间用户切回快照：丢弃结果，view 已经是 snapshot，无需再改。
        if (!alive) return;
        if (loaded === undefined || loaded.rows.length === 0) {
          // 加载失败：退回快照并清掉偏好，下次打开不再白等一次。
          setView("snapshot");
          writeSourcePref("snapshot");
          return;
        }
        setHostData(loaded);
        setView("host");
      })
      .catch(() => {
        if (!alive) return;
        setView("snapshot");
        writeSourcePref("snapshot");
      });
    return () => {
      alive = false;
    };
  }, [view, hostData, state.sourceId, state.turn, state.fromSeq, state.toSeq]);
  const totalWeight = selectedWeight(rows, selected, config.asciiWeight);
  const forced = mustCompact(totalWeight, config.maxChars);
  const effectiveCompact = forced || compact;
  const stats = kindStats(rows, selected);

  const apply = (mode: "draft" | "send") => {
    const picked = rows.filter((row: any) => selected.has(row.seq));
    if (picked.length === 0 || state.targetId === undefined) return;
    const label = state.targetLabel ?? state.targetId;
    // 两条路径的取舍：
    //   draft                     → 一律 message mention（chip），内容提交时由 pre-step 展开；
    //   send 且未压缩             → 直接拼转发块提交，不依赖 pre-step，链路面最窄；
    //   send 且压缩               → 必须走 mention，因为只有 pre-step 那侧能调模型做摘要。
    const useMention = mode === "draft" || effectiveCompact;
    const text = useMention
      ? buildDraftMentions({
          sessionId: state.sourceId,
          rows: picked,
          note,
          compact: effectiveCompact,
        })
      : // header 必须写**源**会话：消息序号属于源会话，写目标会话会让模型误以为
        // 这些 #seq 是该会话自己的消息（render.ts 的「来自会话」就是这个语义）。
        buildForwardText({
          sessionId: state.sourceId,
          label: state.sourceLabel === "" ? state.sourceId : state.sourceLabel,
          rows: picked,
          note,
        });
    // 目标是当前会话时不能走 pending 队列：openSession 对同一会话是空操作，
    // ForwardOverlay 的消费 effect 依赖（sessionId / inputActions）都不变，
    // 队列永远不会被取走——草稿不会回填，而且这条残留会在下次切回本会话时
    // 被误消费。所以这一种情况直接对当前输入框动手。
    if (state.targetId === state.sourceId) {
      dropPending(state.targetId);
      const actions = props?.inputActions;
      if (actions !== undefined && actions !== null && typeof actions.setDraft === "function") {
        try {
          applyDraftFn?.(actions, text);
        } catch {
          // 编辑器不可写：保持原样，用户可以手动复制。
        }
        if (mode === "send" && typeof actions.submit === "function") {
          // 与跨会话路径同样的延迟：让 setDraft 先落到编辑器再提交。
          globalThis.setTimeout(() => {
            try {
              actions.submit();
            } catch {
              // 提交失败时草稿仍在。
            }
          }, 220);
        }
      }
      closeForward();
      return;
    }
    putPending(state.targetId, { text, mode, label });
    try {
      findWorkspace()?.openSession?.(state.targetId);
    } catch {
      // 跳转失败时队列保留，目标会话下次挂载仍会回填。
    }
    closeForward();
  };  // 数据源标记：读取中 / 原始日志 / 快照。直接由 view 推导，不依赖额外布尔。
  const sourceLabel = view === "loading" ? " · 读取中…" : view === "host" ? " · 原始日志" : " · 快照";

  return React.createElement(
    "div",
    { style: cardStyle() },
    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "10px 14px 6px" } },
      React.createElement("strong", { style: { fontWeight: 600 } }, "转发到「" + (state.targetLabel ?? "") + "」"),
      React.createElement("span", { style: { opacity: 0.6 } }, "本轮 " + rows.length + " 条可转发 · 已选 " + selected.size + " 条" + sourceLabel),
      React.createElement("div", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flex: "none", fontSize: 11, opacity: 0.75 } },
        React.createElement("span", null, "原始日志"),
        React.createElement(
          "button",
          {
            type: "button",
            role: "switch",
            // 读取中也算「开着」：用户刚拨到原始日志，视觉上不该弹回去。
            "aria-checked": view !== "snapshot",
            title: "读取原始日志：能看到 tool-call，首次加载较慢",
            onClick: toggleSource,
            style: {
              width: 28,
              height: 15,
              flex: "none",
              borderRadius: 999,
              border: BORDER,
              background: view !== "snapshot" ? "var(--dsh-accent, #3b82f6)" : "transparent",
              position: "relative",
              cursor: "pointer",
              padding: 0,
              transition: "background .15s",
            },
          },
          React.createElement("span", {
            style: {
              position: "absolute",
              top: 2,
              left: view !== "snapshot" ? 15 : 2,
              width: 11,
              height: 11,
              borderRadius: 999,
              background: "#fff",
              transition: "left .15s",
            },
          }),
        ),
      ),
    ),
    React.createElement("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", padding: "0 14px 8px" } },
      stats.map((stat: any) =>
        React.createElement("button", {
          key: stat.kind,
          type: "button",
          title: stat.all ? "取消该类全部" : "选中该类全部",
          onClick: () => setSelected((prev: Set<number>) => toggleKind(rows, new Set(prev), stat.kind)),
          style: { padding: "3px 9px", borderRadius: 999, border: BORDER, background: stat.all ? "rgba(59,130,246,0.22)" : "transparent", color: "inherit", cursor: "pointer", fontSize: 12 },
        }, stat.kind + " " + stat.selected + "/" + stat.total),
      ),
    ),
    React.createElement("div", { style: { overflowY: "auto", maxHeight: "38vh" } },
      // 读取中：整块换成转圈，而不是继续显示快照列表——
      // 否则用户会以为「已经切过去了，只是列表没变」。
      view === "loading"
        ? React.createElement(
            "div",
            {
              style: {
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                height: 160,
                fontSize: 12,
                opacity: 0.7,
              },
            },
            React.createElement("div", { className: "dsh-session-cite-spinner" }),
            React.createElement("div", null, "正在读取原始日志…"),
          )
        : React.createElement(
            React.Fragment,
            null,
            rows.map((row: any) => {
        const expanded = expandedRows.has(row.seq);
        return React.createElement(
          React.Fragment,
          { key: row.seq },
          // 行体：左侧「勾选 + 序号/类型」固定，摘要吃掉剩余宽度，最右是展开开关。
          // 摘要与标签分开，是为了让摘要能用到整行的剩余宽度（约 500px），
          // 而不是像原来那样和标签拼成一句后被截到十几个字。
          React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "4px 14px" } },
            React.createElement(
              "label",
              { style: { display: "flex", alignItems: "center", gap: 8, flex: "none", cursor: "pointer" } },
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
              // 固定最小宽度让各行的摘要起点对齐；seq 位数多时自然撑开。
              React.createElement(
                "span",
                { style: { minWidth: 96, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" } },
                "#" + row.seq + " " + row.kind,
              ),
            ),
            expanded
              ? null
              : React.createElement(
                  "span",
                  {
                    title: typeof row.summary === "string" ? row.summary : "",
                    style: {
                      flex: 1,
                      minWidth: 0,
                      fontSize: 11,
                      opacity: 0.42,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    },
                  },
                  typeof row.summary === "string" ? row.summary : "",
                ),
            // 展开时把按钮推到最右端（摘要让位后没有可收缩的兄弟节点）。
            React.createElement(
              "button",
              {
                type: "button",
                title: expanded ? "收起正文" : "展开完整正文",
                "aria-expanded": expanded,
                onClick: () => toggleRow(row.seq),
                style: {
                  flex: "none",
                  marginLeft: expanded ? "auto" : 0,
                  width: 20,
                  height: 20,
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  color: "inherit",
                  cursor: "pointer",
                  fontSize: 11,
                  opacity: expanded ? 0.85 : 0.45,
                },
              },
              expanded ? "▾" : "▸",
            ),
          ),
          // 展开面板：不是列表，而是可换行的正文；保留原始换行，超长在面板内滚动。
          expanded
            ? React.createElement(
                "div",
                {
                  style: {
                    margin: "2px 14px 8px 44px",
                    padding: "8px 10px",
                    // 左侧竖线说明「这段属于上面那一行」，比四边框更轻、也更像树形展开。
                    borderLeft: "2px solid var(--dsh-border, rgba(255,255,255,0.18))",
                    borderRadius: 6,
                    background: "rgba(127,127,127,0.12)",
                    fontSize: 12,
                    lineHeight: 1.65,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    maxHeight: 220,
                    overflowY: "auto",
                    opacity: 0.92,
                  },
                },
                row.text,
              )
            : null,
        );
      }),
      // 与 /ref --list 同口径：空正文的行不列出，但如实告知跳过了多少，
      // 否则「42 条 assistant 只看到 12 条」会让人以为丢了数据。
      skipped > 0
        ? React.createElement(
            "div",
            { key: "__skipped", style: { padding: "4px 14px 10px", fontSize: 11, opacity: 0.45 } },
            "另有 " + skipped + " 条内容为空的消息未列出",
          )
        : null,
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
      : React.createElement(DialogStage, { state: snapshot, config, inputActions: props?.inputActions });
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("div", { style: maskStyle(), onClick: closeForward }),
    body,
  );
}
