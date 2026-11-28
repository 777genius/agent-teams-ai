import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalOpenCodeAgentPermission,
  requiredOpenCodeToolsAllowed,
} from '../src/adapters/providers/openCodeAgentPolicy.ts';

// Exact pure normalization order from pinned native v1.19.4 core/src/v1/config/agent.ts.
// Source SHA256 4f2d7bc8283ff0c8cd922c614a74f74abb1abe9d5fc2a6dba3dd03d2dca5c624.
function nativePermission(tools: Record<string, boolean>, explicit: Record<string, unknown>) {
  const permission: Record<string, unknown> = {};
  for (const [tool, enabled] of Object.entries(tools)) {
    const action = enabled ? 'allow' : 'deny';
    if (tool === 'write' || tool === 'edit' || tool === 'patch') {
      permission.edit = action;
      continue;
    }
    permission[tool] = action;
  }
  Object.assign(permission, explicit);
  return permission;
}

const required = ['team_task_get', 'team_task_start'];
const selected = { '*': 'deny', test_selected_test_echo: 'allow' };

test('deprecated managed tools seed hides Team after native wildcard normalization; canonical permissions survive', () => {
  const legacyTools = Object.fromEntries(required.map((name) => [name, true]));
  const old = nativePermission(legacyTools, {
    ...selected,
    ...Object.fromEntries(required.map((name) => [name, 'allow'])),
  });
  assert.equal(requiredOpenCodeToolsAllowed(old, required), false);
  const fixed = canonicalOpenCodeAgentPermission({}, selected, required);
  const normalized = nativePermission({}, fixed);
  assert.equal(requiredOpenCodeToolsAllowed(normalized, required), true);
  assert.equal(requiredOpenCodeToolsAllowed(normalized, ['test_ambient_tool']), false);
  assert.equal(requiredOpenCodeToolsAllowed(normalized, ['bash']), false);
  assert.equal(requiredOpenCodeToolsAllowed(normalized, ['test_selected_test_echo']), true);
});

test('canonical conversion preserves legacy edit aliases and explicit policy while moving only managed allows last', () => {
  const tools = { patch: true, read: false, team_task_get: false };
  const explicit = { team_task_get: 'deny', '*': 'deny', read: 'allow', edit: 'ask' };
  const fixed = canonicalOpenCodeAgentPermission(tools, explicit, required);
  assert.equal(fixed.edit, 'ask');
  assert.equal(fixed.read, 'allow');
  assert.equal(fixed['*'], 'deny');
  assert.deepEqual(Object.keys(fixed).slice(-2), required);
  assert.equal(requiredOpenCodeToolsAllowed(nativePermission({}, fixed), required), true);
  assert.equal(requiredOpenCodeToolsAllowed(fixed, ['unselected_other']), false);
  assert.throws(() => canonicalOpenCodeAgentPermission({ bash: 'true' }, {}, required));
});

test('effective native normalized policy refuses later wildcard, missing, ask and pattern-only permission', () => {
  assert.equal(
    requiredOpenCodeToolsAllowed({ team_task_get: 'allow', 'team_*': 'deny' }, ['team_task_get']),
    false
  );
  assert.equal(
    requiredOpenCodeToolsAllowed({ '*': 'deny', 'team_????_get': 'allow' }, ['team_task_get']),
    false
  );
  assert.equal(
    requiredOpenCodeToolsAllowed({ '*': 'deny', team_task_get: 'ask' }, ['team_task_get']),
    false
  );
  assert.equal(
    requiredOpenCodeToolsAllowed({ '*': 'deny', team_task_get: { '*': 'allow' } }, [
      'team_task_get',
    ]),
    false
  );
  assert.equal(requiredOpenCodeToolsAllowed({ '*': 'deny' }, ['team_task_get']), false);
  assert.equal(
    requiredOpenCodeToolsAllowed({ '*': 'deny', 'unrelated.*': 'deny', team_task_get: 'allow' }, [
      'team_task_get',
    ]),
    true
  );
});
