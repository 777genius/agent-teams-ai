import {
  readMemberActionLookup,
  readMemberActionQuery,
  readMemberActionRequest,
} from '../../../contracts/memberActions';
import { parseResumePrepare } from '../resumeValues';
import { parseRosterReplacement } from '../rosterValues';

import { InvalidBackendOperation, object, stringArray, text } from './backendOperationInput';
import { parseTeamLifecyclePayload } from './teamLifecycleValues';

import type {
  BackendLaunchConfiguration,
  BackendLaunchModelSelection,
} from '../../../contracts/launch';
import type { BackendOperationPayloads } from '../../../contracts/operations';

function launchConfiguration(value: unknown): BackendLaunchConfiguration {
  const source = object(value, ['members']);
  if (!Array.isArray(source.members) || source.members.length < 1 || source.members.length > 256)
    throw new InvalidBackendOperation();
  const members = source.members.map((value) => {
    const row = object(value, [
      'memberId',
      'model',
      'effort',
      'fastMode',
      'permissions',
      'context',
    ]);
    const result: BackendLaunchConfiguration['members'][number] = { memberId: text(row.memberId) };
    if (row.model !== undefined) result.model = text(row.model);
    if (row.effort !== undefined) {
      if (
        typeof row.effort !== 'string' ||
        !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(row.effort)
      )
        throw new InvalidBackendOperation();
      result.effort = row.effort as NonNullable<typeof result.effort>;
    }
    if (row.fastMode !== undefined) {
      if (typeof row.fastMode !== 'boolean') throw new InvalidBackendOperation();
      result.fastMode = row.fastMode;
    }
    if (row.permissions !== undefined) {
      if (row.permissions !== 'manual' && row.permissions !== 'bypass')
        throw new InvalidBackendOperation();
      result.permissions = row.permissions;
    }
    if (row.context !== undefined) {
      if (row.context !== 'model-default' && row.context !== 'one-million')
        throw new InvalidBackendOperation();
      result.context = row.context;
    }
    return result;
  });
  if (new Set(members.map((member) => member.memberId)).size !== members.length)
    throw new InvalidBackendOperation();
  return { members };
}

export function parseBackendTeamOperation(
  operation: string,
  value: unknown
): BackendOperationPayloads[keyof BackendOperationPayloads] {
  switch (operation) {
    case 'team.lead.activity.read':
    case 'team.lead.context.read':
    case 'team.launch.model.configuration.read':
    case 'team.roster.read':
    case 'team.snapshot':
      object(value, []);
      return {};
    case 'team.activity.logs.read': {
      const p = object(value, ['memberName', 'taskId']);
      if (Object.hasOwn(p, 'memberName') === Object.hasOwn(p, 'taskId'))
        throw new InvalidBackendOperation();
      return Object.hasOwn(p, 'memberName')
        ? { memberName: text(p.memberName) }
        : { taskId: text(p.taskId) };
    }
    case 'team.activity.stats.read': {
      const p = object(value, ['memberName']);
      return { memberName: text(p.memberName) };
    }
    case 'team.lifecycle.read':
    case 'team.lifecycle.change':
    case 'team.lifecycle.lookup':
    case 'team.lifecycle.purge':
    case 'team.lifecycle.purge.lookup':
    case 'team.queue.read':
    case 'team.queue.discard':
    case 'team.queue.lookup':
      return parseTeamLifecyclePayload(operation, value);
    case 'team.member.action.prepare':
    case 'team.member.action.execute':
      return readMemberActionRequest(value);
    case 'team.member.actions.read':
      return readMemberActionQuery(value);
    case 'team.member.action.lookup':
      return readMemberActionLookup(value);
    case 'team.launch.resume.prepare':
      return parseResumePrepare(value);
    case 'team.launch.restorations.read': {
      const p = object(value, ['launchId']);
      return { launchId: text(p.launchId) };
    }
    case 'team.roster.lookup': {
      const p = object(value, ['expected']);
      return !Object.hasOwn(p, 'expected') ? {} : { expected: parseRosterReplacement(p.expected) };
    }
    case 'team.roster.replace':
      return parseRosterReplacement(value);
    case 'team.launch.probe.start':
    case 'team.launch.probe.read':
    case 'team.launch.probe.cancel': {
      const p = object(value, [
        'launchId',
        'rosterRevision',
        'memberId',
        'model',
        'effort',
        'context',
        'draft',
      ]);
      const member = launchConfiguration({
        members: [
          {
            memberId: p.memberId,
            model: p.model,
            ...(p.effort === undefined ? {} : { effort: p.effort }),
            ...(p.context === undefined ? {} : { context: p.context }),
          },
        ],
      }).members[0];
      if (/[\r\n]/u.test(member.model!)) throw new InvalidBackendOperation();
      let draft: BackendLaunchModelSelection['draft'];
      if (p.draft !== undefined) {
        const raw = object(p.draft, ['providerId', 'target', 'workspace']);
        if (!['anthropic', 'codex', 'opencode'].includes(String(raw.providerId)))
          throw new InvalidBackendOperation();
        const target = object(raw.target, ['kind', 'name', 'originalName']);
        if (target.kind !== 'lead' && target.kind !== 'member') throw new InvalidBackendOperation();
        if (
          target.kind === 'lead' &&
          (target.name !== undefined || target.originalName !== undefined)
        )
          throw new InvalidBackendOperation();
        const workspace = raw.workspace === undefined ? undefined : text(raw.workspace, 8192);
        if (workspace !== undefined && (!workspace.startsWith('/') || /[\r\n]/u.test(workspace)))
          throw new InvalidBackendOperation();
        draft = {
          providerId: raw.providerId as NonNullable<typeof draft>['providerId'],
          target:
            target.kind === 'lead'
              ? { kind: 'lead' }
              : {
                  kind: 'member',
                  name: text(target.name),
                  ...(target.originalName === undefined
                    ? {}
                    : { originalName: text(target.originalName) }),
                },
          ...(workspace === undefined ? {} : { workspace }),
        };
      }
      const selection: BackendLaunchModelSelection = {
        launchId: text(p.launchId),
        rosterRevision: text(p.rosterRevision),
        memberId: member.memberId,
        model: member.model!,
        ...(draft === undefined ? {} : { draft }),
        ...(member.effort === undefined ? {} : { effort: member.effort }),
        ...(member.context === undefined ? {} : { context: member.context }),
      };
      return selection;
    }
    case 'team.launch.read':
    case 'team.launch.configuration.read': {
      const p = object(value, ['launchId']);
      return p.launchId === undefined ? {} : { launchId: text(p.launchId) };
    }
    case 'team.launch.capture': {
      const p = object(value, ['rosterCommandId']);
      return { rosterCommandId: text(p.rosterCommandId) };
    }
    case 'team.launch.start': {
      const p = object(value, ['launchId', 'rosterRevision', 'configuration']);
      return {
        launchId: text(p.launchId),
        rosterRevision: text(p.rosterRevision),
        ...(p.configuration === undefined
          ? {}
          : { configuration: launchConfiguration(p.configuration) }),
      };
    }
    case 'team.launch.retry': {
      const p = object(value, ['launchId', 'rosterRevision', 'attemptId', 'memberIds']);
      const memberIds = stringArray(p.memberIds);
      if (!memberIds.length || new Set(memberIds).size !== memberIds.length)
        throw new InvalidBackendOperation();
      return {
        launchId: text(p.launchId),
        rosterRevision: text(p.rosterRevision),
        attemptId: text(p.attemptId),
        memberIds,
      };
    }
    case 'team.changes.read': {
      const p = object(value, ['cursor']);
      return p.cursor === undefined ? {} : { cursor: text(p.cursor, 128) };
    }
    default:
      throw new InvalidBackendOperation();
  }
}
