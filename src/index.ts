// dsh-session-cite 插件入口（宿主侧装配）。
//
// 能力：
//   1. /ref 命令：把另一个会话压缩成快照并引用到当前对话。
//      命令 handler 组装一条 source.kind 为 'user' 的用户消息并调用
//      agent.followup()，由 dsh 内建的 @deepseek-ai/dsh-session-reference
//      在 agent/pre-step 阶段自动把被引用会话的压缩快照插到该消息之后。
//   2. session_read 工具：让模型按 session-id（+ 可选关键字）继续索取
//      被引用会话的更多片段，输出永远受字节预算约束。
//
// 零运行时外部依赖：本包不 import 任何 @deepseek-ai/* 的值导出。
// 原因：本机沙箱禁止在插件目录创建 node_modules 链接，profile 也不提供这些包，
// 任何运行时 import 都会在加载时失败。需要的内建能力一律由本地等价实现承担，
// 并由 test/ 下的契约回环测试对齐内建行为。

import { REF_COMMAND_NAME, REF_DESCRIPTION, REF_INPUT_HINT, executeRef } from "./command.js";
import { DEFAULT_ASCII_WEIGHT, MAX_ASCII_WEIGHT, MIN_ASCII_WEIGHT, DEFAULT_PICK_KINDS, normalizePickKinds } from "./messages.js";
import { registerSessionRead } from "./session-read.js";
import { expandMessageReferences } from "./pre-step.js";
import type { SurfaceSnapshotLike } from "./session-read.js";
import type { PickKind } from "./messages.js";
import type { RefConfig } from "./command.js";
import type { SessionCandidate } from "./targets.js";

/** 插件名称（loader 用）。 */
export const name = "session-cite";

/** 关键依赖只有命令注册面；其余服务一律运行时探测。 */
export const inject = ["commands"];

/** 硬上限，与 dsh-session-reference 的 MAX_REFERENCES 保持一致。 */
const MAX_REFERENCES_LIMIT = 3;

/** 插件配置（row 的 config 原样传入，由本函数归一化并校验）。 */
export interface SessionCiteConfig {
  /** 命令默认行为：send 直接开新一轮；draft 只回填草稿。 */
  mode: "send" | "draft";
  /** 单次最多引用几个会话，1..3。 */
  maxReferences: number;
  /** 覆盖默认引导语；空串表示用内置默认。 */
  guidance: string;
  /** session_read 单次输出的字节预算。 */
  readBytes: number;
  /** 是否注册 session_read 只读工具；默认关闭，确认命令链路稳定后再开启。 */
  enableReadTool: boolean;
  /** 消息级原文转发的折合字上限；超过且未开 --compact 时报错。 */
  pickMaxChars: number;
  /** ASCII 字符的折合权重：1 等价于按原始字符数判定，0.05 极宽松。 */
  pickAsciiWeight: number;
  /** 消息级读取预算（字节），防止 --pick 上千条去解压大日志。 */
  pickReadBytes: number;
  /** 允许转发的消息类型短名。 */
  pickKinds: readonly PickKind[];
}

/** 默认配置。 */
export const DEFAULT_CONFIG: SessionCiteConfig = {
  mode: "send",
  maxReferences: MAX_REFERENCES_LIMIT,
  guidance: "",
  readBytes: 16384,
  enableReadTool: true,
  pickMaxChars: 4000,
  pickAsciiWeight: DEFAULT_ASCII_WEIGHT,
  pickReadBytes: 262144,
  pickKinds: DEFAULT_PICK_KINDS,
};

/** 最小可用的上下文形状（只声明本插件实际用到的成员）。 */
interface PluginContextLike {
  get?(serviceName: string): unknown;
  effect?(effect: unknown, label?: string): () => void;
  inject?(deps: string[], callback: (scoped: PluginContextLike) => void): unknown;
  logger?: { debug?(message: string): void; info?(message: string): void; warn?(message: string): void };
}

/** 会话引用解析服务的形状（dsh-session-reference 提供）。 */
interface ReferenceResolverLike {
  listCandidates(
    agent: unknown,
    query?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<SessionCandidate[]>;
}

/** 会话查询服务的形状（dsh-session-query 提供）。 */
interface SessionQueryLike {
  readSurface(sessionId: string): Promise<SurfaceSnapshotLike>;
  filterEvents?(sessionId: string, filters: unknown[]): Promise<unknown>;
}

/**
 * 消息级转发与 --list 所需的原始日志读取能力。
 * 两个方法都必须可用：surface 会漏掉被压缩 shadowed 的消息，只有原始日志能覆盖它们。
 */
interface MessageQueryLike {
  listEvents(sessionId: string): Promise<Array<{ seq: number; type: string; time: number }>>;
  readEvent(request: {
    sessionId: string;
    seq: number;
    before?: number;
    after?: number;
  }): Promise<{ target: unknown; events: unknown[] }>;
}

/** 模型调用服务的形状（dsh-llm 提供），只用到流式补全。 */
interface LlmLike {
  stream(options: unknown): AsyncIterable<unknown>;
}

/** 把任意正整数归一化；不合法时取默认值。 */
function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * 归一化 ASCII 折合权重：夹紧到 [MIN_ASCII_WEIGHT, MAX_ASCII_WEIGHT]。
 * 1 表示不折合（回到按原始字符数判定的旧行为）。
 * @param value - 配置原值。
 * @param fallback - 不合法时的默认值。
 * @returns 合法范围内的权重。
 */
function asciiWeightOf(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  if (value < MIN_ASCII_WEIGHT) return MIN_ASCII_WEIGHT;
  if (value > MAX_ASCII_WEIGHT) return MAX_ASCII_WEIGHT;
  return value;
}

/**
 * 归一化并校验插件配置。
 * loader 不持有本插件的 Config schema（零依赖要求），因此校验在此处完成。
 * @param raw - row 的 config 原样值。
 * @returns 补齐默认值并夹紧到合法范围的配置。
 */
export function normalizeConfig(raw: unknown): SessionCiteConfig {
  const input = (raw ?? {}) as Partial<SessionCiteConfig>;
  const mode = input.mode === "draft" ? "draft" : "send";
  const rawMax = positiveInteger(input.maxReferences, DEFAULT_CONFIG.maxReferences);
  const readBytes = positiveInteger(input.readBytes, DEFAULT_CONFIG.readBytes);
  const enableReadTool = input.enableReadTool === true;
  return {
    mode,
    maxReferences: Math.min(rawMax, MAX_REFERENCES_LIMIT),
    guidance: typeof input.guidance === "string" ? input.guidance : DEFAULT_CONFIG.guidance,
    readBytes,
    enableReadTool,
    pickMaxChars: positiveInteger(input.pickMaxChars, DEFAULT_CONFIG.pickMaxChars),
    pickAsciiWeight: asciiWeightOf(input.pickAsciiWeight, DEFAULT_CONFIG.pickAsciiWeight),
    pickReadBytes: positiveInteger(input.pickReadBytes, DEFAULT_CONFIG.pickReadBytes),
    pickKinds: normalizePickKinds(input.pickKinds),
  };
}

/** 取会话引用解析服务；不可用时返回 undefined（命令会给出可诊断错误）。 */
function findReferenceResolver(ctx: PluginContextLike): ReferenceResolverLike | undefined {
  const resolver = ctx.get?.("sessionReferenceResolver") as ReferenceResolverLike | undefined;
  return typeof resolver?.listCandidates === "function" ? resolver : undefined;
}

/** 取会话查询服务；消息级转发需要 listEvents + readEvent 两个能力。 */
function findSessionQuery(ctx: PluginContextLike): MessageQueryLike | undefined {
  const query = ctx.get?.("sessionQuery") as (SessionQueryLike & Partial<MessageQueryLike>) | undefined;
  if (typeof query?.listEvents !== "function" || typeof query?.readEvent !== "function") return undefined;
  return query as MessageQueryLike;
}

/** 取模型调用服务；只有 --compact 摘要才需要。 */
function findLlm(ctx: PluginContextLike): LlmLike | undefined {
  const llm = ctx.get?.("llm") as LlmLike | undefined;
  return typeof llm?.stream === "function" ? llm : undefined;
}

/**
 * 注册 /ref 命令。
 * @param ctx - 插件上下文。
 * @param config - 归一化后的配置。
 * @returns 注销该命令的 disposer。
 */
function registerRefCommand(ctx: PluginContextLike, config: SessionCiteConfig): () => void {
  // 用 ctx.get 而非 ctx.commands：cordis 的注入守卫会拦截未声明服务的属性访问，
  // 而 ctx.get 是显式查询，服务缺失时只返回 undefined，便于降级而非让插件整体失败。
  const commands = ctx.get?.("commands") as { register(definition: unknown): () => void } | undefined;
  if (commands === undefined) {
    ctx.logger?.debug?.("session-cite: 缺少 commands 服务，/ref 命令未注册");
    return () => {};
  }
  const refConfig: RefConfig = {
    mode: config.mode,
    maxReferences: config.maxReferences,
    guidance: config.guidance,
    pickMaxChars: config.pickMaxChars,
    pickAsciiWeight: config.pickAsciiWeight,
    pickReadBytes: config.pickReadBytes,
    pickKinds: config.pickKinds,
  };
  const dispose = commands.register({
    // 不设置 definitionId：本命令没有按身份分支的客户端行为，且品牌函数是值导入。
    name: REF_COMMAND_NAME,
    description: REF_DESCRIPTION,
    input: { hint: REF_INPUT_HINT },
    handler: async (invocation: {
      agent: {
        id: string;
        status: string;
        followup(message: unknown): void;
        options?: { provider?: string; model?: string };
      };
      rawInput: string;
      signal: AbortSignal;
    }) => {
      const resolver = findReferenceResolver(ctx);
      const listCandidates =
        resolver === undefined
          ? undefined
          : (query: string) => resolver.listCandidates(invocation.agent, query, 20);
      return executeRef(
        {
          config: refConfig,
          listCandidates,
          // 消息级转发走原始日志；--compact 摘要另需模型服务。两者缺失时命令给出可诊断错误。
          sessionQuery: findSessionQuery(ctx),
          llm: findLlm(ctx),
        },
        invocation,
      );
    },
  });
  report(ctx, "session-cite: /ref 命令已注册");
  return dispose;
}

/**
 * 装配诊断输出：优先走宿主 logger，缺失时退回 console，便于运维确认注册结果。
 * @param ctx - 插件上下文。
 * @param message - 中文诊断文案。
 */
function report(ctx: PluginContextLike, message: string): void {
  // 装配结果需要可观测：宿主 logger 常按级别过滤，所以同时写一份 stderr。
  ctx.logger?.warn?.(message);
  try {
    const proc = (globalThis as { process?: { stderr?: { write(chunk: string): void } } }).process;
    proc?.stderr?.write(`[${message}]\n`);
  } catch {
    /* 非 Node 宿主没有 process，忽略即可 */
  }
}

/**
 * 注册 session_read 工具。会话查询服务不可用时跳过并留下调试日志。
 * @param ctx - 插件上下文。
 * @param config - 归一化后的配置。
 * @returns 注销该工具的 disposer，跳过时为 no-op。
 */
function registerReadTool(ctx: PluginContextLike, config: SessionCiteConfig): () => void {
  const noop = (): void => {};
  const sessionQuery = ctx.get?.("sessionQuery") as SessionQueryLike | undefined;
  if (sessionQuery === undefined || typeof sessionQuery.readSurface !== "function") {
    ctx.logger?.debug?.("session-cite: ctx.sessionQuery 不可用，session_read 工具未注册");
    return noop;
  }
  const tools = ctx.get?.("tools") as { register(definition: unknown): () => void } | undefined;
  if (tools === undefined) {
    ctx.logger?.debug?.("session-cite: tools 服务不可用，session_read 工具未注册");
    return noop;
  }
  const filterEvents = typeof sessionQuery.filterEvents === "function"
    ? async (sessionId: string, filters: unknown[]) =>
        (await sessionQuery.filterEvents!(sessionId, filters)) as never
    : undefined;
  const dispose = registerSessionRead(
    { tools },
    {
      readBytes: config.readBytes,
      readSurface: (sessionId: string) => sessionQuery.readSurface(sessionId),
      ...(filterEvents === undefined ? {} : { filterEvents }),
    },
  );
  report(ctx, "session-cite: session_read 工具已注册");
  return dispose;
}

/**
 * 注册 /ref 命令与 session_read 工具。
 * @param ctx - 插件上下文。
 * @param rawConfig - row 的 config 原样值。
 */
export function apply(ctx: PluginContextLike, rawConfig?: unknown): void {
  const config = normalizeConfig(rawConfig);

  // 与 dsh-command-guard（本环境已验证可用）保持一致的注册方式：
  // 顶层声明 inject，服务访问一律发生在 ctx.inject 的回调里，且回调内直接
  // 调用 register —— 不额外套 effect（子 fiber 卸载时会自行回收注册）。
  ctx.inject?.(["commands"], (scoped: PluginContextLike) => {
    registerRefCommand(scoped, config);
  });

  // 只读工具默认不注册：工具定义需要与框架的工具面严格一致，先让命令链路
  // 稳定可用，确认无误后再由配置开启，避免工具装配问题拖垮整个会话。
  if (config.enableReadTool) {
    ctx.inject?.(["tools"], (scoped: PluginContextLike) => {
      registerReadTool(scoped, config);
    });
  }

  registerMessageExpansion(ctx, config);
}

/**
 * 注册消息级引用的展开钩子。
 *
 * 草稿里的 dsh-session-message: mention 在提交那一刻才展开成转发内容——
 * 与会话级 reference 的处理思路一致：摘掉 mention 原文，紧跟一条 additionalContext。
 *
 * 失败保护是硬要求：agent/pre-step 抛错会阻塞整轮会话（用户侧表现为消息发不出去），
 * 因此三重兜底：找不到服务放行、展开异常放行、注册失败只告警。
 * @param ctx - 插件上下文。
 * @param config - 归一化后的配置。
 */
function registerMessageExpansion(ctx: PluginContextLike, config: SessionCiteConfig): void {
  const on = (ctx as { on?: (name: string, handler: unknown, options?: unknown) => unknown }).on;
  if (typeof on !== 'function') return;
  const handler = async (event: unknown, next: () => Promise<unknown>) => {
    const decision = await next();
    if (typeof decision !== 'object' || decision === null) return decision;
    const record = decision as { kind?: unknown; messages?: unknown };
    if (record.kind === 'reject') return decision;
    if (!Array.isArray(record.messages)) return decision;
    const sessionQuery = findSessionQuery(ctx);
    if (sessionQuery === undefined) return decision;
    const signal = (event as { signal?: AbortSignal } | null)?.signal;
    try {
      return {
        ...record,
        messages: await expandMessageReferences(
          {
            sessionQuery,
            pickKinds: config.pickKinds,
            pickReadBytes: config.pickReadBytes,
            pickAsciiWeight: config.pickAsciiWeight,
            guidance: config.guidance,
          },
          record.messages,
          signal ?? new AbortController().signal,
        ),
      };
    } catch {
      // 展开失败绝不能影响本轮：原样放行，模型只是少一段背景。
      return decision;
    }
  };
  try {
    on.call(ctx, 'agent/pre-step', handler, { prepend: true });
  } catch {
    // 监听注册失败不影响命令与草稿链路。
  }
}

export default apply;
