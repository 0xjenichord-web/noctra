import { descriptor, execute } from './tools/nea/engines/vulnerability-scanner.mjs';
import { createExecutionRequest } from './tools/nea/core/contracts.mjs';

async function main() {
  console.log("🚀 Testing NEA Vulnerability Scanner Engine...\n");
  console.log("Engine Descriptor:", descriptor.id);

  const request = createExecutionRequest({
    requestId: 'scan-req-001',
    engineId: descriptor.id,
    operation: 'scan',
    input: {
      targetFiles: ['test-project/vulnerable.js', 'test-project/config.js']
    }
  });

  console.log("Executing scan...\n");
  const result = await execute(request);
  
  console.log("✅ Scan Complete!");
  console.log("Status:", result.status);
  console.log("Findings:", result.output.findings.length);
  console.log("\nDetailed Report:");
  console.log(JSON.stringify(result.output, null, 2));
}

main().catch(console.error);