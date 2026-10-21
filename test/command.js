// dsh-session-cite /ref 命令链路测试：参数解析、目标解析、mention 契约回环、消息提交。
// 独立运行：node test/command.js（lib/ 缺失或比 src/ 旧时，先执行一次 tsc -p tsconfig.json）

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const srcDir = join(pkgRoot, "src");
const libDir = join(pkgRoot, "lib");
const SRC_MODULES = ["mention", "message", "parse", "targets", "render", "command"];

function entryOf(name) {
  return join(libDir, name + ".js");
}

/** lib/ 缺失，或有源文件比编译产物新时，先编译一次。 */
function needsBuild() {
  if (!existsSync(entryOf("command"))) return true;
  const target = statSync(entryOf("command")).mtimeMs;
  return SRC_MODULES.some((name) => {
    const source = join(srcDir, name + ".ts");
    return existsSync(source) && statSync(source).mtimeMs > target;
  });
}

if (needsBuild()) {
  try {
    execSync("tsc -p tsconfig.json", { cwd: pkgRoot, stdio: "inherit" });
  } catch {
    console.log("[提示] tsc 返回非 0 退出码（可能来自本次未改动的模块），继续使用已产出的 lib/");
  }
}

async function main() {
  if (!existsSync(entryOf("command"))) {
    console.error("[失败] 找不到 lib/command.js：请先在插件目录执行 tsc -p tsconfig.json");
    process.exitCode = 1;
    return;
  }

  const mention = await import(pathToFileURL(entryOf("mention")).href);
  const message = await import(pathToFileURL(entryOf("message")).href);
  const parse = await import(pathToFileURL(entryOf("parse")).href);
  const targets = await import(pathToFileURL(entryOf("targets")).href);
  const render = await import(pathToFileURL(entryOf("render")).href);
  const command = await import(pathToFileURL(entryOf("command")).href);

  let passed = 0;
  const failures = [];

  async function test(name, fn) {
    try {
      await fn();
      passed += 1;
      console.log("[通过] " + name);
    } catch (error) {
      failures.push(name);
      console.error("[失败] " + name + "：" + (error && error.message ? error.message : error));
    }
  }

  const AGENT_ID = "sess-self";
  const GUIDANCE = "GUIDANCE-本体";

  function makeAgent(status = "idle") {
    const calls = [];
    const agent = {
      id: AGENT_ID,
      status,
      calls,
      followup(msg) {
        calls.push(msg);
      },
    };
    return agent;
  }

  /** 精确命中的候选源桩：查询什么 id 就命中什么 id。 */
  const echoCandidates = async (query) => [{ sessionId: query, label: query }];

  function makeDeps(overrides = {}) {
    return {
      config: { mode: "send", maxReferences: 3, guidance: GUIDANCE },
      listCandidates: echoCandidates,
      ...overrides,
    };
  }

  function idleSignal() {
    return new AbortController().signal;
  }

  const uriOf = (id) => mention.encodeSessionReferenceUri(id);
  const mentionOf = (id, label) => mention.formatSessionReferenceMention({ sessionId: id, label });

  function tokensOf(raw) {
    const parsed = parse.parseRefInput(raw);
    assert.equal(parsed.ok, true, "参数解析应成功：" + (parsed.ok ? "" : parsed.error));
    return parsed.tokens;
  }

  // ===================== 参数解析 =====================

  await test("空输入 → 报错并给出用法", async () => {
    for (const raw of ["", "   ", "\n\t  \n"]) {
      const parsed = parse.parseRefInput(raw);
      assert.equal(parsed.ok, false);
      assert.match(parsed.error, /用法/);
    }
    const result = await command.executeRef(makeDeps(), { agent: makeAgent(), rawInput: "   ", signal: idleSignal() });
    assert.equal(result.kind, "error");
    assert.match(result.text, /用法/);
  });

  await test("单个裸 id", async () => {
    const parsed = parse.parseRefInput("sess-abc");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, undefined);
    assert.deepEqual(parsed.tokens, [{ raw: "sess-abc", kind: "bare" }]);
    assert.equal(parsed.note, "");
  });

  await test("多个裸 id", async () => {
    const parsed = parse.parseRefInput("  sess-1   sess-2.3 ");
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.tokens, [
      { raw: "sess-1", kind: "bare" },
      { raw: "sess-2.3", kind: "bare" },
    ]);
    assert.equal(parsed.note, "");
  });

  await test("裸 id + 说明", async () => {
    const parsed = parse.parseRefInput("sess-1 这个会话里的构建脚本");
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.tokens, [{ raw: "sess-1", kind: "bare" }]);
    assert.equal(parsed.note, "这个会话里的构建脚本");
  });

  await test("说明含空格与换行", async () => {
    const parsed = parse.parseRefInput("sess-1 第一段 内容\n第二段 内容");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.note, "第一段 内容\n第二段 内容");
  });

  await test("dsh-session: URI 形式", async () => {
    const raw = uriOf("sess-uri");
    const parsed = parse.parseRefInput(raw + " 补充说明");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.tokens.length, 1);
    assert.equal(parsed.tokens[0].kind, "uri");
    assert.equal(parsed.note, "补充说明");
    const resolved = await targets.resolveTargets({ agentId: AGENT_ID, tokens: parsed.tokens, maxReferences: 3 });
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.refs, [{ id: "sess-uri", label: "sess-uri" }]);
  });

  await test("整段 mention（标签含空格）被整体吸收", async () => {
    const raw = mentionOf("sess-m", "构建脚本 排查");
    const parsed = parse.parseRefInput(raw + " 看下");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.tokens.length, 1);
    assert.equal(parsed.tokens[0].kind, "mention");
    assert.equal(parsed.tokens[0].raw, raw);
    assert.equal(parsed.note, "看下");
    const resolved = await targets.resolveTargets({ agentId: AGENT_ID, tokens: parsed.tokens, maxReferences: 3 });
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.refs, [{ id: "sess-m", label: "构建脚本 排查" }]);
  });

  await test("--draft 与 --send 开关", async () => {
    const draft = parse.parseRefInput("--draft sess-1");
    assert.equal(draft.ok, true);
    assert.equal(draft.mode, "draft");
    assert.deepEqual(draft.tokens, [{ raw: "sess-1", kind: "bare" }]);
    const send = parse.parseRefInput("--send  sess-1 说明");
    assert.equal(send.ok, true);
    assert.equal(send.mode, "send");
    assert.equal(send.note, "说明");
  });

  await test("两个开关同给或重复给 → 报错", async () => {
    const both = parse.parseRefInput("--draft --send sess-1");
    assert.equal(both.ok, false);
    assert.match(both.error, /互斥/);
    const twice = parse.parseRefInput("--send --send sess-1");
    assert.equal(twice.ok, false);
    assert.match(twice.error, /重复/);
  });

  await test("首 token 非引用 → 报错（不把整行当说明）", async () => {
    const parsed = parse.parseRefInput("请引用 sess-1");
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /没有识别到会话引用/);
  });

  // ===================== 目标解析 =====================

  await test("自引用 → 报错", async () => {
    const resolved = await targets.resolveTargets({
      agentId: AGENT_ID,
      tokens: tokensOf(AGENT_ID),
      maxReferences: 3,
      listCandidates: echoCandidates,
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /自身/);
  });

  await test("自引用：候选为空时也能认出自己（dsh 会过滤掉当前会话）", async () => {
    // 真实环境里 listCandidates 永远不返回当前会话，所以必须能从「候选为空」识别自己，
    // 否则报出来的是「没有找到」，而不是自引用提示。
    const resolved = await targets.resolveTargets({
      agentId: AGENT_ID,
      tokens: tokensOf(AGENT_ID),
      maxReferences: 3,
      listCandidates: async () => [],
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /自身/);
    assert.doesNotMatch(resolved.error, /没有找到/);
  });

  await test("自引用：短 id 前缀命中自己", async () => {
    const resolved = await targets.resolveTargets({
      agentId: "session-2fad253d-e516-45af-afd7-a4d9d85c842b",
      tokens: tokensOf("2fad253d"),
      maxReferences: 3,
      listCandidates: async () => [],
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /自身/);
  });

  await test("自引用：前缀太短时不误判", async () => {
    const resolved = await targets.resolveTargets({
      agentId: "session-2fad253d-e516-45af-afd7-a4d9d85c842b",
      tokens: tokensOf("2fad"),
      maxReferences: 3,
      listCandidates: async () => [],
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /没有找到/);
  });

  await test("消息级自引用：allowSelf 时放行（候选为空也能解析）", async () => {
    const resolved = await targets.resolveTargets({
      agentId: AGENT_ID,
      tokens: tokensOf(AGENT_ID),
      maxReferences: 3,
      listCandidates: async () => [],
      allowSelf: true,
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.refs[0].id, AGENT_ID);
  });

  await test("会话级自引用：即使 allowSelf 为 false 也能给出可操作提示", async () => {
    const resolved = await targets.resolveTargets({
      agentId: AGENT_ID,
      tokens: tokensOf(AGENT_ID),
      maxReferences: 3,
      listCandidates: echoCandidates,
      allowSelf: false,
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /--list 或 --pick/);
  });

  await test("0 个候选 → 未找到", async () => {
    const resolved = await targets.resolveTargets({
      agentId: AGENT_ID,
      tokens: tokensOf("sess-none"),
      maxReferences: 3,
      listCandidates: async () => [],
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /没有找到/);
  });

  await test("多个候选 → 列出候选供重选", async () => {
    const resolved = await targets.resolveTargets({
      agentId: AGENT_ID,
      tokens: tokensOf("build"),
      maxReferences: 3,
      listCandidates: async () => [
        { sessionId: "sess-a", label: "标题 A" },
        { sessionId: "sess-b", label: "标题 B", displayTitle: "显示 B" },
        { sessionId: "sess-c", label: "标题 C" },
      ],
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /命中 3 个候选/);
    assert.match(resolved.error, /sess-a（标题 A）/);
    assert.match(resolved.error, /sess-b（显示 B）/);
    assert.match(resolved.error, /sess-c（标题 C）/);
  });

  await test("唯一候选 → 回退命中", async () => {
    const resolved = await targets.resolveTargets({
      agentId: AGENT_ID,
      tokens: tokensOf("build"),
      maxReferences: 3,
      listCandidates: async () => [{ sessionId: "sess-only", label: "唯一会话", displayTitle: "唯一显示" }],
    });
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.refs, [{ id: "sess-only", label: "唯一显示" }]);
  });

  await test("精确命中优先于唯一回退，且 label 取 displayTitle", async () => {
    const resolved = await targets.resolveTargets({
      agentId: AGENT_ID,
      tokens: tokensOf("sess-b"),
      maxReferences: 3,
      listCandidates: async () => [
        { sessionId: "sess-a", label: "标题 A" },
        { sessionId: "sess-b", label: "标题 B" },
      ],
    });
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.refs, [{ id: "sess-b", label: "标题 B" }]);
  });

  await test("没有候选来源时裸 id → 提示改用 dsh-session: 引用", async () => {
    const resolved = await targets.resolveTargets({ agentId: AGENT_ID, tokens: tokensOf("sess-abc"), maxReferences: 3 });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /dsh-session:/);
  });

  await test("超上限 → 报错并指出上限", async () => {
    const resolved = await targets.resolveTargets({
      agentId: AGENT_ID,
      tokens: tokensOf("sess-1 sess-2 sess-3"),
      maxReferences: 2,
      listCandidates: echoCandidates,
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /最多只能引用 2 个会话/);
  });

  await test("去重后不超上限 → 成功且保持顺序", async () => {
    const resolved = await targets.resolveTargets({
      agentId: AGENT_ID,
      tokens: tokensOf("sess-1 sess-2 sess-1"),
      maxReferences: 2,
      listCandidates: echoCandidates,
    });
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.refs, [
      { id: "sess-1", label: "sess-1" },
      { id: "sess-2", label: "sess-2" },
    ]);
  });

  // ===================== 命令执行 =====================

  await test("send 模式：提交一条 source.kind === user 的消息", async () => {
    const agent = makeAgent("idle");
    const result = await command.executeRef(makeDeps(), {
      agent,
      rawInput: "sess-abc 排查构建脚本",
      signal: idleSignal(),
    });
    assert.equal(result.kind, "success");
    assert.equal(agent.calls.length, 1);
    const msg = agent.calls[0];
    assert.equal(msg.role, "user");
    assert.equal(typeof msg.id, "string");
    assert.ok(msg.id.length > 0);
    assert.deepEqual(msg.source, { kind: "user" });
    assert.equal(msg.content.length, 1);
    assert.equal(msg.content[0].type, "text");
    assert.ok(Object.isFrozen(msg), "消息应被递归冻结");
    assert.ok(Object.isFrozen(msg.content), "content 数组应被递归冻结");
    assert.ok(Object.isFrozen(msg.content[0]), "内容块应被递归冻结");
    const text = msg.content[0].text;
    assert.ok(text.includes(mentionOf("sess-abc")), "正文应含 mention：" + text);
    assert.ok(text.includes("排查构建脚本"), "正文应含说明");
    assert.ok(text.includes(GUIDANCE), "正文应含引导语");
    assert.ok(text.startsWith("排查构建脚本\n\n"), "说明应在最前");
    assert.match(result.text, /已引用 1 个会话/);
    assert.match(result.text, /已开启新一轮/);
  });

  await test("send 模式：label 取候选标题，running 时提示已排队", async () => {
    const agent = makeAgent("running");
    const result = await command.executeRef(
      makeDeps({
        listCandidates: async () => [{ sessionId: "sess-abc", label: "构建脚本排查" }],
      }),
      { agent, rawInput: "sess-abc", signal: idleSignal() },
    );
    assert.equal(result.kind, "success");
    assert.match(result.text, /构建脚本排查/);
    assert.match(result.text, /已排队到下一轮/);
    const text = agent.calls[0].content[0].text;
    assert.ok(text.includes(mentionOf("sess-abc", "构建脚本排查")), text);
  });

  await test("draft 模式：不调用 followup，返回不含引导语的草稿", async () => {
    const agent = makeAgent();
    const result = await command.executeRef(makeDeps(), {
      agent,
      rawInput: "--draft sess-abc 草稿说明",
      signal: idleSignal(),
    });
    assert.equal(result.kind, "success");
    assert.equal(agent.calls.length, 0, "draft 模式不得提交消息");
    assert.ok(result.text.includes(mentionOf("sess-abc")), result.text);
    assert.ok(result.text.includes("草稿说明"));
    assert.ok(!result.text.includes(GUIDANCE), "草稿不应包含引导语");
  });

  await test("配置 mode=draft 时默认走草稿；--send 可覆盖", async () => {
    const draftAgent = makeAgent();
    const draftResult = await command.executeRef(
      { config: { mode: "draft", maxReferences: 3, guidance: GUIDANCE }, listCandidates: echoCandidates },
      { agent: draftAgent, rawInput: "sess-abc", signal: idleSignal() },
    );
    assert.equal(draftResult.kind, "success");
    assert.equal(draftAgent.calls.length, 0);

    const sendAgent = makeAgent();
    const sendResult = await command.executeRef(
      { config: { mode: "draft", maxReferences: 3, guidance: GUIDANCE }, listCandidates: echoCandidates },
      { agent: sendAgent, rawInput: "--send sess-abc", signal: idleSignal() },
    );
    assert.equal(sendResult.kind, "success");
    assert.equal(sendAgent.calls.length, 1);
  });

  await test("已中止的信号 → 报错且不提交", async () => {
    const agent = makeAgent();
    const controller = new AbortController();
    controller.abort();
    const result = await command.executeRef(makeDeps(), {
      agent,
      rawInput: "sess-abc",
      signal: controller.signal,
    });
    assert.equal(result.kind, "error");
    assert.match(result.text, /已取消/);
    assert.equal(agent.calls.length, 0);
  });

  await test("followup 抛异常 → 转成 error 结果", async () => {
    const agent = makeAgent();
    agent.followup = () => {
      throw new Error("投递通道已关闭");
    };
    const result = await command.executeRef(makeDeps(), {
      agent,
      rawInput: "sess-abc",
      signal: idleSignal(),
    });
    assert.equal(result.kind, "error");
    assert.match(result.text, /提交引用失败/);
    assert.match(result.text, /投递通道已关闭/);
  });

  await test("命令元信息齐备", async () => {
    assert.equal(command.REF_COMMAND_NAME, "ref");
    assert.ok(command.REF_DESCRIPTION.length > 0);
    assert.match(command.REF_INPUT_HINT, /\/ref/);
  });

  // ===================== 正文与引导语 =====================

  await test("buildRefMessage 用空行连接并丢弃空值", async () => {
    assert.equal(
      render.buildRefMessage({ note: "说明", mentions: ["@[a](b)", "@[c](d)"], guidance: "引导" }),
      "说明\n\n@[a](b)\n\n@[c](d)\n\n引导",
    );
    assert.equal(render.buildRefMessage({ note: "", mentions: ["@[a](b)"], guidance: "" }), "@[a](b)");
    assert.equal(render.buildRefMessage({ note: "  ", mentions: [""], guidance: "引导" }), "引导");
  });

  await test("DEFAULT_GUIDANCE 覆盖三点且不含未实现的能力承诺", async () => {
    const guidance = render.DEFAULT_GUIDANCE;
    assert.match(guidance, /另一个会话/);
    assert.match(guidance, /只读快照/);
    assert.match(guidance, /裁剪/);
    assert.match(guidance, /spill 文件/);
    assert.match(guidance, /session_read/);
    assert.ok(!/自动|一定会|保证/.test(guidance), "引导语不应承诺不存在的能力");
  });

  await test("createUserMessage 生成互不相同的 id", async () => {
    const first = message.createUserMessage({ content: [{ type: "text", text: "a" }], source: { kind: "user" } });
    const second = message.createUserMessage({ content: [{ type: "text", text: "a" }], source: { kind: "user" } });
    assert.notEqual(first.id, second.id);
    assert.equal(first.role, "user");
  });

  // ===================== mention 契约回环 =====================

  await test("契约回环：mention 编解码往返一致", async () => {
    for (const input of [
      { sessionId: "sess-abc", label: "构建脚本排查" },
      { sessionId: "sess-abc", label: "带 ] 与 \\ 的标签" },
    ]) {
      const text = mentionOf(input.sessionId, input.label);
      const parsed = mention.parseSessionReferenceText(text);
      assert.equal(parsed.references.length, 1);
      assert.equal(parsed.references[0].sessionId, input.sessionId);
      assert.equal(parsed.references[0].label, input.label);
      assert.equal(parsed.text, "@" + input.label);
    }
  });

  await test("契约回环：URI 规范性与非规范拒绝", async () => {
    const uri = uriOf("sess-abc");
    assert.ok(uri.startsWith("dsh-session:"));
    assert.equal(mention.decodeSessionReferenceUri(uri), "sess-abc");
    assert.throws(() => mention.decodeSessionReferenceUri("dsh-session:"), /不是合法的会话引用/);
    assert.throws(() => mention.decodeSessionReferenceUri("dsh-session:@@@@"), /不是合法的会话引用/);
    assert.throws(() => mention.decodeSessionReferenceUri("bear:" + uri.slice(12)), /不是合法的会话引用/);
    // 非规范：载荷补上 base64 填充符后能解出同样的 id，但必须被拒绝
    const padded = uri + "==";
    if (padded.endsWith("==")) assert.throws(() => mention.decodeSessionReferenceUri(padded), /不是合法的会话引用/);
  });

  await test("与内建 dsh-session-reference 逐字对比（不可加载则跳过）", async () => {
    const INTERNAL =
      "E:/nvm/v24.14.1/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-reference/lib/index.js";
    let real = null;
    try {
      real = await import("file:///" + INTERNAL);
    } catch {
      real = null;
    }
    if (real === null) {
      console.log("[跳过] 无法加载内建 dsh-session-reference，跳过逐字对比");
      return;
    }
    for (const id of ["sess-abc", "会话-中文", 'quote"and\\slash', "x", "sess 空格"]) {
      assert.equal(mention.encodeSessionReferenceUri(id), real.encodeSessionReferenceUri(id));
      assert.equal(mention.decodeSessionReferenceUri(real.encodeSessionReferenceUri(id)), id);
    }
    for (const label of ["普通标签", "带 ] 括号", "带 \\ 反斜杠", "两者 ] 与 \\", ""]) {
      assert.equal(
        mentionOf("sess-abc", label),
        real.formatSessionReferenceMention({ sessionId: "sess-abc", label }),
      );
    }
    const sample =
      "看下 " + mentionOf("s", "a]b") + " 以及 " + real.encodeSessionReferenceUri("sess-2") + " 两处";
    assert.deepEqual(mention.parseSessionReferenceText(sample), real.parseSessionReferenceText(sample));
    const escaped = "反斜杠与方括号 " + mentionOf("s2", "a\\]b");
    assert.deepEqual(mention.parseSessionReferenceText(escaped), real.parseSessionReferenceText(escaped));
  });

  if (failures.length > 0) {
    process.exitCode = 1;
    console.error("\n[汇总] 通过 " + passed + " 个，失败 " + failures.length + " 个：");
    for (const name of failures) console.error(" - " + name);
  } else {
    console.log("\n[汇总] 通过 " + passed + " 个，失败 0 个");
  }
}

await main();
