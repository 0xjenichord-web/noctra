import { createEngineDescriptor, createExecutionResult } from '../core/contracts.mjs';
import { readFileSync } from 'node:fs';

const ENGINE_ID = 'noctra.entropy-secret-scanner';

export const descriptor = createEngineDescriptor({
  id: ENGINE_ID,
  name: 'Noctra Entropy Secret Scanner',
  version: '1.0.0',
  domain: 'security',
  capabilities: ['scan', 'entropy-analysis', 'secret-detection'],
  inputContract: 'universal.input.v1',
  outputContract: 'universal.result.v1',
  metadata: { permissions: ['audit:read'], dependencies: [] }
});

// Algoritma Shannon Entropy
function calculateEntropy(str) {
  if (!str) return 0;
  const len = str.length;
  const freq = {};
  for (let i = 0; i < len; i++) {
    const char = str[i];
    freq[char] = (freq[char] || 0) + 1;
  }
  let entropy = 0;
  for (const char in freq) {
    const p = freq[char] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function runEntropyRules(filePath, source) {
  const findings = [];
  // Regex mencari string literal (minimal 20 karakter untuk menghindari noise)
  const stringRegex = /(["'`])([a-zA-Z0-9+/=_\-]{20,})\1/g;
  let match;

  while ((match = stringRegex.exec(source)) !== null) {
    const secretCandidate = match[2];
    const entropy = calculateEntropy(secretCandidate);

    // Threshold > 4.5 biasanya menunjukkan cryptographic key atau token acak
    if (entropy > 4.5) {
      const lineNum = source.substring(0, match.index).split('\n').length;
      const lines = source.split('\n');
      findings.push({
        rule: 'HIGH_ENTROPY_SECRET',
        severity: 'HIGH',
        message: `High entropy string detected (Score: ${entropy.toFixed(2)}). Potential cryptographic key, token, or hash.`,
        file: filePath,
        line: lineNum,
        snippet: lines[lineNum - 1].trim()
      });
    }
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
      const vulns = runEntropyRules(file, source);
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
