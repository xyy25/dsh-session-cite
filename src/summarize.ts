/**
 * 消息摘要：把选中的消息交给模型压成结构化中文摘要。
 *
 * 零运行时依赖：llm 由调用方注入；只消费 dsh-llm 流式协议里的 text-delta 增量
 * （StreamChunk = block-start | text-delta | reasoning-delta | tool-call-delta |
 * block-end | usage | finish），其余块一律忽略。
 */

import type { MessageItem } from './messages.js';

/** 摘要请求的默认输出上限（token）。 */
export const SUMMARY_MAX_TOKENS = 2048;

export type SummarizeResult = { ok: true; text: string } | { ok: false; error: string };

const SYSTEM_PROMPT = [
  '你是会话记录整理器。用户会给你另一个会话里若干条指定消息的原始内容，每条带 seq 编号与角色标注。',
  '请输出一份结构化的中文摘要：按给出的顺序逐条列出每条消息的要点，并在每条开头保留 seq 编号与角色标注（用户 / 助手 / 工具 / 压缩摘要）。',
  '要求：只依据给出的内容归纳，不要编造，不要补充外部知识，不要输出寒暄或开场白；工具参数与工具结果只概括关键动作与结论。',
  '输出用简洁的分条列表，不要包 Markdown 代码块。',
].join('\n');

const ROLE_LABEL: Readonly<Record<string, string>> = {
  user: '用户',
  assistant: '助手',
  tool: '工具',
  summary: '压缩摘要',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  const text = String(error);
  return text === '' ? '未知错误' : text;
}

/** 把消息条目录成中文提示词：每条都带 seq 与角色，方便模型逐条对应。 */
function buildPrompt(items: readonly MessageItem[], sessionLabel: string): string {
  const lines: string[] = [];
  lines.push('## 会话：' + (sessionLabel === '' ? '（未命名）' : sessionLabel));
  lines.push('');
  let chars = 0;
  for (const item of items) chars += item.chars;
  lines.push('共 ' + items.length + ' 条消息，正文合计 ' + chars + ' 字。');
  lines.push('');
  for (const item of items) {
    const role = ROLE_LABEL[item.role] ?? item.role;
    const marks: string[] = [];
    if (item.paired === true) marks.push('自动配对项');
    if (item.truncated === true) marks.push('正文已截断');
    const suffix = marks.length > 0 ? '（' + marks.join('、') + '）' : '';
    lines.push('### seq #' + item.seq + ' · ' + role + suffix);
    lines.push(item.text === '' ? '（空内容）' : item.text);
    lines.push('');
  }
  lines.push('请按上面的顺序输出结构化摘要，逐条保留 seq 与角色标注。');
  return lines.join('\n');
}

/**
 * 调模型生成结构化摘要。
 *
 * 错误一律返回中文原因，不吞异常：中止信号已触发时提前返回；
 * 流为空或累积结果全为空白时报告「摘要返回为空」。
 */
export async function summarizeMessages(
  deps: {
    llm: { stream(options: any): AsyncIterable<any> };
    provider: string;
    model: string;
  },
  input: { items: readonly MessageItem[]; sessionLabel: string; maxTokens?: number; signal: AbortSignal },
): Promise<SummarizeResult> {
  const signal = input.signal;
  const aborted = (): boolean => signal !== undefined && signal.aborted === true;

  if (aborted()) return { ok: false, error: '摘要已取消：中止信号已触发' };
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return { ok: false, error: '没有可摘要的消息' };
  }

  const maxTokens =
    typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) && input.maxTokens > 0
      ? Math.floor(input.maxTokens)
      : SUMMARY_MAX_TOKENS;
  const prompt = buildPrompt(input.items, input.sessionLabel);

  let text = '';
  try {
    const stream = deps.llm.stream({
      provider: deps.provider,
      model: deps.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
      signal,
    });
    for await (const chunk of stream) {
      if (aborted()) return { ok: false, error: '摘要已取消：中止信号已触发' };
      if (!isRecord(chunk)) continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    }
  } catch (error) {
    if (aborted()) return { ok: false, error: '摘要已取消：请求被中止（' + messageOf(error) + '）' };
    return { ok: false, error: '摘要调用失败：' + messageOf(error) };
  }

  if (text.trim() === '') return { ok: false, error: '摘要返回为空' };
  return { ok: true, text };
}
