// Real packaged Windows Electron IPC -> released teammate runtime -> localhost
// test model -> original direct-process Stop. Only the model response is synthetic.
// Tool-window enumeration, model reasoning and forced-exit are separate gates.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pause, type PackagedDefaultCdp } from './packaged-default-cdp.ts';
import { type DefaultProcessLedger, type ProcessIdentity } from './packaged-default-processes.ts';
import { configuredDefault, probePrompt, type GatewayRequest } from './default-model-gateway.ts';
// @ts-expect-error Existing native process inventory is a JavaScript utility.
import { processes } from '../opencode-diagnostics/platform.mjs';

interface ProductInput {
  cdp: PackagedDefaultCdp;
  ledger: DefaultProcessLedger;
  appIdentity: ProcessIdentity;
  gatewayRequests: GatewayRequest[];
  project: string;
  evidenceRoot: string;
  marker: string;
}
type RuntimeMember = {
  alive?: boolean; backendType?: string; runtimePid?: number; pid?: number;
  providerId?: string; runtimeModel?: string; historicalBootstrapConfirmed?: boolean;
};
type Snapshot = { runId?: string; members?: Record<string, RuntimeMember> };
type IpcReply = { done: boolean; value?: unknown; error?: string };

async function until<T>(label: string, read: () => Promise<T | null | false | undefined>,
  timeout = 180_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await pause(300);
  }
  throw new Error('Product Windows E2E timeout: ' + label);
}
function alive(original: ProcessIdentity): boolean {
  return (processes() as ProcessIdentity[]).some(
    row => row.pid === original.pid && row.birth === original.birth);
}
async function ipc(cdp: PackagedDefaultCdp, expression: string, key: string) {
  const literal = JSON.stringify(key);
  await cdp.evaluate('(() => { window[' + literal + ']={done:false};' +
    'Promise.resolve(' + expression + ').then(' +
    'value => window[' + literal + ']={done:true,value},' +
    'error => window[' + literal + ']={done:true,error:String(error)});' +
    'return true; })()');
  return until('real IPC ' + key, async () => {
    const reply = await cdp.evaluate<IpcReply>('window[' + literal + ']');
    if (!reply?.done) return null;
    if (reply.error) throw new Error('Product IPC failed: ' + reply.error.slice(0, 300));
    return { value: reply.value ?? null };
  });
}

export async function proveWindowsProductTeam(input: ProductInput) {
  assert.equal(process.platform, 'win32');
  const {cdp, ledger, appIdentity, gatewayRequests, project, evidenceRoot, marker} = input;
  assert(/^WINDOWS_PRODUCT_TEAM_E2E_[0-9a-f-]{36}$/.test(marker));
  const name = 'windows-product-e2e-' + marker.slice(-12);
  let started = false;
  let original: ProcessIdentity | null = null;
  const report: Record<string, unknown> = {
    schemaVersion: 1, kind: 'actual-product-IPC-native-member', platform: 'win32',
    appPid: appIdentity.pid, teamName: name, passed: false,
    modelEndpoint: 'localhost-only', paidModelInvoked: false,
    fullSemanticInferenceProven: false, realToolCallsProven: false,
    actualConsoleWindowsEnumerated: false, forceExitRetirementProven: false,
  };
  try {
    const request = {
      teamName: name, cwd: project, providerId: 'anthropic',
      model: configuredDefault, skipPermissions: true, syncModelsWithLead: true,
      // The message nonce is intentionally absent from launch/lead prompts:
      // only the worker's later physical inbox message may carry it.
      prompt: 'Owned sandbox only. Do not modify files or invoke tools. Reply READY.',
      members: [{name: 'worker', role: 'Native Windows process acceptance',
        providerId: 'anthropic', model: configuredDefault}],
    };
    const response = await ipc(cdp,
      'window.electronAPI.teams.createTeam(' + JSON.stringify(request) + ')',
      '__windowsProductLaunch');
    const runId = (response.value as {runId?:string} | null)?.runId;
    assert(typeof runId === 'string' && runId.length > 0, 'No product runId');
    started = true;
    const snapshot = await until<Snapshot>('original product teammate readiness', async () => {
      const state = await cdp.evaluate<Snapshot>(
        'window.electronAPI.teams.getTeamAgentRuntime(' + JSON.stringify(name) + ')');
      const member = state?.members?.worker;
      return member?.alive && member.runtimePid && member.historicalBootstrapConfirmed
        ? state : null;
    });
    assert.equal(snapshot.runId, runId);
    const member = snapshot.members!.worker!;
    assert.equal(member.backendType, 'process', 'Must use native direct-process backend');
    assert.equal(member.providerId, 'anthropic');
    assert.equal(member.runtimeModel, configuredDefault);
    const pid = member.runtimePid!;
    original = await until('member process inside original app tree', async () =>
      ledger.sample().find(row => row.pid === pid) ?? null, 20_000);
    assert(original.pid !== appIdentity.pid && alive(original));
    report.runtime = {runId, pid, birth: original.birth,
      backendType: member.backendType, bootstrapConfirmed: true};
    const focusedBefore = await cdp.evaluate<boolean>('document.hasFocus()');
    const floor = gatewayRequests.length;
    await ipc(cdp,
      'window.electronAPI.teams.sendMessage(' + JSON.stringify(name) + ',' +
        JSON.stringify({member:'worker',from:'user',text:probePrompt + ' ' + marker}) + ')',
      '__windowsProductMessage');
    const receipt = await until('actual worker loopback model request', async () =>
      gatewayRequests.slice(floor).find(row => row.path === '/v1/messages' &&
        row.model === configuredDefault && row.productMarkerSeen &&
        row.authorized && row.allowed && row.completed) ?? null, 120_000);
    const focusedAfter = await cdp.evaluate<boolean>('document.hasFocus()');
    assert(focusedBefore && focusedAfter, 'Product GUI focus could not be verified');
    report.modelRequestId = receipt.id;
    report.focusedAtBoundaries = true;
    await cdp.screenshot(path.join(evidenceRoot, 'windows-product-team.png'));
    // The original PID+birth must still exist immediately before product Stop.
    // Otherwise a no-op Stop could falsely qualify prior worker retirement.
    assert(original && alive(original), 'Original worker exited before real product Stop');
    report.originalWorkerAliveImmediatelyBeforeStop = true;
    await ipc(cdp, 'window.electronAPI.teams.stop(' + JSON.stringify(name) + ')',
      '__windowsProductStop');
    started = false;
    await until('original worker exited after real product Stop',
      async () => original && !alive(original) ? true : null, 45_000);
    report.originalWorkerRetiredAfterStop = true;
    report.passed = true;
    return report;
  } finally {
    if (started) {
      await ipc(cdp, 'window.electronAPI.teams.stop(' + JSON.stringify(name) + ')',
        '__windowsProductStopOnFailure').catch(() => undefined);
    }
    if (original) report.originalWorkerStillAliveAtEnd = alive(original);
    await writeFile(path.join(evidenceRoot, 'windows-product-team-result.json'),
      JSON.stringify(report, null, 2) + '\n');
  }
}
