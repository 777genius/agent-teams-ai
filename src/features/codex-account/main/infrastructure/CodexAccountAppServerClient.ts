import {
  type CodexAppServerGetAccountParams,
  type CodexAppServerGetAccountRateLimitsResponse,
  type CodexAppServerGetAccountResponse,
  type CodexAppServerLogoutAccountResponse,
} from '@main/services/infrastructure/codexAppServer';

import type { CodexAppServerSessionFactory } from '@main/services/infrastructure/codexAppServer';

const ACCOUNT_READ_TIMEOUT_MS = 3_500;
const ACCOUNT_RATE_LIMITS_TIMEOUT_MS = 4_500;
const ACCOUNT_LOGOUT_TIMEOUT_MS = 3_500;
const INITIALIZE_TIMEOUT_MS = 6_000;
const TOTAL_TIMEOUT_MS = 9_000;

export class CodexAccountAppServerClient {
  constructor(private readonly sessionFactory: CodexAppServerSessionFactory) {}

  async readAccount(options: {
    binaryPath: string;
    env: NodeJS.ProcessEnv;
    refreshToken?: boolean;
  }): Promise<{
    account: CodexAppServerGetAccountResponse;
    initialize: { codexHome: string; platformFamily: string; platformOs: string };
  }> {
    return this.sessionFactory.withSession(
      {
        binaryPath: options.binaryPath,
        env: options.env,
        requestTimeoutMs: ACCOUNT_READ_TIMEOUT_MS,
        initializeTimeoutMs: INITIALIZE_TIMEOUT_MS,
        totalTimeoutMs: TOTAL_TIMEOUT_MS,
        label: 'codex app-server account/read',
      },
      async (session) => {
        const account = await session.request<CodexAppServerGetAccountResponse>(
          'account/read',
          {
            refreshToken: options.refreshToken ?? false,
          } satisfies CodexAppServerGetAccountParams,
          ACCOUNT_READ_TIMEOUT_MS
        );

        return {
          account,
          initialize: {
            codexHome: session.initializeResponse.codexHome,
            platformFamily: session.initializeResponse.platformFamily,
            platformOs: session.initializeResponse.platformOs,
          },
        };
      }
    );
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
        initializeTimeoutMs: INITIALIZE_TIMEOUT_MS,
        totalTimeoutMs: TOTAL_TIMEOUT_MS,
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
        initializeTimeoutMs: INITIALIZE_TIMEOUT_MS,
        totalTimeoutMs: TOTAL_TIMEOUT_MS,
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
