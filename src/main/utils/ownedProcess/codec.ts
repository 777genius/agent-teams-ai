/** Compatibility entry; native and Host consumers use the same finite wire codec. */
export {
  HEADER_BYTES, MAX_LAUNCH_BYTES, MAX_CONTROL_BYTES, VERSION, Op, generationBytes,
  encodeFrame, FrameDecoder, encodeLaunch,
} from '@agent-teams/legacy-agent-host/owned-process';
export type { Frame } from '@agent-teams/legacy-agent-host/owned-process';
