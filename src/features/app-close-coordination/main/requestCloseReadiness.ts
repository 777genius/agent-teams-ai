import type { AppCloseReadinessResult, AppCloseReason } from '../contracts';
import type { RendererCloseReadinessCoordinator } from './RendererCloseReadinessCoordinator';
import type { BrowserWindow, Dialog } from 'electron';

/** Keep timeout warnings live: a completed save must not leave a stale warning onscreen. */
export async function requestCloseReadiness(
  coordinator: RendererCloseReadinessCoordinator,
  windows: readonly BrowserWindow[],
  reason: AppCloseReason,
  unsafeActionLabel: string,
  dialog: Pick<Dialog, 'showMessageBox'>
): Promise<boolean> {
  if (windows.length === 0) return true;
  const latest = new Map<string, AppCloseReadinessResult>();
  const abort = new AbortController();
  let initialResultsReceived = false;
  const allReady = (): boolean =>
    initialResultsReceived && [...latest.values()].every((result) => result.ok);
  const onLateResult = (result: AppCloseReadinessResult): void => {
    latest.set(result.requestId, result);
    if (allReady()) abort.abort();
  };
  const results = await Promise.all(
    windows.map((window) => coordinator.request(window, reason, undefined, onLateResult))
  );
  // A late reply from one window can arrive while another window is still answering.
  for (const result of results) {
    if (!latest.has(result.requestId)) latest.set(result.requestId, result);
  }
  initialResultsReceived = true;
  try {
    if (allReady()) return true;
    const parent = windows.find((window) => !window.isDestroyed());
    if (!parent) return false;
    parent.show();
    parent.focus();
    const failures = [...latest.values()].filter((result) => !result.ok);
    const unresponsive = failures.some((result) => result.failure === 'unresponsive');
    const choice = await dialog.showMessageBox(parent, {
      type: 'warning',
      title: 'Confirm app close',
      message: unresponsive
        ? 'The app interface is not responding.'
        : 'Changes has not confirmed it is ready to close.',
      detail: failures
        .flatMap((result) => result.blockers)
        .slice(0, 10)
        .map((blocker) => `- ${blocker}`)
        .join('\n'),
      buttons: ['Keep Open', unsafeActionLabel],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      signal: abort.signal,
    });
    return allReady() || choice.response === 1;
  } finally {
    for (const result of results) coordinator.release(result.requestId);
  }
}
