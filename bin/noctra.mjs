#!/usr/bin/env node
const VERSION = "2.6.0 (Magic URL)";

import { scanCommand } from '../lib/cli/commands/scan.mjs';
import { descriptor as bountyDescriptor, execute as bountyExecute } from '../tools/nea/engines/bounty-hunter.mjs';
import { descriptor as trackerDescriptor, execute as trackerExecute } from '../tools/nea/engines/contract-tracker.mjs';
import { descriptor as solanaDescriptor, execute as solanaExecute } from '../tools/nea/engines/solana-scanner.mjs';
import { descriptor as cpiDescriptor, execute as cpiExecute } from '../tools/nea/engines/cpi-spoofing-scanner.mjs';
import { createExecutionRequest } from '../tools/nea/core/contracts.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// --- Watchlist Manager ---
const WATCHLIST_DIR = join(homedir(), '.noctra');
const WATCHLIST_FILE = join(WATCHLIST_DIR, 'watchlist.json');
if (!existsSync(WATCHLIST_DIR)) mkdirSync(WATCHLIST_DIR);
if (!existsSync(WATCHLIST_FILE)) writeFileSync(WATCHLIST_FILE, '[]');
function getWatchlist() { return JSON.parse(readFileSync(WATCHLIST_FILE, 'utf-8')); }
function saveWatchlist(list) { writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2)); }

// --- Magic URL Resolver ---
async function resolveTarget(input) {
  if (input.startsWith('http://') || input.startsWith('https://')) {
    console.log(`\n🌐 Detecting remote repository...`);
    const tempDir = join(tmpdir(), `noctra-${randomUUID()}`);
    console.log(`⏳ Cloning to secure temporary directory (shallow clone)...`);
    try {
      execSync(`git clone --depth 1 --filter=blob:none --sparse ${input} ${tempDir}`, { stdio: 'pipe' });
      // Sparse checkout untuk hemat kuota (hanya ambil folder umum)
      try { execSync(`git -C ${tempDir} sparse-checkout set packages contracts src programs`, { stdio: 'pipe' }); } catch(e) {}
      console.log(`✅ Clone successful. Scanning...\n`);
      return { path: tempDir, isTemp: true };
    } catch (error) {
      console.error(`❌ Failed to clone: ${error.message}`);
      process.exit(1);
    }
  }
  return { path: input, isTemp: false };
}

function cleanup(targetInfo) {
  if (targetInfo.isTemp && existsSync(targetInfo.path)) {
    console.log(`\n🧹 Cleaning up temporary directory...`);
    rmSync(targetInfo.path, { recursive: true, force: true });
  }
}

// --- Smart Formatter ---
function printSmartResults(findings, engineName) {
  const uniqueMap = new Map();
  for (const f of findings) {
    if (f.severity === 'HIGH' || f.severity === 'CRITICAL') {
      const key = `${f.file}|${f.rule}`;
      if (!uniqueMap.has(key)) uniqueMap.set(key, { ...f, count: 1 });
      else uniqueMap.get(key).count++;
    }
  }
  const smartFindings = Array.from(uniqueMap.values());
  console.log(`\n🎯 ${engineName} Smart Results (${smartFindings.length} Unique High/Critical):\n`);
  if (smartFindings.length === 0) console.log("✅ No High/Critical issues found. Code looks clean!");
  else {
    for (const f of smartFindings) {
      const shortFile = f.file.split('/').pop();
      console.log(`🚨 [${f.severity}] ${shortFile}:${f.line} | ${f.rule}`);
      console.log(`   💡 ${f.message}`);
      if (f.count > 1) console.log(`   🔁 Repeats ${f.count}x in this file.`);
      const cleanSnippet = f.snippet.split('\n').map(l => l.trim()).filter(l => l).slice(-2).join(' ');
      console.log(`   💻 ${cleanSnippet}\n`);
    }
  }
  const hiddenCount = findings.filter(x => x.severity !== 'HIGH' && x.severity !== 'CRITICAL').length;
  if (hiddenCount > 0) console.log(`ℹ️ ${hiddenCount} Low/Info findings hidden for clarity.\n`);
}

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === '--help') {
  console.log(`\nNOCTRA v${VERSION}\n\nCOMMANDS:\n  scan <path|url>            Scan JS/TS/Solidity project\n  solana <path|url>          Scan Solana/Anchor Rust project\n  cpi <path|url>             Scan Solana for CPI Spoofing\n  hunt <keyword> [min]       Search public bug bounty programs\n  track <0x...>              Track a contract address\n  watchlist [add|list|...]   Manage watchlist\n`);
  process.exit(0);
}
if (command === '--version') { console.log(`Noctra v${VERSION}`); process.exit(0); }

if (command === 'scan' || command === 'solana' || command === 'cpi') {
  const rawInput = args[1];
  if (!rawInput) { console.error('Error: Please provide a path or GitHub URL.'); process.exit(1); }
  
  (async () => {
    const target = await resolveTarget(rawInput);
    try {
      if (command === 'scan') {
        console.log(`🔍 Scanning: ${target.path}\n================================`);
        await scanCommand(target.path, { format: 'text' });
      } else if (command === 'solana') {
        console.log(`🌊 Noctra Solana Scanner v${VERSION}\n================================`);
        const req = createExecutionRequest({ requestId: `solana-${Date.now()}`, engineId: solanaDescriptor.id, operation: 'scan', input: { targetPath: target.path } });
        const result = await solanaExecute(req);
        printSmartResults(result.output.findings, "Solana Scanner");
      } else if (command === 'cpi') {
        console.log(`🛰️ Noctra CPI Spoofing Scanner v${VERSION}\n================================`);
        const req = createExecutionRequest({ requestId: `cpi-${Date.now()}`, engineId: cpiDescriptor.id, operation: 'scan', input: { targetPath: target.path } });
        const result = await cpiExecute(req);
        printSmartResults(result.output.findings, "CPI Scanner");
      }
    } catch (error) { console.error(`\n❌ Scan failed: ${error.message}`); }
    finally { cleanup(target); } // Auto-delete temp folder!
    process.exit(0);
  })();

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
    for (const f of result.output.findings) console.log(`${f.severity === 'HIGH' ? '💰' : '✅'} ${f.message}`);
  } catch (error) { console.error(`\n❌ Track failed: ${error.message}`); }
  process.exit(0);
} else if (command === 'watchlist') {
  let list = getWatchlist(); const subCommand = args[1];
  if (subCommand === 'add') {
    const address = args[2]; const name = args[3] || 'Unnamed';
    if (!address || !address.startsWith('0x')) { console.error('Error: Invalid address.'); process.exit(1); }
    if (list.find(i => i.address.toLowerCase() === address.toLowerCase())) { console.error('Error: Already in watchlist.'); process.exit(1); }
    list.push({ address, name, addedAt: new Date().toISOString() }); saveWatchlist(list);
    console.log(`✅ Added ${name} (${address}) to watchlist.`);
  } else if (subCommand === 'list') {
    console.log(`\n📋 Your Watchlist (${list.length} items):\n`);
    list.forEach((item, i) => console.log(`${i+1}. ${item.name} - ${item.address}`));
  } else if (subCommand === 'track') {
    if (list.length === 0) { console.log('Watchlist is empty.'); process.exit(0); }
    for (const item of list) {
      console.log(`\n🔍 Tracking: ${item.name} (${item.address})`);
      try {
        const req = createExecutionRequest({ requestId: `track-${Date.now()}`, engineId: trackerDescriptor.id, operation: 'track', input: { address: item.address } });
        const result = await trackerExecute(req);
        for (const f of result.output.findings) console.log(`  ${f.severity === 'HIGH' ? '💰' : '✅'} ${f.message}`);
      } catch (error) { console.error(`  ❌ Error: ${error.message}`); }
    }
  } else if (subCommand === 'remove') {
    const address = args[2]; const newList = list.filter(i => i.address.toLowerCase() !== address.toLowerCase());
    if (newList.length === list.length) { console.error('Error: Address not found.'); process.exit(1); }
    saveWatchlist(newList); console.log(`✅ Removed ${address} from watchlist.`);
  } else { console.error('Usage: watchlist [add|list|track|remove]'); }
  process.exit(0);
} else { console.error(`Unknown command: ${command}`); process.exit(1); }
