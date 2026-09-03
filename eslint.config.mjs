import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'thirdparty/**',
      '.worktrees/**',
      'desktop/ambient-orb/build/**',
    ],
  },
  {
    files: ['runtime/**/*.ts'],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    // Spec 07 R1: core never imports a concrete executor package. Composition roots and the
    // registry are the only exceptions.
    files: ['runtime/src/**/*.ts'],
    ignores: [
      'runtime/src/executors/**',
      'runtime/src/cli.ts',
      'runtime/src/desktop-entry.ts',
      'runtime/src/production-realtime-assembly.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/executors/*/**', '**/executors/*/index.js'],
          message: 'core must not import an executor package; route through ports or the executors/index.js registry',
        }],
      }],
    },
  },
  {
    // Spec 07 R3: executor packages never reach into the conversation layer.
    files: ['runtime/src/executors/*/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/realtime/**', '**/desktop*', '**/*-assembly*'],
          message: 'executor packages must not import realtime/, desktop*, or assemblies; depend on ports.ts',
        }],
      }],
    },
  },
  {
    files: ['runtime/test/**/*.ts'],
    rules: {
      // node:test owns the returned registration promise.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
)
