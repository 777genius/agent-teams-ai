/** The feature's original per-Team write serialization; errors remain visible to their caller. */
export class MemberWorkSyncWriteQueue {
  private readonly queues = new Map<string, Promise<void>>();

  async enqueue(teamName: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(teamName) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(teamName, settled);
    void settled.then(() => {
      if (this.queues.get(teamName) === settled) this.queues.delete(teamName);
    });
    await next;
  }
}
