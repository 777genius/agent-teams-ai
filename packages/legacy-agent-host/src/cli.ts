#!/usr/bin/env node
import { createHostServer } from './index.js';

const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
if (major !== 24 || minor < 21) {
  process.stderr.write('legacy-agent-host requires Node >=24.21.0 <25\n');
  process.exit(1);
}

const server = createHostServer({
  input: process.stdin,
  output: process.stdout,
  buildId: 'legacy-agent-host/0.1.0',
});
process.once('SIGTERM', () => {
  void server.dispose('signal');
});
process.once('SIGINT', () => {
  void server.dispose('signal');
});
void server.closed.then(({ reason, cleanup }) => {
  // No provider resources are installed in this transport-only executable.
  const success =
    (reason === 'input_eof' || reason === 'disposed' || reason === 'signal') &&
    cleanup === 'completed';
  process.exit(success ? 0 : 1);
});
