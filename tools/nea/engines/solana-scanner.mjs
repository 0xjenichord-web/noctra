import { createEngineDescriptor, createExecutionResult } from '../core/contracts.mjs';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ENGINE_ID = 'noctra.solana-scanner';
export const descriptor = createEngineDescriptor({
  id: ENGINE_ID, name: 'Noctra Solana Anchor Scanner', version: '1.4.0', domain: 'solana',
  capabilities: ['scan','anchor-audit','multi-line-attr','pda-aware'],
  inputContract: 'solana.scan.v1', outputContract: 'solana.results.v1',
  metadata: { permissions: ['fs:read'], dependencies: [] }
});

const SENS_NAMES = ['authority','admin','owner','payer','creator','manager','user','signer','vault','treasury'];
const SENS_TYPES = ['Account<','UncheckedAccount<','AccountInfo<','SystemAccount<'];
const TWO_STEP = ['new_','next_','pending_','proposed_'];
const VAULT_TYPES = ['TokenAccount','Mint','Vault','Treasury'];

export async function execute(request) {
  const startedAt = new Date().toISOString();
  const { targetPath } = request.input || {};
  const findings = []; const errors = [];
  if (!targetPath || !existsSync(targetPath)) {
    errors.push({file:'solana-scanner',error:'Invalid target path'});
    return createExecutionResult({requestId:request.requestId,engineId:ENGINE_ID,status:'FAILED',startedAt,finishedAt:new Date().toISOString(),output:{scannedFiles:0,findings,errors}});
  }
  console.log(`\n🌊 Scanning: ${targetPath}...`);
  const rsFiles = [];
  const walk = (d) => { try { for (const f of readdirSync(d)) { const p = join(d,f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.rs')) rsFiles.push(p); } } catch(e){} };
  walk(existsSync(join(targetPath,'programs')) ? join(targetPath,'programs') : targetPath);
  console.log(`Found ${rsFiles.length} Rust files. (v1.4.0: Multi-Line Attribute Aware)`);

  for (const filePath of rsFiles) {
    try {
      const lines = readFileSync(filePath,'utf-8').split('\n');
      // PASS 1: struct punya signer?
      const signerFlags = new Array(lines.length).fill(false);
      { let inS=false, depth=0; for (let i=0;i<lines.length;i++){ const t=lines[i].trim();
        if (t.includes('#[derive(Accounts)]')) { inS=true; depth=0; signerFlags[i]=false; continue; }
        if (inS){ if (t.includes('Signer<')||t.includes('signer')) signerFlags[i]=true;
          depth += (t.match(/\{/g)||[]).length - (t.match(/\}/g)||[]).length;
          if (depth<=0 && t==='}') inS=false; } } }

      // PASS 2: parse field dengan attribute multi-line
      let inS=false, attrBuf=[], attrOpen=false;
      for (let i=0;i<lines.length;i++){ const t=lines[i].trim();
        if (t.includes('#[derive(Accounts)]')) { inS=true; attrBuf=[]; attrOpen=false; continue; }
        if (!inS) continue;
        if (t==='}') { inS=false; attrBuf=[]; attrOpen=false; continue; }
        if (t.startsWith('#[')) { attrBuf=[t]; const o=(t.match(/\(/g)||[]).length,c=(t.match(/\)/g)||[]).length; attrOpen=o>c; continue; }
        if (attrOpen) { attrBuf.push(t); const o=(t.match(/\(/g)||[]).length,c=(t.match(/\)/g)||[]).length; if (o<=c) attrOpen=false; continue; }
        if (t.startsWith('pub ') && t.includes(':')) {
          const attrText = attrBuf.join(' ');
          const fieldName = t.split(':')[0].replace('pub ','').trim();
          const fieldType = t.split(':')[1].replace(',','').trim();
          const isType = SENS_TYPES.some(x=>fieldType.includes(x));
          const isName = SENS_NAMES.some(n=>fieldName.toLowerCase().includes(n));
            const isStateTarget = ["state", "config", "pool", "vault"].some(n => fieldName.toLowerCase() === n) && attrText.includes("mut");
          if (isType && isName && !isStateTarget) {
            const hasSigner = attrText.includes('signer');
            const hasSeeds = attrText.includes('seeds')||attrText.includes('constraint')||attrText.includes('init');
            if (!hasSigner) {
              const lookBack = lines.slice(Math.max(0,i-6),i).join('\n');
              const hasCheck = lookBack.includes('/// CHECK')||lookBack.includes('// CHECK');
              const isTwoStep = TWO_STEP.some(p=>fieldName.toLowerCase().startsWith(p));
              const isVault = VAULT_TYPES.some(v=>fieldType.includes(v));
              let severity='HIGH', rule='MISSING_SIGNER_CHECK', message=`Field '${fieldName}' lacks 'signer'.`;
              if (hasSeeds) { severity='INFO'; rule='PDA_VALIDATED_VIA_SEEDS'; message=`Field '${fieldName}' is PDA via seeds/init constraint. No signer needed. SAFE.`; }
              else if (isTwoStep && signerFlags[i]) { severity='INFO'; rule='TWO_STEP_TRANSFER_PATTERN'; message=`Field '${fieldName}' two-step transfer. Likely SAFE.`; }
              else if (isVault) { severity='MEDIUM'; rule='VAULT_NO_EXPLICIT_CONSTRAINT'; message=`Vault '${fieldName}' without constraint. Verify CPI ownership.`; }
              else if (hasCheck) { severity='LOW'; rule='EXPLICIT_CHECK_COMMENT'; message=`Field '${fieldName}' has /// CHECK. Verify manual validation.`; }
              findings.push({rule,severity,message,file:filePath,line:i+1,snippet:`${attrText}\n${t}`});
            }
          }
          attrBuf=[];
        }
      }
    } catch(e){ errors.push({file:filePath,error:e.message}); }
  }
  return createExecutionResult({requestId:request.requestId,engineId:ENGINE_ID,status:'SUCCEEDED',startedAt,finishedAt:new Date().toISOString(),output:{scannedFiles:rsFiles.length,findings,errors}});
}
