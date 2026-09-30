import {
  createTeamToolApprovalRendererSlice,
  loadTeamToolApprovalSettingsIntoRenderer,
  type TeamToolApprovalRendererSlice,
  type TeamToolApprovalRendererSliceDependencies,
  type TeamToolApprovalRendererState,
} from '@features/team-provisioning/renderer';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolApprovalRequest, ToolApprovalSettings } from '@shared/types';

type TestState = TeamToolApprovalRendererState & TeamToolApprovalRendererSlice;

const settings = (overrides: Partial<ToolApprovalSettings> = {}): ToolApprovalSettings => ({
  ...DEFAULT_TOOL_APPROVAL_SETTINGS,
  ...overrides,
});

const approval = (runId: string, requestId: string, teamName = 'alpha'): ToolApprovalRequest => ({
  requestId,
  runId,
  teamName,
  source: 'lead',
  toolName: 'Bash',
  toolInput: { command: 'pwd' },
  receivedAt: '2026-07-28T12:00:00.000Z',
});

function createHarness(input?: {
  all?: Record<string, ToolApprovalSettings>;
  legacy?: ToolApprovalSettings;
  loadedByTeam?: Record<string, ToolApprovalSettings>;
  selectedTeamName?: string | null;
}) {
  let state: TestState = {
    selectedTeamName: input?.selectedTeamName ?? null,
    pendingApprovals: [],
    resolvedApprovals: new Map(),
    toolApprovalSettingsByTeam: {},
    toolApprovalSettings: DEFAULT_TOOL_APPROVAL_SETTINGS,
    updateToolApprovalSettings: () => Promise.resolve(),
    respondToToolApproval: () => Promise.resolve(),
  };
  const persistAndSchedule = vi.fn();
  const schedule = vi.fn();
  const respond = vi.fn().mockResolvedValue(undefined);
  const error = vi.fn();
  const loadForTeam = vi.fn(
    (teamName: string) => input?.loadedByTeam?.[teamName] ?? DEFAULT_TOOL_APPROVAL_SETTINGS
  );
  const dependencies: TeamToolApprovalRendererSliceDependencies<TestState> = {
    log: { error },
    persistedSettings: {
      loadAll: () => input?.all ?? {},
      loadForTeam,
      loadLegacy: () => input?.legacy ?? DEFAULT_TOOL_APPROVAL_SETTINGS,
    },
    projection: {
      project: (current, teamName, nextSettings, selectTeam = false) => ({
        toolApprovalSettingsByTeam: {
          ...current.toolApprovalSettingsByTeam,
          [teamName]: nextSettings,
        },
        ...(selectTeam || current.selectedTeamName === teamName
          ? { toolApprovalSettings: nextSettings }
          : {}),
      }),
    },
    responseTransport: { respond },
    settingsSync: { persistAndSchedule, schedule },
    state: {
      getState: () => state,
      setState: (update) => {
        const patch = typeof update === 'function' ? update(state) : update;
        state = { ...state, ...patch };
      },
    },
  };
  state = { ...state, ...createTeamToolApprovalRendererSlice(dependencies) };

  return {
    dependencies,
    error,
    getState: () => state,
    loadForTeam,
    persistAndSchedule,
    respond,
    schedule,
    setState: (patch: Partial<TestState>) => {
      state = { ...state, ...patch };
    },
  };
}

describe('createTeamToolApprovalRendererSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads initial team and legacy settings and updates the selected team optimistically', async () => {
    const alpha = settings({ autoAllowFileEdits: true });
    const legacy = settings({ timeoutAction: 'deny' });
    const harness = createHarness({
      all: { alpha },
      legacy,
      selectedTeamName: 'alpha',
    });

    expect(harness.getState().toolApprovalSettingsByTeam).toEqual({ alpha });
    expect(harness.getState().toolApprovalSettings).toEqual(legacy);

    const desired = { ...alpha, autoAllowAll: true };
    harness.persistAndSchedule.mockImplementationOnce(() => {
      expect(harness.getState().toolApprovalSettingsByTeam.alpha).toEqual(desired);
      expect(harness.getState().toolApprovalSettings).toEqual(desired);
    });
    await harness.getState().updateToolApprovalSettings({ autoAllowAll: true });

    expect(harness.getState().toolApprovalSettingsByTeam.alpha).toEqual(desired);
    expect(harness.getState().toolApprovalSettings).toEqual(desired);
    expect(harness.loadForTeam).not.toHaveBeenCalled();
    expect(harness.persistAndSchedule).toHaveBeenCalledWith('alpha', desired);
  });

  it('preserves no-team fallback semantics and persists the legacy desired settings', async () => {
    const legacy = settings({ timeoutAction: 'wait' });
    const harness = createHarness({ legacy });

    await harness.getState().updateToolApprovalSettings({ timeoutSeconds: 90 });

    const desired = { ...legacy, timeoutSeconds: 90 };
    expect(harness.getState().toolApprovalSettings).toEqual(desired);
    expect(harness.getState().toolApprovalSettingsByTeam).toEqual({});
    expect(harness.persistAndSchedule).toHaveBeenCalledWith(null, desired);
  });

  it('loads and projects background-team settings without replacing the selected projection', async () => {
    const selected = settings({ autoAllowFileEdits: true });
    const background = settings({ autoAllowSafeBash: true });
    const harness = createHarness({
      all: { alpha: selected },
      legacy: selected,
      loadedByTeam: { beta: background },
      selectedTeamName: 'alpha',
    });

    await harness.getState().updateToolApprovalSettings({ autoAllowAll: true }, 'beta');

    const desired = { ...background, autoAllowAll: true };
    expect(harness.getState().toolApprovalSettings).toBe(selected);
    expect(harness.getState().toolApprovalSettingsByTeam.beta).toEqual(desired);
    expect(harness.loadForTeam).toHaveBeenCalledWith('beta');
    expect(harness.persistAndSchedule).toHaveBeenCalledWith('beta', desired);
  });

  it('lazily loads selected-team settings, projects them and schedules latest-desired sync', () => {
    const loaded = settings({ timeoutSeconds: 75 });
    const harness = createHarness({
      loadedByTeam: { beta: loaded },
      selectedTeamName: 'alpha',
    });

    const result = loadTeamToolApprovalSettingsIntoRenderer(harness.dependencies, 'beta');

    expect(result).toBe(loaded);
    expect(harness.getState().toolApprovalSettings).toBe(loaded);
    expect(harness.getState().toolApprovalSettingsByTeam.beta).toBe(loaded);
    expect(harness.loadForTeam).toHaveBeenCalledWith('beta');
    expect(harness.schedule).toHaveBeenCalledWith('beta', loaded);
    expect(harness.persistAndSchedule).not.toHaveBeenCalled();
  });

  it('responds before removing only the matching run/request and replaces the resolved Map', async () => {
    const harness = createHarness();
    const previousResolved = new Map([['older', false]]);
    harness.setState({
      pendingApprovals: [
        approval('run-1', 'request-1'),
        approval('run-2', 'request-1'),
        approval('run-1', 'request-2'),
      ],
      resolvedApprovals: previousResolved,
    });
    harness.respond.mockImplementationOnce(() => {
      expect(harness.getState().pendingApprovals).toHaveLength(3);
      expect(harness.getState().resolvedApprovals).toBe(previousResolved);
      return Promise.resolve();
    });

    await harness.getState().respondToToolApproval('alpha', 'run-1', 'request-1', true, 'approved');

    expect(harness.respond).toHaveBeenCalledWith('alpha', 'run-1', 'request-1', true, 'approved');
    expect(harness.getState().pendingApprovals).toEqual([
      approval('run-2', 'request-1'),
      approval('run-1', 'request-2'),
    ]);
    expect(harness.getState().resolvedApprovals).not.toBe(previousResolved);
    expect(harness.getState().resolvedApprovals).toEqual(
      new Map([
        ['older', false],
        ['request-1', true],
      ])
    );
  });

  it('logs and rethrows response failures without rolling back or projecting a resolution', async () => {
    const harness = createHarness();
    const failure = new Error('transport unavailable');
    const pendingApprovals = [approval('run-1', 'request-1')];
    const resolvedApprovals = new Map([['older', true]]);
    harness.setState({ pendingApprovals, resolvedApprovals });
    harness.respond.mockRejectedValueOnce(failure);

    await expect(
      harness.getState().respondToToolApproval('alpha', 'run-1', 'request-1', false)
    ).rejects.toBe(failure);

    expect(harness.error).toHaveBeenCalledWith(
      'respondToToolApproval failed for alpha/request-1: transport unavailable'
    );
    expect(harness.getState().pendingApprovals).toBe(pendingApprovals);
    expect(harness.getState().resolvedApprovals).toBe(resolvedApprovals);
  });
});
