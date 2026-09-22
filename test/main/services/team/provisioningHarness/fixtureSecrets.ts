export interface SecretLikeFixtureFinding {
  path: string;
  reason: string;
  patternName?: string;
  stringLength?: number;
  redactedValue?: '<redacted>';
}

const SECRET_LIKE_KEY_PATTERN = new RegExp(
  [
    'api[_-]?key',
    'apiKey',
    'auth[_-]?token',
    'authToken',
    'oauth[_-]?token',
    'oauthToken',
    'secret',
    'password',
    'passwd',
    'private[_-]?key',
    'privateKey',
  ].join('|'),
  'i'
);
const SECRET_LIKE_VALUE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._-]{10,}\b/i },
  { name: 'openai-api-key', pattern: /\bsk-(?:live|test|proj)?[A-Za-z0-9_-]{10,}\b/i },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{10,}\b/i },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i },
  { name: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{12,}\b/ },
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const SAFE_FIXTURE_PATH_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

function findSecretLikeValuePattern(
  value: string
): (typeof SECRET_LIKE_VALUE_PATTERNS)[number] | undefined {
  return SECRET_LIKE_VALUE_PATTERNS.find(({ pattern }) => pattern.test(value));
}

function findSecretLikeKeyPattern(key: string): { name: string } | undefined {
  if (SECRET_LIKE_KEY_PATTERN.test(key)) {
    return { name: 'secret-like-key' };
  }
  const matchedValuePattern = findSecretLikeValuePattern(key);
  if (matchedValuePattern) {
    return { name: `secret-like-${matchedValuePattern.name}` };
  }
  return undefined;
}

function formatObjectKeyPathSegment(key: string, index: number): string {
  if (findSecretLikeKeyPattern(key)) {
    return `[key#${index}:redacted]`;
  }
  if (SAFE_FIXTURE_PATH_KEY_PATTERN.test(key)) {
    return `[key#${index}:safe]`;
  }
  return `[key#${index}:sanitized]`;
}

function scanFixtureValue(
  value: unknown,
  path: string,
  findings: SecretLikeFixtureFinding[]
): void {
  if (typeof value === 'string') {
    const matchedPattern = findSecretLikeValuePattern(value);
    if (matchedPattern) {
      findings.push({
        path,
        reason: `value matched secret-like pattern ${matchedPattern.name}`,
        patternName: matchedPattern.name,
        stringLength: value.length,
        redactedValue: '<redacted>',
      });
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => scanFixtureValue(item, `${path}[${index}]`, findings));
    return;
  }

  if (value instanceof Map) {
    let index = 0;
    for (const [key, child] of value) {
      scanFixtureValue(key, `${path}[mapKey#${index}]`, findings);
      scanFixtureValue(child, `${path}[mapValue#${index}]`, findings);
      index += 1;
    }
    return;
  }

  if (value instanceof Set) {
    let index = 0;
    for (const item of value) {
      scanFixtureValue(item, `${path}[setValue#${index}]`, findings);
      index += 1;
    }
    return;
  }

  for (const [index, [key, child]] of Object.entries(value).entries()) {
    const childPath = `${path}${formatObjectKeyPathSegment(key, index)}`;
    const matchedKeyPattern = findSecretLikeKeyPattern(key);
    if (matchedKeyPattern) {
      findings.push({
        path: childPath,
        reason: 'key matched secret-like pattern',
        patternName: matchedKeyPattern.name,
      });
    }
    scanFixtureValue(child, childPath, findings);
  }
}

export function collectSecretLikeFixtureValues(value: unknown): SecretLikeFixtureFinding[] {
  const findings: SecretLikeFixtureFinding[] = [];
  scanFixtureValue(value, '$', findings);
  return findings;
}

export function assertNoSecretLikeFixtureValues(value: unknown): void {
  const findings = collectSecretLikeFixtureValues(value);
  if (findings.length === 0) {
    return;
  }

  const details = findings
    .map((finding) =>
      finding.redactedValue
        ? `${finding.path}: ${finding.reason} ` +
          `(length=${finding.stringLength}, value=${finding.redactedValue})`
        : `${finding.path}: ${finding.reason}`
    )
    .join('\n');
  throw new Error(`Secret-like fixture values are not allowed:\n${details}`);
}
