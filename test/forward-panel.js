// 转发面板纯逻辑：与 Host 侧的跨端一致性 + 选择态 + 队列（node test/forward-panel.js）

import assert from "node:assert/strict";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ok   " + name);
  } catch (error) {
    failed += 1;
    process.exitCode = 1;
    console.log("  FAIL " + name + "\n       " + (error && error.message));
  }
}

// 客户端 bundle 通过 window.__ModuleLoader__ 自我注册。
let captured = null;
globalThis.window = { __ModuleLoader__: { load(entry) { captured = entry; } } };
// 加 query 绕过 ESM 模块缓存：client.js 测试已经 import 过同一文件，
// 直接再 import 会命中缓存而不重新执行 bundle，load 就不会被调用。
await import("../client/client.js?forward-panel");
assert.ok(captured !== null, "客户端 bundle 必须注册到 window.__ModuleLoader__");
const fakeReact = { useCallback: (fn) => fn, useEffect: () => {}, useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }), useMemo: (fn) => fn() };
const mod = captured.factory((spec) => {
  if (spec === "react") return fakeReact;
  throw new Error("unexpected require: " + spec);
});

const { weightedChars: hostWeighted, renderForwardedMessages } = await import("../lib/render.js").then(
  async (render) => ({
    weightedChars: (await import("../lib/messages.js")).weightedChars,
    renderForwardedMessages: render.renderForwardedMessages,
  }),
);

const {
  encodeMessageReferenceUri: hostEncodeUri,
  formatMessageReferenceMention: hostMention,
  parseMessageReferenceText: hostParseText,
} = await import("../lib/message-reference.js");

const {
  weightedChars,
  buildForwardText,
  buildDraftMentions,
  encodeMessageReferenceUri,
  escapeMentionLabel,
  messageMention,
  defaultSelection,
  kindStats,
  toggleKind,
  selectedWeight,
  mustCompact,
  rowLabel,
  shortIdOf,
  putPending,
  takePending,
  peekPending,
  dropPending,
  clearPending,
} = mod;

const SID = "session-2ad9569d-f867-4ee8-be64-b1b375a6bea0";

function row(seq, kind, text, summary) {
  return { seq, kind, text, summary: summary ?? text.split("\n")[0] };
}

const ROWS = [
  row(9, "user", "当前电脑安装了deepseek harness的桌面版"),
  row(10, "assistant", "先给结论：没有直接共用同一个 profile 的官方开关。"),
  row(11, "tool-call", "工具 run_code 参数：{\"code\":\"x\"}", "工具 run_code：探测 DSH 环境变量与桌面版数据目录"),
];

// ---------------- 1. 与 Host 同源 ----------------

check("weightedChars：与 Host 侧逐值一致", () => {
  for (const text of ["", "abcd", "中文", "ab中", "id = 42", "混合 mixed 文本 123"]) {
    assert.equal(weightedChars(text), hostWeighted(text), JSON.stringify(text));
  }
  assert.equal(weightedChars("abcd", 0.5), hostWeighted("abcd", 0.5));
  assert.equal(weightedChars("abcd", 1), hostWeighted("abcd", 1));
});

check("buildForwardText：与 Host 侧 renderForwardedMessages 逐字一致", () => {
  const hostItems = ROWS.map((item) => ({ seq: item.seq, kind: item.kind, role: item.kind, text: item.text }));
  const host = renderForwardedMessages({
    sessionId: SID,
    label: "DSH桌面版与命令行共享配置方案",
    shortId: shortIdOf(SID),
    items: hostItems,
    note: "这两条是背景",
    guidance: "",
  });
  const client = buildForwardText({
    sessionId: SID,
    label: "DSH桌面版与命令行共享配置方案",
    shortId: shortIdOf(SID),
    rows: ROWS,
    note: "这两条是背景",
  });
  assert.equal(client, host, "两种转发路径必须产出同一份文本");
});

check("buildForwardText：无附言时不追加空行", () => {
  const text = buildForwardText({ sessionId: SID, label: "甲", rows: [ROWS[0]] });
  assert.ok(text.endsWith("【转发内容结束】"), "结尾应是结束标记");
  const host = renderForwardedMessages({
    sessionId: SID,
    label: "甲",
    shortId: shortIdOf(SID),
    items: [{ seq: 9, kind: "user", role: "user", text: ROWS[0].text }],
    note: "",
    guidance: "",
  });
  assert.equal(text, host);
});

check("shortIdOf：与 Host 侧 trim 规则一致", () => {
  assert.equal(shortIdOf("session-2ad9569d-f867"), "2ad9569d");
  assert.equal(shortIdOf("bare1234"), "bare1234");
});

// ---------------- 2. 选择态 ----------------

check("defaultSelection：默认只选 user 与 assistant", () => {
  const picked = defaultSelection(ROWS);
  assert.deepEqual([...picked].sort((a, b) => a - b), [9, 10]);
});

check("kindStats：统计每种类型的全选状态", () => {
  const picked = defaultSelection(ROWS);
  const stats = kindStats(ROWS, picked);
  assert.deepEqual(stats, [
    { kind: "user", total: 1, selected: 1, all: true },
    { kind: "assistant", total: 1, selected: 1, all: true },
    { kind: "tool-call", total: 1, selected: 0, all: false },
  ]);
});

check("toggleKind：未全选则全选，已全选则全取消", () => {
  const picked = new Set([9]);
  toggleKind(ROWS, picked, "tool-call");
  assert.ok(picked.has(11), "应选中 tool-call");
  toggleKind(ROWS, picked, "user");
  assert.ok(!picked.has(9), "user 已全选，切换后应取消");
});

check("selectedWeight：只累计选中的行", () => {
  const picked = new Set([9]);
  assert.equal(selectedWeight(ROWS, picked), weightedChars(ROWS[0].text));
  assert.equal(selectedWeight(ROWS, new Set()), 0);
});

// ---------------- 3. 压缩判定 ----------------

check("mustCompact：超过上限即强制压缩", () => {
  assert.equal(mustCompact(4000, 4000), false, "等于上限不算超");
  assert.equal(mustCompact(4001, 4000), true);
  assert.equal(mustCompact(0, 4000), false);
  assert.equal(mustCompact(99999, 0), false, "上限非法时不强制");
});

// ---------------- 4. 行标签 ----------------

check("rowLabel：带短摘要，tool-call 剥掉「工具 」前缀", () => {
  // 摘要统一截到 18 个字符（ROW_SUMMARY_LIMIT）。
  assert.equal(rowLabel(ROWS[0]), "#9 user · 当前电脑安装了deepseek ha…");
  assert.equal(Array.from(rowLabel(ROWS[0]).split(" · ")[1]).length, 19, "18 字 + 省略号");
  assert.ok(!rowLabel(ROWS[2]).includes("工具 "), "不得出现重复前缀");
});

// ---------------- 5. 消息级 mention（chip 回填） ----------------

check("encodeMessageReferenceUri：与 Host 侧逐字一致", () => {
  for (const seq of [0, 9, 4965, 123456]) {
    assert.equal(encodeMessageReferenceUri(SID, seq), hostEncodeUri({ sessionId: SID, seq }), "seq=" + seq);
  }
});

check("escapeMentionLabel：转义 ] 与反斜杠", () => {
  assert.equal(escapeMentionLabel("a]b"), "a\\]b");
  assert.equal(escapeMentionLabel("a\\b"), "a\\\\b");
  assert.ok(messageMention(SID, 9, "a]b").includes("[a\\]b]("), "生成时同样要转义");
});

check("buildDraftMentions：一行一个 mention，附言另起一行", () => {
  const text = buildDraftMentions({ sessionId: SID, rows: ROWS.slice(0, 2), note: "这两条是背景" });
  const lines = text.split("\n");
  assert.equal(lines.length, 3, "两条引用 + 一条附言");
  assert.ok(lines[0].startsWith("@[#9 user · "), lines[0]);
  assert.ok(lines[0].includes("(dsh-session-message:"), "必须带消息级 scheme");
  assert.equal(lines[1], hostMention({ sessionId: SID, seq: 10, label: rowLabel(ROWS[1]) }), "与会话级 chip 同形");
  assert.equal(lines[2], "这两条是背景");
});

check("buildDraftMentions：无附言时不追加空行", () => {
  const text = buildDraftMentions({ sessionId: SID, rows: [ROWS[0]] });
  assert.equal(text.split("\n").length, 1);
  assert.ok(text.startsWith("@[#9 user · "));
});

check("往返：Host 侧 pre-step 能把草稿 mention 解析回 seq", () => {
  const draft = buildDraftMentions({ sessionId: SID, rows: ROWS.slice(0, 2), note: "附言" });
  const parsed = hostParseText(draft);
  assert.equal(parsed.references.length, 2, "两条引用都要被识别");
  assert.deepEqual(
    parsed.references.map((item) => item.seq),
    [9, 10],
  );
  assert.ok(parsed.references.every((item) => item.sessionId === SID), "会话 id 不得丢失");
  assert.ok(!parsed.text.includes("dsh-session-message:"), "展开后正文不应残留 URI");
  assert.ok(parsed.text.includes("附言"), "附言原样保留");
});

// ---------------- 6. 待回填队列 ----------------

check("队列：放入 → 取出 → 清除，只消费一次", () => {
  clearPending();
  putPending(SID, { text: "转发块", mode: "draft", label: "甲" });
  assert.equal(peekPending(SID)?.text, "转发块", "窥视不消费");
  assert.equal(takePending(SID)?.mode, "draft");
  assert.equal(takePending(SID), undefined, "第二次取出必须为空");
});

check("队列：回滚与清空", () => {
  clearPending();
  putPending(SID, { text: "a", mode: "send", label: "甲" });
  dropPending(SID);
  assert.equal(peekPending(SID), undefined, "回滚后不应残留");
  putPending(SID, { text: "b", mode: "send", label: "甲" });
  clearPending();
  assert.equal(peekPending(SID), undefined);
});

console.log("");
console.log("通过 " + passed + " 项，失败 " + failed + " 项");
if (failed > 0) process.exitCode = 1;
