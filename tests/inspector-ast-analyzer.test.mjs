import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeJavaScript
} from "../tools/inspector/ast-analyzer.mjs";

test("analyzes a valid JavaScript module", () => {
  const report = analyzeJavaScript(`
    export function calculate(value) {
      return value + 1;
    }
  `);

  assert.equal(report.status, "ANALYZED");
  assert.equal(report.sourceType, "module");
  assert.ok(Array.isArray(report.declarations));
  assert.ok(Array.isArray(report.imports));
  assert.ok(Array.isArray(report.exports));
  assert.ok(Array.isArray(report.calls));
});

test("detects function declarations", () => {
  const report = analyzeJavaScript(`
    function verifyAuthorization(record) {
      return Boolean(record);
    }
  `);

  assert.ok(
    report.declarations.some(
      item =>
        item.type === "FunctionDeclaration" &&
        item.name === "verifyAuthorization"
    )
  );
});

test("detects arrow functions assigned to variables", () => {
  const report = analyzeJavaScript(`
    const validateScope = (scope) => {
      return scope !== null;
    };
  `);

  assert.ok(
    report.declarations.some(
      item =>
        item.type === "ArrowFunctionExpression" &&
        item.name === "validateScope"
    )
  );
});

test("detects classes and their methods", () => {
  const report = analyzeJavaScript(`
    class AuthorizationEngine {
      verify(record) {
        return Boolean(record);
      }
    }
  `);

  assert.ok(
    report.declarations.some(
      item =>
        item.type === "ClassDeclaration" &&
        item.name === "AuthorizationEngine"
    )
  );

  assert.ok(
    report.declarations.some(
      item =>
        item.type === "MethodDefinition" &&
        item.name === "verify"
    )
  );
});

test("detects imports and exports", () => {
  const report = analyzeJavaScript(`
    import fs from "node:fs";
    export const enabled = true;
    export default enabled;
  `);

  assert.ok(report.imports.some(item => item.source === "node:fs"));
  assert.ok(report.exports.length >= 2);
});

test("detects function calls with source locations", () => {
  const report = analyzeJavaScript(`
    function run() {
      verifyAuthorization();
    }
  `);

  const call = report.calls.find(
    item => item.name === "verifyAuthorization"
  );

  assert.ok(call);
  assert.equal(call.line, 3);
  assert.ok(Number.isInteger(call.column));
});

test("returns structured syntax errors without throwing", () => {
  const report = analyzeJavaScript(`
    function broken( {
      return true;
    }
  `);

  assert.equal(report.status, "SYNTAX_ERROR");
  assert.ok(report.syntaxError);
  assert.ok(Number.isInteger(report.syntaxError.line));
  assert.ok(Number.isInteger(report.syntaxError.column));
});

test("does not execute analyzed source code", () => {
  globalThis.__noctraAstExecutionProbe = 0;

  try {
    analyzeJavaScript(`
      globalThis.__noctraAstExecutionProbe = 999;
    `);

    assert.equal(globalThis.__noctraAstExecutionProbe, 0);
  } finally {
    delete globalThis.__noctraAstExecutionProbe;
  }
});

test("returns immutable analysis reports", () => {
  const report = analyzeJavaScript(`
    function inspect() {
      return true;
    }
  `);

  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.declarations));
  assert.ok(Object.isFrozen(report.imports));
  assert.ok(Object.isFrozen(report.exports));
  assert.ok(Object.isFrozen(report.calls));

  assert.throws(() => {
    report.calls.push({ name: "injected" });
  });
});

test("detects named function expressions assigned to variables", () => {
  const report = analyzeJavaScript(`
    const verify = function verifyRecord(record) {
      return Boolean(record);
    };
  `);

  assert.ok(
    report.declarations.some(
      item =>
        item.type === "FunctionExpression" &&
        item.name === "verifyRecord"
    )
  );
});

test("detects methods in object literals", () => {
  const report = analyzeJavaScript(`
    const authorization = {
      verify(record) {
        return Boolean(record);
      }
    };
  `);

  assert.ok(
    report.declarations.some(
      item =>
        item.type === "ObjectMethod" &&
        item.name === "verify"
    )
  );
});

test("does not claim a static name for computed dynamic calls", () => {
  const report = analyzeJavaScript(`
    function invoke(object, dynamicName) {
      object[dynamicName]();
    }
  `);

  const call = report.calls.find(
    item => item.type === "CallExpression"
  );

  assert.ok(call);
  assert.equal(call.name, null);
});

test("detects optional member calls", () => {
  const report = analyzeJavaScript(`
    function invoke(service) {
      service?.verify();
    }
  `);

  const call = report.calls.find(
    item => item.name === "service.verify"
  );

  assert.ok(call);
  assert.equal(call.optional, true);
});

test("detects nested function declarations", () => {
  const report = analyzeJavaScript(`
    function outer() {
      function inner() {
        return true;
      }
      return inner();
    }
  `);

  assert.ok(
    report.declarations.some(
      item =>
        item.type === "FunctionDeclaration" &&
        item.name === "outer"
    )
  );

  assert.ok(
    report.declarations.some(
      item =>
        item.type === "FunctionDeclaration" &&
        item.name === "inner"
    )
  );
});

test("records anonymous arrow functions used as callbacks", () => {
  const report = analyzeJavaScript(`
    function process(items) {
      return items.map(item => validate(item));
    }
  `);

  assert.ok(
    report.declarations.some(
      item =>
        item.type === "ArrowFunctionExpression" &&
        item.name === null
    )
  );
});

test("recognizes literal computed property calls", () => {
  const report = analyzeJavaScript(`
    function invoke(service) {
      service["verify"]();
    }
  `);

  assert.ok(
    report.calls.some(
      item => item.name === "service.verify"
    )
  );
});

test("recognizes optional direct function calls", () => {
  const report = analyzeJavaScript(`
    function invoke(verify) {
      verify?.();
    }
  `);

  assert.ok(
    report.calls.some(
      item =>
        item.name === "verify" &&
        item.optional === true
    )
  );
});

test("does not duplicate class methods as function expressions", () => {
  const report = analyzeJavaScript(`
    class Service {
      verify() {
        return helper();
      }
    }
  `);

  const methodDeclarations = report.declarations.filter(
    item => item.name === "verify"
  );

  assert.equal(methodDeclarations.length, 1);
  assert.equal(methodDeclarations[0].type, "MethodDefinition");
});

test("does not duplicate object methods as function expressions", () => {
  const report = analyzeJavaScript(`
    const handlers = {
      execute() {
        return helper();
      }
    };
  `);

  const methodDeclarations = report.declarations.filter(
    item => item.name === "execute"
  );

  assert.equal(methodDeclarations.length, 1);
  assert.equal(methodDeclarations[0].type, "ObjectMethod");
});

test("assigns unique stable IDs to function declarations", () => {
  const source = `
    function verify() {}
    function verify() {}
  `;

  const first = analyzeJavaScript(source);
  const second = analyzeJavaScript(source);

  const firstIds = first.declarations.map(item => item.id);
  const secondIds = second.declarations.map(item => item.id);

  assert.ok(firstIds.every(id => typeof id === "string" && id.length > 0));
  assert.equal(new Set(firstIds).size, firstIds.length);
  assert.deepEqual(firstIds, secondIds);
});

test("records parent function relationships for nested functions", () => {
  const report = analyzeJavaScript(`
    function outer() {
      function inner() {
        helper();
      }
    }
  `);

  const outer = report.declarations.find(item => item.name === "outer");
  const inner = report.declarations.find(item => item.name === "inner");

  assert.ok(outer?.id);
  assert.ok(inner?.id);
  assert.equal(inner.parentId, outer.id);
});

test("records the owning function for each function call", () => {
  const report = analyzeJavaScript(`
    function outer() {
      helper();

      function inner() {
        validate();
      }
    }

    topLevel();
  `);

  const outer = report.declarations.find(item => item.name === "outer");
  const inner = report.declarations.find(item => item.name === "inner");

  const helper = report.calls.find(item => item.name === "helper");
  const validate = report.calls.find(item => item.name === "validate");
  const topLevel = report.calls.find(item => item.name === "topLevel");

  assert.equal(helper.callerId, outer.id);
  assert.equal(validate.callerId, inner.id);
  assert.equal(topLevel.callerId, null);
});

test("does not emit an extra function node for a class method", () => {
  const report = analyzeJavaScript(`
    class Service {
      verify() {
        return helper();
      }
    }
  `);

  const method = report.declarations.find(
    item => item.type === "MethodDefinition" && item.name === "verify"
  );

  assert.ok(method);

  const duplicates = report.declarations.filter(
    item =>
      item.type === "FunctionExpression" &&
      item.endLine === method.endLine &&
      item.endColumn === method.endColumn
  );

  assert.equal(duplicates.length, 0);
});

test("does not emit an extra function node for an object method", () => {
  const report = analyzeJavaScript(`
    const handlers = {
      execute() {
        return helper();
      }
    };
  `);

  const method = report.declarations.find(
    item => item.type === "ObjectMethod" && item.name === "execute"
  );

  assert.ok(method);

  const duplicates = report.declarations.filter(
    item =>
      item.type === "FunctionExpression" &&
      item.endLine === method.endLine &&
      item.endColumn === method.endColumn
  );

  assert.equal(duplicates.length, 0);
});

test("records class method ownership and method metadata", () => {
  const report = analyzeJavaScript(`
    class Service {
      constructor() {}
      static create() {}
      get status() {}
      set status(value) {}
      run() {}
    }
  `);

  const methods = report.declarations.filter(
    item => item.type === "MethodDefinition"
  );

  assert.equal(methods.length, 5);

  const constructor = methods.find(
    item => item.name === "constructor"
  );

  const create = methods.find(
    item => item.name === "create"
  );

  const getter = methods.find(
    item => item.name === "status" &&
      item.methodKind === "get"
  );

  const setter = methods.find(
    item => item.name === "status" &&
      item.methodKind === "set"
  );

  assert.equal(constructor.ownerClassName, "Service");
  assert.equal(constructor.methodKind, "constructor");
  assert.equal(create.static, true);
  assert.equal(create.ownerClassName, "Service");
  assert.equal(getter.methodKind, "get");
  assert.equal(setter.methodKind, "set");
});

test("records computed class method metadata without inventing a name", () => {
  const report = analyzeJavaScript(`
    class Service {
      [resolveMethodName()]() {
        execute();
      }
    }
  `);

  const method = report.declarations.find(
    item => item.type === "MethodDefinition"
  );

  assert.ok(method);
  assert.equal(method.name, null);
  assert.equal(method.computed, true);
  assert.equal(method.ownerClassName, "Service");
});

test("records object method ownership and accessor metadata", () => {
  const report = analyzeJavaScript(`
    const handlers = {
      execute() {},
      get ready() {},
      set ready(value) {}
    };
  `);

  const methods = report.declarations.filter(
    item => item.type === "ObjectMethod"
  );

  assert.equal(methods.length, 3);

  assert.ok(
    methods.every(item => item.ownerObjectName === "handlers")
  );

  assert.ok(
    methods.some(item => item.methodKind === "get")
  );

  assert.ok(
    methods.some(item => item.methodKind === "set")
  );
});


test("preserves ownership and caller references in nested structures", () => {
  const report = analyzeJavaScript(`
    const outer = {
      execute() {
        const nested = {
          run() {
            work();
          }
        };

        return nested.run();
      }
    };

    function createService() {
      class InnerService {
        execute() {
          initialize();
        }
      }

      return new InnerService();
    }

    class OuterService {
      create() {
        class Inner {
          execute() {
            nestedExecute();
          }
        }

        return new Inner();
      }
    }
  `);

  assert.equal(report.status, "ANALYZED");

  const declarations = report.declarations;
  const ids = declarations.map(item => item.id);
  const knownIds = new Set(ids);

  assert.equal(knownIds.size, ids.length);

  const outerMethod = declarations.find(
    item =>
      item.type === "ObjectMethod" &&
      item.name === "execute" &&
      item.ownerObjectName === "outer"
  );

  const nestedMethod = declarations.find(
    item =>
      item.type === "ObjectMethod" &&
      item.name === "run" &&
      item.ownerObjectName === "nested"
  );

  const innerClass = declarations.find(
    item =>
      item.type === "ClassDeclaration" &&
      item.name === "Inner"
  );

  const outerCreateMethod = declarations.find(
    item =>
      item.type === "MethodDefinition" &&
      item.name === "create" &&
      item.ownerClassName === "OuterService"
  );

  const innerMethod = declarations.find(
    item =>
      item.type === "MethodDefinition" &&
      item.name === "execute" &&
      item.ownerClassName === "Inner"
  );

  assert.ok(outerMethod);
  assert.ok(nestedMethod);
  assert.ok(outerCreateMethod);
  assert.ok(innerClass);
  assert.ok(innerMethod);

  assert.equal(nestedMethod.parentId, outerMethod.id);
  assert.equal(innerClass.parentId, outerCreateMethod.id);
  assert.equal(innerMethod.ownerClassId, innerClass.id);
  assert.equal(innerMethod.parentId, outerCreateMethod.id);

  const invalidCallers = report.calls.filter(
    call =>
      call.callerId !== null &&
      !knownIds.has(call.callerId)
  );

  assert.deepEqual(invalidCallers, []);
});


test("extracts names from direct export declarations", () => {
  const report = analyzeJavaScript(`
    export function alpha() {}
    export class Beta {}
    export const gamma = 1, delta = 2;
    export default function namedDefault() {}
    export class NamedDefaultClass {}
    const epsilon = 1;
    export { epsilon };
  `);

  assert.equal(report.status, "ANALYZED");

  const named = report.exports.filter(
    item => item.type === "ExportNamedDeclaration"
  );

  const directNames = named
    .filter(item => item.declarationType !== null)
    .flatMap(item => item.names.map(entry => entry.exported));

  assert.deepEqual(directNames, [
    "alpha",
    "Beta",
    "gamma",
    "delta",
    "NamedDefaultClass"
  ]);

  const defaults = report.exports.filter(
    item => item.type === "ExportDefaultDeclaration"
  );

  assert.deepEqual(
    defaults.map(item => item.names),
    [
      [{ exported: "default", local: "namedDefault" }]
    ]
  );


  const anonymousDefault = analyzeJavaScript(
    "export default function () {}"
  );

  assert.equal(anonymousDefault.status, "ANALYZED");
  assert.deepEqual(anonymousDefault.exports[0].names, [
    { exported: "default", local: null }
  ]);

  const defaultClass = analyzeJavaScript(
    "export default class NamedDefaultClass {}"
  );

  assert.equal(defaultClass.status, "ANALYZED");
  assert.deepEqual(defaultClass.exports[0].names, [
    { exported: "default", local: "NamedDefaultClass" }
  ]);

  const specifier = named.find(
    item => item.declarationType === null
  );

  assert.deepEqual(specifier.names, [
    { exported: "epsilon", local: "epsilon" }
  ]);
});


test("detects static dynamic imports separately", () => {
  const report = analyzeJavaScript(
    'const wallet = await import("./wallet.js");'
  );

  assert.equal(report.status, "ANALYZED");
  assert.ok(Array.isArray(report.dynamicImports));
  assert.equal(report.dynamicImports.length, 1);
  assert.equal(report.dynamicImports[0].source, "./wallet.js");
  assert.equal(report.dynamicImports[0].sourceType, "STATIC");
});

test("detects dynamic imports with unknown sources", () => {
  const report = analyzeJavaScript(
    "const module = await import(modulePath);"
  );

  assert.equal(report.status, "ANALYZED");
  assert.equal(report.dynamicImports.length, 1);
  assert.equal(report.dynamicImports[0].source, null);
  assert.equal(report.dynamicImports[0].sourceType, "DYNAMIC");
});

test("does not invent sources for concatenated imports", () => {
  const report = analyzeJavaScript(
    'const module = await import("./wallet.js" + suffix);'
  );

  assert.equal(report.status, "ANALYZED");
  assert.equal(report.dynamicImports.length, 1);
  assert.equal(report.dynamicImports[0].source, null);
  assert.equal(report.dynamicImports[0].sourceType, "DYNAMIC");
});


test("records caller ownership for dynamic imports", () => {
  const report = analyzeJavaScript(
    'async function load() { return import("./wallet.js"); }'
  );

  assert.equal(report.dynamicImports.length, 1);
  assert.equal(
    report.dynamicImports[0].callerId,
    report.declarations.find(item => item.name === "load").id
  );
});

test("records ownership of nested object methods", () => {
  const report = analyzeJavaScript(
    "const registry = { wallet: { connect() {} } };"
  );

  const method = report.declarations.find(
    item => item.type === "ObjectMethod"
  );

  assert.equal(method.ownerObjectName, "registry.wallet");
});

test("records ownership of objects assigned to identifiers", () => {
  const report = analyzeJavaScript(
    "let handlers; handlers = { connect() {} };"
  );

  const method = report.declarations.find(
    item => item.type === "ObjectMethod"
  );

  assert.equal(method.ownerObjectName, "handlers");
});

test("recognizes empty string computed property names", () => {
  const report = analyzeJavaScript(
    'function run() { object[""](); }'
  );

  const call = report.calls[0];

  assert.equal(call.name, "object.");
});


test("does not invent ownership for objects behind dynamic computed keys", () => {
  const report = analyzeJavaScript(`
    const registry = {
      [getKey()]: {
        connect() {}
      }
    };
  `);

  const method = report.declarations.find(
    item => item.type === "ObjectMethod"
  );

  assert.equal(method.ownerObjectName, null);
});

test("records ownership for objects assigned to this properties", () => {
  const report = analyzeJavaScript(`
    class WalletManager {
      setup() {
        this.handlers = {
          connect() {}
        };
      }
    }
  `);

  const method = report.declarations.find(
    item => item.type === "ObjectMethod"
  );

  assert.equal(method.ownerObjectName, "this.handlers");
});

test("assigns nested dynamic imports to the innermost function", () => {
  const report = analyzeJavaScript(`
    async function outer() {
      function inner() {
        return import("./wallet.js");
      }
      return inner();
    }
  `);

  const inner = report.declarations.find(
    item => item.name === "inner"
  );

  assert.equal(report.dynamicImports.length, 1);
  assert.equal(report.dynamicImports[0].callerId, inner.id);
});

test("detects namespace re-exports", () => {
  const report = analyzeJavaScript(`
    export * from "./wildcard.js";
    export * as namespace from "./namespace.js";
  `);

  assert.equal(report.status, "ANALYZED");
  assert.equal(report.exports.length, 2);

  assert.deepEqual(report.exports[0].names, [
    { exported: "*", local: null }
  ]);
  assert.equal(report.exports[0].source, "./wildcard.js");

  assert.deepEqual(report.exports[1].names, [
    { exported: "namespace", local: null }
  ]);
  assert.equal(report.exports[1].source, "./namespace.js");
});
