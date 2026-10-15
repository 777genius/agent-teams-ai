import { CustomTeamTemplateStorageInterruptedError } from '@features/custom-team-templates/core/application/CustomTeamTemplateStorageInterruptedError';
import { InMemoryCustomTeamTemplatePreviewStore } from '@features/custom-team-templates/core/application/InMemoryCustomTeamTemplatePreviewStore';
import { RecheckCustomTeamTemplateSaveUseCase } from '@features/custom-team-templates/core/application/RecheckCustomTeamTemplateSaveUseCase';
import { STORAGE_SETTLEMENT_TIMEOUT_MS } from '@features/custom-team-templates/core/application/waitForStorageSettlement';
import { serializeCanonicalTemplateContent } from '@features/custom-team-templates/core/domain/canonicalTemplateSerialization';
import { NodeCustomTeamTemplateHasher } from '@features/custom-team-templates/main/adapters/output/NodeCustomTeamTemplateHasher';
import { describe, expect, it, vi } from 'vitest';

import type {
  CustomTeamTemplateV1,
  ReadCustomTeamTemplateRecordResult,
} from '@features/custom-team-templates/contracts';
import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';

const hasher = new NodeCustomTeamTemplateHasher();

const CANONICAL_CONTENT = serializeCanonicalTemplateContent({
  schemaVersion: 1,
  teamPrompt: 'Deliver the feature.',
  members: [{ name: 'alice', role: 'reviewer', workflow: 'Review each change.' }],
});
const CONTENT_HASH = hasher.hashCanonicalContent(CANONICAL_CONTENT);
/** The stable id a confirmed save of the operation below derives. */
const TEMPLATE_ID = hasher.deriveTemplateId({
  contentHash: CONTENT_HASH,
  nameKey: 'release pipeline',
  description: null,
});

function stored(overrides: Partial<CustomTeamTemplateV1> = {}): CustomTeamTemplateV1 {
  return {
    templateId: TEMPLATE_ID,
    name: 'Release Pipeline',
    schemaVersion: 1,
    teamPrompt: 'Deliver the feature.',
    members: [{ name: 'alice', role: 'reviewer', workflow: 'Review each change.' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface RecheckFixture {
  useCase: RecheckCustomTeamTemplateSaveUseCase;
  store: InMemoryCustomTeamTemplatePreviewStore;
  token: string;
  read: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
}

/**
 * A retained operation exactly as a confirmed save leaves it: the store owns the
 * stable template id, the confirmed identity and the reviewed digest.
 */
function operation(
  options: {
    read?: ReadCustomTeamTemplateRecordResult | Error;
    gateway?: CustomTeamTemplateStorageGateway | null;
    ttlMs?: number;
    now?: () => number;
  } = {}
): RecheckFixture {
  const store = new InMemoryCustomTeamTemplatePreviewStore({
    now: options.now ?? (() => 0),
    createToken: () => 'token-1',
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });
  const state = store.issue({
    sourceTeamName: 'alpha-team',
    templateId: 'tmpl-placeholder',
    name: 'Release Pipeline',
    nameKey: 'release pipeline',
    canonicalContent: CANONICAL_CONTENT,
    contentHash: CONTENT_HASH,
  });
  store.confirmSave(state.token, {
    templateId: TEMPLATE_ID,
    name: 'Release Pipeline',
    nameKey: 'release pipeline',
  });

  const read = vi.fn((): Promise<ReadCustomTeamTemplateRecordResult> => {
    if (options.read instanceof Error) return Promise.reject(options.read);
    if (!options.read) {
      return Promise.reject(new Error('recheck fixture is missing its read outcome'));
    }
    return Promise.resolve(options.read);
  });
  const create = vi.fn();
  const gateway: CustomTeamTemplateStorageGateway | null =
    options.gateway === undefined
      ? {
          customTeamTemplateCreate: create,
          customTeamTemplateList: vi
            .fn()
            .mockResolvedValue({ templates: [], unreadableRecords: [] }),
          customTeamTemplateGetById: read,
        }
      : options.gateway;

  return {
    useCase: new RecheckCustomTeamTemplateSaveUseCase({ gateway, hasher, previewStore: store }),
    store,
    token: state.token,
    read,
    create,
  };
}

describe('RecheckCustomTeamTemplateSaveUseCase', () => {
  it('confirms success when the stored record is equivalent to the operation', async () => {
    const fixture = operation({ read: { status: 'found', template: stored() } });

    await expect(fixture.useCase.execute({ previewToken: fixture.token })).resolves.toEqual({
      status: 'saved',
      template: stored(),
    });
    // Reconciliation happens by the operation's own stable id.
    expect(fixture.read).toHaveBeenCalledWith({ templateId: TEMPLATE_ID });
    // Re-checking is read-only: it can never create a second row.
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('accepts a differing display capitalization as the same record', async () => {
    const fixture = operation({
      read: { status: 'found', template: stored({ name: 'RELEASE PIPELINE' }) },
    });

    await expect(fixture.useCase.execute({ previewToken: fixture.token })).resolves.toEqual({
      status: 'saved',
      template: stored({ name: 'RELEASE PIPELINE' }),
    });
  });

  it('reports a conflicting record under the same id instead of overwriting it', async () => {
    const fixture = operation({
      read: { status: 'found', template: stored({ teamPrompt: 'Something else.' }) },
    });

    await expect(fixture.useCase.execute({ previewToken: fixture.token })).resolves.toEqual({
      status: 'templateIdConflict',
      templateId: TEMPLATE_ID,
    });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('reports confirmed absence as a safely retryable state', async () => {
    const fixture = operation({ read: { status: 'notFound' } });

    await expect(fixture.useCase.execute({ previewToken: fixture.token })).resolves.toEqual({
      status: 'notSaved',
      templateId: TEMPLATE_ID,
    });
  });

  it('never reports an unreadable existing record as confirmed absence', async () => {
    const fixture = operation({ read: { status: 'unreadable', templateId: TEMPLATE_ID } });

    await expect(fixture.useCase.execute({ previewToken: fixture.token })).resolves.toEqual({
      status: 'unresolved',
      templateId: TEMPLATE_ID,
    });
  });

  it('waits out an unknown interruption and stays unresolved rather than guessing', async () => {
    let settled = false;
    const fixture = operation({
      read: new CustomTeamTemplateStorageInterruptedError(
        'worker died',
        'unknown',
        Promise.resolve().then(() => {
          settled = true;
        })
      ),
    });

    await expect(fixture.useCase.execute({ previewToken: fixture.token })).resolves.toEqual({
      status: 'unresolved',
      templateId: TEMPLATE_ID,
    });
    expect(settled).toBe(true);
  });

  it('bounds the settlement wait and never converts a timeout into notFound', async () => {
    vi.useFakeTimers();
    try {
      const fixture = operation({
        read: new CustomTeamTemplateStorageInterruptedError(
          'worker termination unconfirmed',
          'unknown',
          new Promise<void>(() => undefined)
        ),
      });

      const pending = fixture.useCase.execute({ previewToken: fixture.token });
      await vi.advanceTimersByTimeAsync(STORAGE_SETTLEMENT_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(STORAGE_SETTLEMENT_TIMEOUT_MS);

      // A re-check that cannot settle stays honestly unresolved; it is never
      // reinterpreted as confirmed absence.
      await expect(pending).resolves.toEqual({
        status: 'unresolved',
        templateId: TEMPLATE_ID,
      });
      expect(fixture.create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an ordinary read failure as unresolved instead of absent', async () => {
    const fixture = operation({ read: new Error('worker is not available') });

    await expect(fixture.useCase.execute({ previewToken: fixture.token })).resolves.toEqual({
      status: 'unresolved',
      templateId: TEMPLATE_ID,
    });
  });

  it('rejects a missing or unknown token without touching storage', async () => {
    const fixture = operation({ read: { status: 'notFound' } });

    await expect(fixture.useCase.execute({})).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'previewTokenRequired', field: 'previewToken' }],
    });
    await expect(fixture.useCase.execute({ previewToken: '  ' })).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'previewTokenRequired', field: 'previewToken' }],
    });
    await expect(fixture.useCase.execute({ previewToken: 'unknown-token' })).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'previewTokenUnknown', field: 'previewToken' }],
    });
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('allows re-check for an expired token that has a confirmed save', async () => {
    let now = 0;
    const fixture = operation({
      read: { status: 'found', template: stored() },
      ttlMs: 100,
      now: () => now,
    });

    now = 100;
    await expect(fixture.useCase.execute({ previewToken: fixture.token })).resolves.toEqual({
      status: 'saved',
      template: stored(),
    });
    expect(fixture.read).toHaveBeenCalled();
  });

  it('rejects an expired token that was never confirmed', async () => {
    let now = 0;
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => now,
      createToken: () => 'token-1',
      ttlMs: 100,
    });
    const state = store.issue({
      sourceTeamName: 'alpha-team',
      templateId: TEMPLATE_ID,
      name: 'Release Pipeline',
      nameKey: 'release pipeline',
      canonicalContent: CANONICAL_CONTENT,
      contentHash: CONTENT_HASH,
    });
    // Note: confirmSave is NOT called, so no confirmed save identity exists
    const read = vi.fn(
      (): Promise<ReadCustomTeamTemplateRecordResult> => Promise.resolve({ status: 'notFound' })
    );
    const useCase = new RecheckCustomTeamTemplateSaveUseCase({
      gateway: {
        customTeamTemplateCreate: vi.fn(),
        customTeamTemplateList: vi.fn().mockResolvedValue({ templates: [], unreadableRecords: [] }),
        customTeamTemplateGetById: read,
      },
      hasher,
      previewStore: store,
    });

    now = 100;
    await expect(useCase.execute({ previewToken: state.token })).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'previewTokenExpired', field: 'previewToken' }],
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('reports unavailable storage instead of absence when there is no backend', async () => {
    const fixture = operation({ gateway: null });

    await expect(fixture.useCase.execute({ previewToken: fixture.token })).resolves.toEqual({
      status: 'storageUnavailable',
    });
  });

  it('reports confirmed absence for a preview that was never confirmed', async () => {
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => 0,
      createToken: () => 'token-1',
    });
    const state = store.issue({
      sourceTeamName: 'alpha-team',
      templateId: TEMPLATE_ID,
      name: 'Release Pipeline',
      nameKey: 'release pipeline',
      canonicalContent: CANONICAL_CONTENT,
      contentHash: CONTENT_HASH,
    });
    const read = vi.fn(
      (): Promise<ReadCustomTeamTemplateRecordResult> => Promise.resolve({ status: 'notFound' })
    );
    const useCase = new RecheckCustomTeamTemplateSaveUseCase({
      gateway: {
        customTeamTemplateCreate: vi.fn(),
        customTeamTemplateList: vi.fn().mockResolvedValue({ templates: [], unreadableRecords: [] }),
        customTeamTemplateGetById: read,
      },
      hasher,
      previewStore: store,
    });

    // Nothing was persisted for this token, so a re-check honestly reports that
    // rather than inventing a success or an error.
    await expect(useCase.execute({ previewToken: state.token })).resolves.toEqual({
      status: 'notSaved',
      templateId: TEMPLATE_ID,
    });
  });
});
