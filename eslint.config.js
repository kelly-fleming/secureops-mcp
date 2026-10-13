import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', '.codex/**', 'codex_cycle_logs/**'],
  },
  {
    files: [
      'src/**/*.ts',
      'tests/**/*.ts',
      'scripts/**/*.ts',
      'eslint.config.js',
      'vitest.config.ts',
    ],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
]);
