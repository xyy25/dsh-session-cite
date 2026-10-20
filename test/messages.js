/**
 * messages / summarize 两个纯逻辑模块的独立可运行测试：node test/messages.js
 * 断言用 node:assert/strict，不引入测试框架；任一用例失败则 process.exitCode = 1。
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  DEFAULT_PICK_KINDS,
  listMessageEvents,
  normalizePickKinds,
  previewMessages,
  readMessages,
} from '../src/messages.ts';
import { SUMMARY_MAX_TOKENS, summarizeMessages } from '../src/summarize.ts';

const bytesOf = (text) => Buffer.byteLength(text, 'utf8');

let failed = 0;
let passed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (error) {
    failed += 1;
    console.log('  FAIL ' + name);
    console.log('       ' + (error && error.message ? error.message : String(error)));
  }
}

function ev(seq, type, data) {
  return { seq, type, time: 1700000000000 + seq, data };
}

/** 假会话查询服务：listEvents 只给元数据，readEvent 给完整事件。 */
function makeQuery(events) {
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return {
    calls: { listEvents: 0, readEvent: 0 },
    async listEvents(sessionId) {
      this.calls.listEvents += 1;
      assert.equal(typeof sessionId, 'string');
      return events.map((event) => ({ seq: event.seq, type: event.type, time: event.time }));
    },
    async readEvent(request) {
      this.calls.readEvent += 1;
      const found = bySeq.get(request.seq);
      if (found === undefined) throw new Error('不存在的事件 #' + request.seq);
      return { target: found, events: [found] };
    },
  };
}

function userEvent(seq, text, extraBlocks = []) {
  return ev(seq, 'user/message', {
    turn: 1,
    step: 0,
    message: { role: 'user', content: [{ type: 'text', text }, ...extraBlocks] },
  });
}

function baseEvents() {
  return [
    ev(1, 'session/title', { title: '示例会话' }),
    userEvent(2, '你好'),
    ev(3, 'tool/call', { turn: 1, step: 1, callId: 'call_a', name: 'search', arguments: '{"q":"x"}' }),
    ev(4, 'tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'call_a', content: [{ type: 'text', text: '结果A' }] },
    }),
    ev(5, 'assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] } }),
    ev(6, 'compaction/summary', {
      compactionId: 'c1',
      summary: [{ type: 'text', text: '历史摘要' }],
      shadowedRange: { start: 2, end: 5 },
      shadowedSeqs: [],
      shadowedTokenCount: 12,
      provider: 'p',
      model: 'm',
    }),
    ev(7, 'tool/call', { turn: 2, step: 0, callId: 'call_orphan', name: 'read', arguments: '{}' }),
    ev(8, 'tool/result', {
      turn: 2,
      step: 0,
      message: { role: 'tool', toolCallId: 'call_a', content: [{ type: 'text', text: '失败输出' }], isError: true },
    }),
  ];
}

// ---------------------------------------------------------------- 1. 事件列表

await check('listMessageEvents：五种类型映射到短名并按 seq 升序', async () => {
  const query = makeQuery(baseEvents());
  const rows = await listMessageEvents(query, 's1', DEFAULT_PICK_KINDS);
  assert.deepEqual(
    rows.map((row) => [row.seq, row.kind]),
    [
      [2, 'user'],
      [3, 'tool-call'],
      [4, 'tool-result'],
      [5, 'assistant'],
      [6, 'summary'],
      [7, 'tool-call'],
      [8, 'tool-result'],
    ],
  );
});

await check('listMessageEvents：非消息事件被丢弃（元数据事件不进返回）', async () => {
  const query = makeQuery(baseEvents());
  const rows = await listMessageEvents(query, 's1', DEFAULT_PICK_KINDS);
  assert.equal(rows.some((row) => row.seq === 1), false, 'session/title 不该出现');
  assert.equal(rows.length, 7);
});

await check('listMessageEvents：未开放的类型 forwardable=false，开放的为 true', async () => {
  const query = makeQuery(baseEvents());
  const rows = await listMessageEvents(query, 's1', ['user', 'summary']);
  const forwardable = rows.filter((row) => row.forwardable).map((row) => row.seq);
  assert.deepEqual(forwardable, [2, 6]);
  for (const row of rows) {
    assert.equal(row.forwardable, row.kind === 'user' || row.kind === 'summary');
  }
});

await check('listMessageEvents：kinds 全非法时回落默认，全部 forwardable', async () => {
  const query = makeQuery(baseEvents());
  const rows = await listMessageEvents(query, 's1', ['bogus']);
  assert.equal(rows.length, 7);
  assert.equal(rows.every((row) => row.forwardable === true), true);
});

// ---------------------------------------------------------------- 2. pickKinds 归一化

await check('normalizePickKinds：合法数组原样保留（顺序不变）', async () => {
  assert.deepEqual(normalizePickKinds(['summary', 'user']), ['summary', 'user']);
  assert.deepEqual(normalizePickKinds([...DEFAULT_PICK_KINDS]), [...DEFAULT_PICK_KINDS]);
});

await check('normalizePickKinds：未知项被过滤', async () => {
  assert.deepEqual(normalizePickKinds(['user', 'bogus', 42, null, 'tool-call']), ['user', 'tool-call']);
});

await check('normalizePickKinds：全部非法时回落默认', async () => {
  assert.deepEqual(normalizePickKinds(['bogus', 1, null]), [...DEFAULT_PICK_KINDS]);
  assert.deepEqual(normalizePickKinds([]), [...DEFAULT_PICK_KINDS]);
});

await check('normalizePickKinds：非数组回落默认', async () => {
  assert.deepEqual(normalizePickKinds('user'), [...DEFAULT_PICK_KINDS]);
  assert.deepEqual(normalizePickKinds(undefined), [...DEFAULT_PICK_KINDS]);
  assert.deepEqual(normalizePickKinds({ 0: 'user' }), [...DEFAULT_PICK_KINDS]);
});

// ---------------------------------------------------------------- 3. 取数

await check('readMessages：正常取数（顺序、角色、文本、字符与字节统计）', async () => {
  const query = makeQuery(baseEvents());
  const result = await readMessages(query, 's1', [2, 5], { kinds: DEFAULT_PICK_KINDS, readBytes: 65536 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items, [
    { seq: 2, kind: 'user', role: 'user', text: '你好', chars: 2, bytes: 6 },
    { seq: 5, kind: 'assistant', role: 'assistant', text: '回答', chars: 2, bytes: 6 },
  ]);
  assert.equal(result.totalChars, 4);
  assert.equal(result.totalBytes, 12);
  assert.equal(result.omitted, 0);
});

await check('readMessages：用户给出的 seq 顺序优先', async () => {
  const query = makeQuery(baseEvents());
  const result = await readMessages(query, 's1', [5, 2], { kinds: DEFAULT_PICK_KINDS, readBytes: 65536 });
  assert.deepEqual(result.items.map((item) => item.seq), [5, 2]);
});

await check('readMessages：seq 不存在时报错并给出会话最大 seq', async () => {
  const query = makeQuery(baseEvents());
  const result = await readMessages(query, 's1', [99], { kinds: DEFAULT_PICK_KINDS, readBytes: 65536 });
  assert.equal(result.ok, false);
  assert.match(result.error, /该 seq 不存在/);
  assert.match(result.error, /最大 seq 为 8/);
});

await check('readMessages：元数据事件不是可转发消息', async () => {
  const query = makeQuery(baseEvents());
  const result = await readMessages(query, 's1', [1], { kinds: DEFAULT_PICK_KINDS, readBytes: 65536 });
  assert.equal(result.ok, false);
  assert.match(result.error, /#1/);
  assert.match(result.error, /session\/title/);
});

await check('readMessages：类型未在 pickKinds 开放时报错并提示 pickKinds', async () => {
  const query = makeQuery(baseEvents());
  const result = await readMessages(query, 's1', [3], { kinds: ['user'], readBytes: 65536 });
  assert.equal(result.ok, false);
  assert.match(result.error, /#3/);
  assert.match(result.error, /tool-call/);
  assert.match(result.error, /pickKinds/);
});

await check('readMessages：tool/call 自动补上配对的 tool/result（paired=true）', async () => {
  const query = makeQuery(baseEvents());
  const result = await readMessages(query, 's1', [3], { kinds: ['tool-call'], readBytes: 65536 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((item) => [item.seq, item.kind, item.paired === true]), [
    [3, 'tool-call', false],
    [4, 'tool-result', true],
  ]);
  assert.equal(result.items[0].text, '工具 search 参数：{"q":"x"}');
  assert.equal(result.items[0].role, 'tool');
  assert.equal(result.items[1].text, '结果A');
});

await check('readMessages：tool/result 自动补上配对的 tool/call（配对项紧随其后）', async () => {
  const query = makeQuery(baseEvents());
  const result = await readMessages(query, 's1', [4], { kinds: ['tool-result'], readBytes: 65536 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((item) => [item.seq, item.paired === true]), [
    [4, false],
    [3, true],
  ]);
  assert.equal(result.items[1].kind, 'tool-call');
});

await check('readMessages：配对项不受 pickKinds 限制', async () => {
  const query = makeQuery(baseEvents());
  const result = await readMessages(query, 's1', [3], { kinds: ['tool-call'], readBytes: 65536 });
  assert.equal(result.ok, true);
  const paired = result.items.find((item) => item.paired === true);
  assert.equal(paired.kind, 'tool-result', 'tool-result 未开放也必须带上');
});

await check('readMessages：配对缺失时不报错', async () => {
  const query = makeQuery(baseEvents());
  const result = await readMessages(query, 's1', [7], { kinds: DEFAULT_PICK_KINDS, readBytes: 65536 });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].seq, 7);
  assert.equal(result.items[0].paired, undefined);
});

await check('readMessages：用户同时选中 call 与 result 时不重复、都按用户项处理', async () => {
  const query = makeQuery(baseEvents());
  const result = await readMessages(query, 's1', [3, 4], { kinds: DEFAULT_PICK_KINDS, readBytes: 65536 });
  assert.deepEqual(result.items.map((item) => [item.seq, item.paired === true]), [
    [3, false],
    [4, false],
  ]);
});

await check('readMessages：tool/result 的 isError 标注失败', async () => {
  const query = makeQuery(baseEvents());
  const result = await readMessages(query, 's1', [8], { kinds: DEFAULT_PICK_KINDS, readBytes: 65536 });
  assert.equal(result.ok, true);
  const item = result.items.find((entry) => entry.seq === 8);
  assert.match(item.text, /^（工具执行失败）/);
  assert.match(item.text, /失败输出/);
});

await check('readMessages：压缩摘要取 summary 文本', async () => {
  const query = makeQuery(baseEvents());
  const result = await readMessages(query, 's1', [6], { kinds: DEFAULT_PICK_KINDS, readBytes: 65536 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items, [
    { seq: 6, kind: 'summary', role: 'summary', text: '历史摘要', chars: 4, bytes: 12 },
  ]);
});

await check('readMessages：非文本块用占位符（图片 / 文件）', async () => {
  const events = [
    userEvent(2, '看图', [{ type: 'reasoning', text: '内部思考' }, { type: 'image', attachment: {} }, { type: 'file', attachment: {} }]),
  ];
  const query = makeQuery(events);
  const result = await readMessages(query, 's1', [2], { kinds: DEFAULT_PICK_KINDS, readBytes: 65536 });
  assert.equal(result.ok, true);
  assert.equal(result.items[0].text, '看图{图片}{文件}');
});

await check('readMessages：预算不足时从尾部丢弃并计入 omitted', async () => {
  const events = [userEvent(2, 'a'.repeat(100)), userEvent(3, 'b'.repeat(100)), userEvent(4, 'c'.repeat(100)), userEvent(5, 'd'.repeat(100))];
  const query = makeQuery(events);
  const result = await readMessages(query, 's1', [2, 3, 4, 5], { kinds: DEFAULT_PICK_KINDS, readBytes: 250 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((item) => item.seq), [2, 3]);
  assert.equal(result.omitted, 2);
  assert.equal(result.totalBytes, 200);
  assert.equal(result.totalChars, 200);
});

await check('readMessages：单条超过 8 KB 时按边界截断且不产生 U+FFFD', async () => {
  const query = makeQuery([userEvent(2, '汉'.repeat(5000))]);
  const result = await readMessages(query, 's1', [2], { kinds: DEFAULT_PICK_KINDS, readBytes: 65536 });
  assert.equal(result.ok, true);
  const item = result.items[0];
  assert.equal(item.truncated, true);
  assert.equal(item.bytes <= 8192, true, '截断后不超过 8192 字节');
  assert.equal(item.bytes, 8190, '8192 字节内可容纳 2730 个汉字');
  assert.equal(item.chars, 2730);
  assert.equal(item.text.includes('\uFFFD'), false, '不得产生替换字符');
  assert.equal(bytesOf(item.text), item.bytes);
  assert.equal(result.totalBytes, 8190);
});

await check('readMessages：字符数与字节数分别统计（中文 / ASCII / emoji）', async () => {
  const events = [userEvent(2, '你好'), userEvent(3, 'abc'), userEvent(4, '😀')];
  const query = makeQuery(events);
  const result = await readMessages(query, 's1', [2, 3, 4], { kinds: DEFAULT_PICK_KINDS, readBytes: 65536 });
  assert.deepEqual(
    result.items.map((item) => [item.chars, item.bytes]),
    [
      [2, 6],
      [3, 3],
      [2, 4],
    ],
  );
  assert.equal(result.totalChars, 7);
  assert.equal(result.totalBytes, 13);
});

// ---------------------------------------------------------------- 4. 摘要

function fakeLlm(chunks) {
  const state = { calls: 0, lastOptions: undefined };
  return {
    state,
    stream(request) {
      state.calls += 1;
      state.lastOptions = request;
      async function* generate() {
        for (const chunk of chunks) yield chunk;
      }
      return generate();
    },
  };
}

const sampleItems = [
  { seq: 2, kind: 'user', role: 'user', text: '问一个问题', chars: 5, bytes: 15 },
  { seq: 3, kind: 'tool-result', role: 'tool', text: '工具输出', chars: 4, bytes: 12, paired: true },
];

await check('summarizeMessages：累积 text-delta 增量', async () => {
  const llm = fakeLlm([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '要点' },
    { type: 'text-delta', index: 0, text: '一' },
    { type: 'reasoning-delta', index: 0, text: '不该出现' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '要点一' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const result = await summarizeMessages({ llm, provider: 'p', model: 'm' }, { items: sampleItems, sessionLabel: '会话A', signal: new AbortController().signal });
  assert.deepEqual(result, { ok: true, text: '要点一' });
  const request = llm.state.lastOptions;
  assert.equal(request.provider, 'p');
  assert.equal(request.model, 'm');
  assert.equal(request.maxTokens, SUMMARY_MAX_TOKENS);
  assert.equal(typeof request.system, 'string');
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, 'user');
  assert.equal(request.messages[0].content[0].type, 'text');
  assert.match(request.messages[0].content[0].text, /seq #2/);
  assert.match(request.messages[0].content[0].text, /seq #3/);
  assert.match(request.messages[0].content[0].text, /工具/);
});

await check('summarizeMessages：maxTokens 可覆盖默认值', async () => {
  const llm = fakeLlm([{ type: 'text-delta', index: 0, text: 'x' }]);
  const result = await summarizeMessages({ llm, provider: 'p', model: 'm' }, { items: sampleItems, sessionLabel: 'A', maxTokens: 128, signal: new AbortController().signal });
  assert.equal(result.ok, true);
  assert.equal(llm.state.lastOptions.maxTokens, 128);
});

await check('summarizeMessages：空流报「摘要返回为空」', async () => {
  const empty = fakeLlm([]);
  const result = await summarizeMessages({ llm: empty, provider: 'p', model: 'm' }, { items: sampleItems, sessionLabel: 'A', signal: new AbortController().signal });
  assert.deepEqual(result, { ok: false, error: '摘要返回为空' });
});

await check('summarizeMessages：只有空白增量也报「摘要返回为空」', async () => {
  const blank = fakeLlm([{ type: 'text-delta', index: 0, text: '   \n\t ' }]);
  const result = await summarizeMessages({ llm: blank, provider: 'p', model: 'm' }, { items: sampleItems, sessionLabel: 'A', signal: new AbortController().signal });
  assert.deepEqual(result, { ok: false, error: '摘要返回为空' });
});

await check('summarizeMessages：上游抛错被传播为中文错误', async () => {
  const llm = {
    stream() {
      async function* generate() {
        yield { type: 'text-delta', index: 0, text: '半' };
        throw new Error('上游 500');
      }
      return generate();
    },
  };
  const result = await summarizeMessages({ llm, provider: 'p', model: 'm' }, { items: sampleItems, sessionLabel: 'A', signal: new AbortController().signal });
  assert.equal(result.ok, false);
  assert.match(result.error, /摘要调用失败/);
  assert.match(result.error, /上游 500/);
});

await check('summarizeMessages：流创建即抛错也被传播', async () => {
  const llm = {
    stream() {
      throw new Error('路由不可用');
    },
  };
  const result = await summarizeMessages({ llm, provider: 'p', model: 'm' }, { items: sampleItems, sessionLabel: 'A', signal: new AbortController().signal });
  assert.equal(result.ok, false);
  assert.match(result.error, /路由不可用/);
});

await check('summarizeMessages：已中止的 signal 提前返回且不发起调用', async () => {
  const controller = new AbortController();
  controller.abort();
  const llm = fakeLlm([{ type: 'text-delta', index: 0, text: '不该调用' }]);
  const result = await summarizeMessages({ llm, provider: 'p', model: 'm' }, { items: sampleItems, sessionLabel: 'A', signal: controller.signal });
  assert.equal(result.ok, false);
  assert.match(result.error, /取消/);
  assert.equal(llm.state.calls, 0, '已中止时不得调用模型');
});

await check('summarizeMessages：流中途中止返回取消错误', async () => {
  const controller = new AbortController();
  const llm = {
    stream() {
      async function* generate() {
        yield { type: 'text-delta', index: 0, text: '开' };
        controller.abort();
        yield { type: 'text-delta', index: 0, text: '头' };
      }
      return generate();
    },
  };
  const result = await summarizeMessages({ llm, provider: 'p', model: 'm' }, { items: sampleItems, sessionLabel: 'A', signal: controller.signal });
  assert.equal(result.ok, false);
  assert.match(result.error, /取消/);
});

await check('summarizeMessages：没有可摘要消息时报错', async () => {
  const llm = fakeLlm([{ type: 'text-delta', index: 0, text: 'x' }]);
  const result = await summarizeMessages({ llm, provider: 'p', model: 'm' }, { items: [], sessionLabel: 'A', signal: new AbortController().signal });
  assert.equal(result.ok, false);
  assert.match(result.error, /没有可摘要的消息/);
  assert.equal(llm.state.calls, 0);
});

// 回归：真实日志里 user/message 的 data 就是 UserMessage 本身（无 message 包装），
// 早先按 assistant 的形态读取会把它整条判成空内容。
await check('readMessages：user/message 的真实结构（content 直接挂在 data 上）', async () => {
  const events = [
    { seq: 1, type: 'user/message', time: 1 },
    { seq: 2, type: 'assistant/message', time: 2 },
  ];
  const bodies = {
    1: {
      seq: 1,
      type: 'user/message',
      time: 1,
      data: {
        content: [{ type: 'text', text: '用户直接问的问题' }],
        source: { kind: 'user' },
        role: 'user',
        id: 'm1',
      },
    },
    2: {
      seq: 2,
      type: 'assistant/message',
      time: 2,
      data: {
        turn: 1,
        step: 1,
        message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '助手的回答' }], source: { kind: 'model' } },
        stream: [],
      },
    },
  };
  const query = {
    listEvents: async () => events,
    readEvent: async ({ seq }) => ({ target: bodies[seq], events: [bodies[seq]] }),
  };
  const result = await readMessages(query, 's1', [1, 2], { kinds: DEFAULT_PICK_KINDS, readBytes: 65536 });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 2);
  assert.match(result.items[0].text, /用户直接问的问题/);
  assert.ok(result.items[0].bytes > 0, 'user 消息不得被判为空');
  assert.match(result.items[1].text, /助手的回答/);
});

// ---- 列表摘要不得露出 JSON 噪音 ----
await check('previewMessages：tool-call 摘要取 description 而非原始 JSON', async () => {
  const events = [{ seq: 1, type: 'tool/call', time: 1 }];
  const bodies = {
    1: {
      seq: 1,
      type: 'tool/call',
      time: 1,
      data: {
        callId: 'c1',
        name: 'run_code',
        arguments: JSON.stringify({ code: 'const sh = await tools.pwsh({});', description: '探测 DSH 环境变量与数据目录' }),
      },
    },
  };
  const query = { listEvents: async () => events, readEvent: async ({ seq }) => ({ target: bodies[seq], events: [bodies[seq]] }) };
  const previews = await previewMessages(query, 's', [{ seq: 1, kind: 'tool-call', forwardable: true }]);
  const pv = previews.get(1);
  assert.ok(pv);
  assert.match(pv.summary, /工具 run_code：探测 DSH 环境变量与数据目录/);
  assert.doesNotMatch(pv.summary, /"code"/, '摘要不得包含原始 JSON 前缀');
  assert.ok(pv.bytes > 0, '字节数仍按完整体量计算');
});

await check('previewMessages：摘要优先 command，无白名单字段时取首个字符串', async () => {
  const events = [
    { seq: 1, type: 'tool/call', time: 1 },
    { seq: 2, type: 'tool/call', time: 2 },
    { seq: 3, type: 'tool/call', time: 3 },
  ];
  const bodies = {
    1: { seq: 1, type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm run build', timeoutMs: 1000 }) } },
    2: { seq: 2, type: 'tool/call', data: { callId: 'c2', name: 'weird', arguments: JSON.stringify({ alpha: '第一个字符串', beta: 'b' }) } },
    3: { seq: 3, type: 'tool/call', data: { callId: 'c3', name: 'broken', arguments: 'not json at all' } },
  };
  const query = { listEvents: async () => events, readEvent: async ({ seq }) => ({ target: bodies[seq], events: [bodies[seq]] }) };
  const previews = await previewMessages(query, 's', events.map((e) => ({ seq: e.seq, kind: 'tool-call', forwardable: true })));
  assert.match(previews.get(1).summary, /工具 pwsh：npm run build/);
  assert.match(previews.get(2).summary, /工具 weird：第一个字符串/);
  assert.match(previews.get(3).summary, /工具 broken：not json at all/);
});

await check('previewMessages：tool-result 跳过噪音行、附行数、标注失败', async () => {
  const events = [
    { seq: 1, type: 'tool/result', time: 1 },
    { seq: 2, type: 'tool/result', time: 2 },
    { seq: 3, type: 'tool/result', time: 3 },
  ];
  const bodies = {
    1: {
      seq: 1,
      type: 'tool/result',
      data: { message: { content: [{ type: 'text', text: '\n\n---\n===\n磁盘占用 12 GB\n---\n' }], isError: false } },
    },
    2: {
      seq: 2,
      type: 'tool/result',
      data: { message: { content: [{ type: 'text', text: '命令失败：权限不足' }], isError: true } },
    },
    3: {
      seq: 3,
      type: 'tool/result',
      data: { message: { content: [{ type: 'text', text: '---\n===\n' }], isError: false } },
    },
  };
  const query = { listEvents: async () => events, readEvent: async ({ seq }) => ({ target: bodies[seq], events: [bodies[seq]] }) };
  const previews = await previewMessages(query, 's', events.map((e) => ({ seq: e.seq, kind: 'tool-result', forwardable: true })));
  assert.match(previews.get(1).summary, /磁盘占用 12 GB \(4行\)/, '必须跳过空行与分隔行');
  assert.match(previews.get(2).summary, /（失败）命令失败：权限不足/, '失败要标注');
  assert.match(previews.get(3).summary, /空输出/, '全噪音视为空输出');
});

console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) process.exitCode = 1;
