import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, expect, it, vi } from 'vitest';

import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';
import {
  buildOpenCodeScenarioTeamRequest,
  loadOpenCodeSemanticScenario,
  materializeOpenCodeScenarioProject,
  materializeOpenCodeScenarioTasks,
  parseOpenCodeE2EModelList,
  taskRefForScenario,
  type OpenCodeSemanticScenario,
} from './openCodeSemanticScenarioHarness';
import {
  createOpenCodeLiveHarness,
  getRuntimeTranscript,
  readInboxMessages,
  waitForMemberInboxMessage,
  waitForOpenCodeLanesStopped,
  waitForOpenCodeMemberIdle,
  waitForOpenCodePeerRelay,
  waitForUserInboxReply,
  type InboxMessage,
} from './openCodeLiveTestHarness';

import type {
  AgentActionMode,
  TaskRef,
  TeamProvisioningProgress,
} from '../../../../src/shared/types';

const liveDescribe =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET === '1'
    ? describe
    : describe.skip;

interface GauntletReport {
  generatedAt: string;
  runsPerModel: number;
  qualification: {
    minimumAverageScore: number;
    minimumSuccessfulRuns: number;
    minimumConsistencyScore: number;
    requireNoHardFailures: boolean;
  };
  models: ModelGauntletResult[];
}

interface ModelGauntletResult {
  model: string;
  verdict: ModelGauntletVerdict;
  confidence: ModelGauntletConfidence;
  qualified: boolean;
  readinessScore: number;
  consistencyScore: number;
  averageScore: number;
  behavioralAverageScore: number | null;
  minScore: number;
  successfulRuns: number;
  countedRuns: number;
  hardFailures: number;
  providerInfraFailures: number;
  runtimeTransportFailures: number;
  modelBehaviorFailures: number;
  harnessFailures: number;
  p50DurationMs: number;
  p95DurationMs: number;
  stagePassRates: Record<GauntletStageName, RatioSummary>;
  taskRefPassRates: Record<string, RatioSummary>;
  protocolViolationTotals: ProtocolViolationTotals;
  stageFailureImpact: StageFailureImpactSummary[];
  scoreStability: ScoreStabilitySummary;
  dominantFailureCategory: RunFailureCategory | 'mixed';
  recommendationBlockers: string[];
  runs: RunGauntletResult[];
}

interface RatioSummary {
  passed: number;
  total: number;
  rate: number | null;
}

interface ProtocolViolationTotals {
  badMessages: number;
  duplicateOrMissingTokens: number;
  affectedRuns: number;
}

interface StageFailureImpactSummary {
  stage: GauntletStageName;
  failedRuns: number;
  weightedLoss: number;
  passRate: RatioSummary;
}

interface ScoreStabilitySummary {
  sampleSize: number;
  minScore: number;
  maxScore: number;
  spread: number;
  standardDeviation: number;
  consistencyScore: number;
}

type ModelGauntletVerdict =
  | 'recommended'
  | 'strong-candidate'
  | 'tested-only'
  | 'infra-blocked'
  | 'inconclusive';

type ModelGauntletConfidence = 'high' | 'medium' | 'low' | 'blocked';

type RunFailureCategory =
  | 'none'
  | 'model-behavior'
  | 'runtime-transport'
  | 'provider-infra'
  | 'harness-error';

type RunOutcome =
  | 'passed'
  | 'behavioral-fail'
  | 'runtime-transport-fail'
  | 'provider-infra-blocked'
  | 'harness-error';

interface RunGauntletResult {
  runIndex: number;
  passed: boolean;
  score: number;
  countedForRecommendation: boolean;
  outcome: RunOutcome;
  failureCategory: RunFailureCategory;
  primaryFailure: string | null;
  durationMs: number;
  hardFailure: boolean;
  stageDurationsMs: Record<string, number>;
  stageFailures: Record<string, string>;
  taskRefChecks: Record<string, boolean | null>;
  protocolViolations: {
    badMessages: number;
    duplicateOrMissingTokens: string[];
  };
  stages: {
    launchBootstrap: boolean;
    directReply: boolean;
    peerRelayAB: boolean;
    peerRelayBC: boolean;
    concurrentReplies: boolean;
    taskRefs: boolean;
    cleanTranscript: boolean;
    noDuplicateTokens: boolean;
    latencyStable: boolean;
  };
  diagnostics: string[];
}

interface DeliveryExpectation {
  memberName: string;
  messageId: string;
  replyRecipient: string;
  actionMode: AgentActionMode;
  taskIndex: number;
  text: string;
  expectedReplyToken: string;
}

interface PeerExpectation {
  senderName: string;
  recipientName: string;
  messageId: string;
  taskIndex: number;
  peerToken: string;
  expectedReplyToken: string;
  text: string;
}

type GauntletStageName = keyof RunGauntletResult['stages'];

const SCORE_WEIGHTS: Record<keyof RunGauntletResult['stages'], number> = {
  launchBootstrap: 15,
  directReply: 10,
  peerRelayAB: 15,
  peerRelayBC: 15,
  concurrentReplies: 15,
  taskRefs: 10,
  cleanTranscript: 10,
  noDuplicateTokens: 5,
  latencyStable: 5,
};

const GAUNTLET_STAGE_NAMES = Object.keys(SCORE_WEIGHTS) as GauntletStageName[];

const TASK_REF_CHECK_NAMES = [
  'directReply',
  'peerRelayAB',
  'peerRelayBC',
  'concurrentBob',
  'concurrentTom',
] as const;

liveDescribe('OpenCode semantic model gauntlet live e2e', () => {
  it(
    'stress-tests selected OpenCode models and writes a markdown scorecard',
    async () => {
      const scenario = buildGauntletScenario(await loadOpenCodeSemanticScenario());
      const models = parseOpenCodeE2EModelList();
      const runsPerModel = parsePositiveInteger(process.env.OPENCODE_E2E_GAUNTLET_RUNS, 3);
      const minimumAverageScore = parsePositiveInteger(
        process.env.OPENCODE_E2E_GAUNTLET_MIN_AVERAGE_SCORE,
        90
      );
      const minimumSuccessfulRuns = parsePositiveInteger(
        process.env.OPENCODE_E2E_GAUNTLET_MIN_SUCCESSFUL_RUNS,
        Math.max(3, runsPerModel)
      );
      const minimumConsistencyScore = parsePositiveInteger(
        process.env.OPENCODE_E2E_GAUNTLET_MIN_CONSISTENCY_SCORE,
        85
      );
      const report: GauntletReport = {
        generatedAt: new Date().toISOString(),
        runsPerModel,
        qualification: {
          minimumAverageScore,
          minimumSuccessfulRuns,
          minimumConsistencyScore,
          requireNoHardFailures: true,
        },
        models: [],
      };

      for (const model of models) {
        report.models.push(
          await runModelGauntlet({
            scenario,
            model,
            runsPerModel,
            minimumAverageScore,
            minimumSuccessfulRuns,
            minimumConsistencyScore,
          })
        );
        await writeGauntletReport(report);
      }

      await writeGauntletReport(report);
      clearExpectedOpenCodeGauntletConsoleNoise();

      if (process.env.OPENCODE_E2E_GAUNTLET_REQUIRE_RECOMMENDED === '1') {
        const notQualified = report.models.filter((model) => !model.qualified);
        expect(notQualified, JSON.stringify(report, null, 2)).toEqual([]);
      } else {
        expect(report.models.length).toBeGreaterThan(0);
      }
    },
    Math.max(
      900_000,
      parseOpenCodeE2EModelList().length *
        parsePositiveInteger(process.env.OPENCODE_E2E_GAUNTLET_RUNS, 3) *
        600_000
    )
  );
});

describe('OpenCode semantic model gauntlet report helpers', () => {
  it('separates provider infrastructure failures from model behavior', () => {
    const stages = createPassingStages({ launchBootstrap: false });
    const diagnostics = ['openrouter/google/gemini-3.1-pro-preview: key total limit exceeded'];
    const category = classifyGauntletFailure({ diagnostics, stages });

    expect(category).toBe('provider-infra');
    expect(isCountedForRecommendation(category)).toBe(false);
    expect(getRunOutcome(category)).toBe('provider-infra-blocked');
  });

  it('does not promote a single perfect run to Recommended', () => {
    const qualified = isModelQualified({
      averageScore: 100,
      successfulRuns: 1,
      minimumAverageScore: 90,
      minimumSuccessfulRuns: 3,
      minimumConsistencyScore: 85,
      hardFailures: 0,
      providerInfraFailures: 0,
      harnessFailures: 0,
      consistencyScore: 100,
    });
    const verdict = getModelGauntletVerdict({
      qualified,
      behavioralAverageScore: 100,
      successfulRuns: 1,
      countedRuns: 1,
      totalRuns: 1,
      providerInfraFailures: 0,
      runtimeTransportFailures: 0,
      modelBehaviorFailures: 0,
      harnessFailures: 0,
    });
    const confidence = getModelGauntletConfidence({
      countedRuns: 1,
      providerInfraFailures: 0,
      harnessFailures: 0,
    });

    expect(qualified).toBe(false);
    expect(verdict).toBe('strong-candidate');
    expect(confidence).toBe('low');
  });

  it('does not mark failed high-score runs as strong candidates', () => {
    const verdict = getModelGauntletVerdict({
      qualified: false,
      behavioralAverageScore: 85,
      successfulRuns: 0,
      countedRuns: 1,
      totalRuns: 1,
      providerInfraFailures: 0,
      runtimeTransportFailures: 0,
      modelBehaviorFailures: 1,
      harnessFailures: 0,
    });

    expect(verdict).toBe('tested-only');
  });

  it('renders weakest stages, taskRef rates, and protocol totals', () => {
    const run = createTestGauntletRun({
      stages: createPassingStages({
        peerRelayAB: false,
        taskRefs: false,
      }),
      taskRefChecks: {
        directReply: true,
        peerRelayAB: false,
        peerRelayBC: true,
        concurrentBob: true,
        concurrentTom: null,
      },
      protocolViolations: {
        badMessages: 1,
        duplicateOrMissingTokens: ['GAUNTLET_JACK_USER_OK_1'],
      },
      primaryFailure: 'peer relay timed out',
    });
    const markdown = renderGauntletMarkdown({
      generatedAt: '2026-04-26T00:00:00.000Z',
      runsPerModel: 1,
      qualification: {
        minimumAverageScore: 90,
        minimumSuccessfulRuns: 3,
        minimumConsistencyScore: 85,
        requireNoHardFailures: true,
      },
      models: [createTestGauntletModel({ runs: [run] })],
    });

    expect(markdown).toContain('Weakest Stage');
    expect(markdown).toContain('Weakest TaskRef');
    expect(markdown).toContain('Provider-infra runs are reported separately');
    expect(markdown).toContain('Scoring weights: launchBootstrap=15');
    expect(markdown).toContain('Readiness score:');
    expect(markdown).toContain('Recommendation blockers:');
    expect(markdown).toContain('Weighted stage impact:');
    expect(markdown).toContain('Stage pass rates:');
    expect(markdown).toContain('TaskRef pass rates:');
    expect(markdown).toContain('peerRelayAB 0/1 (0%)');
    expect(markdown).toContain('Protocol totals: badMessages=1');
  });

  it('ranks failure impact by lost weighted score instead of raw failure count only', () => {
    const model = createTestGauntletModel({
      runs: [
        createTestGauntletRun({
          stages: createPassingStages({
            peerRelayAB: false,
            noDuplicateTokens: false,
          }),
        }),
        createTestGauntletRun({
          stages: createPassingStages({
            noDuplicateTokens: false,
          }),
        }),
      ],
    });

    expect(model.stageFailureImpact[0]).toMatchObject({
      stage: 'peerRelayAB',
      failedRuns: 1,
      weightedLoss: 15,
    });
    expect(model.stageFailureImpact[1]).toMatchObject({
      stage: 'noDuplicateTokens',
      failedRuns: 2,
      weightedLoss: 10,
    });
    expect(model.recommendationBlockers).toContain('highest weighted stage loss peerRelayAB=15');
  });

  it('keeps infra-only runs out of readiness ranking', () => {
    const model = createTestGauntletModel({
      runs: [
        createTestGauntletRun({
          failureCategory: 'provider-infra',
          countedForRecommendation: false,
          outcome: 'provider-infra-blocked',
          hardFailure: false,
          passed: false,
          stages: createPassingStages({ launchBootstrap: false }),
          diagnostics: ['OpenRouter key total limit exceeded'],
        }),
      ],
    });

    expect(model.verdict).toBe('infra-blocked');
    expect(model.confidence).toBe('blocked');
    expect(model.readinessScore).toBe(0);
    expect(model.recommendationBlockers).toContain('provider-infra failures 1');
  });

  it('blocks recommendation when repeated runs are too inconsistent', () => {
    const perfectRun = createTestGauntletRun({
      runIndex: 1,
      stages: createPassingStages(),
      score: 100,
      failureCategory: 'none',
      passed: true,
      hardFailure: false,
    });
    const unstableButNonHardRun = createTestGauntletRun({
      runIndex: 2,
      stages: createPassingStages({
        latencyStable: false,
      }),
      score: 80,
      failureCategory: 'none',
      passed: true,
      hardFailure: false,
    });
    const model = createTestGauntletModel({
      runs: [perfectRun, perfectRun, unstableButNonHardRun],
    });

    expect(model.successfulRuns).toBe(3);
    expect(model.averageScore).toBeGreaterThanOrEqual(90);
    expect(model.qualified).toBe(false);
    expect(model.consistencyScore).toBeLessThan(85);
    expect(model.recommendationBlockers).toContain(
      `consistency score ${model.consistencyScore} < 85`
    );
  });
});

function clearExpectedOpenCodeGauntletConsoleNoise(): void {
  const warn = vi.mocked(console.warn);
  const expectedWarning =
    'OpenCode prompt delivery watchdog job failed: OpenCode prompt delivery record not found';
  if (warn.mock) {
    removeMatchingMockCalls(warn.mock.calls, [expectedWarning, 'OpenCode inbox relay failed']);
  }

  const error = vi.mocked(console.error);
  if (error.mock) {
    removeMatchingMockCalls(error.mock.calls, [
      'Rejected runtime evidence without current run: delivery_call',
      'Rejected runtime evidence without current run: heartbeat',
      'Rejected stale runtime evidence: bootstrap_checkin',
    ]);
  }
}

function removeMatchingMockCalls(calls: unknown[][], expectedSubstrings: string[]): void {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const rendered = calls[index]?.map((arg) => String(arg)).join(' ') ?? '';
    if (expectedSubstrings.some((substring) => rendered.includes(substring))) {
      calls.splice(index, 1);
    }
  }
}

async function runModelGauntlet(input: {
  scenario: OpenCodeSemanticScenario;
  model: string;
  runsPerModel: number;
  minimumAverageScore: number;
  minimumSuccessfulRuns: number;
  minimumConsistencyScore: number;
}): Promise<ModelGauntletResult> {
  const runs: RunGauntletResult[] = [];
  for (let runIndex = 1; runIndex <= input.runsPerModel; runIndex += 1) {
    runs.push(
      await runGauntletOnce({
        scenario: input.scenario,
        model: input.model,
        runIndex,
      })
    );
  }

  const scores = runs.map((run) => run.score);
  const countedRuns = runs.filter((run) => run.countedForRecommendation);
  const countedScores = countedRuns.map((run) => run.score);
  const scoreStability = summarizeScoreStability(countedScores);
  const durations = runs.map((run) => run.durationMs).sort((left, right) => left - right);
  const averageScore = round(
    scores.reduce((sum, score) => sum + score, 0) / Math.max(scores.length, 1),
    1
  );
  const behavioralAverageScore =
    countedScores.length > 0
      ? round(
          countedScores.reduce((sum, score) => sum + score, 0) / Math.max(countedScores.length, 1),
          1
        )
      : null;
  const hardFailures = runs.filter((run) => run.hardFailure).length;
  const successfulRuns = runs.filter((run) => run.passed).length;
  const stagePassRates = summarizeStagePassRates(runs);
  const taskRefPassRates = summarizeTaskRefPassRates(runs);
  const protocolViolationTotals = summarizeProtocolViolations(runs);
  const stageFailureImpact = summarizeStageFailureImpact(runs, stagePassRates);
  const providerInfraFailures = runs.filter(
    (run) => run.failureCategory === 'provider-infra'
  ).length;
  const runtimeTransportFailures = runs.filter(
    (run) => run.failureCategory === 'runtime-transport'
  ).length;
  const modelBehaviorFailures = runs.filter(
    (run) => run.failureCategory === 'model-behavior'
  ).length;
  const harnessFailures = runs.filter((run) => run.failureCategory === 'harness-error').length;
  const qualified = isModelQualified({
    averageScore,
    successfulRuns,
    minimumAverageScore: input.minimumAverageScore,
    minimumSuccessfulRuns: input.minimumSuccessfulRuns,
    minimumConsistencyScore: input.minimumConsistencyScore,
    hardFailures,
    providerInfraFailures,
    harnessFailures,
    consistencyScore: scoreStability.consistencyScore,
  });
  const dominantFailureCategory = getDominantFailureCategory(runs);
  const recommendationBlockers = buildRecommendationBlockers({
    qualified,
    averageScore,
    behavioralAverageScore,
    successfulRuns,
    minimumAverageScore: input.minimumAverageScore,
    minimumSuccessfulRuns: input.minimumSuccessfulRuns,
    minimumConsistencyScore: input.minimumConsistencyScore,
    hardFailures,
    providerInfraFailures,
    runtimeTransportFailures,
    modelBehaviorFailures,
    harnessFailures,
    stageFailureImpact,
    taskRefPassRates,
    protocolViolationTotals,
  });
  return {
    model: input.model,
    verdict: getModelGauntletVerdict({
      qualified,
      behavioralAverageScore,
      successfulRuns,
      countedRuns: countedRuns.length,
      totalRuns: runs.length,
      providerInfraFailures,
      runtimeTransportFailures,
      modelBehaviorFailures,
      harnessFailures,
    }),
    confidence: getModelGauntletConfidence({
      countedRuns: countedRuns.length,
      providerInfraFailures,
      harnessFailures,
    }),
    qualified,
    readinessScore: calculateReadinessScore({
      behavioralAverageScore,
      successfulRuns,
      countedRuns: countedRuns.length,
      providerInfraFailures,
      totalRuns: runs.length,
      taskRefPassRates,
      protocolViolationTotals,
      consistencyScore: scoreStability.consistencyScore,
    }),
    averageScore,
    consistencyScore: scoreStability.consistencyScore,
    behavioralAverageScore,
    minScore: scores.length > 0 ? Math.min(...scores) : 0,
    successfulRuns,
    countedRuns: countedRuns.length,
    hardFailures,
    providerInfraFailures,
    runtimeTransportFailures,
    modelBehaviorFailures,
    harnessFailures,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    stagePassRates,
    taskRefPassRates,
    protocolViolationTotals,
    stageFailureImpact,
    scoreStability,
    dominantFailureCategory,
    recommendationBlockers,
    runs,
  };
}

async function runGauntletOnce(input: {
  scenario: OpenCodeSemanticScenario;
  model: string;
  runIndex: number;
}): Promise<RunGauntletResult> {
  const startedAt = Date.now();
  const stages: RunGauntletResult['stages'] = {
    launchBootstrap: false,
    directReply: false,
    peerRelayAB: false,
    peerRelayBC: false,
    concurrentReplies: false,
    taskRefs: false,
    cleanTranscript: false,
    noDuplicateTokens: false,
    latencyStable: false,
  };
  const stageDurationsMs: Record<string, number> = {};
  const stageFailures: Record<string, string> = {};
  const taskRefChecks: Record<string, boolean | null> = {
    directReply: null,
    peerRelayAB: null,
    peerRelayBC: null,
    concurrentBob: null,
    concurrentTom: null,
  };
  let protocolViolations: RunGauntletResult['protocolViolations'] = {
    badMessages: 0,
    duplicateOrMissingTokens: [],
  };
  const diagnostics: string[] = [];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-semantic-gauntlet-'));
  const tempClaudeRoot = path.join(tempDir, '.claude');
  const projectPath = path.join(tempDir, 'project');
  const teamName = `${input.scenario.teamNamePrefix}-gauntlet-${sanitizeModelForTeamName(
    input.model
  )}-${Date.now()}-${input.runIndex}`;
  let harness: Awaited<ReturnType<typeof createOpenCodeLiveHarness>> | null = null;
  let keepTempDir = false;
  const measure = async <T>(stageName: string, run: () => Promise<T>): Promise<T> => {
    const stageStartedAt = Date.now();
    try {
      return await run();
    } catch (error) {
      const message = getGauntletErrorMessage(error);
      stageFailures[stageName] = message;
      diagnostics.push(`${stageName}: ${message}`);
      throw error;
    } finally {
      stageDurationsMs[stageName] =
        (stageDurationsMs[stageName] ?? 0) + Date.now() - stageStartedAt;
    }
  };

  try {
    await measure('setup', async () => {
      await fs.mkdir(tempClaudeRoot, { recursive: true });
      await fs.mkdir(projectPath, { recursive: true });
      setClaudeBasePathOverride(tempClaudeRoot);
      await materializeOpenCodeScenarioProject(input.scenario, projectPath);
      harness = await createOpenCodeLiveHarness({
        tempDir,
        selectedModel: input.model,
        projectPath,
      });
    });

    const progressEvents: TeamProvisioningProgress[] = [];
    const createStartedAt = Date.now();
    const { runId } = await measure('launchBootstrap', async () =>
      harness!.svc.createTeam(
        buildOpenCodeScenarioTeamRequest({
          scenario: input.scenario,
          teamName,
          projectPath,
          model: harness!.selectedModel,
        }),
        (progress) => progressEvents.push(progress)
      )
    );
    diagnostics.push(`runId=${runId}`);
    await measure('materializeTasks', async () =>
      materializeOpenCodeScenarioTasks({ scenario: input.scenario, teamName, projectPath })
    );
    assertLaunchReady(progressEvents);
    stages.launchBootstrap = true;

    const direct = await measure('directReply', async () =>
      sendDirectAndWait({
        scenario: input.scenario,
        harness: harness!,
        teamName,
        projectPath,
        runIndex: input.runIndex,
        expectation: {
          memberName: 'bob',
          messageId: `gauntlet-direct-${input.runIndex}-${Date.now()}`,
          replyRecipient: 'user',
          actionMode: 'ask',
          taskIndex: 0,
          expectedReplyToken: `GAUNTLET_DIRECT_BOB_OK_${input.runIndex}`,
          text: [
            `Investigate task #${input.scenario.tasks[0].displayId} under realistic context pressure.`,
            `Reply to the app user with GAUNTLET_DIRECT_BOB_OK_${input.runIndex}.`,
            'Use agent-teams_message_send to user, preserve taskRefs, and do not use SendMessage.',
          ].join('\n'),
        },
      })
    );
    stages.directReply = direct.replyOk;
    stages.taskRefs = direct.taskRefsOk;
    taskRefChecks.directReply = direct.taskRefsOk;
    await waitForOpenCodeMemberIdle({
      bridgeClient: harness!.bridgeClient,
      teamName,
      memberName: 'bob',
      projectPath,
      timeoutMs: 90_000,
    });

    const peerAB = await measure('peerRelayAB', async () =>
      sendPeerAndWait({
        scenario: input.scenario,
        harness: harness!,
        teamName,
        projectPath,
        runIndex: input.runIndex,
        expectation: {
          senderName: 'bob',
          recipientName: 'jack',
          messageId: `gauntlet-peer-ab-${input.runIndex}-${Date.now()}`,
          taskIndex: 1,
          peerToken: `GAUNTLET_PEER_BOB_TO_JACK_OK_${input.runIndex}`,
          expectedReplyToken: `GAUNTLET_JACK_USER_OK_${input.runIndex}`,
          text: [
            `Send one team message to jack about task #${input.scenario.tasks[1].displayId}.`,
            `The teammate message must include GAUNTLET_PEER_BOB_TO_JACK_OK_${input.runIndex}.`,
            `Ask jack to reply to the app user with GAUNTLET_JACK_USER_OK_${input.runIndex}.`,
            'Use agent-teams_message_send to jack, not a plain assistant answer.',
          ].join('\n'),
        },
      })
    );
    stages.peerRelayAB = peerAB.replyOk;
    stages.taskRefs = stages.taskRefs && peerAB.taskRefsOk;
    taskRefChecks.peerRelayAB = peerAB.taskRefsOk;
    await waitForOpenCodeMemberIdle({
      bridgeClient: harness!.bridgeClient,
      teamName,
      memberName: 'jack',
      projectPath,
      timeoutMs: 90_000,
    });

    const peerBC = await measure('peerRelayBC', async () =>
      sendPeerAndWait({
        scenario: input.scenario,
        harness: harness!,
        teamName,
        projectPath,
        runIndex: input.runIndex,
        expectation: {
          senderName: 'jack',
          recipientName: 'tom',
          messageId: `gauntlet-peer-bc-${input.runIndex}-${Date.now()}`,
          taskIndex: 2,
          peerToken: `GAUNTLET_PEER_JACK_TO_TOM_OK_${input.runIndex}`,
          expectedReplyToken: `GAUNTLET_TOM_USER_OK_${input.runIndex}`,
          text: [
            `Send one team message to tom about task #${input.scenario.tasks[2].displayId}.`,
            `The teammate message must include GAUNTLET_PEER_JACK_TO_TOM_OK_${input.runIndex}.`,
            `Ask tom to reply to the app user with GAUNTLET_TOM_USER_OK_${input.runIndex}.`,
            'Use agent-teams_message_send to tom and keep the taskRefs metadata.',
          ].join('\n'),
        },
      })
    );
    stages.peerRelayBC = peerBC.replyOk;
    stages.taskRefs = stages.taskRefs && peerBC.taskRefsOk;
    taskRefChecks.peerRelayBC = peerBC.taskRefsOk;
    await waitForOpenCodeMemberIdle({
      bridgeClient: harness!.bridgeClient,
      teamName,
      memberName: 'tom',
      projectPath,
      timeoutMs: 90_000,
    });

    const concurrent = await measure('concurrentReplies', async () =>
      Promise.allSettled([
        sendDirectAndWait({
          scenario: input.scenario,
          harness: harness!,
          teamName,
          projectPath,
          runIndex: input.runIndex,
          expectation: {
            memberName: 'bob',
            messageId: `gauntlet-concurrent-bob-${input.runIndex}-${Date.now()}`,
            replyRecipient: 'user',
            actionMode: 'ask',
            taskIndex: 3,
            expectedReplyToken: `GAUNTLET_CONCURRENT_BOB_OK_${input.runIndex}`,
            text: [
              `Concurrent check for task #${input.scenario.tasks[3].displayId}.`,
              `Reply to user with GAUNTLET_CONCURRENT_BOB_OK_${input.runIndex}.`,
              'This message is intentionally sent near another teammate delivery.',
            ].join('\n'),
          },
        }),
        sendDirectAndWait({
          scenario: input.scenario,
          harness: harness!,
          teamName,
          projectPath,
          runIndex: input.runIndex,
          expectation: {
            memberName: 'tom',
            messageId: `gauntlet-concurrent-tom-${input.runIndex}-${Date.now()}`,
            replyRecipient: 'user',
            actionMode: 'ask',
            taskIndex: 4,
            expectedReplyToken: `GAUNTLET_CONCURRENT_TOM_OK_${input.runIndex}`,
            text: [
              `Concurrent check for task #${input.scenario.tasks[4].displayId}.`,
              `Reply to user with GAUNTLET_CONCURRENT_TOM_OK_${input.runIndex}.`,
              'Do not produce an idle acknowledgement or duplicate reply.',
            ].join('\n'),
          },
        }),
      ])
    );
    const concurrentBob = concurrent[0];
    const concurrentTom = concurrent[1];
    if (concurrentBob?.status === 'rejected') {
      const message = getGauntletErrorMessage(concurrentBob.reason);
      stageFailures.concurrentBob = message;
      diagnostics.push(`concurrentBob: ${message}`);
    }
    if (concurrentTom?.status === 'rejected') {
      const message = getGauntletErrorMessage(concurrentTom.reason);
      stageFailures.concurrentTom = message;
      diagnostics.push(`concurrentTom: ${message}`);
    }
    const concurrentResults = concurrent.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    );
    stages.concurrentReplies =
      concurrent.length === 2 &&
      concurrent.every((result) => result.status === 'fulfilled' && result.value.replyOk);
    stages.taskRefs =
      stages.taskRefs &&
      concurrent.length === 2 &&
      concurrent.every((result) => result.status === 'fulfilled' && result.value.taskRefsOk);
    taskRefChecks.concurrentBob =
      concurrentBob?.status === 'fulfilled' ? concurrentBob.value.taskRefsOk : false;
    taskRefChecks.concurrentTom =
      concurrentTom?.status === 'fulfilled' ? concurrentTom.value.taskRefsOk : false;
    if (concurrentResults.length !== concurrent.length) {
      stageFailures.concurrentReplies = 'one_or_more_concurrent_deliveries_failed';
    }

    const expectedUserReplyTokens = [
      `GAUNTLET_DIRECT_BOB_OK_${input.runIndex}`,
      `GAUNTLET_JACK_USER_OK_${input.runIndex}`,
      `GAUNTLET_TOM_USER_OK_${input.runIndex}`,
      `GAUNTLET_CONCURRENT_BOB_OK_${input.runIndex}`,
      `GAUNTLET_CONCURRENT_TOM_OK_${input.runIndex}`,
    ];
    const hygiene = await measure('hygiene', async () =>
      inspectMessageHygiene({
        teamName,
        members: input.scenario.members.map((member) => member.name),
        expectedUserReplyTokens,
      })
    );
    stages.cleanTranscript = hygiene.clean;
    stages.noDuplicateTokens = hygiene.noDuplicateTokens;
    protocolViolations = {
      badMessages: hygiene.badMessages,
      duplicateOrMissingTokens: hygiene.duplicateOrMissingTokens,
    };
    diagnostics.push(...hygiene.diagnostics);
    stages.latencyStable = Date.now() - createStartedAt < 420_000;

    const score = scoreRun(stages);
    const failureCategory =
      score >= 90 && !isHardProtocolFailure(stages)
        ? 'none'
        : classifyGauntletFailure({ diagnostics, stages });
    return {
      runIndex: input.runIndex,
      passed: failureCategory === 'none',
      score,
      countedForRecommendation: isCountedForRecommendation(failureCategory),
      outcome: getRunOutcome(failureCategory),
      failureCategory,
      primaryFailure: getPrimaryFailure(diagnostics),
      durationMs: Date.now() - startedAt,
      hardFailure: failureCategory !== 'none' && failureCategory !== 'provider-infra',
      stageDurationsMs,
      stageFailures,
      taskRefChecks,
      protocolViolations,
      stages,
      diagnostics,
    };
  } catch (error) {
    if (process.env.OPENCODE_E2E_KEEP_FAILED === '1') {
      keepTempDir = true;
      diagnostics.push(`tempDir=${tempDir}`);
    }
    diagnostics.push(error instanceof Error ? error.message : String(error));
    const failureCategory = classifyGauntletFailure({ diagnostics, stages });
    return {
      runIndex: input.runIndex,
      passed: false,
      score: scoreRun(stages),
      countedForRecommendation: isCountedForRecommendation(failureCategory),
      outcome: getRunOutcome(failureCategory),
      failureCategory,
      primaryFailure: getPrimaryFailure(diagnostics),
      durationMs: Date.now() - startedAt,
      hardFailure: failureCategory !== 'provider-infra',
      stageDurationsMs,
      stageFailures,
      taskRefChecks,
      protocolViolations,
      stages,
      diagnostics,
    };
  } finally {
    if (harness) {
      await harness.svc.stopTeam(teamName).catch(() => undefined);
      await harness.dispose().catch(() => undefined);
      await waitForOpenCodeLanesStopped(teamName).catch(() => undefined);
    }
    setClaudeBasePathOverride(null);
    if (!keepTempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function sendDirectAndWait(input: {
  scenario: OpenCodeSemanticScenario;
  harness: Awaited<ReturnType<typeof createOpenCodeLiveHarness>>;
  teamName: string;
  projectPath: string;
  runIndex: number;
  expectation: DeliveryExpectation;
}): Promise<{ replyOk: boolean; taskRefsOk: boolean }> {
  const taskRef = taskRefForScenario(input.scenario, input.expectation.taskIndex, input.teamName);
  const delivery = await input.harness.svc.deliverOpenCodeMemberMessage(input.teamName, {
    memberName: input.expectation.memberName,
    messageId: input.expectation.messageId,
    replyRecipient: input.expectation.replyRecipient,
    actionMode: input.expectation.actionMode,
    taskRefs: [taskRef],
    source: 'manual',
    text: input.expectation.text,
  });
  if (!delivery.delivered) {
    throw new Error(`Direct delivery failed: ${JSON.stringify(delivery, null, 2)}`);
  }
  const reply = await waitForReplyWithTranscript({
    bridgeClient: input.harness.bridgeClient,
    teamName: input.teamName,
    memberName: input.expectation.memberName,
    projectPath: input.projectPath,
    expectedToken: input.expectation.expectedReplyToken,
    timeoutMs: 180_000,
  });
  assertVisibleReplyContract(reply, {
    expectedFrom: input.expectation.memberName,
    expectedTo: 'user',
  });
  return {
    replyOk: true,
    taskRefsOk: hasTaskRef(reply, taskRef),
  };
}

async function sendPeerAndWait(input: {
  scenario: OpenCodeSemanticScenario;
  harness: Awaited<ReturnType<typeof createOpenCodeLiveHarness>>;
  teamName: string;
  projectPath: string;
  runIndex: number;
  expectation: PeerExpectation;
}): Promise<{ replyOk: boolean; taskRefsOk: boolean }> {
  const taskRef = taskRefForScenario(input.scenario, input.expectation.taskIndex, input.teamName);
  const delivery = await input.harness.svc.deliverOpenCodeMemberMessage(input.teamName, {
    memberName: input.expectation.senderName,
    messageId: input.expectation.messageId,
    replyRecipient: input.expectation.recipientName,
    actionMode: 'delegate',
    taskRefs: [taskRef],
    source: 'manual',
    text: input.expectation.text,
  });
  if (!delivery.delivered) {
    throw new Error(`Peer delivery failed: ${JSON.stringify(delivery, null, 2)}`);
  }
  const memberMessage = await waitForMemberInboxMessage(
    input.teamName,
    input.expectation.recipientName,
    input.expectation.senderName,
    input.expectation.peerToken,
    180_000
  );
  assertVisibleReplyContract(memberMessage, {
    expectedFrom: input.expectation.senderName,
    expectedTo: input.expectation.recipientName,
  });
  await waitForOpenCodePeerRelay(
    input.harness.svc,
    input.teamName,
    input.expectation.recipientName,
    memberMessage.messageId,
    180_000
  );
  const reply = await waitForReplyWithTranscript({
    bridgeClient: input.harness.bridgeClient,
    teamName: input.teamName,
    memberName: input.expectation.recipientName,
    projectPath: input.projectPath,
    expectedToken: input.expectation.expectedReplyToken,
    timeoutMs: 180_000,
  });
  assertVisibleReplyContract(reply, {
    expectedFrom: input.expectation.recipientName,
    expectedTo: 'user',
  });
  return {
    replyOk: true,
    taskRefsOk: hasTaskRef(memberMessage, taskRef),
  };
}

async function waitForReplyWithTranscript(input: {
  bridgeClient: Parameters<typeof getRuntimeTranscript>[0]['bridgeClient'];
  teamName: string;
  memberName: string;
  projectPath: string;
  expectedToken: string;
  timeoutMs: number;
}): Promise<InboxMessage> {
  try {
    return await waitForUserInboxReply(
      input.teamName,
      input.memberName,
      input.expectedToken,
      input.timeoutMs
    );
  } catch (error) {
    const transcript = await getRuntimeTranscript({
      bridgeClient: input.bridgeClient,
      teamName: input.teamName,
      memberName: input.memberName,
      projectPath: input.projectPath,
    });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nTranscript: ${JSON.stringify(
        transcript,
        null,
        2
      )}`
    );
  }
}

function assertVisibleReplyContract(
  message: InboxMessage,
  input: {
    expectedFrom: string;
    expectedTo: string;
    expectedTaskRef?: TaskRef;
  }
): void {
  expect(message).toMatchObject({
    from: input.expectedFrom,
    to: input.expectedTo,
  });
  const text = message.text ?? '';
  expect(text).not.toContain('SendMessage');
  expect(text).not.toContain('runtime_deliver_message');
  expect(text).not.toContain('#00000000');
  expect(text.trim()).not.toBe('\u041f\u043e\u043d\u044f\u043b');
  if (input.expectedTaskRef) {
    expect(hasTaskRef(message, input.expectedTaskRef)).toBe(true);
  }
}

function hasTaskRef(message: InboxMessage, expected: TaskRef): boolean {
  return Boolean(
    message.taskRefs?.some(
      (taskRef) =>
        taskRef.teamName === expected.teamName &&
        taskRef.taskId === expected.taskId &&
        taskRef.displayId === expected.displayId
    )
  );
}

async function inspectMessageHygiene(input: {
  teamName: string;
  members: string[];
  expectedUserReplyTokens: string[];
}): Promise<{
  clean: boolean;
  noDuplicateTokens: boolean;
  badMessages: number;
  duplicateOrMissingTokens: string[];
  diagnostics: string[];
}> {
  const userInboxPath = path.join(getTeamsBasePath(), input.teamName, 'inboxes', 'user.json');
  const inboxPaths = [
    userInboxPath,
    ...input.members.map((member) =>
      path.join(getTeamsBasePath(), input.teamName, 'inboxes', `${member}.json`)
    ),
  ];
  const userMessages = await readInboxMessages(userInboxPath);
  const messages = (
    await Promise.all(inboxPaths.map((inboxPath) => readInboxMessages(inboxPath)))
  ).flat();
  const diagnostics: string[] = [];
  const badMessages = messages.filter((message) => {
    const text = message.text ?? '';
    return (
      text.includes('SendMessage') ||
      text.includes('runtime_deliver_message') ||
      text.includes('#00000000') ||
      text.trim() === '\u041f\u043e\u043d\u044f\u043b'
    );
  });
  if (badMessages.length > 0) {
    diagnostics.push(`badMessages=${JSON.stringify(badMessages.slice(0, 5))}`);
  }
  const duplicateTokens = input.expectedUserReplyTokens.filter((token) => {
    const count = userMessages.filter((message) => message.text?.includes(token)).length;
    return count !== 1;
  });
  if (duplicateTokens.length > 0) {
    diagnostics.push(`duplicateOrMissingTokens=${duplicateTokens.join(',')}`);
  }
  return {
    clean: badMessages.length === 0,
    noDuplicateTokens: duplicateTokens.length === 0,
    badMessages: badMessages.length,
    duplicateOrMissingTokens: duplicateTokens,
    diagnostics,
  };
}

function buildGauntletScenario(base: OpenCodeSemanticScenario): OpenCodeSemanticScenario {
  const extraProjectFiles = Array.from({ length: 24 }, (_, index) => ({
    path: `src/gauntlet/context-${String(index + 1).padStart(2, '0')}.ts`,
    contentLines: [
      `export const GAUNTLET_CONTEXT_${index + 1} = {`,
      `  area: 'opencode-agent-teams-${index + 1}',`,
      "  constraint: 'preserve routing, taskRefs, and visible MCP replies',",
      '};',
    ],
  }));
  return {
    ...base,
    teamPromptLines: [
      ...base.teamPromptLines,
      'Gauntlet mode: maintain correctness across repeated deliveries, near-concurrent messages, and multi-hop teammate relays.',
      'A model is only strong if it repeatedly uses Agent Teams MCP message_send, keeps recipients exact, preserves taskRefs, and avoids duplicate visible replies.',
      ...Array.from(
        { length: 12 },
        (_, index) =>
          `Gauntlet context note ${index + 1}: stale acknowledgements, fake tool text, wrong recipients, missing taskRefs, or duplicate tokens are production failures.`
      ),
    ],
    members: [
      ...base.members,
      {
        name: 'tom',
        role: 'Developer',
        workflowLines: [
          'Own concurrent delivery checks and multi-hop peer relay replies.',
          'Reply to the app user only when explicitly instructed by a relayed teammate message.',
          'Preserve taskRefs and never emit fake task ids.',
        ],
      },
    ],
    projectFiles: [...base.projectFiles, ...extraProjectFiles],
    tasks: [
      ...base.tasks,
      {
        taskId: 'task-82ad912c-multihop-relay',
        displayId: '82ad912c',
        subject: 'Verify multi-hop OpenCode peer relay reaches a third teammate',
        owner: 'tom',
        comment:
          'Jack must send a relayed message to tom and tom must reply visibly to the app user.',
      },
      {
        taskId: 'task-9e2f74aa-concurrent-bob',
        displayId: '9e2f74aa',
        subject: 'Verify concurrent delivery to bob does not duplicate replies',
        owner: 'bob',
        comment:
          'Bob receives a near-concurrent app message and must produce exactly one visible reply.',
      },
      {
        taskId: 'task-1b4c8afd-concurrent-tom',
        displayId: '1b4c8afd',
        subject: 'Verify concurrent delivery to tom preserves taskRefs',
        owner: 'tom',
        comment:
          'Tom receives a near-concurrent app message and must preserve the taskRefs metadata.',
      },
    ],
  };
}

function assertLaunchReady(progressEvents: TeamProvisioningProgress[]): void {
  if (
    !progressEvents.some((progress) => progress.message.includes('OpenCode team launch is ready'))
  ) {
    throw new Error(
      `OpenCode launch did not reach ready state.\n${formatProgressDump(progressEvents)}`
    );
  }
}

function scoreRun(stages: RunGauntletResult['stages']): number {
  return Object.entries(stages).reduce(
    (score, [stage, passed]) =>
      score + (passed ? SCORE_WEIGHTS[stage as keyof RunGauntletResult['stages']] : 0),
    0
  );
}

function isHardProtocolFailure(stages: RunGauntletResult['stages']): boolean {
  return (
    !stages.launchBootstrap ||
    !stages.directReply ||
    !stages.peerRelayAB ||
    !stages.peerRelayBC ||
    !stages.concurrentReplies ||
    !stages.taskRefs ||
    !stages.cleanTranscript ||
    !stages.noDuplicateTokens
  );
}

function classifyGauntletFailure(input: {
  diagnostics: readonly string[];
  stages: RunGauntletResult['stages'];
}): RunFailureCategory {
  const text = input.diagnostics.join('\n').toLowerCase();
  if (!text && !isHardProtocolFailure(input.stages)) {
    return 'none';
  }
  if (
    [
      'key limit exceeded',
      'total limit exceeded',
      'requires more credits',
      'can only afford',
      'rate limit',
      '429',
      '402',
      'no endpoints found',
      'selected model',
      'not found in the live provider catalog',
      'unable to connect',
      'provider unavailable',
      'insufficient credits',
    ].some((pattern) => text.includes(pattern))
  ) {
    return 'provider-infra';
  }
  if (
    [
      'opencode tool failed without output',
      'not connected to message transport',
      'opencode prompt delivery record not found',
      '"responsestate": "session_error"',
      'session_error',
      'transport',
    ].some((pattern) => text.includes(pattern))
  ) {
    return 'runtime-transport';
  }
  if (text.includes('transcript:') || isHardProtocolFailure(input.stages)) {
    return 'model-behavior';
  }
  return 'harness-error';
}

function isCountedForRecommendation(category: RunFailureCategory): boolean {
  return category === 'none' || category === 'model-behavior' || category === 'runtime-transport';
}

function getRunOutcome(category: RunFailureCategory): RunOutcome {
  if (category === 'none') {
    return 'passed';
  }
  if (category === 'provider-infra') {
    return 'provider-infra-blocked';
  }
  if (category === 'runtime-transport') {
    return 'runtime-transport-fail';
  }
  if (category === 'harness-error') {
    return 'harness-error';
  }
  return 'behavioral-fail';
}

function getPrimaryFailure(diagnostics: readonly string[]): string | null {
  const diagnostic = diagnostics.find((item) => item.trim() && !item.startsWith('runId='));
  if (!diagnostic) {
    return null;
  }
  return diagnostic.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function getGauntletErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
}

function getModelGauntletVerdict(input: {
  qualified: boolean;
  behavioralAverageScore: number | null;
  successfulRuns: number;
  countedRuns: number;
  totalRuns: number;
  providerInfraFailures: number;
  runtimeTransportFailures: number;
  modelBehaviorFailures: number;
  harnessFailures: number;
}): ModelGauntletVerdict {
  if (input.qualified) {
    return 'recommended';
  }
  if (input.countedRuns === 0 && input.providerInfraFailures > 0) {
    return 'infra-blocked';
  }
  if (input.countedRuns === 0 || input.harnessFailures === input.totalRuns) {
    return 'inconclusive';
  }
  if (
    input.behavioralAverageScore !== null &&
    input.behavioralAverageScore >= 85 &&
    input.successfulRuns > 0 &&
    input.providerInfraFailures === 0 &&
    input.harnessFailures === 0 &&
    input.runtimeTransportFailures <= 1 &&
    input.modelBehaviorFailures <= 1
  ) {
    return 'strong-candidate';
  }
  return 'tested-only';
}

function isModelQualified(input: {
  averageScore: number;
  successfulRuns: number;
  minimumAverageScore: number;
  minimumSuccessfulRuns: number;
  minimumConsistencyScore: number;
  hardFailures: number;
  providerInfraFailures: number;
  harnessFailures: number;
  consistencyScore: number;
}): boolean {
  return (
    input.averageScore >= input.minimumAverageScore &&
    input.successfulRuns >= input.minimumSuccessfulRuns &&
    input.consistencyScore >= input.minimumConsistencyScore &&
    input.hardFailures === 0 &&
    input.providerInfraFailures === 0 &&
    input.harnessFailures === 0
  );
}

function getModelGauntletConfidence(input: {
  countedRuns: number;
  providerInfraFailures: number;
  harnessFailures: number;
}): ModelGauntletConfidence {
  if (input.countedRuns === 0 || input.harnessFailures > 0) {
    return 'blocked';
  }
  if (input.countedRuns >= 3 && input.providerInfraFailures === 0) {
    return 'high';
  }
  if (input.countedRuns >= 2) {
    return 'medium';
  }
  return 'low';
}

function summarizeStagePassRates(
  runs: readonly RunGauntletResult[]
): Record<GauntletStageName, RatioSummary> {
  return Object.fromEntries(
    GAUNTLET_STAGE_NAMES.map((stage) => {
      const passed = runs.filter((run) => run.stages[stage]).length;
      return [stage, buildRatioSummary(passed, runs.length)];
    })
  ) as Record<GauntletStageName, RatioSummary>;
}

function summarizeTaskRefPassRates(
  runs: readonly RunGauntletResult[]
): Record<string, RatioSummary> {
  return Object.fromEntries(
    TASK_REF_CHECK_NAMES.map((name) => {
      const values = runs
        .map((run) => run.taskRefChecks[name])
        .filter((value): value is boolean => typeof value === 'boolean');
      const passed = values.filter(Boolean).length;
      return [name, buildRatioSummary(passed, values.length)];
    })
  );
}

function summarizeProtocolViolations(runs: readonly RunGauntletResult[]): ProtocolViolationTotals {
  return runs.reduce<ProtocolViolationTotals>(
    (totals, run) => {
      const duplicateOrMissingTokens = run.protocolViolations.duplicateOrMissingTokens.length;
      const affected = run.protocolViolations.badMessages > 0 || duplicateOrMissingTokens > 0;
      return {
        badMessages: totals.badMessages + run.protocolViolations.badMessages,
        duplicateOrMissingTokens: totals.duplicateOrMissingTokens + duplicateOrMissingTokens,
        affectedRuns: totals.affectedRuns + (affected ? 1 : 0),
      };
    },
    { badMessages: 0, duplicateOrMissingTokens: 0, affectedRuns: 0 }
  );
}

function summarizeScoreStability(scores: readonly number[]): ScoreStabilitySummary {
  if (scores.length === 0) {
    return {
      sampleSize: 0,
      minScore: 0,
      maxScore: 0,
      spread: 0,
      standardDeviation: 0,
      consistencyScore: 0,
    };
  }
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const variance = scores.reduce((sum, score) => sum + (score - average) ** 2, 0) / scores.length;
  const standardDeviation = round(Math.sqrt(variance), 1);
  const spread = maxScore - minScore;
  return {
    sampleSize: scores.length,
    minScore,
    maxScore,
    spread,
    standardDeviation,
    consistencyScore: Math.max(0, round(100 - spread * 0.8 - standardDeviation * 1.2, 1)),
  };
}

function summarizeStageFailureImpact(
  runs: readonly RunGauntletResult[],
  stagePassRates: Record<GauntletStageName, RatioSummary>
): StageFailureImpactSummary[] {
  return GAUNTLET_STAGE_NAMES.map((stage) => {
    const failedRuns = runs.filter((run) => !run.stages[stage]).length;
    return {
      stage,
      failedRuns,
      weightedLoss: failedRuns * SCORE_WEIGHTS[stage],
      passRate: stagePassRates[stage],
    };
  }).sort((left, right) => {
    if (left.weightedLoss !== right.weightedLoss) {
      return right.weightedLoss - left.weightedLoss;
    }
    return left.stage.localeCompare(right.stage);
  });
}

function getDominantFailureCategory(
  runs: readonly RunGauntletResult[]
): RunFailureCategory | 'mixed' {
  const failedRuns = runs.filter((run) => run.failureCategory !== 'none');
  if (failedRuns.length === 0) {
    return 'none';
  }
  const counts = failedRuns.reduce<Record<RunFailureCategory, number>>(
    (totals, run) => ({
      ...totals,
      [run.failureCategory]: totals[run.failureCategory] + 1,
    }),
    {
      none: 0,
      'model-behavior': 0,
      'runtime-transport': 0,
      'provider-infra': 0,
      'harness-error': 0,
    }
  );
  const ranked = (Object.entries(counts) as Array<[RunFailureCategory, number]>)
    .filter(([category, count]) => category !== 'none' && count > 0)
    .sort((left, right) => right[1] - left[1]);
  if (ranked.length === 0) {
    return 'none';
  }
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
    return 'mixed';
  }
  return ranked[0][0];
}

function calculateReadinessScore(input: {
  behavioralAverageScore: number | null;
  successfulRuns: number;
  countedRuns: number;
  providerInfraFailures: number;
  totalRuns: number;
  taskRefPassRates: Record<string, RatioSummary>;
  protocolViolationTotals: ProtocolViolationTotals;
  consistencyScore: number;
}): number {
  if (input.countedRuns === 0) {
    return 0;
  }
  const behavioralScore = input.behavioralAverageScore ?? 0;
  const passRate =
    input.countedRuns > 0 ? round((input.successfulRuns / input.countedRuns) * 100, 1) : 0;
  const taskRefRate = averageRatioRate(input.taskRefPassRates);
  const protocolCleanRate =
    input.totalRuns > 0
      ? round(
          ((input.totalRuns - input.protocolViolationTotals.affectedRuns) / input.totalRuns) * 100,
          1
        )
      : 0;
  const infraCleanRate =
    input.totalRuns > 0
      ? round(((input.totalRuns - input.providerInfraFailures) / input.totalRuns) * 100, 1)
      : 0;
  return round(
    behavioralScore * 0.4 +
      passRate * 0.2 +
      taskRefRate * 0.15 +
      protocolCleanRate * 0.1 +
      input.consistencyScore * 0.1 +
      infraCleanRate * 0.05,
    1
  );
}

function averageRatioRate(ratios: Record<string, RatioSummary>): number {
  const rates = Object.values(ratios)
    .map((summary) => summary.rate)
    .filter((rate): rate is number => typeof rate === 'number');
  if (rates.length === 0) {
    return 100;
  }
  return round(rates.reduce((sum, rate) => sum + rate, 0) / rates.length, 1);
}

function buildRecommendationBlockers(input: {
  qualified: boolean;
  averageScore: number;
  behavioralAverageScore: number | null;
  successfulRuns: number;
  minimumAverageScore: number;
  minimumSuccessfulRuns: number;
  minimumConsistencyScore: number;
  hardFailures: number;
  providerInfraFailures: number;
  runtimeTransportFailures: number;
  modelBehaviorFailures: number;
  harnessFailures: number;
  consistencyScore: number;
  stageFailureImpact: readonly StageFailureImpactSummary[];
  taskRefPassRates: Record<string, RatioSummary>;
  protocolViolationTotals: ProtocolViolationTotals;
}): string[] {
  if (input.qualified) {
    return [];
  }
  const blockers: string[] = [];
  if (input.averageScore < input.minimumAverageScore) {
    blockers.push(`overall average ${input.averageScore} < ${input.minimumAverageScore}`);
  }
  if (
    input.behavioralAverageScore !== null &&
    input.behavioralAverageScore < input.minimumAverageScore
  ) {
    blockers.push(
      `behavioral average ${input.behavioralAverageScore} < ${input.minimumAverageScore}`
    );
  }
  if (input.successfulRuns < input.minimumSuccessfulRuns) {
    blockers.push(`successful runs ${input.successfulRuns} < ${input.minimumSuccessfulRuns}`);
  }
  if (input.consistencyScore < input.minimumConsistencyScore) {
    blockers.push(`consistency score ${input.consistencyScore} < ${input.minimumConsistencyScore}`);
  }
  if (input.hardFailures > 0) {
    blockers.push(`hard failures ${input.hardFailures}`);
  }
  if (input.providerInfraFailures > 0) {
    blockers.push(`provider-infra failures ${input.providerInfraFailures}`);
  }
  if (input.harnessFailures > 0) {
    blockers.push(`harness failures ${input.harnessFailures}`);
  }
  if (input.runtimeTransportFailures > 0) {
    blockers.push(`runtime-transport failures ${input.runtimeTransportFailures}`);
  }
  if (input.modelBehaviorFailures > 0) {
    blockers.push(`model-behavior failures ${input.modelBehaviorFailures}`);
  }
  const highestImpact = input.stageFailureImpact.find((stage) => stage.failedRuns > 0);
  if (highestImpact) {
    blockers.push(
      `highest weighted stage loss ${highestImpact.stage}=${highestImpact.weightedLoss}`
    );
  }
  const weakestTaskRef = getWeakestRatioEntry(input.taskRefPassRates);
  if (weakestTaskRef && weakestTaskRef[1].rate !== null && weakestTaskRef[1].rate < 100) {
    blockers.push(`weakest taskRefs ${weakestTaskRef[0]}=${renderRatio(weakestTaskRef[1])}`);
  }
  if (input.protocolViolationTotals.affectedRuns > 0) {
    blockers.push(`protocol violations in ${input.protocolViolationTotals.affectedRuns} runs`);
  }
  return blockers;
}

function buildRatioSummary(passed: number, total: number): RatioSummary {
  return {
    passed,
    total,
    rate: total > 0 ? round((passed / total) * 100, 1) : null,
  };
}

async function writeGauntletReport(report: GauntletReport): Promise<void> {
  const outputDir = process.env.OPENCODE_E2E_REPORT_DIR?.trim()
    ? path.resolve(process.env.OPENCODE_E2E_REPORT_DIR.trim())
    : path.join(process.cwd(), 'test-results', 'opencode-semantic-model-gauntlet');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, 'model-gauntlet-results.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(outputDir, 'model-gauntlet-results.md'),
    renderGauntletMarkdown(report),
    'utf8'
  );
}

function renderGauntletMarkdown(report: GauntletReport): string {
  const lines = [
    '# OpenCode Model Gauntlet Results',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Runs per model: ${report.runsPerModel}`,
    `Recommended threshold: average >= ${report.qualification.minimumAverageScore}, successful runs >= ${report.qualification.minimumSuccessfulRuns}, consistency >= ${report.qualification.minimumConsistencyScore}, hard failures = 0`,
    '',
    'Provider-infra runs are reported separately and are not counted as model behavior. They still block a Recommended verdict until rerun succeeds.',
    '',
    `Scoring weights: ${renderScoreWeights()}.`,
    '',
    '## Model Summary',
    '',
    '| Model | Verdict | Confidence | Readiness | Consistency | Score Spread | Behavior Avg | Overall Avg | Counted | Pass Runs | Weakest Stage | Weakest TaskRef | Dominant Failure | Blockers | Provider Infra | Runtime Transport | Model Fails | Protocol Runs | p50 | p95 |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const model of report.models) {
    lines.push(
      `| \`${model.model}\` | ${renderModelVerdict(model.verdict)} | ${model.confidence} | ${
        model.readinessScore
      } | ${model.consistencyScore} | ${model.scoreStability.spread} | ${
        model.behavioralAverageScore ?? 'n/a'
      } | ${model.averageScore} | ${model.countedRuns}/${model.runs.length} | ${
        model.successfulRuns
      }/${model.runs.length} | ${renderWeakestRatio(model.stagePassRates)} | ${renderWeakestRatio(
        model.taskRefPassRates
      )} | ${model.dominantFailureCategory} | ${escapeMarkdownTableCell(
        renderBlockers(model.recommendationBlockers)
      )} | ${model.providerInfraFailures} | ${model.runtimeTransportFailures} | ${
        model.modelBehaviorFailures
      } | ${model.protocolViolationTotals.affectedRuns} | ${model.p50DurationMs}ms | ${
        model.p95DurationMs
      }ms |`
    );
  }
  for (const model of report.models) {
    lines.push('', `## ${model.model}`, '');
    lines.push(
      `Readiness score: ${model.readinessScore}.`,
      '',
      `Score stability: ${renderScoreStability(model.scoreStability)}.`,
      '',
      `Recommendation blockers: ${renderBlockers(model.recommendationBlockers)}.`,
      '',
      `Weighted stage impact: ${renderStageFailureImpact(model.stageFailureImpact)}.`,
      '',
      `Stage pass rates: ${renderRatioMap(model.stagePassRates)}.`,
      '',
      `TaskRef pass rates: ${renderRatioMap(model.taskRefPassRates)}.`,
      '',
      `Protocol totals: badMessages=${model.protocolViolationTotals.badMessages}, duplicateOrMissingTokens=${model.protocolViolationTotals.duplicateOrMissingTokens}, affectedRuns=${model.protocolViolationTotals.affectedRuns}.`,
      ''
    );
    lines.push(
      '| Run | Outcome | Category | Score | Counted | Duration | Failed Stages | Slowest Stage | TaskRefs | Protocol | Diagnostics |'
    );
    lines.push('| ---: | --- | --- | ---: | --- | ---: | --- | --- | --- | --- | --- |');
    for (const run of model.runs) {
      const failedStages = Object.entries(run.stages)
        .filter(([, passed]) => !passed)
        .map(([stage]) => stage)
        .join(', ');
      const slowestStage = renderSlowestStage(run.stageDurationsMs);
      lines.push(
        `| ${run.runIndex} | ${run.outcome} | ${run.failureCategory} | ${run.score} | ${
          run.countedForRecommendation ? 'yes' : 'no'
        } | ${run.durationMs}ms | ${failedStages || '-'} | ${slowestStage} | ${renderTaskRefChecks(
          run.taskRefChecks
        )} | ${renderProtocolViolations(run.protocolViolations)} | ${escapeMarkdownTableCell(
          (run.primaryFailure ??
            renderStageFailures(run.stageFailures) ??
            run.diagnostics.join('; ').slice(0, 600)) ||
            '-'
        )} |`
      );
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function renderModelVerdict(verdict: ModelGauntletVerdict): string {
  switch (verdict) {
    case 'recommended':
      return 'Recommended';
    case 'strong-candidate':
      return 'Strong candidate';
    case 'infra-blocked':
      return 'Infra blocked';
    case 'inconclusive':
      return 'Inconclusive';
    case 'tested-only':
    default:
      return 'Tested only';
  }
}

function renderScoreWeights(): string {
  return GAUNTLET_STAGE_NAMES.map((stage) => `${stage}=${SCORE_WEIGHTS[stage]}`).join(', ');
}

function renderWeakestRatio(ratios: Record<string, RatioSummary>): string {
  const weakest = getWeakestRatioEntry(ratios);
  if (!weakest) {
    return '-';
  }
  const [name, summary] = weakest;
  return `${name} ${renderRatio(summary)}`;
}

function getWeakestRatioEntry(ratios: Record<string, RatioSummary>): [string, RatioSummary] | null {
  const entries = Object.entries(ratios).filter(([, summary]) => summary.total > 0);
  if (entries.length === 0) {
    return null;
  }
  return entries.sort((left, right) => {
    const leftRate = left[1].rate ?? Number.POSITIVE_INFINITY;
    const rightRate = right[1].rate ?? Number.POSITIVE_INFINITY;
    if (leftRate !== rightRate) {
      return leftRate - rightRate;
    }
    return left[0].localeCompare(right[0]);
  })[0];
}

function renderRatioMap(ratios: Record<string, RatioSummary>): string {
  const entries = Object.entries(ratios);
  if (entries.length === 0) {
    return '-';
  }
  return entries.map(([name, summary]) => `${name}:${renderRatio(summary)}`).join(', ');
}

function renderRatio(summary: RatioSummary): string {
  if (summary.total === 0 || summary.rate === null) {
    return 'n/a';
  }
  return `${summary.passed}/${summary.total} (${summary.rate}%)`;
}

function renderBlockers(blockers: readonly string[]): string {
  return blockers.length > 0 ? blockers.join('; ') : '-';
}

function renderScoreStability(stability: ScoreStabilitySummary): string {
  if (stability.sampleSize === 0) {
    return 'n/a';
  }
  return [
    `consistency=${stability.consistencyScore}`,
    `min=${stability.minScore}`,
    `max=${stability.maxScore}`,
    `spread=${stability.spread}`,
    `stdDev=${stability.standardDeviation}`,
    `samples=${stability.sampleSize}`,
  ].join(', ');
}

function renderStageFailureImpact(impact: readonly StageFailureImpactSummary[]): string {
  const failed = impact.filter((stage) => stage.failedRuns > 0);
  if (failed.length === 0) {
    return '-';
  }
  return failed
    .slice(0, 5)
    .map(
      (stage) =>
        `${stage.stage}:loss=${stage.weightedLoss}, failed=${stage.failedRuns}, pass=${renderRatio(
          stage.passRate
        )}`
    )
    .join('; ');
}

function renderSlowestStage(stageDurationsMs: Record<string, number>): string {
  const [stage, durationMs] =
    Object.entries(stageDurationsMs).sort((left, right) => right[1] - left[1])[0] ?? [];
  if (!stage || typeof durationMs !== 'number') {
    return '-';
  }
  return `${stage}:${durationMs}ms`;
}

function renderTaskRefChecks(checks: Record<string, boolean | null>): string {
  const entries = Object.entries(checks).filter(([, value]) => value !== null);
  if (entries.length === 0) {
    return '-';
  }
  return entries.map(([stage, passed]) => `${stage}:${passed ? 'ok' : 'fail'}`).join(', ');
}

function renderProtocolViolations(violations: RunGauntletResult['protocolViolations']): string {
  const parts = [];
  if (violations.badMessages > 0) {
    parts.push(`bad=${violations.badMessages}`);
  }
  if (violations.duplicateOrMissingTokens.length > 0) {
    parts.push(`token=${violations.duplicateOrMissingTokens.join('+')}`);
  }
  return parts.length > 0 ? parts.join(', ') : '-';
}

function renderStageFailures(stageFailures: Record<string, string>): string | null {
  const entries = Object.entries(stageFailures);
  if (entries.length === 0) {
    return null;
  }
  return entries
    .map(([stage, message]) => `${stage}: ${message}`)
    .join('; ')
    .slice(0, 600);
}

function formatProgressDump(progressEvents: TeamProvisioningProgress[]): string {
  return progressEvents
    .map((progress) =>
      [
        progress.state,
        progress.message,
        progress.messageSeverity,
        progress.error,
        progress.cliLogsTail,
      ]
        .filter(Boolean)
        .join(' | ')
    )
    .join('\n');
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1)
  );
  return sortedValues[index];
}

function round(value: number, digits: number): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

function sanitizeModelForTeamName(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function createPassingStages(
  overrides: Partial<RunGauntletResult['stages']> = {}
): RunGauntletResult['stages'] {
  return {
    launchBootstrap: true,
    directReply: true,
    peerRelayAB: true,
    peerRelayBC: true,
    concurrentReplies: true,
    taskRefs: true,
    cleanTranscript: true,
    noDuplicateTokens: true,
    latencyStable: true,
    ...overrides,
  };
}

function createTestGauntletRun(overrides: Partial<RunGauntletResult> = {}): RunGauntletResult {
  const stages = overrides.stages ?? createPassingStages();
  const score = overrides.score ?? scoreRun(stages);
  const failureCategory = overrides.failureCategory ?? (score === 100 ? 'none' : 'model-behavior');
  return {
    runIndex: 1,
    passed: failureCategory === 'none',
    score,
    countedForRecommendation: isCountedForRecommendation(failureCategory),
    outcome: getRunOutcome(failureCategory),
    failureCategory,
    primaryFailure: null,
    durationMs: 1_000,
    hardFailure: failureCategory !== 'none' && failureCategory !== 'provider-infra',
    stageDurationsMs: {
      launchBootstrap: 100,
      directReply: 100,
    },
    stageFailures: {},
    taskRefChecks: {
      directReply: true,
      peerRelayAB: true,
      peerRelayBC: true,
      concurrentBob: true,
      concurrentTom: true,
    },
    protocolViolations: {
      badMessages: 0,
      duplicateOrMissingTokens: [],
    },
    stages,
    diagnostics: [],
    ...overrides,
  };
}

function createTestGauntletModel(input: { runs: RunGauntletResult[] }): ModelGauntletResult {
  const scores = input.runs.map((run) => run.score);
  const countedRuns = input.runs.filter((run) => run.countedForRecommendation);
  const countedScores = countedRuns.map((run) => run.score);
  const durations = input.runs.map((run) => run.durationMs).sort((left, right) => left - right);
  const behavioralAverageScore =
    countedScores.length > 0
      ? round(countedScores.reduce((sum, score) => sum + score, 0) / countedScores.length, 1)
      : null;
  const averageScore =
    scores.length > 0 ? round(scores.reduce((sum, score) => sum + score, 0) / scores.length, 1) : 0;
  const providerInfraFailures = input.runs.filter(
    (run) => run.failureCategory === 'provider-infra'
  ).length;
  const runtimeTransportFailures = input.runs.filter(
    (run) => run.failureCategory === 'runtime-transport'
  ).length;
  const modelBehaviorFailures = input.runs.filter(
    (run) => run.failureCategory === 'model-behavior'
  ).length;
  const harnessFailures = input.runs.filter(
    (run) => run.failureCategory === 'harness-error'
  ).length;
  const successfulRuns = input.runs.filter((run) => run.passed).length;
  const hardFailures = input.runs.filter((run) => run.hardFailure).length;
  const stagePassRates = summarizeStagePassRates(input.runs);
  const taskRefPassRates = summarizeTaskRefPassRates(input.runs);
  const protocolViolationTotals = summarizeProtocolViolations(input.runs);
  const stageFailureImpact = summarizeStageFailureImpact(input.runs, stagePassRates);
  const scoreStability = summarizeScoreStability(countedScores);
  const qualified = isModelQualified({
    averageScore,
    successfulRuns,
    minimumAverageScore: 90,
    minimumSuccessfulRuns: 3,
    minimumConsistencyScore: 85,
    hardFailures,
    providerInfraFailures,
    harnessFailures,
    consistencyScore: scoreStability.consistencyScore,
  });
  return {
    model: 'openrouter/test/model',
    verdict: getModelGauntletVerdict({
      qualified,
      behavioralAverageScore,
      successfulRuns,
      countedRuns: countedRuns.length,
      totalRuns: input.runs.length,
      providerInfraFailures,
      runtimeTransportFailures,
      modelBehaviorFailures,
      harnessFailures,
    }),
    confidence: getModelGauntletConfidence({
      countedRuns: countedRuns.length,
      providerInfraFailures,
      harnessFailures,
    }),
    qualified,
    readinessScore: calculateReadinessScore({
      behavioralAverageScore,
      successfulRuns,
      countedRuns: countedRuns.length,
      providerInfraFailures,
      totalRuns: input.runs.length,
      taskRefPassRates,
      protocolViolationTotals,
      consistencyScore: scoreStability.consistencyScore,
    }),
    consistencyScore: scoreStability.consistencyScore,
    averageScore,
    behavioralAverageScore,
    minScore: scores.length > 0 ? Math.min(...scores) : 0,
    successfulRuns,
    countedRuns: countedRuns.length,
    hardFailures,
    providerInfraFailures,
    runtimeTransportFailures,
    modelBehaviorFailures,
    harnessFailures,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    stagePassRates,
    taskRefPassRates,
    protocolViolationTotals,
    stageFailureImpact,
    scoreStability,
    dominantFailureCategory: getDominantFailureCategory(input.runs),
    recommendationBlockers: buildRecommendationBlockers({
      qualified,
      averageScore,
      behavioralAverageScore,
      successfulRuns,
      minimumAverageScore: 90,
      minimumSuccessfulRuns: 3,
      minimumConsistencyScore: 85,
      hardFailures,
      providerInfraFailures,
      runtimeTransportFailures,
      modelBehaviorFailures,
      harnessFailures,
      consistencyScore: scoreStability.consistencyScore,
      stageFailureImpact,
      taskRefPassRates,
      protocolViolationTotals,
    }),
    runs: input.runs,
  };
}
