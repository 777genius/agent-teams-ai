import { z } from 'zod';

import { captureNativeExtensionTarget } from './captureNativeExtensionTarget.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import { ExtensionMutationOwner } from './ExtensionMutationOwner.js';
import { NativeExtensionProcess } from './NativeExtensionProcess.js';
import { readNativeMcp, readNativePlugins } from './readNativeExtensionState.js';
import { qualifyNativeMcpDiagnostics } from './qualifyNativeMcpDiagnostics.js';

import type { ExtensionRootSelection } from '../management/captureExtensionRoots.js';
import type { ManagementCommandStore, ManagementTarget } from '../management/commandRecords.js';
import type { ManagementResourceFence } from '../management/ManagementResourceFence.js';
import type { ClaudeManagementProfile } from '../management/profile.js';

const identity = {
  profileId: z.string().min(1).max(256),
  configRevision: z.string().min(1).max(256),
};
const captureSchema = z
  .object({
    ...identity,
    panel: z.enum(['plugins', 'mcp']),
    scope: z.enum(['user', 'global', 'project', 'local']),
  })
  .strict()
  .refine((input) => input.panel === 'mcp' || input.scope !== 'global');
type Process = Pick<NativeExtensionProcess, 'run' | 'close'> &
  Partial<Pick<NativeExtensionProcess, 'diagnose'>>;

/** Private profile/root selection for finite native extension commands; no ambient provider or context. */
export class NativeExtensionCoordinator {
  private readonly profiles: Map<string, ClaudeManagementProfile>;
  private readonly active = new Set<Process>();
  private readonly held = new Set<Process>();
  private sealed = false;
  readonly mutations: ExtensionMutationOwner;

  constructor(
    profiles: readonly ClaudeManagementProfile[],
    private readonly options: {
      readonly store: ManagementCommandStore;
      readonly fence: ManagementResourceFence;
      assertCurrent(): void;
      managementTarget(profileId: string, configRevision: string): ManagementTarget;
      createProcess?(
        profile: ClaudeManagementProfile,
        selection: ExtensionRootSelection,
        assertOriginal: () => void
      ): Process;
    }
  ) {
    if (new Set(profiles.map((profile) => profile.profileId)).size !== profiles.length)
      throw new ManagementCommandError('invalid');
    this.profiles = new Map(
      structuredClone(profiles).map((profile) => [profile.profileId, profile])
    );
    this.mutations = new ExtensionMutationOwner({
      store: options.store,
      fence: options.fence,
      assertCurrent: () => this.assertCurrent(),
      select: (input) => this.resolve(input).target,
      perform: async (command, targetId, assertOriginal, original) => {
        const selected = this.resolve(original);
        const current = () => {
          this.assertCurrent();
          assertOriginal();
          selected.roots.assertCurrent();
        };
        current();
        const process = options.createProcess
          ? options.createProcess(selected.profile, selected.selection, current)
          : new NativeExtensionProcess(selected.profile, selected.selection, current);
        this.active.add(process);
        let result;
        try {
          result = await process.run(targetId, command);
        } catch (error) {
          await this.closeProcess(process);
          throw error;
        }
        const closed = await this.closeProcess(process);
        return {
          ok: result.ok && closed,
          settled: result.settled && closed,
          ...(result.completed && closed ? { completed: true } : {}),
        };
      },
    });
  }

  private assertCurrent(): void {
    if (this.sealed) throw new ManagementCommandError('held');
    this.options.assertCurrent();
  }

  private profile(profileId: string, configRevision: string): ClaudeManagementProfile {
    this.assertCurrent();
    const profile = this.profiles.get(profileId);
    if (!profile || profile.configRevision !== configRevision)
      throw new ManagementCommandError('conflict');
    this.options.managementTarget(profileId, configRevision);
    return profile;
  }

  capture(raw: unknown) {
    const input = captureSchema.parse(raw),
      profile = this.profile(input.profileId, input.configRevision);
    const roots = captureNativeExtensionTarget(
      profile,
      { panel: input.panel, scope: input.scope },
      () => {
        this.profile(input.profileId, input.configRevision);
      }
    );
    return {
      profileId: input.profileId,
      configRevision: input.configRevision,
      targetId: roots.targetId,
      panel: input.panel,
      scope: input.scope,
    };
  }

  read(raw: unknown) {
    const input = z
      .object({
        ...identity,
        panel: z.enum(['plugins', 'mcp']),
        scope: z.enum(['user', 'global', 'project', 'local']),
        targetId: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .parse(raw);
    const selected = this.resolve(input);
    const current = () => {
      this.assertCurrent();
      selected.roots.assertCurrent();
    };
    const project = input.scope === 'project' || input.scope === 'local';
    const state =
      input.panel === 'plugins'
        ? readNativePlugins(selected.profile, project, current)
        : { entries: readNativeMcp(selected.profile, project, current) };
    current();
    return {
      profileId: input.profileId,
      configRevision: input.configRevision,
      targetId: input.targetId,
      panel: input.panel,
      scope: input.scope,
      ...state,
    };
  }

  async diagnose(raw: unknown) {
    const input = z
      .object({
        ...identity,
        panel: z.literal('mcp'),
        scope: z.enum(['user', 'global', 'project', 'local']),
        targetId: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .parse(raw);
    const selected = this.resolve(input);
    const current = () => {
      this.assertCurrent();
      selected.roots.assertCurrent();
    };
    const installed = readNativeMcp(
      selected.profile,
      input.scope === 'project' || input.scope === 'local',
      current
    );
    const process = this.options.createProcess
      ? this.options.createProcess(selected.profile, selected.selection, current)
      : new NativeExtensionProcess(selected.profile, selected.selection, current);
    this.active.add(process);
    try {
      if (!process.diagnose) throw new ManagementCommandError('held');
      const result = await process.diagnose(input.targetId);
      if (
        !(await this.closeProcess(process)) ||
        !result.ok ||
        !result.settled ||
        result.output === undefined
      )
        throw new ManagementCommandError('held');
      current();
      return { ...input, entries: qualifyNativeMcpDiagnostics(result.output, installed) };
    } catch (error) {
      await this.closeProcess(process);
      throw error;
    }
  }

  private resolve(input: {
    profileId: string;
    configRevision: string;
    targetId: string;
    panel: 'plugins' | 'mcp';
    scope: ExtensionRootSelection['scope'];
  }) {
    const profile = this.profile(input.profileId, input.configRevision);
    const selection = { panel: input.panel, scope: input.scope };
    const roots = captureNativeExtensionTarget(profile, selection, () => {
      this.profile(profile.profileId, profile.configRevision);
    });
    if (roots.targetId !== input.targetId) throw new ManagementCommandError('conflict');
    return {
      profile,
      selection,
      roots,
      target: this.options.managementTarget(profile.profileId, profile.configRevision),
    };
  }

  private async closeProcess(process: Process): Promise<boolean> {
    const settled = await process.close().catch(() => false);
    if (settled) {
      this.active.delete(process);
      this.held.delete(process);
    } else this.held.add(process);
    return settled;
  }

  seal(): void {
    this.sealed = true;
    for (const process of this.active) void this.closeProcess(process);
  }
  async close(): Promise<void> {
    this.seal();
    const results = await Promise.allSettled(
      [...this.active].map((process) => this.closeProcess(process))
    );
    if (results.some((result) => result.status !== 'fulfilled' || !result.value) || this.held.size)
      throw new ManagementCommandError('held');
  }
}
