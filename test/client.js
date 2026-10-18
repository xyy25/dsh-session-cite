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

console.log("\n通过 " + passed + " 项");
