import importPlugin from 'eslint-plugin-import';

import type { Linter } from 'eslint';

const RUNTIME_LAYER_IMPORTS = [
  '@main',
  '@main/**',
  '@renderer',
  '@renderer/**',
  '@preload',
  '@preload/**',
  '@features/review-flow/main',
  '@features/review-flow/main/**',
  '@features/review-flow/preload',
  '@features/review-flow/preload/**',
  '@features/review-flow/renderer',
  '@features/review-flow/renderer/**',
  'electron',
  'fs',
  'node:fs',
  'path',
  'node:path',
];

/**
 * Architecture guard rails of the review-flow feature (see docs/FEATURE_ARCHITECTURE_STANDARD.md).
 *
 * The public-entrypoint rule uses `import/no-internal-modules` on purpose: a second
 * `no-restricted-imports` block over `src/**` would replace the repository-wide restrictions.
 */
export const reviewFlowBoundaries: Linter.Config[] = [
  {
    name: 'review-flow-public-entrypoints',
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/features/review-flow/**'],
    plugins: { import: importPlugin },
    rules: {
      'import/no-internal-modules': [
        'error',
        {
          forbid: [
            '**/review-flow/core/**',
            // The import rule also resolves public barrels to their index.ts files.
            '**/review-flow/{contracts,main,preload,renderer}/!(index|index.ts){,/**}',
            '**/review-flow/{contracts,main,preload,renderer}/*/*/**',
          ],
        },
      ],
    },
  },
  {
    name: 'review-flow-core',
    files: ['src/features/review-flow/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: RUNTIME_LAYER_IMPORTS,
              message:
                'review-flow core stays free of adapters, platform and file-system code; reach storage only through application ports.',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'review-flow-preload',
    files: ['src/features/review-flow/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@main',
                '@main/**',
                '@renderer',
                '@renderer/**',
                '@features/review-flow/main',
                '@features/review-flow/main/**',
                '@features/review-flow/core/**',
              ],
              message: 'review-flow preload may depend only on contracts.',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'review-flow-renderer',
    files: ['src/features/review-flow/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@main',
                '@main/**',
                '@preload',
                '@preload/**',
                '@features/review-flow/main',
                '@features/review-flow/main/**',
                '@features/review-flow/preload',
                '@features/review-flow/preload/**',
                'electron',
              ],
              message:
                'review-flow renderer may depend only on contracts, the pure core/domain rules and renderer code.',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'review-flow-renderer-ui',
    files: ['src/features/review-flow/renderer/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@main',
                '@main/**',
                '@preload',
                '@preload/**',
                '@renderer/store',
                '@renderer/store/**',
                '@features/review-flow/main',
                '@features/review-flow/main/**',
                '@features/review-flow/preload',
                '@features/review-flow/preload/**',
                'electron',
              ],
              message:
                'review-flow ui components stay store-free: reach the app store through hooks in renderer/state.',
            },
          ],
        },
      ],
    },
  },
];
