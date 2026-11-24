import test from "node:test";
import assert from "node:assert/strict";

import { analyzeJavaScript } from "../tools/inspector/ast-analyzer.mjs";
import { analyzeJavaScriptWithBindings } from "../tools/inspector/ast-analyzer.mjs";

function reference(report, source, name, occurrence = "last") {
  const starts = [...source.matchAll(new RegExp(name, "g"))].map(match => match.index);
  const start = occurrence === "first" ? starts[0] : starts.at(-1);
  return report.bindingResolution.references.find(item => item.nodeId === `Identifier:${start}:${start + name.length}`);
}

test("integrates declarations and lexical references while preserving the AST report API", () => {
  const source = "const account = {}; function read() { return account; }";
  const legacy = analyzeJavaScript(source);
  const result = analyzeJavaScriptWithBindings(source);
  const binding = result.scopeAnalysis.bindings.find(item => item.name === "account");

  assert.equal(result.status, legacy.status);
  assert.deepEqual(result.declarations, legacy.declarations);
  assert.ok(binding);
  assert.equal(reference(result, source, "account").bindingId, binding.id);
});

test("resolves nested scopes and shadowed identifiers to the nearest binding", () => {
  const source = "const value = 1; function read() { const value = 2; return value; }";
  const result = analyzeJavaScriptWithBindings(source);
  const bindings = result.scopeAnalysis.bindings.filter(item => item.name === "value");
  assert.equal(bindings.length, 2);
  assert.equal(reference(result, source, "value").bindingId, bindings[1].id);
});

test("marks unresolved lexical identifiers", () => {
  const source = "function read() { return missingValue; }";
  assert.equal(reference(analyzeJavaScriptWithBindings(source), source, "missingValue").status, "UNRESOLVED");
});

test("marks direct eval affected references as dynamic", () => {
  const source = 'function read() { eval("x"); return x; }';
  assert.equal(reference(analyzeJavaScriptWithBindings(source), source, "x").status, "DYNAMIC");
});

test("marks references inside with bodies as dynamic", () => {
  const source = "function read(object) { with (object) { return value; } }";
  const result = analyzeJavaScriptWithBindings(source);
  assert.equal(result.status, "ANALYZED");
  assert.equal(reference(result, source, "value").status, "DYNAMIC");
  assert.equal(result.scopeAnalysis.scopes[0].type, "SCRIPT");
  assert.equal(result.bindingResolution.status, "RESOLVED");
  assert.ok(Array.isArray(result.scopeAnalysis.diagnostics));
  assert.ok(Array.isArray(result.bindingResolution.diagnostics));
});

test("keeps module sourceType when script retry also fails", () => {
  const result = analyzeJavaScriptWithBindings('import value from "pkg"; with (object) {}');
  assert.equal(result.status, "SYNTAX_ERROR");
  assert.equal(result.sourceType, "module");
  assert.equal(result.scopeAnalysis, null);
  assert.equal(result.bindingResolution, null);
});

test("returns a frozen syntax error report with no partial binding reports", () => {
  const source = "function broken( {";
  const legacy = analyzeJavaScript(source);
  const result = analyzeJavaScriptWithBindings(source);
  assert.equal(result.status, "SYNTAX_ERROR");
  assert.deepEqual(result.syntaxError, legacy.syntaxError);
  assert.equal(result.scopeAnalysis, null);
  assert.equal(result.bindingResolution, null);
  assert.ok(Object.isFrozen(result));
});

test("does not mutate previous analyzer output and returns deterministic deeply frozen reports", () => {
  const source = "const account = {}; function read() { return account; }";
  const legacy = analyzeJavaScript(source);
  const before = JSON.stringify(legacy);
  const first = analyzeJavaScriptWithBindings(source);
  const second = analyzeJavaScriptWithBindings(source);
  assert.equal(JSON.stringify(legacy), before);
  assert.deepEqual(first, second);
  assert.ok(Object.isFrozen(first.scopeAnalysis.bindings[0]));
  assert.ok(Object.isFrozen(first.bindingResolution.references[0]));
  assert.ok(Object.isFrozen(first.bindingResolution.diagnostics));
});

test("rejects non-string input consistently with the legacy analyzer", () => {
  assert.throws(() => analyzeJavaScriptWithBindings(null), { name: "TypeError" });
});
