// 按轮次取消息：边界查找与类型完整性（node test/turn-messages.js）

import assert from "node:assert/strict";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("  ok   " + name);
  } catch (error) {
    failed += 1;
    process.exitCode = 1;
    console.log("  FAIL " + name + "\n       " + (error && error.message));
  }
}

const { readTurnMessages, resetEventCache } = await import("../lib/turn-messages.js");

const SID = "session-2fad253d-e516-45af-afd7-a4d9d85c842b";

/** 两个 turn 的完整事件表：第 1 轮含一次工具调用。 */
const EVENTS = [
  { seq: 1, type: "turn/start", data: { turn: 1 } },
  { seq: 2, type: "user/message", data: { content: [{ type: "text", text: "第一个问题" }], source: { kind: "user" }, role: "user", id: "u1" } },
  { seq: 3, type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "run_code", arguments: "{\"description\":\"探测环境\"}" } },
  { seq: 4, type: "tool/result", data: { turn: 1, step: 1, message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "结果输出" }] } } },
  { seq: 5, type: "assistant/message", data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "第一个回答" }] } } },
  { seq: 6, type: "turn/end", data: { turn: 1 } },
  { seq: 7, type: "turn/start", data: { turn: 2 } },
  { seq: 8, type: "user/message", data: { content: [{ type: "text", text: "第二个问题" }], source: { kind: "user" }, role: "user", id: "u2" } },
  { seq: 9, type: "turn/end", data: { turn: 2 } },
];

/** 造一个只读会话查询；readEvent 模拟「窗口读取」，可统计读取次数。 */
function makeQuery(events, counter) {
  return {
    async listEvents() {
      return events.map((event) => ({ seq: event.seq, type: event.type, time: 0 }));
    },
    async readEvent({ seq, before, after }) {
      if (counter !== undefined) counter.reads += 1;
      const from = typeof before === "number" ? Math.max(0, seq - before) : seq;
      const to = typeof after === "number" ? seq + after : seq;
      return {
        target: events.find((event) => event.seq === seq) ?? null,
        events: events.filter((event) => event.seq >= from && event.seq <= to),
      };
    },
  };
}

const OPTIONS = { kinds: ["user", "assistant", "tool-call", "tool-result", "summary"], readBytes: 262144, asciiWeight: 0.25 };

await check("readTurnMessages：配对的工具调用合并成一行 tool", async () => {
  const result = await readTurnMessages(makeQuery(EVENTS), SID, 1, OPTIONS);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.deepEqual(
    result.rows.map((row) => row.seq + ":" + row.kind),
    ["2:user", "3:tool", "5:assistant"],
    "call 与 result 必须合并成以 call 的 seq 为标识的一行",
  );
  const tool = result.rows.find((row) => row.kind === "tool");
  assert.ok(tool.text.includes("探测环境"), "正文要含参数");
  assert.ok(tool.text.includes("结果输出"), "正文要含结果");
});

await check("readTurnMessages：不越界到下一轮", async () => {
  const result = await readTurnMessages(makeQuery(EVENTS), SID, 1, OPTIONS);
  assert.ok(result.ok);
  assert.ok(result.rows.every((row) => row.seq <= 6), "第 2 轮的 seq 不得混进来");
  const second = await readTurnMessages(makeQuery(EVENTS), SID, 2, OPTIONS);
  assert.ok(second.ok);
  assert.deepEqual(second.rows.map((row) => row.seq), [8]);
});

await check("readTurnMessages：返回该轮的起止 seq", async () => {
  const result = await readTurnMessages(makeQuery(EVENTS), SID, 1, OPTIONS);
  assert.ok(result.ok);
  assert.equal(result.startSeq, 1);
  assert.equal(result.endSeq, 6);
});

await check("readTurnMessages：轮次尚未结束时明确报错", async () => {
  const result = await readTurnMessages(makeQuery(EVENTS), SID, 3, OPTIONS);
  assert.equal(result.ok, false);
  assert.match(result.error, /找不到该轮次的起点/);
});

await check("readTurnMessages：只有 start 没有 end 时报告未结束", async () => {
  const open = EVENTS.filter((event) => !(event.type === "turn/end" && event.data.turn === 2));
  const result = await readTurnMessages(makeQuery(open), SID, 2, OPTIONS);
  assert.equal(result.ok, false);
  assert.match(result.error, /尚未结束/);
});

await check("readTurnMessages：入参校验", async () => {
  assert.equal((await readTurnMessages(makeQuery(EVENTS), "", 1, OPTIONS)).ok, false);
  assert.equal((await readTurnMessages(makeQuery(EVENTS), SID, -1, OPTIONS)).ok, false);
  assert.equal((await readTurnMessages(makeQuery(EVENTS), SID, Number.NaN, OPTIONS)).ok, false);
});

await check("readTurnMessages：边界查找会提前停止，不扫完整段日志", async () => {
  // 造 60 轮，只取第 1 轮：读 turn 事件的次数应远小于 60。
  const many = [];
  let seq = 1;
  for (let turn = 1; turn <= 60; turn += 1) {
    many.push({ seq: seq++, type: "turn/start", data: { turn } });
    many.push({ seq: seq++, type: "user/message", data: { content: [{ type: "text", text: "问题 " + turn }], source: { kind: "user" }, role: "user", id: "u" + turn } });
    many.push({ seq: seq++, type: "turn/end", data: { turn } });
  }
  const counter = { reads: 0 };
  const result = await readTurnMessages(makeQuery(many, counter), SID, 1, OPTIONS);
  assert.ok(result.ok);
  assert.ok(counter.reads <= 8, "第 1 轮的边界查找不该读几十个事件，实际读了 " + counter.reads);
});

await check("readTurnMessages：listEvents 抛错时降级为错误而不是崩溃", async () => {
  const broken = {
    async listEvents() {
      throw new Error("模拟读取失败");
    },
    async readEvent() {
      throw new Error("不该被调用");
    },
  };
  const result = await readTurnMessages(broken, SID, 1, OPTIONS);
  assert.equal(result.ok, false);
  assert.match(result.error, /无法列出会话事件/);
});

// ---------------- 边界提示与预读 ----------------

await check("readTurnMessages：给了边界提示就不再查 turn 事件", async () => {
  // 事件表里故意没有 turn/start，若还去查边界就会报错。
  const noBoundaries = EVENTS.filter((event) => event.type !== "turn/start" && event.type !== "turn/end");
  const counter = { reads: 0 };
  const result = await readTurnMessages(makeQuery(noBoundaries, counter), SID, 1, OPTIONS, { from: 1, to: 6 });
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.deepEqual(result.rows.map((row) => row.seq), [2, 3, 5]);
});

await check("readTurnMessages：预读每条只读一次，readMessages 全部命中缓存", async () => {
  // 事件缓存跨请求生效，先清掉，保证计数只反映本次调用。
  resetEventCache();
  const counter = { reads: 0 };
  const result = await readTurnMessages(makeQuery(EVENTS, counter), SID, 1, OPTIONS, { from: 1, to: 6 });
  assert.ok(result.ok);
  // 4 条消息 → 预读 4 次；readMessages 用缓存，不该再产生读取。
  // （加速来自并发而不是次数减少，所以这里断言的是「没有重复读」。）
  assert.equal(counter.reads, 4, "实际读事件次数 " + counter.reads);
});

await check("readTurnMessages：边界倒置时明确报错", async () => {
  const result = await readTurnMessages(makeQuery(EVENTS), SID, 1, OPTIONS, { from: 6, to: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /边界不合法/);
});

// ---------------- 合并规则 ----------------

const { mergeToolRows } = await import("../lib/turn-messages.js");

await check("mergeToolRows：成对合并，seq 用调用侧，正文拼接", () => {
  const rows = [
    { seq: 3, kind: "tool-call", text: "工具 X 参数", summary: "工具 X" },
    { seq: 4, kind: "tool-result", text: "结果 Y", summary: "结果摘要" },
  ];
  const merged = mergeToolRows(rows);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].seq, 3, "seq 取调用侧");
  assert.equal(merged[0].kind, "tool");
  assert.ok(merged[0].text.includes("参数"));
  assert.ok(merged[0].text.includes("结果 Y"));
  assert.equal(merged[0].summary, "工具 X", "摘要优先用调用侧");
});

await check("mergeToolRows：孤立调用与孤立结果都保留为 tool", () => {
  const orphanCall = mergeToolRows([{ seq: 1, kind: "tool-call", text: "只有调用", summary: "" }]);
  assert.equal(orphanCall.length, 1);
  assert.equal(orphanCall[0].kind, "tool");
  const orphanResult = mergeToolRows([{ seq: 2, kind: "tool-result", text: "只有结果", summary: "" }]);
  assert.equal(orphanResult.length, 1);
  assert.equal(orphanResult[0].kind, "tool");
});

await check("mergeToolRows：不相邻的调用与结果不合并", () => {
  const merged = mergeToolRows([
    { seq: 1, kind: "tool-call", text: "调用", summary: "" },
    { seq: 2, kind: "assistant", text: "中间有回答", summary: "" },
    { seq: 3, kind: "tool-result", text: "结果", summary: "" },
  ]);
  assert.equal(merged.length, 3, "中间隔着别的消息就不合并");
});

await check("mergeToolRows：非工具类型原样通过", () => {
  const rows = [
    { seq: 1, kind: "user", text: "问题", summary: "问题" },
    { seq: 2, kind: "assistant", text: "回答", summary: "回答" },
  ];
  assert.deepEqual(mergeToolRows(rows), rows);
});

await check("readTurnMessages：正文为空的消息被跳过并计数", async () => {
  resetEventCache();
  // 第二条 assistant 只有 tool-call 块、没有 text 块——正是纯工具轮次的样子。
  const events = [
    { seq: 1, type: "turn/start", data: { turn: 1 } },
    { seq: 2, type: "assistant/message", data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "有正文" }] } } },
    { seq: 3, type: "assistant/message", data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "tool-call", callId: "c1", name: "x" }] } } },
    { seq: 4, type: "turn/end", data: { turn: 1 } },
  ];
  const result = await readTurnMessages(makeQuery(events), SID, 1, OPTIONS);
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.deepEqual(result.rows.map((row) => row.seq), [2], "只有带正文的那条留下");
  assert.deepEqual(result.rows.map((row) => row.kind), ["assistant"]);
  assert.equal(result.skipped, 1, "空正文要计入 skipped，而不是静默消失");
});

console.log("");
console.log("通过 " + passed + " 项，失败 " + failed + " 项");
if (failed > 0) process.exitCode = 1;
