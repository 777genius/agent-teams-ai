import type {
  CodexAppServerListModelsParams,
  CodexAppServerListModelsResponse,
  CodexAppServerReadConfigParams,
  CodexAppServerReadConfigResponse,
  CodexAppServerSession,
  CodexAppServerSessionFactory,
} from '@main/services/infrastructure/codexAppServer';

const MODEL_LIST_PAGE_LIMIT = 100;
const MODEL_LIST_MAX_PAGES = 5;
const MODEL_LIST_TIMEOUT_MS = 4_500;
const CONFIG_READ_TIMEOUT_MS = 3_500;
const INITIALIZE_TIMEOUT_MS = 6_000;
const TOTAL_TIMEOUT_MS = 9_000;

export class CodexModelCatalogAppServerClient {
  constructor(private readonly sessionFactory: CodexAppServerSessionFactory) {}

  async readModelCatalogWithConfig(options: {
    binaryPath: string;
    env: NodeJS.ProcessEnv;
    includeHidden?: boolean;
    cwd?: string | null;
    profile?: string | null;
  }): Promise<{
    modelCatalog: CodexAppServerListModelsResponse;
    config: { ok: true; value: CodexAppServerReadConfigResponse } | { ok: false; error: unknown };
  }> {
    const configParams = this.buildConfigReadParams(options);

    return this.sessionFactory.withSession(
      {
        binaryPath: options.binaryPath,
        env: options.env,
        requestTimeoutMs: MODEL_LIST_TIMEOUT_MS,
        initializeTimeoutMs: INITIALIZE_TIMEOUT_MS,
        totalTimeoutMs: TOTAL_TIMEOUT_MS,
        label: 'codex app-server model/list with config/read',
        experimentalApi: false,
      },
      async (session) => {
        const configPromise = session
          .request<CodexAppServerReadConfigResponse>(
            'config/read',
            configParams,
            CONFIG_READ_TIMEOUT_MS
          )
          .then((value) => ({ ok: true as const, value }))
          .catch((error: unknown) => ({ ok: false as const, error }));
        const modelCatalogPromise = this.readModelCatalogPages(session, {
          includeHidden: options.includeHidden,
        });
        const [config, modelCatalog] = await Promise.all([configPromise, modelCatalogPromise]);
        return {
          config,
          modelCatalog,
        };
      }
    );
  }

  async readModelCatalog(options: {
    binaryPath: string;
    env: NodeJS.ProcessEnv;
    includeHidden?: boolean;
  }): Promise<CodexAppServerListModelsResponse> {
    return this.sessionFactory.withSession(
      {
        binaryPath: options.binaryPath,
        env: options.env,
        requestTimeoutMs: MODEL_LIST_TIMEOUT_MS,
        initializeTimeoutMs: INITIALIZE_TIMEOUT_MS,
        totalTimeoutMs: TOTAL_TIMEOUT_MS,
        label: 'codex app-server model/list',
        experimentalApi: false,
      },
      async (session) =>
        this.readModelCatalogPages(session, {
          includeHidden: options.includeHidden,
        })
    );
  }

  async readConfig(options: {
    binaryPath: string;
    env: NodeJS.ProcessEnv;
    cwd?: string | null;
    profile?: string | null;
  }): Promise<CodexAppServerReadConfigResponse> {
    const params = this.buildConfigReadParams(options);

    return this.sessionFactory.withSession(
      {
        binaryPath: options.binaryPath,
        env: options.env,
        requestTimeoutMs: CONFIG_READ_TIMEOUT_MS,
        initializeTimeoutMs: INITIALIZE_TIMEOUT_MS,
        totalTimeoutMs: TOTAL_TIMEOUT_MS,
        label: 'codex app-server config/read',
        experimentalApi: false,
      },
      async (session) =>
        session.request<CodexAppServerReadConfigResponse>(
          'config/read',
          params,
          CONFIG_READ_TIMEOUT_MS
        )
    );
  }

  private buildConfigReadParams(options: {
    cwd?: string | null;
    profile?: string | null;
  }): CodexAppServerReadConfigParams {
    const params: CodexAppServerReadConfigParams = {};
    if (options.cwd?.trim()) {
      params.cwd = options.cwd.trim();
    }
    if (options.profile?.trim()) {
      params.profile = options.profile.trim();
    }
    return params;
  }

  private async readModelCatalogPages(
    session: CodexAppServerSession,
    options: { includeHidden?: boolean }
  ): Promise<CodexAppServerListModelsResponse> {
    const data: NonNullable<CodexAppServerListModelsResponse['data']> = [];
    let cursor: string | null = null;
    let nextCursor: string | null = null;

    for (let page = 0; page < MODEL_LIST_MAX_PAGES; page += 1) {
      const payload: CodexAppServerListModelsResponse =
        await session.request<CodexAppServerListModelsResponse>(
          'model/list',
          {
            cursor,
            limit: MODEL_LIST_PAGE_LIMIT,
            includeHidden: options.includeHidden === true,
          } satisfies CodexAppServerListModelsParams,
          MODEL_LIST_TIMEOUT_MS
        );
      data.push(...(payload.data ?? payload.models ?? []));
      nextCursor = payload.nextCursor ?? null;
      if (!nextCursor) {
        break;
      }
      cursor = nextCursor;
    }

    return {
      data,
      nextCursor,
      truncated: nextCursor !== null,
    };
  }
}
