import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HostedRecentMetadataReader } from '../../../../../src/features/recent-projects/main/hosted';

const fixtures: string[] = [];

async function mount(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.cwd(), `test/features/recent-projects/main/hosted/${name}-`));
  fixtures.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== 'linux')('HostedRecentMetadataReader Linux traversal', () => {
  it('reads Claude cwd only from a bounded first header and reports invalid headers as partial', async () => {
    const projects = await mount('claude');
    await fs.mkdir(path.join(projects, 'encoded'), { recursive: true });
    await fs.writeFile(path.join(projects, 'encoded', 'good.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: '/workspace/a', timestamp: '2026-09-30T00:00:00.000Z' })}\n{"message":"body"}\n`);
    await fs.writeFile(path.join(projects, 'encoded', 'bad.jsonl'),
      `${JSON.stringify({ type: 'user', message: { content: 'cwd:/workspace/c' } })}\n`);
    await fs.writeFile(path.join(projects, 'encoded', 'body-first.jsonl'),
      `${JSON.stringify({ type: 'user', message: { content: 'private body' }, cwd: '/workspace/c' })}\n`);
    await fs.writeFile(path.join(projects, 'encoded', 'unicode.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: '/workspace/é', timestamp: '2026-09-30T00:00:00.000Z' })}\n`);
    await fs.writeFile(path.join(projects, 'encoded', 'branch-before-type.jsonl'),
      `${JSON.stringify({ parentUuid: null, isSidechain: false, userType: 'external',
        cwd: '/workspace/branch-header', sessionId: 'session-fixture', version: '1',
        gitBranch: 'private-branch', type: 'user', message: { content: 'private body' } })}\n`);
    await fs.symlink(path.join(projects, 'encoded', 'good.jsonl'),
      path.join(projects, 'encoded', 'symlink.jsonl'));
    const admitted: string[] = [];
    const result = await new HostedRecentMetadataReader('anthropic', [projects]).read(async (fact) => {
      admitted.push(fact.cwd);
    });
    expect(result.status).toBe('partial');
    expect(admitted.sort()).toEqual(['/workspace/a', '/workspace/branch-header', '/workspace/é']);
  });

  it('reads Codex session_meta only from two explicit mounts and never falls back to CODEX_HOME', async () => {
    const sessions = await mount('sessions');
    const archived = await mount('archived');
    await fs.mkdir(path.join(sessions, '2026', '09', '30'), { recursive: true });
    await fs.writeFile(path.join(sessions, '2026', '09', '30', 'a.jsonl'),
      `${JSON.stringify({ type: 'session_meta', timestamp: '2026-09-30T00:00:00Z', payload: {
        cwd: '/workspace/a', source: 'cli', git: { remote: 'private.example/repo' } } })}\n{"cwd":"/workspace/c"}\n`);
    const admitted: string[] = [];
    expect((await new HostedRecentMetadataReader('codex', [sessions, archived]).read(async (fact) => {
      admitted.push(fact.cwd);
    })).status).toBe('complete');
    expect(admitted).toEqual(['/workspace/a']);
    expect((await new HostedRecentMetadataReader('codex', []).read(async () => undefined)).status)
      .toBe('unavailable');
  });

  it('stops before a long Codex base_instructions value after usable metadata', async () => {
    const sessions = await mount('codex-prefix');
    const archived = await mount('codex-archive');
    await fs.writeFile(path.join(sessions, 'metadata.jsonl'), JSON.stringify({
      type: 'session_meta', timestamp: '2026-09-30T00:00:00Z', payload: {
        cwd: '/workspace/codex', source: 'cli', base_instructions: { text: 'secret'.repeat(2_000) },
      },
    }) + '\n');
    const admitted: string[] = [];
    const result = await new HostedRecentMetadataReader('codex', [sessions, archived]).read(async (fact) => {
      admitted.push(fact.cwd);
    });
    expect(result.status).toBe('complete');
    expect(admitted).toEqual(['/workspace/codex']);
  });

  it('uses Claude session file activity time when the first header is old', async () => {
    const projects = await mount('claude-activity');
    const directory = path.join(projects, 'encoded');
    await fs.mkdir(directory);
    const file = path.join(directory, 'activity.jsonl');
    await fs.writeFile(file, JSON.stringify({ type: 'user', cwd: '/workspace/active',
      timestamp: '2020-01-01T00:00:00Z' }) + '\n');
    const activityAt = new Date('2026-09-30T12:00:00Z');
    await fs.utimes(file, activityAt, activityAt);
    const observed: number[] = [];
    expect((await new HostedRecentMetadataReader('anthropic', [projects]).read(async (fact) => {
      observed.push(fact.observedAt);
    })).status).toBe('complete');
    expect(observed).toEqual([activityAt.getTime()]);
  });

  it('does not follow a queued directory replaced by an outside symlink', async () => {
    const projects = await mount('symlink-race');
    const outside = await mount('outside');
    const queued = path.join(projects, 'queued');
    await fs.mkdir(queued);
    await fs.writeFile(path.join(queued, 'inside.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/workspace/inside' }) + '\n');
    await fs.writeFile(path.join(projects, 'trigger.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/workspace/trigger' }) + '\n');
    await fs.writeFile(path.join(outside, 'secret.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/workspace/outside' }) + '\n');
    const admitted: string[] = [];
    await new HostedRecentMetadataReader('anthropic', [projects]).read(async (fact) => {
      admitted.push(fact.cwd);
      if (fact.cwd === '/workspace/trigger') {
        await fs.rename(queued, `${queued}-original`);
        await fs.symlink(outside, queued);
      }
    });
    expect(admitted).toContain('/workspace/trigger');
    expect(admitted).not.toContain('/workspace/outside');
  });
});

it.skipIf(process.platform === 'linux')('fails closed when descriptor-relative traversal is unavailable', async () => {
  const projects = await mount('non-linux');
  expect(await new HostedRecentMetadataReader('anthropic', [projects]).read(async () => undefined))
    .toEqual({ status: 'unavailable' });
});
