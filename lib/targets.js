import { parseSessionReferenceText } from './mention.js';
const CANDIDATE_SAMPLE_LIMIT = 5;
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function describeCandidate(candidate) {
    return candidate.sessionId + '（' + (candidate.displayTitle ?? candidate.label) + '）';
}
/**
 * 判断一个裸 id 是否指向当前会话。
 *
 * 为什么要单独判断：dsh 的 `listCandidates` 会在源头过滤掉当前会话
 * （`record.header.id !== agent.id`），所以「引用自己」永远落在「候选为空」分支，
 * 报出来的是「没有找到匹配的会话」，而不是自引用提示。
 * 这里按完整 id 或短 id 前缀（至少 6 位）识别自己，交给上层决定放行还是报错。
 * @param raw - 用户输入的裸 id。
 * @param agentId - 当前会话的完整 id。
 * @returns 是否指向自己。
 */
export function matchesSelf(raw, agentId) {
    if (raw === agentId)
        return true;
    const bare = agentId.startsWith('session-') ? agentId.slice(8) : agentId;
    const trimmed = raw.startsWith('session-') ? raw.slice(8) : raw;
    // 前缀太短容易误判别的会话，6 位是短 id（8 位）的合理下限。
    return trimmed.length >= 6 && bare.startsWith(trimmed);
}
async function resolveOne(token, listCandidates, agentId) {
    if (token.kind === 'uri' || token.kind === 'mention') {
        try {
            const parsed = parseSessionReferenceText(token.raw);
            const first = parsed.references[0];
            if (first === undefined) {
                return { ok: false, error: '无法从 ' + JSON.stringify(token.raw) + ' 读到会话引用。请重新复制完整的 dsh-session: 引用，或直接写会话 id。' };
            }
            return token.kind === 'mention'
                ? { ok: true, id: first.sessionId, label: first.label }
                : { ok: true, id: first.sessionId };
        }
        catch (error) {
            return {
                ok: false,
                error: '会话引用 ' + JSON.stringify(token.raw) + ' 无法解析（' + messageOf(error) + '）。请重新复制该引用，或改用 dsh-session: 开头的规范形式。',
            };
        }
    }
    if (listCandidates === undefined) {
        return {
            ok: false,
            error: '当前宿主没有提供会话候选查询，无法按裸 id ' + JSON.stringify(token.raw) + ' 定位会话。请改用 dsh-session: 形式的完整引用，或直接给出完整会话 id。',
        };
    }
    let candidates;
    try {
        candidates = await listCandidates(token.raw);
    }
    catch (error) {
        return {
            ok: false,
            error: '查询会话候选失败：' + messageOf(error) + '。请稍后重试，或改用 dsh-session: 形式的完整引用。',
        };
    }
    const exact = candidates.find((candidate) => candidate.sessionId === token.raw);
    if (exact !== undefined) {
        return { ok: true, id: exact.sessionId, label: exact.label, displayTitle: exact.displayTitle };
    }
    if (candidates.length === 1) {
        const only = candidates[0];
        return { ok: true, id: only.sessionId, label: only.label, displayTitle: only.displayTitle };
    }
    if (candidates.length === 0) {
        // 当前会话永远不在候选里，所以先按「指向自己」再判一次：
        // 会话级引用会在这里得到明确的自引用提示，而不是含糊的「找不到」。
        if (matchesSelf(token.raw, agentId)) {
            return { ok: true, id: agentId, label: agentId };
        }
        return {
            ok: false,
            error: '没有找到与 ' + JSON.stringify(token.raw) + ' 匹配的会话。请确认会话 id，或改用完整 id / dsh-session: 引用。',
        };
    }
    const sample = candidates.slice(0, CANDIDATE_SAMPLE_LIMIT).map(describeCandidate).join('、');
    return {
        ok: false,
        error: '会话 ' + JSON.stringify(token.raw) + ' 命中 ' + candidates.length + ' 个候选：' + sample +
            '。请改用完整会话 id 或 dsh-session: 引用重新指定。',
    };
}
export async function resolveTargets(options) {
    const refs = [];
    const seen = new Set();
    for (const token of options.tokens) {
        const target = await resolveOne(token, options.listCandidates, options.agentId);
        if (!target.ok)
            return target;
        if (target.id === options.agentId && options.allowSelf !== true) {
            return {
                ok: false,
                error: '不能引用当前会话自身（' + options.agentId + '）。会话级引用请改为引用另一个会话；' +
                    '只想搬运本会话的消息，请加上 --list 或 --pick（消息级允许自引用）。',
            };
        }
        if (seen.has(target.id))
            continue;
        seen.add(target.id);
        refs.push({ id: target.id, label: target.displayTitle ?? target.label ?? target.id });
    }
    if (refs.length > options.maxReferences) {
        return {
            ok: false,
            error: '最多只能引用 ' + options.maxReferences + ' 个会话，当前为 ' + refs.length + ' 个。请减少引用后重试。',
        };
    }
    return { ok: true, refs };
}
