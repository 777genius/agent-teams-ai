import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyLaunchFailureArtifact,
  extractLaunchBootstrapTransportBreadcrumb,
  isWorkspaceTrustLaunchFailureText,
  readTeamLaunchFailureDiagnosticsBundle,
  redactLaunchFailureArtifactText,
  writeTeamLaunchFailureArtifactPack,
} from '../../../../src/main/services/team/TeamLaunchFailureArtifactPack';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

describe('TeamLaunchFailureArtifactPack', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-launch-artifact-pack-'));
    setClaudeBasePathOverride(path.join(tempRoot, '.claude'));
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('writes a bounded redacted launch failure artifact pack with known launch files', async () => {
    const teamName = 'artifact-team';
    const runId = 'run-secret-1';
    const teamDir = path.join(getTeamsBasePath(), teamName);
    await fs.mkdir(path.join(teamDir, '.bootstrap.lock'), { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'launch-state.json'),
      JSON.stringify({
        teamName,
        runId,
        secret: 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        token: 'abcdefghijklmnopqrstuvwxyz123456',
      }),
      'utf8'
    );
    await fs.writeFile(path.join(teamDir, 'launch-summary.json'), '{"summary":true}\n', 'utf8');
    await fs.writeFile(path.join(teamDir, 'bootstrap-state.json'), '{"bootstrap":true}\n', 'utf8');
    await fs.writeFile(
      path.join(teamDir, 'bootstrap-journal.jsonl'),
      '{"event":"started"}\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, '.bootstrap.lock', 'metadata.json'),
      '{"pid":123,"runId":"run-secret-1"}\n',
      'utf8'
    );

    const result = await writeTeamLaunchFailureArtifactPack({
      teamName,
      runId,
      reason: 'launch_progress_failed',
      startedAt: '2026-05-09T00:00:00.000Z',
      cwd: '/repo',
      pid: 123,
      providerId: 'anthropic',
      model: 'claude-opus',
      expectedMembers: ['alice'],
      effectiveMembers: [{ name: 'alice', role: 'developer', provider: 'anthropic' } as never],
      progress: {
        runId,
        teamName,
        state: 'failed',
        message: 'Launch failed',
        startedAt: '2026-05-09T00:00:00.000Z',
        updatedAt: '2026-05-09T00:01:00.000Z',
        error:
          'Authentication failed: ANTHROPIC_API_KEY=sk-ant-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      memberSpawnStatuses: {
        alice: {
          status: 'error',
          launchState: 'failed_to_start',
          hardFailureReason: 'bootstrap timeout',
          updatedAt: '2026-05-09T00:01:00.000Z',
        },
      },
      cliLogs: 'stderr OPENAI_API_KEY=sk-proj-cccccccccccccccccccccccccccccccccccccccc',
      progressTraceLines: ['[failed] launch failed'],
      runtimeAdapterTraceLines: ['runtime trace'],
    });

    const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8')) as {
      reason: string;
      artifactFiles: string[];
      classification: { code: string };
      bootstrapTransportBreadcrumb: { lastTransportStage: string | null };
      progress: { error: string };
    };
    expect(manifest.reason).toBe('launch_progress_failed');
    expect(manifest.classification.code).toBe('provider_auth');
    expect(manifest.artifactFiles).toContain('cli-logs-tail.txt');
    expect(manifest.artifactFiles).toContain('launch-state.json');
    expect(manifest.progress.error).toContain('[REDACTED]');

    const copiedLaunchState = await fs.readFile(
      path.join(result.directory, 'launch-state.json'),
      'utf8'
    );
    expect(copiedLaunchState).toContain('[REDACTED_ANTHROPIC_API_KEY]');
    expect(() => JSON.parse(copiedLaunchState)).not.toThrow();
    expect(copiedLaunchState).toContain('"token":"[REDACTED]"');
    expect(copiedLaunchState).not.toContain('sk-ant-');

    const cliLogs = await fs.readFile(path.join(result.directory, 'cli-logs-tail.txt'), 'utf8');
    expect(cliLogs).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(cliLogs).not.toContain('sk-proj-');

    const latest = JSON.parse(
      await fs.readFile(path.join(teamDir, 'launch-failure-artifacts', 'latest.json'), 'utf8')
    ) as { manifestPath: string };
    expect(latest.manifestPath).toBe(result.manifestPath);

    const bundle = await readTeamLaunchFailureDiagnosticsBundle(teamName, runId);
    expect(bundle).toMatchObject({
      teamName,
      runId,
      manifestPath: result.manifestPath,
      classification: { code: 'provider_auth' },
      bootstrapTransportBreadcrumb: { submitRejected: false },
    });
    expect(bundle.files.map((file) => file.label)).toEqual([
      'launch-failure-artifacts/latest.json',
      'launch-failure-artifacts/manifest.json',
      'bootstrap-journal.jsonl',
      'launch-state.json',
    ]);
    expect(
      bundle.files.find((file) => file.label === 'bootstrap-journal.jsonl')?.content
    ).toContain('"event":"started"');
    const launchStateContent = bundle.files.find(
      (file) => file.label === 'launch-state.json'
    )?.content;
    expect(launchStateContent).toContain('[REDACTED_ANTHROPIC_API_KEY]');
    expect(launchStateContent).not.toContain('sk-ant-');
  });

  it('redacts common bearer and token-shaped secrets', () => {
    const redacted = redactLaunchFailureArtifactText(
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456 token: abcdefghijklmnopqrstuvwxyz123456 ANTHROPIC_AUTH_TOKEN=lmstudio CODEX_API_KEY="quoted-codex-token" OPENROUTER_API_KEY=\'quoted-router-token\''
    );
    expect(redacted).toContain('Authorization: Bearer [REDACTED]');
    expect(redacted).toContain('token: [REDACTED]');
    expect(redacted).toContain('ANTHROPIC_AUTH_TOKEN=[REDACTED]');
    expect(redacted).toContain('CODEX_API_KEY=[REDACTED]');
    expect(redacted).toContain('OPENROUTER_API_KEY=[REDACTED]');
    expect(redacted).not.toContain('lmstudio');
    expect(redacted).not.toContain('quoted-codex-token');
    expect(redacted).not.toContain('quoted-router-token');
  });

  it('classifies bootstrap transport rejection and extracts breadcrumb details', () => {
    const input = {
      teamName: 'artifact-team',
      runId: 'run-transport',
      reason: 'launch_cleanup_unconfirmed_bootstrap',
      progressTraceLines: [
        'bob did not submit bootstrap prompt: timed out waiting for bootstrap_submitted; last transport stage: bootstrap_submit_rejected: submit rejected by local prompt handler retryable=true',
        'Warning: no stdin data received in 3s, proceeding without it.',
      ],
    };

    expect(classifyLaunchFailureArtifact(input).code).toBe('transport_rejected');
    expect(extractLaunchBootstrapTransportBreadcrumb(input)).toMatchObject({
      lastTransportStage:
        'bootstrap_submit_rejected: submit rejected by local prompt handler retryable=true',
      submitRejected: true,
      retryable: true,
      noStdinWarning: true,
      bootstrapSubmitted: false,
    });
  });

  it('does not classify stdin warning as root cause after bootstrap transport evidence', () => {
    const input = {
      teamName: 'artifact-team',
      runId: 'run-mailbox-written',
      reason:
        'atlas: Teammate process atlas@signal-ops did not submit bootstrap prompt: timed out waiting for bootstrap_submitted; last transport stage: mailbox_bootstrap_written Last stderr: Warning: no stdin data received in 3s, proceeding without it.',
      progressTraceLines: [
        'mailbox_bootstrap_written detail=messageId=bootstrap-atlas-1',
        'Warning: no stdin data received in 3s, proceeding without it.',
      ],
    };

    expect(classifyLaunchFailureArtifact(input).code).toBe('model_no_bootstrap');
    expect(extractLaunchBootstrapTransportBreadcrumb(input)).toMatchObject({
      lastTransportStage: 'mailbox_bootstrap_written',
      noStdinWarning: true,
      bootstrapSubmitted: false,
    });
  });

  it('keeps inbox poller bootstrap stalls out of stdin_missing classification', () => {
    const input = {
      teamName: 'artifact-team',
      runId: 'run-inbox-ready-no-submit',
      reason:
        'atlas: Teammate process atlas@signal-ops did not submit bootstrap prompt: timed out waiting for bootstrap_submitted; last transport stage: inbox_poller_ready: initial poll observed bootstrap prompt Last stderr: Warning: no stdin data received in 3s, proceeding without it.',
      progressTraceLines: [
        'mailbox_bootstrap_written detail=messageId=bootstrap-atlas-2',
        'inbox_poller_ready detail=initial poll observed bootstrap prompt',
        'Warning: no stdin data received in 3s, proceeding without it.',
      ],
    };

    expect(classifyLaunchFailureArtifact(input).code).toBe('model_no_bootstrap');
    expect(extractLaunchBootstrapTransportBreadcrumb(input)).toMatchObject({
      lastTransportStage: 'inbox_poller_ready: initial poll observed bootstrap prompt',
      noStdinWarning: true,
      bootstrapSubmitted: false,
    });
  });

  it('keeps submit-attempt stalls out of stdin_missing classification', () => {
    const input = {
      teamName: 'artifact-team',
      runId: 'run-submit-attempt-no-submit',
      reason:
        'bob: Teammate process bob@signal-ops did not submit bootstrap prompt: timed out waiting for bootstrap_submitted; last transport stage: bootstrap_submit_attempted: submitting bootstrap prompt Last stderr: Warning: no stdin data received in 3s, proceeding without it.',
      progressTraceLines: [
        'mailbox_bootstrap_written detail=messageId=bootstrap-bob-1',
        'bootstrap_submit_attempted detail=submitting bootstrap prompt',
        'Warning: no stdin data received in 3s, proceeding without it.',
      ],
    };

    expect(classifyLaunchFailureArtifact(input).code).toBe('model_no_bootstrap');
    expect(extractLaunchBootstrapTransportBreadcrumb(input)).toMatchObject({
      lastTransportStage: 'bootstrap_submit_attempted: submitting bootstrap prompt',
      noStdinWarning: true,
      bootstrapSubmitted: false,
    });
  });

  it('keeps process exits after bootstrap transport evidence out of stdin_missing classification', () => {
    const input = {
      teamName: 'artifact-team',
      runId: 'run-submit-attempt-process-exit',
      reason:
        'alice: Teammate process alice@signal-ops did not submit bootstrap prompt: teammate process exited before bootstrap_submitted; last transport stage: bootstrap_submit_attempted: submitting bootstrap prompt Last stderr: Warning: no stdin data received in 3s, proceeding without it.',
      progressTraceLines: [
        'mailbox_bootstrap_written detail=messageId=bootstrap-alice-1',
        'bootstrap_submit_attempted detail=submitting bootstrap prompt',
        'process exited before bootstrap_submitted',
        'Warning: no stdin data received in 3s, proceeding without it.',
      ],
    };

    expect(classifyLaunchFailureArtifact(input).code).toBe('model_no_bootstrap');
    expect(extractLaunchBootstrapTransportBreadcrumb(input)).toMatchObject({
      lastTransportStage: 'bootstrap_submit_attempted: submitting bootstrap prompt',
      noStdinWarning: true,
      bootstrapSubmitted: false,
    });
  });

  it('keeps submitted bootstrap prompts out of stdin_missing classification while waiting for confirmation', () => {
    const input = {
      teamName: 'artifact-team',
      runId: 'run-submitted-no-confirm',
      reason:
        'alice: Teammate was registered but did not bootstrap-confirm before timeout. Last transport stage: bootstrap_submitted: messageId=bootstrap-alice-1 Last stderr: Warning: no stdin data received in 3s, proceeding without it.',
      progressTraceLines: [
        'mailbox_bootstrap_written detail=messageId=bootstrap-alice-1',
        'bootstrap_submit_attempted detail=submitting bootstrap prompt',
        'event="bootstrap_submitted" detail=messageId=bootstrap-alice-1',
        'Warning: no stdin data received in 3s, proceeding without it.',
      ],
    };

    expect(classifyLaunchFailureArtifact(input).code).toBe('model_no_bootstrap');
    expect(extractLaunchBootstrapTransportBreadcrumb(input)).toMatchObject({
      lastTransportStage: 'bootstrap_submitted: messageId=bootstrap-alice-1',
      noStdinWarning: true,
      bootstrapSubmitted: true,
    });
  });

  it('classifies accepted-without-uuid bootstrap submit failures as transport evidence', () => {
    const input = {
      teamName: 'artifact-team',
      runId: 'run-submit-accepted-without-uuid',
      reason:
        'jack: Teammate process jack@signal-ops did not submit bootstrap prompt: teammate runtime failed before bootstrap_submitted (bootstrap_submit_accepted_without_uuid) Last stderr: Warning: no stdin data received in 3s, proceeding without it.',
      progressTraceLines: [
        'mailbox_bootstrap_written detail=messageId=bootstrap-jack-1',
        'bootstrap_submit_attempted detail=submitting bootstrap prompt',
        'bootstrap_submit_accepted_without_uuid detail=submit accepted without userMessageUuid',
        'Warning: no stdin data received in 3s, proceeding without it.',
      ],
    };

    expect(classifyLaunchFailureArtifact(input).code).toBe('model_no_bootstrap');
    expect(extractLaunchBootstrapTransportBreadcrumb(input)).toMatchObject({
      noStdinWarning: true,
      bootstrapSubmitted: true,
    });
  });

  it('classifies provider quota separately from protocol errors', () => {
    expect(
      classifyLaunchFailureArtifact({
        teamName: 'artifact-team',
        runId: 'run-quota',
        reason:
          'OpenCode quota exhausted. This request requires more credits, or fewer max_tokens.',
      }).code
    ).toBe('provider_quota');
  });

  it('classifies Claude Code workspace trust failures separately', () => {
    const reason =
      'Teammate "Gayani" cannot start in headless process runtime because workspace trust is not accepted for "C:\\Users\\vilok\\OneDrive\\Desktop\\Safar 0.1". Open that workspace once interactively and accept trust, then launch the team again.';

    const classification = classifyLaunchFailureArtifact({
      teamName: 'artifact-team',
      runId: 'run-workspace-trust',
      reason: 'Deterministic bootstrap failed',
      memberSpawnStatuses: {
        Gayani: {
          status: 'error',
          launchState: 'failed_to_start',
          hardFailureReason: reason,
          updatedAt: '2026-05-12T00:00:00.000Z',
        },
      },
      progressTraceLines: [reason],
    });

    expect(classification.code).toBe('workspace_trust_required');
    expect(classification.evidence.join('\n')).toContain('workspace trust is not accepted');
  });

  it('classifies workspace trust preflight blocks separately', () => {
    const classification = classifyLaunchFailureArtifact({
      teamName: 'artifact-team',
      runId: 'run-workspace-trust-preflight',
      reason: 'Claude workspace trust was not confirmed for /tmp/project',
      launchDiagnostics: [
        {
          id: 'workspace-trust:preflight',
          severity: 'error',
          code: 'workspace_trust_preflight',
          label: 'Workspace trust preflight blocked launch',
          detail: 'Claude workspace trust was not confirmed for /tmp/project',
          observedAt: '2026-05-13T00:00:00.000Z',
        },
      ],
    });

    expect(classification.code).toBe('workspace_trust_required');
    expect(classification.evidence.join('\n')).toContain('workspace trust was not confirmed');
  });

  it('prioritizes workspace trust over auth and transport-looking fallback text', () => {
    const classification = classifyLaunchFailureArtifact({
      teamName: 'artifact-team',
      runId: 'run-workspace-trust-priority',
      reason:
        'Token refresh failed after bootstrap_submit_rejected, but Claude workspace trust was not confirmed for /tmp/project',
      progressTraceLines: [
        '401 Unauthorized',
        'workspace_trust_preflight_not_confirmed',
        'last transport stage: bootstrap_submit_rejected retryable=true',
      ],
    });

    expect(classification.code).toBe('workspace_trust_required');
    expect(classification.confidence).toBeGreaterThan(0.9);
  });

  it('matches only explicit workspace trust failure text', () => {
    expect(
      isWorkspaceTrustLaunchFailureText('Claude workspace trust was not confirmed for /tmp/project')
    ).toBe(true);
    expect(isWorkspaceTrustLaunchFailureText('workspace trust preflight disabled')).toBe(false);
  });

  it.each([
    {
      name: 'stdin warning',
      text: 'Warning: no stdin data received in 3s, proceeding without it.',
      code: 'stdin_missing',
    },
    {
      name: 'provider auth',
      text: 'Codex API error. Token refresh failed: 401 Unauthorized',
      code: 'provider_auth',
    },
    {
      name: 'model bootstrap timeout',
      text: 'bob: Teammate was registered but did not bootstrap-confirm before timeout.',
      code: 'model_no_bootstrap',
    },
    {
      name: 'sanitized launch bootstrap fallback',
      text: 'Bootstrap was not confirmed before the Codex runtime exited. Pending teammates: alice.',
      code: 'model_no_bootstrap',
    },
    {
      name: 'process stale pid',
      text: 'persisted runtime pid is not alive; persisted runtime pid was not found in process table',
      code: 'process_exited',
    },
    {
      name: 'opencode protocol',
      text: 'OpenCode API error. non_visible_tool_without_task_progress',
      code: 'opencode_protocol',
    },
  ])('classifies production-like failure string: $name', ({ text, code }) => {
    expect(
      classifyLaunchFailureArtifact({
        teamName: 'artifact-team',
        runId: `run-${code}`,
        reason: text,
      }).code
    ).toBe(code);
  });
});
