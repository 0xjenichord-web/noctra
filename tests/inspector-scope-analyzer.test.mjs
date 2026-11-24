import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "acorn";

import {
  analyzeScopes
} from "../tools/inspector/scope-analyzer.mjs";

function analyze(source) {
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true
  });

  return analyzeScopes(ast);
}

function findBinding(report, name, kind) {
  return report.bindings.find(
    item => item.name === name && item.kind === kind
  );
}

function findScope(report, type, parentScopeId) {
  return report.scopes.find(
    item =>
      item.type === type &&
      (
        parentScopeId === undefined ||
        item.parentScopeId === parentScopeId
      )
  );
}

test("assigns imports and top-level declarations to module scope", () => {
  const report = analyze(`
    import wallet from "./wallet.mjs";
    const enabled = true;
    let counter = 0;
    var legacyValue = 1;
    function execute() {}
    class WalletEngine {}
  `);

  assert.equal(report.status, "ANALYZED");

  const moduleScope = findScope(report, "MODULE");
  assert.ok(moduleScope);
  assert.equal(moduleScope.parentScopeId, null);

  for (const [name, kind] of [
    ["wallet", "IMPORT"],
    ["enabled", "CONST"],
    ["counter", "LET"],
    ["legacyValue", "VAR"],
    ["execute", "FUNCTION"],
    ["WalletEngine", "CLASS"]
  ]) {
    const binding = findBinding(report, name, kind);
    assert.ok(binding, `Missing binding: ${name}`);
    assert.equal(binding.scopeId, moduleScope.id);
  }
});

test("assigns parameters and var declarations to function scope", () => {
  const report = analyze(`
    function execute(parameter) {
      var functionValue = 1;
      return parameter + functionValue;
    }
  `);

  const moduleScope = findScope(report, "MODULE");
  const functionScope = findScope(
    report,
    "FUNCTION",
    moduleScope.id
  );

  assert.ok(functionScope);

  for (const [name, kind] of [
    ["parameter", "PARAMETER"],
    ["functionValue", "VAR"]
  ]) {
    const binding = findBinding(report, name, kind);
    assert.ok(binding, `Missing binding: ${name}`);
    assert.equal(binding.scopeId, functionScope.id);
  }
});

test("assigns function-body let and const declarations to FUNCTION_BODY", () => {
  const report = analyze(`
    function execute() {
      let localValue = 1;
      const fixedValue = 2;
    }
  `);

  const functionScope = findScope(report, "FUNCTION");
  assert.ok(functionScope);

  const bodyScope = findScope(
    report,
    "FUNCTION_BODY",
    functionScope.id
  );

  assert.ok(bodyScope);

  for (const [name, kind] of [
    ["localValue", "LET"],
    ["fixedValue", "CONST"]
  ]) {
    const binding = findBinding(report, name, kind);
    assert.ok(binding, `Missing binding: ${name}`);
    assert.equal(binding.scopeId, bodyScope.id);
  }
});

test("creates a nested block scope for lexical declarations", () => {
  const report = analyze(`
    function execute() {
      if (true) {
        let blockValue = 1;
        const anotherValue = 2;
      }
    }
  `);

  const functionScope = findScope(report, "FUNCTION");
  assert.ok(functionScope);

  const bodyScope = findScope(
    report,
    "FUNCTION_BODY",
    functionScope.id
  );
  assert.ok(bodyScope);

  const blockScope = findScope(
    report,
    "BLOCK",
    bodyScope.id
  );
  assert.ok(blockScope);

  for (const [name, kind] of [
    ["blockValue", "LET"],
    ["anotherValue", "CONST"]
  ]) {
    const binding = findBinding(report, name, kind);
    assert.ok(binding, `Missing binding: ${name}`);
    assert.equal(binding.scopeId, blockScope.id);
  }
});

test("hoists var declarations from nested blocks to function scope", () => {
  const report = analyze(`
    function execute() {
      if (true) {
        var sharedValue = 1;
      }
    }
  `);

  const functionScope = findScope(report, "FUNCTION");
  const binding = findBinding(report, "sharedValue", "VAR");

  assert.ok(binding);
  assert.equal(binding.scopeId, functionScope.id);
});

test("does not create a duplicate internal binding for function declarations", () => {
  const report = analyze(`
    function execute() {
      return execute;
    }
  `);

  const matches = report.bindings.filter(
    item => item.name === "execute"
  );

  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind, "FUNCTION");
  assert.equal(
    matches[0].scopeId,
    findScope(report, "MODULE").id
  );
});

test("creates an internal name binding for named function expressions", () => {
  const report = analyze(`
    const runner = function internalName() {
      return internalName;
    };
  `);

  const binding = findBinding(
    report,
    "internalName",
    "FUNCTION_NAME"
  );

  assert.ok(binding);

  const functionScope = findScope(report, "FUNCTION");
  assert.equal(binding.scopeId, functionScope.id);

  assert.equal(
    report.bindings.some(
      item =>
        item.name === "internalName" &&
        item.kind === "FUNCTION"
    ),
    false
  );
});

test("generates deterministic scope and binding identifiers", () => {
  const source = `
    const enabled = true;

    function execute(value) {
      const result = value;
      return result;
    }
  `;

  const first = analyze(source);
  const second = analyze(source);

  assert.deepEqual(first.scopes, second.scopes);
  assert.deepEqual(first.bindings, second.bindings);
});

test("keeps shadowed lexical bindings in separate scopes", () => {
  const report = analyze(`
    function execute() {
      let value = 1;

      if (true) {
        let value = 2;
      }
    }
  `);

  const matches = report.bindings.filter(
    item => item.name === "value" && item.kind === "LET"
  );

  assert.equal(matches.length, 2);
  assert.notEqual(matches[0].scopeId, matches[1].scopeId);

  const functionScope = findScope(report, "FUNCTION");
  const bodyScope = findScope(
    report,
    "FUNCTION_BODY",
    functionScope.id
  );
  const blockScope = findScope(
    report,
    "BLOCK",
    bodyScope.id
  );

  assert.ok(matches.some(item => item.scopeId === bodyScope.id));
  assert.ok(matches.some(item => item.scopeId === blockScope.id));
});

test("does not hoist var declarations across nested function boundaries", () => {
  const report = analyze(`
    function outer() {
      function inner() {
        var innerValue = 1;
      }

      var outerValue = 2;
    }
  `);

  const functions = report.scopes.filter(
    item => item.type === "FUNCTION"
  );

  assert.equal(functions.length, 2);

  const innerBinding = findBinding(report, "innerValue", "VAR");
  const outerBinding = findBinding(report, "outerValue", "VAR");

  assert.ok(innerBinding);
  assert.ok(outerBinding);
  assert.notEqual(innerBinding.scopeId, outerBinding.scopeId);
  assert.ok(functions.some(item => item.id === innerBinding.scopeId));
  assert.ok(functions.some(item => item.id === outerBinding.scopeId));
});

test("collects names from nested object and array destructuring", () => {
  const report = analyze(`
    function execute() {
      const {
        wallet: { address },
        ...rest
      } = input;

      let [first, , ...remaining] = values;
    }
  `);

  const bodyScope = findScope(report, "FUNCTION_BODY");
  assert.ok(bodyScope);

  for (const [name, kind] of [
    ["address", "CONST"],
    ["rest", "CONST"],
    ["first", "LET"],
    ["remaining", "LET"]
  ]) {
    const binding = findBinding(report, name, kind);
    assert.ok(binding, `Missing destructured binding: ${name}`);
    assert.equal(binding.scopeId, bodyScope.id);
  }
});

test("keeps arrow function var declarations inside the arrow function scope", () => {
  const report = analyze(`
    function outer() {
      const callback = () => {
        var callbackValue = 1;
      };

      var outerValue = 2;
    }
  `);

  const functions = report.scopes.filter(
    item => item.type === "FUNCTION"
  );

  assert.equal(functions.length, 2);

  const callbackBinding = findBinding(
    report,
    "callbackValue",
    "VAR"
  );
  const outerBinding = findBinding(report, "outerValue", "VAR");

  assert.ok(callbackBinding);
  assert.ok(outerBinding);
  assert.notEqual(callbackBinding.scopeId, outerBinding.scopeId);
  assert.ok(functions.some(item => item.id === callbackBinding.scopeId));
});

test("creates a class scope separate from the module scope", () => {
  const report = analyze(`
    class Wallet {
      connect() {}
    }
  `);

  const moduleScope = findScope(report, "MODULE");
  const classScope = findScope(
    report,
    "CLASS",
    moduleScope.id
  );

  assert.ok(classScope);

  const methodScope = report.scopes.find(
    item =>
      item.type === "FUNCTION" &&
      item.parentScopeId === classScope.id
  );

  assert.ok(methodScope);
});

test("creates a catch scope for the catch parameter", () => {
  const report = analyze(`
    function execute() {
      try {
        run();
      } catch (error) {
        handle(error);
      }
    }
  `);

  const catchScope = findScope(report, "CATCH");
  assert.ok(catchScope);

  const binding = findBinding(
    report,
    "error",
    "CATCH_PARAMETER"
  );

  assert.ok(binding);
  assert.equal(binding.scopeId, catchScope.id);

  const bodyScope = findScope(
    report,
    "BLOCK",
    catchScope.id
  );

  assert.ok(bodyScope);
});

test("creates a loop scope for lexical loop declarations", () => {
  const report = analyze(`
    function execute() {
      for (let index = 0; index < 3; index++) {
        const value = index;
      }
    }
  `);

  const loopScope = findScope(report, "LOOP");
  assert.ok(loopScope);

  const indexBinding = findBinding(report, "index", "LET");
  assert.ok(indexBinding);
  assert.equal(indexBinding.scopeId, loopScope.id);

  const bodyScope = findScope(
    report,
    "BLOCK",
    loopScope.id
  );

  assert.ok(bodyScope);

  const valueBinding = findBinding(report, "value", "CONST");
  assert.ok(valueBinding);
  assert.equal(valueBinding.scopeId, bodyScope.id);
});

test("creates loop scopes for for-of and for-in lexical declarations", () => {
  const report = analyze(`
    function execute(items, object) {
      for (const item of items) {
        consume(item);
      }

      for (let key in object) {
        consume(key);
      }
    }
  `);

  const loops = report.scopes.filter(
    item => item.type === "LOOP"
  );

  assert.equal(loops.length, 2);

  const itemBinding = findBinding(report, "item", "CONST");
  const keyBinding = findBinding(report, "key", "LET");

  assert.ok(itemBinding);
  assert.ok(keyBinding);
  assert.ok(loops.some(item => item.id === itemBinding.scopeId));
  assert.ok(loops.some(item => item.id === keyBinding.scopeId));
});

test("creates an internal name binding for named class expressions", () => {
  const report = analyze(`
    const Engine = class InternalEngine {
      create() {
        return InternalEngine;
      }
    };
  `);

  const internalBinding = findBinding(
    report,
    "InternalEngine",
    "CLASS_NAME"
  );

  assert.ok(internalBinding);

  const classScope = findScope(report, "CLASS");
  assert.ok(classScope);
  assert.equal(internalBinding.scopeId, classScope.id);

  assert.equal(
    report.bindings.some(
      item =>
        item.name === "InternalEngine" &&
        item.kind === "CLASS"
    ),
    false
  );
});

test("supports destructured catch parameters", () => {
  const report = analyze(`
    try {
      execute();
    } catch ({ message, code }) {
      reportError(message, code);
    }
  `);

  const catchScope = findScope(report, "CATCH");
  assert.ok(catchScope);

  for (const name of ["message", "code"]) {
    const binding = findBinding(
      report,
      name,
      "CATCH_PARAMETER"
    );

    assert.ok(binding, `Missing catch binding: \${name}`);
    assert.equal(binding.scopeId, catchScope.id);
  }
});

test("uses one shared lexical scope for all switch cases", () => {
  const report = analyze(`
    function execute(value) {
      switch (value) {
        case 1:
          let firstValue = 1;
          break;
        default:
          const secondValue = 2;
      }
    }
  `);

  const switchScope = findScope(report, "SWITCH");
  assert.ok(switchScope);

  for (const [name, kind] of [
    ["firstValue", "LET"],
    ["secondValue", "CONST"]
  ]) {
    const binding = findBinding(report, name, kind);
    assert.ok(binding, `Missing binding: \${name}`);
    assert.equal(binding.scopeId, switchScope.id);
  }
});

test("keeps var declarations inside class static blocks", () => {
  const report = analyze(`
    function execute() {
      class Wallet {
        static {
          var internalState = 1;
        }
      }

      var externalState = 2;
    }
  `);

  const staticScope = findScope(report, "STATIC_BLOCK");
  assert.ok(staticScope);

  const internalBinding = findBinding(
    report,
    "internalState",
    "VAR"
  );

  const externalBinding = findBinding(
    report,
    "externalState",
    "VAR"
  );

  assert.ok(internalBinding);
  assert.ok(externalBinding);

  assert.equal(internalBinding.scopeId, staticScope.id);
  assert.notEqual(internalBinding.scopeId, externalBinding.scopeId);
});

test("scope identifiers are unique within one analysis report", () => {
  const report = analyze(`
    class Wallet {
      connect() {
        if (true) {
          const value = 1;
        }
      }
    }

    function execute() {
      try {
        run();
      } catch (error) {
        recover(error);
      }
    }
  `);

  const ids = report.scopes.map(scope => scope.id);

  assert.equal(new Set(ids).size, ids.length);
});

test("binding identifiers are unique within one analysis report", () => {
  const report = analyze(`
    const value = 1;

    function execute(value) {
      let local = value;

      if (true) {
        let local = 2;
      }
    }

    class Wallet {}
  `);

  const ids = report.bindings.map(binding => binding.id);

  assert.equal(new Set(ids).size, ids.length);
});

test("every non-root scope references an existing parent scope", () => {
  const report = analyze(`
    function execute() {
      for (let index = 0; index < 2; index++) {
        try {
          consume(index);
        } catch (error) {
          recover(error);
        }
      }
    }
  `);

  const ids = new Set(report.scopes.map(scope => scope.id));

  for (const scope of report.scopes) {
    if (scope.parentScopeId === null) {
      assert.equal(scope.type, "MODULE");
    } else {
      assert.ok(
        ids.has(scope.parentScopeId),
        "Scope parent must exist: " + scope.id
      );
    }
  }

  assert.equal(
    report.scopes.filter(scope => scope.parentScopeId === null).length,
    1
  );
});

test("freezes report arrays and nested records", () => {
  const report = analyze(`
    const enabled = true;

    function execute(value) {
      return value;
    }
  `);

  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.scopes));
  assert.ok(Object.isFrozen(report.bindings));
  assert.ok(Object.isFrozen(report.diagnostics));

  for (const scope of report.scopes) {
    assert.ok(Object.isFrozen(scope));
  }

  for (const binding of report.bindings) {
    assert.ok(Object.isFrozen(binding));
  }
});

test("keeps class declaration and named class expression identities separate", () => {
  const report = analyze(`
    class Wallet {}

    const Engine = class InternalEngine {};
  `);

  const walletOuter = findBinding(report, "Wallet", "CLASS");
  const walletInner = findBinding(report, "Wallet", "CLASS_NAME");
  const engineOuter = findBinding(report, "Engine", "CONST");
  const engineInner = findBinding(
    report,
    "InternalEngine",
    "CLASS_NAME"
  );

  assert.ok(walletOuter);
  assert.ok(walletInner);
  assert.ok(engineOuter);
  assert.ok(engineInner);

  assert.notEqual(walletOuter.scopeId, walletInner.scopeId);
  assert.notEqual(engineOuter.scopeId, engineInner.scopeId);
});

function parseForScopeTest(source) {
  return parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true
  });
}

test("maps every visited AST node to its evaluation scope", () => {
  const source = `
    const moduleValue = 1;

    function execute(parameter) {
      const localValue = parameter;

      if (localValue) {
        consume(localValue);
      }
    }
  `;

  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true
  });

  const report = analyzeScopes(ast);

  assert.ok(Array.isArray(report.nodeScopes));

  const mapping = new Map(
    report.nodeScopes.map(item => [item.nodeId, item.scopeId])
  );

  const moduleScope = findScope(report, "MODULE");
  const functionScope = findScope(report, "FUNCTION", moduleScope.id);
  const functionBodyScope = findScope(
    report,
    "FUNCTION_BODY",
    functionScope.id
  );
  const blockScope = findScope(
    report,
    "BLOCK",
    functionBodyScope.id
  );

  assert.ok(moduleScope);
  assert.ok(functionScope);
  assert.ok(functionBodyScope);
  assert.ok(blockScope);

  function nodeId(node) {
    return node.type + ":" + node.start + ":" + node.end;
  }

  const declaration = ast.body[0];
  const functionDeclaration = ast.body[1];
  const parameter = functionDeclaration.params[0];
  const bodyDeclaration = functionDeclaration.body.body[0];
  const ifStatement = functionDeclaration.body.body[1];
  const blockDeclaration = ifStatement.consequent.body[0];

  assert.equal(mapping.get(nodeId(ast)), moduleScope.id);
  assert.equal(mapping.get(nodeId(declaration)), moduleScope.id);
  assert.equal(mapping.get(nodeId(functionDeclaration)), moduleScope.id);
  assert.equal(mapping.get(nodeId(parameter)), functionScope.id);
  assert.equal(mapping.get(nodeId(functionDeclaration.body)), functionBodyScope.id);
  assert.equal(mapping.get(nodeId(bodyDeclaration)), functionBodyScope.id);
  assert.equal(mapping.get(nodeId(ifStatement.consequent)), blockScope.id);
  assert.equal(mapping.get(nodeId(blockDeclaration)), blockScope.id);

  assert.equal(new Set(report.nodeScopes.map(item => item.nodeId)).size,
    report.nodeScopes.length);

  assert.ok(Object.isFrozen(report.nodeScopes));
  for (const item of report.nodeScopes) {
    assert.ok(Object.isFrozen(item));
    assert.ok(
      report.scopes.some(scope => scope.id === item.scopeId)
    );
  }
});

test("evaluates class heritage outside the class scope", () => {
  const ast = parse(
    "class Wallet extends BaseWallet { method() { return this; } }",
    { ecmaVersion: "latest", sourceType: "module", locations: true }
  );

  const report = analyzeScopes(ast);
  const mapping = new Map(
    report.nodeScopes.map(item => [item.nodeId, item.scopeId])
  );

  const declaration = ast.body[0];
  const heritage = declaration.superClass;
  const classScope = findScope(report, "CLASS");

  const id = node =>
    node.type + ":" + node.start + ":" + node.end;

  assert.ok(classScope);
  assert.equal(mapping.get(id(heritage)), mapping.get(id(declaration)));
  assert.notEqual(mapping.get(id(declaration.body)), mapping.get(id(heritage)));
});

test("evaluates computed class keys outside the class body scope", () => {
  const ast = parse(
    "class Wallet { [computedKey]() { return true; } }",
    { ecmaVersion: "latest", sourceType: "module", locations: true }
  );

  const report = analyzeScopes(ast);
  const mapping = new Map(
    report.nodeScopes.map(item => [item.nodeId, item.scopeId])
  );

  const declaration = ast.body[0];
  const method = declaration.body.body[0];
  const classScope = findScope(report, "CLASS");

  const id = node =>
    node.type + ":" + node.start + ":" + node.end;

  assert.ok(classScope);
  assert.equal(mapping.get(id(method.key)), mapping.get(id(declaration)));
  assert.notEqual(mapping.get(id(method.value.body)), mapping.get(id(method.key)));
});

test("evaluates for-of right-hand expression outside loop scope", () => {
  const ast = parse(
    "for (const item of sourceItems) { consume(item); }",
    { ecmaVersion: "latest", sourceType: "module", locations: true }
  );

  const report = analyzeScopes(ast);
  const mapping = new Map(
    report.nodeScopes.map(item => [item.nodeId, item.scopeId])
  );

  const loop = ast.body[0];
  const loopScope = findScope(report, "LOOP");

  const id = node =>
    node.type + ":" + node.start + ":" + node.end;

  assert.ok(loopScope);
  assert.equal(mapping.get(id(loop.right)), mapping.get(id(loop)));
  assert.notEqual(mapping.get(id(loop.body)), mapping.get(id(loop.right)));
});


test("maps CatchClause nodes to their CATCH scope", () => {
  const report = analyze(
    "try { run(); } catch (error) { handle(error); }"
  );

  const ast = parseForScopeTest(
    "try { run(); } catch (error) { handle(error); }"
  );

  const catchNode = ast.body[0].handler;
  const mapping = new Map(
    report.nodeScopes.map(item => [item.nodeId, item.scopeId])
  );

  const catchScope = findScope(report, "CATCH");

  assert.ok(catchScope);
  assert.equal(
    mapping.get(
      catchNode.type + ":" + catchNode.start + ":" + catchNode.end
    ),
    catchScope.id
  );
});

test("maps StaticBlock nodes to their STATIC_BLOCK scope", () => {
  const source = "class Wallet { static { var state = 1; } }";
  const report = analyze(source);
  const ast = parseForScopeTest(source);

  const staticNode = ast.body[0].body.body[0];
  const mapping = new Map(
    report.nodeScopes.map(item => [item.nodeId, item.scopeId])
  );

  const staticScope = findScope(report, "STATIC_BLOCK");

  assert.ok(staticScope);
  assert.equal(
    mapping.get(
      staticNode.type + ":" + staticNode.start + ":" + staticNode.end
    ),
    staticScope.id
  );
});

test("every binding exposes its exact declaration node ID", () => {
  const source = `
    import wallet from "./wallet.mjs";
    const amount = 10;
    function execute(parameter) {
      let result = parameter;
      return result;
    }
  `;

  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true
  });

  const report = analyzeScopes(ast);
  const identifiers = new Map();

  function walk(node) {
    if (!node || typeof node !== "object") return;

    if (
      node.type === "Identifier" &&
      Number.isInteger(node.start) &&
      Number.isInteger(node.end)
    ) {
      identifiers.set(
        `Identifier:${node.start}:${node.end}`,
        node
      );
    }

    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end"].includes(key)) continue;

      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === "string") {
            walk(child);
          }
        }
      } else if (value && typeof value.type === "string") {
        walk(value);
      }
    }
  }

  walk(ast);

  for (const binding of report.bindings) {
    assert.equal(
      typeof binding.declarationNodeId,
      "string",
      `Missing declarationNodeId: ${binding.name}`
    );

    assert.ok(
      identifiers.has(binding.declarationNodeId),
      `Invalid declarationNodeId: ${binding.name}`
    );

    assert.equal(
      identifiers.get(binding.declarationNodeId).name,
      binding.name
    );
  }
});

test("destructured bindings expose individual declaration node IDs", () => {
  const source = `
    const {
      wallet: { address },
      ...rest
    } = input;

    const [first, ...remaining] = values;
  `;

  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true
  });

  const report = analyzeScopes(ast);

  const expectedNames = [
    "address",
    "rest",
    "first",
    "remaining"
  ];

  for (const name of expectedNames) {
    const binding = findBinding(report, name, "CONST");
    assert.ok(binding, `Missing binding: ${name}`);

    const node = ast.body
      .flatMap(statement =>
        statement.type === "VariableDeclaration"
          ? statement.declarations
          : []
      );

    const identifiers = new Map();

    function walk(value) {
      if (!value || typeof value !== "object") return;

      if (value.type === "Identifier") {
        identifiers.set(
          `Identifier:${value.start}:${value.end}`,
          value
        );
      }

      for (const [key, child] of Object.entries(value)) {
        if (["loc", "start", "end"].includes(key)) continue;

        if (Array.isArray(child)) {
          child.forEach(item => {
            if (item && typeof item.type === "string") walk(item);
          });
        } else if (child && typeof child.type === "string") {
          walk(child);
        }
      }
    }

    node.forEach(walk);

    assert.equal(
      identifiers.get(binding.declarationNodeId)?.name,
      name
    );
  }

  assert.equal(
    new Set(
      expectedNames.map(name =>
        findBinding(report, name, "CONST").declarationNodeId
      )
    ).size,
    expectedNames.length
  );
});

test("named function expression binding exposes its internal identifier node", () => {
  const source = `
    const runner = function InternalRunner() {
      return InternalRunner;
    };
  `;

  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true
  });

  const report = analyzeScopes(ast);
  const binding = findBinding(
    report,
    "InternalRunner",
    "FUNCTION_NAME"
  );

  assert.ok(binding);
  assert.equal(
    binding.declarationNodeId,
    `Identifier:${ast.body[0].declarations[0].init.id.start}:${ast.body[0].declarations[0].init.id.end}`
  );
});

test("named class expression binding exposes its internal identifier node", () => {
  const source = `
    const Engine = class InternalEngine {};
  `;

  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true
  });

  const report = analyzeScopes(ast);
  const binding = findBinding(
    report,
    "InternalEngine",
    "CLASS_NAME"
  );

  assert.ok(binding);

  const identifier = ast.body[0].declarations[0].init.id;

  assert.equal(
    binding.declarationNodeId,
    `Identifier:${identifier.start}:${identifier.end}`
  );
});

test("adding declaration node IDs preserves binding identity and immutability", () => {
  const source = `
    const enabled = true;

    function execute(value) {
      return value;
    }
  `;

  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true
  });

  const report = analyzeScopes(ast);

  const expected = [
    {
      node: ast.body[0].declarations[0].id,
      kind: "CONST"
    },
    {
      node: ast.body[1].id,
      kind: "FUNCTION"
    },
    {
      node: ast.body[1].params[0],
      kind: "PARAMETER"
    }
  ];

  for (const { node, kind } of expected) {
    const expectedId =
      `binding:${kind}:${node.name}:${node.start}:${node.end}`;

    assert.ok(
      report.bindings.some(binding => binding.id === expectedId),
      `Existing binding ID changed or missing: ${expectedId}`
    );
  }

  for (const binding of report.bindings) {
    assert.ok(Object.isFrozen(binding));
    assert.ok(binding.declarationNodeId);
  }
});
