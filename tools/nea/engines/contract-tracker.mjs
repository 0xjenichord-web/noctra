import { createEngineDescriptor, createExecutionResult } from '../core/contracts.mjs';

const ENGINE_ID = 'noctra.contract-tracker';

export const descriptor = createEngineDescriptor({
  id: ENGINE_ID,
  name: 'Noctra Enterprise RPC Contract Tracker',
  version: '2.0.0',
  domain: 'reconnaissance',
  capabilities: ['track', 'verify', 'balance'],
  inputContract: 'contract.track.v1',
  outputContract: 'contract.results.v1',
  metadata: { permissions: ['network:read'], dependencies: [] }
});

const CHAINS = [
  { name: 'Ethereum', rpc: 'https://ethereum.publicnode.com', symbol: 'ETH', type: 'MAINNET' },
  { name: 'BNB Smart Chain', rpc: 'https://bsc.publicnode.com', symbol: 'BNB', type: 'MAINNET' },
  { name: 'Polygon', rpc: 'https://polygon-bor.publicnode.com', symbol: 'MATIC', type: 'MAINNET' },
  { name: 'Arbitrum', rpc: 'https://arbitrum-one.publicnode.com', symbol: 'ETH', type: 'MAINNET' },
  { name: 'Optimism', rpc: 'https://optimism.publicnode.com', symbol: 'ETH', type: 'MAINNET' },
  { name: 'Base', rpc: 'https://base.publicnode.com', symbol: 'ETH', type: 'MAINNET' },
  { name: 'Avalanche', rpc: 'https://avalanche-c-chain.publicnode.com', symbol: 'AVAX', type: 'MAINNET' }
];

export async function execute(request) {
  const startedAt = new Date().toISOString();
  const { address } = request.input || {};
  const findings = [];
  const errors = [];

  if (!address) {
    errors.push({ file: 'contract-tracker', error: 'No address provided' });
    return createExecutionResult({ requestId: request.requestId, engineId: ENGINE_ID, status: 'FAILED', startedAt, finishedAt: new Date().toISOString(), output: { scannedFiles: 0, findings, errors } });
  }

  console.log(`\n🔍 Tracking contract: ${address} via PublicNode (Balance + Bytecode)...`);

  for (const chain of CHAINS) {
    try {
      // 1. Cek Bytecode (Apakah ini Smart Contract?)
      const codePayload = { jsonrpc: "2.0", method: "eth_getCode", params: [address.toLowerCase(), "latest"], id: 1 };
      // 2. Cek Balance (Berapa banyak coin di dalamnya?)
      const balancePayload = { jsonrpc: "2.0", method: "eth_getBalance", params: [address.toLowerCase(), "latest"], id: 2 };

      const [codeRes, balRes] = await Promise.all([
        fetch(chain.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Noctra/2.0' }, body: JSON.stringify(codePayload) }),
        fetch(chain.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Noctra/2.0' }, body: JSON.stringify(balancePayload) })
      ]);

      const codeData = await codeRes.json();
      const balData = await balRes.json();

      const bytecode = codeData.result;
      const isContract = bytecode && typeof bytecode === 'string' && bytecode.length > 2;
      
      // Konversi Wei ke Ether (bagi 10^18)
      const balanceWei = BigInt(balData.result || "0");
      const balanceEther = Number(balanceWei) / 1e18;

      if (isContract || balanceEther > 0) {
        findings.push({
          rule: 'CONTRACT_DEPLOYED',
          severity: balanceEther > 0.1 ? 'HIGH' : 'INFO', // Alert jika ada saldo besar!
          message: `${chain.name} (${chain.type}) | Balance: ${balanceEther.toFixed(4)} ${chain.symbol}`,
          file: chain.name,
          line: 1,
          snippet: `Bytecode: ${isContract ? Math.round(bytecode.length / 2) + ' bytes' : 'EOA (Wallet)'} | RPC: PublicNode`
        });
      }
    } catch (error) {
      errors.push({ file: chain.name, error: error.message });
    }
  }

  if (findings.length === 0) {
    findings.push({ rule: 'CONTRACT_NOT_FOUND', severity: 'INFO', message: `Contract/Wallet not found on tracked chains.`, file: 'N/A', line: 0, snippet: 'N/A' });
  }

  return createExecutionResult({ requestId: request.requestId, engineId: ENGINE_ID, status: 'SUCCEEDED', startedAt, finishedAt: new Date().toISOString(), output: { scannedFiles: 1, findings, errors } });
}
