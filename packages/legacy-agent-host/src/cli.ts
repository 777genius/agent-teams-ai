#!/usr/bin/env node
import { createHostServer } from './index.js';
import { createTeamHost } from './composition/TeamHost.js';
import { readTeamHostProfile } from './composition/readProfile.js';

const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
if (major !== 24 || minor < 21) {
  process.stderr.write('legacy-agent-host requires Node >=24.21.0 <25\n');
  process.exit(1);
}

// Legacy portable policies use console for diagnostics. In this captured host
// stdout is exclusively NDJSON; raw policy arguments never become wire/errors.
let diagnosticBytes = 0;
const diagnostic = (): void => {
  const line = 'legacy-agent-host: policy diagnostic\n';
  if (diagnosticBytes + line.length > 8192) return;
  diagnosticBytes += line.length;
  process.stderr.write(line);
};
console.log = diagnostic;
console.info = diagnostic;
console.warn = diagnostic;
console.error = diagnostic;
console.debug = diagnostic;

const streams = { input: process.stdin, output: process.stdout };
let server: ReturnType<typeof createHostServer>;
try {
  const path = process.env.LEGACY_AGENT_HOST_PROFILE_PATH;
  const digest = process.env.LEGACY_AGENT_HOST_PROFILE_SHA256;
  if (path || digest) {
    if (!path || !digest) throw new Error('Invalid host profile');
    server = createTeamHost(readTeamHostProfile(path, digest), streams);
  } else {
    server = createHostServer({ ...streams, buildId: 'legacy-agent-host/0.1.0' });
  }
} catch {
  process.stderr.write('legacy-agent-host: profile unavailable\n');
  process.exit(1);
}
process.once('SIGTERM', () => {
  void server.dispose('signal');
});
process.once('SIGINT', () => {
  void server.dispose('signal');
});
void server.closed.then(({ reason, cleanup }) => {
  // API disposal is separate from native custody; this CLI has no provider yet.
  const success =
    (reason === 'input_eof' || reason === 'disposed' || reason === 'signal') &&
    cleanup === 'completed';
  process.exit(success ? 0 : 1);
});
