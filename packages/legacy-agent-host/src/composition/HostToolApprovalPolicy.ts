import { shouldAutoAllow } from '../approval/policy.js';
import {
  DEFAULT_TOOL_APPROVAL_SETTINGS,
  toolApprovalSettingsSchema,
} from '../approval/settings.js';
import { runtimeDigest } from '../runtime/identity.js';
import { readCapturedRuntimeInteractions } from './CapturedRuntimeInteraction.js';
import type { ToolApprovalSettings } from '../approval/policy.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';

/** Current preferences only. Existing renderer desired-state persistence rehydrates after restart. */
export class HostToolApprovalPolicy {
  private readonly policies = new Map<
    string,
    { revision: number; settings: ToolApprovalSettings }
  >();
  private readonly deadlines = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly options: {
      principalId: string;
      runtime: Pick<RuntimeOwner, 'readSession' | 'readActivitySnapshot' | 'respondToInteraction'>;
      assertCurrent(entry: MemberEntry): void;
      kick(): void;
      now?: () => number;
    }
  ) {}

  settings(team: HostedTeam, raw?: unknown): ToolApprovalSettings {
    return team.owner.withLaunchAuthority(
      this.options.principalId,
      raw === undefined ? 'read' : 'control',
      (revision) => {
        if (raw !== undefined)
          this.policies.set(team.definition.binding.teamId, {
            revision,
            settings: toolApprovalSettingsSchema.parse(raw),
          });
        const policy = this.policies.get(team.definition.binding.teamId);
        return structuredClone(
          policy?.revision === revision ? policy.settings : DEFAULT_TOOL_APPROVAL_SETTINGS
        );
      }
    );
  }

  async pump(entries: Iterable<MemberEntry>): Promise<void> {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const retained = new Set<string>();
    const now = this.options.now?.() ?? Date.now();
    for (const entry of entries) {
      if (this.disposed) break;
      try {
        const policy = this.settings(entry.team);
        const authorityRevision = entry.team.owner.withLaunchAuthority(this.options.principalId, 'control', revision => revision);
        const assertCurrent = () => {
          if (this.disposed) throw new Error('Approval policy sealed');
          this.options.assertCurrent(entry);
          entry.team.owner.withLaunchAuthority(this.options.principalId, 'control', revision => {
            if (revision !== authorityRevision) throw new Error('Approval authority changed');
          });
          if (runtimeDigest(this.settings(entry.team)) !== runtimeDigest(policy))
            throw new Error('Approval policy changed');
        };
        const pending = readCapturedRuntimeInteractions(
          this.options.runtime,
          entry,
          assertCurrent,
          now
        );
        for (const { fact, request } of pending) {
          const key = runtimeDigest({
            binding: entry.binding,
            inputId: fact.inputId,
            reference: fact.interactionRef,
          });
          retained.add(key);
          if (
            policy.timeoutAction === 'wait' ||
            (request.kind === 'question' && policy.timeoutAction !== 'deny')
          )
            this.deadlines.delete(key);
          else if (!this.deadlines.has(key))
            this.deadlines.set(key, now + policy.timeoutSeconds * 1000);
          let decision: 'allow' | 'deny' | undefined;
          if (request.kind === 'permission') {
            const input =
              request.input && typeof request.input === 'object' && !Array.isArray(request.input)
                ? (request.input as Record<string, unknown>)
                : {};
            if (shouldAutoAllow(policy, request.tool, input).autoAllow) decision = 'allow';
            else if (
              (this.deadlines.get(key) ?? Infinity) <= now &&
              policy.timeoutAction !== 'wait'
            )
              decision = policy.timeoutAction;
          } else if (
            policy.timeoutAction === 'deny' &&
            (this.deadlines.get(key) ?? Infinity) <= now
          ) {
            decision = 'deny'; // Questions cannot fabricate an answer for an automatic Allow.
          }
          if (!decision) continue;
          assertCurrent();
          this.deadlines.delete(key);
          retained.delete(key);
          await this.options.runtime.respondToInteraction(
            entry.binding,
            fact.inputId,
            fact.interactionRef,
            request.kind === 'permission'
              ? { kind: 'permission', decision }
              : { kind: 'question', decision: 'deny' },
            assertCurrent
          );
        }
      } catch {
        // Runtime's original pending/responding/unknown facts retain uncertain decisions; no replay journal.
      }
    }
    for (const key of this.deadlines.keys()) if (!retained.has(key)) this.deadlines.delete(key);
    if (this.disposed || !this.deadlines.size) return;
    const next = Math.min(...this.deadlines.values());
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (!this.disposed) this.options.kick();
      },
      Math.max(1, next - (this.options.now?.() ?? Date.now()))
    );
    this.timer.unref();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.deadlines.clear();
    this.policies.clear();
  }
}
