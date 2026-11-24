import path from "node:path";
import { analyzeSource } from "./parser-registry.mjs";
import { createSafeFileReader } from "./safe-file-reader.mjs";

const EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx", ".d.ts", ".d.mts", ".d.cts", ".ts", ".mts", ".cts", ".tsx"];

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function candidates(from, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (base.startsWith("../") || base === ".." || base.startsWith("/")) return [];
  if (path.posix.extname(base)) return [base];
  return [...EXTENSIONS.map(ext => base + ext), ...EXTENSIONS.map(ext => `${base}/index${ext}`)];
}

function exportName(item) {
  return item.exported;
}

/** Statically analyze reachable local ES modules without evaluating source text. */
export async function analyzeModules({ rootPath, entryFiles, maxFileBytes } = {}) {
  if (!Array.isArray(entryFiles) || entryFiles.length === 0 || entryFiles.some(file => typeof file !== "string")) {
    throw new TypeError("entryFiles must be a non-empty array of relative paths");
  }
  const reader = await createSafeFileReader({ rootPath, ...(maxFileBytes === undefined ? {} : { maxFileBytes }) });
  const modules = new Map();
  const rawEdges = [];
  const diagnostics = [];
  const queue = [...new Set(entryFiles.map(file => path.posix.normalize(file)))];

  async function resolve(from, specifier, line) {
    if (!specifier.startsWith(".")) return null;
    for (const candidate of candidates(from, specifier)) {
      try {
        const read = await reader.readFile(candidate);
        return { path: candidate, read };
      } catch (error) {
        if (String(error?.message).includes("Sensitive file") || String(error?.message).includes("Symbolic link") || String(error?.message).includes("Unsafe path")) {
          diagnostics.push({ code: "UNREADABLE_MODULE", from, source: specifier, line, message: error.message });
          return null;
        }
      }
    }
    diagnostics.push({ code: "MISSING_MODULE", from, source: specifier, line });
    return null;
  }

  while (queue.length) {
    const id = queue.shift();
    if (modules.has(id)) continue;
    let read;
    try { read = await reader.readFile(id); }
    catch (error) { diagnostics.push({ code: "UNREADABLE_MODULE", module: id, message: error.message }); continue; }
    const analysis = analyzeSource({ source: read.content, filePath: id });
    const report = analysis.report;
    modules.set(id, { id, status: analysis.status, imports: report?.imports ?? [], exports: report?.exports ?? [], syntaxError: report?.syntaxError ?? null, diagnostics: analysis.diagnostics });
    if (analysis.status !== "ANALYZED" && analysis.status !== "PARSED") continue;
    for (const declaration of [...report.imports, ...report.exports.filter(item => item.source)]) {
      const resolved = await resolve(id, declaration.source, declaration.line);
      if (!resolved) continue;
      const target = modules.get(resolved.path);
      if (!target) queue.push(resolved.path);
      rawEdges.push({ from: id, to: resolved.path, source: declaration.source, declaration });
    }
  }

  const publicExports = new Map();
  for (const [id, module] of modules) publicExports.set(id, new Map(module.exports.flatMap(item => item.names.map(name => [name.exported, { ...name, source: item.source }]))));
  // Re-export names may pass through multiple modules; iterate to a fixed point (cycles settle naturally).
  for (let pass = 0; pass < modules.size + 1; pass++) {
    let changed = false;
    for (const edge of rawEdges) {
      const declaration = edge.declaration;
      if (!declaration.source || Array.isArray(declaration.specifiers)) continue;
      const targetNames = publicExports.get(edge.to);
      const exposed = publicExports.get(edge.from);
      if (!targetNames || !exposed) continue;
      if (declaration.type === "ExportAllDeclaration") {
        for (const [name, value] of targetNames) if (name !== "default" && !exposed.has(name)) { exposed.set(name, { exported: name, local: value.local, source: null }); changed = true; }
      } else {
        for (const spec of declaration.names) {
          const found = targetNames.get(spec.local);
          if (found && !exposed.has(spec.exported)) { exposed.set(spec.exported, { exported: spec.exported, local: found.local, source: null }); changed = true; }
        }
      }
    }
    if (!changed) break;
  }

  const edges = rawEdges.map(edge => {
    const sourceExports = publicExports.get(edge.to) ?? new Map();
    const imports = edge.declaration.type === "ExportAllDeclaration"
      ? []
      : Array.isArray(edge.declaration.specifiers)
      ? edge.declaration.specifiers.map(spec => ({ imported: spec.type === "ImportDefaultSpecifier" ? "default" : spec.type === "ImportNamespaceSpecifier" ? "*" : spec.imported, local: spec.local }))
      : edge.declaration.names.map(spec => ({ imported: spec.local, local: spec.exported }));
    const linked = imports.flatMap(spec => {
      const found = sourceExports.get(spec.imported);
      if (!found || spec.imported === "*") return [];
      return [{ ...spec, exported: spec.imported }];
    });
    for (const spec of imports) {
      if (spec.imported !== "*" && !sourceExports.has(spec.imported)) diagnostics.push({ code: "MISSING_EXPORT", from: edge.from, to: edge.to, source: edge.source, imported: spec.imported, local: spec.local, line: edge.declaration.line });
    }
    return { from: edge.from, to: edge.to, source: edge.source, imports, exports: linked };
  });

  const adjacency = new Map([...modules.keys()].map(id => [id, edges.filter(edge => edge.from === id).map(edge => edge.to)]));
  const cycles = [];
  const seenCycles = new Set();
  for (const start of modules.keys()) {
    const visit = (node, route, active) => {
      for (const next of adjacency.get(node) ?? []) {
        if (next === start && route.length > 1) {
          const cycle = [...route].sort(); const key = cycle.join("|");
          if (!seenCycles.has(key)) { seenCycles.add(key); cycles.push(cycle); }
        } else if (!active.has(next) && route.length < modules.size) visit(next, [...route, next], new Set([...active, next]));
      }
    };
    visit(start, [start], new Set([start]));
  }
  return freeze({ status: "ANALYZED", entryFiles: [...new Set(entryFiles)], modules: [...modules.values()].map(module => ({ ...module, exports: [...(publicExports.get(module.id)?.values() ?? [])] })), edges, diagnostics, cycles });
}
