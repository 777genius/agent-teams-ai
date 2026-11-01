// @vitest-environment node
import { BoundControlContext } from '@features/external-agent-connection/main/BoundControlContext';
import { ExternalAgentConnection } from '@features/external-agent-connection/main/ExternalAgentConnection';
import { expect, it, vi } from 'vitest';

it('keeps a sanitized profile failure visible instead of advertising ready handles or retrying them', async () => {
  const context = new BoundControlContext('TEST-app', '/TEST-root');
  const handle = { url: 'http://TEST-mcp', generation: 1 };
  const startControl = vi.fn(async () => undefined),
    ensureStarted = vi.fn(async () => undefined);
  const connection = new ExternalAgentConnection({
    context,
    getMainContents: () => null,
    getCdpEnabled: () => true,
    getAppVersion: () => 'test',
    getProfileFingerprint: () => 'TEST-profile',
    isLocalContext: () => true,
    getControlUrl: () => 'http://TEST-control',
    getBoundControlUrl: () => 'http://TEST-control',
    hasTeamManagement: () => true,
    startControl,
    mcp: { getCurrentHandle: () => handle, ensureStarted },
    cdp: {
      read: async () => ({
        cdp: {
          status: 'ready',
          httpOrigin: 'http://TEST-cdp',
          browserWsUrl: 'ws://TEST-cdp',
          rendererTargetId: 'TEST-target',
          rendererWsUrl: 'ws://TEST-renderer',
          targetGeneration: 1,
        },
        reason: null,
      }),
    } as unknown as ConstructorParameters<typeof ExternalAgentConnection>[0]['cdp'],
  });
  expect((await connection.getConnectionInfo()).mcp.status).toBe('ready');
  connection.reportProfileTransitionFailure();
  const failed = await connection.getConnectionInfo();
  expect(failed.errorCode).toBe('API_PROFILE_TRANSITION_FAILED');
  expect(failed.reason).toBe(
    'The app profile transition failed. Restart the app before reconnecting.'
  );
  expect(failed.recovery).toBe('Restart the app.');
  expect(failed.mcp).toMatchObject({ status: 'error', url: null });
  expect(failed.control.status).toBe('error');
  expect(failed.cdp).toMatchObject({ status: 'error', httpOrigin: null, rendererWsUrl: null });
  expect(Object.values(failed.capabilities).every((value) => value === false)).toBe(true);
  expect((await connection.retryConnection()).errorCode).toBe('API_PROFILE_TRANSITION_FAILED');
  expect(startControl).not.toHaveBeenCalled();
  expect(ensureStarted).not.toHaveBeenCalled();
});
