/** Compatibility entry; native and Host consumers use the same finite wire codec. */
export type { Frame } from '@agent-teams/legacy-agent-host/owned-process';
export {
  encodeFrame,
  encodeLaunch,
  FrameDecoder,
  generationBytes,
  HEADER_BYTES,
  MAX_CONTROL_BYTES,
  MAX_LAUNCH_BYTES,
  Op,
  VERSION,
} from '@agent-teams/legacy-agent-host/owned-process';
