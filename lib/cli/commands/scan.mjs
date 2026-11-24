import { descriptor, execute } from '../../../tools/nea/engines/vulnerability-scanner.mjs';
import { createExecutionRequest } from '../../../tools/nea/core/contracts.mjs';
import { writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

function collectJavaScriptFiles(dirPath, files = []) {
  const entries = readdirSync(dirPath);
  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      collectJavaScriptFiles(fullPath, files);
    } else if (stat.isFile()) {
      const ext = extname(entry);
      if (['.js', '.mjs', '.jsx', '.ts', '.tsx'].includes(ext)) files.push(fullPath);
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
    const files = collectJavaScriptFiles(targetPath);
    console.log(`Found ${files.length} JavaScript/TypeScript files\n`);

    if (files.length === 0) {
      console.log('✅ No files to scan.');
      return;
    }

    // 🚀 NEA INTEGRATION: Create a formal execution request
    const request = createExecutionRequest({
      requestId: `noctra-scan-${Date.now()}`,
      engineId: descriptor.id,
      operation: 'scan',
      input: { targetFiles: files }
    });

    console.log(`🚀 Delegating to NEA Engine: ${descriptor.id}...`);
    const result = await execute(request);

    if (outputFile) {
      writeFileSync(outputFile, JSON.stringify(result.output, null, 2));
      console.log(`\n✈️ Report saved to: ${outputFile}`);
    } else if (format === 'json') {
      console.log(JSON.stringify(result.output, null, 2));
    } else {
      console.log('=== Scan Summary ===');
      console.log(`Files scanned: ${result.output.scannedFiles}`);
      console.log(`Vulnerabilities found: ${result.output.findings.length}`);
      console.log(`Files with errors: ${result.output.errors.length}\n`);

      if (result.output.findings.length > 0) {
        console.log('🚨 Vulnerabilities:');
        for (const f of result.output.findings) {
          console.log(`  [${f.severity}] ${f.rule} in ${f.file}:${f.line}`);
          console.log(`    Message: ${f.message}`);
          console.log(`    Snippet: ${f.snippet}\n`);
        }
      }

      if (result.output.errors.length > 0) {
        console.log('⚠️ Errors:');
        for (const err of result.output.errors) console.log(`  ${err.file}: ${err.error}`);
      }
      
      if (result.output.findings.length === 0 && result.output.errors.length === 0) {
        console.log('✅ No vulnerabilities or errors found!');
      }
    }
  } catch (error) {
    throw new Error(`Failed to scan ${targetPath}: ${error.message}`);
  }
}
