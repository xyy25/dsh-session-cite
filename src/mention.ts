/** 会话引用 URI 与行内 mention 的本地编解码实现。 */

/**
 * 与 DSH 内建 dsh-session-reference 逐字对齐：URI 载荷是会话 id 的 JSON 文本的 base64url。
 * 插件运行时不得依赖 @deepseek-ai/* 包（本机沙箱无法为插件目录建立 node_modules 链接），
 * 因此这里用纯字符串实现 base64url，行为与 Buffer 的 'base64url' 编解码一致。
 */

/** 会话引用 URI 的固定 scheme。 */
export const SESSION_REFERENCE_SCHEME = 'dsh-session:';

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const BASE64URL_VALUES = new Map<string, number>(
  Array.from(BASE64URL_ALPHABET, (char, index) => [char, index] as [string, number]),
);

/** 与内建实现完全一致的 mention / 裸 URI 扫描正则（含标签转义处理）。 */
const REFERENCE_PATTERN = /@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)|(dsh-session:[A-Za-z0-9_-]+)/gu;

const CANONICAL_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]+$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** UTF-8 编码为字节序列。 */
export function utf8Bytes(text: string): number[] {
  return Array.from(textEncoder.encode(text));
}

/** 字节序列按 UTF-8 解码。 */
export function utf8Text(bytes: number[]): string {
  return textDecoder.decode(new Uint8Array(bytes));
}

/** 把字节序列编码为无填充的 base64url（消息级引用复用它）。 */
export function toBase64Url(bytes: number[]): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : undefined;
    const third = index + 2 < bytes.length ? bytes[index + 2] : undefined;
    out += BASE64URL_ALPHABET[first >> 2];
    out += BASE64URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second === undefined) break;
    out += BASE64URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    if (third === undefined) break;
    out += BASE64URL_ALPHABET[third & 0x3f];
  }
  return out;
}

/** 解码无填充的 base64url；非法字符直接抛错。 */
export function fromBase64Url(payload: string): number[] {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of payload) {
    const value = BASE64URL_VALUES.get(char);
    if (value === undefined) throw invalidUri(SESSION_REFERENCE_SCHEME + payload);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

function invalidUri(uri: string): Error {
  return new Error('不是合法的会话引用：' + JSON.stringify(uri));
}

/** 把会话 id 编码为规范 URI。 */
export function encodeSessionReferenceUri(sessionId: string): string {
  return SESSION_REFERENCE_SCHEME + toBase64Url(utf8Bytes(JSON.stringify(sessionId)));
}

/** 解码 URI 并校验规范性；非规范或非法的 URI 一律抛错。 */
export function decodeSessionReferenceUri(uri: string): string {
  if (!uri.startsWith(SESSION_REFERENCE_SCHEME)) throw invalidUri(uri);
  const payload = uri.slice(SESSION_REFERENCE_SCHEME.length);
  if (!CANONICAL_PAYLOAD_PATTERN.test(payload)) throw invalidUri(uri);
  let decoded: unknown;
  try {
    decoded = JSON.parse(utf8Text(fromBase64Url(payload)));
  } catch {
    throw invalidUri(uri);
  }
  if (typeof decoded !== 'string') throw invalidUri(uri);
  if (encodeSessionReferenceUri(decoded) !== uri) throw invalidUri(uri);
  return decoded;
}

/** 转义 mention 标签中的反斜杠与右方括号。 */
export function escapeReferenceLabel(label: string): string {
  return label.replace(/[\\\]]/gu, (match) => '\\' + match);
}

/** 还原 mention 标签中被转义的字符。 */
export function unescapeReferenceLabel(label: string): string {
  return label.replace(/\\(.)/gu, '$1');
}

/** 生成形如 @[标签](dsh-session:xxx) 的 mention；标签缺省时用会话 id。 */
export function formatSessionReferenceMention(input: { sessionId: string; label?: string }): string {
  const label = input.label ?? input.sessionId;
  return '@[' + escapeReferenceLabel(label) + '](' + encodeSessionReferenceUri(input.sessionId) + ')';
}

export type ParsedReference = { sessionId: string; label: string };

/**
 * 抽取文本中的 mention 与裸 URI，并把出现处改写为 @标签。
 * 与内建实现一致：遇到非法或非规范的 URI 直接抛错，不做静默跳过。
 */
export function parseSessionReferenceText(text: string): { text: string; references: ParsedReference[] } {
  const references: ParsedReference[] = [];
  const normalized = text.replace(
    new RegExp(REFERENCE_PATTERN),
    (match: string, rawLabel?: string, markdownUri?: string, bareUri?: string) => {
      const uri = markdownUri ?? bareUri;
      if (uri === undefined) throw invalidUri(match);
      const sessionId = decodeSessionReferenceUri(uri);
      const label = rawLabel === undefined ? sessionId : unescapeReferenceLabel(rawLabel);
      references.push({ sessionId, label });
      return '@' + label;
    },
  );
  return { text: normalized, references };
}
