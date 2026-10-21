// 消息级引用：编解码 + agent/pre-step 展开（node test/pre-step.js）

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

const {
  MESSAGE_REFERENCE_SCHEME,
  decodeMessageReferenceUri,
  encodeMessageReferenceUri,
  formatMessageReferenceMention,
  parseMessageReferenceText,
} = await import("../lib/message-reference.js");
const { expandMessageReferences } = await import("../lib/pre-step.js");

const SID = "session-2ad9569d-f867-4ee8-be64-b1b375a6bea0";

function mention(seq, label) {
  return formatMessageReferenceMention({ sessionId: SID, seq, label });
}

// ---------------- 1. 编解码 ----------------

await check("编解码往返：{sessionId, seq} 保持不变", async () => {
  const uri = encodeMessageReferenceUri({ sessionId: SID, seq: 9 });
  assert.ok(uri.startsWith(MESSAGE_REFERENCE_SCHEME));
  assert.deepEqual(decodeMessageReferenceUri(uri), { sessionId: SID, seq: 9 });
  assert.equal(encodeMessageReferenceUri(decodeMessageReferenceUri(uri)), uri, "必须规范");
});

await check("解码：非法前缀或非规范载荷一律抛错", async () => {
  assert.throws(() => decodeMessageReferenceUri("dsh-session:abc"), /不是合法的消息引用/);
  assert.throws(() => decodeMessageReferenceUri(MESSAGE_REFERENCE_SCHEME + "!!!"), /不是合法的消息引用/);
  assert.throws(() => decodeMessageReferenceUri(MESSAGE_REFERENCE_SCHEME), /不是合法的消息引用/);
});

await check("解析：摘掉 mention 改写成 @标签，其余文本保留", async () => {
  const text = "看这两条 " + mention(9, "#9 user") + " 和 " + mention(136, "#136 user") + " 谢谢";
  const parsed = parseMessageReferenceText(text);
  assert.equal(parsed.references.length, 2);
  assert.deepEqual(
    parsed.references.map((r) => ({ sessionId: r.sessionId, seq: r.seq, label: r.label })),
    [
      { sessionId: SID, seq: 9, label: "#9 user" },
      { sessionId: SID, seq: 136, label: "#136 user" },
    ],
  );
  assert.match(parsed.text, /看这两条 @#9 user 和 @#136 user 谢谢/);
  assert.doesNotMatch(parsed.text, /dsh-session-message:/);
});

await check("解析：非法载荷不抛错，原文保留（pre-step 上绝不能炸）", async () => {
  const broken = "@[#9 user](dsh-session-message:!!!notbase64)";
  const parsed = parseMessageReferenceText(broken);
  assert.equal(parsed.references.length, 0);
  assert.equal(parsed.text, broken, "非法引用原样保留");
});

// ---------------- 2. pre-step 展开 ----------------

const BODIES = {
  9: { type: "user/message", data: { content: [{ type: "text", text: "用户的问题原文" }], source: { kind: "user" }, role: "user", id: "m9" } },
  10: { type: "assistant/message", data: { turn: 1, step: 1, message: { id: "m10", role: "assistant", content: [{ type: "text", text: "助手的回答" }], source: { kind: "model" } }, stream: [] } },
};

function makeDeps(override) {
  const base = {
    sessionQuery: {
      listEvents: async () => Object.keys(BODIES).map((seq) => ({ seq: Number(seq), type: BODIES[seq].type, time: 0 })),
      readEvent: async ({ seq }) => ({ target: BODIES[seq] ? { seq: Number(seq), ...BODIES[seq] } : null, events: [] }),
    },
    pickKinds: ["user", "assistant"],
    pickReadBytes: 65536,
    pickAsciiWeight: 0.25,
    guidance: "",
  };
  return { ...base, ...(override ?? {}), sessionQuery: { ...base.sessionQuery, ...(override?.sessionQuery ?? {}) } };
}

const SIGNAL = new AbortController().signal;

function userMessage(text) {
  return { id: "m1", role: "user", source: { kind: "user" }, content: [{ type: "text", text }] };
}

await check("展开：mention 被摘掉，并追加一条转发内容消息", async () => {
  const input = userMessage("背景：" + mention(9, "#9 user") + " 请据此回答");
  const out = await expandMessageReferences(makeDeps(), [input], SIGNAL);
  assert.equal(out.length, 2, "应变成 direct + additionalContext 两条");
  assert.equal(out[0].content[0].text, "背景：@#9 user 请据此回答");
  assert.equal(out[1].source.kind, "user");
  assert.match(out[1].content[0].text, /【转发内容】/);
  assert.match(out[1].content[0].text, /用户的问题原文/);
});

await check("展开：没有 mention 的消息原样通过（同一个对象）", async () => {
  const input = userMessage("普通消息，没有任何引用");
  const out = await expandMessageReferences(makeDeps(), [input], SIGNAL);
  assert.equal(out.length, 1);
  assert.equal(out[0], input);
});

await check("展开：非 user 来源的消息一律不处理", async () => {
  const assistantMessage = { id: "m2", role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: mention(9, "#9 user") }] };
  const out = await expandMessageReferences(makeDeps(), [assistantMessage], SIGNAL);
  assert.equal(out.length, 1);
  assert.equal(out[0], assistantMessage);
});

await check("展开：读取失败时原样放行，绝不抛错", async () => {
  const deps = makeDeps({
    sessionQuery: { readEvent: async () => { throw new Error("模拟读取失败"); } },
  });
  const input = userMessage(mention(9, "#9 user"));
  const out = await expandMessageReferences(deps, [input], SIGNAL);
  assert.equal(out.length, 1, "读不到内容时只保留原消息");
  assert.equal(out[0].content[0].text, "@#9 user", "mention 仍被摘掉，模型不会看到裸 URI");
});

await check("展开：同一会话的多条引用合并成一条转发块", async () => {
  const text = mention(9, "#9 user") + " " + mention(10, "#10 assistant");
  const input = userMessage(text);
  const out = await expandMessageReferences(makeDeps(), [input], SIGNAL);
  assert.equal(out.length, 2, "同会话合并，只追加一条");
  assert.match(out[1].content[0].text, /#9/);
  assert.match(out[1].content[0].text, /#10/);
});

await check("展开：损坏的引用不影响其它消息", async () => {
  const broken = userMessage("@[x](dsh-session-message:!!!)");
  const good = userMessage(mention(9, "#9 user"));
  const out = await expandMessageReferences(makeDeps(), [broken, good], SIGNAL);
  assert.equal(out[0], broken, "损坏引用原样通过");
  assert.equal(out.length, 3, "好的一条仍被展开");
});

// ---------------- 3. 压缩标志（面板的「压缩」真正生效的通道） ----------------

function compactMention(seq, label) {
  return formatMessageReferenceMention({ sessionId: SID, seq, label, compact: true });
}

await check("编解码：compact 标志往返且与普通引用不同", async () => {
  const plain = encodeMessageReferenceUri({ sessionId: SID, seq: 9 });
  const packed = encodeMessageReferenceUri({ sessionId: SID, seq: 9, compact: true });
  assert.notEqual(plain, packed, "带压缩的 URI 必须不同");
  assert.deepEqual(decodeMessageReferenceUri(packed), { sessionId: SID, seq: 9, compact: true });
  assert.equal(encodeMessageReferenceUri(decodeMessageReferenceUri(packed)), packed, "必须规范");
  assert.deepEqual(decodeMessageReferenceUri(plain), { sessionId: SID, seq: 9 }, "普通引用不得回填 compact");
});

await check("解码：c 只认字面量 1（true 属于非规范）", async () => {
  const payload = Buffer.from(JSON.stringify({ s: SID, q: 9, c: true }), "utf8").toString("base64url");
  assert.throws(() => decodeMessageReferenceUri("dsh-session-message:" + payload), /不是合法的消息引用/);
});

await check("展开：compact 引用走摘要，且不保留原文", async () => {
  const llm = {
    stream: async function* () {
      yield { type: "text-delta", text: "这是模型给出的摘要" };
    },
  };
  const deps = makeDeps({ llm, provider: "deepseek", model: "flash" });
  const out = await expandMessageReferences(deps, [userMessage(compactMention(9, "#9 user"))], SIGNAL);
  assert.equal(out.length, 2, "仍是一条正文 + 一条转发内容");
  const text = out[1].content[0].text;
  assert.match(text, /已由模型压缩/, "必须走摘要分支");
  assert.match(text, /这是模型给出的摘要/);
  assert.doesNotMatch(text, /用户的问题原文/, "压缩后不应保留原文");
});

await check("展开：没有模型路由时退回原文，绝不抛错", async () => {
  const out = await expandMessageReferences(makeDeps(), [userMessage(compactMention(9, "#9 user"))], SIGNAL);
  assert.equal(out.length, 2);
  const text = out[1].content[0].text;
  assert.doesNotMatch(text, /已由模型压缩/, "拿不到摘要时应退回原文分支");
  assert.match(text, /用户的问题原文/, "原文必须仍在");
});

await check("展开：摘要调用抛错时退回原文", async () => {
  const llm = {
    stream: () => {
      throw new Error("模拟模型失败");
    },
  };
  const deps = makeDeps({ llm, provider: "p", model: "m" });
  const out = await expandMessageReferences(deps, [userMessage(compactMention(9, "#9 user"))], SIGNAL);
  assert.equal(out.length, 2);
  const text = out[1].content[0].text;
  assert.match(text, /用户的问题原文/);
  assert.doesNotMatch(text, /已由模型压缩/);
});

console.log("");
console.log("通过 " + passed + " 项，失败 " + failed + " 项");
if (failed > 0) process.exitCode = 1;
