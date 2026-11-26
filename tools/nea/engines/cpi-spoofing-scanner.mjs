import { createEngineDescriptor, createExecutionResult } from '../core/contracts.mjs';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ENGINE_ID = 'noctra.cpi-spoofing-scanner';

export const descriptor = createEngineDescriptor({
  id: ENGINE_ID,
  name: 'Noctra CPI Spoofing & Owner Validation Scanner',
  version: '1.1.0',
  domain: 'solana',
  capabilities: ['scan', 'cpi-audit', 'owner-validation', 'anchor-aware'],
  inputContract: 'solana.scan.v1',
  outputContract: 'solana.results.v1',
  metadata: { permissions: ['fs:read'], dependencies: [] }
});

export async function execute(request) {
  const startedAt = new Date().toISOString();
  const { targetPath } = request.input || {};
  const findings = [];
  const errors = [];

  if (!targetPath || !existsSync(targetPath)) {
    errors.push({ file: 'cpi-scanner', error: 'Invalid target path' });
    return createExecutionResult({ requestId: request.requestId, engineId: ENGINE_ID, status: 'FAILED', startedAt, finishedAt: new Date().toISOString(), output: { scannedFiles: 0, findings, errors } });
  }

  console.log(`\n🛰️ Scanning for CPI Spoofing (v1.1.0: Anchor-Aware)...`);

  const rsFiles = [];
  const walk = (dir) => {
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        const fullPath = join(dir, file);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) walk(fullPath);
        else if (fullPath.endsWith('.rs')) rsFiles.push(fullPath);
      }
    } catch (e) { /* skip unreadable dirs */ }
  };
  walk(targetPath);

  console.log(`Found ${rsFiles.length} Rust files. Running CPI detectors...`);

  for (const filePath of rsFiles) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // DETECTOR 1: RAW CPI WITHOUT PROGRAM ID CHECK
        // Kita cari invoke manual, BUKAN Anchor ::cpi:: yang sudah aman
        if (/\b(invoke\b|invoke_signed\b)/.test(line) && !line.includes('::cpi::')) {
          const contextStart = Math.max(0, i - 15);
          const context = lines.slice(contextStart, i).join('\n');
          
          const hasValidation = /require!\s*\([^)]*\.key\(\)\s*==/.test(context) ||
                                /assert_keys_eq!\s*\([^)]*program/.test(context) ||
                                /\.owner\s*==/.test(context) ||
                                /\.owner\(\)\s*==/.test(context) ||
                                /assert_eq!\s*\([^)]*owner/.test(context);
          
          if (!hasValidation) {
            findings.push({
              rule: 'RAW_CPI_MISSING_PROGRAM_ID_VALIDATION',
              severity: 'HIGH',
              message: `Raw invoke/invoke_signed without prior program_id validation. High risk of CPI spoofing.`,
              file: filePath,
              line: i + 1,
              snippet: line.trim()
            });
          }
        }

        // DETECTOR 2: UNCHECKED ACCOUNT USED AS TYPED ACCOUNT WITHOUT OWNER CHECK
        if (/pub\s+\w+\s*:\s*UncheckedAccount/.test(line)) {
          const fieldName = line.match(/pub\s+(\w+)\s*:/)?.[1];
          if (!fieldName) continue;
          
          const contextStart = i + 1;
          const contextEnd = Math.min(lines.length, i + 30);
          const context = lines.slice(contextStart, contextEnd).join('\n');
          
          const usedAsTyped = new RegExp(`${fieldName}\\.try_borrow|${fieldName}\\.data|${fieldName}\\.owner|${fieldName}\\.lamports`).test(context);
          const hasOwnerCheck = new RegExp(`require!\\s*\\([^)]*${fieldName}\\.owner|assert.*${fieldName}\\.owner`).test(content);
          
          if (usedAsTyped && !hasOwnerCheck) {
            findings.push({
              rule: 'UNCHECKED_ACCOUNT_MISSING_OWNER_VALIDATION',
              severity: 'HIGH',
              message: `UncheckedAccount '${fieldName}' is used as typed account without owner validation.`,
              file: filePath,
              line: i + 1,
              snippet: line.trim()
            });
          }
        }
      }
    } catch (error) {
      errors.push({ file: filePath, error: error.message });
    }
  }

  return createExecutionResult({
    requestId: request.requestId,
    engineId: ENGINE_ID,
    status: 'SUCCEEDED',
    startedAt,
    finishedAt: new Date().toISOString(),
    output: { scannedFiles: rsFiles.length, findings, errors }
  });
}
