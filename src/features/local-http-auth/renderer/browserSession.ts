export type AccessState = 'required' | 'checking' | 'ready' | 'expired';

export class BrowserAccessSession {
  private key: string | null = null;
  private revision = 0;
  private pending: Promise<void> | null = null;
  private state: AccessState = 'required';
  private readonly subscribers = new Set<() => void>();
  readonly browserOrigin: string;

  constructor(readonly baseUrl: string) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== baseUrl) {
      throw new Error('Expected an HTTP API origin');
    }
    this.browserOrigin = typeof location === 'undefined' ? baseUrl : location.origin;
  }

  getSnapshot = (): AccessState => this.state;
  subscribe = (callback: () => void): (() => void) => {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  };
  private notify(): void {
    this.subscribers.forEach((callback) => callback());
  }

  /** Explicit entry verifies the key before mounting data effects or opening SSE. */
  enterKey(key: string): Promise<void> {
    if (!/^\S{32,512}$/.test(key.trim())) throw new Error('Enter a valid API access key');
    const candidate = key.trim();
    const revision = ++this.revision;
    this.key = null;
    this.state = 'checking';
    this.notify();
    const check = async (): Promise<void> => {
      try {
        const response = await fetch(`${this.baseUrl}/api/auth/ready`, {
          headers: { Authorization: `Bearer ${candidate}` },
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.timeout(10_000),
        });
        if (revision !== this.revision) {
          await response.body?.cancel();
          return;
        }
        if (!response.ok) {
          this.state = response.status === 401 ? 'expired' : 'required';
          await response.body?.cancel();
          throw new Error(
            response.status === 401 ? 'Access key expired or invalid' : 'API unavailable'
          );
        }
        const ready = (await response.json()) as { ready?: unknown; service?: unknown };
        if (revision !== this.revision) return;
        if (ready.ready !== true || ready.service !== 'api')
          throw new Error('Invalid API readiness');
        this.key = candidate;
        this.state = 'ready';
      } catch (error) {
        if (revision === this.revision && this.state === 'checking') this.state = 'required';
        throw error;
      } finally {
        if (revision === this.revision) this.notify();
      }
    };
    this.pending = check();
    return this.pending;
  }

  clear(): void {
    ++this.revision;
    this.key = null;
    this.pending = null;
    this.state = 'required';
    this.notify();
  }

  async fetch(pathname: string, options: RequestInit = {}): Promise<Response> {
    if (this.state === 'checking') await this.pending;
    const key = this.key,
      revision = this.revision;
    if (!key || this.state !== 'ready') throw new Error('API access key required');
    const target = new URL(pathname, this.baseUrl);
    if (
      !pathname.startsWith('/api/') ||
      target.origin !== this.baseUrl ||
      (typeof location !== 'undefined' && location.origin !== this.browserOrigin)
    )
      throw new Error('Foreign API target');
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${key}`);
    const response = await fetch(target.href, {
      ...options,
      headers,
      redirect: 'error',
      credentials: 'omit',
    });
    if (response.status === 401 && this.revision === revision) {
      this.key = null;
      this.state = 'expired';
      this.notify();
    }
    return response;
  }
}

const sessions = new Map<string, BrowserAccessSession>();
export function getBrowserAccessSession(baseUrl: string): BrowserAccessSession {
  const scope = `${typeof location === 'undefined' ? baseUrl : location.origin}|${baseUrl}`;
  let session = sessions.get(scope);
  if (!session) {
    session = new BrowserAccessSession(baseUrl);
    sessions.set(scope, session);
  }
  return session;
}
