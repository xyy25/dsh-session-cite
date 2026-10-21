// 转发面板的树状会话列表：工作区 → 主会话 → 子代理（node test/session-tree.js）

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
await import("../client/client.js?session-tree");
assert.ok(captured !== null, "客户端 bundle 必须注册到 window.__ModuleLoader__");
const fakeReact = { useCallback: (fn) => fn, useEffect: () => {}, useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }), useMemo: (fn) => fn() };
const mod = captured.factory((spec) => {
  if (spec === "react") return fakeReact;
  throw new Error("unexpected require: " + spec);
});

const { buildSessionTree, filterOptions, parseInventory, ARCHIVED_ID, UNGROUPED_ID } = mod;
assert.equal(typeof buildSessionTree, "function", "必须导出 buildSessionTree");
assert.equal(typeof filterOptions, "function", "必须导出 filterOptions");

/** 造一个会话选项。 */
function option(id, label, extra) {
  return { id, label, ...(extra ?? {}) };
}

/** 造一份清单。 */
function inventoryOf(spec) {
  return parseInventory(spec);
}

// ---------------- 1. parseInventory ----------------

check("parseInventory：解析工作区与行级信息", () => {
  const inventory = inventoryOf({
    generatedAt: 1,
    workspaces: [
      { id: "ws-1", title: "dsh-dev", path: "G:\\dsh-dev", sessionIds: ["a"] },
      { id: "ws-2", title: "My Piano Unity", path: "E:\\unity", sessionIds: [] },
    ],
    rows: [
      { id: "a", workspaceIds: ["ws-1"], childIds: ["a-sub"], archived: false },
      { id: "a-sub", workspaceIds: ["ws-1"], childIds: [], archived: false },
      { id: "b", workspaceIds: [], childIds: [], archived: true },
    ],
    archivedSessionIds: ["b"],
  });
  assert.equal(inventory.workspaces.length, 2);
  assert.equal(inventory.workspaces[0].title, "dsh-dev");
  assert.deepEqual(inventory.bySession.get("a").childIds, ["a-sub"]);
  assert.equal(inventory.bySession.get("b").archived, true);
  assert.deepEqual([...inventory.archivedIds], ["b"]);
});

check("parseInventory：坏形状一律退化为空，不抛错", () => {
  assert.equal(inventoryOf(undefined).workspaces.length, 0);
  assert.equal(inventoryOf(null).bySession.size, 0);
  assert.equal(inventoryOf({ rows: "nope", workspaces: 42 }).bySession.size, 0);
  assert.equal(inventoryOf({ archivedSessionIds: [1, "", null, "ok"] }).archivedIds.size, 1);
});

// ---------------- 2. 三级树 ----------------

const INVENTORY = inventoryOf({
  workspaces: [
    { id: "ws-1", title: "dsh-dev", path: "G:/dsh-dev", sessionIds: [] },
    { id: "ws-2", title: "Piano", path: "E:/piano", sessionIds: [] },
  ],
  rows: [
    { id: "a", workspaceIds: ["ws-1"], childIds: ["a-sub1", "a-sub2"], archived: false },
    { id: "a-sub1", workspaceIds: ["ws-1"], childIds: [], archived: false },
    { id: "a-sub2", workspaceIds: ["ws-1"], childIds: [], archived: false },
    { id: "b", workspaceIds: ["ws-2"], childIds: [], archived: false },
    { id: "c", workspaceIds: [], childIds: [], archived: false },
    { id: "d", workspaceIds: ["ws-1"], childIds: [], archived: true },
  ],
  archivedSessionIds: ["d"],
});

const OPTIONS = [
  option("a", "主会话 A · aaaa", { parentId: undefined }),
  option("a-sub1", "子代理 1 · s001", { parentId: "a", origin: "subagent" }),
  option("a-sub2", "子代理 2 · s002", { parentId: "a", origin: "subagent" }),
  option("b", "主会话 B · bbbb"),
  option("c", "无工作区 · cccc"),
  option("d", "归档的 · dddd", { archived: true }),
];

check("buildSessionTree：两级分组 + 子代理沉到第三级", () => {
  const groups = buildSessionTree(OPTIONS, INVENTORY);
  assert.deepEqual(groups.map((group) => group.title), ["dsh-dev", "Piano", "未分组", "已归档"]);

  const dsh = groups[0];
  assert.equal(dsh.nodes.length, 1, "子代理不得出现在第二级");
  assert.deepEqual(dsh.nodes[0].children.map((child) => child.id), ["a-sub1", "a-sub2"]);
  assert.equal(dsh.count, 3, "计数应含主会话与子代理");
});

check("buildSessionTree：归档会话单独成组并排最后", () => {
  const groups = buildSessionTree(OPTIONS, INVENTORY);
  const last = groups[groups.length - 1];
  assert.equal(last.id, ARCHIVED_ID);
  assert.deepEqual(last.nodes.map((node) => node.option.id), ["d"]);
});

check("buildSessionTree：没有工作区归属的落进未分组", () => {
  const groups = buildSessionTree(OPTIONS, INVENTORY);
  const ungrouped = groups.find((group) => group.id === UNGROUPED_ID);
  assert.ok(ungrouped, "必须存在未分组");
  assert.deepEqual(ungrouped.nodes.map((node) => node.option.id), ["c"]);
});

check("buildSessionTree：清单不可用时退化为未分组，不丢会话", () => {
  const groups = buildSessionTree(OPTIONS, inventoryOf(null));
  // 归档标记同时来自选项本身，所以清单缺失时仍会分出「已归档」组。
  assert.equal(groups.length, 2, "未分组 + 已归档");
  const ungrouped = groups.find((group) => group.id === UNGROUPED_ID);
  assert.ok(ungrouped, "没有清单时所有活动会话都进未分组");
  assert.deepEqual(ungrouped.nodes.map((node) => node.option.id), ["a", "b", "c"]);
  const archived = groups.find((group) => group.id === ARCHIVED_ID);
  assert.equal(archived.nodes.length, 1, "归档标记来自选项本身，不依赖清单");
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  assert.equal(total, 6, "6 个会话一个都不能丢");
});

check("buildSessionTree：分支会话带 parentId 但仍是主会话（并列，不嵌套）", () => {
  const options = [
    option("origin", "源会话 · aaaa"),
    option("branch", "分支出来的 · bbbb", { parentId: "origin" }),
    option("real-sub", "真子代理 · cccc", { parentId: "origin", origin: "subagent" }),
  ];
  const groups = buildSessionTree(options, inventoryOf(null));
  const nodes = groups[0].nodes;
  assert.deepEqual(
    nodes.map((node) => node.option.id),
    ["origin", "branch"],
    "分支会话必须与源会话并列，不能嵌进源会话下面",
  );
  assert.deepEqual(
    nodes[0].children.map((child) => child.id),
    ["real-sub"],
    "只有 origin=subagent 才折叠到第三级",
  );
});

check("buildSessionTree：子代理的父会话不在列表里时提升为顶层", () => {
  const orphan = [option("x", "孤儿 · xxxx", { parentId: "missing-parent", origin: "subagent" })];
  const groups = buildSessionTree(orphan, INVENTORY);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].nodes[0].option.id, "x", "不能因为父会话缺席就丢掉它");
});

check("buildSessionTree：空输入返回空数组", () => {
  assert.deepEqual(buildSessionTree([], INVENTORY), []);
});

// ---------------- 3. 搜索 ----------------

check("filterOptions：空关键词原样返回", () => {
  assert.equal(filterOptions(OPTIONS, "", INVENTORY).length, OPTIONS.length);
  assert.equal(filterOptions(OPTIONS, "   ", INVENTORY).length, OPTIONS.length);
});

check("filterOptions：按标题/id 命中", () => {
  assert.deepEqual(filterOptions(OPTIONS, "bbbb", INVENTORY).map((item) => item.id), ["b"]);
  assert.deepEqual(filterOptions(OPTIONS, "s001", INVENTORY).map((item) => item.id), ["a-sub1"]);
});

check("filterOptions：按工作区名也能命中该区会话", () => {
  const hits = filterOptions(OPTIONS, "piano", INVENTORY).map((item) => item.id);
  assert.deepEqual(hits, ["b"], "工作区名应带出区内会话");
});

console.log("");
console.log("通过 " + passed + " 项，失败 " + failed + " 项");
if (failed > 0) process.exitCode = 1;
