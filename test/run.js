// 测试汇总入口：node test/run.js
//
// 汇总三部分：
//   1. test/command.js  —— /ref 命令链路（参数解析、会话解析、mention 契约回环、消息提交）
//   2. test/tool.js     —— session_read 工具链路（尾部窗口、关键字命中、降级、截断）
//   3. 装配级测试       —— 用真实 lib/index.js 装配假 ctx，核对注册面；未编译时跳过
//
// 任一用例失败时 process.exitCode 会被置为 1，本文件按最终退出码汇总。

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

async function runUnit(file, label) {
  if (!existsSync(join(here, file))) {
    console.log(`[跳过] ${label}：找不到 test/${file}`);
    return;
  }
  const before = process.exitCode ?? 0;
  try {
    await import(`./${file}`);
  } catch (error) {
    console.error(`[失败] ${label} 抛出异常：`, error);
    process.exitCode = 1;
  }
  if ((process.exitCode ?? 0) !== 0 && before === 0) {
    console.log(`[失败] ${label} 存在未通过用例`);
  }
}

async function runAssembly() {
  const libPath = join(here, "..", "lib", "index.js");
  if (!existsSync(libPath)) {
    console.log("[跳过] 装配级测试：lib/index.js 尚未编译（先执行 npm run build）");
    return;
  }
  const plugin = await import(`file:///${libPath.replace(/\\/g, "/")}`);

  const registered = { commands: [], tools: [] };
  const fakeCtx = {
    commands: { register: (def) => { registered.commands.push(def); return () => {}; } },
    tools: { register: (def) => { registered.tools.push(def); return () => {}; } },
    get: (serviceName) => {
      // 真实 cordis 通过服务查询取到这两个服务；插件以此替代属性访问。
      if (serviceName === "commands") return fakeCtx.commands;
      if (serviceName === "tools") return fakeCtx.tools;
      if (serviceName === "sessionReferenceResolver") {
        return { listCandidates: async () => [{ sessionId: "sess-x", label: "示例会话", displayTitle: "示例会话" }] };
      }
      if (serviceName === "sessionQuery") {
        return {
          readSurface: async () => ({ session: {}, capturedThroughSeq: 3, events: [] }),
          filterEvents: async () => [],
        };
      }
      return undefined;
    },
    effect: (factory) => {
      const disposer = typeof factory === "function" ? factory() : undefined;
      return typeof disposer === "function" ? disposer : () => {};
    },
    // 真实 cordis 的 inject 在所需服务就绪后执行回调；测试桩里该 ctx 已备好
    // tools 与 sessionQuery，因此立即执行一次以覆盖延迟注册路径。
    inject: (_deps, callback) => {
      callback(fakeCtx);
      return undefined;
    },
    logger: { debug: () => {} },
  };

  plugin.apply(fakeCtx, { mode: "draft", maxReferences: 2, readBytes: 2048, enableReadTool: true });
  if (registered.commands.length !== 1) throw new Error(`装配失败：命令注册数应为 1，实际 ${registered.commands.length}`);
  const command = registered.commands[0];
  if (command.name !== "ref") throw new Error(`装配失败：命令名应为 ref，实际 ${command.name}`);
  if (command.input?.hint?.length === 0) throw new Error("装配失败：命令应声明 input.hint");
  if (registered.tools.length !== 1) throw new Error(`装配失败：工具注册数应为 1，实际 ${registered.tools.length}`);
  if (registered.tools[0].name !== "session_read") throw new Error(`装配失败：工具名应为 session_read，实际 ${registered.tools[0].name}`);

  // 配置归一化：maxReferences 必须被夹紧到 3
  const normalized = plugin.normalizeConfig({ maxReferences: 99, readBytes: -1, mode: "乱写" });
  if (normalized.maxReferences !== 3) throw new Error(`配置归一化失败：maxReferences 应夹紧到 3，实际 ${normalized.maxReferences}`);
  if (normalized.readBytes !== 16384) throw new Error(`配置归一化失败：非法 readBytes 应回落到 16384，实际 ${normalized.readBytes}`);
  if (normalized.mode !== "send") throw new Error(`配置归一化失败：非法 mode 应回落到 send，实际 ${normalized.mode}`);

  // 缺依赖时的降级：没有 sessionQuery 时不注册工具、不抛错
  const degradedTools = [];
  plugin.apply(
    { ...fakeCtx, get: () => undefined, tools: { register: (def) => { degradedTools.push(def); return () => {}; } } },
    {},
  );
  if (degradedTools.length !== 0) throw new Error("降级失败：缺少 sessionQuery 时不应注册 session_read");

  console.log("[通过] 装配级测试：命令/工具注册、配置夹紧、缺依赖降级");
}

await runUnit("command.js", "命令链路单元与契约测试");
await runUnit("tool.js", "session_read 工具测试");
await runUnit("client.js", "客户端 chip 回填测试");
await runUnit("messages.js", "消息取数与摘要测试");
await runUnit("parse.js", "参数解析与渲染测试");
await runUnit("forward.js", "命令编排：--list 与 --pick 分支");
await runUnit("pre-step.js", "消息级引用：编解码与 agent/pre-step 展开");
await runUnit("forward-panel.js", "转发面板：跨端一致性、选择态与队列");
try {
  await runAssembly();
} catch (error) {
  console.error("[失败] 装配级测试：", error.message);
  process.exitCode = 1;
}

if ((process.exitCode ?? 0) === 0) console.log("\n[全部通过] test/run.js");
