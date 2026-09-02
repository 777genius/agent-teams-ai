function normalizeCreationCommand(value) {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object') {
    throw new Error('Task creation command conflict: invalid provenance');
  }
  const namespace = typeof value.namespace === 'string' ? value.namespace.trim() : '';
  const scopeKey = typeof value.scopeKey === 'string' ? value.scopeKey.trim() : '';
  const operation = typeof value.operation === 'string' ? value.operation.trim() : '';
  const commandId = typeof value.commandId === 'string' ? value.commandId.trim() : '';
  const payloadHash = typeof value.payloadHash === 'string' ? value.payloadHash.trim() : '';
  const idempotencyKey =
    typeof value.idempotencyKey === 'string' ? value.idempotencyKey.trim() : '';
  if (!namespace || !scopeKey || !operation || !commandId || !payloadHash) {
    throw new Error('Task creation command conflict: incomplete provenance');
  }
  return {
    namespace,
    scopeKey,
    operation,
    commandId,
    payloadHash,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

// An explicitly provided creation command id — an MCP requestKey/idempotencyKey or an
// app command id — is the caller's own dedup key. Two creates that carry different ids
// are two different intents even when their content matches, and a replay of one id is
// collapsed by the command path in taskStore.js instead of by content dedup.
function hasExplicitCreationCommand(input) {
  const commandId =
    input && input.creationCommand && typeof input.creationCommand.commandId === 'string'
      ? input.creationCommand.commandId.trim()
      : '';
  return commandId.length > 0;
}

module.exports = { normalizeCreationCommand, hasExplicitCreationCommand };
