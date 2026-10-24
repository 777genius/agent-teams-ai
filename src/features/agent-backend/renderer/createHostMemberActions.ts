import { readMemberActions, readMemberActionView } from '../contracts/memberActions';

import { HostTeamOperationError } from './createHostTeamMutations';
import { readHostLaunchConfiguration } from './readHostLaunchConfiguration';

import type { BackendHandle } from '../contracts';
import type {
  BackendMemberActionRequest,
  BackendMemberActionView,
} from '../contracts/memberActions';
import type { AgentBackendApi } from '../contracts/operations';
/** Existing member controls retain the original command through prepare, effect, reload and UNKNOWN. */
export function createHostMemberActions(options: {
  backend: AgentBackendApi;
  captureScope(): () => boolean;
  resolve(
    key: string,
    current: () => boolean
  ): Promise<{ handle: BackendHandle; assertCurrent(): void }>;
  invalidateReads(handleId: string): void;
}) {
  async function action(
    key: string,
    memberName: string,
    kind: 'restart' | 'skip',
    expectedSecondary = false
  ): Promise<void> {
    const candidateId = crypto.randomUUID(),
      retryAttemptId = crypto.randomUUID(),
      check = options.captureScope();
    if (expectedSecondary) throw new HostTeamOperationError('unsupported', 'not-dispatched');
    if (!check()) throw new HostTeamOperationError('forbidden', 'not-dispatched');
    const target = await options.resolve(key, check),
      assertCurrent = () => {
        if (!check()) throw new HostTeamOperationError('forbidden', 'unknown');
        target.assertCurrent();
      };
    assertCurrent();
    const config = await readHostLaunchConfiguration(options.backend, target.handle);
    assertCurrent();
    if (!config) throw new HostTeamOperationError('hold', 'not-dispatched');
    const matches = config.members.filter((m) => m.label === memberName);
    if (matches.length !== 1) throw new HostTeamOperationError('conflict', 'not-dispatched');
    const memberId = matches[0]!.memberId,
      member = config.launch.members.find((m) => m.memberId === memberId);
    if (!member) throw new HostTeamOperationError('conflict', 'not-dispatched');
    const read = await options.backend.invoke({
      handle: target.handle,
      commandId: crypto.randomUUID(),
      operation: 'team.member.actions.read',
      payload: { launchId: config.launch.launchId, memberId },
    });
    assertCurrent();
    if (!read.ok) throw new HostTeamOperationError(read.code, read.outcome);
    const state = readMemberActions(read.value);
    if (
      state.launchId !== config.launch.launchId ||
      state.memberId !== memberId ||
      state.rosterRevision !== config.launch.rosterRevision
    )
      throw new HostTeamOperationError('conflict', 'not-dispatched');
    const unfinished = state.actions
      .filter((a) => a.current && !['selected', 'refused'].includes(a.stage))
      .at(-1);
    if (unfinished && (unfinished.stage !== 'prepared' || unfinished.action !== kind))
      throw new HostTeamOperationError('hold', 'unknown', unfinished.commandId);
    const priorRetry = state.retries.find((r) => r.current);
    if (
      priorRetry &&
      (priorRetry.attemptId !== member.attemptId ||
        ['not-started', 'pending-bootstrap', 'pending-human', 'unknown'].includes(member.status))
    )
      throw new HostTeamOperationError('hold', 'unknown', priorRetry.commandId);
    if (!unfinished && kind === 'restart' && member.status === 'failed' && member.noAllocation) {
      // Existing technical retry has its own durable receipt before allocation; never relabel it a fresh generation.
      try {
        assertCurrent();
        const result = await options.backend.invoke({
          handle: target.handle,
          commandId: candidateId,
          operation: 'team.launch.retry',
          payload: {
            launchId: state.launchId,
            rosterRevision: state.rosterRevision,
            attemptId: retryAttemptId,
            memberIds: [memberId],
          },
        });
        assertCurrent();
        if (!result.ok && (result.outcome === 'not-dispatched' || result.outcome === 'rejected'))
          throw new HostTeamOperationError(result.code, result.outcome, candidateId);
      } catch (error) {
        assertCurrent();
        if (error instanceof HostTeamOperationError) throw error;
      } finally {
        if (check()) options.invalidateReads(target.handle.handleId);
      }
      const lookup = await options.backend.invoke({
        handle: target.handle,
        commandId: crypto.randomUUID(),
        operation: 'team.member.actions.read',
        payload: { launchId: state.launchId, memberId },
      });
      assertCurrent();
      if (lookup.ok) {
        const retained = readMemberActions(lookup.value);
        if (
          retained.launchId === state.launchId &&
          retained.memberId === memberId &&
          retained.retries.some(
            (r) => r.commandId === candidateId && r.attemptId === retryAttemptId && r.current
          )
        )
          return;
      }
      throw new HostTeamOperationError('hold', 'unknown', candidateId);
    }
    const last = state.actions.filter((a) => a.current && a.stage === 'selected').at(-1);
    if (
      !unfinished &&
      last?.action === 'restart' &&
      !(
        last.selected?.availability === 'observed' &&
        ((last.selected.attached &&
          last.selected.phase === 'allocated' &&
          last.selected.custody === 'owned') ||
          (!last.selected.attached &&
            last.selected.phase === 'closed' &&
            last.selected.custody === 'released'))
      )
    )
      throw new HostTeamOperationError('hold', 'unknown', last.commandId);
    const commandId = unfinished?.commandId ?? candidateId;
    const request: BackendMemberActionRequest = {
      launchId: state.launchId,
      rosterRevision: unfinished?.rosterRevision ?? state.rosterRevision,
      memberId,
      expectedGeneration: unfinished?.sourceGeneration ?? member.generation,
      action: kind,
    };
    const original = (raw: unknown): BackendMemberActionView => {
      const view = readMemberActionView(raw);
      if (
        view.commandId !== commandId ||
        view.launchId !== request.launchId ||
        view.memberId !== memberId ||
        view.action !== kind ||
        view.sourceGeneration !== request.expectedGeneration ||
        view.rosterRevision !== request.rosterRevision
      )
        throw new Error('Wrong original member action');
      return view;
    };
    const lookup = async () => {
      const result = await options.backend.invoke({
        handle: target.handle,
        commandId: crypto.randomUUID(),
        operation: 'team.member.action.lookup',
        payload: { launchId: request.launchId, memberId, originalCommandId: commandId },
      });
      assertCurrent();
      return result.ok && result.value !== null ? original(result.value) : null;
    };
    let prepared: BackendMemberActionView | null = null;
    try {
      const result = await options.backend.invoke({
        handle: target.handle,
        commandId,
        operation: 'team.member.action.prepare',
        payload: request,
      });
      assertCurrent();
      if (result.ok) prepared = original(result.value);
      else if (result.outcome === 'not-dispatched' || result.outcome === 'rejected')
        throw new HostTeamOperationError(result.code, result.outcome, commandId);
    } catch (error) {
      assertCurrent();
      if (error instanceof HostTeamOperationError) throw error;
    }
    if (!prepared) prepared = await lookup();
    if (prepared?.stage !== 'prepared' || !prepared.current)
      throw new HostTeamOperationError('hold', 'unknown', commandId);
    let result: BackendMemberActionView | null = null;
    try {
      assertCurrent();
      const dispatched = await options.backend.invoke({
        handle: target.handle,
        commandId,
        operation: 'team.member.action.execute',
        payload: request,
      });
      assertCurrent();
      if (dispatched.ok) result = original(dispatched.value);
    } catch {
      assertCurrent();
    } finally {
      if (check()) options.invalidateReads(target.handle.handleId);
    }
    // A missing/uncertain result is only looked up. Never execute again or allocate a replacement ID.
    if (!result) result = await lookup();
    if (result?.stage === 'refused')
      throw new HostTeamOperationError('conflict', 'rejected', commandId);
    if (result?.stage !== 'selected' || !result.current)
      throw new HostTeamOperationError('hold', 'unknown', commandId);
    if (
      kind === 'restart' &&
      !(
        result.selected?.availability === 'observed' &&
        result.selected.attached &&
        result.selected.phase === 'allocated' &&
        result.selected.custody === 'owned'
      )
    )
      throw new HostTeamOperationError('hold', 'unknown', commandId);
  }
  return {
    restartMember: (key: string, name: string, secondary?: boolean) =>
      action(key, name, 'restart', secondary),
    skipMemberForLaunch: (key: string, name: string) => action(key, name, 'skip'),
  };
}
