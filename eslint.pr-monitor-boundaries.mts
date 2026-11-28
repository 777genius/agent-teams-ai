import importPlugin from 'eslint-plugin-import';

import { gatewayPublicImports } from './eslint.gateway-boundaries.mts';
import { reviewFlowPublicImports } from './eslint.review-flow-boundaries.mts';

import type { Linter } from 'eslint';

const prMonitorPublicImports = [
  '**/pr-monitor/core/**',
  '**/pr-monitor/{contracts,main,preload,renderer}/!(index|index.ts){,/**}',
  '**/pr-monitor/{contracts,main,preload,renderer}/*/*/**',
];
const runtime = [
  '@main',
  '@main/**',
  '@renderer',
  '@renderer/**',
  '@preload',
  '@preload/**',
  '@features/*/main',
  '@features/*/main/**',
  '@features/*/preload',
  '@features/*/preload/**',
  '@features/*/renderer',
  '@features/*/renderer/**',
  '**/main',
  '**/main/**',
  '**/preload',
  '**/preload/**',
  '**/renderer',
  '**/renderer/**',
  'electron',
  'fastify',
  'node:*',
  'fs',
  'fs/**',
  'child_process',
  'http',
  'https',
  'react',
  'react-dom',
  'react-dom/**',
];
const guard = (name: string, files: string[], group: string[], message: string): Linter.Config => ({
  name,
  files,
  rules: { 'no-restricted-imports': ['error', { patterns: [{ group, message }] }] },
});
const privateImports = new Map([
  ['gateway-provider', gatewayPublicImports],
  ['review-flow', reviewFlowPublicImports],
  ['pr-monitor', prMonitorPublicImports],
]);

export const prMonitorBoundaries: Linter.Config[] = [
  // Compose the existing rule, instead of replacing either previous feature guard.
  ...['shell', ...privateImports.keys()].map(
    (owner): Linter.Config => ({
      name: `feature-public-entrypoints-for-${owner}`,
      files: owner === 'shell' ? ['src/**/*.{ts,tsx}'] : [`src/features/${owner}/**/*.{ts,tsx}`],
      ...(owner === 'shell'
        ? { ignores: [...privateImports.keys()].map((feature) => `src/features/${feature}/**`) }
        : {}),
      plugins: { import: importPlugin },
      rules: {
        'import/no-internal-modules': [
          'error',
          {
            forbid: [...privateImports]
              .filter(([feature]) => feature !== owner)
              .flatMap(([, patterns]) => patterns),
          },
        ],
      },
    })
  ),
  guard(
    'pr-monitor-core',
    ['src/features/pr-monitor/core/**/*.ts'],
    runtime,
    'PR Monitor core uses pure contracts and application ports, never runtime adapters.'
  ),
  guard(
    'pr-monitor-preload',
    ['src/features/pr-monitor/preload/**/*.ts'],
    [
      '@main',
      '@main/**',
      '@renderer',
      '@renderer/**',
      '@features/*/main',
      '@features/*/main/**',
      '**/main',
      '**/main/**',
      '**/renderer',
      '**/renderer/**',
      '**/core',
      '**/core/**',
    ],
    'PR Monitor preload exposes validated contracts only.'
  ),
  guard(
    'pr-monitor-renderer',
    ['src/features/pr-monitor/renderer/**/*.{ts,tsx}'],
    [
      '@main',
      '@main/**',
      '@preload',
      '@preload/**',
      '@features/*/main',
      '@features/*/main/**',
      '**/main',
      '**/main/**',
      '**/preload',
      '**/preload/**',
      '**/core',
      '**/core/**',
      'electron',
      'node:*',
      '!@pr-monitor/core',
    ],
    'PR Monitor renderer accesses its host through the shared app API.'
  ),
  guard(
    'pr-monitor-ui',
    ['src/features/pr-monitor/renderer/ui/**/*.{ts,tsx}'],
    [
      '@main',
      '@main/**',
      '@preload',
      '@preload/**',
      '@features/*/main',
      '@features/*/main/**',
      '**/main',
      '**/main/**',
      '**/preload',
      '**/preload/**',
      '**/core',
      '**/core/**',
      '@renderer/api',
      '@renderer/api/**',
      '@renderer/store',
      '@renderer/store/**',
      'electron',
      'node:*',
      '!@pr-monitor/core',
    ],
    'PR Monitor UI remains presentational; hooks own API and store access.'
  ),
];
