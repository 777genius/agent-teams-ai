import { join } from 'node:path';
import { z } from 'zod';

import { ClaudeAuthConversation } from '../adapters/providers/ClaudeAuthConversation.js';
import { assertManagementTarget, ManagementCommandError } from '../management/commandRecords.js';

import type { ManagementTarget } from '../management/commandRecords.js';
import type { OAuthNativeConversation } from '../management/OAuthOperationOwner.js';
import type { ClaudeManagementProfile } from '../management/profile.js';

const identity = z
  .object({ profileId: z.string().min(1).max(256), configRevision: z.string().min(1).max(256) })
  .strict();
const configDirectory = (profile: ClaudeManagementProfile) =>
  profile.environment.CLAUDE_CONFIG_DIR ?? join(profile.environment.HOME!, '.claude');
const anthropicDirectory = (profile: ClaudeManagementProfile) =>
  profile.environment.ANTHROPIC_CONFIG_DIR?.trim() ||
  join(
    profile.environment.XDG_CONFIG_HOME?.trim() || join(profile.environment.HOME!, '.config'),
    'anthropic'
  );

/** Finite official auth commands, sharing the existing OAuth/credential journal and namespace fence. */
export class ClaudeAuthenticationCoordinator {
  private readonly profiles: Map<string, ClaudeManagementProfile>;
  private readonly active = new Map<ClaudeAuthConversation, string>();
  private readonly held = new Set<string>();
  private sealed = false;

  constructor(
    profiles: ClaudeManagementProfile[],
    private readonly selectTarget: (profileId: string, configRevision: string) => ManagementTarget,
    private readonly assertWriter: () => void
  ) {
    this.profiles = new Map(
      structuredClone(profiles).map((profile) => [profile.profileId, profile])
    );
  }

  private select(profileId: string, configRevision: string): ClaudeManagementProfile {
    this.assertWriter();
    const profile = this.profiles.get(profileId);
    if (this.sealed || !profile || profile.configRevision !== configRevision)
      throw new ManagementCommandError('invalid');
    return profile;
  }

  private assertNamespace(profile: ClaudeManagementProfile): void {
    // Native auth also touches the selected Anthropic profile store. Different Claude
    // config directories may not silently share that writable account namespace.
    for (const other of this.profiles.values()) {
      if (
        anthropicDirectory(other) === anthropicDirectory(profile) &&
        configDirectory(other) !== configDirectory(profile)
      )
        throw new ManagementCommandError('held');
    }
  }

  private create(profile: ClaudeManagementProfile): ClaudeAuthConversation {
    const target = this.selectTarget(profile.profileId, profile.configRevision);
    const key = target.resourceId;
    if (this.held.has(key)) throw new ManagementCommandError('held');
    const conversation = new ClaudeAuthConversation(profile, () => {
      try {
        this.select(profile.profileId, profile.configRevision);
        assertManagementTarget(
          target,
          this.selectTarget(profile.profileId, profile.configRevision)
        );
        return !this.held.has(key);
      } catch {
        return false;
      }
    });
    this.active.set(conversation, key);
    return conversation;
  }

  private async closeConversation(conversation: ClaudeAuthConversation): Promise<boolean> {
    const key = this.active.get(conversation);
    const settled = await conversation.close().catch(() => false);
    if (!settled && key) this.held.add(key);
    if (settled) this.active.delete(conversation);
    return settled;
  }

  prepare(input: {
    profileId: string;
    configRevision: string;
    providerId: string;
    methodIndex: number;
  }): OAuthNativeConversation {
    const profile = this.select(input.profileId, input.configRevision);
    if (input.providerId !== 'anthropic' || input.methodIndex !== 0)
      throw new ManagementCommandError('invalid');
    this.assertNamespace(profile);
    const conversation = this.create(profile);
    return {
      timeoutMs: conversation.timeoutMs,
      nativeCompletion: conversation.nativeCompletion,
      authorize: (fields, signal) => conversation.authorize(fields, signal),
      complete: async (code, signal) => {
        const ok = await conversation.complete(code, signal);
        return ok && (await this.closeConversation(conversation));
      },
      close: () => this.closeConversation(conversation),
    };
  }

  async read(raw: unknown) {
    const input = identity.parse(raw);
    const profile = this.select(input.profileId, input.configRevision);
    const conversation = this.create(profile);
    try {
      const account = await conversation.read(AbortSignal.timeout(profile.timeoutMs));
      this.select(profile.profileId, profile.configRevision);
      let namespaceAvailable = true;
      try {
        this.assertNamespace(profile);
      } catch {
        namespaceAvailable = false;
      }
      const environmentManaged = Object.keys(profile.environment).some((key) =>
        /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|PROFILE)|CLAUDE_CODE_(?:OAUTH|USE_))/u.test(
          key
        )
      );
      const supported =
        namespaceAvailable &&
        !environmentManaged &&
        (!account.forcedLoginMethod || account.forcedLoginMethod === 'claudeai') &&
        (account.authMethod === 'none' || account.authMethod === 'claude.ai');
      const result = {
        profileId: profile.profileId,
        configRevision: profile.configRevision,
        loggedIn: account.loggedIn,
        authMethod: account.authMethod,
        canLogin: supported,
        canLogout: supported,
      };
      if (!(await this.closeConversation(conversation))) throw new ManagementCommandError('held');
      return result;
    } catch (error) {
      if (!(await this.closeConversation(conversation))) throw new ManagementCommandError('held');
      throw error;
    }
  }

  async forget(
    input: { profileId: string; configRevision: string; providerId: string },
    target: ManagementTarget
  ) {
    const profile = this.select(input.profileId, input.configRevision);
    if (input.providerId !== 'anthropic') throw new ManagementCommandError('invalid');
    this.assertNamespace(profile);
    assertManagementTarget(target, this.selectTarget(input.profileId, input.configRevision));
    const conversation = this.create(profile);
    let ok = false;
    try {
      ok = await conversation.forget(AbortSignal.timeout(profile.timeoutMs));
    } catch {
      /* Original durable command remains unconfirmed; never allocate a replacement. */
    }
    const settled = await this.closeConversation(conversation);
    return { ok, settled };
  }

  seal(): void {
    this.sealed = true;
    for (const conversation of this.active.keys()) void this.closeConversation(conversation);
  }

  async close(): Promise<void> {
    this.seal();
    const results = await Promise.allSettled(
      [...this.active.keys()].map((conversation) => this.closeConversation(conversation))
    );
    if (results.some((row) => row.status !== 'fulfilled' || !row.value) || this.held.size)
      throw new ManagementCommandError('held');
  }
}
