import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseHostedPromotionBegin } from '@features/internal-storage/contracts';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { parseActorId, parseDeploymentId, parseWorkspaceId } from '@shared/contracts/hosted';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  HostedPromotionBeginResult,
  HostedTeamConfigurationStorageCreateResult,
  TeamDraftPublication,
} from '@features/internal-storage/contracts';
import type { HostedPromotionCommitAuthority } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionStorageOps';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const workspaceId = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
const publicationBinding = {
  actorId: parseActorId(`actor_${'2'.repeat(32)}`),
  deploymentId: parseDeploymentId(`deployment_${'3'.repeat(32)}`),
  runtimeWorkspaceId: parseWorkspaceId(`workspace_${'4'.repeat(32)}`),
  bindingGeneration: 1,
};

type Lane = Record<string, unknown>;
const claude: Lane = {
  kind: 'native',
  provider: 'anthropic',
  members: [{ name: 'lead', prompt: 'Coordinate.', model: 'claude-opus-4-6', effort: 'high' }],
};
const codex: Lane = {
  kind: 'native',
  provider: 'codex',
  members: [{ name: 'lead', prompt: 'Coordinate.', model: 'gpt-5.6-sol', effort: 'medium' }],
};
const gemini: Lane = {
  kind: 'native',
  provider: 'gemini',
  members: [{ name: 'lead', prompt: 'Coordinate.', model: 'gemini-2.5-pro' }],
};
const openCode: Lane = {
  kind: 'opencode',
  provider: 'opencode',
  selectedModel: 'openai/gpt-6',
  members: [{ name: 'builder', prompt: 'Build.' }],
};
const codexReviewer: Lane = {
  ...codex,
  members: [{ name: 'reviewer', prompt: 'Review.', model: 'gpt-5.6-terra' }],
};

async function begin(
  lanes: readonly Lane[],
  authority: HostedPromotionCommitAuthority
): Promise<HostedPromotionBeginResult> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'promotion-topology-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const worker = new InternalStorageWorkerCore({
    databasePath: path.join(root, 'app.db'),
    // Test-only retained capability; this is not a production host adapter.
    promotionCommitAuthority: authority,
    createDatabase: (file, options) => new Database(file, options),
  });
  cleanup.push(async () => worker.close());
  const members = lanes.flatMap((lane) =>
    (lane.members as { name: string }[]).map(({ name }) => ({ name }))
  );
  const created = worker.handle('hostedTeamConfiguration.create', {
    workspaceId,
    publicationBinding,
    idempotencyKey: 'idempotency_create-topology',
    payloadHash: 'a'.repeat(64),
    metadata: { name: 'Topology' },
    members,
    configuration: { schemaVersion: 1, toolApprovalMode: 'auto', lanes },
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
  } as never) as HostedTeamConfigurationStorageCreateResult;
  if (created.kind !== 'created') throw new Error('fixture-create');
  const scope = {
    workspaceId,
    teamId: created.teamId,
    actorId: publicationBinding.actorId,
    deploymentId: publicationBinding.deploymentId,
  };
  const publication = worker.handle(
    'draftPublication.read',
    scope as never
  ) as TeamDraftPublication;
  return worker.handle(
    'hostedPromotion.begin',
    parseHostedPromotionBegin({
      ...scope,
      ...publicationBinding,
      createOperationId: publication.operationId,
      expectedRevision: created.revision,
      idempotencyKey: 'idempotency_promotion-topology',
      admittedWorkspaceRoot: '/sandbox/project',
      deadlineAtMs: Number.MAX_SAFE_INTEGER,
    })
  ) as HostedPromotionBeginResult;
}

const retain = () => ({ release() {} });
const withoutTrustedProcess: HostedPromotionCommitAuthority = { retainForCommit: retain };
const trustedProcess: HostedPromotionCommitAuthority = {
  retainForCommit: retain,
  launchTopologyPolicy: () => ({ nativeHostLocalLanes: true }),
};

describe('hosted promotion native lane gate', () => {
  it.each([
    ['an authority without a declared policy', withoutTrustedProcess],
    [
      'a declared non-trusted runtime',
      { retainForCommit: retain, launchTopologyPolicy: () => ({ nativeHostLocalLanes: false }) },
    ],
  ])('refuses native lanes for %s, as before trusted_process', async (_label, authority) => {
    await expect(begin([codex], authority)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'native_runtime_isolation_unavailable',
    });
  });

  it.each([
    ['Claude', claude],
    ['Codex', codex],
  ])('freezes a %s-only team into the Owner schema-2 native lane', async (_label, lane) => {
    const result = await begin([lane], trustedProcess);
    if (result.kind !== 'frozen') throw new Error(`expected-frozen:${JSON.stringify(result)}`);
    const plan = JSON.parse(result.operation.planJson) as {
      schemaVersion: number;
      lanes: unknown[];
    };
    expect(plan.schemaVersion).toBe(2);
    expect(plan.lanes).toEqual([{ laneId: result.operation.laneIds[0], ...lane }]);
  });

  it.each([withoutTrustedProcess, trustedProcess])(
    'always refuses Gemini lanes',
    async (authority) => {
      await expect(begin([gemini], authority)).resolves.toEqual({
        kind: 'unavailable',
        reason: 'native_provider_unsupported',
      });
    }
  );

  it('refuses mixed native and OpenCode lanes with a typed reason', async () => {
    await expect(begin([claude, openCode], trustedProcess)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'mixed_runtime_topology',
    });
  });

  it('keeps a Claude lead with a Codex member for a later slice', async () => {
    await expect(begin([claude, codexReviewer], trustedProcess)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'multi_lane_native_topology',
    });
  });

  it('still freezes pure OpenCode teams without trusted_process', async () => {
    await expect(begin([openCode], withoutTrustedProcess)).resolves.toMatchObject({
      kind: 'frozen',
    });
  });
});
