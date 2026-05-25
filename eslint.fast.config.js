import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import importPlugin from 'eslint-plugin-import';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';
import tailwindcss from 'eslint-plugin-tailwindcss';
import globals from 'globals';

export default defineConfig([
  {
    name: 'fast-linter-options',
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },

  globalIgnores([
    'dist/**',
    'dist-electron/**',
    'build/**',
    'node_modules/**',
    'out/**',
    'landing/.nuxt/**',
  ]),

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    name: 'fast-known-plugin-namespaces',
    plugins: {
      boundaries,
      import: importPlugin,
      security,
      sonarjs,
      tailwindcss,
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'warn',
      'no-control-regex': 'warn',
      'no-unsafe-finally': 'warn',
      'no-useless-escape': 'warn',
    },
  },

  {
    name: 'fast-typescript',
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: false,
      },
    },
    rules: {
      'no-undef': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  {
    name: 'fast-imports',
    files: ['src/**/*.{js,jsx,ts,tsx}', 'test/**/*.{ts,tsx}', 'packages/agent-graph/src/**/*.{ts,tsx}'],
    plugins: {
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            ['^\\u0000'],
            ['^node:'],
            ['^react', '^react-dom'],
            ['^@?\\w'],
            ['^@/'],
            ['^\\.\\.(?!/?$)', '^\\.\\./?$'],
            ['^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$'],
            ['^.+\\u0000$'],
          ],
        },
      ],
      'simple-import-sort/exports': 'error',
    },
  },

  {
    name: 'fast-node-globals',
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'scripts/**/*.{js,mjs,ts}', 'test/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  {
    name: 'fast-browser-globals',
    files: ['src/renderer/**/*.{ts,tsx}', 'src/features/**/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  {
    name: 'fast-react',
    files: ['src/renderer/**/*.{tsx,ts}', 'src/features/**/renderer/**/*.{tsx,ts}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'react/prop-types': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/globals': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/immutability': 'off',
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/no-static-element-interactions': 'warn',
      'jsx-a11y/label-has-associated-control': 'warn',
      'jsx-a11y/no-noninteractive-tabindex': 'warn',
      'jsx-a11y/no-autofocus': 'off',
      'react/function-component-definition': [
        'warn',
        {
          namedComponents: 'arrow-function',
          unnamedComponents: 'arrow-function',
        },
      ],
      'react/jsx-key': [
        'error',
        {
          checkFragmentShorthand: true,
          checkKeyMustBeforeSpread: true,
        },
      ],
      'react/self-closing-comp': ['error', { component: true, html: true }],
    },
  },

  {
    name: 'fast-feature-entrypoints',
    files: [
      'src/main/**/*.{ts,tsx}',
      'src/preload/**/*.{ts,tsx}',
      'src/renderer/**/*.{ts,tsx}',
      'src/shared/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@features/*/contracts/*',
                '@features/*/core/**',
                '@features/*/main/*',
                '@features/*/preload/*',
                '@features/*/renderer/*',
              ],
              message: 'Import feature public entrypoints only.',
            },
          ],
        },
      ],
    },
  },

  {
    name: 'fast-feature-core-guards',
    files: ['src/features/*/core/{domain,application}/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'Feature core must stay Electron-free.' },
            { name: 'fastify', message: 'Feature core must stay transport-free.' },
            { name: 'child_process', message: 'Feature core must not spawn processes directly.' },
            {
              name: 'node:child_process',
              message: 'Feature core must not spawn processes directly.',
            },
          ],
          patterns: [
            {
              group: ['@main/*', '@preload/*', '@renderer/*'],
              message: 'Feature core must stay process-agnostic.',
            },
            {
              group: ['@features/*/main/**', '@features/*/preload/**', '@features/*/renderer/**'],
              message: 'Feature core must not import runtime or transport layers.',
            },
          ],
        },
      ],
    },
  },

  {
    name: 'fast-feature-renderer-ui-guards',
    files: ['src/features/*/renderer/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@renderer/api', message: 'renderer/ui must stay presentational.' },
            { name: '@renderer/store', message: 'renderer/ui must stay store-free.' },
            { name: 'electron', message: 'renderer/ui must stay Electron-free.' },
          ],
          patterns: [
            { group: ['@main/*'], message: 'renderer/ui must not import main modules.' },
            { group: ['@renderer/store/*'], message: 'renderer/ui must stay store-free.' },
          ],
        },
      ],
    },
  },
]);
