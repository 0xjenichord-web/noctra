import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "acorn";

import {
  analyzeScopes
} from "../tools/inspector/scope-analyzer.mjs";

import {
  resolveBindings
} from "../tools/inspector/binding-resolver.mjs";

function analyze(source) {
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true
  });

  const scopeReport = analyzeScopes(ast);

  return { ast, scopeReport };
}

function nodeId(node) {
  return `${node.type}:${node.start}:${node.end}`;
}

function findReference(result, source, name, occurrence = "last") {
  const positions = [];
  let offset = 0;

  while ((offset = source.indexOf(name, offset)) !== -1) {
    positions.push(offset);
    offset += name.length;
  }

  const position = occurrence === "first"
    ? positions[0]
    : positions.at(-1);

  assert.notEqual(position, undefined, `Missing source occurrence: ${name}`);

  return result.references.find(
    item => item.nodeId === `Identifier:${position}:${position + name.length}`
  );
}

test("resolves a reference to its module lexical declaration", () => {
  const source = `
    const account = {};
    function read() {
      return account;
    }
  `;

  const { ast, scopeReport } = analyze(source);
  const result = resolveBindings(ast, scopeReport);

  const binding = scopeReport.bindings.find(
    item => item.name === "account"
  );

  const reference = findReference(result, source, "account", "last");

  assert.ok(binding);
  assert.ok(reference);
  assert.equal(reference.classification, "REFERENCE");
  assert.equal(reference.status, "RESOLVED");
  assert.equal(reference.bindingId, binding.id);
});

test("resolves shadowed names to the nearest lexical binding", () => {
  const source = `
    const value = "outer";

    function read() {
      const value = "inner";
      return value;
    }
  `;

  const { ast, scopeReport } = analyze(source);
  const result = resolveBindings(ast, scopeReport);

  const bindings = scopeReport.bindings.filter(
    item => item.name === "value"
  );

  const reference = findReference(result, source, "value", "last");

  assert.equal(bindings.length, 2);
  assert.ok(reference);
  assert.equal(reference.status, "RESOLVED");
  assert.equal(reference.bindingId, bindings[1].id);
});

test("marks an identifier without a lexical declaration as unresolved", () => {
  const source = `
    function read() {
      return missingValue;
    }
  `;

  const { ast, scopeReport } = analyze(source);
  const result = resolveBindings(ast, scopeReport);

  const reference = findReference(
    result,
    source,
    "missingValue"
  );

  assert.ok(reference);
  assert.equal(reference.classification, "REFERENCE");
  assert.equal(reference.status, "UNRESOLVED");
  assert.equal(reference.bindingId, null);
});

test("does not classify declaration identifiers as references", () => {
  const source = `
    const account = 1;
    function read(parameter) {
      const local = parameter;
      return local;
    }
  `;

  const { ast, scopeReport } = analyze(source);
  const result = resolveBindings(ast, scopeReport);

  assert.ok(Array.isArray(result.declarations));
  assert.ok(Array.isArray(result.references));

  const accountBinding = scopeReport.bindings.find(
    item => item.name === "account"
  );

  assert.ok(accountBinding);
  assert.ok(
    result.declarations.some(
      item => item.nodeId === accountBinding.declarationNodeId
    )
  );
});

test("marks references in a direct-eval affected function as dynamic", () => {
  const source = `
    function read() {
      eval("dynamicValue");
      return dynamicValue;
    }
  `;

  const { ast, scopeReport } = analyze(source);
  const result = resolveBindings(ast, scopeReport);

  const reference = findReference(
    result,
    source,
    "dynamicValue",
    "last"
  );

  assert.ok(reference);
  assert.equal(reference.status, "DYNAMIC");
});

test("does not mutate the AST or Scope Analyzer report", () => {
  const source = `
    const account = {};
    function read() {
      return account;
    }
  `;

  const { ast, scopeReport } = analyze(source);
  const astBefore = JSON.stringify(ast);
  const scopeBefore = JSON.stringify(scopeReport);

  resolveBindings(ast, scopeReport);

  assert.equal(JSON.stringify(ast), astBefore);
  assert.equal(JSON.stringify(scopeReport), scopeBefore);
});

test("returns deterministic output for identical inputs", () => {
  const { ast, scopeReport } = analyze(`
    const account = {};
    function read() {
      return account;
    }
  `);

  const first = resolveBindings(ast, scopeReport);
  const second = resolveBindings(ast, scopeReport);

  assert.deepEqual(first, second);
});

test("deep-freezes the resolver result", () => {
  const { ast, scopeReport } = analyze(`
    const account = {};
    function read() {
      return account;
    }
  `);

  const result = resolveBindings(ast, scopeReport);

  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.references));
  assert.ok(Object.isFrozen(result.declarations));
  assert.ok(Object.isFrozen(result.diagnostics));
});
