import { TeamOwnerError } from '../team/contracts.js';
import type { MemberEntry } from './MemberEntry.js';
import type { captureNativeInputAuthority } from './captureNativeInputAuthority.js';
import type { RegisteredProcessNative } from '../process/registeredProcessContracts.js';
/** Private original member capability; input PID never selects a runtime/member/root. */
export function createMemberProcessMcpPort(options: {
  entry: MemberEntry;
  native?: Pick<RegisteredProcessNative, 'observe' | 'signal'>;
  assertCurrent(): void;
  assertAllocatedCurrent?(): void;
  captureSource?(): ReturnType<typeof captureNativeInputAuthority>;
}) {
  const { entry } = options;
  const original = structuredClone(entry.delivery),
    principalId = entry.profile.principalId;
  const commands = (assertCurrent: () => void) => {
    const registrar = () => {
      assertCurrent();
      const { backendId, teamId, runId, memberId, generation } = original;
      return { backendId, teamId, runId, memberId, generation };
    };
    return entry.team.owner.processCommands(principalId, {
      assertCurrent,
      registrar,
      ...(options.native
        ? {
            native: {
              capture(pid, captured) {
                assertCurrent();
                if (
                  !entry.provider?.captureRegisteredProcess ||
                  Object.entries(registrar()).some(
                    ([key, value]) => captured[key as keyof typeof captured] !== value
                  )
                )
                  throw new Error('process:hold');
                return entry.provider.captureRegisteredProcess(pid, captured);
              },
              observe: options.native.observe,
              signal: options.native.signal,
            },
          }
        : {}),
    });
  };
  type Commands = ReturnType<typeof commands>;
  function read<T>(callback: (commands: Commands) => T): T {
    options.assertAllocatedCurrent?.(); // Runtime inspection outside the synchronous Team fence.
    const result = callback(commands(options.assertCurrent));
    options.assertCurrent();
    return result;
  }
  function mutate<T>(callback: (commands: Commands) => T): T {
    options.assertAllocatedCurrent?.();
    const source = options.captureSource?.(); // Captures this call's own original input once.
    source?.assertCurrent();
    // No await through native audit and commit. Only Team proof re-enters the Team fence.
    const result = callback(
      commands(() => {
        options.assertCurrent();
        source?.assertTeamCurrent();
      })
    );
    source?.assertCurrent();
    options.assertCurrent();
    return result;
  }
  // Only this known refusal is public. Unexpected adapter failures retain opaque MCP errors.
  function project<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof Error && error.message === 'process:hold')
        throw new TeamOwnerError('hold');
      throw error;
    }
  }
  return Object.freeze({
    register: (...args: Parameters<Commands['register']>) =>
      project(() => mutate((c) => c.register(...args))),
    metadata: (...args: Parameters<Commands['metadata']>) =>
      project(() => mutate((c) => c.metadata(...args))),
    list: () => project(() => read((c) => c.list())),
    lookup: (...args: Parameters<Commands['lookup']>) =>
      project(() => read((c) => c.lookup(...args))),
  });
}
