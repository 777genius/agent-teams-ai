import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';

import { HOSTED_AUTH_HEADERS, HOSTED_AUTH_ROUTES, type HostedAuthStatus } from '../contracts';

import { setHostedCsrfToken } from './csrfMemory';

interface HostedAuthGateProps {
  readonly children: ReactNode;
  readonly onAuthenticated?: () => void;
}

type GateState =
  | { readonly status: 'loading' }
  | { readonly status: 'anonymous'; readonly auth: HostedAuthStatus; readonly error: string | null }
  | { readonly status: 'authenticated'; readonly auth: HostedAuthStatus }
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

export const HostedAuthGate = ({ children, onAuthenticated }: HostedAuthGateProps) => {
  const [state, setState] = useState<GateState>({ status: 'loading' });
  const [pairingCode, setPairingCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);

  const acceptAuthenticated = useCallback(
    (auth: HostedAuthStatus) => {
      setHostedCsrfToken(auth.csrfToken);
      onAuthenticated?.();
      setState({ status: 'authenticated', auth });
    },
    [onAuthenticated]
  );

  const load = useCallback(async () => {
    try {
      const response = await fetch(HOSTED_AUTH_ROUTES.status, {
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      const auth = await readJson<HostedAuthStatus>(response);
      if (auth.authenticated) {
        acceptAuthenticated(auth);
      } else {
        setHostedCsrfToken(null);
        setState({ status: 'anonymous', auth, error: null });
      }
    } catch (error) {
      setHostedCsrfToken(null);
      setState({
        status: 'unavailable',
        error: error instanceof Error ? error.message : 'Authentication is unavailable.',
      });
    }
  }, [acceptAuthenticated]);

  useEffect(() => {
    void load();
    return () => setHostedCsrfToken(null);
  }, [load]);

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
      <>
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
      </>
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
