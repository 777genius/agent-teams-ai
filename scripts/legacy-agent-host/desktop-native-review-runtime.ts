import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from '../../packages/legacy-agent-host/dist/team/identity.js';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
/** Exact captured history plus, at most, the unchanged profile's unused base binding. */
export function assertNativeReviewRuntimeRecords(
  sessions: Row[],
  original: Row,
  profile: Row
): void {
  assert.ok(sessions.length >= 1 && sessions.length <= 2);
  assert.ok(sessions.every((row) => row.phase === 'closed' && row.custody === 'released'));
  const expected = record(original.runtime),
    captured = sessions.filter((row) => digest(row.binding) === digest(expected.binding));
  assert.equal(captured.length, 1);
  const runtime = captured[0]!;
  assert.equal(record(runtime.binding).runId, record(original.capture).launchId);
  assert.equal(runtime.sessionRef, expected.sessionRef);
  assert.deepEqual(runtime.inputs, expected.inputs);
  assert.ok(Array.isArray(runtime.inputs) && runtime.inputs.length === 2);
  assert.ok(
    runtime.inputs
      .map(record)
      .every((row) => row.phase === 'terminal' && row.terminal === 'succeeded')
  );
  const originalInput = record(original.originalRuntimeInput);
  assert.deepEqual(
    runtime.inputs
      .map(record)
      .find((row) => record(row.intent).inputId === record(originalInput.intent).inputId),
    originalInput
  );
  assert.ok(Array.isArray(profile.teams) && profile.teams.length === 1);
  const team = record(profile.teams[0]);
  assert.ok(Array.isArray(team.members) && team.members.length === 1);
  const delivery = record(record(team.members[0]).delivery);
  const base = Object.fromEntries(
    ['backendId', 'teamId', 'runId', 'memberId', 'generation'].map((key) => [key, delivery[key]])
  );
  assert.ok(Object.values(base).every((value) => typeof value === 'string' && value.length > 0));
  for (const row of sessions.filter((value) => value !== runtime)) {
    assert.deepEqual(
      row.binding,
      base,
      'only exact original profile base binding may accompany captured Runtime'
    );
    assert.deepEqual(row.inputs, []);
    assert.equal(row.config, null);
    assert.equal(row.sessionRef, undefined);
  }
}
export async function readNativeReviewRuntimeRecords(root: string, original: Row): Promise<Row[]> {
  const profile = record(JSON.parse(await readFile(join(root, 'host-profile.json'), 'utf8')));
  const sessions = await readDesktopNativeStopSessions(root);
  assertNativeReviewRuntimeRecords(sessions, original, profile);
  return sessions;
}
