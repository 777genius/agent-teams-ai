import {
  type CodexAppServerAccountLoginCompletedNotification,
  type CodexAppServerCancelLoginAccountResponse,
  type CodexAppServerLoginAccountResponse,
  type CodexAppServerSession,
} from '@main/services/infrastructure/codexAppServer';
import { shell } from 'electron';

import type { CodexLoginStateDto } from '@features/codex-account/contracts';
import type { CodexAppServerSessionFactory } from '@main/services/infrastructure/codexAppServer';

const LOGIN_REQUEST_TIMEOUT_MS = 5_000;
const INITIALIZE_TIMEOUT_MS = 6_000;
const LOGIN_PENDING_TIMEOUT_MS = 10 * 60 * 1_000;

type CodexLoginStateListener = (state: CodexLoginStateDto) => void;
type CodexLoginSettledListener = () => void;
interface CodexLoginLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export class CodexLoginSessionManager {
  private readonly listeners = new Set<CodexLoginStateListener>();
  private readonly settledListeners = new Set<CodexLoginSettledListener>();
  private state: CodexLoginStateDto = {
    status: 'idle',
    error: null,
    startedAt: null,
  };
  private pendingStartToken: symbol | null = null;
  private activeSession: {
    session: CodexAppServerSession;
    loginId: string;
    disposeNotificationListener: () => void;
    timeoutId: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(
    private readonly sessionFactory: CodexAppServerSessionFactory,
    private readonly logger: CodexLoginLogger
  ) {}

  subscribe(listener: CodexLoginStateListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  onSettled(listener: CodexLoginSettledListener): () => void {
    this.settledListeners.add(listener);
    return (): void => {
      this.settledListeners.delete(listener);
    };
  }

  getState(): CodexLoginStateDto {
    return structuredClone(this.state);
  }

  async start(options: { binaryPath: string; env: NodeJS.ProcessEnv }): Promise<void> {
    if (this.activeSession || this.pendingStartToken) {
      return;
    }

    const startToken = Symbol('codex-login-start');
    this.pendingStartToken = startToken;
    let session: CodexAppServerSession | null = null;

    this.setState({
      status: 'starting',
      error: null,
      startedAt: new Date().toISOString(),
    });

    try {
      session = await this.sessionFactory.openSession({
        binaryPath: options.binaryPath,
        env: options.env,
        requestTimeoutMs: LOGIN_REQUEST_TIMEOUT_MS,
        initializeTimeoutMs: INITIALIZE_TIMEOUT_MS,
      });

      if (this.pendingStartToken !== startToken) {
        await session.close().catch(() => undefined);
        return;
      }

      const response = await session.request<CodexAppServerLoginAccountResponse>(
        'account/login/start',
        { type: 'chatgpt' },
        LOGIN_REQUEST_TIMEOUT_MS
      );

      if (this.pendingStartToken !== startToken) {
        await session.close().catch(() => undefined);
        return;
      }

      if (response.type !== 'chatgpt') {
        throw new Error('Codex app-server returned an unexpected login response type');
      }

      const authUrl = new URL(response.authUrl);
      if (authUrl.protocol !== 'https:') {
        throw new Error('Codex app-server returned a non-https auth URL');
      }

      const disposeNotificationListener = session.onNotification((method, params) => {
        if (method !== 'account/login/completed') {
          return;
        }

        const notification = params as CodexAppServerAccountLoginCompletedNotification;
        if (notification.loginId && notification.loginId !== response.loginId) {
          return;
        }

        void this.handleCompletion(notification);
      });

      const timeoutId = setTimeout(() => {
        void this.failActiveLogin('Timed out while waiting for ChatGPT account login to finish.');
      }, LOGIN_PENDING_TIMEOUT_MS);

      this.activeSession = {
        session,
        loginId: response.loginId,
        disposeNotificationListener,
        timeoutId,
      };
      this.pendingStartToken = null;

      this.setState({
        status: 'pending',
        error: null,
        startedAt: this.state.startedAt,
      });

      await shell.openExternal(authUrl.toString());
    } catch (error) {
      const wasAbandonedDuringStart =
        this.pendingStartToken !== startToken &&
        !this.activeSession &&
        (this.state.status === 'cancelled' || this.state.status === 'idle');

      if (this.pendingStartToken === startToken) {
        this.pendingStartToken = null;
      }
      await session?.close().catch(() => undefined);
      if (session && this.activeSession?.session === session) {
        this.activeSession = null;
      }
      if (wasAbandonedDuringStart) {
        return;
      }
      this.setState({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        startedAt: this.state.startedAt,
      });
      throw error;
    }
  }

  async cancel(): Promise<void> {
    if (this.pendingStartToken && !this.activeSession) {
      this.pendingStartToken = null;
      this.setState({
        status: 'cancelled',
        error: null,
        startedAt: null,
      });
      this.emitSettled();
      return;
    }

    if (!this.activeSession) {
      this.setState({
        status: 'cancelled',
        error: null,
        startedAt: null,
      });
      return;
    }

    const activeSession = this.activeSession;
    this.activeSession = null;
    clearTimeout(activeSession.timeoutId);
    activeSession.disposeNotificationListener();

    try {
      await activeSession.session.request<CodexAppServerCancelLoginAccountResponse>(
        'account/login/cancel',
        { loginId: activeSession.loginId },
        LOGIN_REQUEST_TIMEOUT_MS
      );
    } catch (error) {
      this.logger.warn('codex login cancel failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await activeSession.session.close().catch(() => undefined);
    }

    this.setState({
      status: 'cancelled',
      error: null,
      startedAt: null,
    });
    this.emitSettled();
  }

  async dispose(): Promise<void> {
    if (this.pendingStartToken) {
      this.pendingStartToken = null;
    }

    if (!this.activeSession) {
      this.setState({
        status: 'idle',
        error: null,
        startedAt: null,
      });
      return;
    }

    const activeSession = this.activeSession;
    this.activeSession = null;
    clearTimeout(activeSession.timeoutId);
    activeSession.disposeNotificationListener();
    await activeSession.session.close().catch(() => undefined);
    this.setState({
      status: 'idle',
      error: null,
      startedAt: null,
    });
  }

  private async handleCompletion(
    notification: CodexAppServerAccountLoginCompletedNotification
  ): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    const activeSession = this.activeSession;
    this.activeSession = null;
    clearTimeout(activeSession.timeoutId);
    activeSession.disposeNotificationListener();
    await activeSession.session.close().catch(() => undefined);

    if (notification.success) {
      this.setState({
        status: 'idle',
        error: null,
        startedAt: null,
      });
    } else {
      this.setState({
        status: 'failed',
        error: notification.error ?? 'ChatGPT login failed.',
        startedAt: this.state.startedAt,
      });
    }

    this.emitSettled();
  }

  private async failActiveLogin(errorMessage: string): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    const activeSession = this.activeSession;
    this.activeSession = null;
    clearTimeout(activeSession.timeoutId);
    activeSession.disposeNotificationListener();
    await activeSession.session.close().catch(() => undefined);
    this.setState({
      status: 'failed',
      error: errorMessage,
      startedAt: this.state.startedAt,
    });
    this.emitSettled();
  }

  private emitSettled(): void {
    for (const listener of this.settledListeners) {
      listener();
    }
  }

  private setState(nextState: CodexLoginStateDto): void {
    this.state = structuredClone(nextState);
    for (const listener of this.listeners) {
      listener(this.getState());
    }
  }
}
