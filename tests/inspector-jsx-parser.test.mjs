import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeJavaScript } from "../tools/inspector/ast-analyzer.mjs";
import { analyzeSource } from "../tools/inspector/parser-registry.mjs";
import { analyzeProjectDependencyGraph } from "../tools/inspector/project-dependency-graph.mjs";

test("parser registry analyzes JSX modules and preserves expression imports", () => {
  const result = analyzeSource({
    filePath: "Component.jsx",
    source: 'import Button from "./Button.jsx"; export const View = () => <main><Button value={count + 1} /></main>;'
  });

  assert.equal(result.status, "ANALYZED");
  assert.equal(result.language, "javascript");
  assert.deepEqual(result.report.imports.map(item => item.source), ["./Button.jsx"]);
  assert.equal(result.report.bindingResolution.references.find(item => item.name === "Button")?.status, "RESOLVED");
  assert.equal(result.report.bindingResolution.references.filter(item => item.name === "Button").length, 1);
  assert.equal(result.report.bindingResolution.references.find(item => item.name === "count")?.status, "UNRESOLVED");
});

test("legacy analyzeJavaScript API remains JavaScript-only and rejects JSX", () => {
  const result = analyzeJavaScript("const value = 1;");
  assert.equal(result.status, "ANALYZED");
  assert.equal(analyzeJavaScript("const view = <div />;").status, "SYNTAX_ERROR");
});

test("project dependency graph follows imports from JSX files and syntax-parses TypeScript", async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "noctra-jsx-"));
  try {
    await fs.writeFile(path.join(rootPath, "App.jsx"), 'import Card from "./Card.jsx"; export const App = () => <Card />;');
    await fs.writeFile(path.join(rootPath, "Card.jsx"), "export default function Card() { return <article />; }");
    await fs.writeFile(path.join(rootPath, "typed.ts"), "const value: number = 1;");
    const result = await analyzeProjectDependencyGraph({ rootPath, entryFiles: ["App.jsx"] });

    assert.equal(result.nodes.find(node => node.id === "App.jsx")?.status, "ANALYZED");
    assert.equal(result.nodes.find(node => node.id === "Card.jsx")?.status, "ANALYZED");
    assert.equal(result.nodes.find(node => node.id === "typed.ts")?.status, "ANALYZED");
    assert.ok(result.edges.some(edge => edge.from === "App.jsx" && edge.to === "Card.jsx"));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
