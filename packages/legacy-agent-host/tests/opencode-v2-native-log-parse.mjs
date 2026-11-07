// TEST-only durable SSE parser: never treat an unowned, truncated or reordered
// stream as a native Host restart receipt.
const invalid = () => { throw new Error('native_durable_log_identity_or_cursor_mismatch'); };
const limit = () => { throw new Error('native_durable_log_limit_exceeded'); };
const safePosition = value => Number.isSafeInteger(value) && value >= 0;
const ownedString = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;

export function parseOwnedDurableLog(body, sessionId, directory, onEvent) {
  if (typeof body !== 'string' || !ownedString(sessionId) || !ownedString(directory)) invalid();
  const frames = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n');
  if (frames.at(-1) !== '') invalid();
  if (frames.length > 4098) limit();
  let previous = -1, synced = false, watermark;
  const ids = new Set();
  let eventCount = 0;
  for (const frame of frames) {
    const lines = frame.split('\n');
    // Only SSE comments/blank keep-alives may be ignored. Unsupported control
    // directives must never silently conceal a native event in the proof.
    if (lines.some(line => line !== '' && !line.startsWith(':') && !line.startsWith('data:'))) invalid();
    const dataLines = lines.filter(line => line.startsWith('data:'));
    if (dataLines.length === 0) continue;
    const data = dataLines.map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) invalid(); // An empty data: frame is an event, not a heartbeat.
    let event;
    try { event = JSON.parse(data); } catch { invalid(); }
    if (!event || typeof event !== 'object' || Array.isArray(event) || synced) invalid();
    if (event.type === 'log.synced') {
      if (event.aggregateID !== sessionId || !safePosition(event.seq) || event.seq < previous) invalid();
      synced = true;
      watermark = event.seq;
      continue;
    }
    const seq = event.durable?.seq;
    if (event.durable?.aggregateID !== sessionId || event.data?.sessionID !== sessionId ||
        (event.location !== undefined && event.location?.directory !== directory) ||
        !ownedString(event.id) || !ownedString(event.type) ||
        !event.type.startsWith('session.') || !safePosition(seq) || seq <= previous ||
        ids.has(event.id) || eventCount >= 4096 ||
        (eventCount === 0 && (event.type !== 'session.created' || seq !== 0))) invalid();
    ids.add(event.id);
    previous = seq;
    eventCount++;
    // Retain the full event identity in memory for an optional TEST-only
    // cold-restart comparison. Never copy native event content into receipts.
    onEvent?.(event);
  }
  if (!synced) invalid();
  return { watermark, eventCount };
}

// Native cold restart must retain the SAME previously observed events, not
// merely an equal count or watermark. New events may be appended afterwards.
export function retainsOwnedDurablePrefix(fresh, recovered) {
  return Number.isSafeInteger(fresh?.watermark) && fresh.watermark >= 0 &&
    Number.isSafeInteger(recovered?.watermark) && recovered.watermark >= fresh.watermark &&
    Number.isSafeInteger(fresh?.eventCount) && fresh.eventCount >= 0 &&
    Number.isSafeInteger(recovered?.eventCount) && recovered.eventCount >= fresh.eventCount &&
    Array.isArray(fresh?.fingerprints) && Array.isArray(recovered?.fingerprints) &&
    fresh.fingerprints.length === fresh.eventCount &&
    recovered.fingerprints.length === recovered.eventCount &&
    fresh.fingerprints.every((fingerprint, i) =>
      typeof fingerprint === 'string' && fingerprint === recovered.fingerprints[i]);
}
