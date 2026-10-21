/**
 * 会话选择器的纯逻辑：把客户端会话快照映射成 popupSelect 选项行。
 *
 * 单独成文件是为了可单测——这些函数不碰 React、不碰 cordis，只做数据映射。
 * 依赖形状见 dsh-api-session-controller 的 SessionListState / SessionSummary：
 *   { ids: SessionId[], byId: Record<SessionId, { displayTitle, title?, updatedAt, blank, origin?, running }> }
 */

/** 会话快照里的一行（只声明用得到的字段）。 */
export type SessionSummaryLike = {
  title?: string;
  displayTitle?: string;
  updatedAt?: number;
  blank?: boolean;
  origin?: string;
  parentId?: string;
  running?: boolean;
};

/** sessions.list.getSnapshot() 的形状。 */
export type SessionListLike = {
  ids?: readonly string[];
  byId?: Record<string, SessionSummaryLike | undefined>;
};

/** 归档会话的风险确认：与 dsh 的 SelectConfirmation 同形。 */
export type PickerConfirmation = {
  title: string;
  description: string;
  acknowledgeLabel: string;
  cancelLabel: string;
  confirmLabel: string;
};

/** 选择器的一行；字段与 dsh 的 SelectOption 对齐。 */
export type PickerOption = {
  /** 完整 session-id，宿主用它做行 identity。 */
  id: string;
  /** 回填到输入框时使用的 id：短 id 唯一时用短 id，冲突时退回完整 id。 */
  draftId?: string;
  label: string;
  detail?: string;
  badge?: string;
  active?: boolean;
  /** 该会话已被 dsh-session-archive 归档：排到最后，并用更弱的样式呈现。 */
  archived?: boolean;
  /** 父会话 id；子代理会话靠它挂到主会话下面。 */
  parentId?: string;
  /** 会话来源：`subagent` 表示它是某个主会话派生的子代理。 */
  origin?: string;
  /** 归档会话的风险确认；popupSelect 会先展示它，再执行选择。 */
  confirmation?: PickerConfirmation;
};

/**
 * 取会话 id 的可读缩略：去掉 session- 前缀后取前 8 位。
 * @param sessionId - 完整会话 id。
 * @returns 用于展示与搜索的短 id。
 */
export function shortSessionId(sessionId: string): string {
  const bare = sessionId.startsWith("session-") ? sessionId.slice(8) : sessionId;
  return bare.length > 8 ? bare.slice(0, 8) : bare;
}

/**
 * 把时间戳渲染成相对时间，让列表能看出会话新旧。
 * @param at - 毫秒时间戳。
 * @param now - 当前时间（便于测试注入）。
 * @returns 如「刚刚」「12 分钟前」「3 小时前」「5 天前」。
 */
export function relativeTime(at: number, now: number): string {
  if (!Number.isFinite(at)) return "";
  const diff = now - at;
  if (diff < 0) return "刚刚";
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return Math.floor(diff / minute) + " 分钟前";
  if (diff < day) return Math.floor(diff / hour) + " 小时前";
  if (diff < 30 * day) return Math.floor(diff / day) + " 天前";
  const months = Math.floor(diff / (30 * day));
  if (months < 12) return months + " 个月前";
  return Math.floor(months / 12) + " 年前";
}

/** 转义 mention 标签里的反斜杠与方括号（与服务端 escapeLabel 一致）。 */
function escapeLabel(label: string): string {
  return label.replace(/[\\[\]]/gu, (ch) => "\\" + ch);
}

/**
 * 把会话 id 编码成 mention 载荷：base64url(JSON.stringify(id))。
 * 必须与服务端 encodeSessionReferenceUri 逐字一致，否则命令解析不出引用。
 * @param sessionId - 完整会话 id。
 * @returns base64url 载荷。
 */
export function encodeSessionId(sessionId: string): string {
  const json = JSON.stringify(sessionId);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/**
 * 生成规范 mention 文本：@[标签](dsh-session:载荷)。
 * @param sessionId - 完整会话 id。
 * @param label - 展示标签（通常为会话标题）。
 * @returns mention 全文。
 */
export function formatSessionMention(sessionId: string, label: string): string {
  return "@[" + escapeLabel(label) + "](dsh-session:" + encodeSessionId(sessionId) + ")";
}

/**
 * 把会话快照映射成选择器选项：跳过空会话，按最近活动排序，归档会话沉底。
 *
 * label 里刻意带上短 id：popupSelect 的内置搜索按 label 匹配，
 * 只有这样才能同时支持「按标题」和「按 session-id」搜索。
 *
 * 归档会话仍留在快照里（归档插件只记 ledger，不搬会话文件），但它们通常已经
 * 不可正常读取，所以排到末尾并打上「已归档」标记，避免误选。
 * @param state - sessions.list 的快照。
 * @param currentSessionId - 当前会话 id，用于标记 active。
 * @param now - 当前时间戳（便于测试注入）。
 * @param archivedIds - 已归档的会话 id 集合；缺省表示没有归档信息。
 * @returns 选项行数组。
 */
export function toSessionOptions(
  state: SessionListLike | undefined,
  currentSessionId?: string,
  now: number = Date.now(),
  archivedIds?: ReadonlySet<string>,
): PickerOption[] {
  const byId = state?.byId;
  if (byId === undefined || byId === null) return [];
  const ids = Array.isArray(state?.ids) && state.ids.length > 0
    ? state.ids
    : Object.keys(byId);
  // 短 id 只有在全局唯一时才能用来回填，否则会指错会话。
  const shortCounts = new Map<string, number>();
  for (const id of ids) {
    const short = shortSessionId(id);
    shortCounts.set(short, (shortCounts.get(short) ?? 0) + 1);
  }
  const rows: Array<PickerOption & { updatedAt: number }> = [];
  for (const id of ids) {
    const summary = byId[id];
    if (summary === undefined || summary === null) continue;
    // 空会话（还没产生任何 turn）没有引用价值，且会挤占列表。
    if (summary.blank === true) continue;
    const short = shortSessionId(id);
    const rawTitle = typeof summary.displayTitle === "string" && summary.displayTitle !== ""
      ? summary.displayTitle
      : typeof summary.title === "string" && summary.title !== ""
        ? summary.title
        : "未命名会话";
    // 标题里已含短 id 时不重复追加。
    const label = rawTitle.includes(short) ? rawTitle : rawTitle + " · " + short;
    const updatedAt = typeof summary.updatedAt === "number" ? summary.updatedAt : 0;
    const detail = updatedAt > 0 ? relativeTime(updatedAt, now) : "";
    const archived = archivedIds?.has(id) === true;
    // 已归档优先于运行中/子代理：它是这一行最需要被看见的属性。
    const badge = archived
      ? "已归档"
      : summary.running === true
        ? "运行中"
        : summary.origin === "subagent"
          ? "子代理"
          : undefined;
    rows.push({
      id,
      draftId: (shortCounts.get(short) ?? 0) > 1 ? id : short,
      label,
      ...(detail === "" ? {} : { detail }),
      ...(badge === undefined ? {} : { badge }),
      ...(id === currentSessionId ? { active: true } : {}),
      ...(typeof summary.parentId === "string" && summary.parentId !== "" ? { parentId: summary.parentId } : {}),
      ...(typeof summary.origin === "string" && summary.origin !== "" ? { origin: summary.origin } : {}),
      ...(archived
        ? {
            archived: true,
            // 归档只记账、不清内容，所以引用它常常当场失败而不是永远不行；
            // 因此是「确认后仍可继续」，不做硬性禁用。
            confirmation: {
              title: "该会话已归档",
              description:
                "「" + rawTitle + "」已被归档，内容可能已不可正常读取。引用它可能失败，仍要继续吗？",
              acknowledgeLabel: "我了解引用可能失败",
              cancelLabel: "返回选别的会话",
              confirmLabel: "仍然选择",
            } satisfies PickerConfirmation,
          }
        : {}),
      updatedAt,
    });
  }
  // 归档会话永远排在活动会话之后；两组内部各自保持「最近活动优先」。
  rows.sort((a, b) => {
    const archivedA = a.archived === true ? 1 : 0;
    const archivedB = b.archived === true ? 1 : 0;
    if (archivedA !== archivedB) return archivedA - archivedB;
    return b.updatedAt - a.updatedAt;
  });
  return rows.map(({ updatedAt: _ignored, ...rest }) => rest);
}

/**
 * 选中后要写进输入框的草稿文本：把裸 /ref 补成命令式 /ref <session-id>。
 *
 * 刻意用裸 id 而不是 mention chip：命令语法是「/ref <id> [--list|--pick ...] [说明]」，
 * 回填成命令式之后，光标就停在 id 之后，用户可以直接接着敲 --list / --pick / 说明文字。
 * @param option - 用户选中的选项行。
 * @returns 草稿全文。
 */
export function draftForSession(option: PickerOption): string {
  const id =
    typeof option.draftId === "string" && option.draftId !== "" ? option.draftId : option.id;
  return "/ref " + id;
}
