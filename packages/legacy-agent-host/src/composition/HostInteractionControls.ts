import { z } from 'zod';
import { toolApprovalSettingsSchema } from '../approval/settings.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { CapturedInteractionPreview } from './CapturedInteractionPreview.js';
import { HostToolApprovalPolicy } from './HostToolApprovalPolicy.js';
import { runtimeMember, runtimeControlId } from './runtimeControlValues.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';

export const interactionPreviewInput = runtimeMember
  .extend({
    expectedGeneration: runtimeControlId,
    inputId: runtimeControlId,
    interactionRef: runtimeControlId,
    offset: z
      .number()
      .int()
      .min(0)
      .max(2 * 1024 * 1024),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    expectedSource: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine((input) => input.offset === 0 || (!!input.expectedSha256 && !!input.expectedSource));

/** Existing interaction owner, current preferences and request-scoped preview; no new Team journal. */
export class HostInteractionControls {
  private readonly previews = new CapturedInteractionPreview();
  private readonly policy: HostToolApprovalPolicy;
  constructor(
    private readonly options: {
      principalId: string;
      runtime: RuntimeOwner;
      assertCurrent(entry: MemberEntry): void;
      kick(): void;
    }
  ) {
    this.policy = new HostToolApprovalPolicy(options);
  }

  capture(entry: MemberEntry): void {
    this.options.assertCurrent(entry);
    try {
      this.previews.capture(entry);
    } catch {
      /* A missing preview grant never changes ordinary launch behavior. */
    }
  }
  settings(team: HostedTeam, raw?: unknown) {
    const settings = this.policy.settings(team, raw);
    if (raw !== undefined) this.options.kick();
    return { settings: { ...settings } };
  }
  executeSettings(team: HostedTeam | undefined, operation: string, raw: unknown) {
    if (!team) throw new RuntimeOwnerError('invalid');
    if (operation === 'approval.settings.read') {
      z.object({}).strict().parse(raw);
      return this.settings(team);
    }
    const input = z.object({ settings: toolApprovalSettingsSchema }).strict().parse(raw);
    return this.settings(team, input.settings);
  }
  pump(entries: Iterable<MemberEntry>): Promise<void> {
    return this.policy.pump(entries);
  }
  seal(): void {
    this.policy.dispose();
  }
  preview(entry: MemberEntry, raw: unknown) {
    const input = interactionPreviewInput.parse(raw);
    const authorityRevision = entry.team.owner.withLaunchAuthority(this.options.principalId, 'read', revision => revision);
    return this.previews.read({
      runtime: this.options.runtime,
      entry,
      input,
      authoritySource: runtimeDigest({ principalId: this.options.principalId, revision: authorityRevision }),
      assertCurrent: () => {
        this.options.assertCurrent(entry);
        entry.team.owner.withLaunchAuthority(this.options.principalId, 'read', revision => {
          if (revision !== authorityRevision) throw new RuntimeOwnerError('forbidden');
        });
        if (!entry.team.owner.authorizeRuntimeAccess(this.options.principalId, entry.binding, 'control'))
          throw new RuntimeOwnerError('forbidden');
      },
    });
  }
}
