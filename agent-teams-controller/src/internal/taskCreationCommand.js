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

module.exports = { normalizeCreationCommand };
