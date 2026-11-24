import { createEngineDescriptor, createExecutionResult } from '../core/contracts.mjs';
import { readFileSync } from 'node:fs';
import * as acorn from 'acorn';

const ENGINE_ID = 'noctra.taint-analyzer';

export const descriptor = createEngineDescriptor({
  id: ENGINE_ID,
  name: 'Noctra Taint Analysis Engine',
  version: '1.1.0',
  domain: 'security',
  capabilities: ['scan', 'taint-tracking', 'data-flow-analysis'],
  inputContract: 'universal.input.v1',
  outputContract: 'universal.result.v1',
  metadata: { permissions: ['audit:read'], dependencies: ['acorn'] }
});

const SOURCE_PATTERNS = ['req.body', 'req.query', 'req.params', 'req.headers', 'process.argv', 'document.location', 'window.name'];
const SINK_FUNCTIONS = ['eval', 'Function', 'setTimeout', 'setInterval', 'exec', 'execSync'];

// Fungsi rekursif untuk membangun jalur lengkap (misal: "req.body.expression")
function getNodePath(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') {
    const objPath = getNodePath(node.object);
    const prop = node.property.name || node.property.value;
    return objPath ? `${objPath}.${prop}` : prop;
  }
  if (node.type === 'CallExpression') {
    const calleePath = getNodePath(node.callee);
    return calleePath ? `${calleePath}()` : '';
  }
  return '';
}

function isSource(node) {
  const path = getNodePath(node);
  // Cek apakah jalur ini cocok atau dimulai dengan pola sumber yang dikenal
  return SOURCE_PATTERNS.some(p => path === p || path.startsWith(p + '.') || p.includes(path));
}

function runTaintAnalysis(filePath, sourceCode) {
  const findings = [];
  const lines = sourceCode.split('\n');
  const taintedVars = new Set();

  try {
    const ast = acorn.parse(sourceCode, { ecmaVersion: 'latest', sourceType: 'module', locations: true });

    function walk(node) {
      if (!node || typeof node !== 'object') return;

      // 1. Deteksi SOURCE: Tandai variabel sebagai "terkontaminasi"
      if (node.type === 'VariableDeclarator' && node.init && isSource(node.init)) {
        if (node.id.type === 'Identifier') taintedVars.add(node.id.name);
      }
      if (node.type === 'AssignmentExpression' && isSource(node.right)) {
        if (node.left.type === 'Identifier') taintedVars.add(node.left.name);
      }

      // 2. Deteksi SINK: Cek apakah variabel tainted masuk ke fungsi berbahaya
      if (node.type === 'CallExpression') {
        const calleeName = node.callee.name || (node.callee.property ? node.callee.property.name : '');
        
        if (SINK_FUNCTIONS.includes(calleeName)) {
          const hasTaintedArg = node.arguments.some(arg => 
            arg.type === 'Identifier' && taintedVars.has(arg.name)
          );

          if (hasTaintedArg) {
            const lineNum = node.loc ? node.loc.start.line : 0;
            findings.push({
              rule: 'TAINT_FLOW_TO_DANGEROUS_SINK',
              severity: 'CRITICAL',
              message: `Taint Analysis: User-controlled data ('${node.arguments.find(a => taintedVars.has(a.name))?.name}') flows into ${calleeName}().`,
              file: filePath,
              line: lineNum,
              snippet: lines[lineNum - 1].trim()
            });
          }
        }
      }

      // 3. Deteksi SINK Khusus: innerHTML
      if (node.type === 'AssignmentExpression' && 
          node.left.type === 'MemberExpression' && 
          node.left.property.name === 'innerHTML') {
        
        if (node.right.type === 'Identifier' && taintedVars.has(node.right.name)) {
          const lineNum = node.loc ? node.loc.start.line : 0;
          findings.push({
            rule: 'TAINT_FLOW_TO_INNERHTML',
            severity: 'HIGH',
            message: `Taint Analysis: User-controlled data ('${node.right.name}') assigned to innerHTML.`,
            file: filePath,
            line: lineNum,
            snippet: lines[lineNum - 1].trim()
          });
        }
      }

      // Rekursi ke child nodes
      for (const key in node) {
        if (['loc', 'range', 'parent', 'start', 'end'].includes(key)) continue;
        const child = node[key];
        if (Array.isArray(child)) child.forEach(walk);
        else if (child != null && typeof child === 'object') walk(child);
      }
    }

    walk(ast);
  } catch (e) {
    // Abaikan file yang tidak bisa di-parse (misal: file non-JS yang lolos filter)
  }

  return findings;
}

export async function execute(request) {
  const startedAt = new Date().toISOString();
  const targetFiles = request.input.targetFiles || [];
  const jsFiles = targetFiles.filter(f => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.ts') || f.endsWith('.tsx'));
  const allFindings = [];
  const errors = [];

  for (const file of jsFiles) {
    try {
      const source = readFileSync(file, 'utf-8');
      const vulns = runTaintAnalysis(file, source);
      allFindings.push(...vulns);
    } catch (error) {
      errors.push({ file, error: error.message });
    }
  }

  return createExecutionResult({
    requestId: request.requestId,
    engineId: ENGINE_ID,
    status: 'SUCCEEDED',
    startedAt,
    finishedAt: new Date().toISOString(),
    output: { scannedFiles: jsFiles.length, findings: allFindings, errors: errors }
  });
}
