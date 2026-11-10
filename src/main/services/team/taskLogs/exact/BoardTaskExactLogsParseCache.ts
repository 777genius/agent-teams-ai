import { BoardTaskActivityParseCache } from '../activity/BoardTaskActivityParseCache';

import type { ParsedMessage } from '@main/types';

export class BoardTaskExactLogsParseCache {
  private readonly cache = new BoardTaskActivityParseCache<ParsedMessage[]>();

  getIfFresh(filePath: string, mtimeMs: number, size: number): ParsedMessage[] | null {
    return this.cache.getIfFresh(filePath, mtimeMs, size);
  }

  getInFlight(filePath: string): Promise<ParsedMessage[]> | null {
    return this.cache.getInFlight(filePath);
  }

  setInFlight(filePath: string, promise: Promise<ParsedMessage[]>): void {
    this.cache.setInFlight(filePath, promise);
  }

  clearInFlight(filePath: string): void {
    this.cache.clearInFlight(filePath);
  }

  set(filePath: string, mtimeMs: number, size: number, value: ParsedMessage[]): void {
    this.cache.set(filePath, mtimeMs, size, value);
  }

  clearForPath(filePath: string): void {
    this.cache.clearForPath(filePath);
  }

  retainOnly(filePaths: Set<string>): void {
    this.cache.retainOnly(filePaths);
  }
}
