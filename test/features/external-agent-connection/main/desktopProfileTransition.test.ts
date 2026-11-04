// @vitest-environment node
import { createDesktopExternalAgentConnection } from '@features/external-agent-connection/main/composition/createDesktopExternalAgentConnection';
import {
  configureApiProfileChanges,
  registerProfileParticipant,
} from '@features/local-http-auth/main/application/profileTransition';
import { afterEach, describe, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({ retry: vi.fn(), report: vi.fn() }));

vi.mock('@features/local-http-auth/main', async () => ({
  ...(await import('@features/local-http-auth/main/application/profileTransition')),
  applyApiAuthReference: vi.fn(),
}));
vi.mock('@main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv', () => ({
  buildOpenCodeAppProfileScope: () => 'TEST-profile',
}));
vi.mock('@features/external-agent-connection/main/desktopMcpEnvironment', () => ({
  configureDesktopMcpEnvironment: () => () => undefined,
}));
vi.mock('@features/external-agent-connection/main/registerBoundControlHttp', () => ({
  registerBoundControlHttp: vi.fn(),
}));
vi.mock('@features/external-agent-connection/main/ExternalAgentConnection', () => ({
  ExternalAgentConnection: class {
    retryConnection = observed.retry;
    reportProfileTransitionFailure = observed.report;
    getConnectionInfo = vi.fn();
  },
}));

const unregister: Array<() => void> = [];
afterEach(() => {
  for (const release of unregister.splice(0)) release();
  configureApiProfileChanges(() => undefined);
  vi.clearAllMocks();
});

function fixture() {
  let root = '/TEST-profile-old';
  let local = true;
  let credentialEpoch = 1;
  let liveMcp = false;
  let liveRuntime = false;
  let paused = false;
  const stop = vi.fn(async () => undefined);
  const mutate = vi.fn(() => {
    root = '/TEST-profile-new';
  });
  const resume = Object.assign(
    vi.fn(async () => {
      ++credentialEpoch;
      paused = false;
    }),
    {
      unchanged: vi.fn(async (assertUnchanged: () => void) => {
        assertUnchanged();
        paused = false;
      }),
    }
  );
  const pause = vi.fn(async () => {
    paused = true;
    return resume;
  });
  unregister.push(registerProfileParticipant({ pause }));
  const connection = createDesktopExternalAgentConnection({
    appInstanceId: 'TEST-instance',
    userDataPath: '/TEST-profile',
    getRoot: () => root,
    getMainContents: () => null,
    getCdpEnabled: () => false,
    getAppVersion: () => 'test',
    isLocalContext: () => local,
    getControlUrl: () => null,
    getControlAuthToken: () => `TEST-token-${credentialEpoch}`,
    startControl: async () => undefined,
    reconfigureRoot: vi.fn(),
    cdp: {} as Parameters<typeof createDesktopExternalAgentConnection>[0]['cdp'],
    httpEnabled: true,
    mcp: {
      getCurrentHandle: () => null,
      ensureStarted: async () => undefined,
      assertNoLiveConsumers: async () => {
        if (liveMcp) throw new Error('Live MCP consumer');
      },
      stop,
      appContext: { bind: () => () => undefined },
    },
    assertNoLiveRuntimeConsumers: () => {
      if (liveRuntime) throw new Error('Live runtime consumer');
    },
  });
  return {
    connection,
    mutate,
    pause,
    resume,
    stop,
    get root() {
      return root;
    },
    get paused() {
      return paused;
    },
    setLiveMcp: () => {
      liveMcp = true;
    },
    setLocal: (value: boolean) => {
      local = value;
    },
    get credentialEpoch() {
      return credentialEpoch;
    },
    appearDuringDrain: () => {
      pause.mockImplementationOnce(async () => {
        paused = true;
        liveMcp = true;
        return resume;
      });
    },
    setLiveRuntime: () => {
      liveRuntime = true;
    },
  };
}

describe('desktop profile transition rejection', () => {
  it.each(['updateRoot', 'changeContext'] as const)(
    '%s rejects live consumers before pausing the unchanged HTTP/SSE profile',
    async (method) => {
      const f = fixture();
      f.setLiveRuntime();
      await expect(f.connection[method](f.mutate)).rejects.toThrow('Live runtime consumer');
      expect(f.pause).not.toHaveBeenCalled();
      expect(f.paused).toBe(false);
      expect(f.mutate).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      expect(() => f.connection.assertLaunchAdmission()).not.toThrow();
    }
  );

  it('restores the unchanged participant when a consumer appears during draining', async () => {
    const f = fixture();
    f.pause.mockImplementationOnce(async () => {
      f.setLiveMcp();
      return f.resume;
    });
    await expect(f.connection.updateRoot(f.mutate)).rejects.toThrow('Live MCP consumer');
    // The result can reject before physical restoration finishes; queue another change to join it.
    await expect(f.connection.changeContext(f.mutate)).rejects.toThrow('Live MCP consumer');
    expect(f.resume.unchanged).toHaveBeenCalledOnce();
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.mutate).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.root).toBe('/TEST-profile-old');
    expect(observed.retry).not.toHaveBeenCalled();
    expect(() => f.connection.assertLaunchAdmission()).not.toThrow();
  });

  it('restores HTTP for a settled non-local context without reopening MCP admission or rotating its epoch', async () => {
    const f = fixture();
    await f.connection.changeContext(() => f.setLocal(false));
    expect(() => f.connection.assertLaunchAdmission()).toThrow('changing context');
    const epoch = f.credentialEpoch;
    f.resume.mockClear();
    f.appearDuringDrain();
    await expect(f.connection.changeContext(f.mutate)).rejects.toThrow('Live MCP consumer');
    await expect(f.connection.changeContext(f.mutate)).rejects.toThrow('Live MCP consumer');
    expect(f.paused).toBe(false);
    expect(f.resume.unchanged).toHaveBeenCalledOnce();
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.credentialEpoch).toBe(epoch);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(observed.retry).not.toHaveBeenCalled();
    expect(() => f.connection.assertLaunchAdmission()).toThrow('changing context');
  });

  it('never treats a failed mutation to the same non-local flag as the settled closed context', async () => {
    const f = fixture();
    await f.connection.changeContext(() => f.setLocal(false));
    await expect(
      f.connection.changeContext(() => {
        f.setLocal(false);
        throw new Error('Unknown non-local mutation');
      })
    ).rejects.toThrow('Unknown non-local mutation');
    const epoch = f.credentialEpoch;
    f.appearDuringDrain();
    await expect(f.connection.changeContext(f.mutate)).rejects.toThrow('Live MCP consumer');
    await expect(f.connection.changeContext(f.mutate)).rejects.toThrow('profile transition failed');
    expect(observed.report).toHaveBeenCalledOnce();
    expect(f.paused).toBe(true);
    expect(f.resume.unchanged).not.toHaveBeenCalled();
    expect(f.credentialEpoch).toBe(epoch);
    expect(() => f.connection.assertLaunchAdmission()).toThrow('changing context');
  });

  it('publishes owner failure and closes desktop admission after HTTP success but failed physical resume', async () => {
    const f = fixture();
    f.resume.mockRejectedValueOnce(new Error('TEST-secret-config'));
    await expect(
      f.connection.updateRoot(f.mutate, {} as import('fastify').FastifyRequest)
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(observed.report).toHaveBeenCalledOnce());
    expect(() => f.connection.assertLaunchAdmission()).toThrow('changing context');
    expect(observed.retry).not.toHaveBeenCalled();
  });

  it('keeps admission paused after a mutation starts and fails', async () => {
    const f = fixture();
    await expect(
      f.connection.updateRoot(() => {
        f.mutate();
        throw new Error('Partial mutation');
      })
    ).rejects.toThrow('Partial mutation');
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.paused).toBe(true);
    expect(f.root).toBe('/TEST-profile-new');
    expect(f.stop).toHaveBeenCalledOnce();
    expect(() => f.connection.assertLaunchAdmission()).toThrow('changing context');
  });

  it('does not reopen a paused profile after shutdown wins the drain', async () => {
    const f = fixture();
    f.pause.mockImplementationOnce(async () => {
      void f.connection.closeAdmission();
      return f.resume;
    });
    await expect(f.connection.updateRoot(f.mutate)).rejects.toThrow('cancelled');
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.mutate).not.toHaveBeenCalled();
    expect(() => f.connection.assertLaunchAdmission()).toThrow('changing context');
  });
});
