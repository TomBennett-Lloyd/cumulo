/**
 * Typed handles for the design tokens declared in `tokens.css`.
 *
 * Every value is a `var(--…)` reference — never a literal colour, size or
 * spacing value. The CSS custom property is the single source of truth, which
 * is what lets a theme swap (`[data-theme='dark']`) change the rendered value
 * without any TypeScript knowing about it. `tokens.test.ts` pins the two files
 * together: a handle whose custom property does not exist fails the build.
 */
export const tokens = {
  color: {
    bg: 'var(--color-bg)',
    surface: 'var(--color-surface)',
    text: 'var(--color-text)',
    textMuted: 'var(--color-text-muted)',
    border: 'var(--color-border)',
    accent: 'var(--color-accent)',
    accentContrast: 'var(--color-accent-contrast)',
    danger: 'var(--color-danger)',
    warning: 'var(--color-warning)',
    success: 'var(--color-success)',
    chart1: 'var(--color-chart-1)',
    chart2: 'var(--color-chart-2)',
    chart3: 'var(--color-chart-3)',
    chart4: 'var(--color-chart-4)',
    chart5: 'var(--color-chart-5)',
    chart6: 'var(--color-chart-6)',
    chartActuals: 'var(--color-chart-actuals)',
    chartBandFill: 'var(--color-chart-band-fill)',
    chartBandStroke: 'var(--color-chart-band-stroke)',
    chartGrid: 'var(--color-chart-grid)',
    chartAxisLabel: 'var(--color-chart-axis-label)',
    mapMarker: 'var(--color-map-marker)',
    mapMarkerHover: 'var(--color-map-marker-hover)',
    mapMarkerSelected: 'var(--color-map-marker-selected)',
    mapMarkerStroke: 'var(--color-map-marker-stroke)',
  },
  space: {
    1: 'var(--space-1)',
    2: 'var(--space-2)',
    3: 'var(--space-3)',
    4: 'var(--space-4)',
    6: 'var(--space-6)',
    8: 'var(--space-8)',
    12: 'var(--space-12)',
    16: 'var(--space-16)',
  },
  text: {
    xs: 'var(--text-xs)',
    sm: 'var(--text-sm)',
    base: 'var(--text-base)',
    lg: 'var(--text-lg)',
    xl: 'var(--text-xl)',
    '2xl': 'var(--text-2xl)',
    '3xl': 'var(--text-3xl)',
  },
  font: {
    sans: 'var(--font-sans)',
    mono: 'var(--font-mono)',
    weightRegular: 'var(--font-weight-regular)',
    weightMedium: 'var(--font-weight-medium)',
    weightSemibold: 'var(--font-weight-semibold)',
    leadingTight: 'var(--leading-tight)',
    leadingNormal: 'var(--leading-normal)',
  },
  radius: {
    sm: 'var(--radius-sm)',
    md: 'var(--radius-md)',
    full: 'var(--radius-full)',
  },
} as const;
