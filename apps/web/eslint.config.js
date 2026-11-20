import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Mẫu phát hiện màu cứng. Dùng trong selector esquery nên không chứa dấu "/".
const COLOR_PATTERNS = [
  ['#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9A-Za-z_-])', 'mã màu #hex'],
  ['\\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix)\\(', 'hàm màu CSS'],
  [
    '\\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|shadow|accent|caret|divide|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(?:-[0-9]{2,3})?\\b',
    'màu palette Tailwind',
  ],
  ['-\\[(?:#|rgb|hsl|oklch)', 'màu arbitrary Tailwind'],
];
const colorRules = (tpl) =>
  COLOR_PATTERNS.map(([re, what]) => ({
    selector: tpl.replace('RE', re),
    message: `Không dùng ${what} trong component: dùng token màu (xem design/docs/README.md).`,
  }));

export default tseslint.config(
  {
    ignores: [
      'dist',
      'dist-demo',
      'coverage',
      'node_modules',
      'playwright-report',
      'test-results',
      'src/api/generated',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Bảo mật: cấm chèn HTML thô (XSS). Dùng component/escape thay thế.
      'react/no-danger': 'error',
      'react/no-danger-with-children': 'error',
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Không gán innerHTML (XSS).' },
        { property: 'outerHTML', message: 'Không gán outerHTML (XSS).' },
      ],
      'no-eval': 'error',
      'no-implied-eval': 'error',
    },
  },
  {
    // Không màu hard-code: chỉ dùng token (design/tokens/tokens.json → bg-surface, text-danger-text…).
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...colorRules('Literal[value=/RE/]'),
        ...colorRules('TemplateElement[value.raw=/RE/]'),
      ],
    },
  },
  {
    // Portal và phần dùng chung không được chạm Admin API (ranh giới realm của contracts).
    files: ['src/entries/portal/**', 'src/shared/**', 'src/ui/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/api/admin',
                '@/api/generated/admin/*',
                '**/api/admin',
                '**/generated/admin/*',
              ],
              message: 'Portal/shared không được dùng Admin API.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'e2e/**', 'e2e-real/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
    rules: { '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }] },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
