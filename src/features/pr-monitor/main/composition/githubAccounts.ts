import { randomUUID } from 'node:crypto';

import { createFetchTransport } from '@pr-monitor/github';

import { monitorFailure } from '../../contracts';
import {
  createDeviceAuthorization,
  GitHubAuthorizationError,
} from '../../core/application/deviceAuthorization';
import { authenticatedGhAccount } from '../infrastructure/ghAccount';
import { createGhTransport } from '../infrastructure/ghTransport';
import { createGitHubDeviceIssuer } from '../infrastructure/githubOAuth';

import type { MonitorResult } from '../../contracts';
import type {
  DeviceIssuer,
  GitHubLoginConfiguration,
  OAuthCredential,
} from '../../core/application/deviceAuthorization';
import type { MonitorAccount } from '../../core/application/projectMonitor';
import type { createGitHubReaders } from './githubReaders';

export interface GitHubCredentialStore {
  read(): Promise<OAuthCredential | null>;
  save(credential: OAuthCredential, signal?: AbortSignal): Promise<void>;
  clear(): Promise<void>;
  available?(): Promise<boolean>;
}

/** The application owns one native account connection, separate from repository grants. */
export function createGitHubAccounts(options: {
  readers: ReturnType<typeof createGitHubReaders>;
  store: GitHubCredentialStore;
  configuration: GitHubLoginConfiguration | null;
  issuer?: DeviceIssuer;
  cliAccount?: typeof authenticatedGhAccount;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const issuer = options.issuer ?? createGitHubDeviceIssuer();
  const cliAccount = options.cliAccount ?? authenticatedGhAccount;
  let authority = new AbortController();
  let saved: OAuthCredential | null | undefined;
  let refreshing: Promise<OAuthCredential> | undefined;
  const flow = createDeviceAuthorization({
    configuration: options.configuration,
    issuer,
    now,
    newId: randomUUID,
    async save(credential, signal) {
      if (signal.aborted) throw new Error('Sign-in cancelled.');
      await options.store.save(credential, signal);
      if (signal.aborted) throw new Error('Sign-in cancelled.');
      if (saved && saved.accountId !== credential.accountId) retireConnection();
      saved = credential;
    },
  });

  async function token(connection: AbortController, accountId?: string): Promise<OAuthCredential> {
    if (connection !== authority || connection.signal.aborted)
      throw new Error('GitHub disconnected.');
    if (saved === undefined) {
      const loaded = await options.store.read();
      if (connection !== authority || connection.signal.aborted)
        throw new Error('GitHub disconnected.');
      saved = loaded;
    }
    if (!saved || saved.clientId !== options.configuration?.clientId)
      throw new Error('Sign in again.');
    if (accountId !== undefined && saved.accountId !== accountId)
      throw new GitHubAuthorizationError('GitHub account changed.');
    if (saved.expiresAt !== undefined && saved.expiresAt <= now() + 60_000) {
      if (!refreshing) {
        const pending = flow
          .refresh(saved, AbortSignal.any([connection.signal, AbortSignal.timeout(30_000)]))
          .catch((error: unknown) => {
            if (error instanceof GitHubAuthorizationError && connection === authority) {
              flow.cancel();
              retireConnection();
            }
            throw error;
          })
          .finally(() => {
            if (refreshing === pending) refreshing = undefined;
          });
        refreshing = pending;
      }
      const renewed = await refreshing;
      if (connection !== authority || connection.signal.aborted)
        throw new Error('GitHub disconnected.');
      saved = renewed;
    }
    return saved;
  }

  function retireConnection() {
    authority.abort();
    authority = new AbortController();
    saved = null;
    refreshing = undefined;
  }
  return {
    flow,
    async beginLogin() {
      flow.cancel();
      retireConnection();
      const connection = authority;
      if (!flow.configured) return flow.begin();
      const available = !options.store.available || (await options.store.available());
      if (connection !== authority || connection.signal.aborted)
        return monitorFailure('aborted', 'GitHub sign-in was cancelled.');
      if (!available)
        return monitorFailure(
          'unsupported',
          'Unlock your system keychain to sign in to GitHub, then try again.'
        );
      return flow.begin();
    },
    async connect(signal: AbortSignal): Promise<MonitorResult<MonitorAccount>> {
      const connection = authority;
      const identity = await cliAccount(signal);
      if (signal.aborted || connection !== authority || connection.signal.aborted)
        return monitorFailure('aborted', 'GitHub connection was cancelled.');
      if (identity)
        return {
          ok: true,
          value: {
            kind: 'cli',
            createReader: (repository) => options.readers.get(createGhTransport(repository)),
            isCurrent: async (checkSignal) =>
              !checkSignal.aborted && (await cliAccount(checkSignal)) === identity,
          },
        };
      try {
        const credential = await token(connection);
        if ((await issuer.identity(credential.accessToken, signal)) !== credential.accountId)
          throw new Error('GitHub account changed.');
        if (connection !== authority || connection.signal.aborted)
          throw new Error('GitHub disconnected.');
        return {
          ok: true,
          value: {
            kind: 'device',
            createReader: () =>
              options.readers.get(
                createFetchTransport({
                  getToken: async () => (await token(connection, credential.accountId)).accessToken,
                })
              ),
            isCurrent: async (checkSignal) =>
              !checkSignal.aborted &&
              connection === authority &&
              !connection.signal.aborted &&
              saved?.accountId === credential.accountId,
          },
        };
      } catch {
        return monitorFailure(
          options.configuration ? 'sign_in_required' : 'not_configured',
          options.configuration
            ? 'No signed-in GitHub CLI account was found. Sign in to GitHub to continue.'
            : 'GitHub sign-in is not configured in this build. Use a signed-in GitHub CLI account.'
        );
      }
    },
    async signOut() {
      flow.cancel();
      retireConnection();
      saved = null;
      await options.store.clear();
    },
    dispose() {
      flow.cancel();
      authority.abort();
      saved = null;
    },
  };
}
