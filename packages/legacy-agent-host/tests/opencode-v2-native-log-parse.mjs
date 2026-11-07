// TEST-only durable SSE parser: never treat an unowned, truncated or reordered
// stream as a native Host restart receipt.
const invalid = () => { throw new Error('native_durable_log_identity_or_cursor_mismatch'); };
const limit = () => { throw new Error('native_durable_log_limit_exceeded'); };
const safePosition = value => Number.isSafeInteger(value) && value >= 0;
const ownedString = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;

export function parseOwnedDurableLog(body, sessionId, directory) {
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
  }
  if (!synced) invalid();
  return { watermark, eventCount };
}
