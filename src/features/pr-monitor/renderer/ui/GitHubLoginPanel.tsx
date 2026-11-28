import { Button } from '@renderer/components/ui/button';

import type { DeviceLogin, MonitorError } from '../../contracts';

export function GitHubLoginPanel(props: {
  login: DeviceLogin | null;
  error: MonitorError | null;
  busy: boolean;
  onCancel(): void;
  onOpenUrl(url: string): void;
}): React.JSX.Element | null {
  if (!props.login && !props.error) return null;
  return (
    <section aria-label="GitHub sign-in" className="rounded-lg border border-border p-5">
      {props.error && (
        <p role="alert" className="text-sm">
          {props.error.message}
        </p>
      )}
      {props.login && (
        <>
          <h2 className="mb-2 font-medium">Finish signing in on GitHub</h2>
          <p className="mb-3 text-sm">
            Enter this code on GitHub. Return here after approving access.
          </p>
          <p
            aria-label="GitHub verification code"
            className="mb-4 select-all font-mono text-xl tracking-wider"
          >
            {props.login.userCode}
          </p>
          <div className="flex gap-2">
            <Button onClick={() => props.onOpenUrl(props.login!.verificationUri)}>
              Open GitHub sign-in
            </Button>
            <Button variant="outline" onClick={props.onCancel}>
              Cancel sign-in
            </Button>
          </div>
          <p role="status" className="mt-3 text-sm text-text-secondary">
            Waiting for GitHub approval. Code expires at{' '}
            {new Date(props.login.expiresAt).toLocaleTimeString()}.
          </p>
        </>
      )}
    </section>
  );
}
