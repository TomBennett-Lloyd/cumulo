/*
 * Cumulo CSS gate: UI stylesheets consume design tokens only.
 *
 * CLAUDE.md's frontend gate says "no arbitrary colors, sizes, or spacing
 * values". This config is the mechanical half of that rule for CSS (the ESLint
 * half, covering .ts/.tsx, lives in eslint.config.mjs). The single exemption is
 * packages/ui/src/tokens/*.css — the one file in the repo allowed to hold raw
 * values, because it is where the tokens are defined.
 */
export default {
  plugins: ['stylelint-declaration-strict-value'],

  /*
   * Suppression comments are themselves errors — the CSS mirror of
   * `@eslint-community/eslint-comments/no-use` in eslint.config.mjs. Four
   * shapes of `stylelint-disable` exist and each has its own catcher:
   *
   *   scoped to a rule this config defines  → comment-word-disallowed-list
   *   scoped to comment-word-disallowed-list → its own reportDisables (below)
   *   scoped to a rule not in this config    → reportInvalidScopeDisables
   *   not scoped at all (blanket disable)    → reportUnscopedDisables
   *
   * The report* settings are core-level, so unlike a rule they cannot be
   * switched off by the very comment they are reporting.
   */
  reportDescriptionlessDisables: true,
  reportInvalidScopeDisables: true,
  reportNeedlessDisables: true,
  reportUnscopedDisables: true,

  // Generated CSS is not authored CSS, so the gate does not apply to it. There
  // is deliberately no node_modules entry: stylelint always ignores
  // node_modules itself (ALWAYS_IGNORED_GLOBS in lib/standalone.mjs), and an
  // entry that can never fire reads as protection nobody ever tested.
  ignoreFiles: ['**/dist/**', '**/coverage/**'],

  rules: {
    /*
     * Every value that carries visual design must be a `var(--token)`.
     * `ignoreFunctions: false` is deliberate: the plugin's default treats any
     * function call as an acceptable value, which would let `rgb(255 0 0)` and
     * `calc(13px)` straight through the gate. `var()` stays allowed via
     * `ignoreVariables` (on by default). No `reportDisables` here: this plugin
     * validates its own secondary options against a fixed key list and rejects
     * it outright — disables of this rule are caught by
     * comment-word-disallowed-list instead.
     */
    'scale-unlimited/declaration-strict-value': [
      [
        '/color$/',
        'fill',
        'stroke',
        'background',
        'font-size',
        'font-family',
        'font-weight',
        'line-height',
        'margin',
        '/^margin-/',
        'padding',
        '/^padding-/',
        'gap',
        'row-gap',
        'column-gap',
        'border-radius',
      ],
      {
        ignoreFunctions: false,
        ignoreValues: [
          'currentColor',
          'inherit',
          'transparent',
          'none',
          '0',
          'auto',
          'initial',
          'unset',
        ],
      },
    ],

    /*
     * The property list above is an allow-list of the properties we thought of,
     * so a raw colour reaches the page through any property not on it — most
     * often a shorthand: `border: 1px solid #ff0000`, `outline`, `box-shadow`,
     * `text-shadow`, `background-image: linear-gradient(…)`. This rule is
     * property-agnostic instead: whatever the property, a hex literal or a
     * colour-function call in its value is refused. Token references survive
     * because `var(--color-…)` names a colour rather than spelling one.
     */
    'declaration-property-value-disallowed-list': [
      { '/.*/': ['/#[0-9a-fA-F]{3,8}\\b/', '/\\b(rgba?|hsla?|oklch|lab|lch)\\(/'] },
      { reportDisables: true },
    ],

    // A local custom property may only alias a token — never introduce a raw
    // value under a new name, which would launder it past the rule above.
    'declaration-property-value-allowed-list': [
      { '/^--/': ['/^var\\(/'] },
      { reportDisables: true },
    ],

    // See the suppression note above: this is what makes a `stylelint-disable`
    // comment an error in its own right rather than a working escape hatch.
    'comment-word-disallowed-list': [
      ['stylelint-disable'],
      {
        reportDisables: true,
        message:
          'Suppression comment. Fix the root cause — a rule fighting you is a design signal (CLAUDE.md).',
      },
    ],
  },

  overrides: [
    {
      // The tokens source is the single home of raw values in this repo.
      files: ['packages/ui/src/tokens/*.css'],
      rules: {
        'scale-unlimited/declaration-strict-value': null,
        'declaration-property-value-allowed-list': null,
        'declaration-property-value-disallowed-list': null,
      },
    },
  ],
};
