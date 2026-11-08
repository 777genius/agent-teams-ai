import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';

import type { BrowserAccessSession } from '../browserSession';

export const BrowserAccessGate = ({
  session,
  children,
}: {
  session: BrowserAccessSession;
  children: ReactNode;
}) => {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (state !== 'ready') {
      window.__claudeTeamsSplashScene?.stop();
      document.getElementById('splash')?.remove();
    }
  }, [state]);
  if (state === 'ready') return children;
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-surface)] text-[var(--color-text)]">
      <form
        className="w-80 space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await session.enterKey(key);
            setKey('');
            setError('');
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Invalid access key');
          }
        }}
      >
        <h1 className="text-lg font-semibold">API access key</h1>
        <p>Enter the access key supplied by the application owner.</p>
        {state === 'expired' && (
          <p role="alert">Access key expired or invalid. Enter the current key.</p>
        )}
        <label htmlFor="api-access-key">Access key</label>
        <Input
          id="api-access-key"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        {error && <p role="alert">{error}</p>}
        <Button type="submit" disabled={state === 'checking'}>
          {state === 'checking' ? 'Checking…' : 'Connect'}
        </Button>
      </form>
    </main>
  );
};
