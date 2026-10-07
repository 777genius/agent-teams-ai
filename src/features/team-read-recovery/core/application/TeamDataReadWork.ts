import { sameScope, type TeamReadScope } from './ScopedReadRequests';

type SnapshotMode = 'full' | 'thin';
interface TeamDataOwner<T> {
  readonly scope: TeamReadScope;
  readonly active: Partial<Record<SnapshotMode, Promise<T>>>;
  readonly refreshes: Set<symbol>;
  fresh: boolean;
  queuedFull: boolean;
}

/** Live data-read ownership; completed snapshots remain in the store, never here. */
export class TeamDataReadWork<T> {
  private readonly owners = new Map<string, TeamDataOwner<T>>();

  join(team: string, mode: SnapshotMode, scope: TeamReadScope, read: () => Promise<T>): Promise<T> {
    const owner = this.ensure(team, scope);
    const existing = owner.active[mode];
    if (existing) return existing;
    const request = read().finally(() => {
      if (this.owners.get(team) !== owner || owner.active[mode] !== request) return;
      delete owner.active[mode];
      this.prune(team, owner);
    });
    owner.active[mode] = request;
    return request;
  }

  hasRead(team: string, mode: SnapshotMode, scope: TeamReadScope): boolean {
    return this.lookup(team, scope, true)?.active[mode] !== undefined;
  }

  beginRefresh(team: string, scope: TeamReadScope): symbol {
    const token = Symbol(team);
    this.ensure(team, scope).refreshes.add(token);
    return token;
  }

  endRefresh(team: string, scope: TeamReadScope, token: symbol): void {
    const owner = this.lookup(team, scope);
    if (owner?.refreshes.delete(token)) this.prune(team, owner);
  }

  markFresh(team: string, scope: TeamReadScope): void {
    this.ensure(team, scope).fresh = true;
  }

  takeFresh(team: string, scope: TeamReadScope): boolean {
    const owner = this.lookup(team, scope);
    if (!owner?.fresh) return false;
    owner.fresh = false;
    this.prune(team, owner);
    return true;
  }

  queueFull(team: string, scope: TeamReadScope): void {
    this.ensure(team, scope).queuedFull = true;
  }

  takeQueuedFull(team: string, scope: TeamReadScope): boolean {
    const owner = this.lookup(team, scope);
    if (!owner?.queuedFull) return false;
    owner.queuedFull = false;
    this.prune(team, owner);
    return true;
  }

  hasFresh(team: string): boolean {
    return this.owners.get(team)?.fresh === true;
  }

  hasQueuedFull(team: string): boolean {
    return this.owners.get(team)?.queuedFull === true;
  }

  hasPending(team: string, scope: TeamReadScope): boolean {
    const owner = this.lookup(team, scope, true);
    return (
      owner !== undefined &&
      (owner.active.full !== undefined ||
        owner.refreshes.size > 0 ||
        owner.fresh ||
        owner.queuedFull)
    );
  }

  delete(team: string): void {
    this.owners.delete(team);
  }

  clear(): void {
    this.owners.clear();
  }

  private lookup(
    team: string,
    scope: TeamReadScope,
    retireMismatch = false
  ): TeamDataOwner<T> | undefined {
    const owner = this.owners.get(team);
    if (owner && !sameScope(owner.scope, scope)) {
      if (retireMismatch) this.owners.delete(team);
      return undefined;
    }
    return owner;
  }

  private ensure(team: string, scope: TeamReadScope): TeamDataOwner<T> {
    const existing = this.lookup(team, scope, true);
    if (existing) return existing;
    const owner: TeamDataOwner<T> = {
      scope,
      active: {},
      refreshes: new Set(),
      fresh: false,
      queuedFull: false,
    };
    this.owners.set(team, owner);
    return owner;
  }

  private prune(team: string, owner: TeamDataOwner<T>): void {
    if (
      this.owners.get(team) === owner &&
      owner.active.full === undefined &&
      owner.active.thin === undefined &&
      owner.refreshes.size === 0 &&
      !owner.fresh &&
      !owner.queuedFull
    )
      this.owners.delete(team);
  }
}
