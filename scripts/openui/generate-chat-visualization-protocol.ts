import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  chatVisualizationLibrary,
  chatVisualizationInstructions,
  CHAT_VISUALIZATION_PROTOCOL_VERSION,
} from '../../src/features/chat-visualizations/renderer/protocol';

const output = fileURLToPath(
  new URL(
    '../../agent-teams-controller/src/internal/generated/chatVisualizationProtocol.json',
    import.meta.url
  )
);
const text =
  JSON.stringify(
    {
      generated: 'scripts/openui/generate-chat-visualization-protocol.ts',
      protocolVersion: CHAT_VISUALIZATION_PROTOCOL_VERSION,
      instructions: chatVisualizationInstructions,
      spec: chatVisualizationLibrary.toSpec(),
    },
    null,
    2
  ) + '\n';
if (process.argv.includes('--check')) {
  if ((await readFile(output, 'utf8')) !== text) {
    throw new Error('Chat visualization protocol has drifted. Run its generator.');
  }
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, text);
}
