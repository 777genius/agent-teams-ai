/* global Document, Node, document */

export function installHostedProofInspector({ apiKeys, globalName }) {
  // Only the inspector is exposed. Its native references and expected keys
  // stay in this closure, created before any emitted module runs.
  const root = globalThis;
  const originalObject = Object;
  const originalArray = Array;
  const originalReflect = Reflect;
  const originalDefineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const hasOwn = Object.hasOwn;
  const ownKeys = Reflect.ownKeys;
  const originalOwnKeys = Reflect.ownKeys;
  const apply = Reflect.apply;
  const originalApply = Reflect.apply;
  const originalMap = Array.prototype.map;
  const originalCreateElement = Document.prototype.createElement;
  const originalAppendChild = Node.prototype.appendChild;
  const setTextContent = getOwnPropertyDescriptor(Node.prototype, 'textContent').set;
  const expectedKeys = [];
  for (let index = 0; index < apiKeys.length; index += 1) {
    expectedKeys[index] = apiKeys[index];
  }
  originalDefineProperty(root, '__hostedProofInspect', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: () => {
      const globalDescriptor = getOwnPropertyDescriptor(root, globalName);
      if (
        !globalDescriptor ||
        !hasOwn(globalDescriptor, 'value') ||
        globalDescriptor.configurable ||
        globalDescriptor.enumerable ||
        globalDescriptor.writable
      ) return { ok: false, reason: 'global_descriptor' };
      const api = globalDescriptor.value;
      if (api === null || typeof api !== 'object') return { ok: false, reason: 'api_object' };
      const keys = ownKeys(api);
      if (keys.length !== expectedKeys.length) return { ok: false, reason: 'api_keys' };
      for (let index = 0; index < keys.length; index += 1) {
        let expected = false;
        for (let other = 0; other < expectedKeys.length; other += 1) {
          if (keys[index] === expectedKeys[other]) expected = true;
        }
        if (!expected) return { ok: false, reason: 'api_keys' };
        const descriptor = getOwnPropertyDescriptor(api, keys[index]);
        if (!descriptor || !hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
          return { ok: false, reason: 'api_callable_data_descriptor' };
        }
      }
      if (
        getOwnPropertyDescriptor(root, 'Object')?.value !== originalObject ||
        getOwnPropertyDescriptor(root, 'Array')?.value !== originalArray ||
        getOwnPropertyDescriptor(root, 'Reflect')?.value !== originalReflect ||
        getOwnPropertyDescriptor(originalObject, 'defineProperty')?.value !== originalDefineProperty ||
        getOwnPropertyDescriptor(originalObject, 'hasOwn')?.value !== hasOwn ||
        getOwnPropertyDescriptor(originalReflect, 'ownKeys')?.value !== originalOwnKeys ||
        getOwnPropertyDescriptor(originalReflect, 'apply')?.value !== originalApply ||
        getOwnPropertyDescriptor(originalArray.prototype, 'map')?.value !== originalMap
      ) return { ok: false, reason: 'intrinsic_changed' };
      const head = document.head;
      if (head === null) return { ok: false, reason: 'csp_head' };
      const probe = apply(originalCreateElement, document, ['script']);
      apply(setTextContent, probe, ['globalThis.__hostedProofInlineCspRan = true;']);
      apply(originalAppendChild, head, [probe]);
      if (getOwnPropertyDescriptor(root, '__hostedProofInlineCspRan')) {
        return { ok: false, reason: 'csp_ineffective' };
      }
      return { ok: true };
    },
  });
}
