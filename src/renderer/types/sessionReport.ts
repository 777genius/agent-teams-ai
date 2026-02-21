/**
 * Session analysis report types.
 * Output of analyzeSession() — one interface per report section.
 */

// =============================================================================
// Pricing
// =============================================================================

export interface ModelPricing {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

// =============================================================================
// Report Sections
// =============================================================================

export interface ReportOverview {
  sessionId: string;
  projectId: string;
  projectPath: string;
  firstMessage: string;
  messageCount: number;
  hasSubagents: boolean;
  contextConsumption: number;
  contextConsumptionPct: number | null;
  contextAssessment: 'critical' | 'high' | 'moderate' | 'healthy' | null;
  compactionCount: number;
  gitBranch: string;
  startTime: Date | null;
  endTime: Date | null;
  durationSeconds: number;
  durationHuman: string;
  totalMessages: number;
}

export interface ModelTokenStats {
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  costUsd: number;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  grandTotal: number;
  cacheReadPct: number;
}

export interface ReportTokenUsage {
  byModel: Record<string, ModelTokenStats>;
  totals: TokenTotals;
}

export interface ReportCostAnalysis {
  parentCostUsd: number;
  subagentCostUsd: number;
  totalSessionCostUsd: number;
  costByModel: Record<string, number>;
  costPerCommit: number | null;
  costPerLineChanged: number | null;
}

export interface ReportCacheEconomics {
  cacheCreation5m: number;
  cacheCreation1h: number;
  cacheRead: number;
  cacheEfficiencyPct: number;
  coldStartDetected: boolean;
  cacheReadToWriteRatio: number;
}

export interface ToolSuccessRate {
  totalCalls: number;
  errors: number;
  successRatePct: number;
}

export interface ReportToolUsage {
  counts: Record<string, number>;
  totalCalls: number;
  successRates: Record<string, ToolSuccessRate>;
}

export interface SubagentEntry {
  description: string;
  subagentType: string;
  model: string;
  totalTokens: number;
  totalDurationMs: number;
  totalToolUseCount: number;
  costUsd: number;
  costNote?: string;
}

export interface ReportSubagentMetrics {
  count: number;
  totalTokens: number;
  totalDurationMs: number;
  totalToolUseCount: number;
  totalCostUsd: number;
  byAgent: SubagentEntry[];
}

export interface ToolError {
  tool: string;
  inputPreview: string;
  error: string;
  messageIndex: number;
  isPermissionDenial: boolean;
}

export interface ReportErrors {
  errors: ToolError[];
  permissionDenials: {
    count: number;
    denials: ToolError[];
    affectedTools: string[];
  };
}

export interface GitCommit {
  messagePreview: string;
  messageIndex: number;
}

export interface ReportGitActivity {
  commitCount: number;
  commits: GitCommit[];
  pushCount: number;
  branchCreations: string[];
  linesAdded: number;
  linesRemoved: number;
  linesChanged: number;
}

export interface FrictionCorrection {
  messageIndex: number;
  keyword: string;
  preview: string;
}

export interface ReportFrictionSignals {
  correctionCount: number;
  corrections: FrictionCorrection[];
  frictionRate: number;
}

export interface ReportThrashingSignals {
  bashNearDuplicates: { prefix: string; count: number }[];
  editReworkFiles: { filePath: string; editIndices: number[] }[];
}

export interface ReportConversationTree {
  totalNodes: number;
  maxDepth: number;
  sidechainCount: number;
  branchPoints: number;
  branchDetails: {
    parentUuid: string;
    childCount: number;
    parentMessageIndex: number | undefined;
  }[];
}

export interface IdleGap {
  gapSeconds: number;
  gapHuman: string;
  afterMessageIndex: number;
}

export interface ReportIdleAnalysis {
  idleThresholdSeconds: number;
  idleGapCount: number;
  totalIdleSeconds: number;
  totalIdleHuman: string;
  wallClockSeconds: number;
  activeWorkingSeconds: number;
  activeWorkingHuman: string;
  idlePct: number;
  longestGaps: IdleGap[];
}

export interface ModelSwitch {
  from: string;
  to: string;
  messageIndex: number;
  timestamp: Date | null;
}

export interface ReportModelSwitches {
  count: number;
  switches: ModelSwitch[];
  modelsUsed: string[];
}

export interface ReportWorkingDirectories {
  uniqueDirectories: string[];
  directoryCount: number;
  changes: { from: string; to: string; messageIndex: number }[];
  changeCount: number;
  isMultiDirectory: boolean;
}

export interface TestSnapshot {
  messageIndex: number;
  passed: number;
  failed: number;
  total: number;
  raw: string;
}

export interface ReportTestProgression {
  snapshotCount: number;
  snapshots: TestSnapshot[];
  trajectory: 'improving' | 'regressing' | 'stable' | 'insufficient_data';
  firstSnapshot: TestSnapshot | null;
  lastSnapshot: TestSnapshot | null;
}

export interface ReportStartupOverhead {
  messagesBeforeFirstWork: number;
  tokensBeforeFirstWork: number;
  pctOfTotal: number;
}

export interface ReportTokenDensityTimeline {
  quartiles: { q: number; avgTokens: number; messageCount: number }[];
}

export interface ReportPromptQuality {
  firstMessageLengthChars: number;
  userMessageCount: number;
  correctionCount: number;
  frictionRate: number;
  assessment: 'underspecified' | 'verbose_but_unclear' | 'well_specified' | 'moderate_friction';
  note: string;
}

export interface ThinkingBlockAnalysis {
  messageIndex: number;
  preview: string;
  charLength: number;
  signals: Record<string, boolean>;
}

export interface ReportThinkingBlocks {
  count: number;
  analyzedCount: number;
  signalSummary: Record<string, number>;
  notableBlocks: ThinkingBlockAnalysis[];
}

export interface KeyEvent {
  timestamp: Date;
  label: string;
  deltaSeconds?: number;
  deltaHuman?: string;
}

export interface ReportFileReadRedundancy {
  totalReads: number;
  uniqueFiles: number;
  readsPerUniqueFile: number;
  redundantFiles: Record<string, number>;
}

// =============================================================================
// Combined Report
// =============================================================================

export interface SessionReport {
  overview: ReportOverview;
  tokenUsage: ReportTokenUsage;
  costAnalysis: ReportCostAnalysis;
  cacheEconomics: ReportCacheEconomics;
  toolUsage: ReportToolUsage;
  subagentMetrics: ReportSubagentMetrics;
  errors: ReportErrors;
  gitActivity: ReportGitActivity;
  frictionSignals: ReportFrictionSignals;
  thrashingSignals: ReportThrashingSignals;
  conversationTree: ReportConversationTree;
  idleAnalysis: ReportIdleAnalysis;
  modelSwitches: ReportModelSwitches;
  workingDirectories: ReportWorkingDirectories;
  testProgression: ReportTestProgression;
  startupOverhead: ReportStartupOverhead;
  tokenDensityTimeline: ReportTokenDensityTimeline;
  promptQuality: ReportPromptQuality;
  thinkingBlocks: ReportThinkingBlocks;
  keyEvents: KeyEvent[];
  messageTypes: Record<string, number>;
  serviceTiers: Record<string, number>;
  fileReadRedundancy: ReportFileReadRedundancy;
  compactionCount: number;
  gitBranches: string[];
}
