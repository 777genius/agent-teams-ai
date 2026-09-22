const {
  isTaskCompletionClaimText,
  CLAIM_PATTERNS,
  NEGATION_PATTERNS,
  BLOCKER_PATTERNS,
} = require('../src/internal/taskCompletionClaim.js');
const { taskTextSignals } = require('../src/index.js');

describe('isTaskCompletionClaimText', () => {
  it.each([
    '#abcd1234 done. Implemented the parser in src/app.ts, tests green.',
    'All done.',
    'Done.',
    'Task is complete — ready for review.',
    'Work is now finished.',
    'I have finished the refactor.',
    'Ready for review.',
    'Готово, задача выполнена.',
    'Задача завершена.',
    'Закончил, всё работает.',
    'Gotovo.',
    'Sve je gotovo.',
    'Gotovo, spremno za pregled.',
    'Zadatak je gotov.',
    'Implementirano, spremno za pregled.',
    'Završeno, testovi prolaze.',
  ])('treats a completion-shaped comment as a claim: %s', (text) => {
    expect(isTaskCompletionClaimText(text)).toBe(true);
  });

  it.each([
    'Not done yet, still debugging.',
    'Almost complete.',
    'This will be done after the review.',
    'Ещё не готово.',
    'Не готово.',
    'Nije još gotovo.',
    'Još nije.',
    'Skoro gotovo.',
    'Starting work.',
    'Blocked: no access.',
    'Reading src/app.ts now.',
    '',
  ])('does not treat a non-completion comment as a claim: %s', (text) => {
    expect(isTaskCompletionClaimText(text)).toBe(false);
  });

  it.each([
    'Nije implementirano.',
    'Caching nije implementirano, radim na tome.',
    'To nije napravljeno.',
    'Nije završeno.',
    'Zadatak još nije dovršen.',
    'Не закончил.',
    'Я не закончил.',
    'Ещё не закончил.',
    'Не закончила, продолжаю.',
    'Не сделано.',
    'No work done yet.',
    'No work done.',
    'Not much work done today.',
  ])('reads an explicit denial of completion as a negation: %s', (text) => {
    expect(isTaskCompletionClaimText(text)).toBe(false);
  });

  it.each([
    'Work done so far: refactored the parser. Still adding tests.',
    'Done reading src/app.ts, now writing the fix.',
    'Completed the analysis phase, starting implementation now.',
  ])('does not treat mid-work English phrasing as a claim: %s', (text) => {
    expect(isTaskCompletionClaimText(text)).toBe(false);
  });

  it.each([
    // "gotovo" is also the Croatian adverb "almost".
    'Gotovo završeno.',
    'Gotovo dovršeno.',
    'Gotovo nikad ne radi ovako.',
  ])('does not treat the Croatian adverb "gotovo" as a claim: %s', (text) => {
    expect(isTaskCompletionClaimText(text)).toBe(false);
  });

  it.each([
    'All done. Should I also update the docs?',
    'Task is complete — but I need the API key to verify. Can you provide it?',
    'Gotovo, ali trebam pristup bazi. Možeš li mi dati?',
    'Готово, но жду доступ к базе.',
    'Završeno, ali ne mogu pokrenuti testove.',
    'Work is done, waiting on the review key.',
  ])('vetoes a blocker- or question-shaped completion comment: %s', (text) => {
    expect(isTaskCompletionClaimText(text)).toBe(false);
  });

  it('ignores non-string input', () => {
    expect(isTaskCompletionClaimText(undefined)).toBe(false);
    expect(isTaskCompletionClaimText(null)).toBe(false);
    expect(isTaskCompletionClaimText(42)).toBe(false);
  });

  it('classifies on the visible text only, not on agent-only blocks', () => {
    expect(
      isTaskCompletionClaimText('<info_for_agent>Task is complete.</info_for_agent>')
    ).toBe(false);
    expect(
      isTaskCompletionClaimText('Gotovo.\n<info_for_agent>internal note</info_for_agent>')
    ).toBe(true);
  });

  it('normalizes case and collapsed whitespace before matching', () => {
    expect(isTaskCompletionClaimText('TASK   IS\n\nCOMPLETE')).toBe(true);
  });

  it('uses Unicode-aware boundaries so Cyrillic patterns are not dead', () => {
    // JavaScript's \b never matches next to a Cyrillic letter, so every Russian
    // pattern must carry its own lookaround boundary. The same holds for the
    // Croatian tokens that open on a diacritic, such as "čekam".
    expect(CLAIM_PATTERNS.some((pattern) => pattern.test('готово'))).toBe(true);
    expect(NEGATION_PATTERNS.some((pattern) => pattern.test('ещё не готово'))).toBe(true);
    expect(BLOCKER_PATTERNS.some((pattern) => pattern.test('не могу продолжить'))).toBe(true);
    expect(BLOCKER_PATTERNS.some((pattern) => pattern.test('čekam odgovor'))).toBe(true);
  });

  it('keeps the negation list a superset of the claim tokens', () => {
    // Every token that can carry a claim needs a denial form that outranks it,
    // otherwise an explicit "not done" reads as "done".
    for (const claim of [
      'task is done',
      'work is complete',
      'gotovo',
      'završeno',
      'dovršeno',
      'napravljeno',
      'implementirano',
      'готово',
      'закончил',
      'завершено',
      'выполнено',
    ]) {
      expect(isTaskCompletionClaimText(claim)).toBe(true);
    }

    for (const denial of [
      'task is not done',
      'work is not complete',
      'nije gotovo',
      'nije završeno',
      'nije dovršeno',
      'nije napravljeno',
      'nije implementirano',
      'не готово',
      'не закончил',
      'не завершено',
      'не выполнено',
    ]) {
      expect(isTaskCompletionClaimText(denial)).toBe(false);
    }
  });

  it('is exported from the controller package as taskTextSignals', () => {
    expect(taskTextSignals.isTaskCompletionClaimText('All done.')).toBe(true);
    expect(taskTextSignals.isTaskCompletionClaimText('Starting work.')).toBe(false);
  });
});
