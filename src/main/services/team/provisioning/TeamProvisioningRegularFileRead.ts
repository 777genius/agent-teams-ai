import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import * as fs from 'fs';

export interface TeamProvisioningRegularFileReadOptions {
  timeoutMs: number;
  maxBytes: number;
}

export async function tryReadRegularFileUtf8(
  filePath: string,
  opts: TeamProvisioningRegularFileReadOptions
): Promise<string | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return null;
  }

  if (!stat.isFile() || stat.size > opts.maxBytes) {
    return null;
  }

  try {
    return await readFileUtf8WithTimeout(filePath, opts.timeoutMs);
  } catch (error) {
    if (error instanceof FileReadTimeoutError) {
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }
}
