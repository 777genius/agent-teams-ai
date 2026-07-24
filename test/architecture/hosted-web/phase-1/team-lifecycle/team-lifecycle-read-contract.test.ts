import { describe, expect, it } from 'vitest';

import * as teamLifecycle from '../../../../../src/features/team-lifecycle';
import * as teamLifecycleContracts from '../../../../../src/features/team-lifecycle/contracts';
import manifest from '../../../../fixtures/hosted-web/phase-1/team-lifecycle/manifest.json';

function validRequest(): unknown {
  return {
    schemaVersion: 1,
    cursor: 'cursor_contract_page',
    expectedRevision: 'revision_contract_snapshot',
  };
}

function validSuccess(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'success',
    snapshotRevision: 'revision_contract_snapshot',
    items: [
      {
        teamId: 'team_zeta',
        displayName: 'Zeta',
        lifecycle: 'running',
        revision: 'revision_team_zeta',
      },
      {
        teamId: 'team_alpha',
        displayName: 'Alpha',
        lifecycle: 'ready',
        revision: 'revision_team_alpha',
      },
    ],
    nextCursor: 'cursor_contract_next',
  };
}

function validFailure(): Record<PropertyKey, unknown> {
  return {
    schemaVersion: 1,
    kind: 'failure',
    error: {
      code: 'unavailable',
      reason: 'source_unavailable',
      retryAfterMs: 2500,
    },
    retryable: true,
  };
}

function validInapplicable(): Record<PropertyKey, unknown> {
  return {
    schemaVersion: 1,
    kind: 'inapplicable',
    code: 'not_applicable',
    reason: 'list_not_found_inapplicable',
  };
}

function withAdditiveFields(value: Record<PropertyKey, unknown>): Record<PropertyKey, unknown> {
  value.additiveResponseField = 'discarded';
  value[Symbol('additive-response-field')] = 'discarded';
  return value;
}

function expectRejectedResponse(value: unknown): void {
  expect(teamLifecycleContracts.parseListTeamLifecycleResult(value).ok).toBe(false);
}

describe('team-lifecycle read contract', () => {
  it('parses the versioned serializable request with opaque cursor and revision values', () => {
    const parsed = teamLifecycleContracts.parseListTeamLifecycleRequest(validRequest());

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.schemaVersion).toBe(1);
      expect(parsed.value.cursor).toBe('cursor_contract_page');
      expect(parsed.value.expectedRevision).toBe('revision_contract_snapshot');
      expect(Object.isFrozen(parsed.value)).toBe(true);
      expect(Reflect.ownKeys(parsed.value)).toEqual([
        'schemaVersion',
        'cursor',
        'expectedRevision',
      ]);
    }
    expect(teamLifecycleContracts.TEAM_LIFECYCLE_READ_UNKNOWN_FIELD_POLICY).toBe('reject');

    const roundTripped = teamLifecycleContracts.parseListTeamLifecycleRequest(
      JSON.parse(JSON.stringify(validRequest()))
    );
    expect(roundTripped.ok).toBe(true);
  });

  it('rejects unsupported versions, unknown fields, malformed IDs, revisions, and cursors safely', () => {
    const unsupported = teamLifecycleContracts.parseListTeamLifecycleRequest({
      ...(validRequest() as Record<string, unknown>),
      schemaVersion: 2,
    });
    expect(unsupported).toMatchObject({
      ok: false,
      error: {
        code: 'unsupported',
        reason: 'schema_version_unsupported',
        diagnosticId: 'schema-version-invalid-or-unsupported',
      },
    });

    const unknownField = teamLifecycleContracts.parseListTeamLifecycleRequest({
      ...(validRequest() as Record<string, unknown>),
      extra: true,
    });
    expect(unknownField).toMatchObject({
      ok: false,
      error: { code: 'invalid_request', reason: 'request_invalid' },
    });

    const topLevelSymbol = validRequest() as Record<PropertyKey, unknown>;
    topLevelSymbol[Symbol('unknown-request-field')] = true;

    // Client-supplied identity/cancellation must never enter through the wire payload.
    const clientSuppliedContext = {
      ...(validRequest() as Record<string, unknown>),
      context: {
        ...manifest.fakePrincipal,
        deadlineAtMs: manifest.fixedClockMs + 30_000,
      },
    };

    for (const strictUnknown of [topLevelSymbol, clientSuppliedContext]) {
      expect(teamLifecycleContracts.parseListTeamLifecycleRequest(strictUnknown)).toMatchObject({
        ok: false,
        error: { code: 'invalid_request', reason: 'request_invalid' },
      });
    }

    const malformedValues = [
      { ...(validRequest() as Record<string, unknown>), cursor: 'wrong_cursor' },
      { ...(validRequest() as Record<string, unknown>), expectedRevision: 'wrong_revision' },
    ];
    for (const value of malformedValues) {
      expect(teamLifecycleContracts.parseListTeamLifecycleRequest(value)).toMatchObject({
        ok: false,
        error: { code: 'invalid_request', reason: 'request_invalid' },
      });
    }
  });

  it('projects additive success and item fields into fresh, frozen, known-field-only values', () => {
    const source = withAdditiveFields(validSuccess());
    const sourceItems = source.items as Record<PropertyKey, unknown>[];
    sourceItems.forEach(withAdditiveFields);

    const parsed = teamLifecycleContracts.parseListTeamLifecycleResult(source);

    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.kind === 'success') {
      expect(parsed.value.items.map((item) => item.teamId)).toEqual(['team_alpha', 'team_zeta']);
      expect(parsed.value.nextCursor).toBe('cursor_contract_next');
      expect(parsed.value).not.toBe(source);
      expect(parsed.value.items).not.toBe(sourceItems);
      expect(parsed.value.items).not.toContain(sourceItems[0]);
      expect(parsed.value.items).not.toContain(sourceItems[1]);
      expect(Object.isFrozen(parsed.value)).toBe(true);
      expect(Object.isFrozen(parsed.value.items)).toBe(true);
      expect(Reflect.ownKeys(parsed.value)).toEqual([
        'schemaVersion',
        'kind',
        'snapshotRevision',
        'items',
        'nextCursor',
      ]);
      for (const item of parsed.value.items) {
        expect(Object.isFrozen(item)).toBe(true);
        expect(Reflect.ownKeys(item)).toEqual(['teamId', 'displayName', 'lifecycle', 'revision']);
      }
      expect(Reflect.ownKeys(source)).toContain('additiveResponseField');
      expect(Reflect.ownKeys(sourceItems[0])).toContain('additiveResponseField');
    }
  });

  it('copies every dense item once without dispatching input-owned array behavior', () => {
    const source = validSuccess();
    const sourceItems = source.items as Record<PropertyKey, unknown>[];
    const itemReads = sourceItems.map(() => 0);
    const originalItems = [...sourceItems];

    originalItems.forEach((item, index) => {
      Object.defineProperty(sourceItems, index, {
        configurable: true,
        enumerable: true,
        get() {
          itemReads[index] += 1;
          return item;
        },
      });
    });

    let lengthReads = 0;
    const shadowedBehaviorCalls = {
      constructor: 0,
      iterator: 0,
      map: 0,
      species: 0,
    };
    const shadowedConstructor = {};
    Object.defineProperty(shadowedConstructor, Symbol.species, {
      configurable: true,
      get() {
        shadowedBehaviorCalls.species += 1;
        throw new Error('input-owned species must not be read');
      },
    });
    Object.defineProperties(sourceItems, {
      map: {
        configurable: true,
        get() {
          shadowedBehaviorCalls.map += 1;
          throw new Error('input-owned map must not be read');
        },
      },
      constructor: {
        configurable: true,
        get() {
          shadowedBehaviorCalls.constructor += 1;
          return shadowedConstructor;
        },
      },
      [Symbol.iterator]: {
        configurable: true,
        get() {
          shadowedBehaviorCalls.iterator += 1;
          throw new Error('input-owned iterator must not be read');
        },
      },
    });

    source.items = new Proxy(sourceItems, {
      get(target, property, receiver) {
        if (property === 'length') lengthReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    const parsed = teamLifecycleContracts.parseListTeamLifecycleResult(source);

    expect(parsed.ok).toBe(true);
    expect(lengthReads).toBe(1);
    expect(itemReads).toEqual([1, 1]);
    expect(shadowedBehaviorCalls).toEqual({
      constructor: 0,
      iterator: 0,
      map: 0,
      species: 0,
    });
    if (parsed.ok && parsed.value.kind === 'success') {
      const parsedItems = parsed.value.items;
      expect(Object.getPrototypeOf(parsedItems)).toBe(Array.prototype);
      expect(parsedItems === source.items).toBe(false);
      expect(parsedItems.every((_, index) => Object.hasOwn(parsedItems, index))).toBe(true);
      expect(parsedItems.map((item) => item.teamId)).toEqual(['team_alpha', 'team_zeta']);
      expect(Object.isFrozen(parsedItems)).toBe(true);
    }
  });

  it('rejects sparse item arrays at every position', () => {
    for (const sparseIndex of [0, 1, 2]) {
      const source = validSuccess();
      const item = (source.items as Record<PropertyKey, unknown>[])[0];
      const sparseItems: Record<PropertyKey, unknown>[] = [item, item, item];
      Reflect.deleteProperty(sparseItems, sparseIndex);
      source.items = sparseItems;

      expectRejectedResponse(source);
    }
  });

  it('projects additive failure, safe-error, and inapplicable fields without retaining input', () => {
    const failureSource = withAdditiveFields(validFailure());
    const errorSource = withAdditiveFields(failureSource.error as Record<PropertyKey, unknown>);
    const failure = teamLifecycleContracts.parseListTeamLifecycleResult(failureSource);

    expect(failure.ok).toBe(true);
    if (failure.ok && failure.value.kind === 'failure') {
      expect(failure.value).not.toBe(failureSource);
      expect(failure.value.error).not.toBe(errorSource);
      expect(Reflect.ownKeys(failure.value)).toEqual([
        'schemaVersion',
        'kind',
        'error',
        'retryable',
      ]);
      expect(Reflect.ownKeys(failure.value.error)).toEqual(['code', 'reason', 'retryAfterMs']);
      expect(Object.isFrozen(failure.value)).toBe(true);
      expect(Object.isFrozen(failure.value.error)).toBe(true);
    }

    const inapplicableSource = withAdditiveFields(validInapplicable());
    const inapplicable = teamLifecycleContracts.parseListTeamLifecycleResult(inapplicableSource);

    expect(inapplicable.ok).toBe(true);
    if (inapplicable.ok && inapplicable.value.kind === 'inapplicable') {
      expect(inapplicable.value).not.toBe(inapplicableSource);
      expect(Reflect.ownKeys(inapplicable.value)).toEqual([
        'schemaVersion',
        'kind',
        'code',
        'reason',
      ]);
      expect(Object.isFrozen(inapplicable.value)).toBe(true);
    }
  });

  it('validates every known response field before discarding additive fields', () => {
    const success = validSuccess() as Record<PropertyKey, unknown>;
    const successItems = success.items as Record<PropertyKey, unknown>[];
    const invalidSuccessValues: Record<PropertyKey, unknown>[] = [
      { ...success, snapshotRevision: 'snapshot' },
      { ...success, items: null },
      { ...success, nextCursor: 'next' },
      { ...success, kind: 'other' },
      { ...success, schemaVersion: 9 },
    ];
    const missingSuccessRevision = { ...success };
    delete missingSuccessRevision.snapshotRevision;
    invalidSuccessValues.push(missingSuccessRevision);

    const invalidItems = [
      { ...successItems[0], teamId: 'alpha' },
      { ...successItems[0], displayName: '' },
      { ...successItems[0], lifecycle: 'provisioning' },
      { ...successItems[0], revision: 'current' },
    ];
    for (const item of invalidItems) {
      invalidSuccessValues.push({ ...success, items: [withAdditiveFields(item)] });
    }
    const missingItemTeamId = { ...successItems[0] };
    delete missingItemTeamId.teamId;
    invalidSuccessValues.push({
      ...success,
      items: [withAdditiveFields(missingItemTeamId)],
    });

    invalidSuccessValues.forEach((value) => expectRejectedResponse(withAdditiveFields(value)));

    const invalidFailureValues: Record<PropertyKey, unknown>[] = [
      { ...validFailure(), error: null },
      { ...validFailure(), retryable: false },
      { ...validFailure(), kind: 'other' },
      { ...validFailure(), schemaVersion: 9 },
    ];
    const missingFailureError = { ...validFailure() };
    delete missingFailureError.error;
    invalidFailureValues.push(missingFailureError);

    const invalidErrors: Record<PropertyKey, unknown>[] = [
      { code: 'unavailable', reason: 'not safe', retryAfterMs: 2500 },
      { code: 'unavailable', reason: 'source_unavailable', diagnosticId: 'not safe' },
      { code: 'unavailable', reason: 'source_unavailable', diagnosticId: undefined },
      { code: 'unavailable', reason: 'source_unavailable', retryAfterMs: undefined },
      { code: 'internal', reason: 'unexpected', retryAfterMs: 1000 },
    ];
    const missingErrorCode: Record<PropertyKey, unknown> = { reason: 'source_unavailable' };
    invalidErrors.push(missingErrorCode);
    for (const error of invalidErrors) {
      invalidFailureValues.push({
        ...validFailure(),
        error: withAdditiveFields(error),
      });
    }
    invalidFailureValues.forEach((value) => expectRejectedResponse(withAdditiveFields(value)));

    const invalidInapplicableValues: Record<PropertyKey, unknown>[] = [
      { ...validInapplicable(), code: 'unsupported' },
      { ...validInapplicable(), reason: 'unknown_lifecycle_provisioning' },
      { ...validInapplicable(), kind: 'other' },
      { ...validInapplicable(), schemaVersion: 9 },
    ];
    const missingInapplicableCode = { ...validInapplicable() };
    delete missingInapplicableCode.code;
    invalidInapplicableValues.push(missingInapplicableCode);
    invalidInapplicableValues.forEach((value) => expectRejectedResponse(withAdditiveFields(value)));
  });

  it('ignores unreadable additive response values and safely rejects unreadable known values', () => {
    const additiveAccessor = validInapplicable();
    Object.defineProperty(additiveAccessor, 'futureField', {
      enumerable: true,
      get() {
        throw new Error('must not read additive response fields');
      },
    });
    expect(teamLifecycleContracts.parseListTeamLifecycleResult(additiveAccessor).ok).toBe(true);

    const knownAccessor = validSuccess();
    Object.defineProperty(knownAccessor, 'snapshotRevision', {
      enumerable: true,
      get() {
        throw new Error('known response field failed');
      },
    });
    expectRejectedResponse(knownAccessor);

    const changingKnownValue = validSuccess();
    const changingItem = (changingKnownValue.items as Record<PropertyKey, unknown>[])[0];
    let displayNameReads = 0;
    Object.defineProperty(changingItem, 'displayName', {
      enumerable: true,
      get() {
        displayNameReads += 1;
        return displayNameReads === 1 ? 'Zeta' : '';
      },
    });
    const changingParsed = teamLifecycleContracts.parseListTeamLifecycleResult(changingKnownValue);
    expect(changingParsed.ok).toBe(true);
    expect(displayNameReads).toBe(1);

    const requestAccessor = validRequest() as Record<PropertyKey, unknown>;
    Object.defineProperty(requestAccessor, 'cursor', {
      enumerable: true,
      get() {
        throw new Error('known request field failed');
      },
    });
    expect(teamLifecycleContracts.parseListTeamLifecycleRequest(requestAccessor)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request', reason: 'request_invalid' },
    });
  });

  it('accepts only narrow safe failure and inapplicable combinations', () => {
    const unavailable = teamLifecycleContracts.parseListTeamLifecycleResult({
      schemaVersion: 1,
      kind: 'failure',
      error: {
        code: 'unavailable',
        reason: 'source_unavailable',
        retryAfterMs: 2500,
      },
      retryable: true,
    });
    const notFound = teamLifecycleContracts.parseListTeamLifecycleResult({
      schemaVersion: 1,
      kind: 'inapplicable',
      code: 'not_applicable',
      reason: 'list_not_found_inapplicable',
    });
    const provisioning = teamLifecycleContracts.parseListTeamLifecycleResult({
      schemaVersion: 1,
      kind: 'inapplicable',
      code: 'unsupported',
      reason: 'unknown_lifecycle_provisioning',
    });

    expect(unavailable).toMatchObject({ ok: true, value: { kind: 'failure' } });
    expect(notFound).toMatchObject({ ok: true, value: { kind: 'inapplicable' } });
    expect(provisioning).toMatchObject({ ok: true, value: { kind: 'inapplicable' } });

    expect(
      teamLifecycleContracts.parseListTeamLifecycleResult({
        schemaVersion: 1,
        kind: 'inapplicable',
        code: 'not_applicable',
        reason: 'unknown_lifecycle_provisioning',
      })
    ).toMatchObject({
      ok: false,
      error: { code: 'internal', reason: 'source_response_invalid' },
    });
  });

  it('rejects malformed response versions, fields, items, lifecycle states, and opaque values', () => {
    const base = validSuccess();
    const baseItems = base.items as Record<string, unknown>[];
    const malformed = [
      { ...base, schemaVersion: 9 },
      { ...base, snapshotRevision: 'snapshot' },
      { ...base, nextCursor: 'next' },
      { ...base, items: [{ ...baseItems[0], teamId: 'alpha' }] },
      { ...base, items: [{ ...baseItems[0], revision: 'current' }] },
      { ...base, items: [{ ...baseItems[0], lifecycle: 'provisioning' }] },
      { ...base, items: [baseItems[0], baseItems[0]] },
    ];

    for (const value of malformed) {
      const parsed = teamLifecycleContracts.parseListTeamLifecycleResult(value);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.reason).not.toContain(JSON.stringify(value));
    }
  });

  it('exposes the same narrow browser-safe contract through both public entrypoints', () => {
    expect(teamLifecycle.parseListTeamLifecycleRequest).toBe(
      teamLifecycleContracts.parseListTeamLifecycleRequest
    );
    expect(teamLifecycle.parseListTeamLifecycleResult).toBe(
      teamLifecycleContracts.parseListTeamLifecycleResult
    );
    expect(teamLifecycle.parseCanonicalListTeamLifecycleResult).toBe(
      teamLifecycleContracts.parseCanonicalListTeamLifecycleResult
    );
    expect(Object.keys(teamLifecycleContracts)).toEqual(
      expect.arrayContaining([
        'TEAM_LIFECYCLE_READ_FAILURE_CODES',
        'TEAM_LIFECYCLE_READ_REQUEST_DIAGNOSTIC',
        'TEAM_LIFECYCLE_READ_RESPONSE_DIAGNOSTIC',
        'TEAM_LIFECYCLE_READ_SCHEMA_VERSION',
        'TEAM_LIFECYCLE_READ_UNKNOWN_FIELD_POLICY',
        'TEAM_LIFECYCLE_STATES',
        'parseCanonicalListTeamLifecycleResult',
        'parseListTeamLifecycleRequest',
        'parseListTeamLifecycleResult',
      ])
    );
  });
});
