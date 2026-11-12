import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { SCHEDULE_FINITE_PROMPT, SCHEDULE_SMART_LABEL } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-schedules/model.ts';
import type { NativeScheduleScenario } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-schedules/model.ts';

export const LEGACY_SCHEDULE_ID = 'TEST-original-one-shot-schedule';
export const LEGACY_SCHEDULE_LABEL = 'TEST original one-shot';
export const EDITED_SCHEDULE_LABEL = 'TEST scheduled finite edited';

/** A real old record needs explicit UI Save to acquire its Main-owned Host target. */
export async function prepareDesktopScheduleFixture(repo: string, pnpmEntry: string, modelUrl: string) {
  const fixture = await prepareDesktopBackendFixture(repo, { pnpmEntry, seedUiTask: true, launchDialog: true,
    nativeClaude: { path: process.env.LEGACY_DESKTOP_CLAUDE_PATH!,
      sha256: 'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f', modelUrl } });
  const directory = join(fixture.root, 'claude/agent-teams-schedules');
  await mkdir(directory, { mode: 0o700 });
  const now = new Date().toISOString();
  await writeFile(join(directory, 'schedules.json'), JSON.stringify([{
    id: LEGACY_SCHEDULE_ID, teamName: 'host-team:' + encodeURIComponent(fixture.handleId),
    label: LEGACY_SCHEDULE_LABEL, cronExpression: '0 0 1 1 *', timezone: 'UTC', status: 'paused',
    warmUpMinutes: 0, maxConsecutiveFailures: 3, consecutiveFailures: 0,
    maxTurns: 8, maxBudgetUsd: 0.5, createdAt: now, updatedAt: now,
    launchConfig: { cwd: join(fixture.root, 'workspace'), providerId: 'anthropic',
      model: 'claude-sonnet-4-6', effort: 'low', fastMode: 'off', resolvedFastMode: false,
      skipPermissions: true, prompt: SCHEDULE_FINITE_PROMPT },
  }], null, 2), { mode: 0o600, flag: 'wx' });
  return fixture;
}

/** Read-only TEST oracle: the scheduler and actual native MCP own all task writes. */
export function desktopScheduleScenario(root: () => string): NativeScheduleScenario {
  return { task() {
    const directory = join(root(), 'hoststore/tasks/test-desktop-backend');
    const paths = readdirSync(directory).filter(name => name.endsWith('.json'));
    assert.ok(paths.length <= 16, 'finite private scheduled task fixture');
    const tasks = paths.map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')) as Record<string, unknown>)
      .filter(task => task.subject === SCHEDULE_SMART_LABEL);
    assert.equal(tasks.length, 1, 'one original task-first board task');
    const task = tasks[0]!;
    assert.equal(typeof task.id, 'string'); assert.equal(typeof task.owner, 'string');
    assert.equal(typeof task.status, 'string');
    return { id: String(task.id), owner: String(task.owner), status: String(task.status) };
  } };
}
