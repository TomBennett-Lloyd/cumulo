import {
  createSiteInputSchema,
  MAX_PLAUSIBLE_RESIDENTIAL_KW,
  type CreateSiteInput,
} from '@cumulo/shared';
import { useEffect, useId, useRef, useState, type ReactElement, type SubmitEvent } from 'react';

import { ADDING_SITE_LABEL } from '../dashboard/state-copy';
import type { CreationRefusal } from './creation-throttle';

/** The fields the visitor fills in. Coordinates come from the map, not from here. */
const SITE_FIELD_NAMES = ['name', 'tiltDegrees', 'azimuthDegrees', 'capacityKw'] as const;

type SiteFieldName = (typeof SITE_FIELD_NAMES)[number];

/**
 * What the visitor has typed, as typed.
 *
 * Strings rather than numbers because that is what an input holds, and the
 * difference matters: converting on every keystroke turns an empty capacity
 * field into `0`, which is a *number the schema can judge* rather than the
 * blank it actually is.
 */
type SiteDraft = Readonly<Record<SiteFieldName, string>>;

type FieldMessages = Partial<Readonly<Record<SiteFieldName, string>>>;

/**
 * Why the draft was refused, split by where it can be shown: messages that
 * belong to a field, and messages about values the form does not own.
 */
interface DraftIssues {
  readonly fields: FieldMessages;
  /** Issues on the map-supplied coordinates — no input to hang them on, so they surface whole. */
  readonly form: readonly string[];
}

/**
 * The failure arm of the schema's own result type.
 *
 * Derived from the schema rather than imported from `zod`: `apps/web` depends
 * on `@cumulo/shared`, not on zod directly, and a type reaching past a
 * package's public surface is a dependency nobody declared.
 */
type CreateSiteParseFailure = Extract<
  ReturnType<typeof createSiteInputSchema.safeParse>,
  { success: false }
>;

const EMPTY_ISSUES: DraftIssues = { fields: {}, form: [] };

/** Coordinate precision in the generated name: ~11 m, enough to tell two roofs apart. */
const COORDINATE_DECIMALS = 4;

interface NumericFieldSpec {
  readonly field: SiteFieldName;
  readonly label: string;
  readonly hint: string;
}

/**
 * The three physical fields, in the order the schema documents them. Data
 * rather than three near-identical JSX blocks — the blocks would differ only
 * in these strings (`structure.md` rule 7).
 */
const NUMERIC_FIELDS: readonly NumericFieldSpec[] = [
  {
    field: 'tiltDegrees',
    label: 'Tilt',
    hint: 'Degrees from horizontal: 0 is flat, 90 is vertical.',
  },
  {
    field: 'azimuthDegrees',
    label: 'Azimuth',
    hint: 'Degrees clockwise from north: 180 faces due south.',
  },
  {
    field: 'capacityKw',
    label: 'Capacity',
    hint: `Nameplate DC kilowatts, up to ${String(MAX_PLAUSIBLE_RESIDENTIAL_KW)}.`,
  },
];

const isSiteFieldName = (value: unknown): value is SiteFieldName =>
  SITE_FIELD_NAMES.some((name) => name === value);

/**
 * A blank field is *missing*, not zero. `Number('')` is `0`, which would let an
 * untouched capacity field through as a legal-looking value; `NaN` is what the
 * schema refuses, and refusing is the honest answer.
 */
const numericFieldValue = (raw: string): number => (raw.trim() === '' ? Number.NaN : Number(raw));

/** The draft as the schema will see it, coordinates included. */
const draftAsInput = (draft: SiteDraft, latitude: number, longitude: number): unknown => ({
  name: draft.name.trim(),
  latitude,
  longitude,
  tiltDegrees: numericFieldValue(draft.tiltDegrees),
  azimuthDegrees: numericFieldValue(draft.azimuthDegrees),
  capacityKw: numericFieldValue(draft.capacityKw),
});

/**
 * Sorts the schema's complaints into the places the form can show them. The
 * first issue per field wins: a field shows one message, and the visitor fixes
 * one thing at a time.
 */
const collectIssues = (failure: CreateSiteParseFailure): DraftIssues => {
  const fields: Partial<Record<SiteFieldName, string>> = {};
  const form: string[] = [];

  for (const issue of failure.error.issues) {
    const [field] = issue.path;
    if (isSiteFieldName(field)) {
      fields[field] ??= issue.message;
    } else {
      form.push(`${issue.path.join('.')}: ${issue.message}`);
    }
  }

  return { fields, form };
};

/** The name a visitor gets if they add the site without renaming it. */
const defaultSiteName = (latitude: number, longitude: number): string =>
  `Site at ${latitude.toFixed(COORDINATE_DECIMALS)}, ${longitude.toFixed(COORDINATE_DECIMALS)}`;

/**
 * Starting values for the physical fields: a typical pitched roof in these
 * latitudes, facing south, on a common residential array size. Defaults the
 * visitor can accept are the point of the one-minute demo — but they are
 * ordinary values in the inputs, editable and validated like anything typed.
 */
const initialDraft = (latitude: number, longitude: number): SiteDraft => ({
  name: defaultSiteName(latitude, longitude),
  tiltDegrees: '35',
  azimuthDegrees: '180',
  capacityKw: '4',
});

export interface AddSiteFieldProps {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  /** The schema's complaint about this field, or `undefined` while it is happy. */
  readonly message: string | undefined;
  readonly inputMode: 'text' | 'decimal';
  readonly onValueChange: (value: string) => void;
}

/**
 * One labelled input with its hint and, when the schema objects, its message —
 * both tied to the input through `aria-describedby`, so a screen-reader user
 * hears why the field was refused rather than only that it was.
 *
 * `type="text"` with a numeric `inputMode`, deliberately: a `type="number"`
 * input silently discards what it cannot parse, which would hide a typo from
 * the visitor *and* from the schema. Here everything typed reaches the one
 * validator.
 */
const AddSiteField = ({
  id,
  label,
  hint,
  value,
  message,
  inputMode,
  onValueChange,
}: AddSiteFieldProps): ReactElement => {
  const hintId = `${id}-hint`;
  const messageId = `${id}-message`;

  return (
    <div className="add-site-field">
      <label className="add-site-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="add-site-input"
        type="text"
        inputMode={inputMode}
        value={value}
        aria-invalid={message !== undefined}
        aria-describedby={message === undefined ? hintId : `${hintId} ${messageId}`}
        onChange={(event) => {
          onValueChange(event.target.value);
        }}
      />
      <p className="add-site-hint" id={hintId}>
        {hint}
      </p>
      {message !== undefined && (
        <p className="add-site-message" id={messageId}>
          {message}
        </p>
      )}
    </div>
  );
};

export interface AddSiteFormProps {
  /** Where the visitor clicked. Displayed, never edited — the map owns them. */
  readonly latitude: number;
  readonly longitude: number;
  /** Called only with input the shared schema has already accepted. */
  readonly onSubmit: (input: CreateSiteInput) => void;
  readonly onCancel: () => void;
  /** A creation is in flight; the button says so and refuses a second click. */
  readonly submitting: boolean;
  /**
   * The throttle's last refusal, or `null` while the visitor is inside their
   * allowance. Shown as a stated wait; it does not lock the form, because the
   * wait is only re-counted when the visitor presses again.
   */
  readonly refusal: CreationRefusal | null;
  /** What the fleet said when it rejected the last creation, if anything. */
  readonly error: string | null;
}

/**
 * The click-to-add-a-site form.
 *
 * Presentational (`react.md` rule 4): it owns what the visitor has typed and
 * nothing else. Whether a creation is permitted, whether one is in flight and
 * what the fleet said all arrive as props, because all three are the
 * dashboard's business — this form is renderable on its own in every one of
 * those states, which is what its tests do.
 *
 * `createSiteInputSchema` is the only validator, and it is the same schema the
 * Fleet API validates with (`architecture.md` rule 2). Hence `noValidate` on
 * the form: browser constraint validation would be a second, differently
 * worded gate that jsdom does not run, so the tests would prove a path the
 * browser never takes.
 *
 * The coordinates are read at mount, so a second map click must give the form a
 * new `key` rather than new props — remounting is how a new location becomes a
 * fresh draft, without an effect choreographing "when the coordinates change,
 * reset the fields" (`react.md` rule 1).
 */
export const AddSiteForm = ({
  latitude,
  longitude,
  onSubmit,
  onCancel,
  submitting,
  refusal,
  error,
}: AddSiteFormProps): ReactElement => {
  const fieldPrefix = useId();
  const [draft, setDraft] = useState<SiteDraft>(() => initialDraft(latitude, longitude));
  const [issues, setIssues] = useState<DraftIssues>(EMPTY_ISSUES);
  const headingRef = useRef<HTMLHeadingElement>(null);

  /*
   * The same rule the site panel follows: a surface that arrives focuses its own
   * heading, so a reader whose focus is somewhere else on the page is told
   * something changed rather than left to find out.
   *
   * The *reason* moved with the form. While this was an occupant of the reading
   * column's context region, the heading announced a region that had swapped
   * underneath the reader. It opens inside a modal now
   * (`AddSiteDialog.tsx`), and the heading is what names that dialog to a screen
   * reader on arrival — the dialog element carries no accessible name of its own,
   * which that component's header explains. Same line of code, same correctness,
   * different argument.
   *
   * Mount *is* the whole of "arriving" here, hence the empty dependencies: a
   * second draft gives this form a new `key` and remounts it (see the note above
   * on why the coordinates are read once), so there is no later moment at which
   * a live form becomes a different draft.
   *
   * Focus is document state, an external system no render owns — the case an
   * effect is for (`react.md` rule 1).
   */
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const updateField = (field: SiteFieldName, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    // The submit stays in this handler rather than a navigation.
    event.preventDefault();

    const parsed = createSiteInputSchema.safeParse(draftAsInput(draft, latitude, longitude));
    if (!parsed.success) {
      setIssues(collectIssues(parsed));
      return;
    }

    setIssues(EMPTY_ISSUES);
    onSubmit(parsed.data);
  };

  const titleId = `${fieldPrefix}-title`;

  return (
    <form className="add-site-form" aria-labelledby={titleId} noValidate onSubmit={handleSubmit}>
      <h2 className="add-site-title" id={titleId} ref={headingRef} tabIndex={-1}>
        Add a site
      </h2>

      <p className="add-site-coordinates">
        Location{' '}
        <span className="add-site-coordinates-value">
          {latitude.toFixed(COORDINATE_DECIMALS)}, {longitude.toFixed(COORDINATE_DECIMALS)}
        </span>
      </p>

      <AddSiteField
        id={`${fieldPrefix}-name`}
        label="Name"
        hint="How this site is listed on the map and in the fleet."
        value={draft.name}
        message={issues.fields.name}
        inputMode="text"
        onValueChange={(value) => {
          updateField('name', value);
        }}
      />

      {NUMERIC_FIELDS.map((spec) => (
        <AddSiteField
          key={spec.field}
          id={`${fieldPrefix}-${spec.field}`}
          label={spec.label}
          hint={spec.hint}
          value={draft[spec.field]}
          message={issues.fields[spec.field]}
          inputMode="decimal"
          onValueChange={(value) => {
            updateField(spec.field, value);
          }}
        />
      ))}

      {issues.form.length > 0 && (
        <p className="add-site-error" role="alert">
          This location cannot be added: {issues.form.join('; ')}
        </p>
      )}

      {/*
        `role="alert"`, not `status`: a live region mounted with its text already
        inside it has no change to report and announces nothing (`react.md`,
        async surface convention). This answers a submit press the visitor just
        made, into a form already on screen — so it is a real change, and it
        announces the same way as the form's other two submit answers above and
        below. The dashboard's `CreationState` union makes refusal and failure
        mutually exclusive, so those two never announce over each other.
      */}
      {refusal !== null && (
        <p className="add-site-notice" role="alert">
          To stay inside the weather API&rsquo;s request budget, wait {refusal.retryAfterSeconds}s
          before adding another site.
        </p>
      )}

      {error !== null && (
        <p className="add-site-error" role="alert">
          {error}
        </p>
      )}

      <div className="add-site-actions">
        <button type="button" className="add-site-cancel" onClick={onCancel}>
          Cancel
        </button>
        {/*
          Disabled while a creation is in flight, and never for a refusal. A
          refusal states a wait, and nothing re-renders this form when that wait
          elapses — so a button disabled by one would stay disabled under a
          frozen countdown that is wrong a second later. Live, it stays honest:
          the throttle's check costs nothing and spends nothing, so a second
          press either creates the site or restates the wait as it now stands.
        */}
        <button type="submit" className="add-site-submit" disabled={submitting}>
          {submitting ? ADDING_SITE_LABEL : 'Add site'}
        </button>
      </div>
    </form>
  );
};
