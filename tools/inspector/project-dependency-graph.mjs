import fs from "node:fs/promises";
import path from "node:path";
import { createSafeFileReader } from "./safe-file-reader.mjs";
import { analyzeSource } from "./parser-registry.mjs";
import { analyzeModules } from "./module-analyzer.mjs";

const EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"]);
const freeze = value => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};

/** Inventory and statically analyze every supported source file beneath rootPath. */
export async function analyzeProjectDependencyGraph({ rootPath, entryFiles = [], maxFileBytes } = {}) {
  if (!Array.isArray(entryFiles) || entryFiles.some(file => typeof file !== "string")) throw new TypeError("entryFiles must be an array of relative paths");
  const reader = await createSafeFileReader({ rootPath, ...(maxFileBytes === undefined ? {} : { maxFileBytes }) });
  const files = [], diagnostics = [];
  async function walk(abs, relative) {
    let entries;
    try { entries = await fs.readdir(abs, { withFileTypes: true }); }
    catch (error) { diagnostics.push({ code: "UNREADABLE_DIRECTORY", path: relative || ".", message: error.message }); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(abs, entry.name);
      if (entry.isSymbolicLink()) { diagnostics.push({ code: "SYMLINK_SKIPPED", path: rel }); continue; }
      if (entry.isDirectory()) { await walk(full, rel); continue; }
      if (entry.isFile() && EXTENSIONS.has(path.posix.extname(entry.name).toLowerCase())) files.push(rel);
    }
  }
  await walk(reader.rootPath, "");
  files.sort((a, b) => a.localeCompare(b, "en"));
  const nodes = [];
  for (const id of files) {
    try {
      const read = await reader.readFile(id);
      const analysis = analyzeSource({ source: read.content, filePath: id });
      const report = analysis.report;
      nodes.push({ id, kind: "module", status: analysis.status, language: analysis.language, sizeBytes: read.sizeBytes, sha256: read.sha256,
        imports: report?.imports ?? [], exports: report?.exports ?? [], syntaxError: report?.syntaxError ?? null,
        scopeAnalysis: report?.scopeAnalysis ?? null, bindingResolution: report?.bindingResolution ?? null,
        diagnostics: analysis.diagnostics });
      for (const diagnostic of analysis.diagnostics) diagnostics.push({ ...diagnostic, path: id, module: id });
      if (analysis.status === "PARSE_ERROR") diagnostics.push({ code: "INVALID_SOURCE", module: id, ...report.syntaxError });
    } catch (error) {
      nodes.push({ id, kind: "module", status: "UNREADABLE" });
      diagnostics.push({ code: "UNREADABLE_FILE", module: id, message: error.message });
    }
  }
  const readable = nodes.filter(node => node.status === "ANALYZED" || node.status === "PARSED").map(node => node.id);
  const moduleReport = readable.length
    ? await analyzeModules({ rootPath, entryFiles: readable, ...(maxFileBytes === undefined ? {} : { maxFileBytes }) })
    : { edges: [], cycles: [], diagnostics: [] };
  const validIds = new Set(readable);
  const edges = moduleReport.edges.filter(edge => validIds.has(edge.from) && validIds.has(edge.to)).map(edge => ({ ...edge, kind: "dependency" }));
  diagnostics.push(...moduleReport.diagnostics);
  const indegree = new Map(nodes.map(node => [node.id, 0]));
  const adjacency = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) { indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1); adjacency.get(edge.from)?.push(edge.to); }
  const entries = [...new Set(entryFiles)].filter(id => validIds.has(id)).sort((a,b)=>a.localeCompare(b,"en"));
  const roots = entries.length ? entries : nodes.filter(node => indegree.get(node.id) === 0 && validIds.has(node.id)).map(node => node.id);
  const reachable = new Set(), queue = [...roots];
  while (queue.length) { const id = queue.shift(); if (reachable.has(id)) continue; reachable.add(id); queue.push(...(adjacency.get(id) ?? [])); }
  const orphanModules = nodes.filter(node => validIds.has(node.id) && indegree.get(node.id) === 0).map(node => node.id);
  const unreachableModules = entries.length ? nodes.filter(node => validIds.has(node.id) && !reachable.has(node.id)).map(node => node.id) : [];
  const sortedDiagnostics = diagnostics.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  return freeze({ status: "ANALYZED", rootPath: reader.rootPath, entryFiles: entries, nodes, edges,
    orphanModules, unreachableModules, cycles: moduleReport.cycles, diagnostics: sortedDiagnostics });
}
