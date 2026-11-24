import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeSource } from "../tools/inspector/parser-registry.mjs";
import { analyzeModules } from "../tools/inspector/module-analyzer.mjs";
import { analyzeProjectDependencyGraph } from "../tools/inspector/project-dependency-graph.mjs";

test("TypeScript registry analyzes module syntax and scope bindings when the supported subset is complete", () => {
  const result = analyzeSource({
    filePath: "main.ts",
    source: 'import type { User } from "./types"; export interface Row { value: User }; export const count: number = 1;'
  });

  assert.equal(result.status, "ANALYZED");
  assert.equal(result.language, "typescript");
  assert.equal(result.report.imports[0]?.source, "./types");
  assert.ok(result.report.exports.some(item => item.names.some(name => name.exported === "Row")));
  assert.ok(result.report.scopeAnalysis);
  assert.ok(result.report.bindingResolution);
  assert.ok(result.report.bindingResolution.references.some(item => item.name === "User" && item.status === "RESOLVED"));
});

test("TypeScript parser rejects malformed syntax and parses TSX", () => {
  const malformed = analyzeSource({ filePath: "bad.ts", source: "const value: = 1;" });
  const tsx = analyzeSource({ filePath: "View.tsx", source: "export const View = () => <section />;" });

  assert.equal(malformed.status, "PARSE_ERROR");
  assert.ok(malformed.report.syntaxError?.message);
  assert.equal(tsx.status, "ANALYZED");
  assert.equal(tsx.language, "typescript");
});

test("module analyzer follows TypeScript imports while keeping their status PARSED", async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "noctra-ts-modules-"));
  try {
    await fs.writeFile(path.join(rootPath, "main.ts"), 'import { value } from "./dep"; import type { User } from "./types"; export const result: number = value;');
    await fs.writeFile(path.join(rootPath, "dep.ts"), "export const value: number = 1;");
    await fs.writeFile(path.join(rootPath, "types.d.ts"), "export interface User { name: string; }");
    const result = await analyzeModules({ rootPath, entryFiles: ["main.ts"] });

    assert.ok(result.modules.every(module => module.status === "ANALYZED"));
    assert.ok(result.edges.some(edge => edge.from === "main.ts" && edge.to === "dep.ts"));
    assert.ok(result.edges.some(edge => edge.from === "main.ts" && edge.to === "types.d.ts"));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test("project dependency graph indexes TypeScript and keeps JSX support", async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "noctra-ts-graph-"));
  try {
    await fs.writeFile(path.join(rootPath, "App.tsx"), 'import Card from "./Card"; export const App = () => <Card />;');
    await fs.writeFile(path.join(rootPath, "Card.tsx"), "export default function Card() { return <article />; }");
    await fs.writeFile(path.join(rootPath, "View.jsx"), "export const View = () => <main />;");
    const result = await analyzeProjectDependencyGraph({ rootPath, entryFiles: ["App.tsx"] });

    assert.equal(result.nodes.find(node => node.id === "App.tsx")?.status, "ANALYZED");
    assert.equal(result.nodes.find(node => node.id === "View.jsx")?.status, "ANALYZED");
    assert.ok(result.edges.some(edge => edge.from === "App.tsx" && edge.to === "Card.tsx"));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test("resolves TypeScript declarations, generic parameters, namespace members, and function parameters", () => {
  const result = analyzeSource({
    filePath: "types.ts",
    source: `interface Box<T> { value: T; map<U extends T>(item: U): T }
type Maybe<T> = T | null;
enum State { Ready }
namespace Store { export interface Entry { id: number }; export const entry: Entry = { id: 1 }; }
const stored = Store.entry; const initial = State.Ready;
function identity<U extends Box<unknown>>(value: U, fallback?: U): Maybe<U> { return fallback ?? value; }`
  });

  assert.equal(result.status, "ANALYZED");
  const bindings = result.report.bindingResolution.declarations;
  for (const name of ["Box", "Maybe", "State", "Store", "Entry", "entry", "T", "U", "item", "value", "fallback"]) {
    assert.ok(bindings.some(binding => binding.name === name), `expected a binding for ${name}`);
  }
  for (const name of ["Entry", "T", "U", "value", "fallback", "Store", "State"]) {
    assert.ok(result.report.bindingResolution.references.some(reference => reference.name === name && reference.status === "RESOLVED"), `expected references to ${name} to resolve`);
  }
  assert.ok(!result.report.bindingResolution.references.some(reference => reference.name === "id"));
});

test("TSX resolves component tags and expression identifiers but ignores intrinsic tags", () => {
  const result = analyzeSource({
    filePath: "View.tsx",
    source: 'import Widget from "./Widget"; export const View = (props: { title: string }) => <Widget title={props.title}><div /></Widget>;'
  });

  assert.equal(result.status, "ANALYZED");
  const references = result.report.bindingResolution.references;
  assert.equal(references.filter(item => item.name === "Widget").length, 1);
  assert.equal(references.find(item => item.name === "Widget")?.status, "RESOLVED");
  assert.equal(references.find(item => item.name === "props")?.status, "RESOLVED");
  assert.ok(!references.some(item => item.name === "div"));
});

test("keeps TypeScript in PARSED for unsupported syntax or incomplete type binding cases", () => {
  const result = analyzeSource({ filePath: "legacy.ts", source: 'import path = require("node:path");' });
  const wrongNamespace = analyzeSource({ filePath: "wrong-namespace.ts", source: "const Config = 1; let current: Config;" });
  const qualified = analyzeSource({ filePath: "qualified.ts", source: "namespace Types { export interface User {} } let user: Types.User;" });

  assert.equal(result.status, "PARSED");
  assert.equal(result.report.scopeAnalysis, null);
  assert.equal(result.report.bindingResolution, null);
  assert.equal(wrongNamespace.status, "PARSED");
  assert.equal(qualified.status, "PARSED");
});
