import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createHostedPromotionPlanPublisher } from '@main/composition/hosted/hostedDraftPublicationComposition';
import { afterEach, describe, expect, it } from 'vitest';

import type { HostedPromotionRecord } from '@features/internal-storage/contracts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fingerprint(logicalPath: string, stat: Awaited<ReturnType<typeof fs.stat>>): string {
  return createHash('sha256').update(JSON.stringify({ schemaVersion: 1,
    canonicalPath: logicalPath, device: stat.dev.toString(), inode: stat.ino.toString() }),
  'utf8').digest('hex');
}

async function fixture() {
  const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'promotion-publisher-'));
  cleanup.push(() => fs.rm(claudeRoot, { recursive: true, force: true }));
  const teams = path.join(claudeRoot, 'teams');
  await fs.mkdir(teams, { mode: 0o700 });
  const operationId = `adoption_${'a'.repeat(32)}`;
  const teamId = `team_${'b'.repeat(32)}`;
  const key = `draft-${operationId.slice(9)}`;
  const teamRoot = path.join(teams, key);
  await fs.mkdir(teamRoot, { mode: 0o700 });
  const [rootStat, teamsStat, teamStat] = await Promise.all([
    fs.stat(claudeRoot), fs.stat(teams), fs.stat(teamRoot),
  ]);
  const expectedFingerprint = fingerprint(teamRoot, teamStat);
  const marker = `${JSON.stringify({ schemaVersion: 1, operationId, teamId,
    directoryFingerprint: expectedFingerprint,
    rootFingerprint: fingerprint(claudeRoot, rootStat),
    teamsFingerprint: fingerprint(teams, teamsStat) })}\n`;
  await fs.writeFile(path.join(teamRoot, '.hosted-draft-publication.json'), marker, { mode: 0o600 });
  const publisher = await createHostedPromotionPlanPublisher(claudeRoot);
  cleanup.push(() => publisher.dispose());
  const planJson = JSON.stringify({ schemaVersion: 2, teamId, workspaceId: `workspace_${'c'.repeat(32)}` });
  const planSha256 = createHash('sha256').update(planJson).digest('hex');
  const operation = { operationId, createOperationId: operationId, teamId,
    planJson, planSha256, planGeneration: `plan-generation_${planSha256}`,
    state: 'frozen' } as HostedPromotionRecord;
  return { publisher, operation, expectedFingerprint, teamRoot };
}

describe('immutable hosted promotion plan publication', () => {
  it.runIf(process.platform === 'linux')('publishes 0600 exact bytes, replays and refuses a conflicting generation', async () => {
    const { publisher, operation, expectedFingerprint, teamRoot } = await fixture();
    const file = path.join(teamRoot, 'hosted-lifecycle-plan.v1.json');
    await publisher.publish(operation, expectedFingerprint, async () => {});
    const first = await fs.stat(file);
    expect(first.mode & 0o777).toBe(0o600);
    expect(await fs.readFile(file, 'utf8')).toBe(operation.planJson);
    await publisher.publish(operation, expectedFingerprint, async () => {});
    expect((await fs.stat(file)).ino).toBe(first.ino);
    const planJson = operation.planJson.replace(`workspace_${'c'.repeat(32)}`, `workspace_${'d'.repeat(32)}`);
    const planSha256 = createHash('sha256').update(planJson).digest('hex');
    await expect(publisher.publish({ ...operation, planJson, planSha256,
      planGeneration: `plan-generation_${planSha256}` }, expectedFingerprint, async () => {}))
      .rejects.toThrow('draft-publication-byte-conflict');
    expect(await fs.readFile(file, 'utf8')).toBe(operation.planJson);
  });

  it.runIf(process.platform === 'linux')('keeps a partial crash file for explicit recovery', async () => {
    const { publisher, operation, expectedFingerprint, teamRoot } = await fixture();
    const file = path.join(teamRoot, 'hosted-lifecycle-plan.v1.json');
    await fs.writeFile(file, operation.planJson.slice(0, 10), { mode: 0o600 });
    await expect(publisher.publish(operation, expectedFingerprint, async () => {}))
      .rejects.toThrow('draft-publication-file-custody');
    expect(await fs.readFile(file, 'utf8')).toBe(operation.planJson.slice(0, 10));
  });
});
