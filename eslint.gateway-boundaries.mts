import importPlugin from 'eslint-plugin-import';

import type { Linter } from 'eslint';

const runtimeLayers = [
  '@main/**',
  '@renderer/**',
  '@preload/**',
  '@features/*/main',
  '@features/*/main/**',
  '@features/*/renderer',
  '@features/*/renderer/**',
  '@features/*/preload',
  '@features/*/preload/**',
  '**/main/**',
  '**/preload/**',
  '**/renderer/**',
  'electron',
  'fastify',
  'child_process',
  'node:child_process',
  'fs',
  'fs/**',
  'node:fs',
  'node:fs/**',
  'http',
  'https',
  'node:http',
  'node:https',
];

const rendererRestrictedImports = [
  '@main/**',
  '@preload/**',
  '@renderer/store',
  '@renderer/store/**',
  '@features/*/main',
  '@features/*/main/**',
  '**/main/**',
  '**/preload/**',
  '**/core/**',
  'electron',
];

export const gatewayBoundaries: Linter.Config[] = [
  {
    name: 'gateway-provider-public-entrypoints',
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/features/gateway-provider/**'],
    plugins: { import: importPlugin },
    rules: {
      'import/no-internal-modules': [
        'error',
        {
          forbid: [
            '**/gateway-provider/core/**',
            // The import rule also resolves public barrels to their index.ts files.
            '**/gateway-provider/{contracts,main,preload,renderer}/!(index|index.ts){,/**}',
            '**/gateway-provider/{contracts,main,preload,renderer}/*/*/**',
          ],
        },
      ],
    },
  },
  ...(['domain', 'application'] as const).map(
    (layer): Linter.Config => ({
      name: `gateway-provider-core-${layer}`,
      files: [`src/features/gateway-provider/core/${layer}/**/*.ts`],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  ...runtimeLayers,
                  ...(layer === 'domain'
                    ? ['@features/gateway-provider/core/application/**', '**/application/**']
                    : []),
                ],
                message:
                  'Gateway core must depend on pure domain/contracts/ports, not runtime layers.',
              },
            ],
          },
        ],
      },
    })
  ),
  {
    name: 'gateway-provider-preload',
    files: ['src/features/gateway-provider/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@main/**',
                '@renderer/**',
                '@features/*/main',
                '@features/*/main/**',
                '**/main/**',
                '**/renderer/**',
                '**/core/**',
              ],
              message: 'Gateway preload may import contracts and bridge helpers only.',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'gateway-provider-renderer',
    files: ['src/features/gateway-provider/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: rendererRestrictedImports,
              message:
                'Gateway renderer uses its feature API adapter and contracts, not main or app stores.',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'gateway-provider-renderer-ui',
    files: ['src/features/gateway-provider/renderer/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [...rendererRestrictedImports, '@renderer/api', '@renderer/api/**'],
              message:
                'Gateway UI must use its feature adapter instead of app transport or stores.',
            },
          ],
        },
      ],
    },
  },
];
