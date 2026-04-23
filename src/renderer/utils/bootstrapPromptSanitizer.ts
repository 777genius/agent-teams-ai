import { displayMemberName } from '@renderer/utils/memberHelpers';
import {
  doesTeamModelCarryProviderBrand,
  getTeamModelLabel,
  getTeamProviderLabel,
} from '@renderer/utils/teamModelCatalog';

import type { InboxMessage, TeamProviderId } from '@shared/types';

const BOOTSTRAP_REQUIRED_MARKER_SETS = [
  [
    'Your FIRST action: call MCP tool member_briefing',
    'Do NOT start work, claim tasks, or improvise workflow/task/process rules before member_briefing succeeds.',
  ],
  [
    'Your FIRST action: call MCP tool member_briefing',
    'The team has already been created and you are being attached as a persistent teammate.',
  ],
  [
    'Your FIRST action: call MCP tool member_briefing',
    'The team has already been reconnected and you are being re-attached as a persistent teammate.',
  ],
] as const;

const BOOTSTRAP_SUPPORTING_MARKERS = [
  'If member_briefing fails, send',
  'member_briefing is expected to be available in your initial MCP tool list.',
  'IMPORTANT: When sending messages to the team lead',
  'Call member_briefing directly yourself. Do NOT use Agent',
  'wait for instructions from the lead and use team mailbox/task tools normally',
  'resume your queue normally and prioritize already-assigned board work',
] as const;

function parseProviderId(value: string | undefined): TeamProviderId | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'anthropic' ||
    normalized === 'codex' ||
    normalized === 'gemini' ||
    normalized === 'opencode'
  ) {
    return normalized;
  }
  return null;
}

function getTeamEffortLabel(effort: string | undefined): string {
  const trimmed = effort?.trim() ?? '';
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : 'Default';
}

function matchField(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

function matchOverrideField(
  text: string,
  fieldName: 'Provider override' | 'Model override' | 'Effort override'
): string | undefined {
  const fieldPattern = new RegExp(`${fieldName}(?: for this teammate)?:\\s*`, 'i');
  const fieldMatch = fieldPattern.exec(text);
  if (!fieldMatch) {
    return undefined;
  }

  const rest = text.slice(fieldMatch.index + fieldMatch[0].length);
  const nextOverrideMatch =
    /\.\s+(?:Provider override|Model override|Effort override)(?: for this teammate)?:/i.exec(rest);
  const newlineIndex = rest.indexOf('\n');
  const stopCandidates = [
    nextOverrideMatch?.index,
    newlineIndex >= 0 ? newlineIndex : undefined,
  ].filter((index): index is number => typeof index === 'number' && index >= 0);
  const end = stopCandidates.length > 0 ? Math.min(...stopCandidates) : rest.length;
  const value = rest.slice(0, end).trim().replace(/\.$/, '').trim();
  return value ? value : undefined;
}

function buildRuntimeSummary(
  providerId: TeamProviderId | null,
  model: string | undefined,
  effort: string | undefined
): string | undefined {
  if (providerId) {
    const providerLabel = getTeamProviderLabel(providerId) ?? 'Anthropic';
    const modelLabel = model ? (getTeamModelLabel(model) ?? model) : 'Default';
    const effortLabel = effort ? getTeamEffortLabel(effort) : undefined;
    const modelAlreadyCarriesProviderBrand = doesTeamModelCarryProviderBrand(
      providerId,
      modelLabel
    );

    const providerActsAsBackendOnly =
      providerId !== 'anthropic' && modelLabel !== 'Default' && !modelAlreadyCarriesProviderBrand;

    const parts = modelAlreadyCarriesProviderBrand
      ? [modelLabel, effortLabel]
      : providerActsAsBackendOnly
        ? [modelLabel, `via ${providerLabel}`, effortLabel]
        : [providerLabel, modelLabel, effortLabel];
    return parts.filter(Boolean).join(' · ');
  }

  const modelLabel = model ? (getTeamModelLabel(model) ?? model) : '';
  const effortLabel = effort ? getTeamEffortLabel(effort) : '';
  const providerLabel = providerId ? (getTeamProviderLabel(providerId) ?? '') : '';
  return [providerLabel, modelLabel, effortLabel].filter(Boolean).join(' · ') || undefined;
}

export interface BootstrapPromptDisplay {
  teammateName?: string;
  teamName?: string;
  runtime?: string;
  summary: string;
  body: string;
}

export interface BootstrapAcknowledgementDisplay {
  teammateName?: string;
  teamName?: string;
  summary: string;
  body: string;
}

export function getBootstrapPromptDisplay(
  message: Pick<InboxMessage, 'text' | 'to'>
): BootstrapPromptDisplay | null {
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const hasRequiredMarkers = BOOTSTRAP_REQUIRED_MARKER_SETS.some((markerSet) =>
    markerSet.every((marker) => text.includes(marker))
  );
  const hasSupportingMarker = BOOTSTRAP_SUPPORTING_MARKERS.some((marker) => text.includes(marker));
  if (!text.startsWith('You are ') || !hasRequiredMarkers || !hasSupportingMarker) {
    return null;
  }

  const teammateName =
    matchField(text, /^You are\s+([^,\n]+),/m) ??
    (typeof message.to === 'string' ? message.to.trim() : undefined);
  const teamName = matchField(text, /on team "([^"]+)"/);
  const providerId = parseProviderId(matchOverrideField(text, 'Provider override'));
  const model = matchOverrideField(text, 'Model override');
  const effort = matchOverrideField(text, 'Effort override');
  const runtime = buildRuntimeSummary(providerId, model, effort);
  const displayName = teammateName ? displayMemberName(teammateName) : 'teammate';
  const summary = `Starting ${displayName}`;
  const bodyLines = [`Lead is starting \`${displayName}\` as a teammate.`];

  if (runtime) {
    bodyLines.push(`Runtime: ${runtime}`);
  } else if (teamName) {
    bodyLines.push(`Team: \`${teamName}\``);
  }

  bodyLines.push('Startup instructions are hidden in the UI.');

  return {
    teammateName,
    teamName,
    runtime,
    summary,
    body: bodyLines.join('\n\n'),
  };
}

export function getBootstrapAcknowledgementDisplay(
  message: Pick<InboxMessage, 'text' | 'from'>
): BootstrapAcknowledgementDisplay | null {
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return null;
  }

  const markers = [
    "'concerns':",
    "'existingRelationships':",
    "'hasBootstrapGuidance':",
    "'hasAcknowledged':",
    "'isTeamLead':",
    "'memberName':",
    "'teamName':",
  ];
  if (!markers.every((marker) => text.includes(marker))) {
    return null;
  }

  const teammateName =
    matchField(text, /'memberName':\s*'([^']+)'/) ??
    (typeof message.from === 'string' ? message.from.trim() : undefined);
  const teamName = matchField(text, /'teamName':\s*'([^']+)'/);
  const displayName = teammateName ? displayMemberName(teammateName) : 'teammate';

  return {
    teammateName,
    teamName,
    summary: `${displayName} acknowledged bootstrap`,
    body: `${displayName} acknowledged bootstrap.`,
  };
}

export function getSanitizedInboxMessageText(message: Pick<InboxMessage, 'text' | 'to'>): string {
  return (
    getBootstrapPromptDisplay(message)?.body ??
    getBootstrapAcknowledgementDisplay(message as Pick<InboxMessage, 'text' | 'from'>)?.body ??
    message.text ??
    ''
  );
}

export function getSanitizedInboxMessageSummary(
  message: Pick<InboxMessage, 'text' | 'to' | 'from' | 'summary'>
): string {
  return (
    getBootstrapPromptDisplay(message)?.summary ??
    getBootstrapAcknowledgementDisplay(message)?.summary ??
    message.summary ??
    ''
  );
}
