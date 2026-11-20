import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules'] },
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
  prettier,
);
