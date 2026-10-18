import { parseSessionReferenceText } from './mention.js';
import type { RefToken } from './parse.js';

/** 把 /ref 的引用 token 解析成具体会话 id，并做自引用、去重与数量校验。 */

export type SessionCandidate = { sessionId: string; label: string; displayTitle?: string };

export type ResolvedRef = { id: string; label: string };

export type ResolveTargetsOptions = {
  agentId: string;
  tokens: RefToken[];
  maxReferences: number;
  listCandidates?: (query: string) => Promise<SessionCandidate[]>;
};

export type ResolveTargetsResult = { ok: true; refs: ResolvedRef[] } | { ok: false; error: string };

type SingleTarget =
  | { ok: true; id: string; label?: string; displayTitle?: string }
  | { ok: false; error: string };

const CANDIDATE_SAMPLE_LIMIT = 5;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeCandidate(candidate: SessionCandidate): string {
  return candidate.sessionId + '（' + (candidate.displayTitle ?? candidate.label) + '）';
}

async function resolveOne(token: RefToken, listCandidates: ResolveTargetsOptions['listCandidates']): Promise<SingleTarget> {
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
    } catch (error) {
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

  let candidates: SessionCandidate[];
  try {
    candidates = await listCandidates(token.raw);
  } catch (error) {
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
    return {
      ok: false,
      error: '没有找到与 ' + JSON.stringify(token.raw) + ' 匹配的会话。请确认会话 id，或改用完整 id / dsh-session: 引用。',
    };
  }
  const sample = candidates.slice(0, CANDIDATE_SAMPLE_LIMIT).map(describeCandidate).join('、');
  return {
    ok: false,
    error:
      '会话 ' + JSON.stringify(token.raw) + ' 命中 ' + candidates.length + ' 个候选：' + sample +
      '。请改用完整会话 id 或 dsh-session: 引用重新指定。',
  };
}

export async function resolveTargets(options: ResolveTargetsOptions): Promise<ResolveTargetsResult> {
  const refs: ResolvedRef[] = [];
  const seen = new Set<string>();

  for (const token of options.tokens) {
    const target = await resolveOne(token, options.listCandidates);
    if (!target.ok) return target;
    if (target.id === options.agentId) {
      return { ok: false, error: '不能引用当前会话自身（' + options.agentId + '）。请改为引用另一个会话。' };
    }
    if (seen.has(target.id)) continue;
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
