const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createControllerContext } = require('./context.js');
const { withFileLockSync } = require('./fileLock.js');
const messageStore = require('./messageStore.js');
const cascadeGuard = require('./cascadeGuard.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const {
  formatCrossTeamText,
  CROSS_TEAM_SOURCE,
  CROSS_TEAM_SENT_SOURCE,
} = require('./crossTeamProtocol.js');

const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const CROSS_TEAM_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallbackValue;
    throw error;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}

function normalizeMetaMembers(rawMembers) {
  if (!Array.isArray(rawMembers)) return [];
  const deduped = new Map();
  for (const m of rawMembers) {
    if (!m || typeof m !== 'object') continue;
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    if (!name) continue;
    deduped.set(name, {
      name,
      agentType: typeof m.agentType === 'string' ? m.agentType.trim() || undefined : undefined,
      role: typeof m.role === 'string' ? m.role.trim() || undefined : undefined,
    });
  }
  return Array.from(deduped.values());
}

function resolveTargetLead(paths, config) {
  // 1. config.members — agentType check
  if (config && config.members && config.members.length) {
    const lead = config.members.find((m) => m && m.agentType === 'team-lead');
    if (lead && lead.name) return String(lead.name).trim();

    // 2. config.members — name check
    const namedLead = config.members.find((m) => m && m.name === 'team-lead');
    if (namedLead && namedLead.name) return String(namedLead.name).trim();
  }

  // 3. members.meta.json — WITH normalization (trim + dedup)
  const metaPath = path.join(paths.teamDir, 'members.meta.json');
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const members = normalizeMetaMembers(raw && raw.members);
    if (members.length > 0) {
      const metaLead = members.find(
        (m) => m.agentType === 'team-lead' || m.name === 'team-lead'
      );
      if (metaLead && metaLead.name) return metaLead.name;
      return members[0].name;
    }
  } catch {
    /* ENOENT or parse error */
  }

  // 4. role-based (legacy compat)
  if (config && config.members && config.members.length) {
    const roleLead = config.members.find(
      (m) => m && m.role && String(m.role).toLowerCase().includes('lead')
    );
    if (roleLead && roleLead.name) return String(roleLead.name).trim();
    // 5. First member
    if (config.members[0] && config.members[0].name) return String(config.members[0].name).trim();
  }

  return 'team-lead';
}

function createTargetContext(sourceContext, toTeam) {
  return createControllerContext({
    teamName: toTeam,
    claudeDir: sourceContext.claudeDir,
  });
}

function normalizeForDedupe(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function getCrossTeamMessageDedupeKey(message) {
  if (!message || typeof message !== 'object') return '';
  return buildCrossTeamDedupeKey(
    message.fromTeam,
    message.fromMember,
    message.toTeam,
    message.text,
    message.summary,
    message.taskRefs
  );
}

function normalizeTaskRefs(taskRefs) {
  if (!Array.isArray(taskRefs) || taskRefs.length === 0) {
    return undefined;
  }

  const normalized = taskRefs
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      taskId: String(item.taskId || '').trim(),
      displayId: String(item.displayId || '').trim(),
      teamName: String(item.teamName || '').trim(),
    }))
    .filter((item) => item.taskId && item.displayId && item.teamName);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeTaskRefsForDedupe(taskRefs) {
  const normalized = normalizeTaskRefs(taskRefs);
  return normalized ? JSON.stringify(normalized) : '';
}

function buildCrossTeamDedupeKey(fromTeam, fromMember, toTeam, text, summary, taskRefs) {
  return [
    normalizeForDedupe(fromTeam),
    normalizeForDedupe(fromMember),
    normalizeForDedupe(toTeam),
    normalizeForDedupe(summary),
    normalizeForDedupe(text),
    normalizeTaskRefsForDedupe(taskRefs),
  ].join('||');
}

function findRecentDuplicate(outboxList, dedupeKey) {
  if (!Array.isArray(outboxList) || !dedupeKey) return null;
  const cutoff = Date.now() - CROSS_TEAM_DEDUPE_WINDOW_MS;
  for (let i = outboxList.length - 1; i >= 0; i -= 1) {
    const entry = outboxList[i];
    const ts = Date.parse(entry && entry.timestamp ? entry.timestamp : '');
    if (!Number.isFinite(ts) || ts < cutoff) {
      break;
    }
    if (getCrossTeamMessageDedupeKey(entry) === dedupeKey) {
      return entry;
    }
  }
  return null;
}

function sendCrossTeamMessage(context, flags) {
  const fromTeam = context.teamName;
  const toTeam = typeof flags.toTeam === 'string' ? flags.toTeam.trim() : '';
  const rawFromMember = typeof flags.fromMember === 'string' ? flags.fromMember.trim() : 'team-lead';
  const replyToConversationId =
    typeof flags.replyToConversationId === 'string' ? flags.replyToConversationId.trim() : '';
  const conversationId =
    typeof flags.conversationId === 'string' && flags.conversationId.trim()
      ? flags.conversationId.trim()
      : replyToConversationId || '';
  const text = typeof flags.text === 'string' ? flags.text : '';
  const summary = typeof flags.summary === 'string' ? flags.summary.trim() : undefined;
  const chainDepth = typeof flags.chainDepth === 'number' ? flags.chainDepth : 0;
  const taskRefs = normalizeTaskRefs(flags.taskRefs);

  // Validate
  if (!TEAM_NAME_PATTERN.test(fromTeam)) {
    throw new Error(`Invalid fromTeam: ${fromTeam}`);
  }
  if (!TEAM_NAME_PATTERN.test(toTeam)) {
    throw new Error(`Invalid toTeam: ${toTeam}`);
  }
  if (fromTeam === toTeam) {
    throw new Error('Cannot send cross-team message to the same team');
  }
  if (!text || text.trim().length === 0) {
    throw new Error('Message text is required');
  }
  const fromMember = runtimeHelpers.assertExplicitTeamMemberName(
    context.paths,
    rawFromMember,
    'fromMember',
    {
      allowLeadAliases: true,
    }
  );

  // Target context + config
  const targetContext = createTargetContext(context, toTeam);
  const targetConfig = runtimeHelpers.readTeamConfig(targetContext.paths);
  if (!targetConfig || targetConfig.deletedAt) {
    throw new Error(`Target team not found: ${toTeam}`);
  }

  // Resolve lead
  const leadName = resolveTargetLead(targetContext.paths, targetConfig);

  // Format
  const from = `${fromTeam}.${fromMember}`;
  const resolvedConversationId =
    conversationId || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  const formattedText = formatCrossTeamText(from, chainDepth, text, {
    conversationId: resolvedConversationId,
    replyToConversationId: replyToConversationId || undefined,
  });
  const messageId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const timestamp = new Date().toISOString();
  const dedupeKey = buildCrossTeamDedupeKey(fromTeam, fromMember, toTeam, text, summary, taskRefs);

  const inboxPath = path.join(targetContext.paths.teamDir, 'inboxes', `${leadName}.json`);
  const outboxPath = path.join(context.paths.teamDir, 'sent-cross-team.json');
  let duplicate = null;
  withFileLockSync(outboxPath, () => {
    const outbox = readJson(outboxPath, []);
    const outList = Array.isArray(outbox) ? outbox : [];
    duplicate = findRecentDuplicate(outList, dedupeKey);
    if (duplicate) {
      return;
    }

    // Cascade check only for real new deliveries.
    cascadeGuard.check(fromTeam, toTeam, chainDepth);
    cascadeGuard.record(fromTeam, toTeam);

    // Cross-process safe inbox write
    withFileLockSync(inboxPath, () => {
      fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
      const current = readJson(inboxPath, []);
      const list = Array.isArray(current) ? current : [];
      list.push({
        from,
        to: leadName,
        text: formattedText,
        timestamp,
        read: false,
        summary: summary || `Cross-team message from ${fromTeam}`,
        messageId,
        source: CROSS_TEAM_SOURCE,
        conversationId: resolvedConversationId,
        replyToConversationId: replyToConversationId || undefined,
        ...(taskRefs ? { taskRefs } : {}),
      });
      writeJson(inboxPath, list);
    });

    // Verify while still inside dedupe lock so duplicate callers
    // cannot append the same request to outbox concurrently.
    const inbox = readJson(inboxPath, []);
    if (!inbox.some((m) => m.messageId === messageId)) {
      throw new Error('Cross-team inbox write verification failed');
    }

    messageStore.appendSentMessage(context.paths, {
      from: fromMember,
      to: `${toTeam}.${leadName}`,
      text,
      timestamp,
      messageId,
      summary: summary || `Cross-team message to ${toTeam}`,
      source: CROSS_TEAM_SENT_SOURCE,
      conversationId: resolvedConversationId,
      replyToConversationId: replyToConversationId || undefined,
      ...(taskRefs ? { taskRefs } : {}),
    });

    outList.push({
      messageId,
      fromTeam,
      fromMember,
      toTeam,
      conversationId: resolvedConversationId,
      replyToConversationId: replyToConversationId || undefined,
      text,
      ...(taskRefs ? { taskRefs } : {}),
      summary,
      chainDepth,
      timestamp,
    });
    writeJson(outboxPath, outList);
  });

  if (duplicate) {
    return {
      messageId: duplicate.messageId,
      deliveredToInbox: true,
      deduplicated: true,
    };
  }

  return { messageId, deliveredToInbox: true };
}

function listCrossTeamTargets(context, flags) {
  const excludeTeam =
    typeof flags === 'object' && flags && typeof flags.excludeTeam === 'string'
      ? flags.excludeTeam
      : context.teamName;

  const teamsDir = path.dirname(context.paths.teamDir);
  let entries;
  try {
    entries = fs.readdirSync(teamsDir);
  } catch {
    return [];
  }

  const targets = [];
  for (const entry of entries) {
    if (entry === excludeTeam) continue;
    if (!TEAM_NAME_PATTERN.test(entry)) continue;

    const entryTeamDir = path.join(teamsDir, entry);
    const configPath = path.join(entryTeamDir, 'config.json');
    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      continue;
    }
    if (!config || config.deletedAt) continue;

    targets.push({
      teamName: entry,
      displayName: config.name || entry,
      description: config.description || undefined,
    });
  }

  return targets;
}

function getCrossTeamOutbox(context) {
  const outboxPath = path.join(context.paths.teamDir, 'sent-cross-team.json');
  return readJson(outboxPath, []);
}

module.exports = {
  sendCrossTeamMessage,
  listCrossTeamTargets,
  getCrossTeamOutbox,
};
