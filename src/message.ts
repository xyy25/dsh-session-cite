/** 与 DSH 内建 createUserMessage 等价的本地实现（不引入 @deepseek-ai/* 运行时代码）。 */

/**
 * 宿主运行时提供 Node 的 WebCrypto 全局对象，crypto.randomUUID() 与 node:crypto 的
 * randomUUID() 是同一实现；这里走全局对象，避免为 node 内置模块引入类型垫片。
 */
function randomId(): string {
  return crypto.randomUUID();
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) deepFreeze(record[key]);
  return value;
}

/**
 * 构造一条用户消息：结构化克隆后递归冻结，并补上 role 与随机 id。
 * 形状与 dsh-llm 的 createUserMessage 一致；宿主侧的会话引用链路只处理
 * source.kind === 'user' 的消息，所以 source 必须原样保留。
 */
export function createUserMessage<T extends Record<string, unknown>>(input: T): T & { id: string; role: 'user' } {
  const draft = { ...input, role: 'user' as const, id: randomId() };
  return deepFreeze(structuredClone(draft)) as unknown as T & { id: string; role: 'user' };
}
