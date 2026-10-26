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

/** 骨架里的一条：只含序号与类型，正文待填充。 */
export type TurnMetaItem = { seq: number; kind: string };

/** 一轮的骨架：边界与每条的 seq/kind。 */
export type TurnMeta = { items: TurnMetaItem[]; startSeq: number; endSeq: number };

/**
 * 只取某一轮的骨架（不读正文）。
 *
 * 列骨架在 Host 侧只要 listEvents 一次（约 0.4 秒），而正文要逐条解压。
 * 面板先拿骨架渲染占位列表，再分批取正文，用户就不用面对空转的圈。
 * @param sessionId - 源会话 id。
 * @param turn - 轮次编号。
 * @returns 骨架；任何失败都返回 undefined。
 */
export async function fetchTurnMeta(
  sessionId: string,
  turn: number,
  fromSeq?: number,
  toSeq?: number,
): Promise<TurnMeta | undefined> {
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  if (!Number.isSafeInteger(turn) || turn < 0) return undefined;
  const doFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof doFetch !== "function") return undefined;
  try {
    let url =
      TURN_MESSAGES_PATH + "?session=" + encodeURIComponent(sessionId) + "&turn=" + String(turn) + "&meta=1";
    // 带上该轮的 seq 边界：Host 就不必逐个读 turn 事件去找边界（那要好几秒）。
    if (typeof fromSeq === "number" && Number.isSafeInteger(fromSeq)) url += "&from=" + String(fromSeq);
    if (typeof toSeq === "number" && Number.isSafeInteger(toSeq)) url += "&to=" + String(toSeq);
    const response = await doFetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) return undefined;
    const payload: any = await response.json();
    if (payload?.ok !== true || !Array.isArray(payload.items)) return undefined;
    const items: TurnMetaItem[] = [];
    for (const item of payload.items) {
      if (typeof item?.seq !== "number" || typeof item?.kind !== "string") continue;
      items.push({ seq: item.seq, kind: item.kind });
    }
    return {
      items,
      startSeq: typeof payload.startSeq === "number" ? payload.startSeq : 0,
      endSeq: typeof payload.endSeq === "number" ? payload.endSeq : 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * 探测某一轮的日志现在是否已在 Host 缓存里（即再读会很快）。
 *
 * 用于决定「上次选的原始日志」还能不能沿用：冷缓存下一轮要解压整份日志、
 * 大轮次十几秒，那就该退回快照而不是让用户白等。探测本身是 O(1)，不读日志。
 * @param sessionId - 源会话 id。
 * @param turn - 轮次编号。
 * @returns 命中返回 true；任何失败都返回 false（保守地当作没缓存）。
 */
export async function probeTurnCached(sessionId: string, turn: number): Promise<boolean> {
  if (typeof sessionId !== "string" || sessionId === "") return false;
  if (!Number.isSafeInteger(turn) || turn < 0) return false;
  const doFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof doFetch !== "function") return false;
  try {
    const url =
      TURN_MESSAGES_PATH +
      "?session=" +
      encodeURIComponent(sessionId) +
      "&turn=" +
      String(turn) +
      "&probe=1";
    const response = await doFetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) return false;
    const payload: any = await response.json();
    return payload?.ok === true && payload.cached === true;
  } catch {
    return false;
  }
}

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
