import { TeamOwnerError } from '../team/contracts.js';
import { nativeMemberCreationSchema } from '../team/nativeMemberCreationContracts.js';
import type { TeamNativeMemberCreation } from '../team/TeamNativeMemberCreation.js';
import type {
  NativeMemberCreationAuthority,
  NativeMemberCreationInput,
  NativeMemberCreationRecord,
  NativeMemberCreationView,
} from '../team/nativeMemberCreationContracts.js';

/** The existing captured-member factory supplies this port; it owns no separate command queue. */
export interface NewCapturedMemberPort<Captured> {
  /** Validate actual configured provider/model and original custody after expected roster publication. */
  prepare(
    input: NativeMemberCreationInput,
    expected: NativeMemberCreationView,
    source: NativeMemberCreationAuthority
  ): Promise<Captured>;
  expected(captured: Captured, authorized: <T>(operation: () => T) => T): void;
  selection(captured: Captured): NonNullable<NativeMemberCreationRecord['selection']>;
  /** Persist the expected original TeamLaunch member/attempt before calling the provider factory. */
  install(captured: Captured, assertAllocationCurrent: () => void): Promise<void>;
  /** Reuse the existing next-input standing-context mechanism; never enqueue a reminder input. */
  remindPeers(captured: Captured): void;
}

/** One admitted native tool call. Duplicates and lost-ACK lookup never rerun a native effect. */
export function createNativeMemberCreation<Captured>(options: {
  owner: TeamNativeMemberCreation;
  runtime: NewCapturedMemberPort<Captured>;
  assertCurrent(): void;
}) {
  const parse = (raw: unknown) => {
    const parsed = nativeMemberCreationSchema.safeParse(raw);
    if (!parsed.success) throw new TeamOwnerError('invalid');
    return structuredClone(parsed.data);
  };
  return {
    lookup(source: NativeMemberCreationAuthority, raw: unknown) {
      options.assertCurrent();
      return options.owner.lookup(source, parse(raw));
    },
    async add(
      source: NativeMemberCreationAuthority,
      raw: unknown
    ): Promise<NativeMemberCreationView> {
      const input = parse(raw);
      const current = () => {
        options.assertCurrent();
        source.assertCurrent();
      };
      current();
      const admission = options.owner.begin(source, input);
      if (!admission.fresh) return admission.value;
      // The original prepared receipt/expected member is durable before even model preflight.
      try {
        const captured = await options.runtime.prepare(input, admission.value, source);
        current();
        options.runtime.expected(captured, (operation) =>
          options.owner.withPrepared(source, input, operation)
        );
        options.owner.configure(source, input, options.runtime.selection(captured));
        // Allocation authority ends after its one original claim. Provider lifetime uses
        // the installed member's own captured grant/binding, not the parent's input.
        await options.runtime.install(captured, current);
        current();
        options.runtime.remindPeers(captured);
        return options.owner.settle(source, input, 'completed');
      } catch (error) {
        try {
          current();
          options.owner.settle(source, input, 'held');
        } catch {
          /* Original receipt remains queryable; never replay it. */
        }
        throw error;
      }
    },
  };
}
