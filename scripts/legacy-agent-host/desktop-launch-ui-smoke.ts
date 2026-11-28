import { createDesktopCodexSourceSelection } from './desktop-codex-source-selection.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileDigest } from './desktop-backend-fixture.ts';
import { replaceRosterSchema, savedTeamSettingsSchema, teamRosterRevision } from '../../packages/legacy-agent-host/dist/team/rosterSchema.js';
import { FileManagementCommandStore } from '../../packages/legacy-agent-host/dist/adapters/providers/FileManagementCommandStore.js';
import { managementDigest } from '../../packages/legacy-agent-host/dist/management/identity.js';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { teamModelProbeContext, teamModelProbeActionDigest } from '../../packages/legacy-agent-host/dist/composition/teamLaunchModelProbe.js';
import type { StoredModelProbe } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import { readDesktopNativeStopSessions, readDesktopNativeHostProcesses, separateDesktopOpenCodeRuntimeChildren, observeDesktopOpenCodeMetadata, captureDesktopOpenCodeGlobalMetadata, captureDesktopOpenCodeProjectMetadata } from './desktop-native-stop-fixture.ts';
import { command, processTable } from './desktop-backend-observations.ts';
import { captureCodexCodeModeProcess, observeCodexCodeModeProcess } from '../../packages/legacy-agent-host/tests/fixtures/codex-native-closure.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import { createDesktopOriginalActionReadTiming } from './desktop-ui-read-observation.ts';
import { runDesktopRelaunchUiSmoke } from './desktop-relaunch-ui-smoke.ts';
import { runDesktopNativeCommandsUiProof } from './desktop-native-commands-ui-proof.ts';
import { runDesktopCodexCostUiProof } from './desktop-codex-cost-ui-proof.ts';
import { prepareDesktopNativeExtensionSkillsUi } from './desktop-native-extension-skills-ui.ts';
import { runDesktopNativeExtensionCommandsUi } from './desktop-native-extension-consumption-ui-proof.ts';
import { runDesktopNativeExtensionsUiSmoke } from './desktop-native-extensions-ui-smoke.ts';
import { codexRuntimeEndpointHash, runDesktopResumeUiSmoke } from './desktop-resume-ui-smoke.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { prepareDesktopProofFixture } from './desktop-proof-fixture.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import type { startCodexModel } from '../../packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts';
import type { startOpenCodeModel } from '../../packages/legacy-agent-host/tests/fixtures/native-opencode-team/model.ts';

const record = (raw: unknown): Record<string, unknown> => {
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
  return raw as Record<string, unknown>;
};
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as unknown;

/** Observe one original TEST probe's remaining time; this grants no readiness or launch authority. */
export async function waitForDesktopOpenCodePreflight(cdp: UiCdpPort, options: {
  fixture: { root: string; profilePath: string; handleId: string; pins: { profileSha256: string };
    openCodeV2: { model: string; displayName: string } };
  prompt: string;
  proof: Record<string, unknown>;
  ownerState(): Promise<Record<string, unknown>>;
  assertOwnedRenderer(): void;
  step(value: Record<string, unknown>): void;
}): Promise<ReturnType<typeof createDesktopUiControls>> {
  // Match Main's original OpenCode preparation ceiling; this is observation,
  // not a UI latency promise or a renewal of any subsequently observed cutoff.
  const acquisitionTimeoutMs = 100_000;
  const acquisitionDeadline = Date.now() + acquisitionTimeoutMs;
  let original: { commandId: string; identity: string; deadline: number } | undefined;
  let store: FileManagementCommandStore | undefined, completedEnvelope: string | undefined;
  const assertWithin = (): void => {
    options.assertOwnedRenderer();
    assert.ok(Date.now() < (original?.deadline ?? acquisitionDeadline),
      'Original OpenCode preflight observation expired; no replacement probe');
  };
  const readProfile = async () => {
    assertWithin();
    const bytes = await readFile(options.fixture.profilePath);
    assertWithin();
    assert.equal(createHash('sha256').update(bytes).digest('hex'), options.fixture.pins.profileSha256,
      'original TEST profile bytes remain pinned');
    return record(JSON.parse(bytes.toString('utf8')));
  };
  const assertPinnedProfile = (): void => {
    assertWithin();
    const actual = createHash('sha256').update(readFileSync(options.fixture.profilePath)).digest('hex');
    assertWithin();
    assert.equal(actual, options.fixture.pins.profileSha256, 'original TEST profile bytes remain pinned');
  };
  const profile = await readProfile(), owner = record(profile.owner);
  const teams = profile.teams;
  assert.ok(Array.isArray(teams) && teams.length === 1, 'one original TEST team');
  const team = record(teams[0]), binding = record(team.binding), scope = record(team.scope);
  const workspace = join(options.fixture.root, 'workspace'), storageRoot = join(options.fixture.root, 'hoststore');
  assert.equal(owner.storageRoot, storageRoot);
  assert.equal(binding.teamName, 'test-desktop-backend');
  assert.equal(binding.backendId, owner.ownerId);
  assert.equal(scope.teamId, binding.teamId);
  assert.equal(typeof scope.runId, 'string');
  assert.equal(options.fixture.openCodeV2.model, 'test-local/TEST-model', 'only the existing localhost TEST model');
  const ownerDigest = managementDigest(owner), bindingDigest = runtimeDigest(binding);
  // This joins one prospective request to the original form, not an independent
  // proof of its saved source. Only Host admission and the unchanged UI qualify readiness.
  const matchesSavedRequest = (probe: StoredModelProbe, state: Record<string, unknown>): boolean => {
    const captured = probe.readinessScope!, origin = probe.localModelReadinessOrigin!;
    if (!/^saved-model-[a-f0-9]{64}$/.test(captured.sourceRevision)) return false;
    assert.ok(typeof options.fixture.handleId === 'string' && options.fixture.handleId.length > 0);
    const rosterRevision = (value: Record<string, unknown>): string => {
      assert.ok(Array.isArray(value.members), 'original TEST roster members are present');
      for (const member of value.members.map(record)) assert.ok(typeof member.memberId === 'string' &&
        typeof member.name === 'string' && (member.role === 'lead' || member.role === 'member'));
      assert.ok(value.rosterVersion === undefined || Number.isSafeInteger(value.rosterVersion) && Number(value.rosterVersion) >= 0);
      return teamRosterRevision(value.members as Parameters<typeof teamRosterRevision>[0],
        value.rosterVersion as number | undefined, savedTeamSettingsSchema.parse(value.savedSettings));
    };
    const originalRoster = rosterRevision(team);
    const leads = (team.members as unknown[]).map(record).filter(member => member.role === 'lead');
    assert.equal(leads.length, 1, 'one original TEST lead');
    if (captured.rosterRevision !== originalRoster || rosterRevision(state) !== originalRoster) return false;
    const payload = { launchId: captured.sourceRevision, rosterRevision: originalRoster,
      memberId: leads[0]!.memberId as string, model: options.fixture.openCodeV2.model,
      draft: { providerId: 'opencode' as const, target: { kind: 'lead' as const }, workspace } };
    const context = teamModelProbeContext(binding.teamId as string, payload);
    return captured.selectionDigest === runtimeDigest(payload) && probe.context === context &&
      captured.actionDigest === teamModelProbeActionDigest(probe.commandId, context) &&
      captured.destinationKeys.length === 1 && captured.destinationKeys[0] === runtimeDigest(payload.draft.target) &&
      origin.selectionDigest === managementDigest({ handleId: options.fixture.handleId, scope, payload });
  };
  const stableIdentity = (probe: StoredModelProbe): string => {
    const stable: Record<string, unknown> = { ...probe };
    for (const key of ['phase', 'ok', 'resourceHeld', 'readiness', 'nativeFileKeyWitness']) delete stable[key];
    return managementDigest(stable);
  };
  const readOriginal = (state: Record<string, unknown>): StoredModelProbe | undefined => {
    assertWithin();
    if (!store) try { store = new FileManagementCommandStore(storageRoot, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !original) return; throw error; }
    const matches: StoredModelProbe[] = [];
    let count = 0;
    for (const probe of store.list()) {
      assert.ok(++count <= 32, 'bounded original TEST management journal');
      if (probe.kind === 'model.probe' && probe.purpose === 'native-local-readiness-v1' &&
          probe.providerId === 'test-local' && probe.modelId === 'TEST-model' &&
          probe.readinessScope?.kind === 'team' && probe.readinessScope.teamBindingDigest === bindingDigest &&
          probe.readinessScope.workspace === workspace &&
          probe.localModelReadinessOrigin?.kind === 'team' && probe.localModelReadinessOrigin.ownerDigest === ownerDigest &&
          (probe.readinessScope.sourceRevision === scope.runId || matchesSavedRequest(probe, state)))
        matches.push(probe);
    }
    assertWithin();
    assert.ok(matches.length <= 1, 'ambiguous original OpenCode preflight probe');
    if (!matches.length) {
      assert.equal(original, undefined, 'original OpenCode preflight probe disappeared or was replaced');
      return;
    }
    const probe = matches[0]!, origin = probe.localModelReadinessOrigin!, preparation = probe.localModelReadinessPreparation!;
    assert.equal(origin.contextId, 'local');
    assert.equal(origin.commandId, probe.commandId);
    assert.equal(preparation.anchorCommandId, probe.commandId);
    assert.equal(preparation.originDigest, managementDigest(origin));
    assert.deepEqual(origin.workspaces.map(value => value.path), [workspace]);
    assert.equal(probe.profileId, probe.configRevision);
    assert.match(probe.profileId, /^team-probe-[a-f0-9]{64}$/);
    assert.match(probe.commandId, /^team-preflight-[a-f0-9]{64}$/);
    assert.equal(probe.readinessRetired, undefined, 'original readiness was not consumed or retired');
    assert.ok(probe.phase === 'running' || probe.phase === 'completed' && probe.ok && !probe.resourceHeld,
      'original preflight refused or cleanup is unresolved');
    const deadline = Math.min(probe.expiresAt, probe.readinessScope!.cutoff, preparation.expiresAt);
    assert.ok(Number.isSafeInteger(deadline) && Date.now() < deadline, 'original preflight cutoff expired');
    const identity = stableIdentity(probe);
    if (!original) {
      assert.ok(Date.now() < acquisitionDeadline, 'original probe acquisition exceeded its fixed preparation observation ceiling');
      original = { commandId: probe.commandId, identity, deadline };
      options.proof.originalPreflightWait = { authority: 'wait-bound-only', commandId: probe.commandId,
        profileId: probe.profileId, fingerprint: probe.fingerprint, context: probe.context,
        sourceRevision: probe.readinessScope!.sourceRevision,
        ownerDigest, bindingDigest, initialEnvelopeDigest: managementDigest(probe), identity,
        acquisitionDeadline, deadline, probeExpiresAt: probe.expiresAt,
        scopeCutoff: probe.readinessScope!.cutoff, preparationExpiresAt: preparation.expiresAt };
    } else assert.deepEqual({ commandId: probe.commandId, identity, deadline }, original,
      'original OpenCode preflight identity or cutoff changed');
    if (probe.phase === 'completed') {
      const envelope = managementDigest(probe);
      if (completedEnvelope) assert.equal(envelope, completedEnvelope, 'original completed preflight changed');
      completedEnvelope = envelope;
    } else assert.equal(completedEnvelope, undefined, 'original completed preflight regressed');
    assertWithin();
    return probe;
  };
  const beforeRead = async (): Promise<void> => {
    await readProfile();
    const state = await options.ownerState();
    assertPinnedProfile();
    assert.deepEqual(state.binding, binding, 'original Team owner binding changed');
    readOriginal(state);
  };
  const expression = `(() => {
    const prompts=[...document.querySelectorAll('[role="dialog"] #dialog-prompt')];
    if(prompts.length!==1)return {current:false,ready:false};
    const prompt=prompts[0],dialog=prompt.closest('[role="dialog"]');
    const current=Boolean(dialog&&prompt.value===${JSON.stringify(options.prompt)}&&
      dialog.querySelector('#dialog-skip-permissions')?.getAttribute('data-state')==='checked'&&
      dialog.querySelector('button[aria-label*=" provider,"]')?.getAttribute('aria-label')===
        ${JSON.stringify('OpenCode provider, ' + options.fixture.openCodeV2.displayName)});
    const launch=dialog?[...dialog.querySelectorAll('button')].filter(button=>button.textContent.trim()==='Launch team'):[];
    return {current,ready:launch.length===1&&!launch[0].disabled};
  })()`;
  const currentForm = (value: unknown): Record<string, unknown> => {
    const form = record(value);
    assert.equal(form.current, true, 'original OpenCode launch form changed during preflight');
    return form;
  };
  const observationUi = createDesktopUiControls(cdp, { assertOwnedRenderer: assertWithin, step: options.step });
  await observationUi.waitRead(expression, 'one original OpenCode preflight command', acquisitionTimeoutMs,
    value => { currentForm(value); return original !== undefined; }, { deadline: acquisitionDeadline, beforeRead });
  assert.ok(original);
  await observationUi.waitRead(expression, 'original OpenCode preflight within its immutable cutoff',
    original.deadline - Date.now(), value => currentForm(value).ready === true, { deadline: original.deadline, beforeRead });
  await beforeRead(); // A late DOM result cannot outlive the original receipt or owner.
  assertWithin();
  const assertCurrent = (): void => {
    assertPinnedProfile();
    const state = record(JSON.parse(readFileSync(
      join(storageRoot, 'teams/test-desktop-backend/.host-owner/state.json'), 'utf8'
    )));
    assertWithin();
    assert.deepEqual(state.binding, binding, 'original Team owner binding changed');
    assert.ok(readOriginal(state));
  };
  // These controls are used only for the existing pre-submit scroll/click. Their
  // reads stay bound to the original owner/receipt; Input dispatch remains unchanged.
  return createDesktopUiControls({
    async evaluate(source) {
      await beforeRead();
      const value = record(await cdp.evaluate(`(() => { const form=${expression}; const value=(${source}); return {form,value}; })()`));
      // Keep every fresh owner/source fence without another await after the DOM sample.
      assertCurrent();
      currentForm(value.form);
      return value.value;
    },
    send: (method, params) => cdp.send(method, params),
  }, { assertOwnedRenderer: assertCurrent, step: options.step });
}

/** Renderer source only: the Main normalization and original Host envelope remain unobserved. */
function projectSubmittedRoster(raw: unknown, handleId: string): Record<string, unknown> {
  const value = record(raw);
  if ('unavailable' in value) {
    const reasons = ['submitted-ref-missing', 'submitted-ref-ambiguous', 'submitted-ref-malformed',
      'submitted-signature-limit', 'submitted-source-mismatch', 'submitted-form-detached',
      'submitted-hook-traversal-truncated'];
    return { unavailable: typeof value.unavailable === 'string' && reasons.includes(value.unavailable)
      ? value.unavailable : 'submitted-diagnostic-unavailable' };
  }
  assert.equal(typeof value.commandId, 'string');
  assert.equal(typeof value.signature, 'string');
  const commandId = value.commandId as string, signature = value.signature as string;
  assert.ok(commandId.startsWith('roster:') && commandId.length <= 256 &&
    commandId.trim() === commandId && !commandId.includes('\0'));
  assert.ok(Buffer.byteLength(signature, 'utf8') <= 256 * 1024);
  const submitted = record(JSON.parse(signature));
  const request = record(submitted.request), metadata = record(submitted.metadata);
  const command = record(metadata.command), configuration = record(metadata.configuration);
  assert.equal(request.teamName, 'host-team:' + encodeURIComponent(handleId));
  assert.equal(command.commandId, commandId);
  assert.equal(command.idempotencyKey, commandId);
  const payload = {
    expectedRevision: configuration.expectedRevision,
    members: submitted.members,
    ...(configuration.savedSettings === undefined ? {} : { savedSettings: configuration.savedSettings }),
    ...(submitted.intent === undefined ? {} : { memberSettingsRelaunch: submitted.intent }),
  };
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const type = (item: unknown) => item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
  const settings = configuration.savedSettings;
  const configured = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings as Record<string, unknown> : undefined;
  const fields = ['runtimeSelectionVersion', 'cwd', 'displayName', 'description', 'color', 'prompt',
    'providerId', 'providerBackendId', 'model', 'effort', 'fastMode', 'syncModelsWithLead',
    'limitContext', 'skipPermissions', 'worktree', 'extraCliArgs', 'allowExperimentalLocalModels'];
  const present = (source: Record<string, unknown> | undefined, key: string) =>
    source && Object.hasOwn(source, key) ? type(source[key]) : 'absent';
  const admitted = (source: Record<string, unknown> | undefined, key: string, values: string[]) =>
    typeof source?.[key] === 'string' && values.includes(source[key] as string) ? source[key] : null;
  const providers = ['anthropic', 'codex', 'gemini', 'opencode'];
  const backends = ['auto', 'adapter', 'api', 'cli-sdk', 'codex-native', 'opencode-cli'];
  const version = (source: Record<string, unknown> | undefined) =>
    !source || !Object.hasOwn(source, 'runtimeSelectionVersion') ? 'absent'
      : source.runtimeSelectionVersion === 1 ? 'exactly-1' : 'other-type-or-value';
  const checked = replaceRosterSchema.safeParse({ commandId, ...payload });
  const knownFields = new Set([...fields, 'commandId', 'expectedRevision', 'members', 'name',
    'savedSettings', 'memberSettingsRelaunch', 'role', 'workflow', 'isolation', 'mcpPolicy',
    'mode', 'scopes', 'user', 'project', 'local', 'serverNames', 'memberName', 'targetKind',
    'expectedFingerprint', 'expectedTeamSettingsFingerprint', 'baseline']);
  const knownCodes = new Set(['invalid_type', 'invalid_value', 'invalid_format', 'too_big',
    'too_small', 'custom', 'unrecognized_keys', 'invalid_union', 'not_multiple_of',
    'invalid_key', 'invalid_element', 'invalid_enum_value', 'invalid_literal', 'invalid_string']);
  return {
    commandId, signatureSha256: hash(signature), payloadSha256: hash(JSON.stringify(payload)),
    expectedRevisionDigest: typeof payload.expectedRevision === 'string' &&
      /^[a-f0-9]{64}$/.test(payload.expectedRevision) ? payload.expectedRevision : null,
    expectedRevisionType: type(payload.expectedRevision),
    memberCount: Array.isArray(submitted.members) ? submitted.members.length : null,
    membersType: type(submitted.members), savedSettingsType: type(settings),
    configuredFields: Object.fromEntries(fields.map(key => [key, present(configured, key)])),
    requestFields: Object.fromEntries(fields.map(key => [key, present(request, key)])),
    configuredProvider: admitted(configured, 'providerId', providers),
    configuredBackend: admitted(configured, 'providerBackendId', backends),
    requestProvider: admitted(request, 'providerId', providers),
    requestBackend: admitted(request, 'providerBackendId', backends),
    runtimeSelectionVersion: version(configured), requestRuntimeSelectionVersion: version(request),
    rendererSourceSchemaCheck: checked.success ? { accepted: true } : {
      accepted: false, truncated: checked.error.issues.length > 8,
      issues: checked.error.issues.slice(0, 8).map(issue => ({
        code: knownCodes.has(issue.code) ? issue.code : 'other-code',
        path: issue.path.slice(0, 8).map(segment => typeof segment === 'string' && knownFields.has(segment)
          ? segment : typeof segment === 'number' && Number.isInteger(segment) &&
            segment >= 0 && segment < 256 ? segment : 'other-field'),
        pathTruncated: issue.path.length > 8,
      })),
    },
  };
}

/** Private React-layout-dependent TEST diagnosis only; never a workflow qualification. */
export async function captureReadiness(
  cdp: UiCdpPort,
  handleId: string,
  proof: Record<string, unknown>,
  assertOwnedRenderer: () => void,
  phase: 'before-original-submit' | 'original-submit-failed'
): Promise<void> {
  const diagnostics = (proof.readinessDiagnostics ??= []) as unknown[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    assertOwnedRenderer();
    const snapshot = await Promise.race([
      cdp.evaluate(`(() => {
          const teamName=${JSON.stringify('host-team:' + encodeURIComponent(handleId))};
          const captureSubmitted=${phase === 'original-submit-failed'};
          const prompt=document.querySelector('[role="dialog"] #dialog-prompt'),dialog=prompt?.closest('[role="dialog"]');
          if(!prompt||!dialog)return {unavailable:'original-launch-dialog-unavailable',now:Date.now()};
          const field=(value,key)=>value&&(typeof value==='object'||typeof value==='function')
            ?Object.getOwnPropertyDescriptor(value,key)?.value:undefined;
          const submit=[...dialog.querySelectorAll('button')].filter(button=>button.textContent.trim()==='Launch team');
          const result={now:Date.now(),teamName,form:{prompt:prompt.value,
            model:dialog.querySelector('button[aria-label*=" provider,"]')?.getAttribute('aria-label')??null,
            effort:dialog.querySelector('#lead-effort')?.textContent.trim()??null,
            submit:submit.map(button=>({disabled:button.disabled,text:button.textContent.trim()}))},checks:[],currentDraftSignatures:[]};
          const key=Object.keys(prompt).find(key=>key.startsWith('__reactFiber$'));
          const named=node=>{const type=field(node,'type');return typeof type==='function'&&field(type,'name')==='LaunchTeamDialog';};
          const matches=node=>{const props=field(node,'memoizedProps');
            return named(node)&&field(props,'open')===true&&field(props,'teamName')===teamName;};
          const storedName=value=>{const name=typeof value==='string'?value:field(value,'name');return typeof name==='string'?name.slice(0,100):null;};
          const ancestorTrace=[];
          let fiber=key?field(prompt,key):null,root=null,originalComponent=false;
          if(!fiber)return {...result,unavailable:'original-prompt-fiber-missing'};
          for(let depth=0;fiber&&depth<256;depth++,fiber=field(fiber,'return')){
            const props=field(fiber,'memoizedProps'),open=field(props,'open'),tag=field(fiber,'tag');
            ancestorTrace.push({depth,tag:typeof tag==='number'?tag:null,
              typeName:storedName(field(fiber,'type')),elementTypeName:storedName(field(fiber,'elementType')),
              open:typeof open==='boolean'?open:null,originalTeam:field(props,'teamName')===teamName});
            if(named(fiber))originalComponent=true;root=fiber;
          }
          const rootTag=field(root,'tag');
          Object.assign(result,{ancestorTrace,ancestorCount:ancestorTrace.length,
            ancestorLimitHit:Boolean(fiber),namedAncestorFound:originalComponent,rootTag:typeof rootTag==='number'?rootTag:null});
          if(fiber)return {...result,unavailable:'ancestor-traversal-limit'};
          if(!originalComponent)return {...result,unavailable:'launch-component-name-not-found'};
          if(rootTag!==3)return {...result,unavailable:'host-root-tag-mismatch'};
          const currentRoot=field(field(root,'stateNode'),'current');
          if(!currentRoot)return {...result,unavailable:'current-root-missing'};
          const pending=[currentRoot],components=[],seen=new Set();
          let visited=0;
          for(;pending.length&&visited<4096;visited++){
            const node=pending.pop();if(seen.has(node))continue;seen.add(node);
            if(matches(node))components.push(node);
            const sibling=field(node,'sibling'),child=field(node,'child');
            if(sibling)pending.push(sibling);if(child)pending.push(child);
          }
          if(pending.length)return {...result,currentTreeNodesVisited:visited,unavailable:'current-tree-traversal-limit'};
          if(components.length!==1)return {...result,currentTreeNodesVisited:visited,currentComponentMatches:components.length,
            unavailable:components.length===0?'current-launch-component-missing':'current-launch-component-ambiguous'};
          const component=components[0];result.currentTreeNodesVisited=visited;
          const projectChecks=(value,index,origin)=>{
            if(!Array.isArray(value)||!value.length||value.length>8||!value.every(check=>
              ['anthropic','codex','opencode','gemini'].includes(field(check,'providerId'))&&
              ['pending','checking','ready','notes','failed'].includes(field(check,'status'))&&Array.isArray(field(check,'details'))))return;
            result.checks.push({hookIndex:index,origin,checks:value.map(check=>{
              const proof=field(check,'capturedTeamReadiness');
              return {providerId:field(check,'providerId'),status:field(check,'status'),
                details:field(check,'details').slice(0,16).filter(value=>typeof value==='string').map(value=>value.slice(0,2000)),
                capturedTeamDraftSignature:typeof field(check,'capturedTeamDraftSignature')==='string'?field(check,'capturedTeamDraftSignature').slice(0,65536):null,
                capturedTeamReadiness:proof?Object.fromEntries(['handleId','preparationId','launchId','rosterRevision','selectionSignature','expiresAt'].map(key=>[key,field(proof,key)])):null};
            })});
          };
          const submitted=[];
          let hook=field(component,'memoizedState'),count=0;
          for(;hook&&count<1024;hook=field(hook,'next'),count++){
            const value=field(hook,'memoizedState'),current=field(value,'current');
            projectChecks(value,count,'state');projectChecks(current,count,'ref');
            if(captureSubmitted&&current&&typeof current==='object'&&!Array.isArray(current)&&
              Object.hasOwn(current,'commandId')&&Object.hasOwn(current,'signature'))submitted.push(current);
            if(typeof current!=='string'||current.length>65536)continue;
            try{const scope=JSON.parse(current);
              if(Array.isArray(scope)&&scope.length===7&&scope[0]===true&&scope[1]===teamName&&
                typeof scope[2]==='string'&&typeof scope[3]==='string'&&typeof scope[5]==='string'&&Array.isArray(scope[6])&&scope[6].length===12)
                result.currentDraftSignatures.push({hookIndex:count,signature:current});
            }catch{}
          }
          if(captureSubmitted){
            const unavailable=reason=>{result.submittedSource={unavailable:reason};};
            if(hook)unavailable('submitted-hook-traversal-truncated');
            else if(!prompt.isConnected||!dialog.isConnected||prompt.closest('[role="dialog"]')!==dialog||
              document.querySelector('[role="dialog"] #dialog-prompt')!==prompt||
              field(field(root,'stateNode'),'current')!==currentRoot||!matches(component))
              unavailable('submitted-form-detached');
            else if(submitted.length!==1)unavailable(submitted.length?'submitted-ref-ambiguous':'submitted-ref-missing');
            else{
              const original=submitted[0],keys=Reflect.ownKeys(original);
              const data=key=>Object.hasOwn(Object.getOwnPropertyDescriptor(original,key)??{},'value');
              const commandId=field(original,'commandId'),signature=field(original,'signature');
              if(keys.length>4||keys.some(key=>!['commandId','signature','intent','relaunch'].includes(key))||
                !['commandId','signature','intent'].every(data)||keys.some(key=>!data(key))||
                typeof commandId!=='string'||!commandId.startsWith('roster:')||commandId.length>256||
                commandId.trim()!==commandId||commandId.includes('\\0')||typeof signature!=='string')
                unavailable('submitted-ref-malformed');
              else if(signature.length>262144||new TextEncoder().encode(signature).byteLength>262144)
                unavailable('submitted-signature-limit');
              else{
                try{
                  const source=JSON.parse(signature),request=field(source,'request'),metadata=field(source,'metadata');
                  const command=field(metadata,'command');
                  if(field(request,'teamName')!==teamName||field(command,'commandId')!==commandId||
                    field(command,'idempotencyKey')!==commandId)unavailable('submitted-source-mismatch');
                  else result.submittedSource={commandId,signature};
                }catch{unavailable('submitted-ref-malformed');}
              }
            }
          }
          return {...result,hookCount:count,...(hook?{unavailable:'hook-traversal-truncated'}:{})};
        })()`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Readiness diagnostic timed out')), 3000);
      }),
    ]);
    if (phase === 'original-submit-failed') {
      const captured = record(snapshot);
      const submitted = captured.submittedSource;
      delete captured.submittedSource;
      try {
        captured.submittedIntent = submitted === undefined
          ? { unavailable: 'submitted-diagnostic-unavailable' } : projectSubmittedRoster(submitted, handleId);
      } catch {
        captured.submittedIntent = { unavailable: 'submitted-projection-failed' };
      }
    }
    diagnostics.push({ phase, snapshot });
  } catch {
    diagnostics.push({ phase, unavailable: 'readiness-diagnostic-read-failed' });
  } finally {
    clearTimeout(timer);
  }
}

/** All launch effects originate from the original dialog's CDP Input controls. */
export async function runDesktopLaunchUiSmoke(cdp: UiCdpPort, options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopProofFixture>>;
  seed: { taskId: string; subject: string; commandId: string };
  evidence: Record<string, unknown>;
  model?: Awaited<ReturnType<typeof startNativeTeamModel>>;
  codexResumeModel?: Awaited<ReturnType<typeof startCodexModel>>;
  openCodeModel?: Awaited<ReturnType<typeof startOpenCodeModel>>;
  assertOwnedRenderer(): void;
  capturedGroup(): number;
  onHostObserved(pid: number): void;
  restartSameProfile?(codexSourceSelectionRestart?: typeof import('./desktop-captured-app.ts').restartCapturedDesktopApp): Promise<UiCdpPort>;
  currentFixture?(): Awaited<ReturnType<typeof prepareDesktopProofFixture>>;
}): Promise<void> {
  let fixture = options.fixture;
  const { evidence } = options;
  const model = options.openCodeModel ?? options.codexResumeModel ?? options.model;
  assert.ok(model);
  const extensions = process.env.LEGACY_DESKTOP_EXTENSIONS_CONSUMPTION_UI === '1';
  if (extensions) assert.ok(options.model && !fixture.codexResume && !fixture.openCodeV2 &&
    evidence.mode === 'native-launch-ui' && options.restartSameProfile);
  const codex = fixture.codexResume;
  const opencode = fixture.openCodeV2;
  assert.equal(Boolean(codex), Boolean(options.codexResumeModel));
  assert.equal(Boolean(opencode), Boolean(options.openCodeModel));
  if (codex) assert.equal(evidence.mode, 'native-resume-ui');
  const sourceSelection = codex?.sourceSelection ? createDesktopCodexSourceSelection(cdp, {
    fixture, model: options.codexResumeModel!, seed: options.seed, evidence,
    assertOwnedRenderer: options.assertOwnedRenderer, capturedGroup: options.capturedGroup,
    restartSameProfile: options.restartSameProfile,
  }) : undefined;
  const provider = opencode ? 'opencode' : codex ? 'codex' : 'claude';
  const firstPrompt = opencode ? 'OPENCODE_TEAM_ONE' : codex ? 'CODEX_TEAM_ONE' : 'NATIVE_TEAM_ONE';
  const firstReply = opencode ? 'REPLY_OPENCODE_ONE' : codex ? 'REPLY_CODEX_ONE' : 'REPLY_NATIVE_ONE';
  const selectedModel = opencode?.model ?? codex?.model ?? 'claude-opus-4-6';
  const modelLabel = opencode?.displayName ?? (codex ? codex.displayName.replace(/^GPT-/i, '') : 'Opus 4.6');
  const steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE', provider, steps,
    scope: `Original LaunchTeamDialog controls, fresh saved capture, actual SDK/MCP task/message/native effect, Stop and original-dialog settings after ${evidence.mode === 'native-resume-ui' ? 'same-profile cold startup' : 'reload'}`,
    excluded: [evidence.mode === 'native-resume-ui' ? 'Create controls' : 'Create/Resume controls', 'real vendor authentication/inference', 'all advanced settings', 'full Stage1'],
  };
  evidence.launchDialogProof = proof;
  const originalActionReadTiming = opencode && evidence.mode === 'native-resume-ui'
    ? createDesktopOriginalActionReadTiming() : undefined;
  if (originalActionReadTiming) proof.originalActionReadTiming = originalActionReadTiming.data;
  const step = (value: Record<string, unknown>) => steps.push({ monotonicMs: Math.round(performance.now()), ...value });
  let ui = createDesktopUiControls(cdp, { assertOwnedRenderer: () => {
    options.assertOwnedRenderer(); sourceSelection?.observe();
  }, step });
  const teamRoot = join(fixture.root, 'hoststore/teams/test-desktop-backend');
  const ownerState = async () => record(await json(join(teamRoot, '.host-owner/state.json')));
  const poll = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, ms = 60000) => {
    const until = Date.now() + ms;
    let value = await read();
    while (!accept(value) && Date.now() < until) {
      assert.deepEqual(model.failures, [], 'native oracle must not hide tool failures');
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      value = await read();
    }
    assert.ok(accept(value), label);
    return value;
  };
  const expandSettings = async () => {
    const controls = await ui.waitRead(`(() => {
      const rows=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')]
        .filter(e=>e.textContent.includes('Optional launch settings'));
      return rows.length===1 ? {id:rows[0].getAttribute('aria-controls'), expanded:rows[0].getAttribute('aria-expanded')} : null;
    })()`, 'original Optional launch settings');
    const value = record(controls);
    if (value.expanded !== 'true')
      await ui.click(`[role="dialog"] button[aria-controls=${JSON.stringify(value.id)}]`, 'expand original launch settings');
    await ui.waitRead(`Boolean(document.querySelector('[role="dialog"] #dialog-prompt'))`, 'original prompt field');
  };
  if (extensions) {
    assert.equal(model.observations.length, 0);
    await prepareDesktopNativeExtensionSkillsUi(cdp, {
      root: fixture.root, seed: options.seed, evidence, assertOwnedRenderer: options.assertOwnedRenderer,
    });
    cdp = await options.restartSameProfile!();
    ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step });
    proof.coldStartupBeforeFirstLaunch = true;
  }
  const globalMetadata = opencode
    ? await captureDesktopOpenCodeGlobalMetadata(cdp, fixture, options.capturedGroup(), options.assertOwnedRenderer) : undefined;
  if (globalMetadata) {
    proof.originalGlobalMetadata = globalMetadata;
    options.onHostObserved(globalMetadata.captured.host.pid);
  }
  await ui.observeInput();
  await ui.clickSidebar(options.seed.subject, undefined, originalActionReadTiming?.openTeam);
  await ui.click('button', 'open original Launch dialog', 'Launch', undefined, undefined, originalActionReadTiming?.openLaunch);
  await ui.waitRead(`Boolean(document.querySelector('[role="dialog"]'))`, 'original Launch dialog');
  // The Host seed hydrates asynchronously; its initial default summary is not ready for input.
  const hydratedSummary = await ui.waitRead(`(() => {
    const rows=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')]
      .filter(e=>e.textContent.includes('Optional launch settings'));
    if(rows.length!==1||rows[0].getAttribute('aria-expanded')!=='false')return null;
    const chips=[...rows[0].querySelectorAll('span')].map(e=>e.textContent.trim());
    return ${Boolean(opencode)} ? (chips.some(value=>value.includes('TEST-model')) ? {id:rows[0].getAttribute('aria-controls'),chips} : null) : chips.includes('low')&&(${Boolean(codex)}||chips.includes('Sonnet 4.6'))
      ? {id:rows[0].getAttribute('aria-controls'),chips,effort:'low'} : null;
  })()`, 'original saved launch summary hydrates before expansion');
  step({ observation: 'original saved launch summary before expansion', value: hydratedSummary });
  await expandSettings();
  await ui.waitRead(`(() => {
    const row=document.querySelector('[role="dialog"] button[aria-label*=" provider,"]');
    return ${Boolean(opencode)} ? /^OpenCode provider,/i.test(row?.getAttribute('aria-label')??'') : ${Boolean(codex)} ? /^Codex provider,/i.test(row?.getAttribute('aria-label')??'') : row?.textContent.trim()==='Sonnet 4.6';
  })()`, 'original saved lead settings hydrate before editing');
  // Opening the real lead model row is a normal user action, not form setup.
  if (!(await cdp.evaluate(`Boolean(document.querySelector('[role="dialog"] [data-testid="team-model-selector-model-option"]'))`))) {
    await ui.scrollTo('[role="dialog"] button[aria-label*=" provider,"]', 'visible original lead row');
    await ui.click('[role="dialog"] button[aria-label*=" provider,"]', 'expand original lead model row');
  }
  const modelOption = codex || opencode
    ? `[role="dialog"] [data-testid="team-model-selector-model-option"]:is([aria-label=${JSON.stringify(modelLabel)}],[aria-label^=${JSON.stringify(modelLabel + '. ')}])`
    : '[role="dialog"] [data-testid="team-model-selector-model-option"][aria-label^="Opus 4.6"]';
  await ui.scrollTo(modelOption, `visible ${modelLabel} option from actual provider catalog`);
  await ui.click(modelOption, `select ${modelLabel} in original model selector`);
  if (!opencode) {
    await ui.scrollTo('[role="dialog"] button', 'visible original Medium effort', 'Medium');
    await ui.click('[role="dialog"] button', 'choose original Medium effort', 'Medium');
    await ui.waitRead(`document.querySelector('[role="dialog"] #lead-effort')?.textContent.trim()==='Medium'`, 'selected medium effort');
  }
  await ui.scrollTo('[role="dialog"] #dialog-prompt', 'visible original launch prompt');
  await ui.click('[role="dialog"] #dialog-prompt', 'focus original launch prompt');
  await cdp.send('Input.insertText', { text: firstPrompt });
  await ui.waitRead(`document.querySelector('[role="dialog"] #dialog-prompt')?.value===${JSON.stringify(firstPrompt)}`, 'typed original prompt');
  if (opencode && await cdp.evaluate(`document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')`) !== 'checked')
    await ui.click('[role="dialog"] #dialog-skip-permissions', 'select original automatic tool permission mode');
  assert.equal(await cdp.evaluate(`document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')`), 'checked');
  // Do not click the optional preflight bypass: readiness must settle first.
  const launchUi = opencode ? await waitForDesktopOpenCodePreflight(cdp, {
    fixture: { ...fixture, openCodeV2: opencode }, prompt: firstPrompt, proof, ownerState,
    assertOwnedRenderer: options.assertOwnedRenderer, step,
  }) : ui;
  await launchUi.scrollTo('[role="dialog"] button', 'visible original Launch team control', 'Launch team');
  let metadataObservation: ReturnType<typeof readDesktopNativeHostProcesses> | undefined;
  if (opencode) {
    await launchUi.waitRead(`[...document.querySelectorAll('[role="dialog"] button')].some(e=>e.textContent.trim()==='Launch team'&&!e.disabled)`, 'original preflight completes before any runtime allocation');
    assert.ok(globalMetadata);
    const selected = await captureDesktopOpenCodeProjectMetadata(fixture, options.capturedGroup(), globalMetadata);
    metadataObservation = selected.captured; proof.metadataSources = selected.metadataSources;
    assert.equal(((await ownerState()).runtimeCaptures as unknown[] | undefined)?.length ?? 0, 0);
    proof.originalMetadataBeforeLaunch = metadataObservation;
  }
  await captureReadiness(
    cdp,
    fixture.handleId,
    proof,
    options.assertOwnedRenderer,
    'before-original-submit'
  );
  try {
    await launchUi.click('[role="dialog"] button', 'submit original Launch team once', 'Launch team');
    await ui.waitRead(`!document.querySelector('[role="dialog"] #dialog-prompt')`, 'original launch dialog closes', 60000);
  } catch (error) {
    await captureReadiness(
      cdp,
      fixture.handleId,
      proof,
      options.assertOwnedRenderer,
      'original-submit-failed'
    );
    throw error;
  }
  const state = await poll(ownerState, value => Array.isArray(value.runtimeCaptures) && value.runtimeCaptures.length === 1, 'one fresh Team capture');
  const captures = state.runtimeCaptures as unknown[];
  const capture = record(captures[0]);
  const capturedMembers = capture.members as unknown[];
  assert.equal(capturedMembers.length, 1);
  const capturedMember = record(capturedMembers[0]);
  assert.equal(capturedMember.memberId, 'alice-id');
  assert.notEqual(capturedMember.principalId, 'alice-session');
  const saved = record(state.savedSettings);
  assert.equal(saved.prompt, firstPrompt);
  assert.equal(saved.cwd, join(fixture.root, 'workspace'));
  assert.equal(saved.model, selectedModel);
  if (codex) assert.equal(saved.providerId, 'codex');
  if (opencode) assert.equal(saved.providerId, 'opencode');
  assert.equal(saved.effort, opencode ? undefined : 'medium');
  assert.equal(saved.fastMode, opencode ? undefined : 'off');
  assert.equal(saved.skipPermissions, true);
  if (!codex && !opencode) assert.equal(saved.limitContext, true);
  proof.savedSettings = saved;
  proof.capture = capture;
  const capturedSessions = async () => (await readDesktopNativeStopSessions(fixture.root))
    .filter(session => record(session.binding).runId === capture.launchId);
  await sourceSelection?.beforeTerminal(capture);
  const sessions = await poll(
    capturedSessions,
    rows => rows.length === 1 && Array.isArray(rows[0]!.inputs) &&
      (rows[0]!.inputs as unknown[]).length === 1 &&
      (rows[0]!.inputs as unknown[]).map(record).every(input => input.phase === 'terminal' && input.terminal === 'succeeded'),
    'one prompt reaches actual native terminal without duplicate input'
  );
  proof.nativeSessionBeforeStop = sessions[0];
  let firstSession = sessions[0]!;
  assert.equal(model.observations.length, 8);
  assert.ok(model.probes.length >= 1 && model.probes.length <= 8);
  assert.ok(model.observations.every(row => row.requestedModel === (opencode?.modelId ?? selectedModel) &&
    (opencode || 'requestedEffort' in row && row.requestedEffort === 'medium') && row.contextEffective));
  if (opencode) {
    const activity = record(await cdp.evaluate(`window.electronAPI.agentBackend.invoke(${JSON.stringify({
      handle: { handleId: fixture.handleId }, commandId: 'TEST-v2-launch-tool-result-read',
      operation: 'runtime.activity.snapshot', payload: { memberId: 'alice-id' },
    })})`));
    assert.equal(activity.ok, true);
    assert.ok((record(record(activity.value).latest).tools as unknown[]).map(record)
      .some(row => record(row.data).kind === 'tool-result' && record(row.data).isError === true));
    proof.failedNativeShellObserved = true;
  } else assert.ok(model.observations.some(row => 'toolResultError' in row && row.toolResultError), 'actual Bash exit7 observed');
  assert.equal(await readFile(join(fixture.root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\n');
  const tasksDirectory = join(fixture.root, 'hoststore/tasks/test-desktop-backend');
  const tasks = await Promise.all((await readdir(tasksDirectory)).filter(name => /^[A-Za-z0-9_-]+\.json$/.test(name))
    .map(async name => record(await json(join(tasksDirectory, name)))));
  assert.equal(tasks.length, 2);
  const nativeTask = tasks.find(task => task.createdBy === 'alice');
  assert.ok(nativeTask);
  assert.equal(nativeTask.status, 'completed');
  assert.equal(nativeTask.owner, 'alice');
  proof.nativeTask = nativeTask;
  await ui.click('button[aria-label^="alice,"]', 'open original alice chat');
  await ui.waitRead(`document.body.innerText.includes(${JSON.stringify(firstReply)})`, 'native reply visible in original thread');
  const screenshot = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
  assert.ok(typeof screenshot.data === 'string');
  const screenshotPath = join(fixture.root, 'ui-original-launch-native.png');
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
  proof.screenshot = { path: screenshotPath, sha256: await fileDigest(screenshotPath) };
  if (process.env.LEGACY_DESKTOP_COMMANDS_UI === '1') {
    assert.ok(options.model && !codex && !opencode && options.model.commandRequests);
    await runDesktopNativeCommandsUiProof(cdp, {
      root: fixture.root, seed: options.seed, session: sessions[0]!,
      model: { ...options.model, commandRequests: options.model.commandRequests },
      evidence, assertOwnedRenderer: options.assertOwnedRenderer,
    });
  }
  if (extensions) {
    assert.ok(options.model?.extensionRequests);
    firstSession = await runDesktopNativeExtensionCommandsUi(cdp, {
      root: fixture.root, session: firstSession,
      model: { ...options.model, extensionRequests: options.model.extensionRequests },
      evidence, assertOwnedRenderer: options.assertOwnedRenderer,
    });
    proof.nativeSessionAfterExtensionCommands = firstSession;
  }
  if (codex) await runDesktopCodexCostUiProof(cdp, {
    root: fixture.root, handleId: fixture.handleId, session: sessions[0]!, model, evidence,
    assertOwnedRenderer: options.assertOwnedRenderer,
  });
  const hostRows = processTable().filter(row => row.pgid === options.capturedGroup() && command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
  assert.equal(hostRows.length, 1, 'only this TEST Host executable may be selected');
  const hostPid = hostRows[0]!.pid;
  options.onHostObserved(hostPid);
  const nativeObservation = metadataObservation
    ? await observeDesktopOpenCodeMetadata(fixture, options.capturedGroup(), metadataObservation, 1) : undefined;
  if (nativeObservation) {
    metadataObservation = nativeObservation.captured; proof.metadataAtRuntimeObservation = metadataObservation;
  }
  const children = nativeObservation?.runtime ?? processTable().filter(row => row.ppid === hostPid);
  assert.ok(children.length >= 1, 'actual native child present before Stop');
  if (codex) proof.codeModeHost = { status: 'capture-attempted' };
  const helper = codex ? await captureCodexCodeModeProcess(hostPid, codex.nativeInputs) : undefined;
  if (helper) proof.codeModeHost = helper;
  if (codex) proof.runtimeMcpEndpointSha256 = await codexRuntimeEndpointHash(fixture, options.capturedGroup());
  await ui.scrollTo('button[aria-label="Stop"]', 'visible original Stop control');
  await ui.click('button[aria-label="Stop"]', 'original Stop once', 'Stop');
  const stoppedSessions = await poll(async () => { const rows = await capturedSessions(); if (helper) observeCodexCodeModeProcess(helper); return rows; }, rows => rows.length === 1 && rows[0]!.phase === 'closed' && rows[0]!.custody === 'released', 'native cleanup released');
  await poll(async () => {
    const rows = processTable(), observed = helper && observeCodexCodeModeProcess(helper);
    return { rows, helperAbsent: !observed || observed.state === 'absent' };
  }, value => value.helperAbsent && children.every(child => !value.rows.some(row => row.pid === child.pid)), 'captured native children and original helper physically absent');
  if (metadataObservation) {
    const remaining = (await observeDesktopOpenCodeMetadata(fixture, options.capturedGroup(), metadataObservation, 0)).captured;
    separateDesktopOpenCodeRuntimeChildren(metadataObservation, remaining, 0);
    metadataObservation = remaining;
    proof.metadataAfterStop = remaining;
  }
  proof.stop = { nativeChildren: children, releasedBeforeQuit: true };
  if (sourceSelection) {
    assert.ok(helper);
    await sourceSelection.afterStop({ capture, session: stoppedSessions[0]!, saved, nativeTask, helper });
    proof.probes = model.probes; proof.status = 'PASS'; return;
  }
  if (extensions) await runDesktopNativeExtensionsUiSmoke(cdp, {
    root: fixture.root, evidence, assertOwnedRenderer: options.assertOwnedRenderer, pluginPhase: 'uninstall',
  });
  if (options.restartSameProfile && !extensions) {
    assert.equal(evidence.mode, 'native-resume-ui', 'cold boundary belongs only to explicit Resume proof');
    cdp = await options.restartSameProfile();
    fixture = options.currentFixture?.() ?? fixture;
    ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step });
    await ui.waitRead(`Boolean(window.electronAPI)&&!document.getElementById('splash')`, 'cold same-profile real renderer');
  } else {
    const beforeReload = await cdp.evaluate('performance.timeOrigin');
    await cdp.send('Page.reload', { ignoreCache: false });
    await ui.waitRead(`performance.timeOrigin!==${JSON.stringify(beforeReload)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`, 'reloaded real renderer');
  }
  const resumeGlobalMetadata = opencode && options.restartSameProfile && !extensions && evidence.mode === 'native-resume-ui'
    ? await captureDesktopOpenCodeGlobalMetadata(cdp, fixture, options.capturedGroup(), options.assertOwnedRenderer) : undefined;
  if (resumeGlobalMetadata) options.onHostObserved(resumeGlobalMetadata.captured.host.pid);
  if (opencode && !resumeGlobalMetadata) {
    assert.ok(metadataObservation, 'renderer reload retains the original metadata owners');
    const retained = (await observeDesktopOpenCodeMetadata(fixture, options.capturedGroup(), metadataObservation, 0)).captured;
    separateDesktopOpenCodeRuntimeChildren(metadataObservation, retained, 0);
    metadataObservation = retained;
    proof.metadataAfterRendererReload = retained;
  }
  await ui.observeInput();
  if (!(await cdp.evaluate(`Boolean(document.querySelector('.kanban-task-card'))`)))
    await ui.clickSidebar(options.seed.subject);
  await ui.scrollTo('button', 'visible original Launch after reload', 'Launch');
  await ui.click('button', 'reopen original Launch after reload', 'Launch');
  await expandSettings();
  await ui.waitRead(`document.querySelector('[role="dialog"] #dialog-prompt')?.value===${JSON.stringify(firstPrompt)}`, 'same saved prompt after reload');
  assert.equal(await cdp.evaluate(`document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')`), 'checked');
  assert.deepEqual(record((await ownerState()).savedSettings), saved, 'opening/reloading does not rewrite saved settings');
  assert.equal(model.observations.length, 8, 'opening the original dialog cannot dispatch another agent input');
  assert.deepEqual(model.failures, []);
  proof.status = 'PASS';
  proof.probes = model.probes;
  if (options.restartSameProfile && !extensions) proof.settingsRetainedAfterColdStartup = true;
  else proof.settingsRetainedAfterReload = true;
  if (evidence.mode === 'native-resume-ui')
    await runDesktopResumeUiSmoke(cdp, { ...options, fixture, model, firstCapture: capture, savedSettings: saved, nativeTask: nativeTask!, firstSession: sessions[0]!,
      ...(resumeGlobalMetadata ? { metadataGlobal: resumeGlobalMetadata } : {}) });
  if (evidence.mode === 'native-relaunch-ui' || extensions) {
    assert.ok(options.model && !codex);
    await runDesktopRelaunchUiSmoke(cdp, { ...options, model: options.model, firstCapture: capture, savedSettings: saved, nativeTask: nativeTask!, firstSession });
  }
}
