/**
 * 只读 HTTP 路由：把「某一轮的可转发消息」暴露给浏览器端面板。
 *
 * 为什么要一条路由：面板在浏览器里，拿不到 Host 侧的 sessionQuery；而它要显示
 * 的内容必须来自原始日志（这样 tool/call 与 tool/result 才是两行）。路由只读、
 * 只接受 GET，并且**只允许本机回环访问**——会话正文属于敏感数据，局域网与隧道
 * 客户端一律 403，那种场景下面板会自动退回 chat 快照。
 */
import { probeTurnCache, readTurnMessages, readTurnMeta } from './turn-messages.js';
/** 路由路径（与客户端常量逐字一致）。 */
export const TURN_MESSAGES_PATH = '/api/dsh-session-cite/turn-messages';
/**
 * 判断请求是否来自本机回环。
 * 只认回环地址：本插件不打算把会话正文暴露给局域网。
 * @param req - 原始请求。
 * @returns 是否本机。
 */
function isLoopback(req) {
    const address = req?.socket?.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
/**
 * 写一个 JSON 响应；连写失败都不抛（路由不能让 host 崩）。
 * @param res - 原始响应。
 * @param status - HTTP 状态码。
 * @param body - 任意可序列化对象。
 */
function writeJson(res, status, body) {
    try {
        const text = JSON.stringify(body);
        res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        });
        res.end(text);
    }
    catch {
        try {
            res.destroy();
        }
        catch {
            // 连接已断：忽略。
        }
    }
}
/**
 * 构造这条路由。
 * @param deps - 会话查询与读取配置。
 * @returns 可交给 ctx.webServer.register 的路由对象。
 */
export function makeTurnMessagesRoute(deps) {
    return {
        kind: 'exact',
        path: TURN_MESSAGES_PATH,
        async handler(req, res) {
            if (!isLoopback(req)) {
                writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' });
                return;
            }
            if ((req?.method ?? 'GET') !== 'GET') {
                writeJson(res, 405, { ok: false, error: 'method not allowed' });
                return;
            }
            let sessionId = '';
            let turn = Number.NaN;
            let from;
            let to;
            let probe = false;
            let meta = false;
            try {
                const url = new URL(req.url ?? '/', 'http://localhost');
                sessionId = url.searchParams.get('session') ?? '';
                turn = Number.parseInt(url.searchParams.get('turn') ?? '', 10);
                // probe=1：只问「这一轮现在读起来快不快」，不返回任何正文。
                probe = url.searchParams.get('probe') === '1';
                // meta=1：只要每条的 seq/kind（骨架），不读正文——面板据此先渲染占位列表。
                meta = url.searchParams.get('meta') === '1';
                // 客户端能从 slot 的 turn 对象里拿到精确边界（start.seq / end.seq）。
                const fromRaw = url.searchParams.get('from');
                if (fromRaw !== null) {
                    const parsed = Number.parseInt(fromRaw, 10);
                    if (Number.isSafeInteger(parsed) && parsed >= 0)
                        from = parsed;
                }
                const toRaw = url.searchParams.get('to');
                if (toRaw !== null) {
                    const parsed = Number.parseInt(toRaw, 10);
                    if (Number.isSafeInteger(parsed) && parsed >= 0)
                        to = parsed;
                }
            }
            catch {
                writeJson(res, 400, { ok: false, error: 'bad request' });
                return;
            }
            try {
                // 探测模式：只回答缓存命中与否，不读日志——所以必须是 O(1)。
                if (probe) {
                    const cached = probeTurnCache(sessionId, turn);
                    writeJson(res, 200, { ok: true, cached });
                    return;
                }
                // 骨架模式：只列 seq/kind，不读正文（listEvents 一次，约 0.4 秒）。
                if (meta) {
                    const result = await readTurnMeta(deps.query, sessionId, turn, deps.kinds, from === undefined && to === undefined
                        ? undefined
                        : { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) });
                    writeJson(res, result.ok ? 200 : 404, result);
                    return;
                }
                const result = await readTurnMessages(deps.query, sessionId, turn, {
                    kinds: deps.kinds,
                    readBytes: deps.readBytes,
                    asciiWeight: deps.asciiWeight,
                }, from === undefined && to === undefined
                    ? undefined
                    : { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) });
                // 边界缺失（轮次还没结束 / 找不到）用 404，客户端据此退回快照。
                writeJson(res, result.ok ? 200 : 404, result);
            }
            catch (error) {
                writeJson(res, 500, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        },
    };
}
