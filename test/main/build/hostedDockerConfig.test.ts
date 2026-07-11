import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface PackageJson {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

describe('hosted Docker config', () => {
  const dockerfile = readFileSync(resolve(process.cwd(), 'docker/Dockerfile'), 'utf-8');
  const rootDockerignore = readFileSync(resolve(process.cwd(), '.dockerignore'), 'utf-8');
  const dockerDockerignore = readFileSync(resolve(process.cwd(), 'docker/.dockerignore'), 'utf-8');
  const compose = readFileSync(resolve(process.cwd(), 'docker/docker-compose.yml'), 'utf-8');
  const packageJson = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')
  ) as PackageJson;

  function terminalPlatformFileDependencies(): string[] {
    return Object.values(packageJson.dependencies ?? {})
      .filter((specifier) => specifier.startsWith('file:vendor/terminal-platform/'))
      .map((specifier) => specifier.slice('file:'.length))
      .sort();
  }

  function copySourcesBeforeInstall(): string[] {
    const installIndex = dockerfile.indexOf('RUN pnpm install --frozen-lockfile');
    expect(installIndex).toBeGreaterThan(0);

    return dockerfile
      .slice(0, installIndex)
      .split('\n')
      .flatMap((line) => {
        const copyMatch = /^COPY\s+(?!.*--from=)(.+)$/.exec(line.trim());
        if (!copyMatch) return [];
        const copyArgs = copyMatch[1].trim().split(/\s+/);
        return copyArgs.slice(0, -1);
      });
  }

  function isCoveredByCopySource(dependencyPath: string, copySource: string): boolean {
    return dependencyPath === copySource || dependencyPath.startsWith(`${copySource}/`);
  }

  function dockerignoreLines(contents: string): string[] {
    return contents
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  }

  it('builds only the hosted static shell output by default', () => {
    expect(dockerfile).toContain('pnpm hosted:build');
    expect(dockerfile).toContain('COPY --from=builder /app/dist-hosted ./dist-hosted');
    expect(dockerfile).toContain('CMD ["node", "dist-hosted/server.cjs"]');
    expect(dockerfile).not.toContain('dist-standalone');
    expect(dockerfile).not.toContain('CLAUDE_ROOT');
  });

  it('copies all package.json file: vendor artifacts before frozen install', () => {
    const vendorDependencies = terminalPlatformFileDependencies();
    const dependencyLayerCopySources = copySourcesBeforeInstall();

    expect(vendorDependencies).toEqual([
      'vendor/terminal-platform/sdk/terminal-platform-design-tokens-0.1.0.tgz',
      'vendor/terminal-platform/sdk/terminal-platform-foundation-0.1.0.tgz',
      'vendor/terminal-platform/sdk/terminal-platform-runtime-types-0.1.0.tgz',
      'vendor/terminal-platform/sdk/terminal-platform-workspace-adapter-websocket-0.1.0.tgz',
      'vendor/terminal-platform/sdk/terminal-platform-workspace-contracts-0.1.0.tgz',
      'vendor/terminal-platform/sdk/terminal-platform-workspace-core-0.1.0.tgz',
      'vendor/terminal-platform/sdk/terminal-platform-workspace-elements-0.1.0.tgz',
      'vendor/terminal-platform/sdk/terminal-platform-workspace-gateway-node-0.1.0.tgz',
      'vendor/terminal-platform/sdk/terminal-platform-workspace-react-0.1.0.tgz',
      'vendor/terminal-platform/terminal-platform-node-stub',
    ]);
    expect(dependencyLayerCopySources).toEqual(
      expect.arrayContaining([
        'vendor/terminal-platform/sdk',
        'vendor/terminal-platform/terminal-platform-node-stub',
      ])
    );
    for (const dependencyPath of vendorDependencies) {
      expect(
        dependencyLayerCopySources.some((copySource) =>
          isCoveredByCopySource(dependencyPath, copySource)
        )
      ).toBe(true);
    }
  });

  it('copies package install lifecycle scripts before frozen install', () => {
    const dependencyLayerCopySources = copySourcesBeforeInstall();
    const lifecycleScripts = [
      packageJson.scripts?.preinstall,
      packageJson.scripts?.postinstall,
    ].filter((script): script is string => Boolean(script));
    const lifecycleScriptPaths = lifecycleScripts.flatMap((script) =>
      Array.from(script.matchAll(/node\s+\.\/(scripts\/[^\s;]+)/g), (match) => match[1])
    );

    expect(lifecycleScriptPaths).toEqual([
      'scripts/ci/enforce-pnpm-install.mjs',
      'scripts/ensure-electron-install.cjs',
    ]);
    for (const scriptPath of lifecycleScriptPaths) {
      expect(
        dependencyLayerCopySources.some((copySource) =>
          isCoveredByCopySource(scriptPath, copySource)
        )
      ).toBe(true);
    }
  });

  it('keeps vendor artifacts available in Docker build contexts', () => {
    for (const dockerignore of [rootDockerignore, dockerDockerignore]) {
      const ignoredPaths = dockerignoreLines(dockerignore);
      expect(ignoredPaths).not.toContain('vendor');
      expect(ignoredPaths).not.toContain('vendor/');
      expect(ignoredPaths).not.toContain('vendor/terminal-platform');
      expect(ignoredPaths).not.toContain('vendor/terminal-platform/');
    }
  });

  it('defaults to loopback and keeps Docker host exposure opt-in', () => {
    expect(dockerfile).toContain('ENV HOST=127.0.0.1');
    expect(compose).toContain('HOST=127.0.0.1');
    expect(compose).toContain('profiles:');
    expect(compose).toContain('- local');
    expect(compose).toContain('127.0.0.1:3456:3456');
    expect(compose).toContain('HOSTED_ALLOW_REMOTE=1');
    expect(compose).toContain('publishes no host port');
    expect(compose).toContain('Remote exposure requires');
    expect(compose).not.toContain('/data/.claude');
  });
});
