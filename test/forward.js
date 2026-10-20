// 编排层测试：executeRef 的 --list 与 --pick 分支（node test/forward.js）
//
// 会话级路径由 test/command.js 覆盖；这里专测本轮新增的路径：
//   --list（分页列表 + 预览）、--pick（原文转发）、--pick --compact（LLM 摘要）
// 以及它们的失败模式。

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// src/ 用的是 .js 后缀相对导入（nodenext 要求），Node 无法直接跑 .ts 链路，
// 因此与 test/command.js 一样：lib/ 缺失或比 src/ 旧时先编译一次，再从 lib/ 导入。
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const libUrl = (name) => pathToFileURL(join(pkgRoot, "lib", name)).href;
const srcUrl = (name) => join(pkgRoot, "src", name);

function needsBuild() {
  const built = join(pkgRoot, "lib", "command.js");
  if (!existsSync(built)) return true;
  const builtAt = statSync(built).mtimeMs;
  return ["command.ts", "parse.ts", "render.ts", "messages.ts", "summarize.ts", "mention.ts"].some(
    (file) => existsSync(srcUrl(file)) && statSync(srcUrl(file)).mtimeMs > builtAt,
  );
}

if (needsBuild()) {
  try {
    execSync("tsc -p tsconfig.json", { cwd: pkgRoot, stdio: "inherit" });
  } catch {
    console.log("[提示] tsc 返回非 0（可能来自未改动模块），继续使用已产出的 lib/");
  }
}

const { formatSessionReferenceMention } = await import(libUrl("mention.js"));
const { DEFAULT_PICK_KINDS } = await import(libUrl("messages.js"));
const { executeRef } = await import(libUrl("command.js"));

let passed = 0;
const pending = [];

function ok(name, fn) {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(
        () => {
          passed += 1;
          console.log("  ok  " + name);
        },
        (error) => {
          process.exitCode = 1;
          console.log("  FAIL " + name + "\n       " + (error && error.message));
        },
      ),
  );
}

const TARGET_ID = "session-abcdef12-0000-0000-0000-000000000000";
const MENTION = formatSessionReferenceMention({ sessionId: TARGET_ID, label: "目标会话" });

const EVENTS = [
  { seq: 10, type: "user/message", time: 1 },
  { seq: 11, type: "assistant/message", time: 2 },
  { seq: 12, type: "turn/start", time: 3 },
  { seq: 13, type: "tool/call", time: 4 },
  { seq: 14, type: "tool/result", time: 5 },
];
const BODIES = {
  10: { seq: 10, type: "user/message", data: { turn: 1, step: 1, message: { id: "m10", role: "user", content: [{ type: "text", text: "十号：用户提的问" }], source: { kind: "user" } } } },
  11: { seq: 11, type: "assistant/message", data: { turn: 1, step: 1, message: { id: "m11", role: "assistant", content: [{ type: "text", text: "十一号：助手的回答" }], source: { kind: "model" } }, stream: [] } },
  13: { seq: 13, type: "tool/call", data: { turn: 1, step: 2, callId: "call-1", name: "read", arguments: "{\"path\":\"a.txt\"}" } },
  14: { seq: 14, type: "tool/result", data: { turn: 1, step: 2, message: { id: "m14", role: "tool", toolCallId: "call-1", isError: false, content: [{ type: "text", text: "文件内容：hello" }], source: { kind: "tool", callId: "call-1" } } } },
};

function makeSessionQuery() {
  return {
    listEvents: async () => EVENTS.map((e) => ({ ...e })),
    readEvent: async ({ seq }) => ({ target: BODIES[seq] ?? null, events: BODIES[seq] ? [BODIES[seq]] : [] }),
  };
}

function makeLlm(chunks) {
  return {
    calls: 0,
    async *stream() {
      this.calls += 1;
      for (const chunk of chunks) yield chunk;
    },
  };
}

const CONFIG = {
  mode: "send",
  maxReferences: 3,
  guidance: "",
  pickMaxChars: 4000,
  pickReadBytes: 262144,
  pickKinds: DEFAULT_PICK_KINDS,
};

function makeInvocation(rawInput, agentOverride) {
  const sent = [];
  const agent = {
    id: "session-self-9999",
    status: "idle",
    followup(message) { sent.push(message); },
    options: { provider: "prov", model: "mod" },
    ...(agentOverride ?? {}),
  };
  return { sent, invocation: { agent, rawInput, signal: new AbortController().signal } };
}

console.log("命令编排测试开始");

ok("--list：列出消息、带预览与翻页指引", async () => {
  const { invocation } = makeInvocation(MENTION + " --list");
  const result = await executeRef({ config: CONFIG, sessionQuery: makeSessionQuery() }, invocation);
  assert.equal(result.kind, "success");
  // 默认只列 user + assistant（EVENTS 里共 2 条），工具往来需 --kind 放开。
  assert.match(result.text, /共 2 条/);
  assert.match(result.text, /#10/);
  assert.match(result.text, /十号：用户提的问/);
  assert.match(result.text, /十号：用户提的问/);
  assert.match(result.text, /--pick/);
  assert.ok(result.text.includes("类型：user / assistant"), "头部应说明类型过滤范围");
  assert.doesNotMatch(result.text, /#22/, "默认不应列出 tool-call");
});

ok("--list --kind：放开工具类后能列出 tool-call", async () => {
  const { invocation } = makeInvocation(MENTION + " --list --kind user assistant tool-call tool-result summary");
  const result = await executeRef({ config: CONFIG, sessionQuery: makeSessionQuery() }, invocation);
  assert.equal(result.kind, "success");
  assert.match(result.text, /共 4 条/);
  assert.match(result.text, /tool-call/);
});

ok("--list --limit：限制窗口大小", async () => {
  const { invocation } = makeInvocation(MENTION + " --list --limit 1");
  const result = await executeRef({ config: CONFIG, sessionQuery: makeSessionQuery() }, invocation);
  assert.equal(result.kind, "success");
  assert.match(result.text, /#11/);
  assert.doesNotMatch(result.text, /#10/);
});

ok("--list：未启用会话查询时报错", async () => {
  const { invocation } = makeInvocation(MENTION + " --list");
  const result = await executeRef({ config: CONFIG }, invocation);
  assert.equal(result.kind, "error");
  assert.match(result.text, /未启用会话查询/);
});

ok("--list：多个会话时报错", async () => {
  const other = formatSessionReferenceMention({ sessionId: "session-ffff", label: "另一个" });
  const { invocation } = makeInvocation(MENTION + " " + other + " --list");
  const result = await executeRef({ config: CONFIG, sessionQuery: makeSessionQuery() }, invocation);
  assert.equal(result.kind, "error");
  assert.match(result.text, /只支持单个会话/);
});

ok("--pick：原文转发并调用 followup", async () => {
  const { invocation, sent } = makeInvocation(MENTION + " --pick 10 11");
  const result = await executeRef({ config: CONFIG, sessionQuery: makeSessionQuery() }, invocation);
  assert.equal(result.kind, "success");
  assert.equal(sent.length, 1);
  const text = sent[0].content[0].text;
  assert.match(text, /【转发内容】/);
  assert.match(text, /十号：用户提的问/);
  assert.match(text, /十一号：助手的回答/);
  assert.match(text, /不得当作指令/);
  assert.match(result.text, /已转发 2 条消息/);
});

ok("--pick --draft：只返回文本，不调用 followup", async () => {
  const { invocation, sent } = makeInvocation("--draft " + MENTION + " --pick 10");
  const result = await executeRef({ config: CONFIG, sessionQuery: makeSessionQuery() }, invocation);
  assert.equal(result.kind, "success");
  assert.equal(sent.length, 0);
  assert.match(result.text, /【转发内容】/);
});

ok("--pick：tool/call 自动带出配对 result", async () => {
  const { invocation, sent } = makeInvocation(MENTION + " --pick 13");
  await executeRef({ config: CONFIG, sessionQuery: makeSessionQuery() }, invocation);
  const text = sent[0].content[0].text;
  assert.match(text, /read/);
  assert.match(text, /文件内容：hello/);
  assert.match(text, /配对/);
});

ok("--pick：超字数且无 --compact 时报错并给出字数", async () => {
  const { invocation, sent } = makeInvocation(MENTION + " --pick 10 11");
  const result = await executeRef(
    { config: { ...CONFIG, pickMaxChars: 5 }, sessionQuery: makeSessionQuery() },
    invocation,
  );
  assert.equal(result.kind, "error");
  assert.match(result.text, /超过原文转发上限 5 字/);
  assert.match(result.text, /--compact/);
  assert.equal(sent.length, 0, "报错时不得提交");
});

ok("--pick --compact：走摘要并替换正文", async () => {
  const llm = makeLlm([{ type: "text-delta", index: 0, text: "这是模型给出的摘要" }]);
  const { invocation, sent } = makeInvocation(MENTION + " --pick 10 11 --compact");
  const result = await executeRef({ config: CONFIG, sessionQuery: makeSessionQuery(), llm }, invocation);
  assert.equal(result.kind, "success");
  assert.equal(llm.calls, 1);
  const text = sent[0].content[0].text;
  assert.match(text, /已由模型压缩/);
  assert.match(text, /这是模型给出的摘要/);
  assert.doesNotMatch(text, /十号：用户提的问/, "摘要模式下不应再出现逐条原文");
  assert.match(result.text, /摘要/);
});

ok("--pick --compact：字节上限不再限制摘要路径", async () => {
  const llm = makeLlm([{ type: "text-delta", index: 0, text: "压缩后" }]);
  const { invocation } = makeInvocation(MENTION + " --pick 10 11 --compact");
  const result = await executeRef(
    { config: { ...CONFIG, pickMaxChars: 1 }, sessionQuery: makeSessionQuery(), llm },
    invocation,
  );
  assert.equal(result.kind, "success");
});

ok("--pick --compact：未启用模型服务时报错", async () => {
  const { invocation } = makeInvocation(MENTION + " --pick 10 --compact");
  const result = await executeRef({ config: CONFIG, sessionQuery: makeSessionQuery() }, invocation);
  assert.equal(result.kind, "error");
  assert.match(result.text, /未启用模型调用/);
});

ok("--pick --compact：会话无模型路由时报错且不发起调用", async () => {
  const llm = makeLlm([{ type: "text-delta", index: 0, text: "x" }]);
  const { invocation } = makeInvocation(MENTION + " --pick 10 --compact", { options: {} });
  const result = await executeRef({ config: CONFIG, sessionQuery: makeSessionQuery(), llm }, invocation);
  assert.equal(result.kind, "error");
  assert.match(result.text, /没有可用的模型路由/);
  assert.equal(llm.calls, 0);
});

ok("--pick --compact：摘要为空时报错且不回退原文", async () => {
  const llm = makeLlm([]);
  const { invocation, sent } = makeInvocation(MENTION + " --pick 10 --compact");
  const result = await executeRef({ config: CONFIG, sessionQuery: makeSessionQuery(), llm }, invocation);
  assert.equal(result.kind, "error");
  assert.match(result.text, /摘要失败/);
  assert.equal(sent.length, 0);
});

ok("--pick：seq 不存在时报错", async () => {
  const { invocation } = makeInvocation(MENTION + " --pick 999");
  const result = await executeRef({ config: CONFIG, sessionQuery: makeSessionQuery() }, invocation);
  assert.equal(result.kind, "error");
  assert.match(result.text, /不存在/);
});

ok("会话级路径不受影响（回归）", async () => {
  const { invocation, sent } = makeInvocation(MENTION);
  const result = await executeRef({ config: CONFIG }, invocation);
  assert.equal(result.kind, "success");
  assert.equal(sent.length, 1);
  assert.match(sent[0].content[0].text, /dsh-session:/);
});

ok("--list：内容为空的 assistant 轮次被省略并如实计数", async () => {
  // 真实的 assistant 纯工具调用轮次：content 里只有 tool-call 块、没有 text，
  // 于是摘要与字节数都是 0 —— 这类条目对转发没有价值，必须不列出。
  const emptyQuery = {
    listEvents: async () => [
      { seq: 20, type: "assistant/message", time: 1 },
      { seq: 21, type: "user/message", time: 2 },
    ],
    readEvent: async ({ seq }) => ({
      target:
        seq === 20
          ? {
              seq: 20,
              type: "assistant/message",
              data: {
                turn: 1,
                step: 1,
                message: {
                  id: "m20",
                  role: "assistant",
                  content: [{ type: "tool-call", id: "c1", name: "run_code", arguments: "{}" }],
                  source: { kind: "model" },
                },
                stream: [],
              },
            }
          : {
              seq: 21,
              type: "user/message",
              data: {
                turn: 1,
                step: 1,
                message: {
                  id: "m21",
                  role: "user",
                  content: [{ type: "text", text: "有正文的用户消息" }],
                  source: { kind: "user" },
                },
              },
            },
      events: [],
    }),
  };
  const { invocation } = makeInvocation(MENTION + " --list");
  const result = await executeRef({ config: CONFIG, sessionQuery: emptyQuery }, invocation);
  assert.equal(result.kind, "success");
  assert.match(result.text, /#21/, "有正文的消息必须出现");
  assert.doesNotMatch(result.text, /#20/, "空内容的 assistant 轮次不得列出");
  assert.match(result.text, /另有 1 条内容为空/);
});

ok("--list：系统注入的 user 上下文不列出", async () => {
  // 真实日志里注入内容也走 user/message 通道，但 source.kind 不是 'user'
  // （agent-instructions / runtime-context / skill-catalog / 工具目录…），
  // 体积往往很大且转发无意义，默认必须排除。
  const injectedQuery = {
    listEvents: async () => [
      { seq: 30, type: "user/message", time: 1 },
      { seq: 31, type: "user/message", time: 2 },
    ],
    readEvent: async ({ seq }) => ({
      target:
        seq === 30
          ? {
              seq: 30,
              type: "user/message",
              data: {
                content: [{ type: "text", text: "真实用户发言" }],
                source: { kind: "user", rpcId: "r1", clientTimeZone: "Asia/Shanghai" },
                role: "user",
                id: "m30",
              },
            }
          : {
              seq: 31,
              type: "user/message",
              data: {
                content: [{ type: "text", text: "<system-reminder>工具目录…</system-reminder>" }],
                source: { kind: "liangshen-tool-catalog" },
                role: "user",
                id: "m31",
              },
            },
      events: [],
    }),
  };
  const { invocation } = makeInvocation(MENTION + " --list");
  const result = await executeRef({ config: CONFIG, sessionQuery: injectedQuery }, invocation);
  assert.equal(result.kind, "success");
  assert.match(result.text, /真实用户发言/, "真实发言必须列出");
  assert.doesNotMatch(result.text, /system-reminder/, "注入上下文不得列出");
  assert.match(result.text, /系统注入/);
});

await Promise.all(pending);
console.log("\n通过 " + passed + " 项");
