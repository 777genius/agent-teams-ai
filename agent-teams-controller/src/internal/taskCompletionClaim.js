const { stripAgentBlocks } = require('./agentBlocks.js');

// JavaScript's \b is ASCII-only (\w is [A-Za-z0-9_]), so it never matches at the
// edge of a Cyrillic word and a /\bготово\b/-style pattern would be dead code.
// Russian patterns therefore use explicit Unicode lookarounds; Latin patterns
// keep \b only while their outermost characters stay ASCII — a Croatian token
// like "čekam" opens on a non-ASCII letter and needs the lookaround too.
const CLAIM_PATTERNS = [
  // English: a copula or a sentence end is required, otherwise ordinary progress
  // notes ("work done so far: ...", "done reading src/app.ts, now ...") would
  // read as claims.
  /\b(?:task|work|implementation|fix|change|refactor)\s+(?:is|was)\s+(?:now\s+)?(?:complete|completed|done|finished)\b/,
  /\b(?:task|work|implementation|fix|change|refactor)\s+(?:complete|completed|done|finished)\s*[.!]*$/,
  /\ball\s+done\b/,
  /^(?:done|completed|finished)\s*(?:[.!]*$|[-–—:,])/,
  /#[a-f0-9]{6,}\s*[-–—:,]?\s*(?:is\s+)?(?:now\s+)?(?:done|complete|completed|finished)\b/,
  /\bi\s+(?:have\s+)?(?:completed|finished)\b/,
  /\bready\s+for\s+review\b/,
  // Russian
  /(?<![\p{L}\p{N}_])(?:задача|работа)\s+(?:выполнена|завершена|готова|сделана)(?![\p{L}\p{N}_])/u,
  /(?<![\p{L}\p{N}_])(?:готово|выполнено|завершено|закончил|закончила)(?![\p{L}\p{N}_])/u,
  /(?<![\p{L}\p{N}_])готов[ао]?\s+к\s+(?:ревью|review)(?![\p{L}\p{N}_])/u,
  // Croatian: bare "gotovo" is also the adverb "almost" ("gotovo završeno",
  // "gotovo nikad"), so it only reads as a claim when it stands alone at the end
  // of a sentence or appears in the "sve je gotovo" form.
  /(?:^|[.!?]\s)gotovo\s*[.!]*$/,
  /\bsve\s+je\s+gotovo\b/,
  /\b(?:završeno|dovršeno|napravljeno|implementirano)\b/,
  /\bspremno\s+za\s+(?:pregled|review)\b/,
  /\bzadatak\s+je\s+(?:gotov|završen|dovršen)\b/,
];

// Every token that can carry a claim above needs a negation here: the negation
// list has to stay a superset of the claim list, or an explicit denial ("nije
// implementirano", "не закончил") is read as the claim it contradicts.
const NEGATION_PATTERNS = [
  // English
  /\bnot\s+(?:yet\s+)?(?:all\s+)?(?:complete|completed|done|finished|ready)\b/,
  /\b(?:almost|nearly)\s+(?:complete|completed|done|finished)\b/,
  /\bwill\s+be\s+(?:complete|completed|done|finished)\b/,
  /\b(?:no|not\s+much|little)\s+(?:\w+\s+)?(?:work|progress)\b/,
  // Russian
  /(?<![\p{L}\p{N}_])не\s+(?:законч|готов|заверш|выполн|сдела)/u,
  // Croatian
  /\bnije\s+(?:još\s+)?(?:gotov|gotovo|završen|završeno|dovršen|dovršeno|napravljeno|implementirano|spremno)\b/,
  /\bjoš\s+nije\b/,
  /\b(?:skoro|gotovo)\s+(?:gotov|gotovo|završeno|dovršeno)\b/,
];

// Mirrors the blocker/clarification vocabulary of the desktop stall monitor's
// classifier, which tests that branch BEFORE the completion claim. Vetoing the
// same texts here keeps the MCP tool layer from instructing task_complete on a
// comment that asks a question or reports a blocker.
const BLOCKER_PATTERNS = [
  /\?/,
  // English
  /\b(?:blocked|blocker|blocking|cannot|can['’]t|need|needs|needed|waiting|clarification|question|permission)\b/,
  /\b(?:access\s+denied|not\s+enough\s+context)\b/,
  // Russian
  /(?<![\p{L}\p{N}_])не\s+(?:могу|получается)(?![\p{L}\p{N}_])/u,
  /(?<![\p{L}\p{N}_])(?:нужн|нужен|жду|блок|уточн|вопрос|нет\s+доступа|недостаточно\s+контекст)/u,
  // Croatian
  /(?<![\p{L}\p{N}_])(?:ne\s+mogu|trebam|treba\s+mi|čekam|nemam\s+pristup)(?![\p{L}\p{N}_])/u,
];

function normalizeTaskCompletionClaimText(text) {
  return stripAgentBlocks(typeof text === 'string' ? text : '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a task comment reads as "the work on this task is finished".
 *
 * Context-free on purpose: the same predicate has to run inside the MCP tool
 * layer (to tell the author that a comment never changes board status) and
 * inside the desktop stall monitor (to shorten the stall threshold for a task
 * whose owner claimed completion but never called task_complete). Two copies of
 * the keyword list would drift, and a disagreement between those two surfaces is
 * exactly the failure this predicate exists to catch.
 *
 * Blockers and questions are vetoed first, then negations, so "not done yet",
 * "još nije gotovo" and "All done. Should I also update the docs?" never read as
 * a claim.
 */
function isTaskCompletionClaimText(text) {
  const normalized = normalizeTaskCompletionClaimText(text);
  if (!normalized) {
    return false;
  }
  if (BLOCKER_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  if (NEGATION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return CLAIM_PATTERNS.some((pattern) => pattern.test(normalized));
}

module.exports = {
  CLAIM_PATTERNS,
  NEGATION_PATTERNS,
  BLOCKER_PATTERNS,
  normalizeTaskCompletionClaimText,
  isTaskCompletionClaimText,
};
