import type { CommandItem } from '../../../core/domain/models/CommandItem';
import type { CommandProvider } from '../../../core/domain/models/CommandProvider';

const STATIC_ACTIONS: readonly CommandItem[] = [
  {
    id: 'open-dashboard',
    providerId: 'static-actions',
    category: 'action',
    icon: 'dashboard',
    title: 'Open dashboard',
    subtitle: 'Go to the main overview',
    keywords: ['home', 'overview', 'main'],
    priority: 50,
    intent: { type: 'tab.open', tab: 'dashboard' },
  },
  {
    id: 'open-teams',
    providerId: 'static-actions',
    category: 'action',
    icon: 'team',
    title: 'Open teams',
    subtitle: 'Show all agent teams',
    keywords: ['agents', 'team list', 'create team'],
    priority: 48,
    intent: { type: 'tab.open', tab: 'teams' },
  },
  {
    id: 'open-settings',
    providerId: 'static-actions',
    category: 'settings',
    icon: 'settings',
    title: 'Open settings',
    subtitle: 'General app settings',
    keywords: ['preferences', 'configuration'],
    priority: 42,
    intent: { type: 'tab.open', tab: 'settings' },
  },
  {
    id: 'open-provider-settings',
    providerId: 'static-actions',
    category: 'settings',
    icon: 'settings',
    title: 'Open provider settings',
    subtitle: 'Runtime and provider configuration',
    keywords: ['anthropic', 'codex', 'gemini', 'opencode', 'models', 'connection'],
    priority: 44,
    intent: { type: 'tab.open', tab: 'settings', settingsSection: 'connection' },
  },
  {
    id: 'open-notifications',
    providerId: 'static-actions',
    category: 'action',
    icon: 'notifications',
    title: 'Open notifications',
    subtitle: 'Review detected errors and alerts',
    keywords: ['alerts', 'errors'],
    priority: 38,
    intent: { type: 'tab.open', tab: 'notifications' },
  },
  {
    id: 'open-schedules',
    providerId: 'static-actions',
    category: 'action',
    icon: 'schedules',
    title: 'Open schedules',
    subtitle: 'Manage recurring team runs',
    keywords: ['automation', 'cron', 'runs'],
    priority: 36,
    intent: { type: 'tab.open', tab: 'schedules' },
  },
  {
    id: 'open-extensions',
    providerId: 'static-actions',
    category: 'action',
    icon: 'extensions',
    title: 'Open extensions',
    subtitle: 'Plugins, MCP servers, skills, and API keys',
    keywords: ['plugins', 'mcp', 'skills', 'api keys'],
    priority: 34,
    intent: { type: 'tab.open', tab: 'extensions' },
  },
];

export function createStaticActionsProvider(): CommandProvider {
  return {
    id: 'static-actions',
    match: () => STATIC_ACTIONS,
  };
}
