import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { authenticateRelease220Publisher } from '../../ci/release/release220PublisherAuthority.ts';
import type {
  PublisherAuthorityPort,
  PublisherContext,
  PublisherRun,
} from '../../ci/release/release220PublisherAuthority.ts';

const checkoutSha = '1234567890123456789012345678901234567890';
const workflowSha = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
const nativeReceiptBytes = '{"fixture":"unqualified"}';
const template = await readFile(
  new URL('../../../test/fixtures/release220-publisher-U11.yml', import.meta.url),
  'utf8'
);
function fixture() {
  const context: PublisherContext = {
    checkoutSha,
    workflowSha,
    repository: '777genius/agent-teams-ai',
    runId: 123,
    runAttempt: 2,
    planSha256: 'b3422f64da6c44b1aeea6ba656a5db3f694c913b8a7a1289a37dc511530e4678',
    nativeReceiptBytes,
    publish: false,
  };
  const identity = {
    schemaVersion: 1,
    workflowSha,
    checkoutSha,
    applicationSha: 'dc1ec2d927b8c27c20d18c976ee615b27a2bd6f3',
    workflowRef:
      '777genius/agent-teams-ai/.github/workflows/publish-carried-release.yml@refs/tags/release-tooling-v2.17.10-closed-executor-publisher',
    repository: '777genius/agent-teams-ai',
    tag: 'v2.17.10',
    planSha256: context.planSha256,
    nativeReceiptSha256: createHash('sha256').update(nativeReceiptBytes).digest('hex'),
    preparedRunId: 37831798849,
    preparedRunAttempt: 1,
    preparedArtifactId: 11573044289,
    preparedArtifactSha256: '3cfb885531d263866c3a40653b7a6995d9f324144c75ab6e0d6777e1e37d3bc7',
    runId: 123,
    runAttempt: 2,
    publicationRequested: false,
  };
  const run: PublisherRun = {
    id: 123,
    run_attempt: 2,
    head_sha: workflowSha,
    head_branch: 'release-tooling-v2.17.10-closed-executor-publisher',
    path: '.github/workflows/publish-carried-release.yml',
    event: 'workflow_dispatch',
    status: 'in_progress',
    conclusion: null,
    repository: { full_name: '777genius/agent-teams-ai' },
    head_repository: { full_name: '777genius/agent-teams-ai' },
    actor: { login: '777genius' },
    triggering_actor: { login: '777genius' },
  };
  const port: PublisherAuthorityPort = {
    run: (id) => {
      assert.equal(id, 123);
      return Promise.resolve(run);
    },
    workflow: (sha) => {
      assert.equal(sha, workflowSha);
      return Promise.resolve(template.replaceAll('INVALID_G', checkoutSha));
    },
  };
  return { context, identity, run, port };
}
void test('actual immutable U11 origin authenticates G separately from prepared E10', async () => {
  const { context, identity, port } = fixture();
  await authenticateRelease220Publisher(port, identity, context);
});
void test('self-declared sidecar cannot replace actual current origin metadata', async () => {
  const changes: Partial<PublisherRun>[] = [
    { id: 456 },
    { run_attempt: 1 },
    { head_sha: checkoutSha },
    { head_branch: 'main' },
    { path: '.github/workflows/ci.yml' },
    { event: 'push' },
    { status: 'completed' },
    { conclusion: 'failure' },
    { repository: { full_name: 'attacker/repo' } },
    { head_repository: { full_name: 'attacker/repo' } },
    { actor: { login: 'attacker' } },
    { triggering_actor: { login: 'attacker' } },
  ];
  for (const change of changes) {
    const { context, identity, port, run } = fixture();
    Object.assign(run, change);
    await assert.rejects(
      authenticateRelease220Publisher(port, identity, context),
      /origin\/current/
    );
  }
});
void test('every sidecar field and extra field must match actual origin and immutable prepared pins', async () => {
  const original = fixture().identity;
  for (const key of [...Object.keys(original), 'unapproved']) {
    const { context, identity, port } = fixture();
    const changed: Record<string, unknown> = { ...identity, [key]: 'forged' };
    await assert.rejects(authenticateRelease220Publisher(port, changed, context), /sidecar/);
  }
});
void test('closed bridge refuses publish, local plan, other plan, or changed native bytes', async () => {
  const changes: Partial<PublisherContext>[] = [
    { publish: true },
    { planFile: '/TEST-plan.json' },
    { planSha256: 'f'.repeat(64) },
    { repository: 'attacker/repo' },
    { runId: 0 },
    { runAttempt: 0 },
    { nativeReceiptBytes: '{"forged":true}' },
    { checkoutSha: 'a0a8c4d895cfcbe3c790507fe9938b02e4464706' },
  ];
  for (const change of changes) {
    const { context, identity, port } = fixture();
    await assert.rejects(
      authenticateRelease220Publisher(port, identity, {
        ...context,
        ...change,
      })
    );
  }
});
void test('workflow hash checks all bytes and both exact G pins', async () => {
  const source = template.replaceAll('INVALID_G', checkoutSha);
  for (const changed of [
    `${source}\n# injected step\n`,
    source.replace('persist-credentials: false', 'persist-credentials: true'),
    source.replace(`ref: ${checkoutSha}`, `ref: ${workflowSha}`),
    source.replace(`CHECKOUT_SHA: ${checkoutSha}`, `CHECKOUT_SHA: ${workflowSha}`),
  ]) {
    const { context, identity, port } = fixture();
    port.workflow = () => Promise.resolve(changed);
    await assert.rejects(
      authenticateRelease220Publisher(port, identity, context),
      /template\/checkout/
    );
  }
});
