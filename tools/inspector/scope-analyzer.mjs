function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }

  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }

  return Object.freeze(value);
}

function scopeId(node, type) {
  return `scope:${type}:${node.start}:${node.end}`;
}

function bindingId(node, name, kind) {
  return `binding:${kind}:${name}:${node.start}:${node.end}`;
}

function collectPatternNames(pattern, output = []) {
  if (!pattern) return output;

  switch (pattern.type) {
    case "Identifier":
      output.push(pattern);
      break;

    case "RestElement":
      collectPatternNames(pattern.argument, output);
      break;

    case "AssignmentPattern":
      collectPatternNames(pattern.left, output);
      break;

    case "ArrayPattern":
      for (const element of pattern.elements) {
        collectPatternNames(element, output);
      }
      break;

    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.type === "RestElement") {
          collectPatternNames(property.argument, output);
        } else {
          collectPatternNames(property.value, output);
        }
      }
      break;
  }

  return output;
}

export function analyzeScopes(ast) {
  if (!ast || ast.type !== "Program") {
    throw new TypeError("Expected an Acorn Program AST");
  }

  const scopes = [];
  const bindings = [];
  const nodeScopes = [];
  const nodeScopeIndex = new Map();
  const diagnostics = [];

  function recordNode(node, targetScopeId) {
    if (
      !node ||
      typeof node.type !== "string" ||
      !Number.isInteger(node.start) ||
      !Number.isInteger(node.end)
    ) {
      return;
    }

    const nodeId =
      node.type + ":" + node.start + ":" + node.end;

    const existing = nodeScopeIndex.get(nodeId);

    if (existing) {
      if (existing.scopeId !== targetScopeId) {
        throw new Error(
          "Conflicting scope mapping for AST node: " + nodeId
        );
      }
      return;
    }

    const entry = { nodeId, scopeId: targetScopeId };
    nodeScopeIndex.set(nodeId, entry);
    nodeScopes.push(entry);
  }

  function updateNodeScope(node, targetScopeId) {
    const nodeId =
      node.type + ":" + node.start + ":" + node.end;

    const existing = nodeScopeIndex.get(nodeId);

    if (!existing) {
      throw new Error(
        "Cannot update missing AST node scope: " + nodeId
      );
    }

    existing.scopeId = targetScopeId;
  }

  const rootScopeType = ast.sourceType === "script" ? "SCRIPT" : "MODULE";
  const moduleScopeId = scopeId(ast, rootScopeType);

  scopes.push({
    id: moduleScopeId,
    type: rootScopeType,
    parentScopeId: null
  });

  function addScope(node, type, parentScopeId) {
    const id = scopeId(node, type);

    scopes.push({
      id,
      type,
      parentScopeId
    });

    return id;
  }

  function addBinding(identifier, kind, targetScopeId) {
    if (!identifier || typeof identifier.name !== "string" || !Number.isInteger(identifier.start) || !Number.isInteger(identifier.end)) return;

    bindings.push({
      id: bindingId(identifier, identifier.name, kind),
      name: identifier.name,
      kind,
      scopeId: targetScopeId,
      declarationNodeId:
        `${identifier.type}:${identifier.start}:${identifier.end}`,
      line: identifier.loc?.start.line ?? null,
      column: identifier.loc?.start.column ?? null
    });
  }

  function addPattern(pattern, kind, targetScopeId) {
    for (const identifier of collectPatternNames(pattern)) {
      addBinding(identifier, kind, targetScopeId);
    }
  }

  function nearestVarScope(scopeStack) {
    for (let index = scopeStack.length - 1; index >= 0; index--) {
      const scope = scopeStack[index];

      if (
        scope.type === "FUNCTION" ||
        scope.type === "MODULE" ||
        scope.type === "SCRIPT" ||
        scope.type === "STATIC_BLOCK" ||
        scope.type === "NAMESPACE"
      ) {
        return scope.id;
      }
    }

    return moduleScopeId;
  }

  function visit(node, scopeStack, mode = "normal") {
    if (!node || typeof node !== "object") return;

    const currentScopeId = scopeStack.at(-1).id;
    recordNode(node, currentScopeId);

    switch (node.type) {
      case "ImportDeclaration":
        for (const specifier of node.specifiers) {
          addBinding(specifier.local, "IMPORT", moduleScopeId);
        }

        visitChildren(node, scopeStack);
        return;

      case "TSInterfaceDeclaration":
      case "TSTypeAliasDeclaration":
      case "TSEnumDeclaration": {
        const kind = node.type === "TSEnumDeclaration" ? "ENUM" : "TYPE";
        if (node.id) {
          addBinding(node.id, kind, currentScopeId);
          visit(node.id, scopeStack);
        }
        const scopeType = node.type === "TSEnumDeclaration" ? "ENUM" : "TYPE_DECLARATION";
        const id = addScope(node, scopeType, currentScopeId);
        const declarationStack = [...scopeStack, { id, type: scopeType }];
        for (const [key, value] of Object.entries(node)) {
          if (["id", "loc", "start", "end"].includes(key)) continue;
          if (Array.isArray(value)) value.forEach(child => child?.type && visit(child, declarationStack));
          else if (value?.type) visit(value, declarationStack);
        }
        return;
      }

      case "TSModuleDeclaration": {
        if (node.id?.type !== "Identifier") return;
        addBinding(node.id, "NAMESPACE", currentScopeId);
        visit(node.id, scopeStack);
        const id = addScope(node, "NAMESPACE", currentScopeId);
        if (node.body) visit(node.body, [...scopeStack, { id, type: "NAMESPACE" }]);
        return;
      }

      case "TSTypeParameter":
        addBinding({ ...node, type: "TSTypeParameter" }, "TYPE_PARAMETER", currentScopeId);
        visitChildren(node, scopeStack);
        return;

      case "TSMethodSignature": {
        const id = addScope(node, "TYPE_SIGNATURE", currentScopeId);
        const signatureStack = [...scopeStack, { id, type: "TYPE_SIGNATURE" }];
        if (node.typeParameters) visit(node.typeParameters, signatureStack);
        for (const parameter of node.parameters ?? node.params ?? []) {
          addPattern(parameter, "PARAMETER", id);
          visit(parameter, signatureStack);
        }
        if (node.typeAnnotation ?? node.returnType) visit(node.typeAnnotation ?? node.returnType, signatureStack);
        return;
      }

      case "FunctionDeclaration": {
        if (node.id) {
          addBinding(node.id, "FUNCTION", currentScopeId);
          visit(node.id, scopeStack);
        }

        const functionId = addScope(
          node,
          "FUNCTION",
          currentScopeId
        );

        const functionStack = [
          ...scopeStack,
          { id: functionId, type: "FUNCTION" }
        ];

        if (node.typeParameters) visit(node.typeParameters, functionStack);

        for (const parameter of node.params) {
          addPattern(parameter, "PARAMETER", functionId);
          visit(parameter, functionStack);
        }

        if (node.returnType) visit(node.returnType, functionStack);

        const bodyId = addScope(
          node.body,
          "FUNCTION_BODY",
          functionId
        );

        visit(node.body, [
          ...functionStack,
          { id: bodyId, type: "FUNCTION_BODY" }
        ], "function-body");

        return;
      }

      case "VariableDeclaration": {
        const kind = node.kind.toUpperCase();

        for (const declaration of node.declarations) {
          const targetScopeId =
            node.kind === "var"
              ? nearestVarScope(scopeStack)
              : currentScopeId;

          addPattern(
            declaration.id,
            kind,
            targetScopeId
          );

          visit(declaration, scopeStack);
        }

        return;
      }

      case "ClassDeclaration":
      case "ClassExpression": {
        if (node.type === "ClassDeclaration" && node.id) {
          addBinding(node.id, "CLASS", currentScopeId);
          visit(node.id, scopeStack);
        }

        // Heritage expressions are evaluated outside the class body.
        visit(node.superClass, scopeStack);

        const classId = addScope(
          node,
          "CLASS",
          currentScopeId
        );

        if (node.id) {
          addBinding(node.id, "CLASS_NAME", classId);

          if (node.type === "ClassExpression") {
            visit(node.id, [
              ...scopeStack,
              { id: classId, type: "CLASS" }
            ]);
          }
        }

        const classStack = [
          ...scopeStack,
          { id: classId, type: "CLASS" }
        ];

        if (node.typeParameters) visit(node.typeParameters, classStack);
        if (node.superTypeParameters) visit(node.superTypeParameters, classStack);
        for (const implementation of node.implements ?? []) visit(implementation, classStack);

        recordNode(node.body, classId);

        for (const element of node.body.body) {
          recordNode(element, classId);

          if (element.type === "StaticBlock") {
            visit(element, classStack);
            continue;
          }

          if (element.key) {
            visit(
              element.key,
              element.computed ? scopeStack : classStack
            );
          }

          if (element.value) {
            visit(element.value, classStack);
          }
          if (element.typeAnnotation) visit(element.typeAnnotation, classStack);
        }

        return;
      }

      case "SwitchStatement": {
        visit(node.discriminant, scopeStack);

        const switchId = addScope(
          node,
          "SWITCH",
          currentScopeId
        );

        const switchStack = [
          ...scopeStack,
          { id: switchId, type: "SWITCH" }
        ];

        for (const switchCase of node.cases) {
          visit(switchCase, switchStack);
        }

        return;
      }

      case "StaticBlock": {
        const staticId = addScope(
          node,
          "STATIC_BLOCK",
          currentScopeId
        );

        updateNodeScope(node, staticId);

        visitChildren(node, [
          ...scopeStack,
          { id: staticId, type: "STATIC_BLOCK" }
        ]);

        return;
      }

      case "CatchClause": {
        const catchId = addScope(
          node,
          "CATCH",
          currentScopeId
        );

        updateNodeScope(node, catchId);

        const catchStack = [
          ...scopeStack,
          { id: catchId, type: "CATCH" }
        ];

        if (node.param) {
          addPattern(
            node.param,
            "CATCH_PARAMETER",
            catchId
          );
          visit(node.param, catchStack);
        }

        visit(node.body, catchStack);
        return;
      }

      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const loopDeclaration =
          node.type === "ForStatement"
            ? node.init
            : node.left;

        const hasLexicalDeclaration =
          loopDeclaration?.type === "VariableDeclaration" &&
          loopDeclaration.kind !== "var";

        if (!hasLexicalDeclaration) {
          visitChildren(node, scopeStack);
          return;
        }

        const loopId = addScope(
          node,
          "LOOP",
          currentScopeId
        );

        const loopStack = [
          ...scopeStack,
          { id: loopId, type: "LOOP" }
        ];

        if (node.type === "ForStatement") {
          visit(node.init, loopStack);
          visit(node.test, loopStack);
          visit(node.update, loopStack);
          visit(node.body, loopStack);
        } else {
          visit(node.right, scopeStack);
          visit(node.left, loopStack);
          visit(node.body, loopStack);
        }

        return;
      }

      case "BlockStatement": {
        if (mode === "function-body") {
          visitChildren(node, scopeStack);
          return;
        }

        const id = addScope(
          node,
          "BLOCK",
          currentScopeId
        );

        updateNodeScope(node, id);

        visitChildren(node, [
          ...scopeStack,
          { id, type: "BLOCK" }
        ]);

        return;
      }

      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const functionId = addScope(
          node,
          "FUNCTION",
          currentScopeId
        );

        const functionStack = [
          ...scopeStack,
          { id: functionId, type: "FUNCTION" }
        ];

        if (node.typeParameters) visit(node.typeParameters, functionStack);

        if (node.type === "FunctionExpression" && node.id) {
          addBinding(node.id, "FUNCTION_NAME", functionId);
        }

        for (const parameter of node.params) {
          addPattern(parameter, "PARAMETER", functionId);
          visit(parameter, functionStack);
        }

        if (node.returnType) visit(node.returnType, functionStack);

        if (node.body.type === "BlockStatement") {
          const bodyId = addScope(
            node.body,
            "FUNCTION_BODY",
            functionId
          );

          visit(node.body, [
            ...functionStack,
            { id: bodyId, type: "FUNCTION_BODY" }
          ], "function-body");
        } else {
          visit(node.body, functionStack);
        }

        return;
      }
    }

    visitChildren(node, scopeStack);
  }

  function visitParameterExpressions(pattern, scopeStack) {
    if (!pattern) return;

    if (pattern.type === "AssignmentPattern") {
      visit(pattern.right, scopeStack);
      visitParameterExpressions(pattern.left, scopeStack);
      return;
    }

    if (pattern.type === "RestElement") {
      visitParameterExpressions(pattern.argument, scopeStack);
      return;
    }

    if (pattern.type === "ArrayPattern") {
      for (const element of pattern.elements) {
        visitParameterExpressions(element, scopeStack);
      }
      return;
    }

    if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        if (property.type === "RestElement") {
          visitParameterExpressions(property.argument, scopeStack);
        } else {
          visitParameterExpressions(property.value, scopeStack);
        }
      }
    }
  }

  function visitChildren(node, scopeStack, ignored = new Set()) {
    for (const [key, value] of Object.entries(node)) {
      if (
        ignored.has(key) ||
        key === "loc" ||
        key === "start" ||
        key === "end"
      ) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === "string") {
            visit(child, scopeStack);
          }
        }
      } else if (
        value &&
        typeof value.type === "string"
      ) {
        visit(value, scopeStack);
      }
    }
  }

  visit(ast, [
    { id: moduleScopeId, type: rootScopeType }
  ]);

  return deepFreeze({
    status: "ANALYZED",
    scopes,
    bindings,
    nodeScopes,
    diagnostics
  });
}
