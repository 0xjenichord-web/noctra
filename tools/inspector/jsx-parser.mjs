import { Parser } from "acorn";
import jsx from "acorn-jsx";

const JSXParser = Parser.extend(jsx());

export function parseJavaScriptWithJSX(source, options) {
  return JSXParser.parse(source, options);
}
