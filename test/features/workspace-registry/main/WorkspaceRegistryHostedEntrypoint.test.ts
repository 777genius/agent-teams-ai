import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

describe('workspace registry hosted entrypoint', () => {
  it('keeps Fastify exports out of the generic main and feature entrypoints', () => {
    const genericMain = readFileSync(
      resolve(ROOT, 'src/features/workspace-registry/main/index.ts'),
      'utf8'
    );
    const genericFeature = readFileSync(
      resolve(ROOT, 'src/features/workspace-registry/index.ts'),
      'utf8'
    );
    const hostedMain = readFileSync(
      resolve(ROOT, 'src/features/workspace-registry/main/hosted.ts'),
      'utf8'
    );

    for (const source of [genericMain, genericFeature]) {
      expect(source).not.toContain('registerHostedWorkspaceRegistryHttp');
      expect(source).not.toContain('HostedWorkspaceRegistryHttpAdapter');
      expect(source).not.toContain('fastify');
    }
    expect(hostedMain).toContain('registerHostedWorkspaceRegistryHttp');
    expect(hostedMain).toContain('HostedWorkspaceRegistryHttpAdapter');
  });
});
