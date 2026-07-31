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
  {
    /*
     * Frontend gate (CLAUDE.md): UI code consumes design tokens only. Raw
     * colours and inline styles are caught here; the CSS half of the same rule
     * lives in stylelint.config.mjs. Values are exempted by file, never by
     * comment — packages/ui/src/tokens/tokens.css is the one place raw values
     * exist, and tokens.ts only ever references them as `var(--…)` strings.
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

  /* ==========================================================================
   * RATCHET (#77): files predating docs/standards/structure.md. Each retrofit
   * chunk deletes its entries; deleting this whole block closes #77.
   * ==========================================================================
   *
   * The rules above land as `error` for ALL new code immediately — that is the
   * point of the ratchet. What it exempts is an explicit, enumerated list of
   * files that existed before the standard did; there is no glob and no
   * directory-level escape, so a new file cannot drift into the exemption.
   *
   * Retrofitting is therefore mechanically checkable: `grep` this block for
   * your package and the remaining work is the answer. The lists were
   * regenerated against the tree at land time with:
   *
   *   pnpm exec eslint --no-inline-config \
   *     --rule '{"func-style":["error","expression"]}' packages apps --format json
   *   pnpm exec eslint --no-inline-config \
   *     --rule '{"max-lines":["error",{"max":300,"skipBlankLines":true,"skipComments":true}]}' \
   *     packages apps --format json
   *
   * Nothing here is a permanent exemption. If a file listed below no longer
   * violates its rule, its entry is dead weight — delete it.
   */
  {
    files: [
      'apps/web/src/App.tsx',
      'apps/web/src/preview/TokensPreview.tsx',
      'packages/shared/src/fleet.test.ts',
      'packages/shared/src/fleet.ts',
      'packages/shared/src/location.ts',
      'packages/shared/src/site.test.ts',
      'packages/shared/src/storage-key.test.ts',
      'packages/shared/src/storage-key.ts',
      'packages/storage/scripts/smoke.ts',
      'packages/storage/src/batch.test.ts',
      'packages/storage/src/batch.ts',
      'packages/storage/src/client.test.ts',
      'packages/storage/src/client.ts',
      'packages/storage/src/errors.ts',
      'packages/storage/src/series-adapter.test.ts',
      'packages/storage/src/series-adapter.ts',
      'packages/storage/src/site-adapter.test.ts',
      'packages/storage/src/site-adapter.ts',
      'packages/storage/src/table-name.ts',
      'packages/storage/src/ttl.ts',
      'packages/storage/src/weather-adapter.test.ts',
      'packages/storage/src/weather-adapter.ts',
      'packages/ui/src/attribution/OpenMeteoAttribution.tsx',
      'packages/ui/src/tokens/tokens.test.ts',
    ],
    rules: {
      'func-style': 'off',
    },
  },
  {
    files: [
      'apps/web/src/preview/TokensPreview.tsx',
      'packages/storage/scripts/smoke.ts',
      'packages/storage/src/series-adapter.test.ts',
      'packages/storage/src/site-adapter.test.ts',
      'packages/storage/src/weather-adapter.test.ts',
    ],
    rules: {
      'max-lines': 'off',
    },
  },
  /* ===================== end RATCHET (#77) ================================ */
);
