import * as hosted from '@shared/contracts/hosted';

import invalid from './fixtures/invalid-contract-values.json';
import valid from './fixtures/valid-contract-values.json';

const expectSchemaVersionFailure = (operation: () => unknown): void => {
  expect(operation).toThrow(hosted.SCHEMA_VERSION_DIAGNOSTIC);
};

test('hosted tokens stay kind-separated and schema versions fail closed', () => {
  expect(hosted.parseRevision(valid.revision)).toBe(valid.revision);
  expect(hosted.parseCursor(valid.cursor)).toBe(valid.cursor);
  expect(() => hosted.parseCursor(invalid.revisionAsCursor)).toThrow();
  expect(hosted.parseHostedSchemaVersion(valid.sameVersionResponse.schemaVersion)).toBe(
    hosted.HOSTED_SCHEMA_VERSION
  );
  for (const version of [...invalid.schemaVersions, undefined]) {
    expectSchemaVersionFailure(() => hosted.parseHostedSchemaVersion(version));
  }
});

test('same-version responses validate known fields and return a fresh projection', () => {
  const parsed = hosted.parseHostedRevisionResponse(valid.sameVersionResponse);

  expect(parsed).toEqual({
    schemaVersion: hosted.HOSTED_SCHEMA_VERSION,
    revision: valid.revision,
  });
  expect(parsed).not.toBe(valid.sameVersionResponse);
  expect(parsed).not.toHaveProperty('additiveField');
  expect(Object.keys(parsed)).toEqual(['schemaVersion', 'revision']);
});

test('same-version responses reject missing or invalid known fields before additive discard', () => {
  for (const response of invalid.sameVersionResponsesWithInvalidKnownFields) {
    expectSchemaVersionFailure(() => hosted.parseHostedRevisionResponse(response));
  }

  const additiveField = vi.fn(() => 'ignored');
  const response = {
    schemaVersion: hosted.HOSTED_SCHEMA_VERSION,
    get revision(): number {
      return 42;
    },
    get additiveField(): string {
      return additiveField();
    },
  };
  expectSchemaVersionFailure(() => hosted.parseHostedRevisionResponse(response));
  expect(additiveField).not.toHaveBeenCalled();
});

test('revision contracts reject malformed, missing, future, and incompatible versions', () => {
  const invalidContracts: unknown[] = [null, undefined, [], 'not-an-object', {}];
  invalidContracts.push(
    ...invalid.schemaVersions.map((schemaVersion) => ({
      schemaVersion,
      revision: valid.revision,
    }))
  );

  for (const contract of invalidContracts) {
    expectSchemaVersionFailure(() => hosted.parseHostedRevisionResponse(contract));
    expectSchemaVersionFailure(() => hosted.parseHostedRevisionInput(contract));
  }
});

test('versioned inputs validate known fields and reject unknown own fields', () => {
  expect(hosted.parseHostedRevisionInput(valid.sameVersionInput)).toEqual({
    schemaVersion: hosted.HOSTED_SCHEMA_VERSION,
    revision: valid.revision,
  });
  expectSchemaVersionFailure(() =>
    hosted.parseHostedRevisionInput(invalid.sameVersionInputWithUnknownField)
  );
  expectSchemaVersionFailure(() =>
    hosted.parseHostedRevisionInput({
      ...valid.sameVersionInput,
      [Symbol('headers')]: 'disallowed',
    })
  );

  const inheritedUnknownField = Object.create({ headers: 'not-an-own-field' }) as Record<
    string,
    unknown
  >;
  inheritedUnknownField.schemaVersion = hosted.HOSTED_SCHEMA_VERSION;
  inheritedUnknownField.revision = valid.revision;
  expect(hosted.parseHostedRevisionInput(inheritedUnknownField)).toEqual({
    schemaVersion: hosted.HOSTED_SCHEMA_VERSION,
    revision: valid.revision,
  });
});
