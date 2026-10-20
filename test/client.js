// 客户端 chip 回填的纯函数测试：node test/client.js
//
// 验证两件事：
//   1) scanMentions 的 offset/length 与 clipboardText 满足 dsh 的 snapshotSchema 约束
//      （length === clipboardText.length、text.slice(offset,end) === clipboardText、有序不重叠），
//      否则草稿持久化后回读会被丢弃。
//   2) applyDraft 在有 mention 时传结构化快照（references + appearance:'session'），
//      无 mention 或宿主拒绝时回退纯文本。

import assert from "node:assert/strict";

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ok  " + name);
  } catch (error) {
    process.exitCode = 1;
    console.log("  FAIL " + name + "\n       " + (error && error.message));
  }
}

// ---- 加载客户端 bundle（它通过 window.__ModuleLoader__ 自我注册）----
let captured = null;
globalThis.window = { __ModuleLoader__: { load(entry) { captured = entry; } } };
await import("../client/client.js");
assert.ok(captured !== null, "客户端 bundle 必须调用 window.__ModuleLoader__.load");

const fakeReact = { useCallback: (fn) => fn, useEffect: () => {} };
const mod = captured.factory((spec) => {
  if (spec === "react") return fakeReact;
  throw new Error("unexpected require: " + spec);
});

const scanMentions = mod.scanMentions;
const applyDraft = mod.applyDraft;
const decodeSessionId = mod.decodeSessionId;
const shortenSessionId = mod.shortenSessionId;
const displayLabel = mod.displayLabel;
const pickLatestRef = mod.pickLatestRef;
assert.equal(typeof scanMentions, "function", "必须导出 scanMentions");
assert.equal(typeof applyDraft, "function", "必须导出 applyDraft");

const M1 = "@[DSH桌面版与命令行共享配置方案](dsh-session:InNlc3Npb24tMmFkOTU2OWQtZjg2Ny00ZWU4LWJlNjQtYjFiMzc1YTZiZWEwIg)";
const M2 = "@[构建脚本排查](dsh-session:YmJiYg)";

// 与 dsh snapshotSchema 的三条 refine 条件逐条核对
function assertSnapshotSafe(text, refs) {
  let end = 0;
  for (const ref of refs) {
    assert.ok(ref.offset >= end, "引用必须有序且不重叠");
    assert.equal(ref.length, ref.clipboardText.length, "length 必须等于 clipboardText 长度");
    assert.equal(text.slice(ref.offset, ref.offset + ref.length), ref.clipboardText, "区间文本必须等于 clipboardText");
    assert.ok(ref.offset + ref.length <= text.length, "区间不得越界");
    end = ref.offset + ref.length;
  }
}

console.log("客户端 chip 回填测试开始");

ok("单个 mention：offset/length/label 正确", () => {
  const hits = scanMentions(M1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].offset, 0);
  assert.equal(hits[0].length, M1.length);
  assert.equal(hits[0].clipboardText, M1);
  assert.equal(hits[0].label, "DSH桌面版与命令行共享配置方案");
  assertSnapshotSafe(M1, hits);
});

ok("mention 前有说明文字时 offset 正确", () => {
  const prefix = "请参考这段背景：\n";
  const text = prefix + M1;
  const hits = scanMentions(text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].offset, prefix.length);
  assertSnapshotSafe(text, hits);
});

ok("多个 mention：有序不重叠且全部满足 schema", () => {
  const text = M1 + " 以及 " + M2;
  const hits = scanMentions(text);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].offset, 0);
  assert.ok(hits[1].offset >= hits[0].offset + hits[0].length);
  assertSnapshotSafe(text, hits);
});

ok("label 里的转义字符被还原", () => {
  const text = "@[a\\]b\\\\c](dsh-session:ZZZ)";
  const hits = scanMentions(text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, "a]b\\c");
});

ok("没有 mention 时返回空数组", () => {
  assert.deepEqual(scanMentions("没有引用的普通文本"), []);
  assert.deepEqual(scanMentions(""), []);
});

ok("applyDraft：有 mention 时传结构化快照", () => {
  let received = null;
  applyDraft({ setDraft: (value) => { received = value; } }, M1);
  assert.equal(typeof received, "object");
  assert.equal(received.text, M1);
  assert.equal(received.references.length, 1);
  const ref = received.references[0];
  assert.equal(ref.source, "reference");
  assert.equal(ref.appearance, "session");
  assert.equal(ref.ref, M1);
  assert.equal(ref.clipboardText, M1);
  // chip 显示用缩略 id 前缀；ref 与 clipboardText 仍是 mention 全文。
  assert.equal(ref.label, "2ad9569d · DSH桌面版与命令行共享配置方案");
  assertSnapshotSafe(received.text, received.references);
});

ok("applyDraft：无 mention 时传纯文本", () => {
  let received = null;
  applyDraft({ setDraft: (value) => { received = value; } }, "普通文本");
  assert.equal(received, "普通文本");
});

ok("applyDraft：宿主拒绝结构化输入时回退纯文本", () => {
  const received = [];
  const host = {
    setDraft(value) {
      received.push(value);
      if (typeof value !== "string") throw new Error("host rejects structured draft");
    },
  };
  applyDraft(host, M1);
  assert.equal(received.length, 2, "必须先试结构化再回退");
  assert.equal(typeof received[1], "string");
  assert.equal(received[1], M1);
});

ok("decodeSessionId：从真实 URI 解出会话 id", () => {
  assert.equal(decodeSessionId("dsh-session:InNlc3Npb24tMmFkOTU2OWQtZjg2Ny00ZWU4LWJlNjQtYjFiMzc1YTZiZWEwIg"), "session-2ad9569d-f867-4ee8-be64-b1b375a6bea0");
});

ok("decodeSessionId：非法载荷返回 undefined", () => {
  assert.equal(decodeSessionId("dsh-session:!!!"), undefined);
  assert.equal(decodeSessionId("not-a-uri"), undefined);
  assert.equal(decodeSessionId(""), undefined);
});

ok("shortenSessionId：去掉 session- 前缀取前 8 位", () => {
  assert.equal(shortenSessionId("session-2ad9569d-f867-4ee8-be64-b1b375a6bea0"), "2ad9569d");
  assert.equal(shortenSessionId("abc"), "abc");
});

ok("displayLabel：拼出「缩略id · 标题」", () => {
  const id = "session-2ad9569d-f867-4ee8-be64-b1b375a6bea0";
  assert.equal(displayLabel("DSH桌面版与命令行共享配置方案", id), "2ad9569d · DSH桌面版与命令行共享配置方案");
});

ok("displayLabel：标题已是 id 时不重复加前缀", () => {
  const id = "session-2ad9569d-f867-4ee8-be64-b1b375a6bea0";
  assert.equal(displayLabel(id, id), id);
  assert.equal(displayLabel("2ad9569d", id), "2ad9569d");
});

ok("displayLabel：无 sessionId 时原样返回", () => {
  assert.equal(displayLabel("某个标题", undefined), "某个标题");
});

ok("同标题不同会话：chip 标签可区分，但正文投影仍相同", () => {
  const title = "构建脚本排查";
  const uriA = "dsh-session:InNlc3Npb24tYWFhYWFhYWEtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAwIg";
  const uriB = "dsh-session:InNlc3Npb24tYmJiYmJiYmItMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAwIg";
  const text = "@[" + title + "](" + uriA + ") 与 @[" + title + "](" + uriB + ")";
  let received = null;
  applyDraft({ setDraft: (value) => { received = value; } }, text);
  assert.equal(received.references.length, 2);
  assert.notEqual(received.references[0].label, received.references[1].label, "同标题会话的 chip 标签必须不同");
  assert.ok(received.references[0].label.endsWith(" · " + title));
  assert.ok(received.references[1].label.endsWith(" · " + title));
  // 关键：clipboardText 未变，因此持久化校验与模型侧投影都不受影响。
  assertSnapshotSafe(received.text, received.references);
});

// ---- pickLatestRef：错误结果不得回填 ----

function snapshotOf(nodes) {
  return { views: { get: () => ({ nodes: { values: () => nodes } }) } };
}
function cmdNode(outcome, { name = "ref", args = "", seq = 1, commandId = "c1" } = {}) {
  return { kind: "command", data: { kind: "command", name, args, outcome, seq, commandId } };
}
function decodePicked(picked) {
  if (typeof picked !== "string") return null;
  const [commandId, submittedLine, text] = picked.split("\u0000");
  return { commandId, submittedLine, text };
}

ok("pickLatestRef：成功结果被采纳", () => {
  const picked = pickLatestRef(snapshotOf([cmdNode({ kind: "success", text: M1 })]));
  const parts = decodePicked(picked);
  assert.ok(parts !== null);
  assert.equal(parts.text, M1);
  assert.equal(parts.commandId, "c1");
});

ok("pickLatestRef：错误结果即使含 dsh-session: 也不采纳", () => {
  const errorText = '无法从 "abc" 读到会话引用。请重新复制完整的 dsh-session: 引用，或直接写会话 id。';
  assert.ok(errorText.includes("dsh-session:"), "用例必须真的包含该字样才有意义");
  assert.equal(pickLatestRef(snapshotOf([cmdNode({ kind: "error", text: errorText })])), null);
});

ok("pickLatestRef：成功但无规范 mention（send 模式文案）不采纳", () => {
  const sendText = "已引用 1 个会话：构建脚本排查（已开启新一轮）。";
  assert.equal(pickLatestRef(snapshotOf([cmdNode({ kind: "success", text: sendText })])), null);
});

ok("pickLatestRef：成功文本只提到 dsh-session: 字样而非规范 mention 时不采纳", () => {
  const tricky = "用法：/ref [--draft|--send] <会话 id 或 dsh-session: 引用> ... [说明]";
  assert.equal(pickLatestRef(snapshotOf([cmdNode({ kind: "success", text: tricky })])), null);
});

ok("pickLatestRef：较新的错误结果不遮蔽较早的成功结果", () => {
  const nodes = [
    cmdNode({ kind: "success", text: M1 }, { seq: 5, commandId: "old-ok" }),
    cmdNode({ kind: "error", text: "没有找到匹配的会话。请改用 dsh-session: 引用。" }, { seq: 9, commandId: "new-err" }),
  ];
  const parts = decodePicked(pickLatestRef(snapshotOf(nodes)));
  assert.ok(parts !== null, "应回退到最近一条成功结果");
  assert.equal(parts.commandId, "old-ok");
  assert.equal(parts.text, M1);
});

ok("pickLatestRef：只认 name 为 ref 的命令", () => {
  const nodes = [cmdNode({ kind: "success", text: M1 }, { name: "other" })];
  assert.equal(pickLatestRef(snapshotOf(nodes)), null);
});

ok("pickLatestRef：空快照返回 null", () => {
  assert.equal(pickLatestRef(snapshotOf([])), null);
  assert.equal(pickLatestRef({}), null);
});

// ---- 会话选择器（裸 /ref 弹窗的数据映射）----
const toSessionOptions = mod.toSessionOptions;
const draftForSession = mod.draftForSession;
const relativeTime = mod.relativeTime;
const shortSessionId = mod.shortSessionId;
const encodeSessionId = mod.encodeSessionId;
assert.equal(typeof toSessionOptions, "function", "必须导出 toSessionOptions");
assert.equal(typeof draftForSession, "function", "必须导出 draftForSession");

ok("toSessionOptions：跳过空会话、按最近活动降序、标记当前会话", () => {
  const state = {
    ids: ["session-aaaa1111-x", "session-bbbb2222-y", "session-cccc3333-z"],
    byId: {
      "session-aaaa1111-x": { displayTitle: "旧会话", updatedAt: 1000, blank: false },
      "session-bbbb2222-y": { displayTitle: "新会话", updatedAt: 9000, blank: false },
      "session-cccc3333-z": { displayTitle: "空会话", updatedAt: 5000, blank: true },
    },
  };
  const options = toSessionOptions(state, "session-bbbb2222-y", 10000);
  assert.equal(options.length, 2, "空会话不得列出");
  assert.equal(options[0].id, "session-bbbb2222-y", "最近活动的排在前面");
  assert.equal(options[0].active, true, "当前会话应标记 active");
  assert.equal(options[1].active, undefined);
});

ok("toSessionOptions：label 带短 id，保证能按 session-id 搜索", () => {
  const state = { ids: ["session-2ad9569d-ffff"], byId: { "session-2ad9569d-ffff": { displayTitle: "配置方案", updatedAt: 0 } } };
  const [option] = toSessionOptions(state, undefined, 0);
  assert.equal(option.label, "配置方案 · 2ad9569d");
  assert.ok(option.label.includes("2ad9569d"), "短 id 必须在 label 内，否则内置搜索按 id 匹配不到");
});

ok("toSessionOptions：标题已含短 id 时不重复追加；缺标题用兜底", () => {
  const state = {
    ids: ["session-abc12345-1", "session-def67890-2"],
    byId: {
      "session-abc12345-1": { displayTitle: "abc12345 的会话", updatedAt: 1 },
      "session-def67890-2": { updatedAt: 2 },
    },
  };
  const options = toSessionOptions(state, undefined, 100);
  const first = options.find((o) => o.id === "session-abc12345-1");
  const second = options.find((o) => o.id === "session-def67890-2");
  assert.equal(first.label, "abc12345 的会话");
  assert.match(second.label, /未命名会话 · def67890/);
});

ok("toSessionOptions：badge 标注运行中与子代理", () => {
  const state = {
    ids: ["session-run00001-1", "session-sub00001-2"],
    byId: {
      "session-run00001-1": { displayTitle: "跑着的", updatedAt: 5, running: true },
      "session-sub00001-2": { displayTitle: "子代理的", updatedAt: 4, origin: "subagent" },
    },
  };
  const options = toSessionOptions(state, undefined, 100);
  assert.equal(options[0].badge, "运行中");
  assert.equal(options[1].badge, "子代理");
});

ok("toSessionOptions：异常快照返回空数组而不是抛错", () => {
  assert.deepEqual(toSessionOptions(undefined), []);
  assert.deepEqual(toSessionOptions({}), []);
  assert.deepEqual(toSessionOptions({ ids: [], byId: {} }), []);
});

ok("draftForSession：回填命令式 /ref + 短 id（便于继续输参数）", () => {
  const text = draftForSession({ id: "session-2ad9569d-f867-4ee8-be64-b1b375a6bea0", draftId: "2ad9569d", label: "配置方案 · 2ad9569d" });
  assert.equal(text, "/ref 2ad9569d", "必须是命令式：/ref <id>，光标可继续接参数");
  assert.ok(!text.includes("dsh-session:"), "不得回填 mention/chip 形式");
});

ok("draftForSession：没有 draftId 时退回完整 id", () => {
  const id = "session-2ad9569d-f867-4ee8-be64-b1b375a6bea0";
  assert.equal(draftForSession({ id, label: "某会话" }), "/ref " + id);
});

ok("toSessionOptions：短 id 唯一 → 用短 id 回填", () => {
  const state = { ids: ["session-2ad9569d-x"], byId: { "session-2ad9569d-x": { displayTitle: "某会话", updatedAt: 1 } } };
  const [option] = toSessionOptions(state, undefined, 10);
  assert.equal(option.draftId, "2ad9569d");
  assert.equal(draftForSession(option), "/ref 2ad9569d");
});

ok("toSessionOptions：短 id 冲突 → 回填完整 id，避免指错会话", () => {
  const state = {
    ids: ["session-abcdef12-aaa", "session-abcdef12-bbb"],
    byId: {
      "session-abcdef12-aaa": { displayTitle: "甲会话", updatedAt: 2 },
      "session-abcdef12-bbb": { displayTitle: "乙会话", updatedAt: 1 },
    },
  };
  const options = toSessionOptions(state, undefined, 10);
  assert.equal(options.length, 2);
  for (const option of options) {
    assert.equal(option.draftId, option.id, "前缀冲突时必须用完整 id");
    assert.equal(draftForSession(option), "/ref " + option.id);
  }
});

ok("encodeSessionId 仍与服务端 encodeSessionReferenceUri 一致", () => {
  const id = "session-2ad9569d-f867-4ee8-be64-b1b375a6bea0";
  assert.equal(encodeSessionId(id), Buffer.from(JSON.stringify(id)).toString("base64url"));
});

ok("relativeTime：分钟/小时/天/月分档", () => {
  const base = 1_700_000_000_000;
  assert.equal(relativeTime(base - 10_000, base), "刚刚");
  assert.equal(relativeTime(base - 5 * 60_000, base), "5 分钟前");
  assert.equal(relativeTime(base - 3 * 3_600_000, base), "3 小时前");
  assert.equal(relativeTime(base - 5 * 86_400_000, base), "5 天前");
  assert.equal(relativeTime(base - 70 * 86_400_000, base), "2 个月前");
  assert.equal(relativeTime(Number.NaN, base), "");
});

ok("shortSessionId：去掉 session- 前缀取前 8 位", () => {
  assert.equal(shortSessionId("session-2ad9569d-f867-4ee8"), "2ad9569d");
  assert.equal(shortSessionId("bare1234"), "bare1234");
});

// ---- 消息级 mention（dsh-session-message:）----
ok("scanMentions：识别消息级 mention，scheme 与标签正确", () => {
  const payload = Buffer.from(JSON.stringify({ s: "session-2ad9", q: 9 })).toString("base64url");
  const text = "@[#9 user](dsh-session-message:" + payload + ")";
  const hits = scanMentions(text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].scheme, "message");
  assert.equal(hits[0].label, "#9 user");
  assert.equal(hits[0].sessionId, undefined, "消息级载荷不是裸 id，不走会话级解码");
});

ok("applyDraft：消息级 chip 用原始标签，不追加会话短 id", () => {
  const payload = Buffer.from(JSON.stringify({ s: "session-2ad9569d-x", q: 9 })).toString("base64url");
  const text = "@[#9 user](dsh-session-message:" + payload + ")";
  const calls = [];
  applyDraft({ setDraft: (draft) => calls.push(draft) }, text);
  assert.equal(calls.length, 1);
  const reference = calls[0].references[0];
  assert.equal(reference.label, "#9 user", "消息级标签保持原样");
  assert.equal(reference.appearance, "session");
  assert.equal(reference.clipboardText, text);
});

ok("scanMentions：两种 scheme 混合时都能识别", () => {
  const payload = Buffer.from(JSON.stringify({ s: "session-x", q: 9 })).toString("base64url");
  const text = M1 + "\n@[#9 user](dsh-session-message:" + payload + ")";
  const hits = scanMentions(text);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].scheme, "session");
  assert.equal(hits[1].scheme, "message");
});

// ---- 消息级 --draft 的转发块回填（旧格式，保留向后兼容）----
ok("pickLatestRef：--draft --pick 的转发块（无 mention）也被采纳", () => {
  const forward =
    "【转发内容】来自会话「甲」(2ad9569d) 的消息 #9 #136\n" +
    "--- #9 · user ---\n问题原文\n" +
    "--- #136 · user ---\n第二段\n" +
    "【转发内容结束】";
  const decoded = decodePicked(pickLatestRef(snapshotOf([cmdNode({ kind: "success", text: forward })])));
  assert.ok(decoded !== null, "消息级 draft 结果必须能被识别");
  assert.equal(decoded.text, forward, "回填内容就是转发块原文");
});

ok("pickLatestRef：--send 的简短确认不被回填", () => {
  const picked = pickLatestRef(
    snapshotOf([cmdNode({ kind: "success", text: "已转发 2 条消息（原文，来自「甲」，已开启新一轮）。" })]),
  );
  assert.equal(picked, null, "已发送的结果不得填进草稿");
});

ok("pickLatestRef：只有开头标记没有结束标记时不采纳", () => {
  const picked = pickLatestRef(snapshotOf([cmdNode({ kind: "success", text: "【转发内容】来自会话「甲」" })]));
  assert.equal(picked, null, "标记必须成对，避免误判");
});

console.log("\n通过 " + passed + " 项");
