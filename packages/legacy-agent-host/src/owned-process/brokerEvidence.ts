import type { Frame } from './codec.js';
import type { Creation, NativeExitCategory } from './contract.js';

export const nativeExitCategories: readonly NativeExitCategory[] = [
  'owner-eof',
  'bootstrap',
  'read',
  'write',
  'write-deadline',
  'protocol',
  'cancel-undrained',
  'pending-read-barrier',
];
const creations: readonly Creation[] = [
  'known-not-created',
  'contained-suspended',
  'running',
  'uncertain',
];
export interface StopFacts {
  creation: Creation;
  rootExited: boolean;
  active: number;
  dispatchError: number;
  queryError: number;
  payload: Buffer;
}
export function facts(frame: Frame): StopFacts {
  if (frame.payload.length !== 26 || frame.payload.readUInt8(1) > 1) {
    throw new Error('Invalid Stop evidence');
  }
  return {
    creation: creationFromByte(frame.payload.readUInt8(0)),
    rootExited: frame.payload.readUInt8(1) === 1,
    active: frame.payload.readUInt32LE(2),
    dispatchError: frame.payload.readUInt32LE(18),
    queryError: frame.payload.readUInt32LE(22),
    payload: frame.payload,
  };
}
export function creationFromByte(value: number): Creation {
  const creation = creations[value];
  if (creation === undefined) throw new Error('Invalid creation fact');
  return creation;
}
