function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function nodeId(node) {
  return `${node.type}:${node.start}:${node.end}`;
}

const ignoredKeys = new Set(["loc", "start", "end", "range"]);

export function resolveBindings(ast, scopeReport) {
  if (!ast || ast.type !== "Program") throw new TypeError("Expected an Acorn Program AST");
  if (!scopeReport || !Array.isArray(scopeReport.scopes) || !Array.isArray(scopeReport.bindings) || !Array.isArray(scopeReport.nodeScopes)) {
    throw new TypeError("Expected a Scope Analyzer report");
  }

  const scopeById = new Map(scopeReport.scopes.map(scope => [scope.id, scope]));
  const nodeScope = new Map(scopeReport.nodeScopes.map(entry => [entry.nodeId, entry.scopeId]));
  const bindingByNameScope = new Map();
  const declarationsById = new Map();
  for (const binding of scopeReport.bindings) {
    const key = `${binding.scopeId}\0${binding.name}`;
    if (!bindingByNameScope.has(key)) bindingByNameScope.set(key, []);
    bindingByNameScope.get(key).push(binding);
    declarationsById.set(binding.declarationNodeId, true);
  }

  const nodes = [];
  const parents = new Map();
  const childKey = new Map();
  function collect(node, parent = null, key = null) {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;
    nodes.push(node);
    if (parent) { parents.set(node, parent); childKey.set(node, key); }
    for (const [name, value] of Object.entries(node)) {
      if (ignoredKeys.has(name)) continue;
      if (Array.isArray(value)) value.forEach((child, index) => collect(child, node, `${name}.${index}`));
      else if (value && typeof value === "object" && typeof value.type === "string") collect(value, node, name);
    }
  }
  collect(ast);

  function chain(scopeId) {
    const result = [];
    const seen = new Set();
    while (scopeId && !seen.has(scopeId)) {
      seen.add(scopeId);
      result.push(scopeId);
      scopeId = scopeById.get(scopeId)?.parentScopeId ?? null;
    }
    return result;
  }
  function lookup(name, scopeId) {
    for (const id of chain(scopeId)) {
      const matches = bindingByNameScope.get(`${id}\0${name}`);
      if (matches?.length) return matches[0];
    }
    return null;
  }
  function isReference(node) {
    const parent = parents.get(node);
    if (!parent) return false;
    const key = childKey.get(node) || "";
    if (node.type === "JSXIdentifier") {
      if (parent.type === "JSXOpeningElement" && key === "name") {
        return /^[A-Z]/.test(node.name);
      }
      if (parent.type === "JSXMemberExpression" && key === "object") {
        let member = parent;
        while (parents.get(member)?.type === "JSXMemberExpression") member = parents.get(member);
        const element = parents.get(member);
        return element?.type === "JSXOpeningElement" && childKey.get(member) === "name";
      }
      return false;
    }
    if (declarationsById.has(nodeId(node))) return false;
    if ((parent.type === "TSPropertySignature" || parent.type === "TSMethodSignature") && key === "key" && !parent.computed) return false;
    if ((parent.type === "TSEnumMember" && key === "id") || (parent.type === "TSQualifiedName" && key === "right")) return false;
    if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && key === "property" && !parent.computed) return false;
    if ((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition" || parent.type === "FieldDefinition") && key.endsWith("key") && !parent.computed && !(parent.type === "Property" && parent.shorthand)) return false;
    if ((parent.type === "LabeledStatement" && key === "label") || ((parent.type === "BreakStatement" || parent.type === "ContinueStatement") && key === "label")) return false;
    if (parent.type === "MetaProperty") return false;
    if ((parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier" || parent.type === "ImportNamespaceSpecifier") && key.endsWith("imported")) return false;
    if (parent.type === "ExportSpecifier" && key.endsWith("exported") && parent.local !== parent.exported) return false;
    return true;
  }

  const dynamicWith = new Set();
  const evalFunctions = new Set();
  for (const node of nodes) {
    if (node.type === "WithStatement") dynamicWith.add(node.body);
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "eval") {
      const calleeScope = nodeScope.get(nodeId(node.callee));
      if (!lookup("eval", calleeScope)) {
        let parent = parents.get(node);
        while (parent && !["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "Program"].includes(parent.type)) parent = parents.get(parent);
        if (parent) {
          const functionScope = parent.type === "Program"
            ? nodeScope.get(nodeId(parent))
            : `scope:FUNCTION:${parent.start}:${parent.end}`;
          if (functionScope) evalFunctions.add(functionScope);
        }
      }
    }
  }
  function inside(node, root) {
    for (let current = node; current; current = parents.get(current)) if (current === root) return true;
    return false;
  }

  const declarations = [];
  for (const binding of scopeReport.bindings) {
    const [type, start, end] = binding.declarationNodeId.split(":");
    declarations.push({
      nodeId: binding.declarationNodeId,
      name: binding.name,
      kind: binding.kind,
      bindingId: binding.id,
      scopeId: binding.scopeId,
      line: binding.line ?? null,
      column: binding.column ?? null
    });
  }
  declarations.sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.bindingId.localeCompare(b.bindingId));

  const references = [];
  for (const node of nodes) {
    if ((node.type !== "Identifier" && node.type !== "JSXIdentifier") || !isReference(node)) continue;
    const id = nodeId(node);
    const scopeId = nodeScope.get(id) ?? null;
    const binding = lookup(node.name, scopeId);
    let dynamic = false;
    for (const root of dynamicWith) if (inside(node, root)) { dynamic = true; break; }
    if (!dynamic) {
      const scopes = new Set(chain(scopeId));
      dynamic = [...evalFunctions].some(scope => scopes.has(scope));
    }
    references.push({
      nodeId: id,
      name: node.name,
      scopeId,
      classification: "REFERENCE",
      status: dynamic ? "DYNAMIC" : binding ? "RESOLVED" : "UNRESOLVED",
      bindingId: dynamic || !binding ? null : binding.id,
      line: node.loc?.start.line ?? null,
      column: node.loc?.start.column ?? null
    });
  }
  references.sort((a, b) => a.nodeId.localeCompare(b.nodeId));

  const diagnostics = [];
  for (const scope of scopeReport.scopes) {
    if (scope.type !== "WITH" && scope.type !== "DYNAMIC") continue;
    diagnostics.push({ code: "DYNAMIC_SCOPE", scopeId: scope.id, message: "Bindings in this scope may be affected by dynamic name resolution." });
  }
  return deepFreeze({ status: "RESOLVED", declarations, references, diagnostics });
}
