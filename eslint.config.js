import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', '.claude-worktrees/**', 'run-log.json'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Would have caught the dead `branch` param behind CRITIQUE #6.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Best-effort cleanup blocks (worktree/git) intentionally swallow errors.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
