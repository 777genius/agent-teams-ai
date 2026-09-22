import * as fs from 'fs';

function isAbortError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'name' in error &&
    typeof (error as { name?: unknown }).name === 'string' &&
    (error as { name: string }).name === 'AbortError'
  );
}

export class FileReadTimeoutError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly timeoutMs: number
  ) {
    super(`Timed out after ${timeoutMs}ms reading ${filePath}`);
    this.name = 'FileReadTimeoutError';
  }
}

export async function readFileUtf8WithTimeout(
  filePath: string,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fs.promises.readFile(filePath, { encoding: 'utf8', signal: controller.signal });
  } catch (error) {
    if (isAbortError(error)) {
      throw new FileReadTimeoutError(filePath, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
