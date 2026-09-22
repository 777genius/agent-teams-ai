import type {
  MemberLogStreamCoverage,
  MemberLogStreamProvider,
  MemberLogStreamSegment,
  MemberLogStreamWarning,
} from '../../../contracts';
import type { MemberLogStreamBudget } from '../../domain/models/MemberLogStreamBudget';
import type { BoardTaskLogParticipant } from '@shared/types';

export interface MemberLogStreamSourceInput {
  teamName: string;
  memberName: string;
  laneId?: string;
  budget: MemberLogStreamBudget;
  sinceMs?: number | null;
  forceRefresh?: boolean;
}

export interface MemberLogStreamSourceMetadata {
  scannedTranscriptFileCount?: number;
  includedTranscriptFileCount?: number;
  droppedSegmentCount?: number;
  droppedChunkCount?: number;
  droppedMessageCount?: number;
}

export interface MemberLogStreamSourceResult {
  provider: MemberLogStreamProvider;
  status: MemberLogStreamCoverage['status'];
  reason?: string;
  participants: BoardTaskLogParticipant[];
  segments: MemberLogStreamSegment[];
  warnings: MemberLogStreamWarning[];
  metadata?: MemberLogStreamSourceMetadata;
}

export interface MemberLogStreamSource {
  readonly provider: MemberLogStreamProvider;
  load(input: MemberLogStreamSourceInput): Promise<MemberLogStreamSourceResult>;
}
