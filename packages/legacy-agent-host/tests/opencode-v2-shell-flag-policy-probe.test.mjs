import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeShellFlagPermissionSplit } from './opencode-v2-shell-flag-policy-probe.mjs';

const rules = [
  { action: 'shell', resource: '*', effect: 'allow' },
  { action: 'external_directory', resource: '*', effect: 'deny' },
];
function fakeNative({ shellEffect = 'allow', externalEffect = 'deny' } = {}) {
  const calls = [], base = '/api/session/ses_TESTflag';
  async function call(path, method = 'GET', body) {
    calls.push({ path, method, body });
    if (path === '/api/session' && method === 'POST')
      return { status: 200, data: { data: { id: 'ses_TESTflag' } } };
    if (path === base && method === 'GET')
      return { status: 200, data: { data: { id: 'ses_TESTflag', permissions: rules } } };
    if (path === base && method === 'DELETE') return { status: 204 };
    if (path === base + '/permission' && method === 'POST')
      return { status: 200, data: { data: { effect: body.action === 'shell' ? shellEffect : externalEffect } } };
    if (path === base + '/permission' && method === 'GET')
      return { status: 200, data: { data: [] } };
    throw Error('TEST_unexpected_native_method');
  }
  return { call, calls };
}
test('native decision split is never a tool-execution certificate', async () => {
  const {call, calls}=fakeNative();
  assert.deepEqual(await observeShellFlagPermissionSplit(call,'/TEST-workspace','/TEST-owned'),
    {decisionSplitObserved:true,toolExecutionProven:false});
  assert.equal(calls.length,6);
  assert.deepEqual(calls.filter(x=>x.method==='POST').map(x=>x.body?.action),
    [undefined,'shell','external_directory']);
  assert.equal(calls[2].body.resources[0],'git -C /TEST-owned/temp/TEST-outside-shell-flag status');
  assert.equal(calls.at(-1).method,'DELETE');
});
test('external ALLOW fails closed with exactly one cleanup',async()=>{
  const {call,calls}=fakeNative({externalEffect:'allow'});
  await assert.rejects(observeShellFlagPermissionSplit(call,'/TEST-workspace','/TEST-owned'),
    /TEST_shell_flag_native_external_decision_unqualified/);
  assert.equal(calls.filter(x=>x.method==='DELETE').length,1);
});
test('shell ASK fails before external request with exactly one cleanup',async()=>{
  const {call,calls}=fakeNative({shellEffect:'ask'});
  await assert.rejects(observeShellFlagPermissionSplit(call,'/TEST-workspace','/TEST-owned'),
    /TEST_shell_flag_native_shell_decision_unqualified/);
  assert.equal(calls.filter(x=>x.method==='DELETE').length,1);
  assert.equal(calls.some(x=>x.body?.action==='external_directory'),false);
});
