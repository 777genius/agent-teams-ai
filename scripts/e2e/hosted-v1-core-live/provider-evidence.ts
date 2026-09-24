import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [claudeRoot, marker, commandMarker, workspaceRoot] = process.argv.slice(2);
if (typeof claudeRoot !== 'string' || !/^\/tmp\/hosted-core-issuer-[^/]+\/claude$/.test(claudeRoot) ||
    resolve(claudeRoot) !== claudeRoot || await realpath(claudeRoot) !== claudeRoot ||
    !/^CORE_LIVE_[0-9A-F]{24}$/.test(marker ?? '') ||
    !/^CORE_EXEC_[0-9A-F]{24}$/.test(commandMarker ?? '') ||
    !/^\/tmp\/hosted-core-issuer-[A-Za-z0-9_-]+\/sandbox-project$/.test(workspaceRoot ?? '') ||
    await realpath(workspaceRoot).catch(() => null) !== workspaceRoot) {
  throw new Error('core-live-provider-evidence-input-invalid');
}
const expectedCommand = `printf '%s' '${commandMarker}' > '${workspaceRoot}/command-proof.txt'`;
const profiles = join(claudeRoot, '.local', 'share', 'claude-multimodel-nodejs',
  'opencode', 'profiles');
let keys: string[];
try { keys = await readdir(profiles); }
catch { throw new Error('core-live-opencode-profiles-missing'); }
if (keys.length > 32) throw new Error('core-live-opencode-profile-budget-exceeded');
const sessions: Array<Record<string, unknown>> = [];
const toolReceipts: Array<Record<string, unknown>> = [];
for (const key of keys) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(key)) continue;
  const dbPath = join(profiles, key, 'data', 'opencode', 'opencode.db');
  let db: Database;
  try { db = new Database(dbPath, { readonly: true, create: false }); }
  catch { continue; }
  try {
    db.exec('PRAGMA query_only = ON');
    const rows = db.query('select session_id, data from message order by time_created desc limit 256')
      .all() as Array<{ session_id: string; data: string }>;
    const parts = db.query('select session_id, data from part order by time_created desc limit 1024')
      .all() as Array<{ session_id: string; data: string }>;
    const marked = new Set(parts.filter(part => part.data.includes(marker))
      .map(part => part.session_id));
    for (const part of parts) {
      if (!marked.has(part.session_id)) continue;
      let data: Record<string, any>;
      try { data = JSON.parse(part.data); } catch { continue; }
      if (data.type !== 'tool' || !['bash', 'shell'].includes(data.tool) ||
          data.state?.status !== 'completed' ||
          data.state?.input?.command !== expectedCommand) continue;
      toolReceipts.push({ profileKey: key, sessionId: part.session_id,
        partId: data.id ?? null, tool: data.tool, status: data.state.status,
        commandSha256: createHash('sha256').update(expectedCommand).digest('hex') });
    }
    for (const row of rows) {
      if (!marked.has(row.session_id)) continue;
      let data: Record<string, any>;
      try { data = JSON.parse(row.data); } catch { continue; }
      const model = data.model ?? {};
      if (data.role !== 'assistant') continue;
      const providerId = data.providerID ?? model.providerID;
      const modelId = data.modelID ?? model.modelID;
      if (providerId !== 'local-llama' || modelId !== 'qwen3-8b') continue;
      sessions.push({
        profileKey: key, sessionId: row.session_id,
        messageId: data.id ?? null,
        providerId, modelId,
        finishedAt: data.time?.completed ?? null,
        inputTokens: data.tokens?.input ?? null,
        outputTokens: data.tokens?.output ?? null,
      });
    }
  } finally { db.close(); }
}
if (!sessions.some(session => Number(session.outputTokens) > 0 && session.finishedAt !== null &&
    toolReceipts.some(receipt => receipt.profileKey === session.profileKey &&
      receipt.sessionId === session.sessionId))) {
  throw new Error('core-live-completed-model-request-unproven');
}
process.stdout.write(`${JSON.stringify({ source: 'official-opencode-sqlite', sessions,
  completedShellTools: toolReceipts })}\n`);
