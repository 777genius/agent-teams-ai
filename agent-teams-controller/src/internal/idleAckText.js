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

function looksLikeIdleAckOnlyText(value) {
  const normalized = normalizeIdleAckText(value);
  if (!normalized || normalized.length > IDLE_ACK_MAX_CHARS) {
    return false;
  }
  if (IDLE_ACK_EXACT_TEXT.has(normalized)) {
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
