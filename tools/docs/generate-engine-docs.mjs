#!/usr/bin/env node
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function generateDocs() {
  const enginesDir = 'tools/nea/engines';
  const docsDir = 'docs';
  
  mkdirSync(docsDir, { recursive: true });
  
  const files = readdirSync(enginesDir).filter(f => f.endsWith('.mjs'));
  const engines = [];

  for (const file of files) {
    try {
      const module = await import(pathToFileURL(join(process.cwd(), enginesDir, file)).href);
      if (module.descriptor) {
        engines.push({
          file,
          id: module.descriptor.id,
          name: module.descriptor.name,
          version: module.descriptor.version,
          domain: module.descriptor.domain,
          capabilities: module.descriptor.capabilities
        });
      }
    } catch (e) {
      console.warn(`⚠️  Skip ${file}: ${e.message}`);
    }
  }

  let md = `# 🛠️ Available Engines\n\n`;
  md += `> Auto-generated documentation. Run \`npm run docs:generate\` to update.\n\n`;
  md += `Total engines: **${engines.length}**\n\n`;
  md += `| ID | Name | Version | Domain | Capabilities |\n`;
  md += `|----|------|---------|--------|---------------|\n`;
  
  for (const e of engines) {
    md += `| \`${e.id}\` | ${e.name} | ${e.version} | ${e.domain} | ${e.capabilities.join(', ')} |\n`;
  }

  writeFileSync(join(docsDir, 'ENGINES.md'), md);
  console.log(`✅ Generated docs/ENGINES.md with ${engines.length} engines`);
}

generateDocs().catch(console.error);
