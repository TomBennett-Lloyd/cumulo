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

      /*
       * Context-free units (docs/standards/structure.md).
       *
       * func-style: functions are arrow constants — including React components,
       * which get no exemption. no-use-before-define then forces definition
       * order to follow dependencies (arrow constants do not hoist their value,
       * so a declaration-order bug here is a TDZ crash at runtime, not a style
       * quibble); the accepted consequence is that helpers read above the public
       * API. The base `no-use-before-define` is enabled by no preset here, so
       * the TS-aware rule needs no `'no-use-before-define': 'off'` companion.
       *
       * max-lines counts *code* lines: this codebase comments heavily and
       * deliberately, and a raw-line ceiling would tax the comments rather than
       * the complexity. At 300 code lines every production source file on main
       * already passed when the rule landed — it codifies existing practice.
       *
       * @typescript-eslint/unbound-method (inject the object, not the detached
       * method) is deliberately NOT listed: strictTypeChecked above already sets
       * it to 'error', and a local restatement would silently mask the day the
       * preset drops it.
       */
      'func-style': ['error', 'expression'],
      '@typescript-eslint/no-use-before-define': 'error',
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Hooks are not a JSX-only concern: a custom hook authored in a plain .ts
    // file (no JSX, so no .tsx) breaks the same rules in the same ways, and
    // scoping to .tsx left those files silently unlinted (#94).
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // The dependency array is never the knob (docs/standards/react.md).
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    /*
     * Frontend gate (CLAUDE.md): UI code consumes design tokens only. Raw
     * colours and inline styles are caught here; the CSS half of the same rule
     * lives in stylelint.config.mjs. Values are exempted by file, never by
     * comment — packages/ui/src/tokens/tokens.css is the one file this gate
     * exempts, and tokens.ts only ever references them as `var(--…)` strings.
     *
     * The colour-function list below is the same set stylelint refuses in
     * `declaration-property-value-disallowed-list`; the two must stay in step,
     * or a value banned in a stylesheet becomes legal in a string literal.
     */
    files: ['apps/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/#[0-9a-fA-F]{3,8}\\b/]',
          message:
            'Hex colour literal. UI code references design tokens: var(--color-…) from @cumulo/ui.',
        },
        {
          selector: 'TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}\\b/]',
          message:
            'Hex colour literal. UI code references design tokens: var(--color-…) from @cumulo/ui.',
        },
        {
          selector: 'Literal[value=/(rgba?|hsla?|oklch|lab|lch)\\(/]',
          message:
            'Colour-function literal. UI code references design tokens: var(--color-…) from @cumulo/ui.',
        },
        {
          selector: 'TemplateElement[value.raw=/(rgba?|hsla?|oklch|lab|lch)\\(/]',
          message:
            'Colour-function literal. UI code references design tokens: var(--color-…) from @cumulo/ui.',
        },
        {
          selector: 'JSXAttribute[name.name="style"]',
          message: 'Inline styles are banned in UI code. Style via CSS classes consuming tokens.',
        },
      ],
    },
  },
);
