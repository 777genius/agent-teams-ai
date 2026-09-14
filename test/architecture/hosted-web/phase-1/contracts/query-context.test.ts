import * as hosted from '@shared/contracts/hosted';

import invalid from './fixtures/invalid-contract-values.json';
import valid from './fixtures/valid-contract-values.json';
const input = (signal: AbortSignal) => ({
  ...valid.contextIdentity,
  deadlineAtMs: 1000,
  signal,
});

test('hosted query context admits only identity, scope, deadline, and cancellation values', () => {
  const signal = new AbortController().signal;
  const context = hosted.createQueryContext(input(signal));
  expect(context.authorizedScope).toBe(
    hosted.parseAuthorizedScope(valid.contextIdentity.authorizedScope)
  );
  expect(context.signal).toBe(signal);
  expect(Object.isFrozen(context)).toBe(true);
  expect(() =>
    hosted.createQueryContext({ ...input(signal), [invalid.unknownInputField]: 'not-admitted' })
  ).toThrow();
  expect(() => hosted.createQueryContext({ ...input(signal), deadlineAtMs: -1 })).toThrow();
  expect(() => hosted.createQueryContext({ ...input(signal), signal: {} })).toThrow();
});
