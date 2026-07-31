import type { ReactElement, ReactNode } from 'react';

/**
 * Props of {@link ScaleRow}. Named rather than inlined into the signature so the
 * six scale sections conform to one contract (`docs/standards/typing.md`
 * rule 6).
 */
export interface ScaleRowProps {
  /** The custom property name, e.g. `--space-4`. Also the `data-token` key. */
  readonly name: string;
  /** The specimen that shows what the token does — a bar, a line of type, a box. */
  readonly children: ReactNode;
}

/**
 * One row of a token scale: the name on the left, a specimen on the right.
 *
 * Extracted because spacing, type, typefaces, weights, line heights and radii
 * all render exactly this row and would all be wrong if one of them changed it —
 * same intent, so the shared portion is shared (`docs/standards/structure.md`
 * rule 7). Only the shared portion: the specimen differs per section and stays
 * at the call site as `children` rather than becoming a mode flag here, and the
 * enclosing `<ul>` keeps its own class because the radius section lays its rows
 * out differently.
 */
export const ScaleRow = ({ name, children }: ScaleRowProps): ReactElement => (
  <li className="scale-row">
    <code className="token-name">{name}</code>
    {children}
  </li>
);
