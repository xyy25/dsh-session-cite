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
import { fetchTurnMeta, fetchTurnRows, probeTurnCached } from "./turn-source.js";
import { chooseNewSession } from "./forward-panel.js";

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

/**
 * 从 workspaces 快照里找某个会话所属的工作区 id。
 *
 * 算法与 dsh 内部 `startSession` 一致：在工作区列表里找第一个 `sessionIds` 含该会话的项。
 * 抽成纯函数便于单测，不依赖运行时上下文。
 * @param snapshot - workspaces 服务的快照（形如 `{ items: [{ workspaceId, sessionIds }] }`）。
 * @param sessionId - 会话 id。
 * @returns 工作区 id；找不到或结构不符时 undefined。
 */
export function resolveWorkspaceIdFromSnapshot(snapshot: any, sessionId: string): string | undefined {
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  const items = snapshot?.items;
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    if (!Array.isArray(item?.sessionIds)) continue;
    if (item.sessionIds.includes(sessionId) && typeof item.workspaceId === "string") return item.workspaceId;
  }
  return undefined;
}

/**
 * 解析当前会话所属的工作区 id。
 * @param sessionId - 会话 id。
 * @returns 工作区 id；服务不可用时 undefined。
 */
function resolveCurrentWorkspaceId(sessionId: string): string | undefined {
  if (runtimeCtx === null) return undefined;
  try {
    const service = typeof runtimeCtx.get === "function" ? runtimeCtx.get("workspaces") : runtimeCtx.workspaces;
    return resolveWorkspaceIdFromSnapshot(service?.list?.getSnapshot?.(), sessionId);
  } catch {
    return undefined;
  }
}

/**
 * 把转发内容送到「新会话」。
 *
 * 能解析出当前工作区时：用 `openWorkspace` 的 `beforeOpen(newId)` 拿到新会话 id，
 * 写入 pending 队列，由新会话挂载时的消费逻辑回填（send 模式还会提交）——
 * 与「转发到已有会话」完全同一条路。
 *
 * 解析不出工作区时：`startSession(undefined, { prompt })` 让 dsh 自己按「当前工作区」
 * 打开空白会话并把文本填进去。它不返回 id，所以 send 只能退化为草稿（会如实提示）。
 *
 * 刻意不在 openWorkspace 之后 fallback 到 startSession：`beforeOpen` 可能异步触发，
 * 那一刻判断「没回调」会误以为失败，从而创建出**两个**会话。
 * @param mode - draft 或 send。
 * @param text - 已构建好的转发文本（mention 或转发块）。
 * @param label - 目标标签。
 * @param sourceId - 源会话 id（用于定位工作区）。
 * @returns 实际走的路径。
 */
function submitToNewSession(
  mode: "draft" | "send",
  text: string,
  label: string,
  sourceId: string,
): "pending" | "startSession" | "failed" {
  const workspace = findWorkspace();
  if (workspace === undefined) return "failed";
  const workspaceId = resolveCurrentWorkspaceId(sourceId);
  if (workspaceId !== undefined && typeof workspace.openWorkspace === "function") {
    try {
      void workspace.openWorkspace(workspaceId, (newId: string) => {
        if (typeof newId === "string" && newId !== "") putPending(newId, { text, mode, label });
      });
      return "pending";
    } catch {
      return "failed";
    }
  }
  if (typeof workspace.startSession === "function") {
    try {
      workspace.startSession(undefined, { prompt: text, whenDraftExists: "replace" });
      return "startSession";
    } catch {
      return "failed";
    }
  }
  return "failed";
}

/** 分支会话诊断只打一次，避免每次开面板刷屏。 */
let warnedBranches = false;

/**
 * 消息来源偏好。
 *
 * 只存内存：偏好表达的是「上次用过原始日志」，但能否沿用取决于**当前这一轮**
 * 的日志是否还在 Host 缓存里——冷缓存要逐事件解压整份日志（大轮次十几秒），
 * 那种情况下应该强制回到快照。所以每次打开面板都先用 probe 确认，命中才沿用；
 * 刷新页面偏好自然清空，不会出现「每次进来都白等一次」。
 */
let sourcePref: "host" | "snapshot" = "snapshot";

/**
 * 读取上次选用的消息来源。
 * @returns `host` 或 `snapshot`。
 */
function readSourcePref(): "host" | "snapshot" {
  return sourcePref;
}

/**
 * 记录消息来源偏好。
 * @param value - 目标来源。
 */
function writeSourcePref(value: "host" | "snapshot"): void {
  sourcePref = value;
}

/**
 * 卡片的定位与布局；视觉（背景、边框、阴影、圆角、入场动画）交给 `.dsc-card`。
 *
 * 分开的理由：伪状态（hover/focus/动画）内联表达不了，样式集中在注入的 CSS 里
 * 更好维护，也才能做出「高级感」必需的状态反馈。
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
    zIndex: 2147000000,
    overflow: "hidden",
    fontSize: 13,
  };
}

/**
 * 「新建会话」行前面的加号图标。
 * 与转发图标同一套规范：16 视口、currentColor、round cap/join。
 * @returns SVG 元素。
 */
function PlusIcon(): any {
  return React.createElement("svg", {
    viewBox: "0 0 16 16",
    width: 12,
    height: 12,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    children: [
      React.createElement("path", { key: "h", d: "M8 3.2v9.6" }),
      React.createElement("path", { key: "v", d: "M3.2 8h9.6" }),
    ],
  });
}

function maskStyle(): any {
  return { position: "fixed", inset: 0, background: "rgba(0,0,0,0.32)", zIndex: 2146999999 };
}

/** 选择列表的一行：工作区分组 / 主会话 / 子代理 / 空提示。 */
type PickerRow =
  | { kind: "new" }
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

/** 行内小标签（已归档 / 当前）；视觉在 .dsc-tag，accent 用于「当前会话」。 */
function tagSpan(text: string, accent?: boolean): any {
  return React.createElement(
    "span",
    { className: accent === true ? "dsc-tag dsc-tag-accent" : "dsc-tag", style: { flex: "none" } },
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
      { className: "dsc-card", style: cardStyle() },
      React.createElement(
        "div",
        { className: "dsc-header", style: { display: "flex", alignItems: "center", gap: 8, padding: "14px 16px 10px" } },
        React.createElement("span", { className: "dsc-title" }, "该会话已归档"),
        React.createElement("span", { className: "dsc-tag", style: { flex: "none" } }, "风险确认"),
      ),
      React.createElement(
        "div",
        { style: { padding: "4px 16px 16px", lineHeight: 1.7, fontSize: 13 } },
        React.createElement("div", { style: { fontSize: 12.5, color: "rgba(255,255,255,.86)", marginBottom: 8 } }, target.label),
        React.createElement(
          "div",
          { style: { fontSize: 12, color: "rgba(255,255,255,.5)" } },
          "归档只做记账、不清内容，但该会话通常已不可正常读取。引用它可能失败。",
        ),
      ),
      React.createElement(
        "div",
        { className: "dsc-footer", style: { display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 16px" } },
        React.createElement("button", { type: "button", onClick: () => setPending(null), className: "dsc-btn" }, "返回选别的"),
        React.createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              setPending(null);
              chooseTarget(target.id, target.label.split(" · ")[0] ?? target.label);
            },
            className: "dsc-btn dsc-btn-primary",
          },
          "仍然选择",
        ),
      ),
    );
  }

  // 行模型：树状浏览与搜索平铺共用同一套渲染。
  // 「新建会话」永远排第一：它和搜索/分组都无关，放在最前最好找。
  let rows: PickerRow[] = [{ kind: "new" }];
  if (keyword !== "") {
    // 搜索时拍平：关键词已经收窄了范围，再要求逐层展开只会碍事。
    const hits = filterOptions(options, keyword, inventory);
    if (hits.length === 0) rows.push({ kind: "empty", text: "没有匹配的会话" });
    else for (const option of hits) rows.push({ kind: "session", option, childCount: 0, expanded: false });
  } else {
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
    { className: "dsc-card", style: cardStyle() },
    React.createElement(
      "div",
      { className: "dsc-header", style: { display: "flex", alignItems: "baseline", gap: 8, padding: "13px 16px 10px" } },
      React.createElement(
        "span",
        { className: "dsc-title" },
        Array.isArray(props?.state?.turns) && props.state.turns.length > 0
          ? "选择要转发到的会话（已选 " + props.state.turns.length + " 轮）"
          : "选择要转发到的会话",
      ),
    ),
    React.createElement("input", {
      type: "text",
      value: query,
      autoFocus: true,
      placeholder: "搜索会话标题、id 或工作区…",
      onChange: (e: any) => setQuery(e.target.value),
      className: "dsc-search",
      style: { margin: "0 16px 10px", padding: "8px 11px", fontSize: 13 },
    }),
    React.createElement("div", { className: "dsc-scroll", style: { overflowY: "auto", maxHeight: "46vh", padding: "0 8px 8px" } },
      rows.map((row: PickerRow) => {
        if (row.kind === "new") {
          // 「新建会话」：与普通会话行同高，但左侧加强调色竖条 + 淡底，
          // 一眼能看出这是「创建一个新目标」而不是已有会话。
          return React.createElement(
            "button",
            {
              key: "new",
              type: "button",
              onClick: chooseNewSession,
              className: "dsc-new-session",
              title: "在当前工作区创建一个新会话并转发过去",
            },
            React.createElement("span", { className: "dsc-new-session-icon" }, PlusIcon()),
            React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "新建会话"),
            React.createElement("span", { className: "dsc-count", style: { marginLeft: "auto", flex: "none" } }, "同工作区 · 空白"),
          );
        }
        if (row.kind === "empty") {
          return React.createElement("div", { key: "empty", style: { padding: "14px 10px", opacity: 0.5, fontSize: 12 } }, row.text);
        }
        if (row.kind === "group") {
          // 第一级：工作区，点击折叠/展开。
          return React.createElement("button", {
            key: "g:" + row.id,
            type: "button",
            onClick: () => toggleIn(setCollapsedGroups, row.id),
            className: "dsc-group",
            style: { ...PICKER_BASE_STYLE, padding: "8px 10px" },
          },
            React.createElement("span", { style: { width: 10, flex: "none", opacity: 0.45, fontSize: 10 } }, row.collapsed ? "▸" : "▾"),
            React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.title),
            React.createElement("span", { className: "dsc-count", style: { marginLeft: "auto", flex: "none" } }, String(row.count)),
          );
        }
        if (row.kind === "child") {
          // 第三级：子代理只能看不能选——它不能作为转发目标。
          return React.createElement(
            "div",
            { key: "c:" + row.option.id, className: "dsc-child", style: { ...PICKER_BASE_STYLE, padding: "4px 10px 4px 26px", cursor: "default" } },
            React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.option.label),
          );
        }
        // 第二级：主会话。左侧选中，右侧是子代理展开开关，两者互不干扰。
        const option = row.option;
        return React.createElement(
          "div",
          { key: "s:" + option.id, className: "dsc-row", style: { display: "flex", alignItems: "stretch" } },
          React.createElement(
            "button",
            {
              type: "button",
              onClick: () => pick(option),
              style: { ...PICKER_BASE_STYLE, flex: 1, minWidth: 0, paddingLeft: 12, opacity: option.archived === true ? 0.5 : 1 },
            },
            React.createElement(
              "span",
              { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5 } },
              option.label,
            ),
            // 「当前」用强调色，因为它回答的是「我现在在哪个会话」；
            // 它和「已归档」可以并存（当前会话也可能被归档过）。
            option.current === true ? tagSpan("当前", true) : null,
            option.archived === true ? tagSpan("已归档") : null,
            option.detail === undefined
              ? null
              : React.createElement("span", { className: "dsc-count", style: { marginLeft: "auto", flex: "none" } }, option.detail),
          ),
          row.childCount === 0
            ? null
            : React.createElement(
                "button",
                {
                  type: "button",
                  title: row.expanded ? "收起子代理" : "展开子代理",
                  onClick: () => toggleIn(setExpandedNodes, option.id),
                  style: { ...PICKER_BASE_STYLE, width: "auto", flex: "none", padding: "5px 10px", fontSize: 10.5, opacity: 0.5 },
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
  // 多轮模式：rows 由 openMultiForward 在后台逐轮读取后直接给出，
  // 这里不再自己请求（单轮才走 Host/快照二选一）。
  const multiTurns: number[] | undefined =
    Array.isArray(state.turns) && state.turns.length > 0 ? state.turns : undefined;
  const isMulti = multiTurns !== undefined;
  // 初始一律快照：能否沿用上次的「原始日志」取决于这一轮的日志是否还在 Host 缓存，
  // 由下面的 probe effect 决定（冷缓存要解压整份日志，不能让用户白等）。
  const [view, setView] = React.useState("snapshot");
  const [hostData, setHostData] = React.useState(null);
  // 骨架 + 分批：加载期间先用骨架占位（seq/kind 已知），正文逐批填进来。
  const [skeleton, setSkeleton] = React.useState(null);
  const [metaProgress, setMetaProgress] = React.useState(null);
  const filledRef = React.useRef(new Map());
  const rows = isMulti
    ? state.rows
    : skeleton !== null
      ? skeleton.map(
          (item: any) =>
            filledRef.current.get(item.seq) ?? {
              seq: item.seq,
              kind: item.kind,
              text: "",
              summary: "",
              pending: true,
            },
        )
      : view === "host" && hostData !== null
        ? hostData.rows
        : state.rows;
  // 原始日志里被跳过的条数（正文为空的纯工具轮次等），与 --list 的口径一致。
  // 多轮模式由 Host 逐轮过滤，这里不重复统计。
  const skipped: number = isMulti ? 0 : view === "host" && hostData !== null ? hostData.skipped : 0;
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

  // 打开面板先探测：上次选过原始日志、且这一轮仍在 Host 缓存里才沿用；
  // 否则留在快照并清掉偏好——冷缓存下一轮要解压整份日志，不能让用户白等一次。
  const probedRef = React.useRef(false);
  React.useEffect(() => {
    if (isMulti) return undefined;
    if (probedRef.current) return undefined;
    probedRef.current = true;
    if (readSourcePref() !== "host") return undefined;
    const turn = state.turn;
    if (typeof turn !== "number") return undefined;
    let alive = true;
    probeTurnCached(state.sourceId, turn).then((cached) => {
      if (!alive) return;
      // 命中：进 loading 走正常加载（几乎瞬时）；未命中：放弃沿用。
      if (cached) setView("loading");
      else writeSourcePref("snapshot");
    });
    return () => {
      alive = false;
    };
  }, [isMulti]);

  React.useEffect(() => {
    // 多轮：数据由 openMultiForward 逐轮读取后直接给出，这里不再请求。
    if (isMulti) return undefined;
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
    const run = async (): Promise<void> => {
      try {
        // 1) 骨架：只 listEvents 一次（约 0.4 秒），先把「本轮 N 条 · 类型」亮出来。
        const meta = await fetchTurnMeta(state.sourceId, turn, state.fromSeq, state.toSeq);
        if (!alive) return;
        if (meta === undefined) {
          setView("snapshot");
          writeSourcePref("snapshot");
          return;
        }
        filledRef.current = new Map();
        setSkeleton(meta.items);
        setMetaProgress({ done: 0, total: meta.items.length });
        // 2) 分批取正文：每批 8 条（约 1.5 秒），逐批替换占位行。
        const BATCH = 8;
        for (let start = 0; start < meta.items.length; start += BATCH) {
          const batch = meta.items.slice(start, start + BATCH);
          // 窗口右界取「下一批第一个 seq - 1」：骨架行是合并后的（seq 是调用侧），
          // 直接用 batch 末条的 seq 会把配对的 tool/result 切在后面，导致该批丢结果。
          const nextStart = meta.items[start + BATCH];
          const winTo = nextStart !== undefined ? nextStart.seq - 1 : state.toSeq;
          const payload = await fetchTurnRows(
            state.sourceId,
            turn,
            batch[0].seq,
            typeof winTo === "number" ? winTo : undefined,
          );
          if (!alive) return;
          if (payload !== undefined) {
            for (const row of payload.rows) filledRef.current.set(row.seq, row);
          }
          setMetaProgress({
            done: Math.min(start + BATCH, meta.items.length),
            total: meta.items.length,
          });
        }
        if (!alive) return;
        const collected = meta.items
          .map((item: any) => filledRef.current.get(item.seq))
          .filter((row: any) => row !== undefined);
        setSkeleton(null);
        setMetaProgress(null);
        if (collected.length === 0) {
          setView("snapshot");
          writeSourcePref("snapshot");
          return;
        }
        setHostData({ rows: collected, skipped: 0 });
        setView("host");
      } catch {
        if (!alive) return;
        setSkeleton(null);
        setMetaProgress(null);
        setView("snapshot");
        writeSourcePref("snapshot");
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [view, hostData, state.sourceId, state.turn, state.fromSeq, state.toSeq]);
  const totalWeight = selectedWeight(rows, selected, config.asciiWeight);
  const forced = mustCompact(totalWeight, config.maxChars);
  const effectiveCompact = forced || compact;
  const stats = kindStats(rows, selected);

  const apply = (mode: "draft" | "send") => {
    // 加载中 rows 还是快照那份：此时转发出去的内容和看到的列表不是一回事，直接拒绝。
    if (busy) return;
    const picked = rows.filter((row: any) => selected.has(row.seq));
    if (picked.length === 0) return;
    // 新会话要等到创建时才知道 id，所以「没有 targetId」本身不再算无效。
    if (state.targetNew !== true && state.targetId === undefined) return;
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
    // 目标是「新会话」：创建并投递，不经过 openSession。
    if (state.targetNew === true) {
      const route = submitToNewSession(mode, text, label, state.sourceId);
      if (route === "failed") {
        console.warn("[dsh-session-cite] 新建会话失败：宿主没有可用的 workspace 服务");
        return; // 面板留在原地，用户可改选其它目标
      }
      if (route === "startSession" && mode === "send") {
        // 降级路径拿不到新会话 id，无法自动提交；内容已进草稿，如实提示。
        console.warn("[dsh-session-cite] 无法定位工作区，已把内容填进新会话草稿，请手动发送");
      }
      closeForward();
      return;
    }

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
  // 多轮：标题报轮数，meta 报条数；读取中显示进度。
  const progress = state.multiLoading;
  const loadingMulti = isMulti && progress !== undefined;
  // 加载中：列表已换成转圈，但底下的分段/附言/压缩/发送仍然指向「快照」那份 rows，
  // 此时让它们可点就是误导（选中集与看到的列表不是一回事）。统一置灰并禁用，
  // 只保留源开关（切回快照等于取消这次加载）。
  const busy = view === "loading" || loadingMulti;
  const sourceLabel = isMulti ? " · 原始日志（多轮）" : view === "loading" ? " · 读取中…" : view === "host" ? " · 原始日志" : " · 快照";
  const titleText =
    state.targetNew === true
      ? isMulti
        ? "转发 " + (multiTurns?.length ?? 0) + " 轮消息 → 新会话"
        : "转发 " + rows.length + " 条 → 新会话"
      : isMulti
        ? "转发 " + (multiTurns?.length ?? 0) + " 轮消息 → 「" + (state.targetLabel ?? "") + "」"
        : "转发到「" + (state.targetLabel ?? "") + "」";
  const metaText = isMulti
    ? loadingMulti
      ? "读取第 " + (progress as any).done + "/" + (progress as any).total + " 轮…"
      : rows.length + " 条可转发" + ((progress as any)?.failed?.length > 0 ? " · " + (progress as any).failed.length + " 轮读取失败" : "") + " · 已选 " + selected.size + " 条"
    : busy && metaProgress !== null
      ? "加载中 " + metaProgress.done + "/" + metaProgress.total + " 条" + sourceLabel
      : "本轮 " + rows.length + " 条可转发 · 已选 " + selected.size + " 条" + sourceLabel;

  return React.createElement(
    "div",
    { className: "dsc-card", style: cardStyle() },
    React.createElement("div", { className: "dsc-header", style: { display: "flex", alignItems: "center", gap: 8, padding: "13px 16px 10px" } },
      React.createElement("span", { className: "dsc-title" }, titleText),
      React.createElement("span", { className: "dsc-meta" }, metaText),
      // 多轮模式固定使用原始日志（快照只有当前轮），开关保留可见但禁用：
      // 直接隐藏会让人以为界面出了问题。
      React.createElement("div", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 7, flex: "none", fontSize: 10.5, color: "rgba(255,255,255,.5)" } },
        React.createElement("span", null, "原始日志"),
        React.createElement(
          "button",
          {
            type: "button",
            role: "switch",
            // 加载中仍可用：切回快照就等于取消这次读取，这是唯一的取消入口。
            disabled: isMulti,
            // 读取中也算「开着」：用户刚拨到原始日志，视觉上不该弹回去。
            "aria-checked": isMulti ? true : view !== "snapshot",
            "data-on": isMulti || view !== "snapshot" ? "true" : "false",
            title: isMulti
              ? "多轮合并固定使用原始日志（快照只有当前轮）"
              : "读取原始日志：能看到 tool-call，首次加载较慢",
            onClick: isMulti ? undefined : toggleSource,
            className: "dsc-switch",
            style: { flex: "none" },
          },
          React.createElement("span", null),
        ),
      ),
    ),
    React.createElement("div", { style: { padding: "10px 16px 6px" } },
      React.createElement("div", { className: "dsc-seg", style: { display: "inline-flex", flexWrap: "wrap" } },
        stats.map((stat: any) =>
          React.createElement("button", {
            key: stat.kind,
            type: "button",
            title: stat.all ? "取消该类全部" : "选中该类全部",
            onClick: () => setSelected((prev: Set<number>) => toggleKind(rows, new Set(prev), stat.kind)),
            className: "dsc-seg-item",
            disabled: busy,
            "data-on": stat.all ? "true" : "false",
          }, stat.kind + " " + stat.selected + "/" + stat.total),
        ),
      ),
    ),
    React.createElement("div", { className: "dsc-scroll", style: { overflowY: "auto", maxHeight: "38vh", padding: "2px 8px 6px" } },
      // 读取中：有骨架就渲染骨架列表（seq/类型已就位，正文逐批填充）；
      // 只在「还没拿到骨架」时才显示转圈。多轮合并没有骨架，仍走转圈。
      (view === "loading" && skeleton === null) || loadingMulti
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
              React.createElement("div", null, loadingMulti ? "正在合并多轮消息…" : "正在读取原始日志…"),
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
          React.createElement("div", { className: "dsc-row", "data-on": selected.has(row.seq) ? "true" : "false", "data-pending": row.pending === true ? "true" : "false", style: { display: "flex", alignItems: "center", gap: 8, padding: "4px 8px" } },
            React.createElement(
              "label",
              { style: { display: "flex", alignItems: "center", gap: 8, flex: "none", cursor: "pointer" } },
              React.createElement("input", {
                type: "checkbox",
                // 骨架行还没有正文，不能勾选（否则会把空壳转发出去）。
                disabled: row.pending === true,
                checked: selected.has(row.seq),
                style: { accentColor: "var(--dsh-accent, #3b82f6)" },
                onChange: (e: any) => setSelected((prev: Set<number>) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(row.seq);
                  else next.delete(row.seq);
                  return next;
                }),
              }),
              // 固定最小宽度让各行的摘要起点对齐；多轮时补上来源轮次，避免跨轮混淆。
              React.createElement(
                "span",
                { className: "dsc-seq", style: { minWidth: 92, whiteSpace: "nowrap" } },
                "#" + row.seq + " " + row.kind + (isMulti && typeof row.turn === "number" ? " · 第" + row.turn + "轮" : ""),
              ),
            ),
            expanded
              ? null
              : React.createElement(
                  "span",
                  {
                    title: typeof row.summary === "string" ? row.summary : "",
                    className: "dsc-summary",
                    style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                  },
                  row.pending === true ? "读取中…" : typeof row.summary === "string" ? row.summary : "",
                ),
            // 展开时把按钮推到最右端（摘要让位后没有可收缩的兄弟节点）。
            React.createElement(
              "button",
              {
                type: "button",
                title: expanded ? "收起正文" : "展开完整正文",
                "aria-expanded": expanded,
                onClick: () => toggleRow(row.seq),
                className: "dsc-expand",
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
                  fontSize: 10,
                  opacity: expanded ? 0.85 : undefined,
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
                  className: "dsc-body dsc-scroll",
                  style: {
                    margin: "2px 10px 8px 10px",
                    padding: "9px 11px",
                    maxHeight: 220,
                    overflowY: "auto",
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
            { key: "__skipped", style: { padding: "6px 10px 8px", fontSize: 10.5, color: "rgba(255,255,255,.35)" } },
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
      className: "dsc-note",
      disabled: busy,
      style: { margin: "6px 16px 12px", padding: "8px 11px", fontSize: 13, resize: "vertical" },
    }),
    React.createElement("div", { className: "dsc-footer", style: { display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", fontSize: 11.5 } },
      // 字数用「已用 / 上限」的形式，超限时整段转成警示色。
      React.createElement(
        "span",
        {
          className: "dsc-meta",
          style: { flex: "none", color: forced ? "rgba(248,113,113,.92)" : undefined },
        },
        Math.round(totalWeight) + " / " + config.maxChars + " 字",
      ),
      React.createElement(
        "label",
        { style: { display: "flex", alignItems: "center", gap: 6, flex: "none", color: "rgba(255,255,255,.62)", opacity: forced ? 0.55 : 1 } },
        React.createElement(
          "button",
          {
            type: "button",
            role: "switch",
            "aria-checked": effectiveCompact,
            "data-on": effectiveCompact ? "true" : "false",
            disabled: forced,
            title: forced ? "已超上限，强制压缩" : "压缩后再发送",
            onClick: () => {
              if (forced) return;
              setCompact(!compact);
            },
            className: "dsc-switch",
            style: { flex: "none", cursor: forced ? "default" : "pointer" },
          },
          React.createElement("span", null),
        ),
        "压缩",
      ),
      React.createElement("div", { style: { flex: 1 } }),
      React.createElement(
        "button",
        { type: "button", onClick: () => apply("draft"), className: "dsc-btn", disabled: busy },
        "草稿",
      ),
      React.createElement(
        "button",
        { type: "button", onClick: () => apply("send"), className: "dsc-btn dsc-btn-primary", disabled: busy },
        "直接发送",
      ),
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
