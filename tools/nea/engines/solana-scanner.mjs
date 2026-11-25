import { createEngineDescriptor, createExecutionResult } from '../core/contracts.mjs';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ENGINE_ID = 'noctra.solana-scanner';

export const descriptor = createEngineDescriptor({
  id: ENGINE_ID,
  name: 'Noctra Solana Anchor Scanner',
  version: '1.0.1',
  domain: 'solana',
  capabilities: ['scan', 'anchor-audit'],
  inputContract: 'solana.scan.v1',
  outputContract: 'solana.results.v1',
  metadata: { permissions: ['fs:read'], dependencies: [] }
});

// Kata kunci field yang WAJIB memiliki tanda tangan (signer)
const SENSITIVE_NAMES = ['authority', 'admin', 'owner', 'payer', 'creator', 'manager', 'user', 'signer'];
// Tipe data Anchor yang sering disalahgunakan
const SENSITIVE_TYPES = ['Account<', 'UncheckedAccount<', 'AccountInfo<', 'SystemAccount<'];

export async function execute(request) {
  const startedAt = new Date().toISOString();
  const { targetPath } = request.input || {};
  const findings = [];
  const errors = [];

  if (!targetPath || !existsSync(targetPath)) {
    errors.push({ file: 'solana-scanner', error: 'Invalid target path' });
    return createExecutionResult({ requestId: request.requestId, engineId: ENGINE_ID, status: 'FAILED', startedAt, finishedAt: new Date().toISOString(), output: { scannedFiles: 0, findings, errors } });
  }

  console.log(`\n🌊 Scanning Solana/Anchor project: ${targetPath}...`);

  const rsFiles = [];
  const programsDir = join(targetPath, 'programs');
  
  // Fungsi rekursif untuk mencari file .rs
  const walk = (dir) => {
    const files = readdirSync(dir);
    for (const file of files) {
      const fullPath = join(dir, file);
      const stat = statSync(fullPath); // ✅ FIX: Menggunakan statSync yang sudah di-import
      if (stat.isDirectory()) walk(fullPath);
      else if (fullPath.endsWith('.rs')) rsFiles.push(fullPath);
    }
  };

  if (existsSync(programsDir)) {
    walk(programsDir);
  } else {
    // Fallback: cari di root jika tidak ada folder programs
    walk(targetPath);
  }

  if (rsFiles.length === 0) {
    findings.push({ rule: 'NO_RUST_FILES', severity: 'INFO', message: 'No .rs files found in target directory.', file: 'N/A', line: 0, snippet: 'N/A' });
    return createExecutionResult({ requestId: request.requestId, engineId: ENGINE_ID, status: 'SUCCEEDED', startedAt, finishedAt: new Date().toISOString(), output: { scannedFiles: 0, findings, errors } });
  }

  console.log(`Found ${rsFiles.length} Rust files. Analyzing Anchor macros...`);

  for (const filePath of rsFiles) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      let inAccountsStruct = false;
      let currentAttributes = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Deteksi awal blok Accounts
        if (line.includes('#[derive(Accounts)]')) {
          inAccountsStruct = true;
          currentAttributes = [line];
          continue;
        }

        if (inAccountsStruct) {
          if (line.startsWith('#[')) {
            currentAttributes.push(line);
          } else if (line.startsWith('pub ') && line.includes(':')) {
            // Parsing field
            const parts = line.split(':');
            const fieldName = parts[0].replace('pub ', '').trim();
            const fieldType = parts[1].replace(',', '').trim();

            const isSensitiveType = SENSITIVE_TYPES.some(t => fieldType.includes(t));
            const isSensitiveName = SENSITIVE_NAMES.some(n => fieldName.toLowerCase().includes(n));

            // LOGIKA DETEKSI: Jika tipe sensitif DAN nama sensitif, tapi TIDAK ada 'signer'
            if (isSensitiveType && isSensitiveName) {
              const hasSigner = currentAttributes.some(attr => attr.includes('signer'));
              
              if (!hasSigner) {
                findings.push({
                  rule: 'MISSING_SIGNER_CHECK',
                  severity: 'HIGH',
                  message: `Anchor Field '${fieldName}' lacks 'signer' constraint. Potential unauthorized execution.`,
                  file: filePath,
                  line: i + 1,
                  snippet: `${currentAttributes.join(' ')}\n${line}`
                });
              }
            }
            currentAttributes = [];
          } else if (line === '}') {
            inAccountsStruct = false;
            currentAttributes = [];
          } else {
            currentAttributes = [];
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
