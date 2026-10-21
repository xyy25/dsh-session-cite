/** 消息级引用的 URI 与行内 mention 编解码。
 *
 * 与会话级 `dsh-session:` 并列：一条消息引用编码 `{ s: 会话id, q: 事件seq }`。
 * 之所以单独一个 scheme，是因为会话级 mention 由内建 dsh-session-reference 处理，
 * 而消息级必须由本插件自己在 agent/pre-step 展开，两者不能混用同一前缀。
 */

import {
  escapeReferenceLabel,
  fromBase64Url,
  toBase64Url,
  unescapeReferenceLabel,
  utf8Bytes,
  utf8Text,
} from './mention.js';

/** 消息级引用 URI 的固定 scheme。 */
export const MESSAGE_REFERENCE_SCHEME = 'dsh-session-message:';

const CANONICAL_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 扫描文本里的消息级 mention（只认带标签的 markdown 形式）。 */
const MESSAGE_REFERENCE_PATTERN = /@\[((?:\\.|[^\\\]])*)\]\(dsh-session-message:([^\s)]*)\)/gu;

/** 一条消息级引用：目标会话 + 事件序号，可选地要求摘要压缩。 */
export type MessageReference = { sessionId: string; seq: number; compact?: boolean };

function invalidUri(uri: string): Error {
  return new Error('不是合法的消息引用：' + JSON.stringify(uri));
}

/**
 * 把消息引用编码为规范 URI。
 * 压缩标志只在需要时出现（c:1），因此不带压缩的载荷与旧版逐字一致。
 */
export function encodeMessageReferenceUri(reference: MessageReference): string {
  const payload =
    reference.compact === true
      ? JSON.stringify({ s: reference.sessionId, q: reference.seq, c: 1 })
      : JSON.stringify({ s: reference.sessionId, q: reference.seq });
  return MESSAGE_REFERENCE_SCHEME + toBase64Url(utf8Bytes(payload));
}

/** 解码 URI 并校验规范性；非规范或非法一律抛错。 */
export function decodeMessageReferenceUri(uri: string): MessageReference {
  if (!uri.startsWith(MESSAGE_REFERENCE_SCHEME)) throw invalidUri(uri);
  const payload = uri.slice(MESSAGE_REFERENCE_SCHEME.length);
  if (!CANONICAL_PAYLOAD_PATTERN.test(payload)) throw invalidUri(uri);
  let decoded: unknown;
  try {
    decoded = JSON.parse(utf8Text(fromBase64Url(payload)));
  } catch {
    throw invalidUri(uri);
  }
  if (typeof decoded !== 'object' || decoded === null) throw invalidUri(uri);
  const record = decoded as Record<string, unknown>;
  const sessionId = record.s;
  const seq = record.q;
  if (typeof sessionId !== 'string' || sessionId === '') throw invalidUri(uri);
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) throw invalidUri(uri);
  // 压缩标志只认字面量 1：其它写法（true、"1"）都是非规范载荷。
  if (record.c !== undefined && record.c !== 1) throw invalidUri(uri);
  const compact = record.c === 1;
  // 规范性校验：重新编码必须逐字一致。
  const reference: MessageReference = compact ? { sessionId, seq, compact: true } : { sessionId, seq };
  if (encodeMessageReferenceUri(reference) !== uri) throw invalidUri(uri);
  return reference;
}

/** 生成形如 @[#9 user](dsh-session-message:xxx) 的 mention。 */
export function formatMessageReferenceMention(input: {
  sessionId: string;
  seq: number;
  label: string;
  /** 要求 pre-step 在展开时走摘要压缩。 */
  compact?: boolean;
}): string {
  const uri = encodeMessageReferenceUri({
    sessionId: input.sessionId,
    seq: input.seq,
    ...(input.compact === true ? { compact: true } : {}),
  });
  return '@[' + escapeReferenceLabel(input.label) + '](' + uri + ')';
}

export type ParsedMessageReference = MessageReference & { label: string };

/**
 * 抽取文本里的消息级 mention，并把出现处改写成 @标签。
 * 与会话级不同，这里**不抛错**：任何非法载荷都原样保留文本，
 * 因为这段代码跑在 agent/pre-step 上，抛错会阻塞整轮会话。
 * @param text - 原始正文。
 * @returns 清理后的文本与被解析出的引用（按出现顺序）。
 */
export function parseMessageReferenceText(text: string): {
  text: string;
  references: ParsedMessageReference[];
} {
  const references: ParsedMessageReference[] = [];
  const normalized = text.replace(
    new RegExp(MESSAGE_REFERENCE_PATTERN),
    (match: string, rawLabel?: string, payload?: string) => {
      if (rawLabel === undefined || payload === undefined) return match;
      let reference: MessageReference;
      try {
        reference = decodeMessageReferenceUri(MESSAGE_REFERENCE_SCHEME + payload);
      } catch {
        return match;
      }
      references.push({ ...reference, label: unescapeReferenceLabel(rawLabel) });
      return '@' + unescapeReferenceLabel(rawLabel);
    },
  );
  return { text: normalized, references };
}
