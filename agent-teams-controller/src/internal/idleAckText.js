const IDLE_ACK_MAX_CHARS = 180;

function normalizeIdleAckText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[#*_`"'“”‘’«»()[\]{}.,!?;:<>/\\|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const IDLE_ACK_EXACT_TEXT = new Set([
  'ok',
  'okay',
  'understood',
  'got it',
  'ready',
  'waiting',
  'waiting for tasks',
  'awaiting tasks',
  'no tasks',
  'no assigned tasks',
  'no actionable tasks',
  'понял',
  'поняла',
  'понял жду',
  'понял жду задачи',
  'принял',
  'приняла',
  'ок',
  'окей',
  'готов',
  'готов к работе',
  'жду',
  'жду задачи',
  'нет задач',
  'нет назначенных задач',
]);

/**
 * The app's own narrow-ack vocabulary, copied from `ACK_ONLY_PHRASES` /
 * `ACK_ONLY_PREFIXES` in
 * `src/main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdog.ts`.
 * The controller is a standalone package and cannot import from the app, so the
 * two lists must be kept in sync by hand, with this one a superset.
 *
 * Every reply the app classifies ack-only is one it re-prompts for a real
 * answer under the same relayOfMessageId. The relay-scoped dedup in
 * messageStore.js must recognise at least the same texts, or the repaired
 * answer is deduplicated against the acknowledgement and never reaches the user.
 */
const NARROW_ACK_ONLY_PHRASES = [
  'понял',
  'поняла',
  'ок',
  'окей',
  'принял',
  'приняла',
  'сделаю',
  'разберусь',
  'understood',
  'got it',
  'ok',
  'okay',
  'will do',
].map(normalizeIdleAckText);

const NARROW_ACK_ONLY_PREFIXES = [
  "i'll check",
  'i will check',
  "i'll take a look",
  'i will take a look',
  "i'll do it",
  'i will do it',
  'я проверю',
  'я посмотрю',
].map(normalizeIdleAckText);

function looksLikeNarrowAckOnlyText(normalized) {
  if (NARROW_ACK_ONLY_PHRASES.includes(normalized)) {
    return true;
  }
  return NARROW_ACK_ONLY_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix} `)
  );
}

function looksLikeIdleAckOnlyText(value) {
  const normalized = normalizeIdleAckText(value);
  if (!normalized || normalized.length > IDLE_ACK_MAX_CHARS) {
    return false;
  }
  if (IDLE_ACK_EXACT_TEXT.has(normalized) || looksLikeNarrowAckOnlyText(normalized)) {
    return true;
  }

  const hasNoTaskPhrase =
    normalized.includes('нет назначенных задач') ||
    normalized.includes('нет задач') ||
    normalized.includes('no assigned tasks') ||
    normalized.includes('no actionable tasks') ||
    normalized.includes('no tasks');
  const hasWaitingPhrase =
    normalized.includes('жду задачи') ||
    normalized.includes('ожидаю задачи') ||
    normalized.includes('waiting for tasks') ||
    normalized.includes('awaiting tasks');
  const hasReadyPhrase =
    normalized.includes('готов к работе') ||
    normalized.includes('готов работать') ||
    normalized.includes('ready to work');
  const hasNoMoreMessagingPhrase =
    normalized.includes('больше не буду') &&
    (normalized.includes('писать') ||
      normalized.includes('отправлять') ||
      normalized.includes('message') ||
      normalized.includes('send'));
  const hasIdlePhrase =
    normalized.includes('idle') &&
    (normalized.includes('task') || normalized.includes('wait') || normalized.includes('ready'));

  return (
    hasNoTaskPhrase ||
    hasWaitingPhrase ||
    hasReadyPhrase ||
    hasNoMoreMessagingPhrase ||
    hasIdlePhrase
  );
}

module.exports = {
  looksLikeIdleAckOnlyText,
  normalizeIdleAckText,
};
