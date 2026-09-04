import {
  ANNOUNCEMENTS_CHANNELS as channels,
  type ClaimAnnouncementInput,
} from '@features/announcements/contracts';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import type {
  AnnouncementsFeature,
  AnnouncementWindowContext,
} from '../../composition/createAnnouncementsFeature';

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
}

function validAssetUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 2048 &&
    ![...value].some((character) => character.charCodeAt(0) <= 32)
  );
}

function validClaim(value: unknown): value is ClaimAnnouncementInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).length === 3 &&
    validId(input.id) &&
    typeof input.revision === 'string' &&
    /^[a-f0-9]{64}$/.test(input.revision) &&
    typeof input.bodySha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(input.bodySha256)
  );
}

/** Every request must originate from the main frame of a registered app window. */
export function registerAnnouncementsIpc(
  feature: AnnouncementsFeature,
  contextFor: (event: IpcMainInvokeEvent) => AnnouncementWindowContext | null
): () => void {
  const registered: string[] = [];
  const handle = (
    channel: string,
    arity: number,
    invoke: (context: AnnouncementWindowContext, arg: unknown) => unknown
  ): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const context = contextFor(event);
      if (!context || args.length !== arity) throw new Error('Invalid announcement request');
      return invoke(context, args[0]);
    });
    registered.push(channel);
  };
  handle(channels.getSnapshot, 0, () => feature.getSnapshot());
  handle(channels.refresh, 0, () => feature.refresh());
  handle(channels.prepareAuto, 0, (context) => feature.prepareAuto(context));
  handle(channels.claimAuto, 1, (context, input) => {
    if (!validClaim(input)) throw new Error('Invalid announcement request');
    return feature.claimAuto(input, context);
  });
  handle(channels.openManual, 1, (_context, id) => {
    if (!validId(id)) throw new Error('Invalid announcement request');
    return feature.openManual(id);
  });
  handle(channels.loadAsset, 1, (_context, url) => {
    if (!validAssetUrl(url)) throw new Error('Invalid announcement request');
    return feature.loadAsset(url);
  });
  handle(channels.dismiss, 1, (_context, id) => {
    if (!validId(id)) throw new Error('Invalid announcement request');
    return feature.dismiss(id);
  });
  return () => {
    for (const channel of registered) ipcMain.removeHandler(channel);
  };
}
