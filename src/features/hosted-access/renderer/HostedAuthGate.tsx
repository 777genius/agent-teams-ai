import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';

import {
  HOSTED_AUTH_HEADERS,
  HOSTED_AUTH_ROUTES,
  HOSTED_RUNTIME_ISOLATION,
  type HostedAuthStatus,
} from '../contracts';

import { setHostedCsrfToken } from './csrfMemory';
import {
  type HostedAuthAvailability,
  HostedAuthRevalidationContext,
  type HostedAuthRevalidationResult,
} from './HostedAuthRevalidation';

interface HostedAuthGateProps {
  readonly children: ReactNode;
  readonly onAuthenticated?: (auth: HostedAuthStatus) => void;
}

type GateState =
  | { readonly status: 'loading' }
  | { readonly status: 'anonymous'; readonly auth: HostedAuthStatus; readonly error: string | null }
  | { readonly status: 'authenticated'; readonly auth: HostedAuthStatus; readonly epoch: number }
  | { readonly status: 'unavailable'; readonly error: string };

interface LogoutResponse {
  readonly ok: boolean;
  readonly redirectUrl?: string | null;
  readonly providerLogoutError?: string | null;
}

async function readJson<T>(response: Response): Promise<T> {
  const value = (await response.json()) as T & { readonly error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

const AUTH_REVALIDATION_TIMEOUT_MS = 8_000;

function sameAuthority(left: HostedAuthStatus, right: HostedAuthStatus): boolean {
  const a = left.principal;
  const b = right.principal;
  return (
    a !== null &&
    b !== null &&
    left.mode === right.mode &&
    left.deploymentId === right.deploymentId &&
    left.bootId === right.bootId &&
    a.userId === b.userId &&
    a.sessionId === b.sessionId &&
    a.role === b.role &&
    a.authenticationMethod === b.authenticationMethod &&
    a.permissions.length === b.permissions.length &&
    a.permissions.every((permission) => b.permissions.includes(permission))
  );
}

async function readAuthStatus(timeoutMs?: number): Promise<HostedAuthStatus> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = fetch(HOSTED_AUTH_ROUTES.status, {
    credentials: 'include',
    cache: 'no-store',
    headers: { accept: 'application/json' },
    signal: controller.signal,
  }).then((response) => readJson<HostedAuthStatus>(response));
  try {
    const auth =
      timeoutMs === undefined
        ? await request
        : await Promise.race([
            request,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => {
                controller.abort();
                reject(new Error('Authentication status timed out.'));
              }, timeoutMs);
            }),
          ]);
    const principal = auth && typeof auth === 'object' ? auth.principal : null;
    if (
      typeof auth !== 'object' ||
      auth === null ||
      (auth.mode !== 'personal' && auth.mode !== 'oidc') ||
      typeof auth.authenticated !== 'boolean' ||
      auth.runtimeIsolation !== HOSTED_RUNTIME_ISOLATION ||
      (auth.deploymentId !== null && typeof auth.deploymentId !== 'string') ||
      (auth.bootId !== null && typeof auth.bootId !== 'string') ||
      (auth.authenticated
        ? principal === null ||
          typeof principal !== 'object' ||
          typeof principal.userId !== 'string' ||
          !Array.isArray(principal.permissions) ||
          typeof auth.csrfToken !== 'string'
        : principal !== null || auth.csrfToken !== null)
    ) {
      throw new Error('Authentication status was invalid.');
    }
    return auth;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export const HostedAuthGate = ({ children, onAuthenticated }: HostedAuthGateProps) => {
  const [state, setState] = useState<GateState>({ status: 'loading' });
  const [pairingCode, setPairingCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<HostedAuthAvailability>('available');
  const authenticatedRef = useRef<HostedAuthStatus | null>(null);
  const revalidationRef = useRef<Promise<HostedAuthRevalidationResult> | null>(null);
  const mountedRef = useRef(false);
  const loadSequenceRef = useRef(0);
  const onAuthenticatedRef = useRef(onAuthenticated);
  onAuthenticatedRef.current = onAuthenticated;

  const acceptAuthenticated = useCallback((auth: HostedAuthStatus) => {
    setHostedCsrfToken(auth.csrfToken);
    authenticatedRef.current = auth;
    onAuthenticatedRef.current?.(auth);
    setAvailability('available');
    setState({ status: 'authenticated', auth, epoch: 0 });
  }, []);

  const load = useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    try {
      const auth = await readAuthStatus();
      if (!mountedRef.current || loadSequenceRef.current !== sequence) return;
      if (auth.authenticated) {
        acceptAuthenticated(auth);
      } else {
        authenticatedRef.current = null;
        setHostedCsrfToken(null);
        setState({ status: 'anonymous', auth, error: null });
      }
    } catch (error) {
      if (!mountedRef.current || loadSequenceRef.current !== sequence) return;
      authenticatedRef.current = null;
      setHostedCsrfToken(null);
      setState({
        status: 'unavailable',
        error: error instanceof Error ? error.message : 'Authentication is unavailable.',
      });
    }
  }, [acceptAuthenticated]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      loadSequenceRef.current += 1;
      setHostedCsrfToken(null);
    };
  }, [load]);

  const revalidate = useCallback((): Promise<HostedAuthRevalidationResult> => {
    if (revalidationRef.current !== null) return revalidationRef.current;
    const previousAuth = authenticatedRef.current;
    if (previousAuth === null) {
      return Promise.resolve({
        kind: 'unavailable',
        error: 'No authenticated session to revalidate.',
      });
    }
    setAvailability('checking');
    const pending = (async (): Promise<HostedAuthRevalidationResult> => {
      try {
        const auth = await readAuthStatus(AUTH_REVALIDATION_TIMEOUT_MS);
        if (!mountedRef.current || authenticatedRef.current !== previousAuth) {
          return {
            kind: 'unavailable',
            error: 'Authentication session changed during revalidation.',
          };
        }
        if (!auth.authenticated) {
          authenticatedRef.current = null;
          setHostedCsrfToken(null);
          setState({ status: 'anonymous', auth, error: null });
          return { kind: 'unauthenticated', auth };
        }
        const identity = sameAuthority(previousAuth, auth) ? 'same' : 'changed';
        authenticatedRef.current = auth;
        setHostedCsrfToken(auth.csrfToken);
        onAuthenticatedRef.current?.(auth);
        setAvailability('available');
        setState((current) => ({
          status: 'authenticated',
          auth,
          epoch:
            current.status === 'authenticated' && identity === 'changed'
              ? current.epoch + 1
              : current.status === 'authenticated'
                ? current.epoch
                : 0,
        }));
        return { kind: 'authenticated', identity, auth };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Authentication is unavailable.';
        if (mountedRef.current && authenticatedRef.current === previousAuth) {
          setAvailability('unavailable');
        }
        return { kind: 'unavailable', error: message };
      }
    })();
    revalidationRef.current = pending;
    void pending.finally(() => {
      if (revalidationRef.current === pending) revalidationRef.current = null;
    });
    return pending;
  }, []);

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    if (state.status !== 'anonymous' || state.auth.mode !== 'personal') return;
    setSubmitting(true);
    try {
      const response = await fetch(HOSTED_AUTH_ROUTES.pair, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          [HOSTED_AUTH_HEADERS.csrf]: '',
        },
        body: JSON.stringify({ pairingCode }),
      });
      const auth = await readJson<HostedAuthStatus>(response);
      setPairingCode('');
      acceptAuthenticated(auth);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Pairing failed.';
      setPairingCode('');
      if (message === 'identity_storage_unavailable') {
        setHostedCsrfToken(null);
        setState({ status: 'unavailable', error: message });
      } else {
        setState({
          status: 'anonymous',
          auth: state.auth,
          error: message,
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const endSession = async (action: 'local' | 'global' | 'forget-device') => {
    if (state.status !== 'authenticated' || state.auth.csrfToken === null) return;
    setSubmitting(true);
    setAccountError(null);
    try {
      const response = await fetch(
        action === 'forget-device' ? HOSTED_AUTH_ROUTES.forgetDevice : HOSTED_AUTH_ROUTES.logout,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            [HOSTED_AUTH_HEADERS.csrf]: state.auth.csrfToken,
          },
          body: JSON.stringify({ global: action === 'global' }),
        }
      );
      const result = await readJson<LogoutResponse>(response);
      authenticatedRef.current = null;
      setHostedCsrfToken(null);
      if (result.providerLogoutError) {
        setState({
          status: 'anonymous',
          auth: {
            ...state.auth,
            authenticated: false,
            principal: null,
            csrfToken: null,
          },
          error: result.providerLogoutError,
        });
        setSubmitting(false);
        return;
      }
      if (result.redirectUrl) {
        window.location.assign(result.redirectUrl);
      } else {
        window.location.reload();
      }
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : 'Sign out failed.');
      setSubmitting(false);
    }
  };

  if (state.status === 'authenticated') {
    return (
      <HostedAuthRevalidationContext.Provider
        key={state.epoch}
        value={{ availability, revalidate }}
      >
        {children}
        <aside
          aria-label="Hosted account"
          className="fixed bottom-4 right-4 z-50 max-w-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 shadow-xl"
        >
          <p className="truncate text-sm font-medium">{state.auth.principal?.displayName}</p>
          <p className="mb-2 text-xs capitalize text-[var(--color-text-muted)]">
            {state.auth.principal?.role}
          </p>
          {accountError && (
            <p role="alert" className="mb-2 text-xs text-red-400">
              {accountError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={submitting}
              onClick={() => void endSession('local')}
            >
              Sign out
            </Button>
            {state.auth.mode === 'personal' ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={() => void endSession('forget-device')}
              >
                Forget browser
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={() => void endSession('global')}
              >
                Sign out everywhere
              </Button>
            )}
          </div>
        </aside>
      </HostedAuthRevalidationContext.Provider>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-surface)] p-6 text-[var(--color-text)]">
      <section
        aria-busy={state.status === 'loading'}
        className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-7 shadow-xl"
      >
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
          Agent Teams hosted
        </p>
        <h1 className="mb-3 text-2xl font-semibold">Sign in to this deployment</h1>

        {state.status === 'loading' && (
          <p className="text-sm text-[var(--color-text-muted)]">Checking your session…</p>
        )}

        {state.status === 'unavailable' && (
          <>
            <p role="alert" className="mb-5 text-sm text-red-400">
              Authentication is unavailable: {state.error}
            </p>
            <Button type="button" onClick={() => void load()}>
              Try again
            </Button>
          </>
        )}

        {state.status === 'anonymous' && state.auth.mode === 'oidc' && (
          <>
            <p className="mb-5 text-sm text-[var(--color-text-muted)]">
              Continue with {state.auth.oidcProviderName ?? 'your identity provider'}. If it is
              offline, Agent Teams will not fall back to personal pairing.
            </p>
            {state.error && (
              <p role="alert" className="mb-4 text-sm text-red-400">
                {state.error}
              </p>
            )}
            <Button
              type="button"
              className="w-full"
              onClick={() => window.location.assign(HOSTED_AUTH_ROUTES.login)}
            >
              Continue to sign in
            </Button>
          </>
        )}

        {state.status === 'anonymous' && state.auth.mode === 'personal' && (
          <form onSubmit={(event) => void pair(event)}>
            <p className="mb-5 text-sm text-[var(--color-text-muted)]">
              Retrieve the one-time pairing code from the local Docker host. The code expires after
              ten minutes and is never stored by this browser.
            </p>
            {state.auth.runtimeIsolation === HOSTED_RUNTIME_ISOLATION && (
              <p
                role="note"
                className="mb-5 rounded-md border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-sm text-amber-100"
              >
                Agents run directly on the host with the permissions of the Owner&apos;s OS user.
                They are not sandboxed, so pair only a browser you control.
              </p>
            )}
            <Label htmlFor="hosted-pairing-code">Pairing code</Label>
            <Input
              id="hosted-pairing-code"
              className="mt-2"
              type="password"
              autoComplete="one-time-code"
              spellCheck={false}
              value={pairingCode}
              onChange={(event) => setPairingCode(event.target.value)}
              required
              minLength={32}
              disabled={submitting}
            />
            {state.error && (
              <p role="alert" className="mt-3 text-sm text-red-400">
                {state.error}
              </p>
            )}
            <Button type="submit" className="mt-5 w-full" disabled={submitting}>
              {submitting ? 'Pairing…' : 'Pair this browser'}
            </Button>
          </form>
        )}
      </section>
    </main>
  );
};
