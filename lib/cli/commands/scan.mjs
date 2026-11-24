import { createExecutionRequest } from '../../../tools/nea/core/contracts.mjs';
import { writeFileSync, readdirSync, statSync } from 'node:fs';
import { generateHtmlReport } from '../../formatters/html.mjs';
import { join, extname, basename } from 'node:path';

import { descriptor as vulnDescriptor, execute as vulnExecute } from '../../../tools/nea/engines/vulnerability-scanner.mjs';
import { descriptor as taintDescriptor, execute as taintExecute } from '../../../tools/nea/engines/taint-analyzer.mjs';
import { descriptor as iacDescriptor, execute as iacExecute } from '../../../tools/nea/engines/iac-scanner.mjs';
import { descriptor as entDescriptor, execute as entExecute } from '../../../tools/nea/engines/entropy-secret-scanner.mjs';
import { descriptor as solDescriptor, execute as solExecute } from '../../../tools/nea/engines/solidity-scanner.mjs';
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
      if (['.js', '.mjs', '.jsx', '.ts', '.tsx', '.json', '.sol', '.tf', '.yaml', '.yml'].includes(ext) || entry === 'Dockerfile' || entry.startsWith('Dockerfile.') || entry.startsWith('docker-compose') || entry.startsWith('compose.') || entry === 'package.json') {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function convertToSarif(findings, baseDir) {
  return {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "Noctra Security Scanner",
          version: "3.0.0",
          informationUri: "https://github.com/0xjenichord-web/noctra",
          rules: findings.map(f => ({
            id: f.rule,
            shortDescription: { text: f.message },
            defaultConfiguration: { level: f.severity === 'CRITICAL' || f.severity === 'HIGH' ? 'error' : 'warning' }
          }))
        }
      },
      results: findings.map(f => ({
        ruleId: f.rule,
        level: f.severity === 'CRITICAL' || f.severity === 'HIGH' ? 'error' : 'warning',
        message: { text: f.message },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: f.file.replace(baseDir + '/', '') },
            region: { startLine: f.line }
          }
        }]
      }))
    }]
  };
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
    
    const vulnRequest = createExecutionRequest({ requestId, engineId: vulnDescriptor.id, operation: 'scan', input: { targetFiles: files } });
    const depRequest = createExecutionRequest({ requestId, engineId: depDescriptor.id, operation: 'scan', input: { targetFiles: files } });

    console.log('🚀 Executing engines in parallel via NEA Contracts...\n');
    
    const taintRequest = createExecutionRequest({ requestId, engineId: taintDescriptor.id, operation: 'scan', input: { targetFiles: files } });
    const iacRequest = createExecutionRequest({ requestId, engineId: iacDescriptor.id, operation: 'scan', input: { targetFiles: files } });
    const entRequest = createExecutionRequest({ requestId, engineId: entDescriptor.id, operation: 'scan', input: { targetFiles: files } });
    const solRequest = createExecutionRequest({ requestId, engineId: solDescriptor.id, operation: 'scan', input: { targetFiles: files } });
    const results = await Promise.all([vulnExecute(vulnRequest), depExecute(depRequest), solExecute(solRequest), entExecute(entRequest), iacExecute(iacRequest), taintExecute(taintRequest)]);

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

    const finalOutput = { scannedFiles: totalScanned, findings: aggregatedFindings, errors: aggregatedErrors };

    if (format === 'sarif') {
      const sarifData = convertToSarif(aggregatedFindings, process.cwd());
      const targetFile = outputFile || 'noctra-report.sarif';
      writeFileSync(targetFile, JSON.stringify(sarifData, null, 2));
      console.log(`✈️ SARIF report saved to: ${targetFile}`);
    } else if (format === 'html') {
      generateHtmlReport(finalOutput, outputFile || 'noctra-report.html');
    } else if (outputFile) {
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
