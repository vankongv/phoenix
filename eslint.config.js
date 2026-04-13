import eslintPluginAstro from 'eslint-plugin-astro';
import tsParser from '@typescript-eslint/parser';
import js from '@eslint/js';

/** Browser globals available in all client-side JS/TS/Astro scripts. */
const browserGlobals = {
  document: 'readonly',
  window: 'readonly',
  localStorage: 'readonly',
  fetch: 'readonly',
  AbortSignal: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  requestAnimationFrame: 'readonly',
  console: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  navigator: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  EventSource: 'readonly',
  MutationObserver: 'readonly',
  CustomEvent: 'readonly',
  TextDecoder: 'readonly',
  crypto: 'readonly',
  // CDN-loaded library (loaded via <script> tag in index.astro)
  lucide: 'readonly',
};

export default [
  // Base JS recommended rules
  js.configs.recommended,

  // Astro files — uses astro-eslint-parser which handles <script> blocks
  // (including TypeScript). Type checking for .astro is handled by `astro check`.
  ...eslintPluginAstro.configs.recommended,

  // JS/TS source files
  {
    files: ['src/**/*.{js,ts,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: browserGlobals,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      // Empty catch blocks are used intentionally throughout (fire-and-forget patterns)
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Astro component scripts — wire TypeScript parser for <script> blocks inside .astro files
  // (astro-eslint-parser is already set by the recommended config above;
  //  parserOptions.parser tells it which parser to use for the script block contents)
  {
    files: ['src/**/*.astro'],
    languageOptions: {
      globals: browserGlobals,
      parserOptions: {
        parser: tsParser,
        extraFileExtensions: ['.astro'],
      },
    },
    rules: {
      // astro check owns type errors; ESLint only catches logic issues here
      'no-undef': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Ignore generated/dependency directories
  {
    ignores: [
      'dist/',
      '.astro/',
      'node_modules/',
      'public/',
      'src/**/*.d.ts', // TypeScript declaration files — checked by astro check, not ESLint
    ],
  },
];
