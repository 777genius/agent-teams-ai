import type React from 'react';

/**
 * Returns true while an IME (Input Method Editor) composition is in progress —
 * e.g. CJK candidate selection or punctuation entry. Keyboard events fired
 * during composition (notably Enter and the arrow keys) belong to the input
 * method, not the app: pressing Enter confirms a candidate rather than
 * submitting, and the arrows navigate candidates rather than the UI.
 *
 * Handlers that submit messages or drive autocomplete must bail out early when
 * this returns true, otherwise CJK users accidentally send half-composed text
 * while selecting characters.
 *
 * `nativeEvent.isComposing` is the standard signal. `keyCode === 229` is a
 * long-standing fallback for browsers that emit the composition-confirming
 * keydown without setting `isComposing`.
 */
export function isImeComposing(e: React.KeyboardEvent): boolean {
  // eslint-disable-next-line sonarjs/deprecation -- keyCode 229 is the standard IME-composition fallback; there is no non-deprecated equivalent.
  return e.nativeEvent.isComposing || e.keyCode === 229;
}
