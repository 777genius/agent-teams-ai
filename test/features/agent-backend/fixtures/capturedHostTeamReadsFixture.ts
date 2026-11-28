import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { pageGroupCatalog } from '../../../../packages/legacy-agent-host/src/group-chats/pageGroupCatalog';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemTeamOwner } from '@agent-teams/legacy-agent-host/team/filesystem';
import { vi } from 'vitest';

import { hostTeamSelectionKey } from '../../../../src/features/agent-backend/contracts/teamSelection';
import { BackendOperationsFacade } from '../../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { captureHostTeamReads } from '../../../../src/features/agent-backend/main/application/CapturedHostTeamReads';

import type { BackendConnectionSnapshot } from '../../../../src/features/agent-backend/contracts/connections';
import type { BackendOwnerRouter } from '../../../../src/features/agent-backend/main/application/BackendOwnerRouter';
import type { CapturedHostReadScope } from '../../../../src/features/agent-backend/main/application/CapturedHostTeamReads';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

type Connection = BackendConnectionSnapshot['bindings'][number];
type OwnerOptions = Parameters<typeof createFilesystemTeamOwner>[0];

/** Real filesystem Team owners and Main projections, with only the private transport in process. */
export function capturedHostTeamReadsFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-captured-host-reads-')));
  const teams = new Map<string, ReturnType<typeof addTeam>>();
  let current = true;
  let snapshot: BackendConnectionSnapshot = { state: 'ready', bindings: [] };
  let afterRead: ((method: string) => void) | undefined;
  const groupPageKey = randomUUID();
  const router = {
    lookup: vi.fn<BackendOwnerRouter['lookup']>(),
    request: vi.fn<BackendOwnerRouter['request']>(async (handle, request) => {
      const team = teams.get(handle.handleId);
      if (!team) throw new Error('Uncaptured TEST owner');
      const payload = request.payload as Record<string, unknown>;
      let value: unknown;
      switch (request.method) {
        case 'team.snapshot':
          value = team.human.readSnapshot(payload.cursor ? { cursor: String(payload.cursor) } : {});
          break;
        case 'team.roster.read':
          value = team.human.readRoster();
          break;
        case 'team.lifecycle.read': {
          const state = team.owner.lifecycleCommands('human').view();
          value = { kind: 'team_lifecycle', revision: state.revision,
            deletedAt: state.deletedAt, cleanupPending: state.cleanupPending };
          break;
        }
        case 'team.group.list': {
          const original = await team.owner.groupCommands('human', { getRun: async () => null })
            .read('list', {}, { before() {}, inside() {} });
          value = pageGroupCatalog({
            rows: JSON.parse(JSON.stringify(original)) as JsonValue[],
            key: groupPageKey,
            principalId: 'human',
            binding: handle.handleId,
            ...(payload.cursor === undefined ? {} : { cursor: String(payload.cursor) }),
          });
          break;
        }
        default:
          throw new Error('Unexpected TEST request ' + request.method);
      }
      afterRead?.(request.method);
      return JSON.parse(JSON.stringify({ ok: true, value })) as JsonValue;
    }),
  };
  const facade = new BackendOperationsFacade(router);
  const feature: CapturedHostReadScope['feature'] = {
    initialize: vi.fn(async () => undefined),
    discoverBindings: vi.fn(async () => structuredClone(snapshot)),
    listBindings: vi.fn(() => structuredClone(snapshot)),
    authorizeHandle: vi.fn((_contextId, handle) => current &&
      snapshot.bindings.some(row => row.handle.handleId === handle.handleId)),
    facade,
  };
  const scope: CapturedHostReadScope = {
    feature, contextId: 'TEST-original-context', isCurrent: () => current,
  };

  function addTeam(options: {
    name?: string;
    handleId?: string;
    ownerResourceRef?: string;
    projectContextMode?: Connection['projectContextMode'];
    projectContext?: Connection['projectContext'];
    savedSettings?: OwnerOptions['savedSettings'];
    members?: OwnerOptions['members'];
    grants?: OwnerOptions['grants'];
  } = {}) {
    const name: string = options.name ?? `test-team-${teams.size + 1}`;
    const binding = { backendId: 'TEST-backend', teamId: 'TEST-id-' + name, teamName: name };
    const owner = createFilesystemTeamOwner({ root, binding,
      members: options.members ?? [
        { memberId: 'lead', name: 'team-lead', role: 'lead' },
        { memberId: 'alice', name: 'alice', role: 'member', settings: {
          role: 'Reviewer', workflow: 'Review the TEST change.' } },
      ],
      savedSettings: options.savedSettings ?? { cwd: join(root, 'TEST-project'), prompt: 'TEST saved prompt' },
      grants: options.grants ?? [{ principalId: 'human', memberName: 'user',
        permissions: ['read', 'admin', 'task.write', 'message.write'] }],
    });
    const connection: Connection = {
      handle: { handleId: options.handleId ?? 'TEST-handle-' + name }, label: name,
      ownerResourceRef: options.ownerResourceRef ?? 'TEST-owner', teamResourceRef: binding.teamId,
      ...(options.projectContextMode ? { projectContextMode: options.projectContextMode } : {}),
      ...(options.projectContext ? { projectContext: options.projectContext } : {}),
      members: owner.connect('human').readRoster().members.map(member => ({
        memberId: member.memberId, label: member.name,
      })),
    };
    const result = { owner, human: owner.connect('human'), binding, connection,
      key: hostTeamSelectionKey(connection.handle.handleId) };
    teams.set(connection.handle.handleId, result);
    snapshot.bindings.push(connection);
    return result;
  }

  return {
    root, teams, router, facade, feature, scope, addTeam,
    capture: () => captureHostTeamReads(scope),
    revokeContext: () => { current = false; },
    afterRead: (callback: typeof afterRead) => { afterRead = callback; },
    setSnapshot: (value: BackendConnectionSnapshot) => { snapshot = value; },
    snapshot: () => snapshot,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
