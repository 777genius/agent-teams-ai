declare const operationsIdentifierBrand: unique symbol;

export type DiagnosticId = string & {
  readonly [operationsIdentifierBrand]: 'DiagnosticId';
};
export type SseConnectionId = string & {
  readonly [operationsIdentifierBrand]: 'SseConnectionId';
};
export type OperationalReferenceId = string & {
  readonly [operationsIdentifierBrand]: 'OperationalReferenceId';
};
export type OperationCorrelationId = string & {
  readonly [operationsIdentifierBrand]: 'OperationCorrelationId';
};

const OPAQUE_IDENTIFIER_PAYLOAD = /^[0-9a-f]{32}$/;

function parseOpaqueIdentifier<T extends string>(
  value: unknown,
  prefix: 'diagnostic' | 'reference' | 'request' | 'stream'
): T {
  const expectedLength = prefix.length + 1 + 32;
  if (
    typeof value !== 'string' ||
    value.length !== expectedLength ||
    !value.startsWith(`${prefix}_`) ||
    !OPAQUE_IDENTIFIER_PAYLOAD.test(value.slice(prefix.length + 1))
  ) {
    throw new TypeError('hosted-operations-opaque-identifier-invalid');
  }
  return value as T;
}

export const parseDiagnosticId = (value: unknown): DiagnosticId =>
  parseOpaqueIdentifier(value, 'diagnostic');

export const parseSseConnectionId = (value: unknown): SseConnectionId =>
  parseOpaqueIdentifier(value, 'stream');

export const parseOperationalReferenceId = (value: unknown): OperationalReferenceId =>
  parseOpaqueIdentifier(value, 'reference');

/** Parses the server-minted fixed-shape identifier shared across one operation context. */
export const parseOperationCorrelationId = (value: unknown): OperationCorrelationId =>
  parseOpaqueIdentifier(value, 'request');
