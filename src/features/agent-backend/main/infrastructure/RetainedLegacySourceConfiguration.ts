import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { RetainedLegacyLaunchRefusal } from '../../core/application/RetainedLegacyLaunchCoordinator';

import type { CapturedLegacyStoppedSource } from './stopped-import/createLegacyStoppedTeamSource';
import type { TeamLaunchRequest } from '@shared/types';

type JsonRecord = Record<string, unknown>;
const names = ['config.json', 'team.meta.json', 'members.meta.json'] as const;
const runtimeMemberFields = new Set([
  'agentId',
  'sessionId',
  'joinedAt',
  'pid',
  'processId',
  'processStartTime',
  'tmuxPaneId',
  'tmuxSessionName',
  'tmuxSocketPath',
  'backendType',
  'isActive',
  'isIdle',
  'status',
  'lastActivity',
  'lastActivityAt',
]);
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RetainedLegacyLaunchRefusal('source-changed');
  return value as JsonRecord;
}
function parse(bytes: Buffer): JsonRecord {
  return record(JSON.parse(bytes.toString('utf8')));
}
function without(input: JsonRecord, fields: ReadonlySet<string>): JsonRecord {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !fields.has(key)));
}

/** Native runtime records may evolve; unrelated settings and archived member identities may not. */
function nativeConfigMatches(
  actualBytes: Buffer,
  expectedBytes: Buffer,
  teamBytes: Buffer,
  membersBytes: Buffer,
  launch: TeamLaunchRequest
): boolean {
  const actual = parse(actualBytes),
    expected = parse(expectedBytes),
    team = parse(teamBytes),
    membersMeta = parse(membersBytes);
  const nativeRootFields = new Set(['leadAgentId', 'leadSessionId', 'sessionHistory', 'members']);
  if (stable(without(actual, nativeRootFields)) !== stable(without(expected, nativeRootFields)))
    return false;
  const beforeHistory = expected.sessionHistory ?? [],
    afterHistory = actual.sessionHistory ?? [];
  if (
    !Array.isArray(beforeHistory) ||
    !Array.isArray(afterHistory) ||
    beforeHistory.some((entry) => !afterHistory.includes(entry))
  )
    return false;
  if (!Array.isArray(actual.members) || !Array.isArray(expected.members)) return false;
  const configured = new Map(
    (Array.isArray(membersMeta.members) ? membersMeta.members : []).map((item) => {
      const member = record(item);
      return [String(member.name).toLowerCase(), member] as const;
    })
  );
  const previous = new Map(
    expected.members.map((item) => {
      const member = record(item);
      return [String(member.name).toLowerCase(), member] as const;
    })
  );
  const seen = new Set<string>();
  for (const item of actual.members) {
    const member = record(item),
      name = String(member.name).toLowerCase();
    if (seen.has(name)) return false;
    seen.add(name);
    const saved = configured.get(name),
      before = previous.get(name) ?? saved;
    if (!before || before.removedAt != null) return false;
    const lead = name === 'team-lead' || before.agentType === 'team-lead';
    const selected = lead ? { ...team, ...launch } : (saved ?? before);
    const inherited = lead ? selected : { ...team, ...selected };
    const allowed: JsonRecord = {
      providerId: inherited.providerId,
      provider: inherited.providerId,
      providerBackendId: inherited.providerBackendId,
      model:
        selected.model ??
        (lead ? record(team.launchIdentity ?? {}).resolvedLaunchModel : team.model),
      effort: inherited.effort,
      fastMode: inherited.fastMode,
      cwd: selected.cwd ?? launch.cwd,
      agentType: before.agentType ?? (lead ? 'team-lead' : 'general-purpose'),
    };
    const nextStable = without(member, runtimeMemberFields),
      oldStable = without(before, runtimeMemberFields);
    for (const key of new Set([...Object.keys(nextStable), ...Object.keys(oldStable)])) {
      if (stable(nextStable[key]) === stable(oldStable[key])) continue;
      if (
        !Object.hasOwn(allowed, key) ||
        allowed[key] === undefined ||
        stable(nextStable[key]) !== stable(allowed[key])
      )
        return false;
    }
  }
  return [...previous.keys()].every((name) => seen.has(name));
}

/** Only a witnessed original Main write can replace the expected bytes. No observed drift is adopted. */
export function captureRetainedLegacySourceConfiguration(source: CapturedLegacyStoppedSource) {
  const root = source.roots.find((entry) => entry.category === 'team')?.path;
  if (!root) throw new RetainedLegacyLaunchRefusal('source-changed');
  const paths = new Map(names.map((name) => [resolve(join(root, name)), name] as const));
  const read = (name: (typeof names)[number]): Buffer => {
    const file = join(root, name),
      stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024)
      throw new RetainedLegacyLaunchRefusal('source-changed');
    return readFileSync(file);
  };
  const expected = new Map(names.map((name) => [name, read(name)]));
  const pending = new Map<(typeof names)[number], Buffer>();
  let poisoned = false,
    launch: TeamLaunchRequest | undefined;
  const matches = (name: (typeof names)[number], bytes: Buffer, wanted: Buffer): boolean =>
    bytes.equals(wanted) ||
    (name === 'config.json' &&
      Boolean(launch) &&
      nativeConfigMatches(
        bytes,
        wanted,
        expected.get('team.meta.json')!,
        expected.get('members.meta.json')!,
        launch!
      ));
  const assertCurrent = () => {
    if (poisoned || !source.isCurrent()) throw new RetainedLegacyLaunchRefusal('source-changed');
    for (const name of names) {
      const bytes = read(name),
        next = pending.get(name);
      if (!matches(name, bytes, expected.get(name)!) && !(next && matches(name, bytes, next)))
        throw new RetainedLegacyLaunchRefusal('source-changed');
    }
  };
  return {
    assertCurrent,
    async mutate<T>(operation: () => Promise<T>): Promise<T> {
      assertCurrent();
      const value = await operation();
      assertCurrent();
      return value;
    },
    admitLaunch(request: TeamLaunchRequest) {
      assertCurrent();
      launch = structuredClone(request);
    },
    beginWrite(file: string, data: string | Buffer, permitted = true) {
      const name = paths.get(resolve(file));
      if (!name) return;
      if (!permitted) throw new RetainedLegacyLaunchRefusal('not-eligible');
      assertCurrent();
      if (pending.has(name)) throw new RetainedLegacyLaunchRefusal('busy');
      const next = Buffer.from(data);
      parse(next);
      pending.set(name, next);
      return {
        beforeCommit: assertCurrent,
        finish(success: boolean) {
          try {
            if (!success || !matches(name, read(name), next)) {
              poisoned = true;
              throw new RetainedLegacyLaunchRefusal('source-changed');
            }
            // Pin the writer's intended bytes, never bytes obtained from a concurrent editor.
            expected.set(name, next);
            assertCurrent();
          } finally {
            pending.delete(name);
          }
        },
      };
    },
  };
}
