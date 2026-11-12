import type { TeamCommand } from './contracts.js';

export interface NativeSessionCommand {
  name: string;
  raw: string;
}
export interface NativeSessionCommandCapability {
  name: string;
  description: string;
}

/** Same bounded standalone syntax as the existing Composer, without provider assumptions. */
export function parseNativeSessionCommand(text: string): NativeSessionCommand | undefined {
  const raw = text.trim();
  const match = /^\/([a-z][a-z0-9:-]{0,63})(?:\s+([\s\S]*\S))?$/iu.exec(raw);
  return match ? { name: match[1]!, raw } : undefined;
}

/** Old rich-message receipts keep their original wrapped bytes; new raw delivery is explicit. */
export function nativeCommandMessage(command: TeamCommand): NativeSessionCommand | undefined {
  if (command.operation !== 'message.send') return;
  const payload = command.payload;
  return payload.nativeCommand === true ||
    (payload.messageId === undefined &&
      payload.summary === undefined &&
      payload.actionMode === undefined)
    ? parseNativeSessionCommand(payload.text)
    : undefined;
}
