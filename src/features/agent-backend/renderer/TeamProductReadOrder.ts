import type { BackendTeamPosition } from '../contracts/teamChanges';
import type { BackendTeamSnapshot } from '../contracts/teamSnapshot';

interface Current {
  position: BackendTeamPosition;
  retired: Set<string>;
  snapshot?: { sequence: number; revision: string };
}
/** Metadata only: no second product cache. All state stays in the ordinary UI stores. */
export class TeamProductReadOrder {
  private readonly resources = new Map<string, Current>();
  private readonly writes = new Map<string, number>();
  private readonly launchReads = new Map<string, symbol>();
  private scope: (() => boolean) | undefined;

  capture(scope: () => boolean): void {
    if (!scope()) throw new Error('Team context changed');
    if (this.scope && !this.scope()) {
      this.resources.clear();
      this.writes.clear();
      this.launchReads.clear();
    }
    this.scope = scope;
  }

  invalidateReads(handleId: string): void {
    this.writes.set(handleId, (this.writes.get(handleId) ?? 0) + 1);
  }

  readFence(handleId: string): () => void {
    const epoch = this.writes.get(handleId) ?? 0;
    return () => {
      if ((this.writes.get(handleId) ?? 0) !== epoch)
        throw new Error('Host read crossed a mutation boundary');
    };
  }

  /** Direct status reads and the shared observer cannot publish out of order. */
  launchReadFence(handleId: string): () => void {
    const token = Symbol();
    this.launchReads.set(handleId, token);
    const noMutation = this.readFence(handleId);
    return () => {
      noMutation();
      if (this.launchReads.get(handleId) !== token) throw new Error('Stale Host launch read');
    };
  }

  position(handleId: string): BackendTeamPosition | undefined {
    const position = this.resources.get(handleId)?.position;
    return position ? { ...position } : undefined;
  }

  private advance(handleId: string, position: BackendTeamPosition): Current | undefined {
    const previous = this.resources.get(handleId);
    if (previous?.retired.has(position.streamId)) return undefined;
    if (
      previous?.position.streamId === position.streamId &&
      position.sequence < previous.position.sequence
    )
      return undefined;
    if (previous && previous.position.streamId !== position.streamId) {
      previous.retired.add(previous.position.streamId);
      const current: Current = { position: { ...position }, retired: previous.retired };
      this.resources.set(handleId, current);
      return current;
    }
    const current = previous ?? { position: { ...position }, retired: new Set<string>() };
    current.position = { ...position };
    this.resources.set(handleId, current);
    return current;
  }

  observeFeed(handleId: string, position: BackendTeamPosition): boolean {
    return this.advance(handleId, position) !== undefined;
  }

  acceptSnapshot(handleId: string, snapshot: BackendTeamSnapshot): void {
    const previous = this.resources.get(handleId);
    if (
      previous?.position.streamId === snapshot.feed.streamId &&
      previous.snapshot?.sequence === snapshot.feed.sequence &&
      previous.snapshot.revision !== snapshot.revision
    )
      throw new Error('Inconsistent Host product snapshot');
    const current = this.advance(handleId, snapshot.feed);
    if (!current) throw new Error('Stale Host product snapshot');
    current.snapshot = { sequence: snapshot.feed.sequence, revision: snapshot.revision };
  }

  assertCurrent(handleId: string, position: BackendTeamPosition): void {
    const current = this.resources.get(handleId);
    if (
      !current ||
      current.position.streamId !== position.streamId ||
      current.position.sequence !== position.sequence
    )
      throw new Error('Stale Host product snapshot');
  }
}
