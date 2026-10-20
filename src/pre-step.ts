/** 消息级引用的 pre-step 展开：把草稿里的 message mention 换成转发内容。
 *
 * 为什么需要它：`--draft --pick` 只把引用写进草稿（客户端渲染成一行一个 chip），
 * 真正的内容必须在提交时展开，模型才读得到。这与内建 dsh-session-reference 对
 * 会话级 mention 的处理方式一致：摘掉 mention 原文，紧跟一条 additionalContext。
 *
 * **失败保护**：本模块跑在 agent/pre-step 上，任何异常都必须吞掉并原样放行消息，
 * 否则会阻塞整轮会话（用户侧表现为「消息发不出去」）。因此：
 *   - 单条消息扩展失败 → 该条原样通过；
 *   - 引用读取失败 → 该条原样通过；
 *   - 外层再包一层 catch，绝不向 cordis 抛错。
 */

import { createUserMessage } from './message.js';
import { parseMessageReferenceText } from './message-reference.js';
import { readMessages } from './messages.js';
import { renderForwardedMessages } from './render.js';
import type { PickKind } from './messages.js';

/** pre-step 展开需要的依赖。 */
export type MessageExpansionDeps = {
  sessionQuery: {
    listEvents(sessionId: string): Promise<readonly unknown[]>;
    readEvent(request: {
      sessionId: string;
      seq: number;
      before?: number;
      after?: number;
    }): Promise<{ target: unknown; events: unknown[] }>;
  };
  pickKinds: readonly PickKind[];
  pickReadBytes: number;
  /** ASCII 折合权重（与命令路径一致；这里只影响统计，不影响展开内容）。 */
  pickAsciiWeight: number;
  /** 转发块尾部附加的引导语（与命令路径保持一致）。 */
  guidance: string;
};

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 短 id：去掉 session- 前缀取前 8 位，用作转发块的会话标识。 */
function shortId(sessionId: string): string {
  const bare = sessionId.startsWith('session-') ? sessionId.slice(8) : sessionId;
  return bare.length > 8 ? bare.slice(0, 8) : bare;
}

/**
 * 把一组消息引用渲染成一条 additionalContext 消息。
 * @returns 追加消息；读取失败时返回 undefined（调用方保持原样）。
 */
async function buildContext(
  deps: MessageExpansionDeps,
  sessionId: string,
  seqs: readonly number[],
  signal: AbortSignal,
): Promise<unknown> {
  const read = await readMessages(deps.sessionQuery as any, sessionId, [...seqs], {
    kinds: deps.pickKinds,
    readBytes: deps.pickReadBytes,
    asciiWeight: deps.pickAsciiWeight,
  });
  if (!read.ok || read.items.length === 0) return undefined;
  const label = shortId(sessionId);
  const text = renderForwardedMessages({
    sessionId,
    label,
    shortId: label,
    items: read.items,
    note: '',
    guidance: deps.guidance,
    originalChars: read.totalChars,
    ...(read.omitted > 0 ? { omitted: read.omitted } : {}),
  });
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
}

/**
 * 展开单条消息：摘掉 mention，必要时在其后追加转发内容。
 * @returns 替换该消息的若干条消息（失败时就是它自己）。
 */
async function expandOne(
  deps: MessageExpansionDeps,
  message: unknown,
  signal: AbortSignal,
): Promise<unknown[]> {
  if (!isRecord(message)) return [message];
  if (!isRecord(message.source) || message.source.kind !== 'user') return [message];
  const content = Array.isArray(message.content) ? message.content : [];
  const bySession = new Map<string, number[]>();
  let touched = false;
  const nextContent = content.map((block: unknown) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return block;
    const parsed = parseMessageReferenceText(block.text);
    if (parsed.references.length === 0) return block;
    touched = true;
    for (const reference of parsed.references) {
      const list = bySession.get(reference.sessionId) ?? [];
      if (!list.includes(reference.seq)) list.push(reference.seq);
      bySession.set(reference.sessionId, list);
    }
    return { ...block, text: parsed.text };
  });
  if (!touched || bySession.size === 0) return [message];

  const direct = { ...message, content: nextContent };
  const appended: unknown[] = [direct];
  for (const [sessionId, seqs] of bySession) {
    const context = await buildContext(deps, sessionId, seqs, signal);
    if (context !== undefined) appended.push(context);
  }
  return appended;
}

/**
 * 展开一轮里的全部消息。
 * 说明：引用读不出来时**不**报错，只是不追加内容——
 * 宁可少一段背景，也不能让整轮会话失败。
 * @param deps - 会话查询与读取预算。
 * @param messages - 下游 pre-step 已接受的消息。
 * @param signal - 本轮取消信号。
 * @returns 展开后的消息序列。
 */
export async function expandMessageReferences(
  deps: MessageExpansionDeps,
  messages: readonly unknown[],
  signal: AbortSignal,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const message of messages) {
    let expanded: unknown[];
    try {
      expanded = await expandOne(deps, message, signal);
    } catch {
      expanded = [message];
    }
    out.push(...expanded);
  }
  return out;
}
