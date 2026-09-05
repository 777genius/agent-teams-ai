import { ANNOUNCEMENTS_CHANNELS } from '@features/announcements/contracts';
import {
  type AnnouncementsFeature,
  type AnnouncementWindowContext,
  createAnnouncementsFeature,
  registerAnnouncementsIpc,
} from '@features/announcements/main';
import { type BrowserWindow, type IpcMainInvokeEvent, powerMonitor } from 'electron';

import { safeSendToRenderer } from './utils/safeWebContentsSend';
import { announcementsSourcePolicy } from './announcementsSourcePolicy';

import type { AnnouncementsProfileProbe } from './announcementsProfileProbe';

interface MainWindowRecord {
  window: BrowserWindow;
  openedAt: string | undefined;
  generation: number;
  documentGeneration: number;
}

/** Created before the first BrowserWindow, attached to services later. */
export class AnnouncementsLifecycle {
  private readonly windows = new Map<number, MainWindowRecord>();
  private feature: AnnouncementsFeature | null = null;
  private firstOpenedAt: string | undefined;
  private removeIpc: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private disposed = false;
  private readonly onSuspend = (): void => {
    void this.feature?.suspend();
  };
  private readonly onResume = (): void => {
    this.feature?.resume();
  };

  registerMainWindow(window: BrowserWindow): void {
    const record: MainWindowRecord = {
      window,
      openedAt: undefined,
      generation: 0,
      documentGeneration: 0,
    };
    this.windows.set(window.id, record);
    const shown = (): void => {
      if (!record.openedAt) {
        record.openedAt = new Date().toISOString();
        this.firstOpenedAt ??= record.openedAt;
        this.feature?.registerWindow(window.id, record.openedAt);
      }
    };
    window.on('show', shown);
    // BrowserWindow defaults to show:true: its initial show precedes registration.
    if (window.isVisible()) shown();
    const invalidateAutoAttempt = (): void => {
      record.generation += 1;
    };
    const invalidateDocument = (): void => {
      invalidateAutoAttempt();
      record.documentGeneration += 1;
      this.feature?.invalidateWindow(window.id);
    };
    window.on('blur', invalidateAutoAttempt);
    window.on('hide', invalidateAutoAttempt);
    window.webContents.on('did-start-loading', invalidateDocument);
    window.on('focus', () => {
      this.feature?.foreground();
    });
    window.once('closed', () => {
      invalidateDocument();
      this.windows.delete(window.id);
      void this.feature?.unregisterWindow(window.id);
    });
  }

  async initialize(options: {
    userDataPath: string;
    profile: AnnouncementsProfileProbe;
    production: boolean;
    isolatedProfile: boolean;
    sourceOverride?: string;
  }): Promise<void> {
    const feature = createAnnouncementsFeature({
      userDataPath: options.userDataPath,
      origin: options.profile.origin,
      production: options.production,
      isolatedProfile: options.isolatedProfile,
      sourceUrl: announcementsSourcePolicy(
        options.production,
        options.isolatedProfile,
        options.sourceOverride
      ),
      firstOpenedAt: this.firstOpenedAt,
    });
    this.feature = feature;
    this.unsubscribe = feature.subscribe((snapshot) => {
      for (const { window } of this.windows.values()) {
        safeSendToRenderer(window, ANNOUNCEMENTS_CHANNELS.stateChanged, snapshot);
      }
    });
    this.removeIpc = registerAnnouncementsIpc(feature, (event) => this.contextFor(event));
    powerMonitor.on('suspend', this.onSuspend);
    powerMonitor.on('resume', this.onResume);
    for (const { window, openedAt } of this.windows.values()) {
      if (openedAt && !window.isDestroyed()) feature.registerWindow(window.id, openedAt);
    }
    await feature.initialize();
  }

  private contextFor(event: IpcMainInvokeEvent): AnnouncementWindowContext | null {
    if (this.disposed || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame)
      return null;
    const record = [...this.windows.values()].find(
      ({ window }) => !window.isDestroyed() && window.webContents === event.sender
    );
    if (!record) return null;
    const generation = record.generation;
    const documentGeneration = record.documentGeneration;
    return {
      windowId: record.window.id,
      uiGeneration: generation,
      documentGeneration,
      isDocumentCurrent: () =>
        !this.disposed &&
        this.windows.get(record.window.id) === record &&
        documentGeneration === record.documentGeneration &&
        !!record.openedAt &&
        !record.window.isDestroyed() &&
        !event.sender.isDestroyed() &&
        !event.sender.isLoadingMainFrame(),
      isReady: () =>
        !this.disposed &&
        this.windows.get(record.window.id) === record &&
        generation === record.generation &&
        !!record.openedAt &&
        !record.window.isDestroyed() &&
        !event.sender.isDestroyed() &&
        !event.sender.isLoadingMainFrame() &&
        record.window.isVisible() &&
        record.window.isFocused(),
    };
  }

  /** Called only by the existing accepted shutdown path; cancelled quit keeps tracking. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.removeIpc?.();
    this.unsubscribe?.();
    powerMonitor.removeListener('suspend', this.onSuspend);
    powerMonitor.removeListener('resume', this.onResume);
    await this.feature?.dispose();
    this.feature = null;
  }
}
