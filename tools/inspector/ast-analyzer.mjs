import { parse } from "acorn";
import { analyzeScopes } from "./scope-analyzer.mjs";
import { resolveBindings } from "./binding-resolver.mjs";

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

function getStaticName(node) {
  if (!node) return null;

  if (
    node.type === "Identifier" ||
    node.type === "PrivateIdentifier"
  ) {
    return node.name;
  }

  if (node.type === "Literal") {
    return String(node.value);
  }

  if (node.type === "ThisExpression") {
    return "this";
  }

  if (node.type === "MemberExpression") {
    const objectName = getStaticName(node.object);
    let propertyName;

    if (node.computed) {
      if (
        node.property?.type !== "Literal" ||
        !["string", "number"].includes(typeof node.property.value)
      ) {
        return null;
      }

      propertyName = String(node.property.value);
    } else {
      propertyName = getStaticName(node.property);
    }

    if (objectName === null || propertyName === null) return null;

    return `${objectName}.${propertyName}`;
  }

  return null;
}

function locationOf(node) {
  return {
    line: node.loc.start.line,
    column: node.loc.start.column
  };
}

function declarationId(node) {
  return `${node.type}:${node.start}:${node.end}`;
}

function analyzeTree(ast) {
  const declarations = [];
  const imports = [];
  const dynamicImports = [];
  const exports = [];
  const calls = [];

  function addDeclaration(
    type,
    name,
    node,
    parentId = null,
    metadata = {}
  ) {
    const id = declarationId(node);

    declarations.push({
      id,
      parentId,
      type,
      name: name ?? null,
      ...locationOf(node),
      endLine: node.loc.end.line,
      endColumn: node.loc.end.column,
      ...metadata
    });

    return id;
  }

  function visitChildren(node, currentFunctionId, context = {}) {
    for (const key of Object.keys(node)) {
      if (
        key === "loc" ||
        key === "start" ||
        key === "end"
      ) {
        continue;
      }

      const child = node[key];

      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item.type === "string") {
            visit(item, node, currentFunctionId, false, context);
          }
        }
      } else if (
        child &&
        typeof child.type === "string"
      ) {
        visit(child, node, currentFunctionId, false, context);
      }
    }
  }

  function visit(
    node,
    parent = null,
    currentFunctionId = null,
    suppressFunctionExpression = false,
    context = {}
  ) {
    if (!node || typeof node !== "object") return;

    switch (node.type) {
      case "FunctionDeclaration": {
        const id = addDeclaration(
          node.type,
          node.id?.name ?? null,
          node,
          currentFunctionId
        );

        visitChildren(node, id, context);
        return;
      }

      case "ArrowFunctionExpression":
      case "FunctionExpression": {
        if (suppressFunctionExpression) {
          visitChildren(node, currentFunctionId, context);
          return;
        }

        const name =
          node.id?.name ??
          (
            parent?.type === "VariableDeclarator"
              ? parent.id?.name
              : null
          );

        const id = addDeclaration(
          node.type,
          name,
          node,
          currentFunctionId
        );

        visitChildren(node, id, context);
        return;
      }

      case "ClassDeclaration": {
        const className = node.id?.name ?? null;

        const classId = addDeclaration(
          node.type,
          className,
          node,
          currentFunctionId
        );

        visitChildren(node, currentFunctionId, {
          ...context,
          classId,
          className
        });

        return;
      }

      case "ClassExpression": {
        const name =
          node.id?.name ??
          (
            parent?.type === "VariableDeclarator"
              ? parent.id?.name
              : null
          );

        const classId = name
          ? addDeclaration(
              node.type,
              name,
              node,
              currentFunctionId
            )
          : null;

        visitChildren(node, currentFunctionId, {
          ...context,
          classId,
          className: name ?? null
        });

        return;
      }

      case "MethodDefinition": {
        const id = addDeclaration(
          node.type,
          getStaticName(node.key),
          node,
          currentFunctionId,
          {
            ownerClassId: context.classId ?? null,
            ownerClassName: context.className ?? null,
            methodKind: node.kind,
            static: Boolean(node.static),
            computed: Boolean(node.computed)
          }
        );

        // Computed method keys are evaluated in the outer scope.
        if (node.key) {
          visit(node.key, node, currentFunctionId, false, context);
        }

        // The FunctionExpression is the method's implementation,
        // not a second independent function declaration.
        if (node.value) {
          visit(node.value, node, id, true, context);
        }

        return;
      }

      case "Property": {
        if (
          node.method ||
          node.kind === "get" ||
          node.kind === "set"
        ) {
          const id = addDeclaration(
            "ObjectMethod",
            getStaticName(node.key),
            node,
            currentFunctionId,
            {
              ownerObjectName: context.ownerObjectName ?? null,
              methodKind: node.kind === "init" ? "method" : node.kind,
              computed: Boolean(node.computed)
            }
          );

          if (node.key) {
            visit(node.key, node, currentFunctionId, false, context);
          }

          if (node.value) {
            visit(node.value, node, id, true, context);
          }

          return;
        }

        visitChildren(node, currentFunctionId, context);
        return;
      }

      case "ObjectExpression": {
        let ownerObjectName = null;

        if (
          parent?.type === "VariableDeclarator" &&
          parent.id?.type === "Identifier"
        ) {
          ownerObjectName = parent.id.name;
        } else if (parent?.type === "AssignmentExpression") {
          ownerObjectName = getStaticName(parent.left);
        } else if (parent?.type === "Property") {
          const propertyName = getStaticName(parent.key);

          if (
            context.ownerObjectName != null &&
            propertyName !== null
          ) {
            ownerObjectName =
              context.ownerObjectName + "." + propertyName;
          }
        }

        visitChildren(node, currentFunctionId, {
          ...context,
          ownerObjectName
        });

        return;
      }

      case "ImportDeclaration":
        imports.push({
          source: node.source.value,
          specifiers: node.specifiers.map(specifier => ({
            type: specifier.type,
            imported:
              specifier.imported?.name ??
              specifier.imported?.value ??
              null,
            local: specifier.local?.name ?? null
          })),
          ...locationOf(node)
        });
        break;

      case "ExportNamedDeclaration": {
        const declaration = node.declaration;
        let names = [];

        if (
          declaration?.type === "FunctionDeclaration" ||
          declaration?.type === "ClassDeclaration"
        ) {
          if (declaration.id?.name) {
            names.push({
              exported: declaration.id.name,
              local: declaration.id.name
            });
          }
        } else if (declaration?.type === "VariableDeclaration") {
          for (const declarator of declaration.declarations) {
            const bindings = collectBindingNames(declarator.id);

            for (const name of bindings) {
              names.push({
                exported: name,
                local: name
              });
            }
          }
        } else if (!declaration) {
          names = node.specifiers.map(specifier => ({
            exported:
              specifier.exported?.name ??
              specifier.exported?.value ??
              null,
            local:
              specifier.local?.name ??
              specifier.local?.value ??
              null
          }));
        }

        exports.push({
          type: node.type,
          declarationType: declaration?.type ?? null,
          names,
          source: node.source?.value ?? null,
          line: node.loc.start.line,
          column: node.loc.start.column
        });
        break;
      }

      case "ExportDefaultDeclaration": {
        const declaration = node.declaration;
        const localName =
          declaration?.type === "FunctionDeclaration" ||
          declaration?.type === "ClassDeclaration"
            ? declaration.id?.name ?? null
            : null;

        exports.push({
          type: node.type,
          declarationType: declaration?.type ?? null,
          names: [{
            exported: "default",
            local: localName
          }],
          source: null,
          line: node.loc.start.line,
          column: node.loc.start.column
        });
        break;
      }

      case "ExportAllDeclaration":
        exports.push({
          type: node.type,
          declarationType: null,
          names: [{ exported: node.exported?.name ?? node.exported?.value ?? "*", local: null }],
          source: node.source.value,
          ...locationOf(node)
        });
        break;

      case "ImportExpression":
        dynamicImports.push({
          type: "DynamicImport",
          source:
            node.source?.type === "Literal" &&
            typeof node.source.value === "string"
              ? node.source.value
              : null,
          sourceType:
            node.source?.type === "Literal" &&
            typeof node.source.value === "string"
              ? "STATIC"
              : "DYNAMIC",
          callerId: currentFunctionId,
          ...locationOf(node)
        });
        break;

      case "CallExpression":
      case "NewExpression":
        calls.push({
          type: node.type,
          name: getStaticName(node.callee),
          callerId: currentFunctionId,
          argumentCount: node.arguments.length,
          optional: Boolean(
            node.optional ||
            node.callee?.optional ||
            parent?.type === "ChainExpression"
          ),
          ...locationOf(node)
        });
        break;
    }

    visitChildren(node, currentFunctionId, context);
  }

  visit(ast);

  return {
    declarations,
    imports,
    dynamicImports,
    exports,
    calls
  };
}

function collectBindingNames(pattern, names = []) {
  if (!pattern) return names;

  switch (pattern.type) {
    case "Identifier":
      names.push(pattern.name);
      break;

    case "RestElement":
      collectBindingNames(pattern.argument, names);
      break;

    case "AssignmentPattern":
      collectBindingNames(pattern.left, names);
      break;

    case "ArrayPattern":
      for (const element of pattern.elements) {
        collectBindingNames(element, names);
      }
      break;

    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.type === "RestElement") {
          collectBindingNames(property.argument, names);
        } else {
          collectBindingNames(property.value, names);
        }
      }
      break;
  }

  return names;
}

export function analyzeJavaScript(source) {
  if (typeof source !== "string") {
    throw new TypeError("JavaScript source must be a string");
  }

  let ast;

  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowHashBang: true
    });
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    return deepFreeze({
      status: "SYNTAX_ERROR",
      sourceType: "module",
      declarations: [],
      imports: [],
      dynamicImports: [],
      exports: [],
      calls: [],
      syntaxError: {
        message: error.message,
        line: Number.isInteger(error.loc?.line)
          ? error.loc.line
          : 1,
        column: Number.isInteger(error.loc?.column)
          ? error.loc.column
          : 0
      }
    });
  }

  return deepFreeze({
    status: "ANALYZED",
    sourceType: "module",
    ...analyzeTree(ast),
    syntaxError: null
  });
}

/** Analyze JavaScript and include lexical scope and binding resolution reports. */
export function analyzeJavaScriptWithBindings(source, { parse: parseSource = parse } = {}) {
  if (typeof source !== "string") {
    throw new TypeError("JavaScript source must be a string");
  }

  let ast;
  let sourceType = "module";
  try {
    try {
      ast = parseSource(source, {
        ecmaVersion: "latest",
        sourceType,
        locations: true,
        allowHashBang: true
      });
    } catch (moduleError) {
      // `with` is valid only in scripts. Retry as a script so the binding
      // resolver can report its dynamic name-resolution region.
      if (!(moduleError instanceof SyntaxError) || !/\bwith\b/.test(source)) {
        throw moduleError;
      }
      const scriptAst = parseSource(source, {
        ecmaVersion: "latest",
        sourceType: "script",
        locations: true,
        allowHashBang: true
      });
      sourceType = "script";
      ast = scriptAst;
    }
    ast.sourceType = sourceType;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return deepFreeze({
      status: "SYNTAX_ERROR",
      sourceType,
      ...analyzeTree({ type: "Program", body: [] }),
      syntaxError: {
        message: error.message,
        line: Number.isInteger(error.loc?.line) ? error.loc.line : 1,
        column: Number.isInteger(error.loc?.column) ? error.loc.column : 0
      },
      scopeAnalysis: null,
      bindingResolution: null
    });
  }

  const scopeAnalysis = analyzeScopes(ast);
  const bindingResolution = resolveBindings(ast, scopeAnalysis);
  return deepFreeze({
    status: "ANALYZED",
    sourceType,
    ...analyzeTree(ast),
    syntaxError: null,
    scopeAnalysis,
    bindingResolution
  });
}
