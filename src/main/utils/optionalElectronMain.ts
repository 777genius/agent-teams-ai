/** Identify the runtime before loading the npm Electron entry, which can provision a binary. */
export function isElectronMainProcess(): boolean {
  return Boolean(process.versions.electron) && process.type === 'browser';
}

/** Main APIs remain optional for standalone Node and Electron's run-as-Node mode. */
export function getOptionalElectronMain(): typeof import('electron') | null {
  if (!isElectronMainProcess()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load Main APIs only after identifying the runtime.
    return require('electron') as typeof import('electron');
  } catch {
    return null;
  }
}
