/*
 * Driving a native `<dialog>` across the two DOM implementations this app runs
 * in.
 *
 * One module rather than a copy per dialog, and the repetition rule's own
 * question is what decides it (`structure.md` rule 7): if the fallback below
 * changed — jsdom growing a real `showModal`, the guard moving to a different
 * capability — every dialog in the app would be wrong until it changed the same
 * way. Same intent, so the shared portion is shared. What is *not* shared is
 * anything about a particular dialog: who owns its open-ness, what it contains,
 * where focus goes on the way out. Those differ per dialog and stay with each
 * one.
 *
 * It sits at `src/` rather than inside `header/` or `add-site/` because it
 * belongs to neither — `structure.md` rule 5's "helpers used by only that
 * adapter live inside it" read the other way round. Named for what it is about
 * rather than genericly (`architecture.md` rule 5): this is the modality
 * question, not a bag of dialog helpers.
 */

/**
 * Open or close a `<dialog>`, modally where the DOM implementation has modality.
 *
 * `showModal` and `close` are the whole reason these are native dialogs: they
 * put the element in the top layer, paint the backdrop, make the page behind it
 * inert, give Escape its meaning, and restore focus to whatever was focused
 * before on the way out. None of that is behaviour a component should
 * reimplement.
 *
 * jsdom 30 — the DOM the unit lane runs in — implements `HTMLDialogElement`
 * with `open` and nothing else (`constructor,open` is the entire prototype).
 * Toggling the attribute is what a DOM without a top layer can honestly do: the
 * dialog is open and its content is present, and *every* property that needs a
 * top layer is by definition the browser lane's to prove (`testing.md`
 * rule 10) — `e2e/header.spec.ts` drives Escape through a real Chromium for the
 * About dialog and `e2e/map-regressions.spec.ts` does the same for the add-site
 * one, measuring the dismissal and the focus landing there. The alternative,
 * standing a fake `showModal` up in the unit lane, would have the suite assert
 * that a stub was called while proving nothing about modality at all.
 *
 * Guarded on the method rather than on an environment flag so the branch states
 * the capability it actually needs, and so nothing here has to know what is
 * running it.
 */
export const syncDialogOpen = (dialog: HTMLDialogElement, shouldBeOpen: boolean): void => {
  if (dialog.open === shouldBeOpen) {
    // Already there — and on the Escape path it got there by itself, because
    // an unprevented `cancel` closes the dialog before this effect runs.
    return;
  }

  if (typeof dialog.showModal !== 'function') {
    dialog.open = shouldBeOpen;
    return;
  }

  if (shouldBeOpen) {
    dialog.showModal();
  } else {
    dialog.close();
  }
};
