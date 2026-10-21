/**
 * 归档清单：向 dsh-session-archive 的同源 HTTP 路由查询会话治理信息。
 *
 * 为什么必须问它：归档插件只往自己的 ledger 写一条记录，**不搬动会话文件**，
 * 所以 sessions.list 里仍然会列出已归档会话，而它们通常已经不可正常读取。
 *
 * 同一个接口还给出两样 sessions.list 没有的东西，转发面板的树状列表要用：
 *   - `workspaces[]`：工作区 id / 标题 / 路径，以及它包含的 sessionIds；
 *   - 每行的 `workspaceIds` 与 `childIds`：会话归属哪个工作区、它派生了哪些子代理。
 *
 * 依赖是**可选**的：没装归档插件（404）、被门禁拒绝、网络失败，一律当作
 * 「没有信息」返回空结构，选择器的行为与之前完全一致。
 */

/** 归档插件的清单路由（与它的 ARCHIVE_API_PREFIX 一致）。 */
const INVENTORY_PATH = "/api/dsh-session-archive/inventory";

/** 缓存有效期：归档是低频操作，30 秒足够新鲜，又能避免每次开面板都请求。 */
const CACHE_TTL_MS = 30_000;

/** 一个工作区。 */
export type InventoryWorkspace = { id: string; title: string; path: string };

/** 单个会话在清单里的治理信息。 */
export type InventorySession = {
  workspaceIds: readonly string[];
  childIds: readonly string[];
  archived: boolean;
};

/** 清单的归一化结果。 */
export type Inventory = {
  archivedIds: ReadonlySet<string>;
  workspaces: readonly InventoryWorkspace[];
  bySession: ReadonlyMap<string, InventorySession>;
};

/** 空清单：外部插件不可用时的统一返回值。 */
export const EMPTY_INVENTORY: Inventory = {
  archivedIds: new Set<string>(),
  workspaces: [],
  bySession: new Map<string, InventorySession>(),
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item !== "");
}

/**
 * 解析 inventory 响应（纯函数，便于单测）。
 * 任何字段缺失或类型不符都退化为空，绝不抛错。
 * @param payload - 反序列化后的响应体。
 * @returns 归一化清单。
 */
export function parseInventory(payload: unknown): Inventory {
  if (typeof payload !== "object" || payload === null) return EMPTY_INVENTORY;

  const rawWorkspaces = (payload as { workspaces?: unknown }).workspaces;
  const workspaces: InventoryWorkspace[] = [];
  if (Array.isArray(rawWorkspaces)) {
    for (const item of rawWorkspaces) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string" || record.id === "") continue;
      workspaces.push({
        id: record.id,
        title: typeof record.title === "string" && record.title !== "" ? record.title : record.id,
        path: typeof record.path === "string" ? record.path : "",
      });
    }
  }

  const bySession = new Map<string, InventorySession>();
  const archivedIds = new Set<string>();
  const rawRows = (payload as { rows?: unknown }).rows;
  if (Array.isArray(rawRows)) {
    for (const item of rawRows) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string" || record.id === "") continue;
      const archived = record.archived === true;
      bySession.set(record.id, {
        workspaceIds: asStringArray(record.workspaceIds),
        childIds: asStringArray(record.childIds),
        archived,
      });
      if (archived) archivedIds.add(record.id);
    }
  }

  // 顶层 archivedSessionIds 比行级标记更权威（行可能被分页截断），存在时以它为准。
  const topLevel = asStringArray((payload as { archivedSessionIds?: unknown }).archivedSessionIds);
  for (const id of topLevel) archivedIds.add(id);

  return { archivedIds, workspaces, bySession };
}

let cached: Inventory | null = null;
let cachedAt = 0;
let inflight: Promise<Inventory> | null = null;

/** 清空缓存：测试用，也可在用户执行归档后强制刷新。 */
export function resetArchiveCache(): void {
  cached = null;
  cachedAt = 0;
  inflight = null;
}

/**
 * 读取归一化后的清单（带缓存与并发合并）。
 * 任何失败都降级为空清单，不抛错。
 * @param now - 当前时间戳（便于测试注入）。
 * @returns 清单。
 */
export async function loadInventory(now: number = Date.now()): Promise<Inventory> {
  if (cached !== null && now - cachedAt < CACHE_TTL_MS) return cached;
  if (inflight !== null) return inflight;
  inflight = (async (): Promise<Inventory> => {
    try {
      const doFetch = (globalThis as { fetch?: typeof fetch }).fetch;
      if (typeof doFetch !== "function") return EMPTY_INVENTORY;
      const response = await doFetch(INVENTORY_PATH, { headers: { accept: "application/json" } });
      if (!response.ok) return EMPTY_INVENTORY;
      const inventory = parseInventory(await response.json());
      cached = inventory;
      cachedAt = Date.now();
      return inventory;
    } catch {
      return EMPTY_INVENTORY;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * 只取归档会话 id 集合（popupSelect 只需要这个）。
 * @param payload - 反序列化后的响应体。
 * @returns 归档 id 集合。
 */
export function parseArchivedIds(payload: unknown): Set<string> {
  return new Set(parseInventory(payload).archivedIds);
}

/**
 * 读取归归档 id 集合（带缓存）。
 * @param now - 当前时间戳。
 * @returns 归档 id 集合。
 */
export async function loadArchivedIds(now: number = Date.now()): Promise<ReadonlySet<string>> {
  return (await loadInventory(now)).archivedIds;
}
