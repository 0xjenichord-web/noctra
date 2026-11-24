import path from "node:path";
import { analyzeJavaScriptWithBindings } from "./ast-analyzer.mjs";
import { parseJavaScriptWithJSX } from "./jsx-parser.mjs";
import { analyzeTypeScript } from "./typescript-analyzer.mjs";

const freeze = value => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};

/** Parser adapter contract: { language, extensions, analyze(source) => legacy report }. */
export class ParserRegistry {
  #adapters = new Map();

  register(adapter) {
    if (!adapter || typeof adapter.language !== "string" || !Array.isArray(adapter.extensions) || typeof adapter.analyze !== "function") {
      throw new TypeError("Parser adapter must define language, extensions, and analyze(source)");
    }
    for (const extension of adapter.extensions) {
      if (typeof extension !== "string" || !extension.startsWith(".")) throw new TypeError("Parser adapter extensions must begin with a dot");
      this.#adapters.set(extension.toLowerCase(), adapter);
    }
    return this;
  }

  analyze({ source, filePath } = {}) {
    if (typeof source !== "string") throw new TypeError("Source must be a string");
    if (typeof filePath !== "string") throw new TypeError("filePath must be a string");
    const extension = path.posix.extname(filePath).toLowerCase();
    const adapter = this.#adapters.get(extension);
    if (!adapter) {
      return freeze({ status: "UNSUPPORTED_LANGUAGE", language: null, report: null,
        diagnostics: [{ code: "UNSUPPORTED_LANGUAGE", message: `No parser is registered for ${extension || "this file"}`, location: null }] });
    }
    const report = adapter.analyze(source, { filePath });
    if (report.status === "SYNTAX_ERROR") {
      const location = { line: report.syntaxError?.line ?? 1, column: report.syntaxError?.column ?? 0 };
      return freeze({ status: "PARSE_ERROR", language: adapter.language, report,
        diagnostics: [{ code: "PARSE_ERROR", message: report.syntaxError?.message ?? "Unable to parse source", location }] });
    }
    const status = report.status === "PARSED" ? "PARSED" : "ANALYZED";
    return freeze({ status, language: adapter.language, report, diagnostics: [] });
  }
}

export const parserRegistry = new ParserRegistry().register({
  language: "javascript",
  extensions: [".js", ".mjs", ".cjs"],
  analyze: analyzeJavaScriptWithBindings
}).register({
  language: "javascript",
  extensions: [".jsx"],
  analyze: source => analyzeJavaScriptWithBindings(source, { parse: parseJavaScriptWithJSX })
}).register({
  language: "typescript",
  extensions: [".ts", ".mts", ".cts", ".tsx"],
  analyze: analyzeTypeScript
});

export function analyzeSource(input, registry = parserRegistry) {
  if (!registry || typeof registry.analyze !== "function") throw new TypeError("registry must implement analyze(input)");
  return registry.analyze(input);
}
