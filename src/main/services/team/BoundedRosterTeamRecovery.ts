const MAX_RECORDS_PER_PASS = 16;
const MAX_PASS_MS = 25;

export class BoundedRosterTeamRecovery {
  private readonly cursorByTeam = new Map<string, string | null>();

  async run(input: {
    teamName: string;
    now(): number;
    withLock<T>(operation: () => Promise<T>): Promise<T>;
    listPage(
      cursor: string | null,
      limit: number
    ): Promise<{ ids: string[]; nextCursor: string | null }>;
    process(id: string): Promise<void>;
    prune(limit: number, shouldYield: () => boolean): Promise<boolean>;
    schedule(): void;
  }): Promise<void> {
    const startedAt = input.now();
    const cursor = this.cursorByTeam.get(input.teamName) ?? null;
    let continuation: string | null = null;
    await input.withLock(async () => {
      const page = await input.listPage(cursor, MAX_RECORDS_PER_PASS);
      let lastProcessed = cursor;
      for (const id of page.ids) {
        if (lastProcessed !== cursor && input.now() - startedAt >= MAX_PASS_MS) {
          continuation = lastProcessed;
          break;
        }
        await input.process(id);
        lastProcessed = id;
      }
      continuation ??= page.nextCursor;
    });
    if (continuation) {
      this.cursorByTeam.set(input.teamName, continuation);
      input.schedule();
      return;
    }
    this.cursorByTeam.delete(input.teamName);
    if (
      !(await input.withLock(() =>
        input.prune(MAX_RECORDS_PER_PASS, () => input.now() - startedAt >= MAX_PASS_MS)
      ))
    )
      input.schedule();
  }
}
