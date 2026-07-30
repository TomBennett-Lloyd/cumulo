import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // .claude/worktrees holds agent git worktrees; their unbuilt deps make type-aware rules
    // report phantom errors. Gitignoring is not enough here: eslint flat config never reads
    // .gitignore (Prettier does, so .gitignore alone covers format:check). Keep both entries.
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '.claude/worktrees/**'],
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@eslint-community/eslint-comments': eslintComments,
    },
    rules: {
      // Suppressions are themselves errors: fix root causes (docs/standards/typing.md).
      '@eslint-community/eslint-comments/no-use': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': true,
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // The dependency array is never the knob (docs/standards/react.md).
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
