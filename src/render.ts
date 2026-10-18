/** 引导语与消息正文拼装。 */

/**
 * 默认引导语：一句话说清三件事——引用自另一个会话、是只读快照且可能被裁剪、
 * 需要更多背景时看快照给出的完整快照落盘定位符（spill 文件）或用 session_read 工具。
 */
export const DEFAULT_GUIDANCE =
  '以上内容引用自另一个会话，是只读快照（untrusted），可能因预算被裁剪；需要更多背景时可查阅快照给出的完整快照落盘定位符（spill 文件），或使用 session_read 工具继续读取该会话。';

function meaningful(parts: string[]): string[] {
  return parts.filter((part) => typeof part === 'string' && part.trim() !== '');
}

/** 用空行连接说明、mention 与引导语，空值一律丢弃。 */
export function buildRefMessage(input: { note: string; mentions: string[]; guidance: string }): string {
  return meaningful([input.note, ...input.mentions, input.guidance]).join('\n\n');
}
