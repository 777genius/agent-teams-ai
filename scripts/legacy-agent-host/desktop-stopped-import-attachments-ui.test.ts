import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { readStoppedImportAttachmentOwner } from './desktop-stopped-import-attachments-ui.ts';
import { desktopJsLiteral } from './desktop-ui-controls.ts';

test('TEST CDP JavaScript literals round-trip hostile data without adding executable source', () => {
  const values = [
    '\"\'); globalThis.unexpectedEffects++; //',
    '</script><script>globalThis.unexpectedEffects++</script>',
    '\\path\\\"quoted\"\n\r\t\b\f\0',
    'TEST\u2028separator\u2029Україна😀',
    { nested: ['<tag>', '\\', null, true, 17] },
  ];
  const literal = desktopJsLiteral(values);
  assert.doesNotMatch(literal, /[<>\b\f\n\r\t\0\u2028\u2029]/);
  const realm = { unexpectedEffects: 0 };
  const observed: unknown = runInNewContext(`JSON.stringify(${literal})`, realm);
  assert.equal(observed, JSON.stringify(values));
  assert.equal(realm.unexpectedEffects, 0);
  assert.throws(() => desktopJsLiteral(undefined), TypeError);
});

test('attachment UI owner oracle uses actual canonical task props across renamed memo components', () => {
  const expected = {
    teamName: 'host-team:TEST-handle',
    taskId: 'TEST-task',
    reference: 'im1:TEST-task:' + 'a'.repeat(64),
  };
  const fiber = {
    memoizedProps: { children: 'TEST same display name' },
    return: {
      type: { type: { name: 'TeamDetailView2' } },
      memoizedProps: {
        teamName: expected.teamName,
        task: { id: expected.taskId, sourceMessageId: expected.reference },
      },
    },
  };
  // Exercise the self-contained function source that CDP evaluates in the renderer realm.
  const observed = runInNewContext(
    `(${readStoppedImportAttachmentOwner.toString()})(fiber, taskId)`,
    {
      fiber,
      taskId: expected.taskId,
    }
  );
  assert.deepEqual(JSON.parse(JSON.stringify(observed)), expected);
  const legacy = {
    memoizedProps: {
      teamName: 'TEST-legacy-same-display-name',
      task: { id: expected.taskId, sourceMessageId: 'TEST-original-message' },
    },
    return: fiber.return,
  };
  assert.notDeepEqual(readStoppedImportAttachmentOwner(legacy, expected.taskId), expected);
  assert.equal(
    readStoppedImportAttachmentOwner(legacy, expected.taskId)?.teamName,
    'TEST-legacy-same-display-name',
    'nearest actual wrong owner is exposed for refusal, never skipped to a canonical ancestor'
  );
  assert.equal(readStoppedImportAttachmentOwner(fiber, 'TEST-other-task'), null);
  assert.equal(readStoppedImportAttachmentOwner({ return: null }, expected.taskId), null);
});
