import { TeamTaskAgendaSource } from '@features/member-work-sync/main/adapters/output/TeamTaskAgendaSource';
import { expect, it, vi } from 'vitest';

function source(deps: Record<string, unknown>) {
  return new TeamTaskAgendaSource({
    configReader: { getConfig: async () => ({ name: 'sandbox', members: [{ name: 'alice' }] }) },
    membersMetaStore: { getMembers: async () => [] },
    taskReader: { getTasks: async () => [] },
    kanbanManager: { getState: async () => ({ teamName: 'sandbox', tasks: {}, reviewers: [] }) },
    clock: { now: () => new Date() },
    hash: { sha256Hex: (text: string) => text },
    readTimeoutMs: 20,
    ...deps,
  } as never);
}

it('replaces an expired roster read without allowing its late result to poison the cache', async () => {
  vi.useFakeTimers();
  let release!: (config: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const getConfig = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValue({ name: 'sandbox', members: [{ name: 'new-member' }] });
  const agenda = source({ configReader: { getConfig } });
  try {
    const first = expect(agenda.loadActiveMemberNames('sandbox')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20);
    await first;
    expect(await agenda.loadActiveMemberNames('sandbox')).toEqual(['new-member']);
    release({ name: 'sandbox', members: [{ name: 'obsolete' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(await agenda.loadActiveMemberNames('sandbox')).toEqual(['new-member']);
    expect(getConfig).toHaveBeenCalledTimes(2);
  } finally {
    release(null);
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }
});

it('retains failed work reads until their sibling I/O settles, bounding replacements across 100 loads', async () => {
  vi.useFakeTimers();
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const getTasks = vi.fn(async () => {
    throw new Error('tasks unreadable');
  });
  const getState = vi.fn(() => pending);
  const agenda = source({ taskReader: { getTasks }, kanbanManager: { getState } });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = expect(
        agenda.loadAgenda({ teamName: 'sandbox', memberName: 'alice' })
      ).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(20);
      await read;
    }
    for (let tick = 0; tick < 100; tick++) {
      await expect(agenda.loadAgenda({ teamName: 'sandbox', memberName: 'alice' })).rejects.toThrow(
        'capacity exhausted'
      );
    }
    expect(getTasks).toHaveBeenCalledTimes(2);
    expect(getState).toHaveBeenCalledTimes(2);
    release({ teamName: 'sandbox', tasks: {}, reviewers: [] });
    await vi.advanceTimersByTimeAsync(0);
    await expect(agenda.loadAgenda({ teamName: 'sandbox', memberName: 'alice' })).rejects.toThrow(
      'tasks unreadable'
    );
    expect(getTasks).toHaveBeenCalledTimes(3);
  } finally {
    release({ tasks: {}, reviewers: [] });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }
});

it('bounds successful roster cache under team churn', async () => {
  const getConfig = vi.fn(async () => ({ members: [{ name: 'alice' }] }));
  const agenda = source({ configReader: { getConfig } });
  for (let team = 0; team < 129; team++) await agenda.loadActiveMemberNames(`sandbox-${team}`);
  expect(getConfig).toHaveBeenCalledTimes(129);
  await agenda.loadActiveMemberNames('sandbox-128');
  expect(getConfig).toHaveBeenCalledTimes(129);
  await agenda.loadActiveMemberNames('sandbox-0');
  expect(getConfig).toHaveBeenCalledTimes(130);
});
