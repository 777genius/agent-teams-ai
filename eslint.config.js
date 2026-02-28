import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import tailwindcss from 'eslint-plugin-tailwindcss';
import sonarjs from 'eslint-plugin-sonarjs';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import importPlugin from 'eslint-plugin-import';
import security from 'eslint-plugin-security';
import boundaries from 'eslint-plugin-boundaries';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import globals from 'globals';

export default defineConfig([
  // Global ignores
  globalIgnores([
    'dist/**',
    'dist-electron/**',
    'build/**',
    'node_modules/**',
    '*.config.js',
    '*.config.cjs',
    '*.config.ts',
    'out/**',
  ]),

  // Base ESLint recommended rules
  js.configs.recommended,

  // TypeScript-ESLint recommended with type checking + stylistic
  // Using recommended (not strict) for a balanced approach
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // SonarJS - Code quality and bug detection rules
  sonarjs.configs.recommended,

  // Security - Catch common security mistakes in AI-generated code
  security.configs.recommended,

  // TypeScript parser options for type-aware linting
  {
    name: 'typescript-parser-options',
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Import plugin configuration - Main/Preload (uses tsconfig.node.json)
  {
    name: 'import-plugin-main',
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.node.json',
        },
      },
    },
    rules: {
      'import/no-cycle': ['error', { maxDepth: 3, ignoreExternal: true }],
      'import/no-unresolved': 'error',
      'import/no-default-export': 'warn',
    },
  },

  // Import plugin configuration - Renderer (uses tsconfig.json)
  {
    name: 'import-plugin-renderer',
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json',
        },
      },
    },
    rules: {
      'import/no-cycle': ['error', { maxDepth: 3, ignoreExternal: true }],
      'import/no-unresolved': 'error',
      'import/no-default-export': 'warn',
    },
  },

  // Module boundaries - Enforce Electron three-process architecture
  {
    name: 'module-boundaries',
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    plugins: {
      boundaries: boundaries,
    },
    settings: {
      'boundaries/elements': [
        { type: 'main', pattern: 'src/main/**', mode: 'folder' },
        { type: 'preload', pattern: 'src/preload/**', mode: 'folder' },
        { type: 'renderer', pattern: 'src/renderer/**', mode: 'folder' },
        { type: 'shared', pattern: 'src/shared/**', mode: 'folder' },
      ],
      'boundaries/ignore': ['**/*.test.ts', '**/*.spec.ts'],
    },
    rules: {
      // Enforce strict module boundaries for Electron architecture
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            // Renderer can only import from renderer and shared
            { from: 'renderer', allow: ['renderer', 'shared'] },
            // Main process can only import from main and shared
            { from: 'main', allow: ['main', 'shared'] },
            // Preload can only import from preload and shared
            { from: 'preload', allow: ['preload', 'shared'] },
            // Shared can import from shared and main (for type re-exports)
            { from: 'shared', allow: ['shared', 'main'] },
          ],
        },
      ],
      // Prevent importing private modules
      'boundaries/no-private': 'error',
    },
  },

  // ESLint Comments
  {
    name: 'eslint-comments',
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    plugins: {
      '@eslint-community/eslint-comments': eslintComments,
    },
    rules: {
      // Prevents blanket-disabling rules
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
      // Require description for disable comments
      '@eslint-community/eslint-comments/require-description': [
        'error',
        { ignore: [] },
      ],
      // Re-enable rules after disabling
      '@eslint-community/eslint-comments/disable-enable-pair': 'error',
      // No duplicate disable comments
      '@eslint-community/eslint-comments/no-duplicate-disable': 'error',
      // Unused disable comments
      '@eslint-community/eslint-comments/no-unused-disable': 'error',
    },
  },

  // Import sorting for all JS/TS files
  {
    name: 'import-sorting',
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    plugins: {
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            // Side effect imports (e.g., import './styles.css')
            ['^\\u0000'],
            // Node.js builtins (fs, path, etc.)
            ['^node:'],
            // React and related packages
            ['^react', '^react-dom'],
            // External packages from node_modules
            ['^@?\\w'],
            // Internal aliases (@/ paths)
            ['^@/'],
            // Parent imports (../)
            ['^\\.\\.(?!/?$)', '^\\.\\./?$'],
            // Same-folder imports (./)
            ['^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$'],
            // Type imports
            ['^.+\\u0000$'],
          ],
        },
      ],
      'simple-import-sort/exports': 'error',
    },
  },

  // Main process (Electron Node.js)
  {
    name: 'electron-main',
    files: ['src/main/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Allow console in main process for logging
      'no-console': 'off',
    },
  },

  // Preload script (Electron bridge)
  {
    name: 'electron-preload',
    files: ['src/preload/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },

  // Renderer process (React + A11y + Tailwind)
  {
    name: 'renderer-react',
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
      tailwindcss: tailwindcss,
    },
    settings: {
      react: {
        version: 'detect',
      },
      tailwindcss: {
        // Tailwind config path (relative to cwd)
        config: 'tailwind.config.js',
        // Allow custom classnames (e.g., from CSS modules)
        callees: ['classnames', 'clsx', 'cn'],
      },
    },
    rules: {
      // React recommended rules
      ...reactPlugin.configs.recommended.rules,
      // JSX runtime (React 17+) - no need to import React
      ...reactPlugin.configs['jsx-runtime'].rules,
      // React Hooks rules
      ...reactHooks.configs.recommended.rules,
      // Accessibility rules (recommended)
      ...jsxA11y.configs.recommended.rules,
      // Tailwind CSS rules
      ...tailwindcss.configs.recommended.rules,

      // React Refresh for HMR
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // Disable prop-types since we use TypeScript
      'react/prop-types': 'off',

      // A11y rule adjustments for this project
      // Allow click handlers on divs when keyboard handlers also present
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/no-static-element-interactions': 'warn',
      // Allow autofocus for search inputs in desktop apps
      'jsx-a11y/no-autofocus': 'off',

      // Tailwind CSS rule adjustments
      // Warn on class order (Prettier plugin handles sorting)
      'tailwindcss/classnames-order': 'off', // Prettier plugin handles this
      // Warn on conflicting classes
      'tailwindcss/no-contradicting-classname': 'error',
      // Warn on custom classnames that don't exist
      'tailwindcss/no-custom-classname': 'warn',

      // === React-Specific Rules ===
      // Consistent component definition
      'react/function-component-definition': [
        'error',
        {
          namedComponents: 'arrow-function',
          unnamedComponents: 'arrow-function',
        },
      ],

      // Strengthen exhaustive-deps
      'react-hooks/exhaustive-deps': 'error',

      // Prevent prop spreading
      'react/jsx-props-no-spreading': [
        'warn',
        {
          exceptions: ['input', 'button', 'Input', 'Button', 'textarea', 'select'],
        },
      ],

      // Ensure key props
      'react/jsx-key': [
        'error',
        {
          checkFragmentShorthand: true,
          checkKeyMustBeforeSpread: true,
        },
      ],

      // Prevent unnecessary fragments
      'react/jsx-no-useless-fragment': 'warn',

      // Self-closing components for consistency
      'react/self-closing-comp': [
        'error',
        {
          component: true,
          html: true,
        },
      ],
    },
  },

  // Test files
  {
    name: 'test-files',
    files: ['test/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: false,
        project: './tsconfig.json',
      },
    },
    rules: {
      // Relax TypeScript strict rules for tests
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',

      // Relax function/export rules for tests
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',

      // Relax naming conventions for tests (allow describe, it, expect patterns)
      '@typescript-eslint/naming-convention': 'off',

      // Allow magic numbers in tests
      'sonarjs/no-hardcoded-ip': 'off',

      // Allow floating promises in tests (common with async test helpers)
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  // Custom rule overrides for all TypeScript files
  {
    name: 'custom-rules',
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // === Core JavaScript rules ===
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // === TypeScript Import/Export rules ===
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
      '@typescript-eslint/consistent-type-exports': [
        'error',
        { fixMixedExportsWithInlineTypeSpecifier: true },
      ],

      // === Unused variables ===
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // === Relaxed strict rules for practical use ===
      // Allow empty functions (useful for callbacks and stubs)
      '@typescript-eslint/no-empty-function': 'off',

      // Allow numbers/booleans in template literals (common pattern)
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowNumber: true,
          allowBoolean: true,
          allowNullish: false,
        },
      ],

      // Allow async functions without await (IPC handlers often need this)
      '@typescript-eslint/require-await': 'off',

      // Allow floating promises in event handlers (common in Electron)
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          ignoreVoid: true,
          ignoreIIFE: true,
        },
      ],

      // Allow promises in places that don't expect them (event handlers)
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: {
            attributes: false,
            arguments: false,
          },
        },
      ],

      // Allow void expression in arrow functions shorthand
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        {
          ignoreArrowShorthand: true,
          ignoreVoidOperator: true,
        },
      ],

      // Prefer nullish coalescing but don't error on logical or
      '@typescript-eslint/prefer-nullish-coalescing': 'off',

      // Allow inferrable types (style preference)
      '@typescript-eslint/no-inferrable-types': 'off',

      // === Anti-Hallucination Rules ===
      // Explicit return types
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
          allowDirectConstAssertionInArrowFunctions: true,
        },
      ],

      // Explicit types for exported functions (minimum requirement)
      '@typescript-eslint/explicit-module-boundary-types': 'warn',

      // Prevent variable shadowing
      '@typescript-eslint/no-shadow': 'error',

      // === Naming Conventions ===
      '@typescript-eslint/naming-convention': [
        'warn',
        // Imports can be camelCase or PascalCase (React, ReactDOM, App, etc.)
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
        // Default: variables and parameters in camelCase
        {
          selector: 'default',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
        },
        // Static readonly class properties can be UPPER_CASE
        {
          selector: 'classProperty',
          modifiers: ['static', 'readonly'],
          format: ['camelCase', 'UPPER_CASE'],
        },
        // Variables: camelCase or UPPER_CASE for constants
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        // Functions: camelCase (includes type guards like isXxx, builders like buildXxx)
        {
          selector: 'function',
          format: ['camelCase', 'PascalCase'],
        },
        // Parameters: camelCase, allow leading underscore for unused
        {
          selector: 'parameter',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
        },
        // Types and interfaces in PascalCase
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        // Interfaces should NOT start with I (modern convention)
        {
          selector: 'interface',
          format: ['PascalCase'],
          custom: { regex: '^I[A-Z]', match: false },
        },
        // Enum members in PascalCase or UPPER_CASE
        {
          selector: 'enumMember',
          format: ['PascalCase', 'UPPER_CASE'],
        },
        // Object literal properties: allow any format (for API compatibility)
        {
          selector: 'objectLiteralProperty',
          format: null,
        },
        // Type properties: allow any format (for type definitions matching APIs)
        {
          selector: 'typeProperty',
          format: null,
        },
      ],

      // === Import Restrictions ===
      // Note: boundaries/element-types handles main/renderer separation
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            // Prevent deep relative imports - use @/ aliases
            {
              group: ['../**/..'],
              message: 'Avoid deep relative imports, use @/ aliases',
            },
          ],
        },
      ],

      // === Mutation Prevention ===
      'no-param-reassign': [
        'error',
        {
          props: true,
          ignorePropertyModificationsFor: ['draft', 'acc', 'ctx', 'state', 'req', 'res'],
        },
      ],

      // === SonarJS rule adjustments ===
      // Cognitive complexity - warn instead of error for gradual adoption
      'sonarjs/cognitive-complexity': 'off',
      // Allow some duplication in similar but not identical code
      'sonarjs/no-duplicate-string': 'off',
      // Relax for Electron IPC patterns (many similar switch cases)
      'sonarjs/no-small-switch': 'off',
      // Allow nested ternaries in JSX (common React pattern)
      'sonarjs/no-nested-conditional': 'off',

      // === Security rule adjustments (Code Protection) ===
      // These catch common security mistakes
      'security/detect-eval-with-expression': 'error',
      // Disabled: This is a desktop file reader app - file system access is expected
      'security/detect-non-literal-fs-filename': 'off',
      // Disabled: Dynamic patterns are intentional in this app
      'security/detect-non-literal-regexp': 'off',
      // Disabled: Often false positives with typed code
      'security/detect-object-injection': 'off',
      'security/detect-child-process': 'warn',
      'security/detect-non-literal-require': 'warn',
      'security/detect-possible-timing-attacks': 'warn',
    },
  },

  // === IMPORTANT: eslint-config-prettier MUST be LAST ===
  // This disables all ESLint rules that conflict with Prettier
  // Prettier handles formatting, ESLint handles code quality
  eslintConfigPrettier,
]);
