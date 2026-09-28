import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { type Cursor, type Revision, type TeamId } from '@shared/contracts/hosted';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';

import {
  HOSTED_TASK_BOARD_COLUMNS,
  HOSTED_TASK_BOARD_SCHEMA_VERSION,
  type HostedTaskBoardColumn,
  type HostedTaskBoardCoreV1MutationCommand,
  type HostedTaskBoardItem,
  type HostedTaskBoardSourceGeneration,
} from '../../contracts/hosted';
import {
  type HostedCreateTaskRegistry,
  HostedCreateTaskSession,
} from '../composition/HostedCreateTaskSession';
import { hostedMutationIdentity } from '../utils/hostedTaskMutationIdentity';

import { HostedCreateTaskControls } from './HostedCreateTaskControls';
import {
  type HostedTaskMutationBase,
  HostedTaskMutationControls,
} from './HostedTaskMutationControls';

import type { CreateTaskScope } from '../../core/application/models/CreateTaskInteraction';
import type { HostedTaskBoardTransport } from '../ports/HostedTaskBoardRendererPorts';

const SAFE_ERROR_MESSAGE = 'The task board is temporarily unavailable. Refresh to try again.';
type LoadStatus = 'loading' | 'refreshing' | 'loading_more' | 'ready' | 'error';
interface HostedTaskBoardViewState {
  readonly items: readonly HostedTaskBoardItem[];
  readonly nextCursor: Cursor | null;
  readonly sourceGeneration: HostedTaskBoardSourceGeneration | null;
  readonly revision: Revision | null;
  readonly status: LoadStatus;
  readonly error: string | null;
  readonly stale: boolean;
  readonly degraded: boolean;
}
export interface HostedTaskBoardPageProps {
  readonly teamId: TeamId;
  readonly transport: HostedTaskBoardTransport;
  readonly createScope: CreateTaskScope;
  readonly createRegistry: HostedCreateTaskRegistry;
  readonly heading?: string;
  readonly description?: string;
  readonly pageLimit?: number;
}
const COLUMN_LABELS: Readonly<Record<HostedTaskBoardColumn, string>> = Object.freeze({
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  approved: 'Approved',
  done: 'Done',
});
function initialState(): HostedTaskBoardViewState {
  return Object.freeze({
    items: Object.freeze([]),
    nextCursor: null,
    sourceGeneration: null,
    revision: null,
    status: 'loading',
    error: null,
    stale: false,
    degraded: false,
  });
}
function unstablePage(
  current: HostedTaskBoardViewState,
  incomingItems: readonly HostedTaskBoardItem[],
  sourceGeneration: HostedTaskBoardSourceGeneration,
  revision: Revision,
  nextCursor: Cursor | null,
  seenCursors: ReadonlySet<Cursor>
): boolean {
  const currentIds = new Set(current.items.map((item) => item.taskId));
  return (
    current.sourceGeneration !== sourceGeneration ||
    current.revision !== revision ||
    incomingItems.some((item) => currentIds.has(item.taskId)) ||
    (nextCursor !== null && seenCursors.has(nextCursor))
  );
}
export const HostedTaskBoardPage = ({
  teamId,
  transport,
  createScope,
  createRegistry,
  heading = 'Task board',
  description = 'Current team tasks grouped by workflow stage.',
  pageLimit = 25,
}: HostedTaskBoardPageProps): React.JSX.Element => {
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
    throw new TypeError('hosted-task-board-renderer-page-limit-invalid');
  }
  const headingId = useId();
  const descriptionId = useId();
  const [state, setState] = useState<HostedTaskBoardViewState>(initialState);
  const operationGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const seenCursors = useRef(new Set<Cursor>());
  const transportGeneration = useRef(0);
  const revisionEventWatermark = useRef(0);
  const currentState = useRef(state);
  currentState.current = state;
  const createSession = useMemo(
    () =>
      createRegistry.getOrCreate(
        createScope,
        () => new HostedCreateTaskSession(createScope, teamId)
      ),
    [createRegistry, createScope, teamId]
  );
  const pendingNonCreate = useSyncExternalStore(
    createSession.nonCreate.subscribe,
    createSession.nonCreate.getSnapshot
  );
  useLayoutEffect(() => {
    transportGeneration.current += 1;
    return () => {
      transportGeneration.current += 1;
    };
  }, [transport]);
  const publishError = useCallback((generation: number, currentTransportGeneration: number) => {
    if (
      operationGeneration.current !== generation ||
      transportGeneration.current !== currentTransportGeneration
    )
      return;
    busy.current = false;
    activeController.current = null;
    setState((current) =>
      Object.freeze({ ...current, status: 'error', error: SAFE_ERROR_MESSAGE })
    );
  }, []);
  const isCurrentOperation = useCallback(
    (generation: number, currentTransportGeneration: number, signal: AbortSignal): boolean =>
      operationGeneration.current === generation &&
      transportGeneration.current === currentTransportGeneration &&
      !signal.aborted,
    []
  );
  const markStale = useCallback(() => {
    busy.current = false;
    setState((current) =>
      Object.freeze({ ...current, status: 'refreshing', error: null, stale: true })
    );
  }, []);
  const loadFirstPage = useCallback(
    async (reason: 'initial' | 'manual' | 'mutation' | 'stale'): Promise<boolean> => {
      const generation = operationGeneration.current + 1;
      operationGeneration.current = generation;
      const currentTransportGeneration = transportGeneration.current;
      const requestEventWatermark = revisionEventWatermark.current;
      activeController.current?.abort();
      const controller = new AbortController();
      activeController.current = controller;
      busy.current = true;
      seenCursors.current = new Set();
      setState((current) =>
        Object.freeze({
          ...current,
          items: reason === 'initial' ? Object.freeze([]) : current.items,
          nextCursor: reason === 'initial' ? null : current.nextCursor,
          sourceGeneration: reason === 'initial' ? null : current.sourceGeneration,
          revision: reason === 'initial' ? null : current.revision,
          status: reason === 'initial' || current.items.length === 0 ? 'loading' : 'refreshing',
          error: null,
          stale: reason === 'stale',
          degraded: reason === 'initial' ? false : current.degraded,
        })
      );
      try {
        const result = await transport.getPage(
          Object.freeze({
            schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
            teamId,
            cursor: null,
            expectedSourceGeneration: null,
            limit: pageLimit,
          }),
          Object.freeze({ signal: controller.signal })
        );
        if (!isCurrentOperation(generation, currentTransportGeneration, controller.signal))
          return false;
        if (result.kind !== 'success' || result.page.teamId !== teamId) {
          publishError(generation, currentTransportGeneration);
          return false;
        }
        if (revisionEventWatermark.current !== requestEventWatermark) return false;
        if (result.page.nextCursor !== null) seenCursors.current.add(result.page.nextCursor);
        busy.current = false;
        activeController.current = null;
        setState(
          Object.freeze({
            items: result.page.items,
            nextCursor: result.page.nextCursor,
            sourceGeneration: result.page.sourceGeneration,
            revision: result.page.revision,
            status: 'ready',
            error: null,
            stale: false,
            degraded: result.page.degraded.active,
          })
        );
        return true;
      } catch {
        publishError(generation, currentTransportGeneration);
        return false;
      }
    },
    [isCurrentOperation, pageLimit, publishError, teamId, transport]
  );
  useLayoutEffect(
    () =>
      createSession.bind({
        transport,
        getBasis: () => {
          const current = currentState.current;
          return current.sourceGeneration === null || current.revision === null
            ? null
            : Object.freeze({
                sourceGeneration: current.sourceGeneration,
                revision: current.revision,
                items: current.items,
              });
        },
        refresh: async () => {
          if (!(await loadFirstPage('mutation'))) throw new Error('hosted-create-refresh-failed');
        },
      }),
    [createSession, loadFirstPage, transport]
  );
  const executeMutation = useCallback(
    async (command: HostedTaskBoardCoreV1MutationCommand, replay = false): Promise<void> => {
      const mutation = transport.executeMutation;
      if (mutation === undefined || busy.current) return;
      const pending = createSession.nonCreate;
      if (replay ? !pending.beginReplay(command) : !pending.claim(command)) return;
      const execute = mutation.bind(transport);
      const generation = operationGeneration.current + 1;
      operationGeneration.current = generation;
      const currentTransportGeneration = transportGeneration.current;
      activeController.current?.abort();
      activeController.current = null;
      busy.current = true;
      setState((current) =>
        Object.freeze({ ...current, status: 'refreshing', error: null, stale: false })
      );
      try {
        // Read cleanup never aborts a command whose dispatch boundary may have been crossed.
        const result = await execute(command);
        pending.finishAttempt(command);
        if (
          result.kind === 'committed' ||
          result.kind === 'idempotent_replay' ||
          result.kind === 'stale_generation' ||
          result.kind === 'stale_revision' ||
          result.kind === 'not_found' ||
          result.kind === 'unsafe_active' ||
          result.kind === 'invalid_request' ||
          (result.kind === 'conflict' && result.reason !== 'idempotency_mismatch')
        )
          pending.settle(command);
        if (
          operationGeneration.current !== generation ||
          transportGeneration.current !== currentTransportGeneration
        )
          return;
        if (result.kind === 'committed' || result.kind === 'idempotent_replay') {
          busy.current = false;
          await loadFirstPage('mutation');
          return;
        }
        if (
          result.kind === 'stale_generation' ||
          result.kind === 'stale_revision' ||
          result.kind === 'conflict' ||
          result.kind === 'not_found' ||
          result.kind === 'unsafe_active'
        ) {
          markStale();
          await loadFirstPage('stale');
          return;
        }
        publishError(generation, currentTransportGeneration);
      } catch {
        pending.finishAttempt(command);
        publishError(generation, currentTransportGeneration);
      }
    },
    [createSession, loadFirstPage, markStale, publishError, transport]
  );
  const retryMutation = useCallback((): void => {
    const command = createSession.nonCreate.getSnapshot().command;
    if (command !== null) void executeMutation(command, true);
  }, [createSession, executeMutation]);
  const loadMore = useCallback(async (): Promise<void> => {
    if (
      busy.current ||
      state.nextCursor === null ||
      state.sourceGeneration === null ||
      state.revision === null
    ) {
      return;
    }
    const requestCursor = state.nextCursor;
    const expectedSourceGeneration = state.sourceGeneration;
    const expectedRevision = state.revision;
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    const currentTransportGeneration = transportGeneration.current;
    const controller = new AbortController();
    activeController.current = controller;
    busy.current = true;
    setState((current) =>
      Object.freeze({ ...current, status: 'loading_more', error: null, stale: false })
    );
    try {
      const result = await transport.getPage(
        Object.freeze({
          schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
          teamId,
          cursor: requestCursor,
          expectedSourceGeneration,
          limit: pageLimit,
        }),
        Object.freeze({ signal: controller.signal })
      );
      if (!isCurrentOperation(generation, currentTransportGeneration, controller.signal)) return;
      if (result.kind === 'stale_generation') {
        markStale();
        await loadFirstPage('stale');
        return;
      }
      if (
        result.kind !== 'success' ||
        result.page.teamId !== teamId ||
        unstablePage(
          state,
          result.page.items,
          result.page.sourceGeneration,
          result.page.revision,
          result.page.nextCursor,
          seenCursors.current
        ) ||
        expectedRevision !== result.page.revision
      ) {
        if (result.kind === 'success') {
          markStale();
          await loadFirstPage('stale');
        } else {
          publishError(generation, currentTransportGeneration);
        }
        return;
      }
      if (result.page.nextCursor !== null) seenCursors.current.add(result.page.nextCursor);
      busy.current = false;
      activeController.current = null;
      setState((current) =>
        Object.freeze({
          ...current,
          items: Object.freeze([...current.items, ...result.page.items]),
          nextCursor: result.page.nextCursor,
          sourceGeneration: result.page.sourceGeneration,
          revision: result.page.revision,
          status: 'ready',
          error: null,
          stale: false,
          degraded: current.degraded || result.page.degraded.active,
        })
      );
    } catch {
      publishError(generation, currentTransportGeneration);
    }
  }, [
    isCurrentOperation,
    loadFirstPage,
    markStale,
    pageLimit,
    publishError,
    state,
    teamId,
    transport,
  ]);
  const createMutationBase = useCallback((): HostedTaskMutationBase | null => {
    if (state.sourceGeneration === null || state.revision === null) return null;
    return Object.freeze({
      schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
      ...hostedMutationIdentity(),
      teamId,
      expectedSourceGeneration: state.sourceGeneration,
      expectedRevision: state.revision,
    });
  }, [state.revision, state.sourceGeneration, teamId]);
  const dispatchMutation = useCallback(
    (build: (base: HostedTaskMutationBase) => HostedTaskBoardCoreV1MutationCommand): void => {
      const base = createMutationBase();
      if (base !== null) void executeMutation(build(base));
    },
    [createMutationBase, executeMutation]
  );
  useEffect(() => {
    void loadFirstPage('initial');
    const subscribeToInvalidations = transport.subscribeToInvalidations;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe =
        typeof subscribeToInvalidations === 'function'
          ? subscribeToInvalidations.call(transport, teamId, (event) => {
              if (event.teamId !== teamId) return;
              revisionEventWatermark.current += 1;
              if (!busy.current || createSession.nonCreate.getSnapshot().command === null)
                void loadFirstPage('stale');
            })
          : undefined;
    } catch {
      // Optional event wiring must not block the HTTP task-board view.
    }
    return () => {
      try {
        unsubscribe?.();
      } catch {
        /* optional event teardown */
      }
      operationGeneration.current += 1;
      activeController.current?.abort();
      activeController.current = null;
      busy.current = false;
      seenCursors.current = new Set();
    };
  }, [createSession, loadFirstPage, teamId, transport]);
  const isBusy = ['loading', 'refreshing', 'loading_more'].includes(state.status);
  const mutationsEnabled = typeof transport.executeMutation === 'function';
  return (
    <main
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      aria-busy={isBusy}
      className="min-h-full bg-[var(--color-background)] p-4 text-[var(--color-text)]"
    >
      <div className="mx-auto max-w-[1600px]">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 id={headingId} className="text-lg font-semibold">
              {heading}
            </h1>
            <p id={descriptionId} className="mt-1 text-sm text-[var(--color-text-muted)]">
              {description}
            </p>
          </div>
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Refresh task board"
                  disabled={isBusy}
                  onClick={() => void loadFirstPage('manual')}
                >
                  {state.status === 'refreshing' ? (
                    <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw aria-hidden="true" className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh task board</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </header>
        <HostedCreateTaskControls
          key={`${createScope.key}:${createScope.authorityEpoch}`}
          session={createSession}
          mutationsEnabled={mutationsEnabled}
          canObserve={typeof transport.observeCreation === 'function'}
          boardBusy={isBusy || pendingNonCreate.command !== null}
          hasBasis={state.sourceGeneration !== null && state.revision !== null}
          onConflict={() => void loadFirstPage('stale')}
        />
        {state.status === 'loading' && state.items.length === 0 ? (
          <p
            role="status"
            className="mt-6 flex items-center gap-2 text-sm text-[var(--color-text-muted)]"
          >
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            Loading task board…
          </p>
        ) : null}
        {state.stale ? (
          <p
            role="status"
            className="mt-4 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600"
          >
            <RefreshCw aria-hidden="true" className="size-4 animate-spin" />
            The task board changed. Refreshing the current board…
          </p>
        ) : null}
        {state.error !== null ? (
          <div
            role="alert"
            className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500"
          >
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
            {state.error}
            {mutationsEnabled && pendingNonCreate.command !== null ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy || pendingNonCreate.inFlight}
                onClick={retryMutation}
              >
                Retry task change
              </Button>
            ) : null}
          </div>
        ) : null}
        {pendingNonCreate.command !== null && state.error === null && !isBusy ? (
          <div
            role="alert"
            className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
          >
            <span>
              The original task change is unresolved. Command:{' '}
              <code>{pendingNonCreate.command.commandId}</code>
            </span>
            {mutationsEnabled ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pendingNonCreate.inFlight}
                onClick={retryMutation}
              >
                Retry task change
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pendingNonCreate.inFlight}
              onClick={() => createSession.nonCreate.dismiss()}
            >
              Dismiss unresolved change
            </Button>
          </div>
        ) : null}
        {state.degraded ? (
          <p className="mt-4 rounded-md bg-amber-500/10 p-3 text-sm text-amber-600">
            Some task data may be delayed. Refresh for the latest available view.
          </p>
        ) : null}
        {state.items.length > 0 ? (
          <div
            className="mt-5 grid gap-3 lg:grid-cols-5"
            aria-label={mutationsEnabled ? 'Task board' : 'Read-only task board'}
          >
            {HOSTED_TASK_BOARD_COLUMNS.map((column) => {
              const items = state.items.filter((item) => item.column === column);
              return (
                <section
                  key={column}
                  aria-label={COLUMN_LABELS[column]}
                  className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
                >
                  <h2 className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                    <span>{COLUMN_LABELS[column]}</span>
                    <span aria-label={`${items.length} tasks`}>{items.length}</span>
                  </h2>
                  {items.length === 0 ? (
                    <p className="mt-3 text-xs text-[var(--color-text-subtle)]">No tasks</p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {items.map((item) => (
                        <li
                          key={item.taskId}
                          data-task-id={item.taskId}
                          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3"
                        >
                          <h3 className="break-words text-sm font-medium">{item.subject}</h3>
                          {item.description !== null && item.description.length > 0 ? (
                            <p className="mt-2 whitespace-pre-wrap break-words text-xs text-[var(--color-text-muted)]">
                              {item.description}
                            </p>
                          ) : null}
                          <p className="mt-2 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-subtle)]">
                            {item.status.replace('_', ' ')}
                          </p>
                          {mutationsEnabled ? (
                            <HostedTaskMutationControls
                              key={[item.taskId, state.sourceGeneration, state.revision].join(':')}
                              item={item}
                              allItems={state.items}
                              columnItems={items}
                              disabled={isBusy || pendingNonCreate.command !== null}
                              orderingDisabled={state.nextCursor !== null}
                              dispatch={dispatchMutation}
                            />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        ) : null}
        {state.status === 'ready' && state.items.length === 0 ? (
          <p className="mt-6 rounded-md bg-[var(--color-surface)] p-4 text-sm text-[var(--color-text-muted)]">
            This team has no tasks.
          </p>
        ) : null}
        {state.nextCursor !== null ? (
          <Button
            type="button"
            variant="outline"
            className="mt-4 w-full"
            aria-label="Load more tasks; task moves and whole-column ordering stay disabled until all tasks load"
            disabled={isBusy || state.status === 'error'}
            onClick={() => void loadMore()}
          >
            {state.status === 'loading_more' ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : null}
            Load more tasks
          </Button>
        ) : null}
      </div>
    </main>
  );
};
