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
    files: ['runtime/test/**/*.ts'],
    rules: {
      // node:test owns the returned registration promise.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
)
