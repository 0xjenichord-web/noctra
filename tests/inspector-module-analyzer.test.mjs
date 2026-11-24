import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeModules } from "../tools/inspector/module-analyzer.mjs";

async function fixture(files) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "noctra-modules-"));
  for (const [name, source] of Object.entries(files)) {
    const target = path.join(rootPath, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, source);
  }
  return { rootPath, cleanup: () => fs.rm(rootPath, { recursive: true, force: true }) };
}

test("links named imports and aliased imports to named exports", async () => {
  const f = await fixture({ "main.js": 'import { value as local } from "./lib.js"; console.log(local);', "lib.js": "export const value = 1;" });
  try {
    const report = await analyzeModules({ rootPath: f.rootPath, entryFiles: ["main.js"] });
    assert.equal(report.edges.length, 1);
    assert.equal(report.edges[0].imports[0].imported, "value");
    assert.equal(report.edges[0].imports[0].local, "local");
    assert.equal(report.edges[0].exports[0].exported, "value");
    assert.deepEqual(report.diagnostics, []);
  } finally { await f.cleanup(); }
});

test("links default imports to default exports", async () => {
  const f = await fixture({ "main.js": 'import Item from "./item.js";', "item.js": "export default function Item() {}" });
  try {
    const report = await analyzeModules({ rootPath: f.rootPath, entryFiles: ["main.js"] });
    assert.equal(report.edges[0].imports[0].imported, "default");
    assert.equal(report.edges[0].exports[0].exported, "default");
  } finally { await f.cleanup(); }
});

test("resolves named re-exports", async () => {
  const f = await fixture({ "main.js": 'import { renamed } from "./barrel.js";', "barrel.js": 'export { value as renamed } from "./lib.js";', "lib.js": "export const value = 1;" });
  try {
    const report = await analyzeModules({ rootPath: f.rootPath, entryFiles: ["main.js"] });
    assert.equal(report.edges.find(e => e.to === "barrel.js").exports[0].exported, "renamed");
  } finally { await f.cleanup(); }
});

test("reports cycles in dependency graph", async () => {
  const f = await fixture({ "a.js": 'import { b } from "./b.js"; export const a = 1;', "b.js": 'import { a } from "./a.js"; export const b = 1;' });
  try {
    const report = await analyzeModules({ rootPath: f.rootPath, entryFiles: ["a.js"] });
    assert.ok(report.cycles.some(cycle => cycle.includes("a.js") && cycle.includes("b.js")));
  } finally { await f.cleanup(); }
});

test("reports missing local module", async () => {
  const f = await fixture({ "main.js": 'import "./absent.js";' });
  try {
    const report = await analyzeModules({ rootPath: f.rootPath, entryFiles: ["main.js"] });
    assert.ok(report.diagnostics.some(d => d.code === "MISSING_MODULE"));
  } finally { await f.cleanup(); }
});

test("reports missing imported export", async () => {
  const f = await fixture({ "main.js": 'import { absent } from "./lib.js";', "lib.js": "export const present = 1;" });
  try {
    const report = await analyzeModules({ rootPath: f.rootPath, entryFiles: ["main.js"] });
    assert.ok(report.diagnostics.some(d => d.code === "MISSING_EXPORT" && d.imported === "absent"));
  } finally { await f.cleanup(); }
});
