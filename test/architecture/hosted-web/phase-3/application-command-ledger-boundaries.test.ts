import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  COMMAND_IDEMPOTENCY_SCOPE,
  createCommandDescriptorRegistry,
  DURABLE_COMMAND_STATES,
  DURABLE_EFFECT_STATES,
  EFFECT_RECOVERY_CLASSES,
  encodeLengthDelimitedValue,
  HMAC_SHA256_LD_V1,
} from '@features/application-command-ledger';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const PURE_PROTOCOL_PATHS = [
  'src/features/application-command-ledger/contracts/durableCommandProtocol.ts',
  'src/features/application-command-ledger/core/domain/commandDescriptorRegistry.ts',
  'src/features/application-command-ledger/core/domain/commandFingerprint.ts',
  'src/features/application-command-ledger/core/domain/durableCommandState.ts',
] as const;

const FORBIDDEN_IMPORTS = [
  'electron',
  'fastify',
  'node:fs',
  'node:path',
  'node:crypto',
  '@main/',
  'internal-storage',
] as const;

describe('Phase 3 durable command architecture boundary', () => {
  it('keeps the protocol contracts and core free of runtime, storage, and cryptography imports', () => {
    for (const relativePath of PURE_PROTOCOL_PATHS) {
      // Paths come only from the frozen repository-owned allowlist above.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(imports, `${relativePath} imports ${forbidden}`).not.toContain(forbidden);
        expect(
          imports.some((specifier) => specifier.startsWith(forbidden)),
          `${relativePath} imports ${forbidden}`
        ).toBe(false);
      }
      expect(source).not.toMatch(/\b(registerCapability|writeFile|readFile|createHmac)\b/);
    }
  });

  it('exposes the pure protocol through the existing public feature entrypoint', () => {
    expect(HMAC_SHA256_LD_V1).toBe('hmac-sha256-ld-v1');
    expect(COMMAND_IDEMPOTENCY_SCOPE).toBe('deploymentId+stableActorId+commandKind+idempotencyKey');
    expect(EFFECT_RECOVERY_CLASSES).toHaveLength(5);
    expect(DURABLE_COMMAND_STATES).toHaveLength(6);
    expect(DURABLE_EFFECT_STATES).toHaveLength(7);
    expect(encodeLengthDelimitedValue({ value: 'public' })).toMatch(/^o:/);
    expect(typeof createCommandDescriptorRegistry).toBe('function');
  });

  it('leaves the compatibility runner source untouched by the additive protocol', () => {
    // This resolves one fixed repository-owned source path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const runnerSource = readFileSync(
      resolve(
        ROOT,
        'src/features/application-command-ledger/core/application/ApplicationCommandRunner.ts'
      ),
      'utf8'
    );
    expect(runnerSource).not.toContain('CommandDescriptorRegistry');
    expect(runnerSource).not.toContain('resolveCommandClaim');
    expect(runnerSource).not.toContain('DurableCommandState');
  });
});
