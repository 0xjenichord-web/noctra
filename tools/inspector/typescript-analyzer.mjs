import { Parser } from "acorn";
import { tsPlugin } from "@sveltejs/acorn-typescript";
import { analyzeJavaScriptWithBindings } from "./ast-analyzer.mjs";

const TypeScriptParser = Parser.extend(tsPlugin());
const TypeScriptJsxParser = Parser.extend(tsPlugin({ jsx: true }));
const TypeScriptDeclarationParser = Parser.extend(tsPlugin({ dts: true }));

const SUPPORTED_TYPESCRIPT_NODES = new Set([
  "TSInterfaceDeclaration", "TSInterfaceBody", "TSPropertySignature", "TSMethodSignature",
  "TSTypeAliasDeclaration", "TSEnumDeclaration", "TSEnumMember", "TSModuleDeclaration", "TSModuleBlock",
  "TSTypeParameterDeclaration", "TSTypeParameterInstantiation", "TSTypeParameter", "TSTypeAnnotation",
  "TSTypeReference", "TSTypeLiteral", "TSUnionType", "TSIntersectionType", "TSArrayType",
  "TSLiteralType", "TSParenthesizedType", "TSConditionalType", "TSIndexedAccessType", "TSKeyofType", "TSTypeOperator",
  "TSAsExpression", "TSTypeAssertion", "TSNonNullExpression",
  "TSSatisfiesExpression", "TSInstantiationExpression", "TSAnyKeyword", "TSBooleanKeyword",
  "TSBigIntKeyword", "TSIntrinsicKeyword", "TSNeverKeyword", "TSNullKeyword", "TSNumberKeyword",
  "TSObjectKeyword", "TSStringKeyword", "TSSymbolKeyword", "TSUndefinedKeyword", "TSUnknownKeyword",
  "TSVoidKeyword", "TSThisType"
]);
const TYPE_BINDING_KINDS = new Set(["TYPE", "TYPE_PARAMETER", "ENUM", "CLASS", "IMPORT"]);

function getName(node) {
  return node?.name ?? node?.value ?? null;
}

function collectPatternNames(pattern, names = []) {
  if (!pattern) return names;
  if (pattern.type === "Identifier") names.push(pattern.name);
  else if (pattern.type === "RestElement") collectPatternNames(pattern.argument, names);
  else if (pattern.type === "AssignmentPattern") collectPatternNames(pattern.left, names);
  else if (pattern.type === "ArrayPattern") pattern.elements.forEach(item => collectPatternNames(item, names));
  else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) collectPatternNames(property.type === "RestElement" ? property.argument : property.value, names);
  }
  return names;
}

function moduleDeclarations(ast) {
  const imports = [];
  const exports = [];
  for (const node of ast.body) {
    if (node.type === "ImportDeclaration") {
      imports.push({
        source: node.source.value,
        specifiers: node.specifiers.map(specifier => ({
          type: specifier.type,
          imported: getName(specifier.imported),
          local: specifier.local?.name ?? null
        })),
        line: node.loc.start.line,
        column: node.loc.start.column
      });
    } else if (node.type === "ExportNamedDeclaration") {
      const declaration = node.declaration;
      let names = [];
      if (declaration?.type === "VariableDeclaration") {
        names = declaration.declarations.flatMap(item => collectPatternNames(item.id).map(name => ({ exported: name, local: name })));
      } else if (declaration?.id?.name) {
        names = [{ exported: declaration.id.name, local: declaration.id.name }];
      } else if (!declaration) {
        names = node.specifiers.map(specifier => ({ exported: getName(specifier.exported), local: getName(specifier.local) }));
      }
      exports.push({
        type: node.type,
        declarationType: declaration?.type ?? null,
        names,
        source: node.source?.value ?? null,
        line: node.loc.start.line,
        column: node.loc.start.column
      });
    } else if (node.type === "ExportDefaultDeclaration") {
      const declaration = node.declaration;
      exports.push({
        type: node.type,
        declarationType: declaration?.type ?? null,
        names: [{ exported: "default", local: declaration?.id?.name ?? null }],
        source: null,
        line: node.loc.start.line,
        column: node.loc.start.column
      });
    } else if (node.type === "ExportAllDeclaration") {
      exports.push({
        type: node.type,
        declarationType: null,
        names: [{ exported: getName(node.exported) ?? "*", local: null }],
        source: node.source.value,
        line: node.loc.start.line,
        column: node.loc.start.column
      });
    }
  }
  return { imports, exports };
}

function hasUnsupportedTypeScriptNodes(ast) {
  let unsupported = false;
  function visit(node) {
    if (!node || typeof node !== "object" || unsupported) return;
    if (typeof node.type === "string" && node.type.startsWith("TS") && !SUPPORTED_TYPESCRIPT_NODES.has(node.type)) {
      unsupported = true;
      return;
    }
    if (node.type === "TSModuleDeclaration" && node.id?.type !== "Identifier") {
      unsupported = true;
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(ast);
  return unsupported;
}

function hasAmbiguousBindings(scopeAnalysis) {
  const namesByScope = new Set();
  for (const binding of scopeAnalysis.bindings) {
    const key = `${binding.scopeId}\0${binding.name}`;
    if (namesByScope.has(key)) return true;
    namesByScope.add(key);
  }
  return false;
}

function hasIncorrectTypeBindings(ast, analysis) {
  const typeNameIds = new Set();
  function collectTypeName(node) {
    if (node?.type === "Identifier") typeNameIds.add(`Identifier:${node.start}:${node.end}`);
  }
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "TSTypeReference") collectTypeName(node.typeName);
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(ast);
  const bindings = new Map(analysis.bindingResolution.declarations.map(binding => [binding.bindingId, binding.kind]));
  return analysis.bindingResolution.references.some(reference =>
    typeNameIds.has(reference.nodeId) && reference.status === "RESOLVED" && !TYPE_BINDING_KINDS.has(bindings.get(reference.bindingId))
  );
}

function parsedReport(ast) {
  return {
    status: "PARSED",
    sourceType: "module",
    declarations: [],
    ...moduleDeclarations(ast),
    dynamicImports: [],
    calls: [],
    syntaxError: null,
    scopeAnalysis: null,
    bindingResolution: null
  };
}

/** Analyze the covered TypeScript subset; retain PARSED for unsupported AST forms. */
export function analyzeTypeScript(source, { filePath = "source.ts" } = {}) {
  if (typeof source !== "string") throw new TypeError("TypeScript source must be a string");
  const parser = /\.d\.(?:ts|mts|cts)$/i.test(filePath)
    ? TypeScriptDeclarationParser
    : /\.tsx$/i.test(filePath)
    ? TypeScriptJsxParser
    : TypeScriptParser;
  let ast;
  try {
    ast = parser.parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true });
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {
      status: "SYNTAX_ERROR",
      sourceType: "module",
      declarations: [],
      ...moduleDeclarations({ body: [] }),
      dynamicImports: [],
      calls: [],
      syntaxError: {
        message: error.message,
        line: Number.isInteger(error.loc?.line) ? error.loc.line : 1,
        column: Number.isInteger(error.loc?.column) ? error.loc.column : 0
      },
      scopeAnalysis: null,
      bindingResolution: null
    };
  }
  if (hasUnsupportedTypeScriptNodes(ast)) return parsedReport(ast);

  const parse = (text, options) => parser.parse(text, options);
  const analysis = analyzeJavaScriptWithBindings(source, { parse });
  if (analysis.status !== "ANALYZED") return parsedReport(ast);
  if (hasAmbiguousBindings(analysis.scopeAnalysis)) return parsedReport(ast);
  if (hasIncorrectTypeBindings(ast, analysis)) return parsedReport(ast);
  return {
    ...analysis,
    status: "ANALYZED",
    ...moduleDeclarations(ast)
  };
}
