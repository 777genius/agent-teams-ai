import {
  CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
  type CodexAppServerGetAccountParams,
  type CodexAppServerGetAccountRateLimitsResponse,
  type CodexAppServerGetAccountResponse,
  type CodexAppServerLogoutAccountResponse,
  type CodexAppServerSessionFactory,
} from '@main/services/infrastructure/codexAppServer';

const ACCOUNT_READ_TIMEOUT_MS = 5_000;
const ACCOUNT_RATE_LIMITS_TIMEOUT_MS = 8_000;
const ACCOUNT_LOGOUT_TIMEOUT_MS = 5_000;
const SESSION_OVERHEAD_TIMEOUT_MS = 1_500;
const ACCOUNT_TOTAL_TIMEOUT_MS =
  CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS + ACCOUNT_READ_TIMEOUT_MS + SESSION_OVERHEAD_TIMEOUT_MS;
const RATE_LIMITS_TOTAL_TIMEOUT_MS =
  CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS +
  ACCOUNT_RATE_LIMITS_TIMEOUT_MS +
  SESSION_OVERHEAD_TIMEOUT_MS;
const TOTAL_WITH_RATE_LIMITS_TIMEOUT_MS = ACCOUNT_TOTAL_TIMEOUT_MS + ACCOUNT_RATE_LIMITS_TIMEOUT_MS;

type CodexAccountRateLimitsReadResult =
  | { ok: true; payload: CodexAppServerGetAccountRateLimitsResponse }
  | { ok: false; error: unknown };

export class CodexAccountAppServerClient {
  constructor(private readonly sessionFactory: CodexAppServerSessionFactory) {}

  async readAccountSnapshot(options: {
    binaryPath: string;
    env: NodeJS.ProcessEnv;
    refreshToken?: boolean;
    includeRateLimits?: boolean;
  }): Promise<{
    account: CodexAppServerGetAccountResponse;
    rateLimits: CodexAccountRateLimitsReadResult | null;
    initialize: { codexHome: string; platformFamily: string; platformOs: string };
  }> {
    const includeRateLimits = options.includeRateLimits === true;

    return this.sessionFactory.withSession(
      {
        binaryPath: options.binaryPath,
        env: options.env,
        requestTimeoutMs: includeRateLimits
          ? ACCOUNT_RATE_LIMITS_TIMEOUT_MS
          : ACCOUNT_READ_TIMEOUT_MS,
        initializeTimeoutMs: CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
        totalTimeoutMs: includeRateLimits
          ? TOTAL_WITH_RATE_LIMITS_TIMEOUT_MS
          : ACCOUNT_TOTAL_TIMEOUT_MS,
        label: includeRateLimits
          ? 'codex app-server account/read with rateLimits/read'
          : 'codex app-server account/read',
      },
      async (session) => {
        const account = await session.request<CodexAppServerGetAccountResponse>(
          'account/read',
          {
            refreshToken: options.refreshToken ?? false,
          } satisfies CodexAppServerGetAccountParams,
          ACCOUNT_READ_TIMEOUT_MS
        );

        let rateLimits: CodexAccountRateLimitsReadResult | null = null;
        if (includeRateLimits) {
          try {
            rateLimits = {
              ok: true,
              payload: await session.request<CodexAppServerGetAccountRateLimitsResponse>(
                'account/rateLimits/read',
                undefined,
                ACCOUNT_RATE_LIMITS_TIMEOUT_MS
              ),
            };
          } catch (error) {
            rateLimits = { ok: false, error };
          }
        }

        return {
          account,
          rateLimits,
          initialize: {
            codexHome: session.initializeResponse.codexHome,
            platformFamily: session.initializeResponse.platformFamily,
            platformOs: session.initializeResponse.platformOs,
          },
        };
      }
    );
  }

  async readAccount(options: {
    binaryPath: string;
    env: NodeJS.ProcessEnv;
    refreshToken?: boolean;
  }): Promise<{
    account: CodexAppServerGetAccountResponse;
    initialize: { codexHome: string; platformFamily: string; platformOs: string };
  }> {
    const result = await this.readAccountSnapshot(options);
    return {
      account: result.account,
      initialize: result.initialize,
    };
  }

  async readRateLimits(options: {
    binaryPath: string;
    env: NodeJS.ProcessEnv;
  }): Promise<CodexAppServerGetAccountRateLimitsResponse> {
    return this.sessionFactory.withSession(
      {
        binaryPath: options.binaryPath,
        env: options.env,
        requestTimeoutMs: ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
        initializeTimeoutMs: CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
        totalTimeoutMs: RATE_LIMITS_TOTAL_TIMEOUT_MS,
        label: 'codex app-server account/rateLimits/read',
      },
      async (session) =>
        session.request<CodexAppServerGetAccountRateLimitsResponse>(
          'account/rateLimits/read',
          undefined,
          ACCOUNT_RATE_LIMITS_TIMEOUT_MS
        )
    );
  }

  async logout(options: {
    binaryPath: string;
    env: NodeJS.ProcessEnv;
  }): Promise<CodexAppServerLogoutAccountResponse> {
    return this.sessionFactory.withSession(
      {
        binaryPath: options.binaryPath,
        env: options.env,
        requestTimeoutMs: ACCOUNT_LOGOUT_TIMEOUT_MS,
        initializeTimeoutMs: CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
        totalTimeoutMs: ACCOUNT_TOTAL_TIMEOUT_MS,
        label: 'codex app-server account/logout',
      },
      async (session) =>
        session.request<CodexAppServerLogoutAccountResponse>(
          'account/logout',
          undefined,
          ACCOUNT_LOGOUT_TIMEOUT_MS
        )
    );
  }
}
