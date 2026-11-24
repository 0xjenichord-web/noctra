import { createEngineDescriptor, createExecutionResult } from '../core/contracts.mjs';
import { readFileSync, existsSync } from 'node:fs';

const ENGINE_ID = 'noctra.dependency-checker';

export const descriptor = createEngineDescriptor({
  id: ENGINE_ID,
  name: 'Noctra Dependency Checker',
  version: '1.0.0',
  domain: 'security',
  capabilities: ['scan', 'dependency-analysis'],
  inputContract: 'universal.input.v1',
  outputContract: 'universal.result.v1',
  metadata: {
    permissions: ['audit:read'],
    dependencies: [] // Bisa ditambahkan dependensi antar engine di sini nanti
  }
});

export async function execute(request) {
  const startedAt = new Date().toISOString();
  const targetFiles = request.input.targetFiles || [];
  const findings = [];
  const errors = [];

  for (const file of targetFiles) {
    if (file.endsWith('package.json')) {
      try {
        if (existsSync(file)) {
          const content = JSON.parse(readFileSync(file, 'utf-8'));
          const deps = Object.keys(content.dependencies || {});
          const devDeps = Object.keys(content.devDependencies || {});
          
          findings.push({
            rule: 'PACKAGE_JSON_ANALYZED',
            severity: 'INFO',
            message: `Found ${deps.length} dependencies and ${devDeps.length} devDependencies.`,
            file: file,
            line: 1,
            snippet: `Dependencies: ${deps.join(', ') || 'None'}`
          });
        }
      } catch (error) {
        errors.push({ file, error: `Invalid JSON: ${error.message}` });
      }
    }
  }

  return createExecutionResult({
    requestId: request.requestId,
    engineId: ENGINE_ID,
    status: 'SUCCEEDED',
    startedAt,
    finishedAt: new Date().toISOString(),
    output: { scannedFiles: targetFiles.length, findings, errors }
  });
}
