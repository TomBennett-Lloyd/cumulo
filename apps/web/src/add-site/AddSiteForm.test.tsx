// @vitest-environment jsdom

import { createSiteInputSchema, type CreateSiteInput } from '@cumulo/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AddSiteForm, type AddSiteFormProps } from './AddSiteForm';

// Vitest runs without global test hooks, so Testing Library's automatic
// cleanup never registers itself.
afterEach(cleanup);

/**
 * A map click in Dublin, carried at more precision than the form displays —
 * the displayed name rounds, the submitted coordinates must not.
 */
const LATITUDE = 53.34981234;
const LONGITUDE = -6.26031234;

const renderForm = (overrides: Partial<AddSiteFormProps> = {}) => {
  const onSubmit = vi.fn<(input: CreateSiteInput) => void>();
  const onCancel = vi.fn<() => void>();

  render(
    <AddSiteForm
      latitude={LATITUDE}
      longitude={LONGITUDE}
      onSubmit={onSubmit}
      onCancel={onCancel}
      submitting={false}
      refusal={null}
      error={null}
      {...overrides}
    />,
  );

  return { onSubmit, onCancel };
};

const typeInto = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

const submitForm = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Add site' }));
};

/**
 * The text of every element one field's input points at through its own
 * `aria-describedby`, narrowed to the ids ending in `idSuffix` and joined.
 *
 * Going through the attribute rather than querying the DOM at large is the
 * whole point: copy that rendered but was never associated with the input is
 * absent to a screen-reader user, so it reads as absent here too. The suffix is
 * which *kind* of description is wanted — the form gives each one a stable id
 * ending — and the two readers below name the kinds.
 */
const describedByText = (label: string, idSuffix: string): string => {
  const input = screen.getByLabelText(label);
  const describedBy = input.getAttribute('aria-describedby') ?? '';

  return describedBy
    .split(' ')
    .filter((id) => id.endsWith(idSuffix))
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();
};

/** The message the form is showing under one field, empty while it has nothing to say. */
const fieldMessage = (label: string): string => describedByText(label, '-message');

/** The standing hint under one field — the copy that is there before anything goes wrong. */
const fieldHint = (label: string): string => describedByText(label, '-hint');

/**
 * Each row is a value the shared schema refuses, one per bound the form is
 * responsible for surfacing. A bound dropped from `createSiteInputSchema`
 * makes exactly one of these rows submit.
 */
const refusedValues: readonly [why: string, label: string, value: string][] = [
  ['a tilt past vertical', 'Tilt', '95'],
  ['a negative tilt', 'Tilt', '-1'],
  ['a full turn of azimuth, which must normalize to 0', 'Azimuth', '360'],
  ['a site with no capacity', 'Capacity', '0'],
  ['capacity above the residential sanity ceiling', 'Capacity', '50.1'],
  ['a capacity left blank, which is missing rather than zero', 'Capacity', ''],
  ['a capacity that is not a number at all', 'Capacity', '4o'],
  ['a name of nothing but spaces', 'Name', '   '],
];

describe('AddSiteForm', () => {
  it('arrives filled in, so accepting the defaults is one click', () => {
    renderForm();

    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Site at 53.3498, -6.2603');
    expect(screen.getByLabelText('Tilt')).toHaveProperty('value', '35');
    expect(screen.getByLabelText('Azimuth')).toHaveProperty('value', '180');
    expect(screen.getByLabelText('Capacity')).toHaveProperty('value', '4');
  });

  /*
   * The literal is the point. The hint interpolates the shared ceiling, so
   * asserting it against that same constant would prove only that a value
   * equals itself — and would stay green if the interpolation rendered
   * `undefined`. Spelling the whole sentence out means a ceiling change lands
   * here as a deliberate second touch, and any deviation in the rendered copy
   * is a failure.
   */
  it('states the capacity ceiling in the hint, in the copy a visitor reads', () => {
    renderForm();

    expect(fieldHint('Capacity')).toBe('Nameplate DC kilowatts, up to 50.');
  });

  it('submits what the visitor accepted, at the precision the map clicked', () => {
    const { onSubmit } = renderForm();

    submitForm();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0]?.[0];
    // The whole point of the schema gate: what leaves the form is a value the
    // Fleet API would accept, not merely a value the form assembled.
    expect(createSiteInputSchema.safeParse(submitted).success).toBe(true);
    expect(submitted).toEqual({
      name: 'Site at 53.3498, -6.2603',
      latitude: LATITUDE,
      longitude: LONGITUDE,
      tiltDegrees: 35,
      azimuthDegrees: 180,
      capacityKw: 4,
    });
  });

  it('submits the visitor’s own values once they edit the draft', () => {
    const { onSubmit } = renderForm();

    typeInto('Name', '  Bristol rooftop  ');
    typeInto('Tilt', '22.5');
    typeInto('Azimuth', '135');
    typeInto('Capacity', '6.4');
    submitForm();

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Bristol rooftop',
      latitude: LATITUDE,
      longitude: LONGITUDE,
      tiltDegrees: 22.5,
      azimuthDegrees: 135,
      capacityKw: 6.4,
    });
  });

  describe.each(refusedValues)('given %s', (_why, label, value) => {
    it('keeps the creation inside the form and says why', () => {
      const { onSubmit } = renderForm();

      typeInto(label, value);
      submitForm();

      expect(onSubmit).not.toHaveBeenCalled();
      expect(screen.getByLabelText(label).getAttribute('aria-invalid')).toBe('true');
      expect(fieldMessage(label)).not.toBe('');
    });
  });

  it('complains about the field that is wrong and only that field', () => {
    renderForm();

    typeInto('Tilt', '95');
    submitForm();

    expect(fieldMessage('Tilt')).not.toBe('');
    expect(fieldMessage('Capacity')).toBe('');
    expect(screen.getByLabelText('Capacity').getAttribute('aria-invalid')).toBe('false');
  });

  it('stops complaining once the value is fixed', () => {
    const { onSubmit } = renderForm();

    typeInto('Tilt', '95');
    submitForm();
    typeInto('Tilt', '40');
    submitForm();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ tiltDegrees: 40 }));
    expect(fieldMessage('Tilt')).toBe('');
  });

  it('explains the budget when the throttle refuses', () => {
    renderForm({ refusal: { retryAfterSeconds: 42 } });

    expect(screen.getByRole('alert').textContent).toMatch(
      /request budget, wait 42s before adding another site/,
    );
    // The absence is the half worth pinning: a `role="status"` mounted with its
    // text already in it looks accessible and announces nothing (`react.md`), so
    // a regression back to one would otherwise still read as green above.
    expect(screen.queryByRole('status')).toBeNull();
  });

  /*
   * A refusal states a wait; it must not become a dead end.
   *
   * Disabling the button here looks like the safe choice and is the trap: this
   * form never learns that the wait has elapsed — nothing re-renders it on a
   * timer — so a disabled button stays disabled for as long as the visitor
   * leaves the form open, under a frozen "wait 42s" that is a lie within a
   * second of being painted. Leaving it live is what makes the wait honest: a
   * click re-asks the throttle, which is side-effect-free, and the visitor gets
   * either the creation or a freshly counted wait.
   */
  it('stays submittable while refused, so the stated wait can be re-tested', () => {
    const { onSubmit } = renderForm({ refusal: { retryAfterSeconds: 42 } });

    const submit = screen.getByRole('button', { name: 'Add site' });
    expect(submit).toHaveProperty('disabled', false);

    fireEvent.click(submit);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('refuses a second click while a creation is in flight', () => {
    const { onSubmit } = renderForm({ submitting: true });

    const submit = screen.getByRole('button', { name: 'Adding site…' });
    expect(submit).toHaveProperty('disabled', true);

    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows what the fleet said when a creation was rejected', () => {
    renderForm({ error: 'Fleet unreachable: check your connection and try again' });

    expect(screen.getByRole('alert').textContent).toBe(
      'Fleet unreachable: check your connection and try again',
    );
  });

  /*
   * The form announces itself by focusing its own heading — the one landing
   * `react.md`'s focus rule still grants, for a modal whose own controls are the
   * answer. (A selection elsewhere on the page moves focus nowhere, #328.)
   * Without this a visitor who has just placed a pin has their focus left
   * wherever it was while a form opens somewhere else.
   *
   * It is a modal that arrives now rather than an occupant of the reading
   * column's context region (`AddSiteDialog.tsx`), which makes the heading do a
   * second job: the `<dialog>` carries no accessible name of its own, so this is
   * what a screen reader is given on arrival.
   */
  it('announces itself on arrival by focusing its own heading', () => {
    renderForm();

    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Add a site' }));
  });

  it('lets the visitor back out', () => {
    const { onCancel } = renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
