import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeProjectDependencyGraph } from "../tools/inspector/project-dependency-graph.mjs";

async function fixture(files) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "noctra-graph-"));
  for (const [name, value] of Object.entries(files)) { const target = path.join(rootPath, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, value); }
  return { rootPath, cleanup: () => fs.rm(rootPath, { recursive: true, force: true }) };
}

test("builds a deterministic graph across nested source directories", async () => {
  const f = await fixture({ "main.js": 'import { x } from "./nested/lib.js";', "nested/lib.js": "export const x = 1;", "nested/other.ts": "export {};" });
  try { const a = await analyzeProjectDependencyGraph({ rootPath: f.rootPath, entryFiles: ["main.js"] }); const b = await analyzeProjectDependencyGraph({ rootPath: f.rootPath, entryFiles: ["main.js"] });
    assert.deepEqual(a, b); assert.equal(a.nodes.length, 3); assert.equal(a.edges.length, 1); assert.ok(Object.isFrozen(a.nodes[0].scopeAnalysis));
  } finally { await f.cleanup(); }
});

test("identifies orphan and unreachable modules", async () => {
  const f = await fixture({ "main.js": 'import "./used.js";', "used.js": "export {};", "orphan.js": "export {};" });
  try { const r = await analyzeProjectDependencyGraph({ rootPath: f.rootPath, entryFiles: ["main.js"] }); assert.deepEqual(r.orphanModules, ["main.js", "orphan.js"]); assert.deepEqual(r.unreachableModules, ["orphan.js"]); }
  finally { await f.cleanup(); }
});

test("reports missing dependencies and circular dependencies", async () => {
  const f = await fixture({ "a.js": 'import "./b.js"; import "./missing.js";', "b.js": 'import "./a.js";' });
  try { const r = await analyzeProjectDependencyGraph({ rootPath: f.rootPath, entryFiles: ["a.js"] }); assert.ok(r.diagnostics.some(d => d.code === "MISSING_MODULE")); assert.ok(r.cycles.some(c => c.includes("a.js") && c.includes("b.js"))); }
  finally { await f.cleanup(); }
});

test("reports invalid, oversized and symlinked source safely", async () => {
  const f = await fixture({ "bad.js": "let =", "large.js": "1234567890123456789012345678901234567890" });
  try {
    await fs.writeFile(path.join(f.rootPath, "invalid-utf8.js"), Buffer.from([0xff]));
    await fs.symlink("bad.js", path.join(f.rootPath, "linked.js"));
    const r = await analyzeProjectDependencyGraph({ rootPath: f.rootPath, maxFileBytes: 30 });
    assert.ok(r.diagnostics.some(d => d.code === "INVALID_SOURCE")); assert.ok(r.diagnostics.some(d => d.code === "UNREADABLE_FILE")); assert.ok(r.diagnostics.some(d => d.code === "SYMLINK_SKIPPED"));
  } finally { await f.cleanup(); }
});

test("routes TypeScript through its parser adapter and keeps malformed JavaScript as a parse error", async () => {
  const f = await fixture({ "typed.ts": "const value: number = 1;", "valid.js": "export const value = 1;", "bad.js": "const = ;" });
  try {
    const r = await analyzeProjectDependencyGraph({ rootPath: f.rootPath });
    const typed = r.nodes.find(node => node.id === "typed.ts");
    const bad = r.nodes.find(node => node.id === "bad.js");
    assert.equal(typed.status, "ANALYZED");
    assert.equal(bad.status, "PARSE_ERROR");
    assert.equal(r.nodes.find(node => node.id === "valid.js").status, "ANALYZED");
    assert.ok(!r.diagnostics.some(d => d.code === "UNSUPPORTED_LANGUAGE" && d.path === "typed.ts"));
    const syntax = r.diagnostics.find(d => d.code === "PARSE_ERROR" && d.path === "bad.js");
    assert.ok(syntax?.message);
    assert.ok(Number.isInteger(syntax.location.line));
    assert.ok(Number.isInteger(syntax.location.column));
  } finally { await f.cleanup(); }
});
