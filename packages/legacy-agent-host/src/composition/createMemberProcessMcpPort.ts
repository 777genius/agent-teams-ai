import { performance } from 'node:perf_hooks';
import { TeamOwnerError } from '../team/contracts.js';
import type { MemberEntry } from './MemberEntry.js';
import type { captureNativeInputAuthority } from './captureNativeInputAuthority.js';
import type { RegisteredProcessNative } from '../process/registeredProcessContracts.js';
import type { WindowsRegisteredProcessPort } from '../owned-process/retainedServiceContracts.js';
/** Private original member capability; input PID never selects a runtime/member/root. */
export function createMemberProcessMcpPort(options: {
  entry: MemberEntry;
  native?: Pick<RegisteredProcessNative, 'observe' | 'signal'>;
  windows?: WindowsRegisteredProcessPort;
  assertCurrent(): void;
  assertAllocatedCurrent?(): void;
  captureSource?(): ReturnType<typeof captureNativeInputAuthority>;
}) {
  const { entry } = options;
  const original = structuredClone(entry.delivery),
    principalId = entry.profile.principalId;
  const commands = (assertCurrent: () => void, assertAsyncCurrent?: () => void) => {
    const registrar = () => {
      assertCurrent();
      const { backendId, teamId, runId, memberId, generation } = original;
      return { backendId, teamId, runId, memberId, generation };
    };
    return entry.team.owner.processCommands(principalId, {
      assertCurrent,
      ...(assertAsyncCurrent ? { assertAsyncCurrent } : {}),
      registrar,
      ...(options.windows ? { windows: {
        prepareCapture(pid, captured) {
          assertCurrent();
          if (!entry.provider?.prepareRegisteredWindowsProcess ||
              Object.entries(registrar()).some(([key, value]) => captured[key as keyof typeof captured] !== value))
            throw new Error('process:hold');
          return entry.provider.prepareRegisteredWindowsProcess(pid, captured);
        },
        prepareControl: (capture, operation) => options.windows!.prepareControl(capture, operation),
        run: (intent, deadline) => options.windows!.run(intent, deadline),
        lookup: (intent, deadline) => options.windows!.lookup(intent, deadline),
        query: (capture, deadline) => options.windows!.query(capture, deadline),
      } } : {}),
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
  async function readAsync<T>(callback: (commands: Commands) => Promise<T>): Promise<T> {
    options.assertAllocatedCurrent?.();
    const result = await callback(commands(options.assertCurrent, () => {
      options.assertAllocatedCurrent?.(); options.assertCurrent();
    }));
    options.assertAllocatedCurrent?.(); options.assertCurrent();
    return result;
  }
  async function mutateAsync<T>(callback: (commands: Commands) => Promise<T>): Promise<T> {
    options.assertAllocatedCurrent?.();
    const source = options.captureSource?.();
    source?.assertCurrent();
    const result = await callback(commands(() => {
      options.assertCurrent(); source?.assertTeamCurrent();
    }, () => {
      options.assertAllocatedCurrent?.(); source?.assertCurrent(); options.assertCurrent();
    }));
    source?.assertCurrent(); options.assertCurrent();
    return result;
  }
  async function projectAsync<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof Error && error.message === 'process:hold') throw new TeamOwnerError('hold');
      throw error;
    }
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
    register: (...args: Parameters<Commands['register']>) => {
      const deadline = performance.now() + 10000;
      return options.windows
        ? projectAsync(() => mutateAsync(c => c.windows!.register(...args, deadline)))
        : project(() => mutate(c => c.register(...args)));
    },
    metadata: (...args: Parameters<Commands['metadata']>) =>
      project(() => mutate((c) => c.metadata(...args))),
    list: () => {
      const deadline = performance.now() + 10000;
      return options.windows ? projectAsync(() => readAsync(c => c.windows!.list(deadline)))
        : project(() => read(c => c.list()));
    },
    lookup: (...args: Parameters<Commands['lookup']>) => {
      const deadline = performance.now() + 10000;
      // Windows lookup can finish the original registration policy phase; retain call-specific authority.
      return options.windows ? projectAsync(() => mutateAsync(c => c.windows!.lookup(...args, deadline)))
        : project(() => read(c => c.lookup(...args)));
    },
  });
}
