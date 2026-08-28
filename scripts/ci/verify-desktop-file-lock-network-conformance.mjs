#!/usr/bin/env node

import fs from 'node:fs';

const REQUIRED_PROTOCOLS = ['nfsv4', 'smb3'];
const evidencePath = process.env.DESKTOP_FILE_LOCK_NETWORK_CONFORMANCE_EVIDENCE?.trim();

if (process.argv.includes('--check-gate-definition')) {
  console.log(
    '[desktop-file-lock-network] gate definition OK; releases require external two-host NFSv4 and SMB3 evidence'
  );
  process.exit(0);
}

if (!evidencePath) {
  throw new Error(
    'DESKTOP_FILE_LOCK_NETWORK_CONFORMANCE_EVIDENCE is required. No suitable two-host ' +
      'self-hosted NFSv4/SMB3 infrastructure is declared by this repository, so this gate ' +
      'fails closed instead of simulating network-lock conformance on a hosted runner.'
  );
}

const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
if (evidence.schemaVersion !== 1 || evidence.gitSha !== process.env.GITHUB_SHA) {
  throw new Error('Network conformance evidence must use schemaVersion 1 and match GITHUB_SHA');
}

for (const protocol of REQUIRED_PROTOCOLS) {
  const result = evidence.protocols?.[protocol];
  const distinctHosts = new Set([result?.hostA, result?.hostB].filter(Boolean));
  if (
    result?.status !== 'passed' ||
    distinctHosts.size !== 2 ||
    result?.fundamentalNameLock !== true ||
    result?.processDeathRecovery !== true ||
    result?.rootSubstitutionFailClosed !== true
  ) {
    throw new Error(
      `${protocol} evidence must prove two distinct hosts, the fundamental name lock, ` +
        'process-death recovery, and fail-closed root substitution'
    );
  }
}

console.log('[desktop-file-lock-network] two-host NFSv4 and SMB3 conformance evidence accepted');
