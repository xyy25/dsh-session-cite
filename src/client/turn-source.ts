/**
 * 从 Host 取「某一轮的可转发消息」。
 *
 * 面板原先只读客户端 chat 快照，而快照把一次工具调用的 tool/call 与 tool/result
 * 合并成一个节点，列表里因此只有 tool-result。这里改走插件自己在 Host 注册的
 * 只读路由，取数函数与命令侧 `--list / --pick` 完全相同，类型、摘要、seq 都同源。
 *
 * 路由不可用（Host 未重启、非 web 形态、局域网访问被 403、请求失败）时返回
 * undefined，调用方回退到 chat 快照——绝不让面板变空。
 */

/** 路由路径（与 Host 侧 TURN_MESSAGES_PATH 逐字一致）。 */
const TURN_MESSAGES_PATH = "/api/dsh-session-cite/turn-messages";

/** 面板可直接消费的一行。 */
export type HostTurnRow = { seq: number; kind: string; text: string; summary: string };

/** 一次读取的结果：可见行 + 因正文为空被跳过的条数。 */
export type TurnPayload = { rows: HostTurnRow[]; skipped: number };

/**
 * 取某一轮的消息。
 * @param sessionId - 源会话 id。
 * @param turn - 轮次编号。
 * @returns 可见行与跳过数；任何失败都返回 undefined。
 */
export async function fetchTurnRows(
  sessionId: string,
  turn: number,
  fromSeq?: number,
  toSeq?: number,
): Promise<TurnPayload | undefined> {
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  if (!Number.isSafeInteger(turn) || turn < 0) return undefined;
  const doFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof doFetch !== "function") return undefined;
  try {
    let url = TURN_MESSAGES_PATH + "?session=" + encodeURIComponent(sessionId) + "&turn=" + String(turn);
    if (typeof fromSeq === "number" && Number.isSafeInteger(fromSeq)) url += "&from=" + String(fromSeq);
    if (typeof toSeq === "number" && Number.isSafeInteger(toSeq)) url += "&to=" + String(toSeq);
    const response = await doFetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) return undefined;
    const payload: any = await response.json();
    if (payload?.ok !== true || !Array.isArray(payload.rows)) return undefined;
    const rows: HostTurnRow[] = [];
    for (const item of payload.rows) {
      if (typeof item?.seq !== "number" || typeof item?.kind !== "string" || typeof item?.text !== "string") continue;
      rows.push({
        seq: item.seq,
        kind: item.kind,
        text: item.text,
        summary: typeof item.summary === "string" ? item.summary : "",
      });
    }
    return {
      rows,
      skipped: typeof payload.skipped === "number" && payload.skipped >= 0 ? payload.skipped : 0,
    };
  } catch {
    return undefined;
  }
}
