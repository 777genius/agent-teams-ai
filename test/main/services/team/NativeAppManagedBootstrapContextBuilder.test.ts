import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildNativeAppManagedBootstrapSpecs,
  buildNativeAppManagedBootstrapSpecsWithDiagnostics,
  hashNativeBootstrapText,
  MAX_NATIVE_BOOTSTRAP_TOTAL_CONTEXT_CHARS,
} from '../../../../src/main/services/team/bootstrap/NativeAppManagedBootstrapContextBuilder';
import { TeamMembersMetaStore } from '../../../../src/main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '../../../../src/main/services/team/TeamMetaStore';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

describe('NativeAppManagedBootstrapContextBuilder', () => {
  let tempClaudeRoot = '';

  beforeEach(async () => {
    tempClaudeRoot = await mkdtemp(join(tmpdir(), 'native-bootstrap-builder-'));
    setClaudeBasePathOverride(tempClaudeRoot);
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await rm(tempClaudeRoot, { recursive: true, force: true });
  });

  it('canonical hash normalizes line endings and trailing whitespace', () => {
    expect(hashNativeBootstrapText('line 1\r\nline 2  \n')).toBe(
      hashNativeBootstrapText('line 1\nline 2')
    );
  });

  it('builds bounded redacted context for native providers and skips non-native providers', async () => {
    await new TeamMetaStore().writeMeta('native-ready-team', {
      cwd: '/tmp/workspace',
      providerId: 'anthropic',
      model: 'claude-opus-4-6',
      createdAt: Date.now(),
    });
    await new TeamMembersMetaStore().writeMembers('native-ready-team', [
      {
        name: 'alice',
        providerId: 'anthropic',
        role:
          'Reviewer ANTHROPIC_API_KEY=sk-ant-secret ANTHROPIC_AUTH_TOKEN="lmstudio local token"',
      },
      {
        name: 'bob',
        providerId: 'codex',
        role: 'Developer Bearer secret-token',
      },
      {
        name: 'zoe',
        providerId: 'gemini',
        role: 'Gemini member',
      },
      {
        name: 'tom',
        providerId: 'opencode',
        role: 'OpenCode member',
      },
    ]);

    const specs = await buildNativeAppManagedBootstrapSpecs({
      teamName: 'native-ready-team',
      cwd: '/tmp/workspace',
      members: [
        {
          name: 'alice',
          providerId: 'anthropic',
          role:
            'Reviewer ANTHROPIC_API_KEY=sk-ant-secret ANTHROPIC_AUTH_TOKEN="lmstudio local token"',
        },
        {
          name: 'bob',
          providerId: 'codex',
          role: 'Developer Bearer secret-token',
        },
        {
          name: 'zoe',
          providerId: 'gemini',
          role: 'Gemini member',
        },
        {
          name: 'tom',
          providerId: 'opencode',
          role: 'OpenCode member',
        },
      ],
    });

    expect([...specs.keys()].sort()).toEqual(['alice', 'bob']);
    const alice = specs.get('alice');
    const bob = specs.get('bob');
    expect(alice?.contextText).toContain('<agent_teams_native_bootstrap_context>');
    expect(alice?.contextText).not.toContain('sk-ant-secret');
    expect(alice?.contextText).toContain('ANTHROPIC_API_KEY=[REDACTED]');
    expect(alice?.contextText).toContain('ANTHROPIC_AUTH_TOKEN=[REDACTED]');
    expect(alice?.contextText).not.toContain('lmstudio');
    expect(alice?.contextText).not.toContain('local token');
    expect(bob?.contextText).not.toContain('Bearer secret-token');
    expect(bob?.contextText).toContain('Bearer [REDACTED]');
    expect(bob?.contextText).toContain('Codex Native visible messaging rule');
    expect(bob?.contextText).toContain('mcp__agent-teams__task_get');
    expect(bob?.contextText).not.toContain('notify your team lead via SendMessage');
    expect(alice?.contextHash).toBe(hashNativeBootstrapText(alice?.contextText ?? ''));
  });

  it('warns but still builds for large native rosters below the aggregate budget', async () => {
    await new TeamMetaStore().writeMeta('large-warning-native-team', {
      cwd: '/tmp/workspace',
      providerId: 'anthropic',
      model: 'claude-opus-4-6',
      createdAt: Date.now(),
    });
    await new TeamMembersMetaStore().writeMembers(
      'large-warning-native-team',
      Array.from({ length: 7 }, (_, index) => ({
        name: `member-${index}`,
        providerId: 'anthropic' as const,
        role: 'Developer',
      }))
    );

    const result = await buildNativeAppManagedBootstrapSpecsWithDiagnostics({
      teamName: 'large-warning-native-team',
      cwd: '/tmp/workspace',
      members: Array.from({ length: 7 }, (_, index) => ({
        name: `member-${index}`,
        providerId: 'anthropic' as const,
        role: 'Developer',
      })),
    });

    expect(result.specs.size).toBe(7);
    expect(result.diagnostics.nativeMemberCount).toBe(7);
    expect(result.diagnostics.totalContextLimitChars).toBe(
      MAX_NATIVE_BOOTSTRAP_TOTAL_CONTEXT_CHARS
    );
    expect(result.diagnostics.warning).toMatch(/Large native team startup context/);
  });

  it('compacts thirty large native contexts within the aggregate budget', async () => {
    const hugeRole = 'x'.repeat(40_000);
    await new TeamMetaStore().writeMeta('large-native-team', {
      cwd: '/tmp/workspace',
      providerId: 'anthropic',
      model: 'claude-opus-4-6',
      createdAt: Date.now(),
    });
    await new TeamMembersMetaStore().writeMembers(
      'large-native-team',
      Array.from({ length: 30 }, (_, index) => ({
        name: `member-${index}`,
        providerId: 'anthropic' as const,
        role: hugeRole,
      }))
    );

    const result = await buildNativeAppManagedBootstrapSpecsWithDiagnostics({
      teamName: 'large-native-team',
      cwd: '/tmp/workspace',
      members: Array.from({ length: 30 }, (_, index) => ({
        name: `member-${index}`,
        providerId: 'anthropic' as const,
        role: hugeRole,
      })),
    });
    const totalContextChars = [...result.specs.values()].reduce(
      (sum, spec) => sum + spec.contextText.length,
      0
    );
    const firstContext = result.specs.get('member-0')?.contextText ?? '';

    expect(result.specs.size).toBe(30);
    expect(totalContextChars).toBeLessThanOrEqual(MAX_NATIVE_BOOTSTRAP_TOTAL_CONTEXT_CHARS);
    expect(firstContext).toContain('The app loaded compact startup context');
    expect(firstContext).toContain('Startup rules:');
    expect(firstContext).toContain('Current task briefing:');
    expect(firstContext).toContain('[truncated native bootstrap context]');
  });

  it('keeps Codex MCP rules in compact native startup context', async () => {
    await new TeamMetaStore().writeMeta('large-codex-native-team', {
      cwd: '/tmp/workspace',
      providerId: 'codex',
      model: 'gpt-5.4-mini',
      createdAt: Date.now(),
    });
    const members = Array.from({ length: 10 }, (_, index) => ({
      name: `member-${index}`,
      providerId: 'codex' as const,
      role: 'Developer',
      model: 'gpt-5.4-mini',
    }));
    await new TeamMembersMetaStore().writeMembers('large-codex-native-team', members);

    const result = await buildNativeAppManagedBootstrapSpecsWithDiagnostics({
      teamName: 'large-codex-native-team',
      cwd: '/tmp/workspace',
      members,
    });
    const firstContext = result.specs.get('member-0')?.contextText ?? '';

    expect(result.specs.size).toBe(10);
    expect(firstContext).toContain('The app loaded compact startup context');
    expect(firstContext).toContain('mcp__agent-teams__task_get');
    expect(firstContext).toContain('mcp__agent-teams__member_work_sync_report');
    expect(firstContext).toContain('mcp__agent-teams__message_send');
    expect(firstContext).toContain('Do not use SendMessage');
  });

});
