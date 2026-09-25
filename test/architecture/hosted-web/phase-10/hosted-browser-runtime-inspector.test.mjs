import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installHostedProofInspector } from '../../../../scripts/ci/hosted-browser-event-stream-runtime-inspector.mjs';

test('the browser inspector rejects a throwing API getter under prototype pollution', () => {
  class FakeNode {
    set textContent(_value) {}
    appendChild(child) { return child; }
  }
  class FakeDocument {
    createElement() { return new FakeNode(); }
  }
  globalThis.Node = FakeNode;
  globalThis.Document = FakeDocument;
  globalThis.document = new FakeDocument();
  globalThis.document.head = new FakeNode();

  const globalName = '__hostedProofIsolatedGetterApi';
  const apiKeys = ['createHostedCoordinationEventBootstrapTransport', 'createHostedCoordinationEventTransport'];
  installHostedProofInspector({ apiKeys, globalName });
  const api = {
    createHostedCoordinationEventBootstrapTransport() {},
  };
  Object.defineProperty(api, apiKeys[1], {
    configurable: true,
    get() { throw new Error('getter_was_invoked'); },
  });
  Object.defineProperty(globalThis, globalName, { value: api });
  Object.prototype.value = function spoof() {};
  try {
    assert.deepEqual(globalThis.__hostedProofInspect(), {
      ok: false,
      reason: 'api_callable_data_descriptor',
    });
  } finally {
    delete Object.prototype.value;
  }
  Object.defineProperty(api, apiKeys[1], { value: function createTransport() {} });
  assert.deepEqual(globalThis.__hostedProofInspect(), { ok: true });
});
