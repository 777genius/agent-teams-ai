import { BoardTaskLogDiagnosticsService } from '../src/main/services/team/taskLogs/diagnostics/BoardTaskLogDiagnosticsService';

function usage(): string {
  return 'Usage: pnpm exec tsx scripts/diagnose-task-log-stream.ts <team-name> <task-id-or-display-id> [--json]';
}

function formatExamples(
  title: string,
  examples: Array<{
    timestamp: string;
    toolName: string;
    toolUseId?: string;
    filePath: string;
    messageUuid: string;
    isSidechain: boolean;
    agentId?: string;
  }>,
): string[] {
  if (examples.length === 0) {
    return [];
  }

  return [
    title,
    ...examples.map((example) => {
      const parts = [
        `- ${example.timestamp}`,
        example.toolName,
        `message=${example.messageUuid}`,
        `file=${example.filePath}`,
        `sidechain=${String(example.isSidechain)}`,
      ];
      if (example.toolUseId) {
        parts.push(`toolUseId=${example.toolUseId}`);
      }
      if (example.agentId) {
        parts.push(`agentId=${example.agentId}`);
      }
      return parts.join('  ');
    }),
  ];
}

async function main(): Promise<void> {
  const teamName = process.argv[2];
  const taskRef = process.argv[3];
  const jsonMode = process.argv.includes('--json');

  if (!teamName || !taskRef) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const diagnosticsService = new BoardTaskLogDiagnosticsService();
  const report = await diagnosticsService.diagnose(teamName, taskRef);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lines = [
    `Task log diagnostics for ${report.teamName} #${report.task.displayId}`,
    `Task: ${report.task.subject}`,
    `Status: ${report.task.status}${report.task.owner ? `  owner=${report.task.owner}` : ''}`,
    `Transcript files: ${report.transcript.fileCount}`,
    `Explicit records: total=${report.explicitRecords.total} execution=${report.explicitRecords.execution} lifecycle=${report.explicitRecords.lifecycle} boardAction=${report.explicitRecords.boardAction}`,
    `Explicit participants: ${report.explicitRecords.participants.join(', ') || 'none'}`,
    `Explicit tool names: ${report.explicitRecords.toolNames.join(', ') || 'none'}`,
    `Interval tool results: total=${report.intervalToolResults.total} boardMcp=${report.intervalToolResults.boardMcp} worker=${report.intervalToolResults.worker.total} explicitWorker=${report.intervalToolResults.worker.explicitLinked} missingWorker=${report.intervalToolResults.worker.missingExplicit}`,
    `Stream: participants=${report.stream.participants.join(', ') || 'none'} defaultFilter=${report.stream.defaultFilter} segments=${report.stream.segmentCount}`,
    `Visible stream tools: ${report.stream.visibleToolNames.join(', ') || 'none'}`,
    'Diagnosis:',
    ...report.diagnosis.map((line) => `- ${line}`),
    ...formatExamples(
      'Missing worker tool results without explicit links:',
      report.intervalToolResults.worker.examples,
    ),
    ...formatExamples(
      'Empty payload examples from current stream:',
      report.stream.emptyPayloadExamples,
    ),
  ];

  console.log(lines.join('\n'));
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
