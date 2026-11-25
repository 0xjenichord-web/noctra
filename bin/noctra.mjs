#!/usr/bin/env node
const VERSION = "2.0.0";

import { scanCommand } from '../lib/cli/commands/scan.mjs';
import { descriptor as bountyDescriptor, execute as bountyExecute } from '../tools/nea/engines/bounty-hunter.mjs';
import { descriptor as trackerDescriptor, execute as trackerExecute } from '../tools/nea/engines/contract-tracker.mjs';
import { createExecutionRequest } from '../tools/nea/core/contracts.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// --- Watchlist Manager ---
const WATCHLIST_DIR = join(homedir(), '.noctra');
const WATCHLIST_FILE = join(WATCHLIST_DIR, 'watchlist.json');

if (!existsSync(WATCHLIST_DIR)) mkdirSync(WATCHLIST_DIR);
if (!existsSync(WATCHLIST_FILE)) writeFileSync(WATCHLIST_FILE, '[]');

function getWatchlist() { return JSON.parse(readFileSync(WATCHLIST_FILE, 'utf-8')); }
function saveWatchlist(list) { writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2)); }

const args = process.argv.slice(2);
const command = args[0];
const subCommand = args[1];

if (!command || command === '--help' || command === '-h') {
  console.log(`
NOCTRA v${VERSION} - Web3 Security Intelligence System

COMMANDS:
  scan <path>                Scan project for vulnerabilities
  hunt <keyword> [min]       Search public bug bounty programs
  track <0x...>              Track a single contract address
  watchlist add <0x..> [name] Add address to local watchlist
  watchlist list             Show all saved addresses
  watchlist track            Track ALL addresses in watchlist
  watchlist remove <0x..>    Remove address from watchlist
  --version                  Show version number
  `);
  process.exit(0);
}

if (command === '--version' || command === '-v') { console.log(`Noctra v${VERSION}`); process.exit(0); }

if (command === 'scan') {
  const targetPath = args[1];
  const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : 'text';
  const output = args.includes('--output') ? args[args.indexOf('--output') + 1] : null;
  if (!targetPath) { console.error('Error: Please provide a target path.'); process.exit(1); }
  try { await scanCommand(targetPath, { format, output }); } catch (error) { console.error(`Error: ${error.message}`); process.exit(1); }

} else if (command === 'hunt') {
  const keyword = args[1] || ''; const minBounty = parseInt(args[2]) || 0;
  console.log(`🛡️ Noctra Bounty Hunter v${VERSION}\n================================`);
  try {
    const req = createExecutionRequest({ requestId: `hunt-${Date.now()}`, engineId: bountyDescriptor.id, operation: 'search', input: { keyword, minBounty, limit: 10 } });
    const result = await bountyExecute(req);
    console.log(`\n🎯 Found ${result.output.findings.length} targets:\n`);
    for (const f of result.output.findings) console.log(`✅ ${f.message}\n   🔗 ${f.file}\n`);
  } catch (error) { console.error(`\n❌ Hunt failed: ${error.message}`); }
  process.exit(0);

} else if (command === 'track') {
  const address = args[1];
  if (!address || !address.startsWith('0x')) { console.error('Error: Provide valid 0x address.'); process.exit(1); }
  console.log(`🛰️ Noctra Tracker v${VERSION}\n================================`);
  try {
    const req = createExecutionRequest({ requestId: `track-${Date.now()}`, engineId: trackerDescriptor.id, operation: 'track', input: { address } });
    const result = await trackerExecute(req);
    console.log(`\n🎯 Results:\n`);
    for (const f of result.output.findings) {
      const icon = f.severity === 'HIGH' ? '💰' : '✅';
      console.log(`${icon} ${f.message}\n   📝 ${f.snippet}\n`);
    }
  } catch (error) { console.error(`\n❌ Track failed: ${error.message}`); }
  process.exit(0);

} else if (command === 'watchlist') {
  let list = getWatchlist();
  
  if (subCommand === 'add') {
    const address = args[2]; const name = args[3] || 'Unnamed';
    if (!address || !address.startsWith('0x')) { console.error('Error: Invalid address.'); process.exit(1); }
    if (list.find(i => i.address.toLowerCase() === address.toLowerCase())) { console.error('Error: Already in watchlist.'); process.exit(1); }
    list.push({ address, name, addedAt: new Date().toISOString() });
    saveWatchlist(list);
    console.log(`✅ Added ${name} (${address}) to watchlist.`);
  } 
  else if (subCommand === 'list') {
    console.log(`\n📋 Your Watchlist (${list.length} items):\n`);
    list.forEach((item, i) => console.log(`${i+1}. ${item.name} - ${item.address}`));
    console.log('');
  } 
  else if (subCommand === 'track') {
    if (list.length === 0) { console.log('Watchlist is empty. Use: noctra watchlist add <0x...>'); process.exit(0); }
    console.log(`🛰️ Tracking ${list.length} targets from Watchlist...\n================================`);
    for (const item of list) {
      console.log(`\n🔍 Tracking: ${item.name} (${item.address})`);
      try {
        const req = createExecutionRequest({ requestId: `track-${Date.now()}`, engineId: trackerDescriptor.id, operation: 'track', input: { address: item.address } });
        const result = await trackerExecute(req);
        for (const f of result.output.findings) {
          const icon = f.severity === 'HIGH' ? '💰' : '✅';
          console.log(`  ${icon} ${f.message}`);
        }
      } catch (error) { console.error(`  ❌ Error: ${error.message}`); }
    }
  }
  else if (subCommand === 'remove') {
    const address = args[2];
    const newList = list.filter(i => i.address.toLowerCase() !== address.toLowerCase());
    if (newList.length === list.length) { console.error('Error: Address not found.'); process.exit(1); }
    saveWatchlist(newList);
    console.log(`✅ Removed ${address} from watchlist.`);
  }
  else { console.error('Usage: watchlist [add|list|track|remove]'); }
  process.exit(0);

} else { console.error(`Unknown command: ${command}`); process.exit(1); }
