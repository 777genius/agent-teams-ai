import {
  type AnnouncementDocument,
  ANNOUNCEMENTS_CHANNELS as channels,
  type AnnouncementsApi,
  type AnnouncementsSnapshot,
  type ClaimAnnouncementInput,
  type PreparedAnnouncement,
} from '@features/announcements/contracts';

export interface AnnouncementsBridgeTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  subscribe(
    channel: string,
    listener: (snapshot: AnnouncementsSnapshot) => void
  ): () => void;
}

const invoke = <Result,>(
  transport: AnnouncementsBridgeTransport,
  channel: string,
  ...args: unknown[]
): Promise<Result> => transport.invoke(channel, ...args) as Promise<Result>;

export function createAnnouncementsBridge(
  transport: AnnouncementsBridgeTransport
): AnnouncementsApi {
  return {
    getSnapshot: () => invoke<AnnouncementsSnapshot>(transport, channels.getSnapshot),
    refresh: () => invoke<AnnouncementsSnapshot>(transport, channels.refresh),
    prepareAuto: () => invoke<PreparedAnnouncement | null>(transport, channels.prepareAuto),
    claimAuto: (input: ClaimAnnouncementInput) =>
      invoke<AnnouncementDocument | null>(transport, channels.claimAuto, input),
    openManual: (id) =>
      invoke<AnnouncementDocument | null>(transport, channels.openManual, id),
    loadCover: (id, requestId) =>
      invoke<string | null>(transport, channels.loadCover, id, requestId),
    cancelCover: (requestId) => invoke<void>(transport, channels.cancelCover, requestId),
    loadAsset: (url, requestId) =>
      invoke<string | null>(transport, channels.loadAsset, url, requestId),
    cancelAsset: (requestId) => invoke<void>(transport, channels.cancelAsset, requestId),
    dismiss: (id) => invoke<{ saved: boolean }>(transport, channels.dismiss, id),
    onStateChanged: (listener) => transport.subscribe(channels.stateChanged, listener),
  };
}
