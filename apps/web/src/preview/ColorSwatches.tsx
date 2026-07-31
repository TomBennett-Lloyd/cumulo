import type { ReactElement } from 'react';

/**
 * Props of {@link ColorSwatches}. Named rather than inlined into the signature
 * so the three colour subsections conform to one contract
 * (`docs/standards/typing.md` rule 6).
 */
export interface ColorSwatchesProps {
  readonly names: readonly string[];
}

/**
 * A grid of colour chips, one per token name. The chip's colour comes from
 * `preview.css` keyed by `[data-token='--name']` — the selector *is* the token
 * name, so there is no second name to keep in sync and no value here to drift
 * from the design system.
 */
export const ColorSwatches = ({ names }: ColorSwatchesProps): ReactElement => (
  <ul className="swatch-grid">
    {names.map((name) => (
      <li key={name} className="swatch">
        <span className="swatch-chip" data-token={name} aria-hidden="true" />
        <code className="token-name">{name}</code>
      </li>
    ))}
  </ul>
);
