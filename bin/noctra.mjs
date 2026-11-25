#!/usr/bin/env node

// Hardcoded version to completely avoid Node.js 20+ ESM JSON import errors
const VERSION = "1.0.5";

import { parseArgs } from '../lib/cli/parser.mjs';
import { scanCommand } from '../lib/cli/commands/scan.mjs';
import { descriptor as bountyDescriptor, execute as bountyExecute } from '../tools/nea/engines/bounty-hunter.mjs';
import { createExecutionRequest } from '../tools/nea/core/contracts.mjs';

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === '--help' || command === '-h') {
  console.log(`
NOCTRA - Independent Security Research and Bug Bounty Intelligence System

USAGE:
  noctra <command> [options]

COMMANDS:
  scan <path>          Scan project for vulnerabilities (JS, TS, Solidity, IaC)
  hunt <keyword> [min] Search public bug bounty programs (e.g., web3, defi, crypto)
  --help               Show this help message
  --version            Show version number

EXAMPLES:
  noctra scan ./my-project
  noctra scan ./src --format html --output report.html
  noctra hunt web3 10000
  `);
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  console.log(`Noctra v${VERSION}`);
  process.exit(0);
}

if (command === 'scan') {
  const targetPath = args[1];
  const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : 'text';
  const output = args.includes('--output') ? args[args.indexOf('--output') + 1] : null;
  
  if (!targetPath) {
    console.error('Error: Please provide a target path to scan.');
    console.error('Usage: noctra scan <path> [--format text|json|sarif|html] [--output file]');
    process.exit(1);
  }

  try {
    await scanCommand(targetPath, { format, output });
  } catch (error) {
    console.error(`Error: Failed to scan ${targetPath}: ${error.message}`);
    process.exit(1);
  }
} else if (command === 'hunt') {
  const keyword = args[1] || '';
  const minBounty = parseInt(args[2]) || 0;
  const limit = 10;
  
  console.log(`🛡️ Noctra Bounty Hunter v${VERSION}`);
  console.log(`================================`);
  
  try {
    const req = createExecutionRequest({
      requestId: `hunt-${Date.now()}`,
      engineId: bountyDescriptor.id,
      operation: 'search',
      input: { keyword, minBounty, limit }
    });
    
    const result = await bountyExecute(req);
    
    console.log(`\n🎯 Found ${result.output.findings.length} potential targets:\n`);
    for (const f of result.output.findings) {
      console.log(`✅ ${f.message}`);
      console.log(`   🔗 URL: ${f.file}`);
      console.log(`   📝 Note: ${f.snippet}\n`);
    }
    
    if (result.output.errors.length > 0) {
      console.error(`\n⚠️ Errors:`, result.output.errors);
    }
    console.log(`💡 Tip: Use "noctra scan <cloned-repo-folder>" to scan a target from the list above.`);
  } catch (error) {
    console.error(`\n❌ Hunt failed: ${error.message}`);
  }
  process.exit(0);
} else {
  console.error(`Unknown command: ${command}`);
  console.log(`Run "noctra --help" for usage information.`);
  process.exit(1);
}
