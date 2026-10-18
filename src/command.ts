import { formatSessionReferenceMention } from './mention.js';
import { createUserMessage } from './message.js';
import { parseRefInput } from './parse.js';
import { buildRefMessage, DEFAULT_GUIDANCE } from './render.js';
import { resolveTargets } from './targets.js';
import type { SessionCandidate } from './targets.js';

/** /ref 命令的执行链路：解析参数 → 解析目标 → 中止检查 → 提交或返回草稿。 */

export const REF_COMMAND_NAME = 'ref';

export const REF_DESCRIPTION =
  '把另一个会话作为只读快照引用到本轮对话，附完整快照落盘定位符，可用 session_read 工具按需回查。';

export const REF_INPUT_HINT =
  '用法：/ref [--draft|--send] <会话 id 或 dsh-session: 引用> ... [说明]；--draft 只返回草稿不发送。';

export type RefConfig = { mode: 'send' | 'draft'; maxReferences: number; guidance: string };

export type RefInvocationLike = {
  agent: { id: string; status: string; followup(message: unknown): void };
  rawInput: string;
  signal: AbortSignal;
};

export type RefDeps = { config: RefConfig; listCandidates?: (query: string) => Promise<SessionCandidate[]> };

export type RefResult = { kind: 'success'; text: string } | { kind: 'error'; text: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function executeRef(deps: RefDeps, invocation: RefInvocationLike): Promise<RefResult> {
  const parsed = parseRefInput(invocation.rawInput);
  if (!parsed.ok) return { kind: 'error', text: parsed.error };

  const resolved = await resolveTargets({
    agentId: invocation.agent.id,
    tokens: parsed.tokens,
    maxReferences: deps.config.maxReferences,
    listCandidates: deps.listCandidates,
  });
  if (!resolved.ok) return { kind: 'error', text: resolved.error };

  if (invocation.signal?.aborted === true) {
    return { kind: 'error', text: '已取消：/ref 没有提交任何引用，需要时可以重新执行。' };
  }

  const mentions = resolved.refs.map((ref) =>
    formatSessionReferenceMention({ sessionId: ref.id, label: ref.label }),
  );
  const mode = parsed.mode ?? deps.config.mode;

  if (mode === 'draft') {
    return { kind: 'success', text: buildRefMessage({ note: parsed.note, mentions, guidance: '' }) };
  }

  const guidance = deps.config.guidance.trim() === '' ? DEFAULT_GUIDANCE : deps.config.guidance;
  const message = createUserMessage({
    content: [{ type: 'text', text: buildRefMessage({ note: parsed.note, mentions, guidance }) }],
    source: { kind: 'user' },
  });

  try {
    invocation.agent.followup(message);
  } catch (error) {
    return {
      kind: 'error',
      text: '提交引用失败：' + messageOf(error) + '。请重试；若持续失败，可以在对话里直接说明需要参考哪个会话。',
    };
  }

  const labels = resolved.refs.map((ref) => ref.label).join('、');
  const state = invocation.agent.status === 'running' ? '已排队到下一轮' : '已开启新一轮';
  return { kind: 'success', text: '已引用 ' + resolved.refs.length + ' 个会话：' + labels + '（' + state + '）。' };
}
