import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { TeamOwner } from '../dist/team/TeamOwner.js';
import type { MemberProviderContext } from '../dist/adapters/providers/MemberProvider.js';
import type { OwnerState } from '../dist/team/ownerState.js';

/** Observe the original readiness callback after its separate Runtime custody read. */
export function checkDefaultFreshAuthority(t: TestContext, context: MemberProviderContext,
  root: string, teamName: string, principalId: string): void {
  const directory = join(root, 'teams', teamName), store = join(directory, '.host-owner');
  const lock = join(store, 'authority.lock');
  type Row = { namespaceReads: number; tokens: string[]; checks: string[] };
  let rows: Row[] = [], pendingNamespaces = 0, pendingChecks: string[] = [];
  let runtimeReads = 0, observing = false, measuring = false;
  let providerDepth = 0, changeState: ((state: OwnerState) => void) | undefined;
  let afterExecution: (() => void) | undefined;
  const stateStore = new TeamOwnerStore(root, teamName);
  const saved = stateStore.fenced(() => stateStore.read<OwnerState>('state.json')!);
  const restore = () => stateStore.fenced(() => stateStore.write('state.json', saved));
  const row = () => rows.at(-1)!;
  const link = fs.linkSync, directories = fs.readdirSync, read = TeamOwnerStore.prototype.read;
  const runtime = RuntimeOwner.prototype.readCapturedSession;
  const provider = TeamOwner.prototype.capturedProviderAuthority;
  const execution = TeamOwner.prototype.assertExecutionAllowed;
  const control = TeamOwner.prototype.authorizeRuntimeAccess;
  const mocks = [
    t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
      if (observing && args[1] === lock) {
        rows.push({ namespaceReads: pendingNamespaces, tokens: [], checks: pendingChecks });
        pendingNamespaces = 0; pendingChecks = [];
      }
      return link(...args);
    }),
    t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
      if (observing && args[0] === directory) {
        if (fs.existsSync(lock)) row().namespaceReads++;
        else pendingNamespaces++;
      }
      return directories(...args);
    }),
    t.mock.method(TeamOwnerStore.prototype, 'read', function<T>(this: TeamOwnerStore, name: string): T | undefined {
      if (observing && this.directory === store && name === 'state.json') {
        const [pid, , token] = fs.readFileSync(lock, 'utf8').split('\n');
        assert.equal(pid, String(process.pid)); assert.match(token!, /^[a-f0-9-]{36}$/);
        row().tokens.push(token!);
      }
      const value = (read<T>).call(this, name);
      if (observing && providerDepth && this.directory === store && name === 'state.json' && changeState) {
        const change = changeState; changeState = undefined;
        const next = structuredClone(value) as OwnerState;
        change(next);
        this.write('state.json', next);
      }
      return value;
    }),
    t.mock.method(RuntimeOwner.prototype, 'readCapturedSession', function(this: RuntimeOwner,
      ...args: Parameters<typeof runtime>) {
      const result = runtime.apply(this, args);
      if (measuring && ++runtimeReads === 2) {
        assert.equal(result.record?.phase, 'opening'); assert.equal(result.attached, false);
        assert.equal(fs.existsSync(lock), false, 'Runtime custody remains outside the Team fence');
        observing = true;
      }
      return result;
    }),
    t.mock.method(TeamOwner.prototype, 'capturedProviderAuthority', function(this: TeamOwner,
      ...args: Parameters<typeof provider>) {
      if (observing) {
        const event = 'provider:' + args[0];
        if (fs.existsSync(lock)) row().checks.push(event); else pendingChecks.push(event);
      }
      providerDepth++;
      try { return provider.apply(this, args); } finally { providerDepth--; }
    }),
    t.mock.method(TeamOwner.prototype, 'assertExecutionAllowed', function(this: TeamOwner,
      ...args: Parameters<typeof execution>) {
      if (observing) row().checks.push('execution:' + args[0]);
      const value = execution.apply(this, args);
      if (observing) afterExecution?.();
      return value;
    }),
    t.mock.method(TeamOwner.prototype, 'authorizeRuntimeAccess', function(this: TeamOwner,
      ...args: Parameters<typeof control>) {
      if (observing) row().checks.push('control:' + args[0] + ':' + args[2]);
      return control.apply(this, args);
    }),
  ];
  syncBuiltinESMExports();
  const measure = (expected = true) => {
    rows = []; pendingNamespaces = 0; pendingChecks = []; runtimeReads = 0; measuring = true;
    try {
      assert.equal(context.canAllocate(), expected, 'the actual original factory guard observes current authority');
      assert.equal(runtimeReads, 2, 'both original Runtime custody observations execute');
      return structuredClone(rows);
    } finally {
      observing = measuring = false;
      assert.equal(fs.existsSync(lock), false, 'the entire shared fence ends before authority returns');
    }
  };
  try {
    const observed = measure();
    const pairs = observed.flatMap((value, index) => {
      if (!value.checks[0]?.startsWith('provider:')) return [];
      const following = observed[index + 1];
      const scopes = value.checks.some(check => check.startsWith('execution:')) ? [value]
        : following?.checks[0]?.startsWith('execution:') ? [value, following] : [];
      assert.ok(scopes.length, 'each original readiness provider check is followed by allocation');
      return [{ publications: scopes.length, namespaceReads: scopes.reduce((sum, item) => sum + item.namespaceReads, 0),
        tokens: scopes.flatMap(item => item.tokens), checks: scopes.flatMap(item => item.checks) }];
    });
    assert.ok(pairs.length > 0, 'actual NDJSON default launch reaches its provider/allocation readiness pair');
    assert.deepEqual(observed.flatMap(value => value.checks), pairs.flatMap(value => value.checks),
      'no original execution/control check may be omitted or repeated outside its provider pair');
    t.diagnostic(JSON.stringify({ defaultFreshPairs: pairs.map(value => ({ ...value, tokens: value.tokens.length })) }));
    for (const value of pairs) {
      assert.equal(value.namespaceReads, 8, 'all eight original namespace observations remain');
      assert.equal(value.tokens.length, 7, 'all seven original state reads remain fresh');
      assert.deepEqual(value.checks, ['provider:' + context.profile.principalId,
        'execution:' + principalId, 'control:' + principalId + ':control']);
      assert.equal(value.publications, 1, 'the actual default readiness pair shares one physical publication');
      assert.equal(new Set(value.tokens).size, 1, 'the whole pair retains its original canonical token');
    }
    const later = measure();
    assert.deepEqual(later.map(value => ({ ...value, tokens: value.tokens.length })),
      observed.map(value => ({ ...value, tokens: value.tokens.length })),
      'the next callback retains every original observation and physical boundary');
    const beforeTokens = new Set(observed.flatMap(value => value.tokens));
    assert.ok(later.flatMap(value => value.tokens).every(token => !beforeTokens.has(token)),
      'a later invocation cannot retain any prior token or currentness result');
    const mutations: [string, (state: OwnerState) => void][] = [
      ['admin permission', state => { state.grants.find(grant => grant.principalId === principalId)!.permissions = ['read']; }],
      ['grant revision', state => { const grant = state.grants.find(grant => grant.principalId === principalId)!;
        grant.revision = (grant.revision ?? 1) + 1; }],
      ['lifecycle', state => { state.lifecycle = { cleanupCommandId: 'TEST-pending', cleanupPending: true }; }],
      ['member removal', state => { state.members = state.members.filter(member => member.memberId !== context.profile.memberId); }],
    ];
    for (const [name, change] of mutations) {
      changeState = change;
      const refused = measure(false);
      assert.equal(changeState, undefined, name + ' is changed after the original provider state read');
      assert.equal(refused.length, 1, name + ' fails within the same physical pair without an outside retry');
      restore(); measure();
    }
    if (process.platform !== 'win32') {
      const changed = join(directory, 'TEST-replaced-namespace');
      afterExecution = () => { afterExecution = undefined; fs.symlinkSync(root, changed, 'dir'); };
      try {
        const refused = measure(false);
        assert.equal(refused.length, 1, 'namespace replacement fails inside the one original pair');
        assert.equal(refused[0]!.checks.some(check => check.startsWith('control:')), false,
          'the original nested namespace check refuses before current control');
      } finally { afterExecution = undefined; fs.rmSync(changed, { force: true }); }
      measure();
    }
  } finally {
    observing = measuring = false; changeState = undefined; afterExecution = undefined;
    restore();
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
  }
}
