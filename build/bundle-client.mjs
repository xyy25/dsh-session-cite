// 把 tsc 编译出的客户端 CJS 产物，包成 dsh 浏览器端要求的
// window.__ModuleLoader__.load({ id, factory }) 外壳，写入 client/client.js。
//
// 浏览器端模块加载器只认识 react 平台 seed，不解析相对路径；
// 因此同目录的相对模块（如 session-picker）在这里内联成局部变量，
// 并把 client.js 里对应的 require(...) 改写成该变量。
//
// 运行：npm run build 的最后一步（node build/bundle-client.mjs）
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "tmp-client-cjs");
const entry = path.join(outDir, "client.js");
const output = path.join(root, "client", "client.js");

/** 需要内联的同目录模块：文件名与生成的局部变量名。 */
const INLINE_MODULES = [{ file: "session-picker.js", symbol: "__sessionPicker" }];

const HEAD = [
  "		var module = { exports: {} };",
  "		var exports = module.exports;",
  "		Object.defineProperty(exports, Symbol.toStringTag, { value: \"Module\" });",
];
const TAIL = ["\t\treturn module.exports;"];

let body = readFileSync(entry, "utf8").replace(/\s+$/, "");
const blocks = [];

for (const module of INLINE_MODULES) {
  const source = path.join(outDir, module.file);
  if (!existsSync(source)) continue;
  const inner = readFileSync(source, "utf8").replace(/\s+$/, "");
  body = body.split('require("./' + module.file + '")').join(module.symbol);
  blocks.push(
    [
      "\t\t// 内联模块：" + module.file,
      "\t\tvar " + module.symbol + " = (() => {",
      ...HEAD,
      inner,
      ...TAIL,
      "\t\t})();",
    ].join("\n"),
  );
}

const bundle = [
  "// 由 src/client/client.tsx 经 npm run build 构建生成，请勿手改；源码修改后重新构建。",
  "window.__ModuleLoader__.load({",
  "\tid: \"dsh-session-cite\",",
  "\tfactory: (require) => {",
  ...blocks,
  ...HEAD,
  body,
  ...TAIL,
  "\t}",
  "});",
  "",
].join("\n");

mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, bundle, "utf8");
rmSync(outDir, { recursive: true, force: true });
console.log("[build] client bundle ->", path.relative(root, output), blocks.length > 0 ? "(+" + blocks.length + " 内联模块)" : "");
