#!/usr/bin/env node
import { parseArgs } from '../lib/cli/parser.mjs';
import { scanCommand } from '../lib/cli/commands/scan.mjs';

const VERSION = '0.1.0';

function showHelp() {
  console.log(`
NOCTRA - Independent Security Research and Bug Bounty Intelligence System

USAGE:
  noctra <command> [options]

COMMANDS:
  scan <path>          Scan project for vulnerabilities
  --help               Show this help message
  --version            Show version number

EXAMPLES:
  noctra scan ./my-project
  noctra scan ./src --format json
`);
}

function showVersion() {
  console.log(`noctra v${VERSION}`);
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const parsed = parseArgs(args);

    if (parsed.flags.help || args.length === 0) { showHelp(); process.exit(0); }
    if (parsed.flags.version) { showVersion(); process.exit(0); }

    const command = parsed.command;
    if (command === 'scan') {
      await scanCommand(parsed.positional[0], parsed.flags);
    } else {
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}
main();
