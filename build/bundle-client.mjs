// 把 tsc 编译出的客户端 CJS 产物，包成 dsh 浏览器端要求的
// window.__ModuleLoader__.load({ id, factory }) 外壳，写入 client/client.js。
//
// 浏览器端模块加载器只认识 react 平台 seed，不解析相对路径；
// 因此同目录的相对模块在这里内联成局部变量，并把 client.js 与各内联模块里
// 对应的 require(...) 一并改写成该变量（内联模块自己的依赖也要改，否则会漏）。
//
// 运行：npm run build 的最后一步（node build/bundle-client.mjs）
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "tmp-client-cjs");
const entry = path.join(outDir, "client.js");
const output = path.join(root, "client", "client.js");

// 顺序即依赖顺序：被依赖者先内联。
const INLINE_MODULES = [
  { file: "session-picker.js", symbol: "__sessionPicker" },
  { file: "forward-logic.js", symbol: "__forwardLogic" },
  { file: "forward-panel.js", symbol: "__forwardPanel" },
  { file: "forward-overlay.js", symbol: "__forwardOverlay" },
];

const HEAD = [
  "		var module = { exports: {} };",
  "		var exports = module.exports;",
  "		Object.defineProperty(exports, Symbol.toStringTag, { value: \"Module\" });",
];
const TAIL = ["		return module.exports;"];

/** 把一段代码里对内联模块的 require 全部换成对应符号。 */
function rewrite(text, subs) {
  return subs.reduce((acc, sub) => acc.split(sub.from).join(sub.to), text);
}

const modules = [];
for (const item of INLINE_MODULES) {
  const source = path.join(outDir, item.file);
  if (!existsSync(source)) continue;
  modules.push({ ...item, body: readFileSync(source, "utf8").replace(/\s+$/, "") });
}

const subs = modules.map((item) => ({ from: 'require("./' + item.file + '")', to: item.symbol }));

let body = rewrite(readFileSync(entry, "utf8").replace(/\s+$/, ""), subs);

const blocks = [];
for (const item of modules) {
  blocks.push(
    [
      "		// 内联模块：" + item.file,
      "		var " + item.symbol + " = (() => {",
      ...HEAD,
      rewrite(item.body, subs),
      ...TAIL,
      "		})();",
    ].join("\n"),
  );
}

const bundle = [
  "// 由 src/client/client.tsx 经 npm run build 构建生成，请勿手改；源码修改后重新构建。",
  "window.__ModuleLoader__.load({",
  "	id: \"dsh-session-cite\",",
  "	factory: (require) => {",
  ...blocks,
  ...HEAD,
  body,
  ...TAIL,
  "	}",
  "});",
  "",
].join("\n");

mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, bundle, "utf8");
rmSync(outDir, { recursive: true, force: true });
console.log("[build] client bundle ->", path.relative(root, output), "(+" + blocks.length + " 内联模块)");
