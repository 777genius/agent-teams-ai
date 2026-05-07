import type {
  MemberLogPreviewItem,
  MemberLogStreamCoverage,
  MemberLogStreamProvider,
  MemberLogStreamWarning,
} from '../../../contracts';
import type { MemberLogPreviewBudget } from '../../domain/models/MemberLogPreviewBudget';

export interface MemberLogPreviewSourceInput {
  teamName: string;
  memberName: string;
  laneId?: string;
  budget: MemberLogPreviewBudget;
  maxItems: number;
  textLimit: number;
  forceRefresh?: boolean;
}

export interface MemberLogPreviewSourceResult {
  provider: MemberLogStreamProvider;
  status: MemberLogStreamCoverage['status'];
  reason?: string;
  items: MemberLogPreviewItem[];
  warnings: MemberLogStreamWarning[];
  truncated: boolean;
  overflowCount: number;
}

export interface MemberLogPreviewSource {
  readonly provider: MemberLogStreamProvider;
  loadPreview(input: MemberLogPreviewSourceInput): Promise<MemberLogPreviewSourceResult>;
}
