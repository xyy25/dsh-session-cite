/**
 * session_read 的独立可运行测试：node test/tool.js
 * 断言用 node:assert/strict，不引入测试框架；任一用例失败则 exitCode = 1。
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  SESSION_READ_TOOL_NAME,
  SESSION_READ_DESCRIPTION,
  renderSessionRead,
  registerSessionRead
} from '../src/session-read.ts';

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

function assertText(text) {
  assert.equal(typeof text, 'string', '返回的 text 必须是字符串');
  return text;
}

function makeEvent(seq, text) {
  return {
    seq,
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] }
  };
}

function makeAssistantEvent(seq, text) {
  return { seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } };
}

function makeDeps(overrides) {
  return {
    readBytes: 4096,
    readSurface: async (sessionId) => ({ session: { id: sessionId }, capturedThroughSeq: 1, events: [] }),
    ...overrides
  };
}

/** 用一个假 ctx 拿到被注册的工具定义。 */
function captureRegistration(deps) {
  const registry = { definition: null, disposerCalls: 0, disposer: null };
  const disposer = registerSessionRead(
    {
      tools: {
        register(definition) {
          registry.definition = definition;
          const inner = () => {
            registry.disposerCalls += 1;
          };
          registry.disposer = inner;
          return inner;
        }
      }
    },
    deps
  );
  assert.equal(registry.definition === null, false, 'registerSessionRead 必须调用 ctx.tools.register');
  assert.equal(typeof disposer, 'function', 'registerSessionRead 必须把 disposer 交给调用方');
  return { registry, disposer };
}

console.log('session_read 测试开始');

await check('头部含标题、untrusted 警告、sessionId 与元信息', () => {
  const out = renderSessionRead({
    sessionId: 'session-abc',
    capturedThroughSeq: 42,
    items: [{ seq: 1, role: 'user', text: '你好' }],
    maxBytes: 4096
  });
  const text = assertText(out.text);
  assert.match(text, /## Referenced session \(session_read\)/);
  assert.match(text, /不可信/);
  assert.match(text, /只读快照/);
  assert.ok(text.includes('session-abc'), '头部必须含 sessionId');
  assert.ok(text.includes('42'), '头部必须含 capturedThroughSeq');
  assert.match(text, /- truncation: none/u);
  assert.ok(text.includes('[1] user: 你好'), '正文必须带 seq/role 前缀');
  assert.equal(out.truncated, false);
  assert.equal(out.omittedBytes, 0);
  assert.ok(bytesOf(text) <= 4096);
});

await check('degraded 非空时追加降级说明行', () => {
  const out = renderSessionRead({
    sessionId: 'session-degraded',
    items: [{ text: '片段' }],
    maxBytes: 4096,
    degraded: '过滤器不可用'
  });
  assert.match(out.text, /说明/);
  assert.ok(out.text.includes('过滤器不可用'));
});

await check('未截断时 truncated=false 且没有 omittedBytes 丢失', () => {
  const out = renderSessionRead({
    sessionId: 'session-small',
    items: [{ seq: 1, role: 'user', text: '短消息' }, { seq: 2, role: 'assistant', text: '短回复' }],
    maxBytes: 4096
  });
  assert.equal(out.truncated, false);
  assert.equal(out.omittedBytes, 0);
  assert.ok(bytesOf(out.text) <= 4096);
});

await check('截断时 truncated=true、omittedBytes>0 且不超字节上限', () => {
  const items = Array.from({ length: 20 }, (_unused, index) => ({
    seq: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: '第' + (index + 1) + '段：' + '内容'.repeat(30)
  }));
  const out = renderSessionRead({ sessionId: 'session-cut', items, maxBytes: 700 });
  assert.equal(out.truncated, true);
  assert.ok(out.omittedBytes > 0, 'omittedBytes 必须大于 0');
  assert.ok(bytesOf(out.text) <= 700, '输出必须不超过 maxBytes，实际 ' + bytesOf(out.text));
  assert.ok(out.text.includes('\uFFFD') === false, '按字节切片不允许产生替换字符');
  assert.match(out.text, /- truncation: truncated, omittedBytes=\d+/u);
});

await check('极端小预算仍然守住字节上限', () => {
  const items = [{ seq: 1, role: 'user', text: '内容'.repeat(80) }];
  for (const maxBytes of [1, 12, 50, 120]) {
    const out = renderSessionRead({ sessionId: 'session-tiny', items, maxBytes });
    assert.ok(bytesOf(out.text) <= maxBytes, 'maxBytes=' + maxBytes + ' 时输出 ' + bytesOf(out.text) + ' 字节');
    assert.equal(out.truncated, true);
  }
});

await check('无 query：从尾部取最近事件，累积到字节预算为止', async () => {
  const events = [];
  for (let index = 1; index <= 8; index += 1) {
    events.push(makeEvent(index, '最早一条第' + index + '段：' + '内容'.repeat(20)));
  }
  events.push(makeAssistantEvent(9, '最后一条：最近的结论在此'));
  const { registry } = captureRegistration(
    makeDeps({
      readBytes: 900,
      readSurface: async (sessionId) => ({ session: { id: sessionId }, capturedThroughSeq: 9, events })
    })
  );
  const out = await registry.definition.execute({ sessionId: 'session-tail' }, { agent: { id: 'session-self' } });
  assert.equal(typeof out, 'object');
  assert.equal(typeof out.text, 'string');
  assert.ok(out.text.includes('最后一条：最近的结论在此'), '必须包含最新的那条事件');
  assert.ok(out.text.includes('最早一条第1段') === false, '最早的条目应被尾部窗口丢弃');
  assert.match(out.text, /本次只返回最近的/);
  assert.ok(out.text.includes('条未纳入'), '窗口裁剪必须在说明行里如实告知');
  assert.ok(bytesOf(out.text) <= 900, '输出必须不超过 deps.readBytes，实际 ' + bytesOf(out.text));
  assert.ok(out.truncated === false || out.omittedBytes > 0);
});

await check('有 query 且 filterEvents 可用：把谓词交给过滤器并使用命中项', async () => {
  let received = null;
  let surfaceCalls = 0;
  const { registry } = captureRegistration(
    makeDeps({
      readSurface: async () => {
        surfaceCalls += 1;
        throw new Error('有过滤器时不应读取整份快照');
      },
      filterEvents: async (sessionId, filters) => {
        received = { sessionId, filters };
        return [{ seq: 5, role: 'assistant', text: '命中：构建命令是 tsc -p tsconfig.json' }];
      }
    })
  );
  const out = await registry.definition.execute({ sessionId: 'session-q', query: '构建' }, {});
  assert.ok(received !== null, 'filterEvents 必须被调用');
  assert.equal(received.sessionId, 'session-q');
  assert.ok(Array.isArray(received.filters) && received.filters.length === 1, 'filters 必须是非空数组');
  // 谓词形状取自 SessionEventResultFilter 的 text 分支：只接受一个 text 字段。
  assert.equal(received.filters[0].text, '构建');
  assert.equal(received.filters[0].kind, 'text');
  assert.equal(surfaceCalls, 0, '有过滤器时不应再读整份快照');
  assert.ok(out.text.includes('命中：构建命令'), '命中项必须进入正文');
  assert.match(out.text, /- truncation: none/u);
  assert.ok(out.text.includes('降级说明') === false);
});

await check('filterEvents 缺失：降级为本地子串过滤并在 degraded 中说明', async () => {
  const events = [makeEvent(1, '无关内容：天气不错'), makeAssistantEvent(2, '构建使用 tsc')];
  const { registry } = captureRegistration(
    makeDeps({
      readSurface: async (sessionId) => ({ session: { id: sessionId }, capturedThroughSeq: 2, events })
    })
  );
  const out = await registry.definition.execute({ sessionId: 'session-d', query: '构建' }, {});
  assert.match(out.text, /说明/);
  assert.ok(out.text.includes('未提供会话事件过滤器'), '降级原因必须可见');
  assert.match(out.text, /降级/u);
  assert.ok(out.text.includes('构建使用 tsc'), '本地过滤后必须保留命中项');
  assert.ok(out.text.includes('天气不错') === false, '本地过滤后必须丢弃未命中项');
});

await check('filterEvents 抛错：同样降级且原因里带上失败信息', async () => {
  const events = [makeEvent(1, '目标片段：关键字 命中')];
  const { registry } = captureRegistration(
    makeDeps({
      readSurface: async (sessionId) => ({ session: { id: sessionId }, capturedThroughSeq: 1, events }),
      filterEvents: async () => {
        throw new Error('session-query 不可用');
      }
    })
  );
  const out = await registry.definition.execute({ sessionId: 'session-broken', query: '命中' }, {});
  assert.match(out.text, /说明/);
  assert.match(out.text, /降级/u);
  assert.ok(out.text.includes('session-query 不可用'), '降级原因必须包含原始错误');
  assert.ok(out.text.includes('目标片段'));
});

await check('maxBytes 参数被 deps.readBytes 硬上限压制', async () => {
  const events = Array.from({ length: 12 }, (_unused, index) => makeEvent(index + 1, '条目' + index + '：' + '内容'.repeat(25)));
  const { registry } = captureRegistration(
    makeDeps({
      readBytes: 620,
      readSurface: async (sessionId) => ({ session: { id: sessionId }, capturedThroughSeq: 12, events })
    })
  );
  const out = await registry.definition.execute({ sessionId: 'session-cap', maxBytes: 1000000 }, {});
  assert.ok(bytesOf(out.text) <= 620, '实际 ' + bytesOf(out.text));
});

await check('sessionId 缺失或为空时抛出中文错误', async () => {
  const { registry } = captureRegistration(makeDeps({}));
  await assert.rejects(() => registry.definition.execute({}, {}), /sessionId/u);
  await assert.rejects(() => registry.definition.execute({ sessionId: '   ' }, {}), /sessionId/u);
  await assert.rejects(() => registry.definition.execute(null, {}), /sessionId/u);
});

await check('读取快照失败时抛出带中文原因的错误且不吞异常', async () => {
  const { registry } = captureRegistration(
    makeDeps({
      readSurface: async () => {
        throw new Error('磁盘上的会话日志已损坏');
      }
    })
  );
  await assert.rejects(
    () => registry.definition.execute({ sessionId: 'session-bad' }, {}),
    (error) => error instanceof Error && /读取会话 session-bad 失败/u.test(error.message) && /磁盘上的会话日志已损坏/u.test(error.message)
  );
});

await check('不能读取当前会话自身', async () => {
  const { registry } = captureRegistration(makeDeps({}));
  await assert.rejects(
    () => registry.definition.execute({ sessionId: 'session-self' }, { agent: { id: 'session-self' } }),
    /不能读取当前会话自身/u
  );
});

await check('工具定义形状：name/description/parameters.required 与 disposer 可用', async () => {
  const { registry, disposer } = captureRegistration(makeDeps({}));
  const definition = registry.definition;
  assert.equal(definition.name, 'session_read');
  assert.equal(definition.name, SESSION_READ_TOOL_NAME);
  assert.equal(definition.description, SESSION_READ_DESCRIPTION);
  assert.equal(typeof definition.description, 'string');
  assert.ok(definition.description.length > 0, 'description 不能为空');
  assert.match(definition.description, /只读|不可信/u);
  assert.equal(definition.parameters.type, 'object');
  // 参数 schema 必须与 defineTool 的编译产物一致：不声明 additionalProperties，
  // 否则导出的 SDK 类型会禁止额外字段（对照 dsh 自身 parameterSchemaSpecToJsonSchema）。
  assert.equal(definition.parameters.additionalProperties, undefined);
  assert.deepEqual(definition.parameters.required, ['sessionId']);
  assert.equal(definition.parameters.properties.sessionId.type, 'string');
  assert.equal(definition.parameters.properties.query.type, 'string');
  assert.equal(definition.parameters.properties.maxBytes.type, 'number');
  assert.equal(definition.output.schema.type, 'object');
  assert.deepEqual(definition.output.schema.required, ['text', 'truncated', 'omittedBytes']);
  const rendered = definition.output.render({}, { text: '渲染文本', truncated: false, omittedBytes: 0 });
  assert.ok(Array.isArray(rendered));
  assert.equal(rendered[0].type, 'text');
  assert.equal(rendered[0].text, '渲染文本');
  assert.equal(typeof definition.execute, 'function');
  const out = await definition.execute({ sessionId: 'session-registered' }, {});
  assert.equal(typeof out, 'object');
  assert.equal(typeof out.text, 'string');
  assert.equal(typeof out.truncated, 'boolean');
  assert.equal(typeof out.omittedBytes, 'number');
  assert.equal(registry.disposerCalls, 0);
  disposer();
  assert.equal(registry.disposerCalls, 1, 'disposer 必须可调用');
});

await check('user/message 中非 user 来源的注入上下文不进入正文', async () => {
  const events = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'system' }, content: [{ type: 'text', text: '注入的系统提示' }] } },
    makeEvent(2, '真正的用户消息'),
    { seq: 3, type: 'tool/result', data: { content: [{ type: 'text', text: '工具输出' }] } }
  ];
  const { registry } = captureRegistration(
    makeDeps({ readSurface: async (sessionId) => ({ session: { id: sessionId }, capturedThroughSeq: 3, events }) })
  );
  const out = await registry.definition.execute({ sessionId: 'session-filter-src' }, {});
  assert.ok(out.text.includes('真正的用户消息'));
  assert.ok(out.text.includes('注入的系统提示') === false);
  assert.ok(out.text.includes('工具输出') === false);
});

console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) process.exitCode = 1;
