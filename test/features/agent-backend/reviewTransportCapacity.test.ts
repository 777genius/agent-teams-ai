// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_HOST_LIMITS,
  REVIEW_HOST_PAYLOAD_BYTES,
} from '@agent-teams/legacy-agent-host/contracts';
import { afterEach, beforeAll, expect, it } from 'vitest';

import { captureBackendPayload } from '../../../src/features/agent-backend/main/application/backendBinding';
import { CapturedHostClient } from '../../../src/features/agent-backend/main/infrastructure/CapturedHostClient';

import type { SelectedHostProfile } from '../../../src/features/agent-backend/main/infrastructure/selectedHostProfile';

it('review payload exact UTF-8 byte limit passes; limit plus one rejects; ordinary and unknown aliases stay one MiB', () => {
  const exact = 'x'.repeat(REVIEW_HOST_PAYLOAD_BYTES - 2);
  expect(captureBackendPayload(exact, 'team.review.invoke')).toBe(exact);
  expect(() => captureBackendPayload(exact + 'x', 'team.review.invoke')).toThrow();
  const ordinary = 'x'.repeat(DEFAULT_HOST_LIMITS.maxFrameBytes - 2);
  expect(captureBackendPayload(ordinary)).toBe(ordinary);
  expect(() => captureBackendPayload(ordinary + 'x')).toThrow();
  expect(() => captureBackendPayload(ordinary + 'x', 'team.review.unbounded')).toThrow();
  // Surrogate pairs count as four UTF-8 bytes, not two JavaScript code units.
  const unicode = '😀'.repeat(DEFAULT_HOST_LIMITS.maxFrameBytes / 4);
  expect(() => captureBackendPayload(unicode)).toThrow();
  expect(captureBackendPayload(unicode, 'team.review.invoke')).toBe(unicode);
});

let nodeExecutable: string, nodeVersion: string, nodeSha256: string, serverUrl: string;
const roots: string[] = [],
  clients: CapturedHostClient[] = [];
beforeAll(async () => {
  nodeExecutable = await realpath(process.env.AGENT_BACKEND_TEST_NODE ?? process.execPath);
  nodeVersion = execFileSync(nodeExecutable, ['--version'], { encoding: 'utf8', env: {} }).trim();
  nodeSha256 = createHash('sha256')
    .update(await readFile(nodeExecutable))
    .digest('hex');
  serverUrl = execFileSync(
    nodeExecutable,
    [
      '--input-type=module',
      '-e',
      'process.stdout.write(import.meta.resolve("@agent-teams/legacy-agent-host"))',
    ],
    { encoding: 'utf8', env: {}, cwd: process.cwd() }
  );
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function capturedReviewClient(
  optIn = true,
  rawOversize: 'review' | 'ordinary' | undefined = undefined
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-review-host-capacity-')));
  roots.push(root);
  const hostEntry = join(root, 'host.mts');
  const raw = rawOversize
    ? `appendFileSync(${JSON.stringify(join(root, 'effects'))}, 'effect\\n'); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:context.requestId,result:'x'.repeat(${rawOversize === 'review' ? '32*1024*1024+64*1024+1' : '1024*1024+1'})}) + '\\n'); return 'ignored';`
    : 'return params;';
  const body = `import { createHostServer } from ${JSON.stringify(serverUrl)};
    import { appendFileSync } from 'node:fs';
    const server = createHostServer({ input: process.stdin, output: process.stdout, buildId:'TEST-review-capacity', reviewTransport:'review-v1', methods:{
      'team.review.invoke':{lane:'work',handle(params,context){ ${rawOversize === 'ordinary' ? 'return params;' : raw} }},
      ordinary:{lane:'work',handle(params,context){ ${rawOversize === 'ordinary' ? raw : 'return params;'} }},
      'team.review.getChangeStats':{lane:'control',handle(){ for(let i=0;i<200;i++)server.notifyData('event',{i}); return 'control'; }}
    }}); void server.closed.then(()=>process.exit(0));`;
  await writeFile(hostEntry, body);
  const profile: SelectedHostProfile = {
    profileId: 'TEST-review-capacity',
    nodeExecutable,
    nodeVersion,
    nodeSha256,
    hostEntry,
    hostEntrySha256: createHash('sha256').update(body).digest('hex'),
    expectedBuildId: 'TEST-review-capacity',
    cwd: root,
    env: { HOME: root, TMPDIR: root },
    startupTimeoutMs: 3000,
    requestTimeoutMs: 3000,
    writeTimeoutMs: 1000,
    shutdownTimeoutMs: 100,
    ...(optIn ? { reviewTransport: 'review-v1' as const } : {}),
  };
  const client = new CapturedHostClient(profile);
  clients.push(client);
  return { client, root };
}
it('captured opt-in negotiates finite review capacity, retains ordinary cap, and bounded slow-UI notifications preserve control', async () => {
  const { client } = await capturedReviewClient();
  expect((await client.start()).capabilities).toContain('transport.review-v1');
  const large = 'x'.repeat(2 * 1024 * 1024);
  expect(await client.request('team.review.invoke', large)).toBe(large);
  await expect(client.request('ordinary', large)).rejects.toMatchObject({
    outcome: 'not-dispatched',
  });
  await expect(client.request('team.review.alias', large)).rejects.toMatchObject({
    outcome: 'not-dispatched',
  });
  expect(await client.request('team.review.getChangeStats', null, { control: true })).toBe(
    'control'
  );
  expect(client.takeNotifications().gap).toBe(true);
  expect((await client.shutdown()).childExit).toBe('confirmed');
});
it('default captured profile refuses a larger unselected handshake before application requests', async () => {
  const { client } = await capturedReviewClient(false);
  await expect(client.start()).rejects.toMatchObject({ code: 'protocol-error' });
  expect((await client.shutdown()).childExit).toBe('confirmed');
});
it.each(['review', 'ordinary'] as const)(
  'oversized %s response is unknown and original request is never replayed',
  async (kind) => {
    const { client, root } = await capturedReviewClient(true, kind);
    await client.start();
    await expect(
      client.request(kind === 'review' ? 'team.review.invoke' : 'ordinary', null)
    ).rejects.toMatchObject({ code: 'protocol-error', outcome: 'unknown' });
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe('effect\n');
    await expect(
      client.request(kind === 'review' ? 'team.review.invoke' : 'ordinary', null)
    ).rejects.toMatchObject({ outcome: 'not-dispatched' });
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe('effect\n');
  }
);
