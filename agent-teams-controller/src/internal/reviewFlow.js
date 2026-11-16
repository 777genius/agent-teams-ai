const fs = require('fs');
const path = require('path');
const { writeJsonFileSync } = require('./atomicFile.js');

/**
 * Review-flow policy: who gives the final acceptance after AI review.
 *
 * The policy is layered. A global default (a file in the claude dir) applies to every team,
 * and a team may override it with its own complete settings unit stored in its kanban state.
 * The TypeScript side mirrors these rules in src/features/review-flow/core/domain; a parity
 * test keeps both copies equal.
 */

const REVIEW_FLOW_AGENT_APPROVAL = 'agent_approval';
const REVIEW_FLOW_HUMAN_APPROVAL = 'human_approval';
const REVIEW_FLOWS = Object.freeze([REVIEW_FLOW_AGENT_APPROVAL, REVIEW_FLOW_HUMAN_APPROVAL]);
const DEFAULT_REVIEW_FLOW = REVIEW_FLOW_AGENT_APPROVAL;
const MAX_REVIEW_FLOW_PROMPT_LENGTH = 1000;
const REVIEW_FLOW_DEFAULTS_FILE = 'review-flow-defaults.json';
const DEFAULTS_CORRUPT_MESSAGE = 'Review flow defaults are corrupt';
const DEFAULTS_UNREADABLE_MESSAGE = 'Review flow defaults could not be read';

const BUILT_IN_SETTINGS = Object.freeze({
  reviewFlow: DEFAULT_REVIEW_FLOW,
  reviewFlowPrompt: '',
});

function isReviewFlow(value) {
  return REVIEW_FLOWS.includes(value);
}

/** Trims user-written flow instructions; empty text clears them. */
function normalizeReviewFlowPrompt(value) {
  if (typeof value !== 'string') throw new Error('reviewFlowPrompt must be a string');
  const prompt = value.trim();
  if (prompt.length > MAX_REVIEW_FLOW_PROMPT_LENGTH) {
    throw new Error(`reviewFlowPrompt must be at most ${MAX_REVIEW_FLOW_PROMPT_LENGTH} characters`);
  }
  return prompt;
}

/**
 * Strict parser of one complete settings unit. Throws on anything but an object with a known
 * `reviewFlow` and an optional string prompt. The result always carries a prompt ('' = none).
 */
function parseReviewFlowSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('review flow settings must be an object');
  }
  if (!isReviewFlow(raw.reviewFlow)) {
    throw new Error(`reviewFlow must be one of: ${REVIEW_FLOWS.join(', ')}`);
  }
  const reviewFlowPrompt =
    raw.reviewFlowPrompt === undefined ? '' : normalizeReviewFlowPrompt(raw.reviewFlowPrompt);
  return { reviewFlow: raw.reviewFlow, reviewFlowPrompt };
}

/** Same unit as persisted: the prompt key is omitted when empty. */
function toPersistedSettings(settings) {
  return {
    reviewFlow: settings.reviewFlow,
    ...(settings.reviewFlowPrompt ? { reviewFlowPrompt: settings.reviewFlowPrompt } : {}),
  };
}

/** An override replaces BOTH flow and prompt; the default prompt is never merged in. */
function resolvePolicy(defaults, override) {
  return override
    ? { reviewFlow: override.reviewFlow, reviewFlowPrompt: override.reviewFlowPrompt, source: 'team' }
    : { reviewFlow: defaults.reviewFlow, reviewFlowPrompt: defaults.reviewFlowPrompt, source: 'default' };
}

function isHumanApproval(policy) {
  return Boolean(policy) && policy.reviewFlow === REVIEW_FLOW_HUMAN_APPROVAL;
}

function getDefaultsPath(claudeDir) {
  if (typeof claudeDir !== 'string' || !claudeDir) {
    throw new Error('claudeDir is required to resolve review flow defaults');
  }
  return path.join(claudeDir, REVIEW_FLOW_DEFAULTS_FILE);
}

/**
 * Reads the global default. A missing file means the built-in default. Unparseable or invalid
 * content, and any other filesystem failure, throw: silently falling back to agent approval would
 * weaken a human-only policy. The two failures are reported differently so a broken file is not
 * confused with an unreadable one.
 */
function readDefaults(claudeDir) {
  let text;
  try {
    text = fs.readFileSync(getDefaultsPath(claudeDir), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ...BUILT_IN_SETTINGS };
    const code = error && error.code ? error.code : 'unknown';
    throw new Error(`${DEFAULTS_UNREADABLE_MESSAGE} (${code})`);
  }
  try {
    return parseReviewFlowSettings(JSON.parse(text));
  } catch {
    throw new Error(DEFAULTS_CORRUPT_MESSAGE);
  }
}

/** Validates and atomically replaces the global default. Returns the stored settings. */
function writeDefaults(claudeDir, settings) {
  const normalized = parseReviewFlowSettings(settings);
  writeJsonFileSync(getDefaultsPath(claudeDir), toPersistedSettings(normalized));
  return normalized;
}

module.exports = {
  BUILT_IN_SETTINGS,
  DEFAULT_REVIEW_FLOW,
  MAX_REVIEW_FLOW_PROMPT_LENGTH,
  REVIEW_FLOWS,
  REVIEW_FLOW_AGENT_APPROVAL,
  REVIEW_FLOW_DEFAULTS_FILE,
  REVIEW_FLOW_HUMAN_APPROVAL,
  isHumanApproval,
  isReviewFlow,
  normalizeReviewFlowPrompt,
  parseReviewFlowSettings,
  readDefaults,
  resolvePolicy,
  toPersistedSettings,
  writeDefaults,
};
