/**
 * 转发面板的树状会话列表：工作区 → 主会话 → 子代理。
 *
 * 三层各自的可操作性不同，这是整个结构的重点：
 *   - 工作区：只承担分组，点击折叠/展开；
 *   - 主会话：唯一可选的层级，点击即转发目标；
 *   - 子代理：**不可选**，只用于看清「这个主会话派生了谁」。
 *
 * 数据来自两处，缺一不可：
 *   - 会话本身（标题、时间、父子关系）来自客户端 sessions.list 快照；
 *   - 工作区归属来自 dsh-session-archive 的 inventory（sessions.list 不带工作区）。
 * 任何一个缺失都退回「未分组」，绝不因此丢会话。
 *
 * 纯函数：不碰 React、不碰 DOM，便于单测。
 */

import type { PickerOption } from "./session-picker.js";
import type { Inventory } from "./archive-status.js";

/** 树里的一个主会话节点。 */
export type SessionNode = {
  option: PickerOption;
  /** 该主会话派生的子代理；不可选，仅展示。 */
  children: PickerOption[];
};

/** 树里的一个分组（工作区，或「未分组」「已归档」两个合成组）。 */
export type SessionGroup = {
  id: string;
  title: string;
  /** 分组标题右侧的计数：主会话数 + 子代理数。 */
  count: number;
  nodes: SessionNode[];
};

/** 没有工作区归属的会话归到这里。 */
export const UNGROUPED_ID = "__ungrouped";

/** 已归档会话单独成组，永远排在最后。 */
export const ARCHIVED_ID = "__archived";

/** 合成组的固定标题。 */
export const UNGROUPED_TITLE = "未分组";
export const ARCHIVED_TITLE = "已归档";

/**
 * 把平铺的会话选项折成树。
 *
 * 规则：
 *   1. 有 parentId 且父会话也在本次选项里的，沉为子代理，不再作为顶层行；
 *   2. 归档会话（自身标记或清单标记）整体移到最后的「已归档」组；
 *   3. 其余按清单里的 workspaceIds[0] 归组，取不到就进「未分组」；
 *   4. 分组顺序按「组内第一个会话在传入顺序里的位置」——传入顺序已经是
 *      「最近活动优先」，所以活跃工作区自然排前面。
 * @param options - 平铺的会话选项（应已按活动时间排好）。
 * @param inventory - 归档清单（提供工作区归属与归档状态）。
 * @returns 分组数组；没有任何会话时返回空数组。
 */
export function buildSessionTree(
  options: readonly PickerOption[],
  inventory: Inventory,
): SessionGroup[] {
  if (options.length === 0) return [];

  const byId = new Map<string, PickerOption>();
  for (const option of options) byId.set(option.id, option);

  // childIds 的语义比「子代理」宽：分支/派生出来的普通会话也会记在里面。
  // 所以只在**确认对方是子代理**（origin=subagent）时，才用它反查父会话。
  const parentFromInventory = new Map<string, string>();
  for (const [parentId, info] of inventory.bySession) {
    for (const childId of info.childIds) {
      if (!parentFromInventory.has(childId)) parentFromInventory.set(childId, parentId);
    }
  }

  // 先按父子关系分出顶层与子代理。
  const childrenOf = new Map<string, PickerOption[]>();
  const roots: PickerOption[] = [];
  for (const option of options) {
    const declaredParent =
      typeof option.parentId === "string" && option.parentId !== "" ? option.parentId : undefined;
    // 子代理的唯一判据是 origin === 'subagent'。
    // 「在新对话中分支」产生的分支会话同样带 parentId，但它是独立的主会话，
    // 必须与其它主会话并列——把它嵌进源会话下面会让人以为它只是源会话的一部分。
    const isSubagent = option.origin === "subagent";
    const parentId = isSubagent ? (declaredParent ?? parentFromInventory.get(option.id)) : undefined;
    if (parentId !== undefined && parentId !== option.id && byId.has(parentId)) {
      const list = childrenOf.get(parentId);
      if (list === undefined) childrenOf.set(parentId, [option]);
      else list.push(option);
    } else {
      roots.push(option);
    }
  }

  const workspaceTitles = new Map<string, string>();
  for (const workspace of inventory.workspaces) workspaceTitles.set(workspace.id, workspace.title);

  const groups = new Map<string, SessionGroup>();
  const order: string[] = [];
  const archived: SessionGroup = { id: ARCHIVED_ID, title: ARCHIVED_TITLE, count: 0, nodes: [] };

  /** 放进某个分组，保持分组首次出现顺序。 */
  const place = (groupId: string, title: string, node: SessionNode): void => {
    let group = groups.get(groupId);
    if (group === undefined) {
      group = { id: groupId, title, count: 0, nodes: [] };
      groups.set(groupId, group);
      order.push(groupId);
    }
    group.nodes.push(node);
    group.count += 1 + node.children.length;
  };

  for (const option of roots) {
    const info = inventory.bySession.get(option.id);
    const node: SessionNode = { option, children: childrenOf.get(option.id) ?? [] };
    const isArchived = option.archived === true || info?.archived === true;
    if (isArchived) {
      archived.nodes.push(node);
      archived.count += 1 + node.children.length;
      continue;
    }
    const workspaceId = info?.workspaceIds?.[0];
    if (typeof workspaceId === "string" && workspaceId !== "") {
      place(workspaceId, workspaceTitles.get(workspaceId) ?? workspaceId, node);
    } else {
      place(UNGROUPED_ID, UNGROUPED_TITLE, node);
    }
  }

  const result = order.map((id) => groups.get(id) as SessionGroup);
  // 「未分组」排在真实工作区之后，但仍然在已归档之前。
  const ungroupedIndex = result.findIndex((group) => group.id === UNGROUPED_ID);
  if (ungroupedIndex >= 0) {
    const [ungrouped] = result.splice(ungroupedIndex, 1);
    result.push(ungrouped);
  }
  if (archived.nodes.length > 0) result.push(archived);
  return result;
}

/**
 * 搜索时把树拍平成「命中项 + 路径前缀」的行，供平铺渲染。
 *
 * 树状视图里搜索必须拍平：否则要自动展开多层才能看到命中项，
 * 而且用户已经用关键词收窄了范围，分组反而碍事。
 * @param options - 平铺的会话选项。
 * @param keyword - 已小写化的关键词；空串表示不搜索。
 * @param inventory - 归档清单（用于生成工作区前缀）。
 * @returns 命中的选项（保持原顺序）。
 */
export function filterOptions(
  options: readonly PickerOption[],
  keyword: string,
  inventory: Inventory,
): PickerOption[] {
  const trimmed = keyword.trim().toLowerCase();
  if (trimmed === "") return [...options];
  return options.filter((option) => {
    if (option.label.toLowerCase().includes(trimmed)) return true;
    const workspaceId = inventory.bySession.get(option.id)?.workspaceIds?.[0];
    if (workspaceId === undefined) return false;
    const title = inventory.workspaces.find((workspace) => workspace.id === workspaceId)?.title ?? "";
    return title.toLowerCase().includes(trimmed);
  });
}
