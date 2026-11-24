import { createEngineDescriptor, createExecutionResult } from '../core/contracts.mjs';
import * as parser from '@solidity-parser/parser';
import { readFileSync } from 'node:fs';

const ENGINE_ID = 'noctra.solidity-scanner';

export const descriptor = createEngineDescriptor({
  id: ENGINE_ID,
  name: 'Noctra Solidity Scanner',
  version: '1.0.0',
  domain: 'web3',
  capabilities: ['scan', 'analyze', 'smart-contract-audit'],
  inputContract: 'universal.input.v1',
  outputContract: 'universal.result.v1',
  metadata: {
    permissions: ['audit:read'],
    dependencies: []
  }
});

function runSolidityRules(filePath, source) {
  const findings = [];
  const lines = source.split('\n');

  try {
    const ast = parser.parse(source, { loc: true, tolerant: true });

    function walk(node) {
      if (node == null) return;

      // Rule 1: tx.origin used for authorization (anti-pattern)
      if (node.type === 'MemberAccess' && node.memberName === 'origin') {
        const lineNum = node.loc ? node.loc.start.line : 0;
        findings.push({ rule: 'TX_ORIGIN_AUTH', severity: 'HIGH', message: 'Use of tx.origin detected. Vulnerable to phishing/forwarding attacks. Use msg.sender instead.', file: filePath, line: lineNum, snippet: (lines[lineNum - 1] || '').trim() });
      }

      // Rule 2: delegatecall without proper checks
      if (node.type === 'FunctionCall' && node.expression && node.expression.memberName === 'delegatecall') {
        const lineNum = node.loc ? node.loc.start.line : 0;
        findings.push({ rule: 'UNSAFE_DELEGATECALL', severity: 'CRITICAL', message: 'delegatecall detected. Risk of storage manipulation if implementation is untrusted.', file: filePath, line: lineNum, snippet: (lines[lineNum - 1] || '').trim() });
      }

      // Rule 3: Reentrancy pattern (call then state change)
      if (node.type === 'FunctionCall' && node.expression && node.expression.name === 'call') {
        const lineNum = node.loc ? node.loc.start.line : 0;
        findings.push({ rule: 'POTENTIAL_REENTRANCY', severity: 'HIGH', message: 'External call detected. Verify Checks-Effects-Interactions pattern to prevent reentrancy.', file: filePath, line: lineNum, snippet: (lines[lineNum - 1] || '').trim() });
      }

      // Rule 4: Unchecked transfer
      if (node.type === 'FunctionCall' && node.expression && node.expression.memberName === 'transfer') {
        const lineNum = node.loc ? node.loc.start.line : 0;
        findings.push({ rule: 'UNSAFE_TRANSFER', severity: 'MEDIUM', message: 'transfer() detected. Consider using call{value:} pattern for gas compatibility.', file: filePath, line: lineNum, snippet: (lines[lineNum - 1] || '').trim() });
      }

      // Rule 5: selfdestruct
      if (node.type === 'FunctionCall' && node.expression && (node.expression.name === 'selfdestruct' || node.expression.memberName === 'selfdestruct')) {
        const lineNum = node.loc ? node.loc.start.line : 0;
        findings.push({ rule: 'SELFDESTRUCT_RISK', severity: 'HIGH', message: 'selfdestruct detected. Ensure onlyOwner/onlyAdmin protection is enforced.', file: filePath, line: lineNum, snippet: (lines[lineNum - 1] || '').trim() });
      }

      // Recurse through AST
      for (const key in node) {
        if (key === 'loc' || key === 'range' || key === 'parent' || key === 'start' || key === 'end') continue;
        const child = node[key];
        if (Array.isArray(child)) {
          child.forEach(walk);
        } else if (child != null && typeof child === 'object') {
          walk(child);
        }
      }
    }
    walk(ast);
  } catch (e) {}

  // Rule 6: Hardcoded private key / mnemonic in Solidity (regex)
  const keyRegex = /(privateKey|secret|mnemonic|seed)\s*=\s*["'][a-fA-F0-9]{16,}["']/gi;
  let match;
  while ((match = keyRegex.exec(source)) != null) {
    const lineNum = source.substring(0, match.index).split('\n').length;
    findings.push({ rule: 'HARDCODED_ONCHAIN_SECRET', severity: 'CRITICAL', message: 'Hardcoded private key/secret in Solidity contract.', file: filePath, line: lineNum, snippet: (lines[lineNum - 1] || '').trim() });
  }

  return findings;
}

export async function execute(request) {
  const startedAt = new Date().toISOString();
  const targetFiles = request.input.targetFiles || [];
  const allFindings = [];
  const errors = [];

  for (const file of targetFiles) {
    try {
      const source = readFileSync(file, 'utf-8');
      const vulns = runSolidityRules(file, source);
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
    output: { scannedFiles: targetFiles.length, findings: allFindings, errors: errors }
  });
}
