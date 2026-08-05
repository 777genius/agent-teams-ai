import {
  HOSTED_MEMBER_LOG_MAX_PAGE_BYTES,
  HOSTED_MEMBER_LOG_MAX_PAGE_TIME_MS,
  HOSTED_MEMBER_LOG_PAGE_HTTP_PATH,
  HOSTED_MEMBER_LOG_SCHEMA_VERSION,
  type HostedMemberLogEntry,
  hostedMemberLogEntryByteLength,
  type HostedMemberLogPage,
  hostedMemberLogPageByteLength,
  parseHostedMemberLogEntryId,
  parseHostedMemberLogSelectionId,
  parseHostedMemberLogSourceGeneration,
} from '@features/member-log-stream/contracts/hosted';
import {
  createHostedMemberLogFeature,
  createHostedMemberLogRouteContribution,
  HOSTED_MEMBER_LOG_PAGE_ROUTE,
  HOSTED_MEMBER_LOG_ROUTE_DESCRIPTORS,
  type HostedMemberLogAuthorityPort,
  type HostedMemberLogHttpFacade,
  registerHostedMemberLogHttp,
} from '@features/member-log-stream/main/hosted';
import { createRouteCatalog } from '@main/composition/hosted/routing';
import {
  createQueryContext,
  parseCursor,
  parseMemberId,
  parseRevision,
  parseTeamId,
} from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const memberId = parseMemberId(`member_${'b'.repeat(32)}`);
const revision = parseRevision('revision_member-log-http');
const sourceGeneration = parseHostedMemberLogSourceGeneration('generation_member-log-http');
const selectionId = parseHostedMemberLogSelectionId(`member_log_selection_${'c'.repeat(32)}`);
const otherSelectionId = parseHostedMemberLogSelectionId(`member_log_selection_${'d'.repeat(32)}`);

function context(signal: AbortSignal) {
  return createQueryContext({
    actorId: 'actor_member-log-http',
    sessionId: 'session_member-log-http',
    deploymentId: 'deployment_member-log-http',
    bootId: 'boot_member-log-http',
    requestId: 'request_member-log-http',
    authorizedScope: 'scope_member-log-http',
    deadlineAtMs: 10_000,
    signal,
  });
}

function entry(index: number, text = `member log ${index}`): HostedMemberLogEntry {
  return {
    teamId,
    memberId,
    entryId: parseHostedMemberLogEntryId(`member_log_${index.toString(16).padStart(32, '0')}`),
    level: 'info',
    occurredAtMs: index,
    text,
  };
}

function page(
  entries: readonly HostedMemberLogEntry[] = [],
  options: {
    readonly pageSelectionId?: typeof selectionId;
    readonly nextCursor?: ReturnType<typeof parseCursor> | null;
    readonly itemLimit?: number;
  } = {}
): HostedMemberLogPage {
  const nextCursor = options.nextCursor ?? null;
  const truncationReasons = nextCursor === null ? [] : ['source_budget' as const];
  let usedBytes = 0;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate: HostedMemberLogPage = {
      schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
      kind: 'member_log_page',
      selectionId: options.pageSelectionId ?? selectionId,
      teamId,
      memberId,
      sourceGeneration,
      revision,
      entries,
      nextCursor,
      truncated: nextCursor !== null,
      truncationReasons,
      budget: {
        itemLimit: options.itemLimit ?? 25,
        byteLimit: HOSTED_MEMBER_LOG_MAX_PAGE_BYTES,
        timeLimitMs: HOSTED_MEMBER_LOG_MAX_PAGE_TIME_MS,
        usedItems: entries.length,
        usedBytes,
        elapsedMs: 1,
      },
    };
    const measured = hostedMemberLogPageByteLength(candidate);
    if (measured === usedBytes) return candidate;
    usedBytes = measured;
  }
  throw new Error('member-log-test-page-byte-budget-did-not-converge');
}

function facade(): HostedMemberLogHttpFacade {
  return { getPage: vi.fn(async () => ({ kind: 'success' as const, page: page() })) };
}

async function createApp(feature: HostedMemberLogHttpFacade = facade()) {
  const app = Fastify();
  const createContext = vi.fn((_request, signal: AbortSignal) => context(signal));
  registerHostedMemberLogHttp(app, feature, createContext);
  await app.ready();
  return { app, createContext, feature };
}

function request() {
  return {
    schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
    selectionId,
    cursor: null,
    expectedSourceGeneration: null,
    limit: 25,
  };
}

function found(
  candidates: readonly {
    readonly entry: HostedMemberLogEntry;
    readonly cursorAfter: ReturnType<typeof parseCursor>;
  }[]
) {
  return {
    kind: 'found' as const,
    selectionId,
    teamId,
    memberId,
    sourceGeneration,
    revision,
    candidates,
    hasMore: false,
  };
}

describe('hosted member-log HTTP', () => {
  it('declares one deferred authenticated browser-read contribution', () => {
    const catalog = createRouteCatalog(HOSTED_MEMBER_LOG_ROUTE_DESCRIPTORS, 'production');
    const feature = createHostedMemberLogFeature({
      authority: {
        readPage: vi.fn(async () => found([])),
      },
      clock: { now: () => 1 },
    });
    const contribution = createHostedMemberLogRouteContribution(feature);

    expect(catalog.routes).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: HOSTED_MEMBER_LOG_PAGE_HTTP_PATH,
        owner: 'member-log-stream',
        trustKind: 'browser',
        readiness: ['serve', 'auth', 'read'],
        testOnly: false,
      }),
    ]);
    expect(HOSTED_MEMBER_LOG_PAGE_ROUTE).toBe(HOSTED_MEMBER_LOG_PAGE_HTTP_PATH);
    expect(contribution).toMatchObject({ id: 'member-log-stream.hosted.v1', facade: feature });
    expect(Object.isFrozen(contribution)).toBe(true);
  });

  it('serves one no-store page through the injected authenticated context', async () => {
    const { app, createContext, feature } = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_MEMBER_LOG_PAGE_ROUTE,
        payload: request(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual(page());
      expect(feature.getPage).toHaveBeenCalledWith(request(), expect.any(Object));
      expect(createContext).toHaveBeenCalledWith(expect.any(Object), expect.any(AbortSignal));
    } finally {
      await app.close();
    }
  });

  it('rejects caller-provided workspace and member authority before the trusted authority runs', async () => {
    const readPage = vi.fn<HostedMemberLogAuthorityPort['readPage']>(async () => found([]));
    const feature = createHostedMemberLogFeature({
      authority: { readPage },
      clock: { now: () => 1 },
    });
    const { app } = await createApp(feature);
    try {
      const forged = await app.inject({
        method: 'POST',
        url: HOSTED_MEMBER_LOG_PAGE_ROUTE,
        payload: { ...request(), teamId, memberId },
      });
      expect(forged.statusCode).toBe(400);
      expect(readPage).not.toHaveBeenCalled();

      const allowed = await app.inject({
        method: 'POST',
        url: HOSTED_MEMBER_LOG_PAGE_ROUTE,
        payload: request(),
      });
      expect(allowed.statusCode).toBe(200);
      expect(readPage).toHaveBeenCalledTimes(1);
      const authorityRequest = readPage.mock.calls[0]?.[0];
      expect(authorityRequest).toMatchObject({
        selectionId,
        cursor: null,
        expectedSourceGeneration: null,
        itemLimit: 26,
        byteLimit: HOSTED_MEMBER_LOG_MAX_PAGE_BYTES,
      });
      expect(authorityRequest).not.toHaveProperty('teamId');
      expect(authorityRequest).not.toHaveProperty('memberId');

      const denied = createHostedMemberLogFeature({
        authority: {
          readPage: vi.fn(async (authorityRequest) =>
            authorityRequest.selectionId === otherSelectionId
              ? found([])
              : Object.freeze({ kind: 'not_found' as const })
          ),
        },
        clock: { now: () => 1 },
      });
      const deniedApp = await createApp(denied);
      try {
        const response = await deniedApp.app.inject({
          method: 'POST',
          url: HOSTED_MEMBER_LOG_PAGE_ROUTE,
          payload: request(),
        });
        expect(response.statusCode).toBe(404);
      } finally {
        await deniedApp.app.close();
      }
    } finally {
      await app.close();
    }
  });

  it('redacts adversarial secrets and private user data before HTTP serialization', async () => {
    const secret = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
    const privateKeyMaterial = ['private', 'key', 'material'].join('-');
    const privateKey = [
      ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' '),
      privateKeyMaterial,
      ['-----END', 'PRIVATE', 'KEY-----'].join(' '),
    ].join('\n');
    const privatePath = ['', 'Users', 'alice', 'private', 'project'].join('/');
    const privateEmail = ['alice', 'example.test'].join('@');
    const feature = createHostedMemberLogFeature({
      authority: {
        readPage: vi.fn(async () =>
          found([
            {
              entry: entry(
                1,
                `Authorization: Bearer ${secret}; key=${privateKey}; path=${privatePath}; ${privateEmail}`
              ),
              cursorAfter: parseCursor('cursor_member-log-redacted'),
            },
          ])
        ),
      },
      clock: { now: () => 1 },
    });
    const { app } = await createApp(feature);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_MEMBER_LOG_PAGE_ROUTE,
        payload: request(),
      });
      const result = response.json() as HostedMemberLogPage;

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain(privateKeyMaterial);
      expect(response.body).not.toContain(privatePath);
      expect(response.body).not.toContain(privateEmail);
      expect(result.entries[0]?.text).toContain('[REDACTED]');
      expect(result.entries[0]?.text).toContain('[REDACTED_PATH]');
      expect(result.entries[0]?.text).toContain('[REDACTED_EMAIL]');
    } finally {
      await app.close();
    }
  });

  it('fails closed for cookie headers, connection URLs, and opaque credentials under unknown labels', async () => {
    const cookieValue = ['session', 'value', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
    const databasePassword = ['db', 'password', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
    const databaseUrl = `postgres://member:${databasePassword}@database.example.test/member-log`;
    const providerCredential = [
      'opaque',
      'credential',
      'abcdefghijklmnopqrstuvwxyz0123456789',
    ].join('_');
    const feature = createHostedMemberLogFeature({
      authority: {
        readPage: vi.fn(async () =>
          found([
            {
              entry: entry(1, `Cookie: ${cookieValue}; theme=dark`),
              cursorAfter: parseCursor('cursor_member-log-cookie'),
            },
            {
              entry: entry(2, `Set-Cookie=${cookieValue}; HttpOnly`),
              cursorAfter: parseCursor('cursor_member-log-set-cookie'),
            },
            {
              entry: entry(3, `DATABASE_URL=${databaseUrl}`),
              cursorAfter: parseCursor('cursor_member-log-database-url'),
            },
            {
              entry: entry(4, `opaqueEnvelope=${providerCredential}`),
              cursorAfter: parseCursor('cursor_member-log-provider-credential'),
            },
          ])
        ),
      },
      clock: { now: () => 1 },
    });
    const { app } = await createApp(feature);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_MEMBER_LOG_PAGE_ROUTE,
        payload: request(),
      });
      const result = response.json() as HostedMemberLogPage;

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(cookieValue);
      expect(response.body).not.toContain(databasePassword);
      expect(response.body).not.toContain(databaseUrl);
      expect(response.body).not.toContain(providerCredential);
      expect(result.entries).toHaveLength(4);
      expect(result.entries.every((item) => item.text.includes('[REDACTED]'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('redacts empty-user and subdelimiter credential URLs before HTTP serialization', async () => {
    const shortPassword = ['short', 'Password'].join('');
    const userinfoSubdelimiters = ['!', '$', '&', "'", '(', ')', '*', '+', ',', ';', '='].join('');
    const credentialUrls = [
      `redis://:${shortPassword}@cache.internal/0`,
      `redis://member${userinfoSubdelimiters}:${shortPassword}@cache.internal/0`,
      `redis://member:${userinfoSubdelimiters}${shortPassword}@cache.internal/0`,
    ];
    const publicUrls = ['redis://cache.internal/0', 'https://status.test/logs?view=public'];
    const feature = createHostedMemberLogFeature({
      authority: {
        readPage: vi.fn(async () =>
          found([
            ...credentialUrls.map((url, index) => ({
              entry: entry(index + 1, url),
              cursorAfter: parseCursor(`cursor_member-log-userinfo-${index}`),
            })),
            ...publicUrls.map((url, index) => ({
              entry: entry(credentialUrls.length + index + 1, url),
              cursorAfter: parseCursor(`cursor_member-log-public-${index}`),
            })),
          ])
        ),
      },
      clock: { now: () => 1 },
    });
    const { app } = await createApp(feature);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_MEMBER_LOG_PAGE_ROUTE,
        payload: request(),
      });
      const result = response.json() as HostedMemberLogPage;

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(shortPassword);
      expect(response.body).not.toContain(userinfoSubdelimiters);
      for (const credentialUrl of credentialUrls) {
        expect(response.body).not.toContain(credentialUrl);
      }
      expect(result.entries.slice(0, credentialUrls.length).map((item) => item.text)).toEqual(
        credentialUrls.map(() => '[REDACTED]')
      );
      expect(result.entries.slice(credentialUrls.length).map((item) => item.text)).toEqual(
        publicUrls
      );
    } finally {
      await app.close();
    }
  });

  it('bounds the complete page envelope, metadata, and continuation cursor', async () => {
    const candidates = Array.from({ length: 30 }, (_, index) => ({
      entry: entry(index + 1, 'x'.repeat(4_000)),
      cursorAfter: parseCursor(`cursor_${'m'.repeat(220)}_${index + 1}`),
    }));
    const source = {
      readPage: vi.fn(async () => ({ ...found(candidates), hasMore: true })),
    };
    const feature = createHostedMemberLogFeature({ authority: source, clock: { now: () => 1 } });
    const { app } = await createApp(feature);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_MEMBER_LOG_PAGE_ROUTE,
        payload: { ...request(), limit: 50 },
      });
      const result = response.json() as HostedMemberLogPage;
      const serializedBytes = new TextEncoder().encode(response.body).byteLength;
      const entriesOnlyBytes = result.entries.reduce(
        (total, item) => total + hostedMemberLogEntryByteLength(item),
        0
      );

      expect(response.statusCode).toBe(200);
      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.entries.length).toBeLessThan(candidates.length);
      expect(result.nextCursor).not.toBeNull();
      expect(result.truncated).toBe(true);
      expect(result.truncationReasons).toContain('byte_budget');
      expect(result.budget.usedBytes).toBe(serializedBytes);
      expect(result.budget.usedBytes).toBeLessThanOrEqual(HOSTED_MEMBER_LOG_MAX_PAGE_BYTES);
      expect(entriesOnlyBytes).toBeLessThan(result.budget.usedBytes);
      expect(source.readPage).toHaveBeenCalledWith(
        expect.objectContaining({
          selectionId,
          itemLimit: 51,
          byteLimit: HOSTED_MEMBER_LOG_MAX_PAGE_BYTES,
          expectedSourceGeneration: null,
        }),
        expect.any(Object)
      );
    } finally {
      await app.close();
    }
  });

  it('never serializes private source fields or thrown error details', async () => {
    const malformedFacade: HostedMemberLogHttpFacade = {
      getPage: vi.fn(async () => ({
        kind: 'success' as const,
        page: {
          ...page(),
          privateLocation: 'opaque-source-location',
        } as unknown as HostedMemberLogPage,
      })),
    };
    const malformed = await createApp(malformedFacade);
    try {
      const response = await malformed.app.inject({
        method: 'POST',
        url: HOSTED_MEMBER_LOG_PAGE_ROUTE,
        payload: request(),
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('opaque-source-location');
    } finally {
      await malformed.app.close();
    }

    const privateFailure = facade();
    vi.mocked(privateFailure.getPage).mockRejectedValueOnce(
      new Error('internal detail opaque-source-location')
    );
    const retry = await createApp(privateFailure);
    try {
      const response = await retry.app.inject({
        method: 'POST',
        url: HOSTED_MEMBER_LOG_PAGE_ROUTE,
        payload: request(),
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toMatch(/internal|detail|opaque/);
    } finally {
      await retry.app.close();
    }
  });
});
