/**
 * 归档状态：向 dsh-session-archive 的同源 HTTP 路由查询「哪些会话已归档」。
 *
 * 为什么必须问它：归档插件只往自己的 ledger 写一条记录，**不搬动会话文件**，
 * 所以 sessions.list 里仍然会列出已归档会话，而它们通常已经不可正常读取。
 * 选择器必须把这些行沉底并标记，否则很容易误选。
 *
 * 依赖是**可选**的：没装归档插件（404）、被门禁拒绝、网络失败，一律当作
 * 「没有归档信息」返回空集，选择器的行为与之前完全一致——绝不因为外部插件
 * 不可用而打不开列表。
 */

/** 归档插件的清单路由（与它的 ARCHIVE_API_PREFIX 一致）。 */
const INVENTORY_PATH = "/api/dsh-session-archive/inventory";

/** 缓存有效期：归档是低频操作，30 秒足够新鲜，又能避免每次开面板都请求。 */
const CACHE_TTL_MS = 30_000;

/** 空集合常量：调用方可以安全共享。 */
export const EMPTY_ARCHIVED: ReadonlySet<string> = new Set<string>();

/**
 * 从 inventory 响应里取出归档 id 集合。
 * 只认 `archivedSessionIds: string[]`，其它形状一律视为「没有信息」。
 * @param payload - 反序列化后的响应体。
 * @returns 归档会话 id 集合。
 */
export function parseArchivedIds(payload: unknown): Set<string> {
  const out = new Set<string>();
  const list = (payload as { archivedSessionIds?: unknown } | null | undefined)?.archivedSessionIds;
  if (!Array.isArray(list)) return out;
  for (const id of list) {
    if (typeof id === "string" && id !== "") out.add(id);
  }
  return out;
}

let cached: Set<string> | null = null;
let cachedAt = 0;
let inflight: Promise<ReadonlySet<string>> | null = null;

/** 清空缓存：测试用，也可在用户执行归档后强制刷新。 */
export function resetArchiveCache(): void {
  cached = null;
  cachedAt = 0;
  inflight = null;
}

/**
 * 读取已归档会话 id 集合（带缓存与并发合并）。
 * 任何失败都降级为空集，不抛错。
 * @param now - 当前时间戳（便于测试注入）。
 * @returns 归档 id 集合。
 */
export async function loadArchivedIds(now: number = Date.now()): Promise<ReadonlySet<string>> {
  if (cached !== null && now - cachedAt < CACHE_TTL_MS) return cached;
  if (inflight !== null) return inflight;
  inflight = (async (): Promise<ReadonlySet<string>> => {
    try {
      const doFetch = (globalThis as { fetch?: typeof fetch }).fetch;
      if (typeof doFetch !== "function") return EMPTY_ARCHIVED;
      const response = await doFetch(INVENTORY_PATH, { headers: { accept: "application/json" } });
      if (!response.ok) return EMPTY_ARCHIVED;
      const ids = parseArchivedIds(await response.json());
      cached = ids;
      cachedAt = Date.now();
      return ids;
    } catch {
      return EMPTY_ARCHIVED;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
