import { createEngineDescriptor, createExecutionResult } from '../core/contracts.mjs';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ENGINE_ID = 'noctra.solana-scanner';

export const descriptor = createEngineDescriptor({
  id: ENGINE_ID,
  name: 'Noctra Solana Anchor Scanner',
  version: '1.2.0',
  domain: 'solana',
  capabilities: ['scan', 'anchor-audit', 'pda-validation'],
  inputContract: 'solana.scan.v1',
  outputContract: 'solana.results.v1',
  metadata: { permissions: ['fs:read'], dependencies: [] }
});

const SENSITIVE_NAMES = ['authority', 'admin', 'owner', 'payer', 'creator', 'manager', 'user', 'signer', 'vault', 'state', 'treasury'];
const SENSITIVE_TYPES = ['Account<', 'UncheckedAccount<', 'AccountInfo<', 'SystemAccount<'];
const TWO_STEP_PATTERNS = ['new_', 'next_', 'pending_', 'proposed_'];

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
  const walk = (dir) => {
    const files = readdirSync(dir);
    for (const file of files) {
      const fullPath = join(dir, file);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) walk(fullPath);
      else if (fullPath.endsWith('.rs')) rsFiles.push(fullPath);
    }
  };

  if (existsSync(join(targetPath, 'programs'))) walk(join(targetPath, 'programs'));
  else walk(targetPath);

  console.log(`Found ${rsFiles.length} Rust files. Analyzing (v1.2.0: PDA Seed Check)...`);

  for (const filePath of rsFiles) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      let inAccountsStruct = false;
      let currentAttributes = [];
      let structHasSigner = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.includes('#[derive(Accounts)]')) {
          inAccountsStruct = true;
          currentAttributes = [line];
          structHasSigner = false;
          for (let j = i + 1; j < lines.length; j++) {
            const inner = lines[j].trim();
            if (inner === '}') break;
            if (inner.includes('Signer<') || inner.includes(': Signer')) structHasSigner = true;
          }
          continue;
        }

        if (inAccountsStruct) {
          if (line.startsWith('#[')) {
            currentAttributes.push(line);
          } else if (line.startsWith('pub ') && line.includes(':')) {
            const parts = line.split(':');
            const fieldName = parts[0].replace('pub ', '').trim();
            const fieldType = parts[1].replace(',', '').trim();

            const isSensitiveType = SENSITIVE_TYPES.some(t => fieldType.includes(t));
            const isSensitiveName = SENSITIVE_NAMES.some(n => fieldName.toLowerCase().includes(n));
            const isTwoStep = TWO_STEP_PATTERNS.some(p => fieldName.toLowerCase().startsWith(p));
            const hasCheckComment = lines[i - 1]?.trim().includes('CHECK');
            
            // Cek apakah ada constraint seeds atau owner di attribute
            const hasSeedsConstraint = currentAttributes.some(attr => attr.includes('seeds') || attr.includes('constraint'));

            if (isSensitiveType && isSensitiveName) {
              const hasSigner = currentAttributes.some(attr => attr.includes('signer'));

              if (!hasSigner) {
                let severity = 'HIGH';
                let rule = 'MISSING_SIGNER_CHECK';
                let message = `Field '${fieldName}' lacks 'signer' constraint.`;

                if (isTwoStep && structHasSigner) {
                  severity = 'INFO';
                  rule = 'TWO_STEP_TRANSFER_PATTERN';
                  message = `Field '${fieldName}' is two-step transfer. Likely SAFE.`;
                } else if (hasCheckComment && hasSeedsConstraint) {
                  severity = 'INFO';
                  rule = 'VALIDATED_PDA_WITH_CHECK';
                  message = `Field '${fieldName}' has CHECK comment AND seeds constraint. SAFE.`;
                } else if (hasCheckComment && !hasSeedsConstraint && (fieldName.includes('vault') || fieldName.includes('state') || fieldName.includes('treasury'))) {
                  severity = 'HIGH'; // 🔴 UPGRADE: Ini berpotensi Missing PDA Validation!
                  rule = 'POTENTIAL_MISSING_PDA_VALIDATION';
                  message = `Field '${fieldName}' is Unchecked, has CHECK comment, but LACKS 'seeds' or 'constraint'. Verify manual PDA validation in function body!`;
                } else if (hasCheckComment) {
                  severity = 'LOW';
                  rule = 'EXPLICIT_CHECK_COMMENT';
                  message = `Field '${fieldName}' has /// CHECK comment. Developer claims manual validation.`;
                }

                findings.push({ rule, severity, message, file: filePath, line: i + 1, snippet: `${currentAttributes.join(' ')}\n${line}` });
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

  return createExecutionResult({ requestId: request.requestId, engineId: ENGINE_ID, status: 'SUCCEEDED', startedAt, finishedAt: new Date().toISOString(), output: { scannedFiles: rsFiles.length, findings, errors } });
}
