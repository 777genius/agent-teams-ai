// CJS protocol boundary mirrors the public team-group-chats envelope guard.
function assertValidGroupInboxRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Inbox storage unavailable: expected array');
  const canonicalIds = new Set();
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const row = item;
    if (!Object.keys(row).some((key) => key.startsWith('group'))) continue;
    if (
      typeof row.groupChatId !== 'string' ||
      !row.groupChatId ||
      typeof row.groupMessageId !== 'string' ||
      !row.groupMessageId ||
      typeof row.messageId !== 'string' ||
      !row.messageId ||
      row.groupChatProtocolVersion !== 1 ||
      typeof row.from !== 'string' ||
      typeof row.text !== 'string' ||
      typeof row.timestamp !== 'string' ||
      typeof row.read !== 'boolean' ||
      !Number.isFinite(Date.parse(row.timestamp))
    )
      throw new Error('Inbox storage unavailable: malformed group envelope');
    if (row.groupMessageId === row.messageId) {
      if (row.to !== 'user' || canonicalIds.has(row.messageId))
        throw new Error('Inbox storage unavailable: duplicate or misplaced canonical group row');
      if (
        !Array.isArray(row.groupRecipientNames) ||
        row.groupRecipientNames.some((name) => typeof name !== 'string' || !name) ||
        new Set(row.groupRecipientNames).size !== row.groupRecipientNames.length ||
        !row.groupRecipientRunKeys ||
        typeof row.groupRecipientRunKeys !== 'object' ||
        Array.isArray(row.groupRecipientRunKeys) ||
        row.groupRecipientNames.some(
          (name) =>
            typeof row.groupRecipientRunKeys[name] !== 'string' || !row.groupRecipientRunKeys[name]
        )
      )
        throw new Error('Inbox storage unavailable: invalid frozen recipients');
      canonicalIds.add(row.messageId);
    } else if (
      typeof row.to !== 'string' ||
      typeof row.groupRunKey !== 'string' ||
      !row.groupRunKey
    ) {
      throw new Error('Inbox storage unavailable: invalid group physical destination');
    }
    if (row.groupChatName !== undefined && typeof row.groupChatName !== 'string')
      throw new Error('Inbox storage unavailable: invalid group name');
    if (row.groupDeliverySummary !== undefined) {
      const summary = row.groupDeliverySummary;
      if (
        !summary ||
        typeof summary.recordedAt !== 'string' ||
        !Number.isFinite(Date.parse(summary.recordedAt)) ||
        !Array.isArray(summary.recipients)
      )
        throw new Error('Inbox storage unavailable: invalid delivery summary');
      const seen = new Set();
      for (const entry of summary.recipients) {
        if (!entry || typeof entry !== 'object')
          throw new Error('Inbox storage unavailable: invalid delivery outcome');
        const outcome = entry;
        if (
          typeof outcome.memberName !== 'string' ||
          typeof outcome.physicalMessageId !== 'string' ||
          !['queued', 'accepted', 'failed', 'unknown', 'skipped'].includes(
            String(outcome.status)
          ) ||
          seen.has(outcome.memberName) ||
          (outcome.reason !== undefined && typeof outcome.reason !== 'string')
        )
          throw new Error('Inbox storage unavailable: invalid delivery outcome');
        seen.add(outcome.memberName);
      }
    }
    if (row.groupHandoffStartedAt !== undefined && typeof row.groupHandoffStartedAt !== 'string')
      throw new Error('Inbox storage unavailable: invalid handoff marker');
  }
}

module.exports = { assertValidGroupInboxRows };
