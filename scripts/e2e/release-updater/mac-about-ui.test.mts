import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { Window } from 'happy-dom';

import { macAbout, macAboutHasVersion } from './mac-old-ui.mts';

// Original signed 2.17.1 source395572f9: AdvancedSection.tsx176-217 and en/settings.json.
// Adjacent paragraphs have no text separator in the real DOM.
const markup = (version: string, appName = 'Agent Teams AI'): string =>
  `<div><div><p>${appName}</p><button>Up to date</button></div><p>Version ${version}</p><p>Assemble AI agent teams that work autonomously in parallel.</p></div>`;

const evaluate = (window: Window, expression: string): boolean => {
  // Execute the same fixed harness expression as CDP, in an isolated DOM realm.
  // eslint-disable-next-line sonarjs/code-eval
  return runInNewContext(expression, { document: window.document }, { timeout: 500 }) as boolean;
};

void test('exact About version paragraph survives adjacent source211 description text', async () => {
  const window = new Window();
  try {
    window.document.body.innerHTML = markup('2.17.1');
    assert.equal(
      evaluate(
        window,
        `(() => {const block=${macAbout};return /Version\\s+2\\.17\\.1\\b/.test(block.textContent);})()`
      ),
      false,
      'Previous container predicate rejects the rendered signed211 markup'
    );
    assert.equal(evaluate(window, macAboutHasVersion('2.17.1')), true);
    assert.equal(evaluate(window, macAboutHasVersion('2.17.0')), false);
    window.document.body.innerHTML = markup('2.17.0');
    assert.equal(evaluate(window, macAboutHasVersion('2.17.0')), true);
    assert.equal(evaluate(window, macAboutHasVersion('2.17.1')), false);
  } finally {
    await window.happyDOM.close();
  }
});

void test('About version rejects pending, suffix, wrong app scope and unrelated version paragraphs', async () => {
  const window = new Window();
  try {
    for (const html of [
      markup('...'),
      markup('2.17.10'),
      markup('2.17.1 beta'),
      markup('2.17.1', 'Other app'),
      `<p>Version 2.17.1</p>${markup('2.17.0')}`,
    ]) {
      window.document.body.innerHTML = html;
      assert.equal(evaluate(window, macAboutHasVersion('2.17.1')), false);
    }
  } finally {
    await window.happyDOM.close();
  }
});
