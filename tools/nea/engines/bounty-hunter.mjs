import { createEngineDescriptor, createExecutionResult } from '../core/contracts.mjs';

const ENGINE_ID = 'noctra.bounty-hunter';

export const descriptor = createEngineDescriptor({
  id: ENGINE_ID,
  name: 'Noctra Bounty Hunter Aggregator',
  version: '1.1.0',
  domain: 'reconnaissance',
  capabilities: ['search', 'filter', 'aggregate'],
  inputContract: 'bounty.search.v1',
  outputContract: 'bounty.results.v1',
  metadata: { permissions: ['network:read'], dependencies: [] }
});

export async function execute(request) {
  const startedAt = new Date().toISOString();
  const { keyword = '', minBounty = 0, limit = 10 } = request.input || {};
  const findings = [];
  const errors = [];

  try {
    console.log(`\n🔍 Searching public bug bounty programs (Keyword: "${keyword}", Min Bounty: $${minBounty})...`);
    
    // URL yang diperbarui ke path dist/data.json yang aktif
    const response = await fetch('https://raw.githubusercontent.com/projectdiscovery/public-bugbounty-programs/main/dist/data.json');
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}. Dataset might be temporarily unavailable.`);
    }
    
    const data = await response.json();
    const programs = data.programs || [];

    let matchedCount = 0;

    for (const program of programs) {
      const name = program.name || 'Unknown';
      const url = program.url || '';
      
      // Filter berdasarkan kata kunci (case-insensitive)
      const matchKeyword = keyword === '' || 
        name.toLowerCase().includes(keyword.toLowerCase()) ||
        url.toLowerCase().includes(keyword.toLowerCase());

      if (matchKeyword) {
        findings.push({
          rule: 'BUG_BOUNTY_PROGRAM_FOUND',
          severity: 'INFO',
          message: `Eligible Bug Bounty Program: ${name}`,
          file: url,
          line: 1,
          snippet: `Target: ${url} | Keywords matched: ${keyword}`
        });
        matchedCount++;
        
        // Batasi hasil agar tidak membanjiri terminal
        if (matchedCount >= limit) break;
      }
    }

    if (matchedCount === 0) {
      findings.push({
        rule: 'NO_PROGRAMS_FOUND',
        severity: 'INFO',
        message: `No programs found matching keyword "${keyword}". Try broadening your search (e.g., "web3", "defi", "crypto", "hackerone").`,
        file: 'N/A',
        line: 0,
        snippet: 'N/A'
      });
    }

  } catch (error) {
    errors.push({ file: 'bounty-hunter', error: error.message });
  }

  return createExecutionResult({
    requestId: request.requestId,
    engineId: ENGINE_ID,
    status: 'SUCCEEDED',
    startedAt,
    finishedAt: new Date().toISOString(),
    output: { scannedFiles: 1, findings, errors }
  });
}
