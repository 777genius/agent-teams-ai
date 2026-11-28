import { createHash, randomUUID } from 'node:crypto';

import { hostTeamSelectionKey, parseHostTeamSelectionKey } from '../../contracts/teamSelection';
import { readHostGroupCatalog } from '../../core/application/readHostGroupCatalog';
import { readHostPagedSnapshot } from '../../core/application/readHostPagedSnapshot';
import { TeamProductReadOrder } from '../../core/application/TeamProductReadOrder';

import type { BackendConnectionSnapshot } from '../../contracts/connections';
import type { AgentBackendApi, BackendOperationRequest } from '../../contracts/operations';
import type { BackendRosterConfiguration } from '../../contracts/roster';
import type { BackendTeamLifecycle } from '../../contracts/teamLifecycle';
import type { DesktopBackendFeature } from '../composition/DesktopBackendFeature';

type Connection = BackendConnectionSnapshot['bindings'][number];
export interface CapturedHostReadScope {
  feature: Pick<
    DesktopBackendFeature,
    'initialize' | 'discoverBindings' | 'listBindings' | 'authorizeHandle' | 'facade'
  >;
  contextId: string;
  isCurrent(): boolean;
}

const fingerprint = (snapshot: BackendConnectionSnapshot): string =>
  JSON.stringify({
    state: snapshot.state,
    bindings: snapshot.bindings,
  });

/** One request, original owner catalog, and complete product reads; never a fallback selector. */
export class CapturedHostTeamReads {
  readonly contextId: string;
  readonly bindings: readonly Connection[];
  readonly unavailableOwners: NonNullable<BackendConnectionSnapshot['unavailableOwners']>;
  private readonly signature: string;
  private readonly order = new TeamProductReadOrder();
  private readonly products = new Map<string, ReturnType<typeof readHostPagedSnapshot>>();
  private readonly configurations = new Map<
    string,
    ReturnType<CapturedHostTeamReads['readConfiguration']>
  >();
  private readonly groups = new Map<string, Promise<Record<string, string>>>();

  constructor(
    private readonly scope: CapturedHostReadScope,
    snapshot: BackendConnectionSnapshot
  ) {
    if (!scope.isCurrent() || snapshot.state !== 'ready')
      throw new Error('Host source unavailable');
    this.contextId = scope.contextId;
    this.bindings = structuredClone(snapshot.bindings);
    this.unavailableOwners = structuredClone(snapshot.unavailableOwners ?? []);
    this.signature = fingerprint(snapshot);
    if (new Set(this.bindings.map((row) => row.handle.handleId)).size !== this.bindings.length)
      throw new Error('Ambiguous Host catalog');
    this.assertCurrent();
  }

  assertCurrent(): void {
    if (
      !this.scope.isCurrent() ||
      fingerprint(this.scope.feature.listBindings(this.contextId)) !== this.signature
    )
      throw new Error('Host source context changed');
    for (const binding of this.bindings)
      if (!this.scope.feature.authorizeHandle(this.contextId, binding.handle))
        throw new Error('Host source binding revoked');
  }

  connection(selection: string): Connection {
    this.assertCurrent();
    const handleId = parseHostTeamSelectionKey(selection);
    const binding = this.bindings.find((row) => row.handle.handleId === handleId);
    if (!binding?.ownerResourceRef || !binding.teamResourceRef)
      throw new Error('Original Host owner unavailable');
    return binding;
  }

  logicalConnection(binding: Connection): Connection {
    const selected = this.connection(hostTeamSelectionKey(binding.handle.handleId));
    if (!selected.projectContext) return selected;
    const parent = this.bindings.find(
      (row) => row.handle.handleId === selected.projectContext?.logicalHandleId
    );
    if (
      !parent ||
      parent.projectContext ||
      parent.ownerResourceRef !== selected.ownerResourceRef ||
      parent.teamResourceRef === selected.teamResourceRef
    )
      throw new Error('Host project owner changed');
    return this.connection(hostTeamSelectionKey(parent.handle.handleId));
  }

  product(selection: string): ReturnType<typeof readHostPagedSnapshot> {
    const binding = this.connection(selection);
    let promise = this.products.get(selection);
    if (!promise) {
      const backend: Pick<AgentBackendApi, 'invoke'> = {
        invoke: (request) => this.invoke(request),
      };
      promise = readHostPagedSnapshot(
        backend,
        binding,
        () => {
          this.assertCurrent();
          return true;
        },
        this.order
      );
      this.products.set(selection, promise);
    }
    return promise.then((value) => {
      this.assertCurrent();
      value.assertCurrent();
      return value;
    });
  }

  savedConfiguration(selection: string): ReturnType<CapturedHostTeamReads['readConfiguration']> {
    this.connection(selection);
    let promise = this.configurations.get(selection);
    if (!promise) {
      promise = this.readConfiguration(selection);
      this.configurations.set(selection, promise);
    }
    return promise.then((value) => {
      value.assertCurrent();
      return value;
    });
  }

  /** A write admission must re-read the original owner; a request-local cache is not a fence. */
  async verifyConfiguration(selection: string, revision: string): Promise<void> {
    this.connection(selection);
    const current = await this.readConfiguration(selection);
    if (current.revision !== revision) throw new Error('Host saved configuration changed');
    current.assertCurrent();
  }

  private async readConfiguration(selection: string) {
    const connection = this.connection(selection);
    const read = async (operation: 'team.roster.read' | 'team.lifecycle.read') => {
      const result = await this.invoke({
        handle: connection.handle,
        commandId: randomUUID(),
        operation,
        payload: {},
      });
      if (!result.ok) throw new Error('Host saved configuration unavailable');
      return result.value;
    };
    const before = (await read('team.lifecycle.read')) as BackendTeamLifecycle;
    const configuration = (await read('team.roster.read')) as BackendRosterConfiguration;
    const repeated = (await read('team.roster.read')) as BackendRosterConfiguration;
    const after = (await read('team.lifecycle.read')) as BackendTeamLifecycle;
    const unavailable = (value: BackendTeamLifecycle) =>
      value.kind !== 'team_lifecycle' ||
      value.deletedAt !== null ||
      value.cleanupPending ||
      value.pendingPurge ||
      value.pendingChange;
    if (
      unavailable(before) ||
      unavailable(after) ||
      before.revision !== after.revision ||
      configuration.revision !== repeated.revision ||
      !configuration.savedSettings
    )
      throw new Error('Host saved configuration changed or unavailable');
    this.assertCurrent();
    const revision = createHash('sha256')
      .update(
        JSON.stringify({
          owner: connection.ownerResourceRef,
          team: connection.teamResourceRef,
          contextId: this.contextId,
          lifecycle: after.revision,
          configuration: configuration.revision,
        })
      )
      .digest('hex');
    return { connection, configuration, revision, assertCurrent: () => this.assertCurrent() };
  }

  groupNames(selection: string): Promise<Record<string, string>> {
    const connection = this.connection(selection);
    let promise = this.groups.get(selection);
    if (!promise) {
      promise = (async () => {
        const rows = await readHostGroupCatalog(
          async (cursor) => {
            const result = await this.invoke({
              handle: connection.handle,
              commandId: randomUUID(),
              operation: 'group.list',
              payload: cursor === undefined ? {} : { cursor },
            });
            if (!result.ok) throw new Error('Host groups unavailable');
            return result.value;
          },
          () => this.assertCurrent()
        );
        return Object.fromEntries(rows.map((group) => [group.id, group.name]));
      })();
      this.groups.set(selection, promise);
    }
    return promise.then((value) => {
      this.assertCurrent();
      return value;
    });
  }

  private async invoke(request: BackendOperationRequest) {
    this.connection(hostTeamSelectionKey(request.handle.handleId));
    const result = await this.scope.feature.facade.invoke(request, {
      isCurrent: () => {
        this.assertCurrent();
        return true;
      },
    });
    this.assertCurrent();
    return result;
  }
}

export type CaptureHostTeamReads = () => Promise<CapturedHostTeamReads | undefined>;

export async function captureHostTeamReads(
  scope: CapturedHostReadScope | undefined
): Promise<CapturedHostTeamReads | undefined> {
  if (!scope) return undefined;
  if (!scope.isCurrent()) throw new Error('Host source context changed');
  await scope.feature.initialize();
  if (!scope.isCurrent()) throw new Error('Host source context changed');
  const snapshot = await scope.feature.discoverBindings(scope.contextId, {
    isCurrent: scope.isCurrent,
  });
  if (!scope.isCurrent()) throw new Error('Host source context changed');
  if (snapshot.state === 'unconfigured') return undefined;
  return new CapturedHostTeamReads(scope, snapshot);
}
