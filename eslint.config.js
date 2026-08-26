import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Globals that must never appear in packages/renderer.
 * CLAUDE.md: "`renderFrame` stays pure. No DOM APIs, no `window`/`document`, no async,
 * no fetch. It must run unchanged under `@napi-rs/canvas` in Node."
 */
const FORBIDDEN_IN_RENDERER = [
  'window',
  'document',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
  'fetch',
  'XMLHttpRequest',
  'requestAnimationFrame',
  'setTimeout',
  'setInterval',
  'queueMicrotask',
  'process',
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      'fixtures/**',
      'out.png',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // CLAUDE.md: "No `any`, no `@ts-ignore`."
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // Allows the omit-via-destructure idiom (`const { drop: _drop, ...rest } = x`)
      // and deliberately-unused `_`-prefixed parameters.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-console': 'off',
    },
  },
  {
    // The renderer purity guard. Breaking this breaks M8 (server-side video export).
    files: ['packages/renderer/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...FORBIDDEN_IN_RENDERER.map((name) => ({
          name,
          message:
            'packages/renderer must stay pure and run unchanged under @napi-rs/canvas in Node (CLAUDE.md).',
        })),
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'AwaitExpression',
          message: 'renderFrame must be synchronous (CLAUDE.md: "no async").',
        },
        {
          selector: 'FunctionDeclaration[async=true]',
          message: 'renderFrame must be synchronous (CLAUDE.md: "no async").',
        },
        {
          selector: 'ArrowFunctionExpression[async=true]',
          message: 'renderFrame must be synchronous (CLAUDE.md: "no async").',
        },
        {
          selector: 'ImportDeclaration[source.value=/@trade-replay\\u002Fadapters/]',
          message:
            'Adapters never leak: packages/renderer must not import from packages/adapters (CLAUDE.md).',
        },
      ],
    },
  },
  {
    // "Adapters never leak" — packages/core must not know a venue exists.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportDeclaration[source.value=/@trade-replay\\u002Fadapters/]',
          message:
            'packages/core must not import from packages/adapters (CLAUDE.md: "Adapters never leak").',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
