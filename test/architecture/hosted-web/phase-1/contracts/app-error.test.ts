import * as hosted from '@shared/contracts/hosted';

import valid from './fixtures/valid-contract-values.json';
test('hosted errors freeze safe fields and reject unsafe or transport-shaped values', () => {
  expect(hosted.APP_ERROR_CODES.join(',')).toBe(
    'invalid_request,unauthenticated,forbidden,not_found,conflict,unsupported,unavailable,cancelled,internal'
  );
  expect(Object.isFrozen(hosted.APP_ERROR_CODES)).toBe(true);
  expect(hosted.createSafeAppError(valid.safeError)).toEqual(valid.safeError);
  for (const reason of ['Raw message', 'source/unavailable']) {
    expect(() => hosted.createSafeAppError({ code: 'internal', reason })).toThrow();
  }
  for (const retryAfterMs of [0, 60_001]) {
    expect(() =>
      hosted.createSafeAppError({ code: 'unavailable', reason: 'retry', retryAfterMs })
    ).toThrow();
  }
  expect(() =>
    hosted.createSafeAppError({ code: 'internal', reason: 'unexpected', status: 500 })
  ).toThrow();
  expect(() =>
    hosted.createSafeAppError({ code: 'internal', reason: 'unexpected', retryAfterMs: 1 })
  ).toThrow();
  expect(() => hosted.createSafeAppError({ code: 'other', reason: 'unexpected' })).toThrow();
});

test('hosted errors snapshot fields once so getters cannot swap validated values', () => {
  let reasonReads = 0;
  const toctou = {
    code: 'internal',
    get reason() {
      reasonReads += 1;
      return reasonReads === 1 ? 'validated_safe_reason' : 'leaked raw internal detail';
    },
  };

  const safeError = hosted.createSafeAppError(toctou);

  expect(reasonReads).toBe(1);
  expect(safeError.reason).toBe('validated_safe_reason');

  const symbolKeyed = { code: 'internal', reason: 'unexpected', [Symbol('extra')]: 'x' };
  expect(() => hosted.createSafeAppError(symbolKeyed)).toThrowError(
    'hosted-contract-safe-error-invalid'
  );
});

test('hosted error diagnostic IDs survive only in frozen known-field projections', () => {
  const diagnosticId = 'diag.focused-regression';
  const safeError = hosted.createSafeAppError({
    code: 'internal',
    reason: 'unexpected',
    diagnosticId,
  });

  expect(safeError).toEqual({ code: 'internal', reason: 'unexpected', diagnosticId });
  expect(safeError.diagnosticId).toBe(diagnosticId);
  expect(Reflect.ownKeys(safeError)).toEqual(['code', 'reason', 'diagnosticId']);
  expect(Object.isFrozen(safeError)).toBe(true);
  expect(() =>
    hosted.createSafeAppError({
      code: 'internal',
      reason: 'unexpected',
      diagnosticId: 'unsafe diagnostic',
    })
  ).toThrowError('hosted-contract-safe-error-invalid');
});
