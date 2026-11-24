import { createExecutionRequest } from '../../../tools/nea/core/contracts.mjs';
import { writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

// Import engines secara modular
import { descriptor as vulnDescriptor, execute as vulnExecute } from '../../../tools/nea/engines/vulnerability-scanner.mjs';
import { descriptor as depDescriptor, execute as depExecute } from '../../../tools/nea/engines/dependency-checker.mjs';

function collectTargetFiles(dirPath, files = []) {
  const entries = readdirSync(dirPath);
  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      collectTargetFiles(fullPath, files);
    } else if (stat.isFile()) {
      const ext = extname(entry);
      // Tambahkan package.json ke dalam target yang dipindai
      if (['.js', '.mjs', '.jsx', '.ts', '.tsx', '.json'].includes(ext) || entry === 'package.json') {
        files.push(fullPath);
      }
    }
  }
  return files;
}

export async function scanCommand(targetPath, flags) {
  if (!targetPath) throw new Error('Please provide a target path to scan');
  const format = flags.format || 'text';
  const outputFile = flags.output;
  
  console.log(`Scanning: ${targetPath}`);
  console.log(`Format: ${format}\n`);

  try {
    const files = collectTargetFiles(targetPath);
    console.log(`Found ${files.length} target files\n`);

    if (files.length === 0) {
      console.log('✅ No files to scan.');
      return;
    }

    console.log('🚀 Initializing Multi-Engine NEA Scan...');
    const requestId = `noctra-multi-${Date.now()}`;
    
    // 1. Buat Execution Request yang sah untuk Vulnerability Scanner
    const vulnRequest = createExecutionRequest({
      requestId,
      engineId: vulnDescriptor.id,
      operation: 'scan',
      input: { targetFiles: files }
    });

    // 2. Buat Execution Request yang sah untuk Dependency Checker
    const depRequest = createExecutionRequest({
      requestId,
      engineId: depDescriptor.id,
      operation: 'scan',
      input: { targetFiles: files }
    });

    console.log('🚀 Executing engines in parallel via NEA Contracts...\n');
    
    // 3. Jalankan kedua engine secara paralel (Manual Orchestration)
    const results = await Promise.all([
      vulnExecute(vulnRequest),
      depExecute(depRequest)
    ]);

    // 4. Agregasi hasil dari semua engine
    const aggregatedFindings = [];
    const aggregatedErrors = [];
    let totalScanned = 0;

    for (const result of results) {
      if (result.output) {
        totalScanned = Math.max(totalScanned, result.output.scannedFiles || 0);
        if (result.output.findings) aggregatedFindings.push(...result.output.findings);
        if (result.output.errors) aggregatedErrors.push(...result.output.errors);
      }
    }

    const finalOutput = {
      scannedFiles: totalScanned,
      findings: aggregatedFindings,
      errors: aggregatedErrors
    };

    // 5. Format Output
    if (outputFile) {
      writeFileSync(outputFile, JSON.stringify(finalOutput, null, 2));
      console.log(`\n✈️ Report saved to: ${outputFile}`);
    } else if (format === 'json') {
      console.log(JSON.stringify(finalOutput, null, 2));
    } else {
      console.log('=== 🛡️ Noctra Multi-Engine Scan Summary ===');
      console.log(`Files scanned: ${finalOutput.scannedFiles}`);
      console.log(`Total Findings: ${finalOutput.findings.length}`);
      console.log(`Errors: ${finalOutput.errors.length}\n`);

      if (finalOutput.findings.length > 0) {
        console.log('🚨 Findings:');
        for (const f of finalOutput.findings) {
          console.log(`  [${f.severity}] ${f.rule} in ${f.file}:${f.line}`);
          console.log(`    Message: ${f.message}`);
          console.log(`    Snippet: ${f.snippet}\n`);
        }
      }

      if (finalOutput.errors.length > 0) {
        console.log('⚠️ Errors:');
        for (const err of finalOutput.errors) console.log(`  ${err.file}: ${err.error}`);
      }
      
      if (finalOutput.findings.length === 0 && finalOutput.errors.length === 0) {
        console.log('✅ No vulnerabilities or errors found!');
      }
    }
  } catch (error) {
    throw new Error(`Failed to scan ${targetPath}: ${error.message}`);
  }
}
