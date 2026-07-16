declare const opaqueTokenBrand: unique symbol;
export type Revision = string & { readonly [opaqueTokenBrand]: 'Revision' };
export type Cursor = string & { readonly [opaqueTokenBrand]: 'Cursor' };
export const HOSTED_SCHEMA_VERSION = 1 as const;
export const SCHEMA_VERSION_DIAGNOSTIC = 'phase1-schema-version-invalid-or-unsupported';
export interface HostedRevisionContract {
  schemaVersion: typeof HOSTED_SCHEMA_VERSION;
  revision: Revision;
}

const TOKEN_PATTERNS = new Map<string, RegExp>();
function parseToken<T extends string>(value: unknown, prefix: string): T {
  let pattern = TOKEN_PATTERNS.get(prefix);
  if (!pattern) {
    pattern = new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9._-]*$`);
    TOKEN_PATTERNS.set(prefix, pattern);
  }
  if (typeof value !== 'string' || value.length > 256 || !pattern.test(value)) {
    throw new TypeError('hosted-contract-opaque-token-invalid');
  }
  return value as T;
}
export const parseRevision = (value: unknown): Revision => parseToken(value, 'revision');
export const parseCursor = (value: unknown): Cursor => parseToken(value, 'cursor');
export function parseHostedSchemaVersion(value: unknown): typeof HOSTED_SCHEMA_VERSION {
  if (value !== HOSTED_SCHEMA_VERSION) throw new TypeError(SCHEMA_VERSION_DIAGNOSTIC);
  return HOSTED_SCHEMA_VERSION;
}

function schemaVersionError(): never {
  throw new TypeError(SCHEMA_VERSION_DIAGNOSTIC);
}

function parseHostedRevisionContract(value: unknown): HostedRevisionContract {
  if (typeof value !== 'object' || value === null) schemaVersionError();
  const record = value as Record<PropertyKey, unknown>;

  try {
    if (!Object.hasOwn(record, 'schemaVersion') || !Object.hasOwn(record, 'revision')) {
      return schemaVersionError();
    }

    const schemaVersion = parseHostedSchemaVersion(record.schemaVersion);
    const revision = parseRevision(record.revision);
    return { schemaVersion, revision };
  } catch {
    return schemaVersionError();
  }
}

export function parseHostedRevisionResponse(value: unknown): HostedRevisionContract {
  return parseHostedRevisionContract(value);
}

export function parseHostedRevisionInput(value: unknown): HostedRevisionContract {
  const parsed = parseHostedRevisionContract(value);

  try {
    for (const key of Reflect.ownKeys(value as object)) {
      if (key !== 'schemaVersion' && key !== 'revision') schemaVersionError();
    }
  } catch {
    return schemaVersionError();
  }

  return parsed;
}
