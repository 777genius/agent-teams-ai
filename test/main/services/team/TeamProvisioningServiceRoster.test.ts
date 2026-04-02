import { describe, expect, it, vi } from 'vitest';

import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';

describe('TeamProvisioningService (launch roster discovery)', () => {
  it('inbox fallback keeps -1 names but drops auto-suffixed -2+ when base exists', async () => {
    const svc = new TeamProvisioningService(
      {} as never,
      {
        listInboxNames: vi.fn(async () => [
          'dev',
          'dev-1',
          'dev-2',
          'dev-3',
          'user',
          'team-lead',
          'DEV-2',
        ]),
      } as never,
      { getMembers: vi.fn(async () => []) } as never,
      {} as never
    );

    const result = await (svc as unknown as any).resolveLaunchExpectedMembers('t', '{}');
    expect(result.source).toBe('inboxes');
    expect(result.members.map((m: { name: string }) => m.name)).toEqual(['dev', 'dev-1']);
  });

  it('inbox fallback ignores cross-team pseudo and qualified external names', async () => {
    const svc = new TeamProvisioningService(
      {} as never,
      {
        listInboxNames: vi.fn(async () => [
          'dev',
          'cross-team:team-alpha-super',
          'cross-team-team-alpha-super',
          'team-alpha-super.user',
        ]),
      } as never,
      { getMembers: vi.fn(async () => []) } as never,
      {} as never
    );

    const result = await (svc as unknown as any).resolveLaunchExpectedMembers('t', '{}');
    expect(result.source).toBe('inboxes');
    expect(result.members.map((m: { name: string }) => m.name)).toEqual(['dev']);
  });

  it('inbox fallback keeps suffixed name if base is absent', async () => {
    const svc = new TeamProvisioningService(
      {} as never,
      { listInboxNames: vi.fn(async () => ['alice-2']) } as never,
      { getMembers: vi.fn(async () => []) } as never,
      {} as never
    );

    const result = await (svc as unknown as any).resolveLaunchExpectedMembers('t', '{}');
    expect(result.source).toBe('inboxes');
    expect(result.members.map((m: { name: string }) => m.name)).toEqual(['alice-2']);
  });

  it('inbox fallback merges provider/model overrides from config for multimodel reconnect', async () => {
    const svc = new TeamProvisioningService(
      {} as never,
      { listInboxNames: vi.fn(async () => ['bob']) } as never,
      { getMembers: vi.fn(async () => []) } as never,
      {} as never
    );

    const configRaw = JSON.stringify({
      name: 't',
      members: [{ name: 'bob', role: 'reviewer', provider: 'codex', model: 'gpt-5.4' }],
    });

    const result = await (svc as unknown as any).resolveLaunchExpectedMembers('t', configRaw);
    expect(result.source).toBe('inboxes');
    expect(result.members).toEqual([
      { name: 'bob', role: 'reviewer', workflow: undefined, providerId: 'codex', model: 'gpt-5.4' },
    ]);
    expect(result.warning).toContain('best-effort');
  });

  it('members.meta.json fallback never returns reserved names (user/team-lead)', async () => {
    const svc = new TeamProvisioningService(
      {} as never,
      { listInboxNames: vi.fn(async () => []) } as never,
      {
        getMembers: vi.fn(async () => [
          { name: 'user', agentType: 'general-purpose' },
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'Alice', role: 'dev', agentType: 'general-purpose' },
        ]),
      } as never,
      {} as never
    );

    const result = await (svc as unknown as any).resolveLaunchExpectedMembers('t', '{}');
    expect(result.source).toBe('members-meta');
    expect(result.members.map((m: { name: string }) => m.name)).toEqual(['Alice']);
  });

  it('config fallback never returns reserved names (user/team-lead)', async () => {
    const svc = new TeamProvisioningService(
      {} as never,
      { listInboxNames: vi.fn(async () => []) } as never,
      { getMembers: vi.fn(async () => []) } as never,
      {} as never
    );

    const configRaw = JSON.stringify({
      name: 't',
      members: [{ name: 'team-lead', agentType: 'team-lead' }, { name: 'user' }, { name: 'bob' }],
    });

    const result = await (svc as unknown as any).resolveLaunchExpectedMembers('t', configRaw);
    expect(result.source).toBe('config-fallback');
    expect(result.members.map((m: { name: string }) => m.name)).toEqual(['bob']);
  });
});
