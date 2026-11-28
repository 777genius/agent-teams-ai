import { monitorFailure } from '../../contracts';

import type { DeviceLogin, LoginProgress, MonitorResult } from '../../contracts';

export interface GitHubLoginConfiguration {
  readonly clientId: string;
  readonly scope: string;
  readonly permissionNotice: string;
}
export interface OAuthCredential {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly refreshExpiresAt?: number;
  readonly accountId: string;
  readonly clientId: string;
}
export interface DeviceIssuer {
  request(parameters: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown>;
  exchange(parameters: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown>;
  identity(accessToken: string, signal: AbortSignal): Promise<string>;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const boundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000\r\n]/.test(value);
const seconds = (value: unknown, fallback: number): number =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Math.min(Number(value), 31_536_000) : fallback;

/** Main-owned protocol state. Public views contain neither device nor access tokens. */
export function createDeviceAuthorization(options: {
  configuration: GitHubLoginConfiguration | null;
  issuer: DeviceIssuer;
  now(): number;
  newId(): string;
  save(credential: OAuthCredential, signal: AbortSignal): Promise<void>;
}) {
  let pending: {
    view: DeviceLogin;
    deviceCode: string;
    abort: AbortController;
    nextPoll: number;
    interval: number;
    busy: boolean;
  } | null = null;
  const cancel = () => {
    pending?.abort.abort();
    pending = null;
  };
  const missing = () =>
    monitorFailure(
      'not_configured',
      'GitHub sign-in is not configured in this build. Use a signed-in GitHub CLI account.'
    );

  async function credential(value: unknown, signal: AbortSignal): Promise<OAuthCredential> {
    const record = object(value);
    if (
      !boundedString(record.access_token, 4096) ||
      record.token_type !== 'bearer' ||
      !options.configuration
    )
      throw new Error('Invalid sign-in response.');
    const accountId = await options.issuer.identity(record.access_token, signal);
    return {
      accessToken: record.access_token,
      accountId,
      clientId: options.configuration.clientId,
      ...(boundedString(record.refresh_token, 4096) ? { refreshToken: record.refresh_token } : {}),
      ...(record.expires_in !== undefined
        ? { expiresAt: options.now() + seconds(record.expires_in, 1) * 1000 }
        : {}),
      ...(record.refresh_token_expires_in !== undefined
        ? { refreshExpiresAt: options.now() + seconds(record.refresh_token_expires_in, 1) * 1000 }
        : {}),
    };
  }
  return {
    cancel,
    configured: options.configuration !== null,
    permissionNotice: options.configuration?.permissionNotice ?? '',
    async begin(): Promise<MonitorResult<DeviceLogin>> {
      cancel();
      if (!options.configuration) return missing();
      const abort = new AbortController();
      const current = {
        abort,
        view: {} as DeviceLogin,
        deviceCode: '',
        nextPoll: 0,
        interval: 5000,
        busy: false,
      };
      pending = current;
      try {
        const response = object(
          await options.issuer.request(
            {
              client_id: options.configuration.clientId,
              ...(options.configuration.scope ? { scope: options.configuration.scope } : {}),
            },
            abort.signal
          )
        );
        if (pending !== current || abort.signal.aborted)
          return monitorFailure('aborted', 'GitHub sign-in was cancelled.');
        if (
          !boundedString(response.device_code, 256) ||
          !boundedString(response.user_code, 32) ||
          response.verification_uri !== 'https://github.com/login/device'
        )
          throw new Error('Invalid device response.');
        current.interval = Math.max(5000, seconds(response.interval, 5) * 1000);
        current.deviceCode = response.device_code;
        current.nextPoll = options.now() + current.interval;
        current.view = {
          attemptId: options.newId(),
          userCode: response.user_code,
          verificationUri: response.verification_uri,
          expiresAt: new Date(
            options.now() + Math.min(seconds(response.expires_in, 900), 900) * 1000
          ).toISOString(),
          intervalMs: current.interval,
        };
        return { ok: true, value: current.view };
      } catch {
        if (pending === current) cancel();
        return monitorFailure(
          'offline',
          'Could not start GitHub sign-in. Check your connection and try again.'
        );
      }
    },
    async poll(attemptId: string): Promise<MonitorResult<LoginProgress>> {
      const current = pending;
      if (!options.configuration) return missing();
      if (!current || current.view.attemptId !== attemptId)
        return monitorFailure('aborted', 'This GitHub sign-in is no longer active.');
      if (options.now() >= Date.parse(current.view.expiresAt)) {
        cancel();
        return monitorFailure(
          'unauthorized',
          'The sign-in code expired. Start GitHub sign-in again.'
        );
      }
      const waiting = (): MonitorResult<LoginProgress> => ({
        ok: true,
        value: { status: 'pending', retryAt: new Date(current.nextPoll).toISOString() },
      });
      if (current.busy || options.now() < current.nextPoll) return waiting();
      current.busy = true;
      current.nextPoll = options.now() + current.interval;
      try {
        const response = object(
          await options.issuer.exchange(
            {
              client_id: options.configuration.clientId,
              device_code: current.deviceCode,
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            },
            current.abort.signal
          )
        );
        if (pending !== current || current.abort.signal.aborted)
          return monitorFailure('aborted', 'GitHub sign-in was cancelled.');
        if (response.error === 'authorization_pending') return waiting();
        if (response.error === 'slow_down') {
          current.interval = Math.max(
            current.interval + 5000,
            seconds(response.interval, 0) * 1000
          );
          current.nextPoll = options.now() + current.interval;
          return waiting();
        }
        if (response.error) {
          cancel();
          return monitorFailure(
            'unauthorized',
            response.error === 'access_denied'
              ? 'GitHub sign-in was declined. You can start again.'
              : 'GitHub sign-in could not finish. Start again.'
          );
        }
        const saved = await credential(response, current.abort.signal);
        if (pending !== current || current.abort.signal.aborted)
          return monitorFailure('aborted', 'GitHub sign-in was cancelled.');
        await options.save(saved, current.abort.signal);
        if (pending !== current) return monitorFailure('aborted', 'GitHub sign-in was cancelled.');
        cancel();
        return { ok: true, value: { status: 'connected' } };
      } catch {
        if (pending === current) cancel();
        return monitorFailure(
          'offline',
          'GitHub sign-in could not finish. Check your connection and try again.'
        );
      } finally {
        current.busy = false;
      }
    },
    async refresh(previous: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
      if (
        !options.configuration ||
        !previous.refreshToken ||
        (previous.refreshExpiresAt !== undefined && previous.refreshExpiresAt <= options.now())
      )
        throw new Error('Sign in again.');
      const response = await options.issuer.exchange(
        {
          client_id: options.configuration.clientId,
          refresh_token: previous.refreshToken,
          grant_type: 'refresh_token',
        },
        signal
      );
      const next = await credential(response, signal);
      if (next.accountId !== previous.accountId) throw new Error('GitHub account changed.');
      await options.save(next, signal);
      return next;
    },
  };
}
