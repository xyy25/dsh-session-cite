// 把 tsc 编译出的客户端 CJS 单文件产物，包成 dsh 浏览器端要求的
// window.__ModuleLoader__.load({ id, factory }) 外壳，写入 client/client.js。
//
// 运行：npm run build 的最后一步（node build/bundle-client.mjs）
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "tmp-client-cjs", "client.js");
const output = path.join(root, "client", "client.js");

const body = readFileSync(entry, "utf8").replace(/\s+$/, "");

const bundle = [
  "// 由 src/client/client.tsx 经 npm run build 构建生成，请勿手改；源码修改后重新构建。",
  "window.__ModuleLoader__.load({",
  "\tid: \"dsh-session-cite\",",
  "\tfactory: (require) => {",
  "\t\tvar module = { exports: {} };",
  "\t\tvar exports = module.exports;",
  "\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: \"Module\" });",
  body,
  "\t\treturn module.exports;",
  "\t}",
  "});",
  "",
].join("\n");

mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, bundle, "utf8");
rmSync(path.join(root, "tmp-client-cjs"), { recursive: true, force: true });
console.log("[build] client bundle ->", path.relative(root, output));
