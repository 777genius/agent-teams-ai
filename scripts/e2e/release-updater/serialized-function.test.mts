import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { serializedFunction } from './serialized-function.mts';
import { transportHook } from './transport.mts';

import type { TransportState } from './transport.mts';

// Run through tsx as well as builtin stripping: the actual compiler can add
// __name around transportHook's nested bind callback. A foreign realm supplies
// none of the harness module's lexical globals. This proves only serialization.
void test('actual transport hook binds both sessions without touching foreign compiler globals', () => {
  const foreignHelper = () => {
    throw new Error('Original app helper must remain unused');
  };
  const realm = {
    __name: foreignHelper,
    URL,
    process: { env: {}, resourcesPath: 'TEST-resources', execPath: 'TEST-executable', arch: 'x64' },
  };
  const source = `(() => {
    let ready;
    const bindings={};
    const makeSession=name=>({webRequest:{onBeforeRequest:(_,listener)=>{bindings[name]=listener}}});
    const defaultSession=makeSession('default'), partition=makeSession('electron-updater');
    const electron={app:{isReady:()=>false,prependOnceListener:(_,listener)=>{ready=listener},getPath:name=>name,getVersion:()=> '2.17.1',isPackaged:true},session:{defaultSession,fromPartition:()=>partition}};
    const updater={constructor:{name:'NsisUpdater'},currentVersion:{version:'2.17.1'},on:()=>{}};
    (${serializedFunction(transportHook)})(electron,()=>updater,'http://127.0.0.1:1234',['/github/777genius/agent-teams-ai/releases.atom']);
    ready();
    const results=[];
    for(const session of ['default','electron-updater']) bindings[session]({method:'GET',url:'https://github.com/777genius/agent-teams-ai/releases.atom'},result=>results.push(result));
    return JSON.stringify({state:globalThis.__TEST_nativeUpdater,results});
  })()`;
  // Only the fixed repository hook and test realm execute; no app/runtime is started.
  // eslint-disable-next-line sonarjs/code-eval
  const raw: unknown = runInNewContext(source, realm, { timeout: 500 });
  assert(typeof raw === 'string');
  const parsed = JSON.parse(raw) as { state: TransportState; results: { redirectURL: string }[] };
  assert.equal(parsed.state.error, undefined);
  assert.deepEqual(parsed.state.bound, ['default', 'electron-updater']);
  assert.deepEqual(
    parsed.results.map((result) => new URL(result.redirectURL).searchParams.get('TEST_session')),
    ['default', 'electron-updater']
  );
  assert.equal(realm.__name, foreignHelper);
});
