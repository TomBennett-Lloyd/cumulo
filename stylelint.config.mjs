/*
 * Cumulo CSS gate: UI stylesheets consume design tokens only, and paint focus
 * only where focus informs the reader.
 *
 * CLAUDE.md's frontend gate says "no arbitrary colors, sizes, or spacing
 * values". This config is the mechanical half of that rule for CSS (the ESLint
 * half, covering .ts/.tsx, lives in eslint.config.mjs). The single exemption is
 * packages/ui/src/tokens/*.css — the one file this gate exempts from the ban on
 * raw values, because it is where the tokens are defined. What files outside
 * this gate's reach may hold is a separate question, and that file's own header
 * owns the answer.
 *
 * The second gate here is not about values at all: it is
 * docs/standards/design.md rule 11's, and it governs *when* a ring paints. It
 * sits in this file because it is the same kind of thing — a design rule with a
 * CSS-shaped tell that a linter can see — and see
 * `selector-pseudo-class-disallowed-list` below for what it refuses and why.
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
  //
  // playwright-report/ and test-results/ are the browser lane's own output —
  // Playwright's vendored trace-viewer stylesheet, not ours. Without them a
  // local `pnpm --filter @cumulo/web test:e2e` leaves thousands of hex-colour
  // and raw-length errors in the next `pnpm verify`, so the two commands a
  // task runs most often could not be run in sequence in one worktree. Both
  // dirs are gitignored. eslint has no matching entry — `isPathIgnored` on a file
  // in either returns FALSE — and does not flag them for the weaker reason
  // that no config object's `files` pattern reaches a bare `.js` there, so
  // zero rules apply (measured, not assumed). It bites hardest when the lane
  // is red, because `retain-on-failure` is what writes them (#269, #381).
  ignoreFiles: ['**/dist/**', '**/coverage/**', '**/playwright-report/**', '**/test-results/**'],

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
     * covers the widths in *at-rule preludes* — media features and container
     * features alike — which every rule here misses for a stronger reason: a
     * query feature is not a declaration at all, so no declaration-scoped rule
     * can see one however the property list grows. Those widths are therefore
     * raw lengths by construction; each is measured and argued where it is
     * written, which is the whole of what stands in for a gate there.
     *
     * This paragraph is also where the census of *viewport* breakpoints is kept
     * — the stylesheets point here rather than counting each other, so a new one
     * is added to this list and to nothing else. One remains:
     * `apps/web/src/map/map.css`, the attribution band. `apps/web/src/header`'s
     * left it at #326, which converted the header fold to a container query
     * measuring the bar's own content box; that issue audited the app's other
     * candidates too, and `docs/design/chart-treatment.md` records what it found.
     * A container query's width is not a census entry — it needs no viewport to
     * be true — but it is the same raw length and the same residual. And a
     * second viewport breakpoint would be a signal in its own right: measuring
     * the container is `docs/standards/design.md` rule 7's default and a
     * breakpoint its documented escalation, so a new one owes an argument for
     * why its surface cannot measure itself. There
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

    /*
     * A ring is for the reader who is navigating by keyboard, never for the one
     * who just clicked — docs/standards/design.md rule 11 owns that rule and the
     * argument for it. `:focus` matches however focus arrived, so styling it
     * paints a ring on a pointer interaction that asked for none; the browser
     * heuristic that tells the two arrivals apart is `:focus-visible`, and it is
     * the only half of *that* pair this codebase may style.
     *
     * It is no longer the only way the two arrivals are told apart, which is what
     * the message below says and this paragraph used to contradict. Since #440 an
     * element whose focus the heuristic misreads may observe how its own focus
     * arrived and publish that as an attribute, and a rule keyed on the attribute
     * suppresses the ring for exactly that arrival (`charts.css`). That route is
     * outside this rule rather than an exception to it: it carries no
     * pseudo-class at all, so there is nothing here for the list to reach.
     *
     * The list matches pseudo-class *names*, which is what makes a one-entry
     * list sufficient: `focus-visible` and `focus-within` are different names,
     * so they pass untouched while bare `:focus` is refused. The two `lint:css`
     * runs on issue 339 are what establish that rather than the documentation —
     * a seeded `.gate-probe:focus` was refused by this rule, and the tree's real
     * `:focus-visible` rules stayed green.
     *
     * This landed on an already-clean tree (issue 339 audited every focus rule
     * in the repo and found `:focus-visible` throughout), so it is a ratchet
     * rather than a fix: it exists to fail the *next* bare `:focus`. That
     * regression is invisible to jsdom — `:focus-visible` is a heuristic no
     * jsdom test can run — so lint is the fast half of catching it and
     * apps/web/e2e/pointer-focus.spec.ts, which measures the painted ring in a
     * real browser, is the slow half.
     *
     * Deliberately absent from the tokens override below: defining a token is no
     * licence to style focus, and the exemption there is about raw values only.
     */
    'selector-pseudo-class-disallowed-list': [
      ['focus'],
      {
        reportDisables: true,
        message:
          'Style focus with :focus-visible, never bare :focus — rings for keyboard interaction, none for pointer. Where an engine paints a pointer ring :focus-visible cannot reach, guard on the focus source instead — an attribute the component sets, no pseudo-class (charts.css; design.md rule 11 / P11, issues 339 and 440).',
      },
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
      // The tokens source is the one file this gate exempts from the raw-value
      // rules; that file's own header owns the wider claim.
      files: ['packages/ui/src/tokens/*.css'],
      rules: {
        'scale-unlimited/declaration-strict-value': null,
        'declaration-property-value-allowed-list': null,
        'declaration-property-value-disallowed-list': null,
      },
    },
  ],
};
