import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { TeamLaunchOwner } from '../dist/team-launch/TeamLaunchOwner.js';
import { captureNativeInputAuthority } from '../dist/composition/captureNativeInputAuthority.js';
import { executeNativeMemberAction } from '../dist/composition/executeNativeMemberAction.js';
import { captureMemberProviderAuthority } from '../dist/composition/captureMemberProviderAuthority.js';
import { runtimeDigest as digest } from '../dist/runtime/identity.js';
import type { RuntimeMemberProfile } from '../dist/composition/runtimeProfile.js';
import type { HostedTeam, MemberEntry } from '../dist/composition/MemberEntry.js';
import type { Session, Event, Input } from '@agent-teams/provider-session-contracts';

export class Driver implements Session {
  closed = 0;
  confirmed = true;
  closeWait: Promise<void> | undefined;
  sessionRef: string;
  private done = false;
  private waiting: ((r: IteratorResult<Event>) => void) | undefined;
  private readonly canSubmit: () => boolean;
  constructor(id: string, canSubmit: () => boolean = () => true) {
    this.canSubmit = canSubmit;
    this.sessionRef = `TEST-session-${id}`;
  }
  observe = (): AsyncIterable<Event> => ({
    [Symbol.asyncIterator]: () => ({
      next: () =>
        this.done
          ? Promise.resolve({ done: true, value: undefined })
          : new Promise((done) => {
              this.waiting = done;
            }),
    }),
  });
  submit: Session['submit'] = async (input: Input) => {
    assert.equal(
      this.canSubmit(),
      true,
      'Immutable target lifetime must permit its own current input'
    );
    return {
      ok: true,
      value: {
        inputId: input.inputId,
        operationRef: input.operationRef,
        delivery: 'client-consumed',
        providerAcceptance: 'unknown',
      },
    };
  };
  interrupt: Session['interrupt'] = async () => ({ ok: false, code: 'unsupported' });
  respondToInteraction: Session['respondToInteraction'] = async () => ({
    ok: false,
    code: 'unsupported',
  });
  checkpoint: Session['checkpoint'] = () => ({ ok: false, code: 'unsupported' });
  checkReadiness: Session['checkReadiness'] = async () => ({ ok: true, value: undefined });
  close: Session['close'] = async () => {
    this.closed++;
    await this.closeWait;
    this.done = true;
    this.waiting?.({ done: true, value: undefined });
    return { logicallyClosed: true, cleanup: this.confirmed ? 'confirmed' : 'unknown' };
  };
}
export async function fixture(t: TestContext, openTarget = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-native-member-actions-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = {
    backendId: 'TEST-backend',
    teamId: 'TEST-team',
    teamName: 'test-native-member-actions',
  };
  const members = ['L', 'A', 'B'].map((memberId) => ({
    memberId,
    name: memberId === 'L' ? 'leader' : memberId === 'A' ? 'alice' : 'bob',
    role: memberId === 'L' ? ('lead' as const) : ('member' as const),
    delivery: { ...binding, runId: 'TEST-run', memberId, generation: 'original-1' },
  }));
  const grants = [
    {
      principalId: 'profile-admin',
      memberName: 'user',
      permissions: ['read', 'task.write', 'message.write', 'admin'] as (
        | 'read'
        | 'task.write'
        | 'message.write'
        | 'admin'
      )[],
    },
    {
      principalId: 'human',
      memberName: 'user',
      permissions: ['read', 'task.write', 'message.write', 'admin'] as (
        | 'read'
        | 'task.write'
        | 'message.write'
        | 'admin'
      )[],
    },
    {
      principalId: 'TEST-other-A-grant',
      memberName: 'alice',
      permissions: ['read', 'task.write'] as ('read' | 'task.write')[],
    },
    ...members.map((m) => ({
      principalId: `native-${m.memberId}`,
      memberName: m.name,
      permissions: ['read', 'task.write', 'message.write', 'process.write'] as (
        | 'read'
        | 'task.write'
        | 'message.write'
        | 'process.write'
      )[],
    })),
  ];
  const owner = createFilesystemTeamOwner({ root, binding, members, grants });
  const human = owner.connect('human');
  const team: HostedTeam = {
    definition: {
      binding,
      members: structuredClone(members),
      grants,
      scope: {
        projectId: 'TEST-project',
        workspaceId: 'TEST-workspace',
        teamId: binding.teamId,
        runId: 'TEST-run',
        memberId: 'TEST-host',
        generation: '1',
      },
    },
    owner,
    connection: owner.connect('profile-admin'),
  };
  const entries = new Map<string, MemberEntry>();
  for (const member of members) {
    const profile: RuntimeMemberProfile = {
      provider: 'claude',
      teamId: binding.teamId,
      memberId: member.memberId,
      principalId: `native-${member.memberId}`,
      sessionId: member.memberId,
      generation: 1,
      configRevision: 'TEST-config',
      model: 'TEST-model',
      accountBinding: `TEST-${member.memberId}`,
      cwd: root,
      environment: { HOME: root },
      executable: { path: join(root, 'TEST-never-executed'), sha256: 'a'.repeat(64) },
      nativeTools: [],
      autoAllowedTools: [],
      limits: {
        queuedInputs: 4,
        inputBytes: 65536,
        outputBytes: 65536,
        outputEvents: 100,
        pendingInteractions: 4,
        timeoutMs: 10000,
      },
    };
    const { teamName: _teamName, ...runtimeBinding } = member.delivery;
    entries.set(digest(runtimeBinding), {
      team,
      profile,
      baseProfile: structuredClone(profile),
      binding: runtimeBinding,
      delivery: member.delivery,
      config: {
        tenantId: binding.backendId,
        projectId: 'TEST-project',
        sessionId: member.memberId,
        generation: 1,
        configRevision: 'TEST-config',
        requiredCapabilities: ['tools'],
      },
    });
  }
  const drivers = new Map<string, Driver>(),
    opened: string[] = [];
  let beforeOpen: ((entry: MemberEntry) => Promise<void>) | undefined;
  const runtimeStore = new FileRuntimeStore(root);
  const providerAuthorities = new Map<string, ReturnType<typeof captureMemberProviderAuthority>>();
  const runtime = new RuntimeOwner({
    store: runtimeStore,
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-host',
    authorize: (b, a, intent) =>
      intent ? owner.authorizeDeliveryIntent(intent, a) : owner.authorizeMemberBinding(b, a),
    canDispatch: () => true,
    driverFactory: {
      async open(config, authority) {
        const entry = [...entries.values()].find(
          (e) =>
            e.config.sessionId === config.sessionId && e.config.generation === config.generation
        )!;
        const targetAuthority = captureMemberProviderAuthority({
          entry,
          request: config,
          profileId: 'TEST-profile',
          hostIncarnation: 'TEST-host',
          ...(authority ? { assertAllocation: authority } : {}),
          assertCurrent() {},
          readRuntime: () => runtime.readCapturedSession(entry.binding),
        });
        // Initial controlled setup is trusted; successor uses the actual production guard.
        if (authority) assert.equal(targetAuthority.canAllocate(), true);
        providerAuthorities.set(`${config.sessionId}:${config.generation}`, targetAuthority);
        await beforeOpen?.(entry);
        if (authority) assert.equal(targetAuthority.canAllocate(), true);
        const driver = new Driver(
          `${config.sessionId}-${config.generation}`,
          targetAuthority.canAllocate
        );
        drivers.set(`${config.sessionId}:${config.generation}`, driver);
        opened.push(`${config.sessionId}:${config.generation}`);
        return { driver, capabilities: ['tools'] };
      },
    },
  });
  for (const entry of entries.values())
    if (openTarget || entry.binding.memberId !== 'A')
      await runtime.openSession({ binding: entry.binding, config: entry.config });
  const store = new TeamOwnerStore(root, binding.teamName);
  const launch = new TeamLaunchOwner({
    definition: {
      launchId: 'TEST-run',
      rosterRevision: 'TEST-roster',
      members: [...entries.values()].map((e) => ({
        memberId: e.binding.memberId,
        binding: e.binding,
        runtimeGeneration: 1,
        configurationDigest: digest(e.profile),
        baseConfigurationDigest: digest(e.baseProfile),
        contextDigest: digest({ member: e.binding.memberId }),
        configRevision: e.config.configRevision,
        skipped: false,
        timeoutMs: 10000,
      })),
    },
    store,
    hostIncarnation: 'TEST-host',
    authorized: (action, fn) => owner.withLaunchAuthority('profile-admin', action, fn),
    captureActor: () => ({ principalId: 'profile-admin', authorityRevision: 1 }),
    runtime: {
      captureAuthority: () => () => {},
      read(memberId) {
        const e = [...entries.values()].find((e) => e.binding.memberId === memberId)!;
        const s = runtime.readSession(e.binding);
        return {
          ...(s.record ? { record: s.record } : {}),
          attached: s.attached,
          nativeReady: false,
        };
      },
      async open(memberId, authority) {
        const e = [...entries.values()].find((e) => e.binding.memberId === memberId)!;
        const sourceBinding = launch.readFreshMemberSource(e.binding);
        if (sourceBinding)
          await runtime.openFreshMemberSession(
            { sourceBinding, binding: e.binding, config: e.config },
            authority!
          );
        else await runtime.openSession({ binding: e.binding, config: e.config }, authority);
      },
    },
  });
  const lead = [...entries.values()].find((e) => e.binding.memberId === 'L')!;
  for (const actionMode of ['do', 'ask'] as const)
    human.execute({
      commandId: `TEST-${actionMode}`,
      operation: 'message.send',
      payload: { to: 'leader', text: `TEST ${actionMode}`, actionMode },
    });
  const input = (mode: string) => {
    const raw = human.pendingDeliveries().find((r) => r.commandId === `TEST-${mode}`);
    assert.ok(raw);
    return raw;
  };
  await runtime.admitDelivery(input('do'));
  await runtime.dispatchNext(lead.binding);
  const source = captureNativeInputAuthority({
    binding: lead.binding,
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-host',
    config: lead.config,
    readRuntime: () => runtime.readSession(lead.binding),
    captureTeam: (raw) => owner.captureNativeMcpAuthority('native-L', lead.binding, raw, true),
    assertCurrent() {},
  });
  const options = {
    team,
    launch,
    entries,
    runtime,
    source,
    assertCurrent() {},
    isSealed: () => false,
  };
  const call = (
    op: Parameters<typeof executeNativeMemberAction>[1],
    commandId: string,
    raw: unknown
  ) => executeNativeMemberAction(options, op, commandId, raw);
  const request = (commandId: string, action: 'restart' | 'skip' = 'restart') => {
    const view = launch.memberActions().source('A');
    return {
      commandId,
      body: {
        launchId: 'TEST-run',
        rosterRevision: launch.read().rosterRevision,
        memberId: 'A',
        expectedGeneration: view.binding!.generation,
        action,
      },
    };
  };
  return {
    root,
    owner,
    human,
    team,
    entries,
    runtime,
    runtimeStore,
    providerAuthorities,
    setBeforeOpen(callback: (entry: MemberEntry) => Promise<void>) {
      beforeOpen = callback;
    },
    store,
    launch,
    drivers,
    opened,
    source,
    lead,
    call,
    request,
    input,
    async nextAsk() {
      runtimeStore.fenced(lead.binding, (tx) => {
        const r = tx.get()!;
        r.inputs[0]!.phase = 'terminal';
        r.inputs[0]!.terminal = 'succeeded';
        tx.put(r);
      });
      await runtime.admitDelivery(input('ask'));
      await runtime.dispatchNext(lead.binding);
    },
  };
}
