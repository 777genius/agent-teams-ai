import { createMemberWorkSyncFeature } from '@features/member-work-sync/main';
import { TeamKanbanManager } from '@main/services/team/TeamKanbanManager';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { TeamTaskReader } from '@main/services/team/TeamTaskReader';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { createController } from 'agent-teams-controller';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestWorkSyncIdentity } from '../helpers/createTestWorkSyncIdentity';

import type { MemberWorkSyncFeatureFacade } from '@features/member-work-sync/main';
import type { TeamTask } from '@shared/types';

let root: string | undefined;
let feature: MemberWorkSyncFeatureFacade | undefined;
afterEach(async () => {
  await feature?.dispose();
  feature = undefined;
  setClaudeBasePathOverride(null);
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('reviewer clarification safe E2E', () => {
  it.each(['lead', 'user'] as const)(
    'suppresses queued review pickup while awaiting %s and resumes after clearing',
    async (waitingOn) => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-reviewer-clarification-'));
      setClaudeBasePathOverride(root);
      const teamName = 'test-review-wait';
      const teamRoot = path.join(root, 'teams', teamName);
      await fs.mkdir(teamRoot, { recursive: true });
      await fs.writeFile(
        path.join(teamRoot, 'config.json'),
        JSON.stringify({
          name: teamName,
          leadSessionId: 'test-lead-session',
          members: [
            { name: 'team-lead', agentType: 'team-lead', providerId: 'codex' },
            { name: 'owner', providerId: 'codex' },
            { name: 'reviewer', providerId: 'codex' },
          ],
        })
      );
      const controller = createController({ teamName, claudeDir: root });
      const task = controller.taskBoard.createTask({
        subject: 'Review sandbox work',
        owner: 'owner',
      }) as TeamTask;
      controller.taskBoard.startTask(task.id, 'owner');
      controller.taskBoard.completeTask(task.id, 'owner');
      controller.taskBoard.requestReview(task.id, { from: 'owner', reviewer: 'reviewer' });
      // The assignment has already been read; this test targets work-sync, not delivery retry.
      const inboxPath = path.join(teamRoot, 'inboxes', 'reviewer.json');
      const assignment = JSON.parse(await fs.readFile(inboxPath, 'utf8')) as Record<
        string,
        unknown
      >[];
      await fs.writeFile(
        inboxPath,
        JSON.stringify(assignment.map((row) => ({ ...row, read: true })))
      );
      const deliveries: string[] = [];
      const makeFeature = () =>
        createMemberWorkSyncFeature({
          teamsBasePath: path.join(root!, 'teams'),
          lifecycleIdentity: createTestWorkSyncIdentity(),
          isManagedByThisProfile: async () => true,
          startBackground: false,
          isTeamActive: async () => true,
          configReader: {
            getConfig: async () =>
              JSON.parse(await fs.readFile(path.join(teamRoot, 'config.json'), 'utf8')),
          } as Parameters<typeof createMemberWorkSyncFeature>[0]['configReader'],
          taskReader: new TeamTaskReader(),
          kanbanManager: new TeamKanbanManager(),
          membersMetaStore: new TeamMembersMetaStore(),
          reviewPickupDelivery: {
            canDeliver: () => ({ ok: true }),
            deliver: async ({ messageId }) => {
              deliveries.push(messageId);
              return { ok: true, state: 'prompt_accepted', messageId };
            },
          },
        });
      feature = makeFeature();
      const reviewer = { teamName, memberName: 'reviewer' };
      const initial = await feature.refreshStatus({ ...reviewer, forceNudge: true });
      expect(initial.agenda.items).toHaveLength(1);
      expect(initial.agenda.items[0].kind).toBe('review');
      const cycleId = initial.agenda.items[0].evidence.reviewCycleId;
      // Queue first, then change the board without refreshing persisted sync status.
      controller.taskBoard.setNeedsClarification(task.id, waitingOn);
      const dispatch = await feature.dispatchDueNudges([teamName]);
      expect(dispatch.superseded).toBeGreaterThan(0);
      expect(deliveries).toEqual([]);
      const waiting = await feature.refreshStatus(reviewer);
      expect(waiting.state).toBe('caught_up');
      expect(waiting.agenda.items).toEqual([]);
      const report = await feature.report({
        ...reviewer,
        state: 'caught_up',
        agendaFingerprint: waiting.agenda.fingerprint!,
        reportToken: waiting.reportToken!,
      });
      expect(report.accepted).toBe(true);
      const lead = await feature.refreshStatus({ teamName, memberName: 'team-lead' });
      expect(lead.agenda.items.map((item) => item.kind)).toEqual(
        waitingOn === 'lead' ? ['clarification'] : []
      );
      // Waiting survives a fresh feature instance; no lease renewal is required.
      await feature.dispose();
      feature = makeFeature();
      expect((await feature.refreshStatus(reviewer)).agenda.items).toEqual([]);
      expect((await feature.dispatchDueNudges([teamName])).delivered).toBe(0);
      expect(deliveries).toEqual([]);
      controller.taskBoard.setNeedsClarification(task.id, null);
      const resumed = await feature.refreshStatus({ ...reviewer, forceNudge: true });
      expect(resumed.state).toBe('needs_sync');
      expect(resumed.agenda.items).toHaveLength(1);
      expect(resumed.agenda.items[0].evidence.reviewCycleId).toBe(cycleId);
      expect((await feature.dispatchDueNudges([teamName])).delivered).toBe(1);
      expect(deliveries).toHaveLength(1);
      expect(
        (await feature.refreshStatus({ teamName, memberName: 'team-lead' })).agenda.items
      ).toEqual([]);
    },
    30_000
  );
});
