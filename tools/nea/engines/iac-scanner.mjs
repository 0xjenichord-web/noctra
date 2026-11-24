import { createEngineDescriptor, createExecutionResult } from '../core/contracts.mjs';
import { readFileSync } from 'node:fs';

const ENGINE_ID = 'noctra.iac-scanner';

export const descriptor = createEngineDescriptor({
  id: ENGINE_ID,
  name: 'Noctra Infrastructure-as-Code Scanner',
  version: '1.0.0',
  domain: 'devsecops',
  capabilities: ['scan', 'iac-analysis', 'container-audit', 'cloud-config-audit'],
  inputContract: 'universal.input.v1',
  outputContract: 'universal.result.v1',
  metadata: { permissions: ['audit:read'], dependencies: [] }
});

// Filter: hanya proses file IaC
function isIacFile(filePath, entry) {
  const name = entry || filePath.split('/').pop();
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return (
    name === 'Dockerfile' || name.startsWith('Dockerfile.') ||
    name.startsWith('docker-compose') || name.startsWith('compose.') ||
    ['tf', 'yaml', 'yml'].includes(ext)
  );
}

function analyzeDockerfile(filePath, source) {
  const findings = [];
  const lines = source.split('\n');
  let hasUserDirective = false;

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (/^USER\s+/i.test(trimmed)) hasUserDirective = true;
    const lineNum = idx + 1;

    if (/^USER\s+root/i.test(trimmed)) {
      findings.push({ rule: 'DOCKERFILE_ROOT_USER', severity: 'HIGH', message: 'Container explicitly runs as root user.', file: filePath, line: lineNum, snippet: trimmed });
    }
    if (/--privileged|--net=host|--network=host/i.test(trimmed)) {
      findings.push({ rule: 'DOCKERFILE_PRIVILEGED_BUILD', severity: 'CRITICAL', message: 'Privileged build/host network detected. Container can escape to host.', file: filePath, line: lineNum, snippet: trimmed });
    }
    if (/^EXPOSE\s+.*(3306|5432|27017|6379|9200)/i.test(trimmed)) {
      findings.push({ rule: 'DOCKERFILE_DB_PORT_EXPOSED', severity: 'MEDIUM', message: 'Database port exposed. Ensure it is not bound to 0.0.0.0.', file: filePath, line: lineNum, snippet: trimmed });
    }
    if (/^ADD\s+https?:\/\//i.test(trimmed)) {
      findings.push({ rule: 'DOCKERFILE_REMOTE_ADD', severity: 'MEDIUM', message: 'ADD from remote URL without checksum. Use COPY + verified download.', file: filePath, line: lineNum, snippet: trimmed });
    }
    if (/^ENV\s+.*(SECRET|PASSWORD|TOKEN|API_KEY|ACCESS_KEY)/i.test(trimmed)) {
      findings.push({ rule: 'DOCKERFILE_SECRET_IN_ENV', severity: 'HIGH', message: 'Secret-like value in ENV directive. Use build-time secrets or runtime injection.', file: filePath, line: lineNum, snippet: trimmed });
    }
  });

  if (!hasUserDirective) {
    findings.push({ rule: 'DOCKERFILE_NO_USER_DIRECTIVE', severity: 'MEDIUM', message: 'No USER directive found. Container defaults to root.', file: filePath, line: 1, snippet: '(default)' });
  }
  return findings;
}

function analyzeCompose(filePath, source) {
  const findings = [];
  const lines = source.split('\n');
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    const lineNum = idx + 1;
    if (/privileged:\s*true/i.test(trimmed)) {
      findings.push({ rule: 'COMPOSE_PRIVILEGED', severity: 'CRITICAL', message: 'privileged: true grants full host device access.', file: filePath, line: lineNum, snippet: trimmed });
    }
    if (/network_mode:\s*["']?host/i.test(trimmed)) {
      findings.push({ rule: 'COMPOSE_HOST_NETWORK', severity: 'HIGH', message: 'network_mode: host bypasses container isolation.', file: filePath, line: lineNum, snippet: trimmed });
    }
    if (/["']\/:\/["']|\/var\/run\/docker\.sock/i.test(trimmed)) {
      findings.push({ rule: 'COMPOSE_HOST_FS_MOUNT', severity: 'CRITICAL', message: 'Host filesystem or Docker socket mounted into container.', file: filePath, line: lineNum, snippet: trimmed });
    }
    if (/["']0\.0\.0\.0:\d+:(3306|5432|27017|6379)["']/.test(trimmed)) {
      findings.push({ rule: 'COMPOSE_DB_PUBLIC_BIND', severity: 'HIGH', message: 'Database bound to 0.0.0.0 (public interface).', file: filePath, line: lineNum, snippet: trimmed });
    }
  });
  return findings;
}

function analyzeK8s(filePath, source) {
  const findings = [];
  const lines = source.split('\n');
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    const lineNum = idx + 1;
    if (/runAsUser:\s*0|runAsNonRoot:\s*false/.test(trimmed)) {
      findings.push({ rule: 'K8S_RUN_AS_ROOT', severity: 'HIGH', message: 'Pod/container allowed to run as root.', file: filePath, line: lineNum, snippet: trimmed });
    }
    if (/privileged:\s*true/.test(trimmed)) {
      findings.push({ rule: 'K8S_PRIVILEGED_CONTAINER', severity: 'CRITICAL', message: 'Privileged container in Kubernetes.', file: filePath, line: lineNum, snippet: trimmed });
    }
    if (/hostPath:/.test(trimmed)) {
      findings.push({ rule: 'K8S_HOST_PATH', severity: 'HIGH', message: 'hostPath volume exposes host filesystem.', file: filePath, line: lineNum, snippet: trimmed });
    }
    if (/allowPrivilegeEscalation:\s*true/.test(trimmed)) {
      findings.push({ rule: 'K8S_PRIV_ESCALATION', severity: 'MEDIUM', message: 'Privilege escalation allowed.', file: filePath, line: lineNum, snippet: trimmed });
    }
  });
  return findings;
}

function analyzeTerraform(filePath, source) {
  const findings = [];
  const lines = source.split('\n');
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    const lineNum = idx + 1;
    if (/acl\s*=\s*["']public-read(-write)?["']/.test(trimmed)) {
      findings.push({ rule: 'TF_PUBLIC_BUCKET', severity: 'CRITICAL', message: 'S3 bucket with public ACL.', file: filePath, line: lineNum, snippet: trimmed });
    }
    if (/cidr_blocks\s*=\s*\[\s*["']0\.0\.0\.0\/0["']/.test(trimmed)) {
      findings.push({ rule: 'TF_OPEN_SECURITY_GROUP', severity: 'HIGH', message: 'Security group open to the entire internet (0.0.0.0/0).', file: filePath, line: lineNum, snippet: trimmed });
    }
    if (/(access_key|secret_key|password)\s*=\s*["'][^"']{8,}["']/.test(trimmed) && !/var\.|variable\./.test(trimmed)) {
      findings.push({ rule: 'TF_HARDCODED_CRED', severity: 'CRITICAL', message: 'Hardcoded credential in Terraform.', file: filePath, line: lineNum, snippet: trimmed });
    }
  });
  return findings;
}

function runIacRules(filePath, source) {
  const name = filePath.split('/').pop();
  if (name === 'Dockerfile' || name.startsWith('Dockerfile.')) return analyzeDockerfile(filePath, source);
  if (name.startsWith('docker-compose') || name.startsWith('compose.')) return analyzeCompose(filePath, source);
  if (name.endsWith('.tf')) return analyzeTerraform(filePath, source);
  if (name.endsWith('.yaml') || name.endsWith('.yml')) {
    // K8s vs compose heuristic
    return /\b(kind|apiVersion|metadata)\b/.test(source) ? analyzeK8s(filePath, source) : analyzeCompose(filePath, source);
  }
  return [];
}

export async function execute(request) {
  const startedAt = new Date().toISOString();
  const allFiles = request.input.targetFiles || [];
  const iacFiles = allFiles.filter(f => isIacFile(f));
  const allFindings = [];
  const errors = [];

  for (const file of iacFiles) {
    try {
      const source = readFileSync(file, 'utf-8');
      allFindings.push(...runIacRules(file, source));
    } catch (error) {
      errors.push({ file, error: error.message });
    }
  }

  return createExecutionResult({
    requestId: request.requestId,
    engineId: ENGINE_ID,
    status: 'SUCCEEDED',
    startedAt,
    finishedAt: new Date().toISOString(),
    output: { scannedFiles: iacFiles.length, findings: allFindings, errors: errors }
  });
}
