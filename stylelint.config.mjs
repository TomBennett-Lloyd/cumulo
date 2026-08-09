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
        /*
         * Colour-bearing shorthands. Without these, `border: 1px solid red`
         * lints clean — the named colour is a sub-value of a property nothing
         * on this list matches, and the property-agnostic rule below only
         * catches hex literals and colour functions, not named colours. Listed
         * individually rather than as `/^border-/`, which would also demand a
         * token for `border-style: solid` — a keyword, not a design value.
         *
         * The plugin checks every sub-value, so listing a shorthand refuses the
         * whole shorthand form unless each part is a `var()` or an ignored
         * keyword: `border: var(--w) solid red` trips on `solid` as well as on
         * `red`. That is the intended trade — write the longhands
         * (`border-width`/`border-style`/`border-color`, as `.swatch-chip` and
         * `.map-marker` do) and each part is checked on its own terms.
         * `border: none` and friends stay legal via `ignoreValues`.
         */
        'border',
        'outline',
        'box-shadow',
        'text-shadow',
        'background-image',
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
     * so anything it does not name is unguarded. This rule closes the colour
     * half of that gap and only that half: it is property-agnostic, so whatever
     * the property, a hex literal or a colour-function call in its value is
     * refused. Token references survive because `var(--color-…)` names a colour
     * rather than spelling one. Named colours (`red`) are not caught here —
     * they are ordinary keywords, indistinguishable from `solid` or `auto` by
     * pattern — which is why every colour-bearing shorthand is on the list
     * above instead.
     *
     * Residual, deliberately open: the *length* half of the frontend gate is
     * still allow-list-shaped, so a raw size reaches the page through any
     * property the list omits — `width`, `height`, `max-width`, `inset`,
     * `flex-basis`, `border-width`, `letter-spacing`, `stroke-width`,
     * `grid-template-columns`, among others. Committed CSS already relies on
     * this (e.g. `max-width: 44rem` in apps/web/src/app.css). The same open half
     * covers *media features*, which every rule here misses for a stronger
     * reason: a media feature is not a declaration at all, so no
     * declaration-scoped rule can see one however the property list grows. The
     * app's two breakpoints — `apps/web/src/map/map.css` and
     * `apps/web/src/header/header.css` — are therefore raw lengths by
     * construction; each is measured and argued where it is written, which is
     * the whole of what stands in for a gate there. There
     * is no property-agnostic mirror for lengths because a length is legal
     * syntax everywhere, and adding these properties to the list above would
     * demand tokens that do not exist: the set has spacing, type, and radii
     * scales, but no measure or layout-size category. Closing it means adding
     * token categories first — design-system scope, tracked in
     * docs/tech-debt.md, not a config tweak.
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
