<script setup lang="ts">
import { comparisonRuNotes as ruNotes } from "~/data/comparisonNotes";
import robotAvatarCyan from "~/assets/images/hero/robots/robot-avatar-cyan-v1.webp";

const { t, locale } = useI18n()
const comparisonRobotRef = ref<HTMLElement | null>(null)
const showComparisonRobotBubble = ref(false)
let comparisonRobotObserver: IntersectionObserver | null = null
const comparisonScrollRef = ref<HTMLElement | null>(null)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)
let comparisonResizeObserver: ResizeObserver | null = null
const scrollLabels = computed(() => locale.value === 'ru'
  ? { hint: 'Прокрутите таблицу, чтобы увидеть все инструменты.', left: 'Влево', right: 'Вправо' }
  : { hint: 'Scroll the table to see every tool.', left: 'Left', right: 'Right' })

function updateScrollState(): void {
  const scroller = comparisonScrollRef.value
  if (!scroller) return
  canScrollLeft.value = scroller.scrollLeft > 1
  canScrollRight.value = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1
}

function scrollComparison(direction: -1 | 1, edge = false): void {
  const scroller = comparisonScrollRef.value
  if (!scroller) return
  const featureWidth = scroller.querySelector('th')?.getBoundingClientRect().width ?? 0
  const step = Math.max(40, scroller.clientWidth - featureWidth - 24)
  const left = edge ? (direction === -1 ? 0 : scroller.scrollWidth) : scroller.scrollLeft + direction * step
  scroller.scrollTo({ left, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
}

function onComparisonKeydown(event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  scrollComparison(event.key === 'ArrowLeft' || event.key === 'Home' ? -1 : 1, event.key === 'Home' || event.key === 'End')
}


function note(text: string): string {
  return locale.value === 'ru' ? (ruNotes[text] ?? text) : text
}

const sourcesPrefix = computed(() => (
  locale.value === 'ru'
    ? 'Факты Agent Teams проверены по локальному исходному коду 22 сентября 2026; источники остальных конкурентов проверены 22 сентября 2026; OpenRig v0.6.5 проверен 6 октября 2026:'
    : 'Agent Teams product facts checked in local source on September 22, 2026; other competitor sources checked on September 22, 2026; OpenRig v0.6.5 checked on October 6, 2026:'
))

const autonomyRatingNote = computed(() => (
  locale.value === 'ru'
    ? 'Это качественная редакционная оценка документированных возможностей общения, владения задачами, зависимостей, завершения работы и ревью, а не результат бенчмарка.'
    : 'Live collaboration scores are qualitative editorial assessments of documented communication, task ownership and dependencies, completion, and review capabilities, not benchmark results.'
))

const ruSourceLabels: Record<string, string> = {
  'Agent Teams organizations feature': 'фича организаций Agent Teams',
  'Agent Teams mixed-provider team lanes': 'mixed-provider команды Agent Teams',
  'Agent Teams cross-team messaging': 'межкомандные сообщения Agent Teams',
  'Agent Teams Kanban board': 'Kanban-доска Agent Teams',
  'Agent Teams terminal workspace': 'терминальный workspace Agent Teams',
  'Agent Teams token usage budgets': 'бюджеты расхода токенов Agent Teams',
  'Agent Teams budget alerts': 'бюджетные уведомления Agent Teams',
  'Agent Teams scheduled budget cap': 'лимит бюджета scheduled runs Agent Teams',
  'Agent Teams runtime/provider readiness detection': 'проверка готовности runtime и провайдеров Agent Teams',
  'Agent Teams local provider autodetection': 'автодетект локальных провайдеров Agent Teams',
  'Agent Teams Solo Mode': 'соло-режим Agent Teams',
  'Agent Teams Changes viewer': 'Changes viewer Agent Teams',
  'historical research notes (June 25, 2026)': 'исторические заметки исследования от 25 июня 2026',
  'Gastown provider guide': 'гайд по провайдерам Gastown',
  'Gastown scheduler': 'планировщик Gastown',
  'Gastown dashboard source': 'исходники dashboard Gastown',
  'Gastown release': 'релиз Gastown',
  'Paperclip adapters': 'адаптеры Paperclip',
  'Paperclip heartbeat protocol': 'heartbeat-протокол Paperclip',
  'Paperclip org chart': 'оргструктура Paperclip',
  'Paperclip OrgChart source': 'исходники OrgChart Paperclip',
  'Paperclip budgets': 'бюджеты Paperclip',
  'Paperclip runtime services': 'runtime services Paperclip',
  'Paperclip Kanban source': 'исходники Kanban Paperclip',
  'Paperclip work products': 'work products Paperclip',
  'Paperclip release': 'релиз Paperclip',
  'Cursor terminal': 'терминал Cursor',
  'Cursor Cloud Agents': 'cloud agents Cursor',
  'Cursor Agent Review': 'agent review Cursor',
  'Cursor worktrees': 'worktrees Cursor',
  'Cursor Agents Window': 'Agents Window Cursor',
  'Cursor subagents': 'субагенты Cursor',
  'Cursor Models & Pricing': 'модели и цены Cursor',
  'Cursor Team Pricing': 'team pricing Cursor',
  'Cursor pricing': 'тарифы Cursor',
  'Claude Code CLI': 'Claude Code CLI',
  'Claude Code agent teams': 'команды агентов Claude Code',
  'Claude Code cross-session messaging': 'cross-session messaging Claude Code',
  'Claude Code worktrees': 'worktrees Claude Code',
  'Claude Code subagents': 'сабагенты Claude Code',
  'Claude Code workflows': 'workflows Claude Code',
  'Claude Code costs': 'стоимость Claude Code',
  'Claude pricing': 'цены Claude',
  'Claude Code release': 'релиз Claude Code',
}

function sourceLabel(label: string): string {
  return locale.value === 'ru' ? (ruSourceLabels[label] ?? label) : label
}


interface CellValue {
  status: string
  note?: string
  noteLink?: string
  power?: number
}

interface ComparisonRow {
  feature: string
  us: CellValue
  gastown: CellValue
  paperclip: CellValue
  cursor: CellValue
  claudeCli: CellValue
  openrig: CellValue
}

const rows = computed<ComparisonRow[]>(() => [
  {
    feature: t('comparison.features.teamAutonomy'),
    us: { status: 'yes', power: 9, note: note('Live agents plan, delegate, work, and review together') },
    gastown: { status: 'yes', power: 8, note: note('Persistent teams with coordination and recovery') },
    paperclip: { status: 'partial', power: 7, note: note('Durable scheduled and event-triggered agents, less live peer teamwork') },
    cursor: { status: 'partial', power: 6, note: note('Parallel agents + subagents, no peer team') },
    claudeCli: { status: 'partial', power: 7, note: note('Experimental teams + cross-session messaging; recovery limits') },
    openrig: { status: 'yes', power: 8, note: note('Persistent roles, delegation, owned-work queues, and review handoffs') },
  },
  {
    feature: t('comparison.features.flexAutonomy'),
    us: { status: 'yes', note: note('Per-action approvals, roles, and notifications') },
    gastown: { status: 'yes', note: note('Gates, roles, escalation, and recovery') },
    paperclip: { status: 'yes', note: note('Board approvals, roles, pause, and stop') },
    cursor: { status: 'partial', note: note('Command controls and admin policies') },
    claudeCli: { status: 'yes', note: note('Permissions + hooks') },
    openrig: { status: 'yes', note: note('Native permissions, audited seat policies, typing guard, and stop controls') },
  },
  {
    feature: t('comparison.features.liveWorkGraph'),
    us: { status: 'yes', note: note('Teammates, tasks, blockers, handoffs, activity, logs') },
    gastown: { status: 'partial', note: note('Agent tree + feed panels') },
    paperclip: { status: 'partial', note: note('Org chart/status, not a task/log map') },
    cursor: { status: 'partial', note: note('Agents Window, no shared peer-team map') },
    claudeCli: { status: 'partial', note: note('Terminal team panel, no graphical UI') },
    openrig: { status: 'yes', note: note('TUI topology graph, seat state, missions, and activity feed') },
  },
  {
    feature: t('comparison.features.teamWorkspace'),
    us: { status: 'yes', note: note('Tasks, code, terminal, review, and teammates in one app') },
    gastown: { status: 'partial', note: note('Mail/feed/dashboard across tools') },
    paperclip: { status: 'partial', note: note('Board + task chats, less live teammate view') },
    cursor: { status: 'partial', note: note('Agents Window, no peer team workspace') },
    claudeCli: { status: 'partial', note: note('Terminal agent view, no graphical workspace') },
    openrig: { status: 'partial', note: note('TUI coordination + tmux terminals; optional maintenance web UI') },
  },
  {
    feature: t('comparison.features.zeroSetup'),
    us: { status: 'yes', note: note('Start free, no signup or API key') },
    gastown: { status: 'no', note: note('Manual CLI stack') },
    paperclip: { status: 'partial', note: note('npx onboarding + browser app') },
    cursor: { status: 'partial', note: note('App install + account') },
    claudeCli: { status: 'partial', note: note('CLI + env flag') },
    openrig: { status: 'partial', note: note('Node + tmux + provider login; guided setup on macOS/Linux') },
  },
  {
    feature: t('comparison.features.launchProof'),
    us: { status: 'yes', note: note('Clear ready/stuck status with launch diagnostics') },
    gastown: { status: 'yes', note: note('Working, stalled, and failed health with recovery controls') },
    paperclip: { status: 'partial', note: note('Run status and orphan recovery') },
    cursor: { status: 'partial', note: note('Agent status in Agents Window') },
    claudeCli: { status: 'partial', note: note('Agent view statuses, logs, stop/respawn in terminal') },
    openrig: { status: 'yes', note: note('Readiness checks, snapshots, and explicit per-seat restore outcomes') },
  },
  {
    feature: t('comparison.features.kanban'),
    us: { status: 'yes', note: note('5-column task board with review states and drag-and-drop ordering') },
    gastown: { status: 'no', note: note('Dashboard, not Kanban') },
    paperclip: { status: 'yes', note: note('7 columns, drag-and-drop') },
    cursor: { status: 'no' },
    claudeCli: { status: 'no' },
    openrig: { status: 'no', note: note('Owned-work queue and mission views; no Kanban board') },
  },
  {
    feature: t('comparison.features.reviewWorkflow'),
    us: { status: 'yes', note: note('Built-in Changes viewer with file/hunk accept, reject, edit, undo, and feedback') },
    gastown: { status: 'partial', note: note('Merge queue, no diff UI') },
    paperclip: { status: 'partial', note: note('Review gates, not inline code review') },
    cursor: { status: 'yes', note: note('Local Agent Review + PR Bugbot') },
    claudeCli: { status: 'partial', note: note('Agent review, no review UI') },
    openrig: { status: 'partial', note: note('Reviewer rigs and proof approvals; no task-level hunk review UI') },
  },
  {
    feature: t('comparison.features.crossTeam'),
    us: { status: 'yes', note: note('Direct agent messages and shared task links across teams') },
    gastown: { status: 'partial', note: note('Mailboxes + handoffs') },
    paperclip: { status: 'partial', note: note('Comments + @mentions') },
    cursor: { status: 'na' },
    claudeCli: { status: 'partial', note: note('Cross-machine/cloud session messaging, no shared cross-team task graph') },
    openrig: { status: 'yes', note: note('Cross-rig messages, broadcasts, chatrooms, and queue handoffs') },
  },
  {
    feature: t('comparison.features.linkedTasks'),
    us: { status: 'yes', note: note('Tasks can link to and block each other') },
    gastown: { status: 'yes', note: note('Task deps + grouped work') },
    paperclip: { status: 'yes', note: note('Goals, parent tasks, blockers') },
    cursor: { status: 'no' },
    claudeCli: { status: 'yes', note: note('Shared task list') },
    openrig: { status: 'yes', note: note('Queue blockers, workflow dependencies, and transactional handoffs') },
  },
  {
    feature: t('comparison.features.sessionAnalysis'),
    us: { status: 'yes', note: note('Agent messages, tool calls, timeline, token use, and cost') },
    gastown: { status: 'partial', note: note('Session recall, feed, metrics') },
    paperclip: { status: 'partial', note: note('Run transcripts + cost audit') },
    cursor: { status: 'partial', note: note('Agent chat, diffs, artifacts, and cloud diagnostics') },
    claudeCli: { status: 'partial', note: note('Transcripts, background logs, /usage, and /insights') },
    openrig: { status: 'yes', note: note('Activity feed, transcripts, queue audit, and runtime-dependent telemetry') },
  },
  {
    feature: t('comparison.features.orgGovernance'),
    us: { status: 'yes', note: note('Nested organizations with live team, task, relation, and communication map') },
    gastown: { status: 'partial', note: note('Roles + escalation, no org chart') },
    paperclip: { status: 'yes', note: note('Org chart + board governance') },
    cursor: { status: 'partial', note: note('Team admin only') },
    claudeCli: { status: 'no' },
    openrig: { status: 'partial', note: note('Rigs, pods, seats, and topology graph; no editable company org map') },
  },
  {
    feature: t('comparison.features.multiAgent'),
    us: { status: 'yes', note: note('Provider-aware teams with per-member models and mixed OpenCode side lanes') },
    gastown: { status: 'yes', note: note('Many providers, terminal-first') },
    paperclip: { status: 'yes', note: note('Bring your own agents/runtimes') },
    cursor: { status: 'partial', note: note('Multi-model parent + subagents, no peer team') },
    claudeCli: { status: 'partial', note: note('Claude-only experimental teams') },
    openrig: { status: 'yes', note: note('Claude Code, Codex, Pi, and Oh My Pi in mixed rigs') },
  },
  {
    feature: t('comparison.features.budgetControls'),
    us: { status: 'yes', note: note('Monthly budget alerts + optional cap for supported scheduled one-shot runs') },
    gastown: { status: 'partial', note: note('Cost tiers + digest, no hard caps') },
    paperclip: { status: 'yes', note: note('Per-agent budgets + hard stops') },
    cursor: { status: 'yes', note: note('User/team spend caps + cloud-agent spend limits') },
    claudeCli: { status: 'yes', note: note('Org/member spend limits + print-mode hard cap') },
    openrig: { status: 'partial', note: note('Token-burn/provider-window monitoring; no documented spend cap') },
  },
  {
    feature: t('comparison.features.worktree'),
    us: { status: 'yes', note: note('Optional separate workspace per teammate') },
    gastown: { status: 'yes', note: note('Core primitive') },
    paperclip: { status: 'yes', note: note('Worktrees / branches') },
    cursor: { status: 'yes', note: note('Agents Window worktrees') },
    claudeCli: { status: 'yes', note: note('Built-in for sessions and subagents') },
    openrig: { status: 'partial', note: note('Per-seat working directories; externally managed Git worktrees') },
  },
  {
    feature: t('comparison.features.integratedTerminal'),
    us: { status: 'yes', note: note('Built-in visual terminal for team and local commands') },
    gastown: { status: 'partial', note: note('Terminal-based workflow, no built-in terminal') },
    paperclip: { status: 'partial', note: note('Runs commands, no interactive terminal') },
    cursor: { status: 'yes', note: note('Built-in IDE terminal') },
    claudeCli: { status: 'partial', note: note('Runs in your terminal') },
    openrig: { status: 'yes', note: note('tmux + herdr/cmux integration; optional maintenance web terminal') },
  },
  {
    feature: t('comparison.features.codeEditor'),
    us: { status: 'yes', note: note('With Git support') },
    gastown: { status: 'no' },
    paperclip: { status: 'no', note: note('Control plane, not editor') },
    cursor: { status: 'yes', note: note('Full IDE') },
    claudeCli: { status: 'no' },
    openrig: { status: 'partial', note: note('Basic file editor in optional maintenance web UI') },
  },
  {
    feature: t('comparison.features.taskAttachments'),
    us: { status: 'yes', note: note('Auto-attach, agents read & attach') },
    gastown: { status: 'no', note: note('Not task-level') },
    paperclip: { status: 'yes', note: note('Docs, attachments, work products') },
    cursor: { status: 'partial', note: note('Prompt context, not task attachments') },
    claudeCli: { status: 'partial', note: note('Prompt files/images, not task attachments') },
    openrig: { status: 'partial', note: note('Queue evidence refs, proof media, and Slack file attachments') },
  },
  {
    feature: t('comparison.features.price'),
    us: { status: 'free', note: note('OSS + free model with no auth, paid providers optional') },
    gastown: { status: 'free', note: note('OSS, runtime plans needed') },
    paperclip: { status: 'free', note: note('OSS, self-hosted + infra') },
    cursor: { status: 'text', note: note('Free + paid usage') },
    claudeCli: { status: 'text', note: note('Claude plan or API usage') },
    openrig: { status: 'free', note: note('Apache-2.0 OSS; provider usage and hosting costs apply') },
  },
])

const competitors = [
  { key: 'us', name: 'Agent Teams', highlight: true },
  { key: 'gastown', name: 'Gas Town' },
  { key: 'paperclip', name: 'Paperclip' },
  { key: 'cursor', name: 'Cursor' },
  { key: 'claudeCli', name: 'Claude Code CLI' },
  { key: 'openrig', name: 'OpenRig' },
]

const sourceLinks = [
  { label: 'OpenRig v0.6.5 README', href: 'https://github.com/mvschwarz/openrig/blob/5ea35e93bca9460db94da0fc31afbc3716ea14ba/README.md' },
  { label: 'OpenRig coordination and queue', href: 'https://github.com/mvschwarz/openrig/blob/5ea35e93bca9460db94da0fc31afbc3716ea14ba/docs/as-built/architecture/coordination-primitive.md' },
  { label: 'OpenRig snapshot and restore', href: 'https://github.com/mvschwarz/openrig/blob/5ea35e93bca9460db94da0fc31afbc3716ea14ba/docs/as-built/architecture/lifecycle-snapshot-restore.md' },
  { label: 'OpenRig workspace model', href: 'https://github.com/mvschwarz/openrig/blob/5ea35e93bca9460db94da0fc31afbc3716ea14ba/docs/as-built/architecture/workspace-primitive.md' },
  { label: 'OpenRig basic web editor', href: 'https://github.com/mvschwarz/openrig/blob/5ea35e93bca9460db94da0fc31afbc3716ea14ba/packages/ui/src/components/files/FilesWorkspace.tsx' },
  { label: 'OpenRig comparison evidence', href: 'https://github.com/777genius/agent-teams-ai/blob/main/docs/research/openrig-comparison-2026-10-06.md' },

  { label: 'Agent Teams organizations feature', href: 'https://github.com/777genius/agent-teams-ai/blob/main/src/features/organizations/README.md' },
  { label: 'Agent Teams mixed-provider team lanes', href: 'https://github.com/777genius/agent-teams-ai/blob/main/src/features/team-runtime-lanes/core/domain/planTeamRuntimeLanes.ts' },
  { label: 'Agent Teams cross-team messaging', href: 'https://github.com/777genius/agent-teams-ai/blob/main/src/main/services/team/CrossTeamService.ts' },
  { label: 'Agent Teams Kanban board', href: 'https://github.com/777genius/agent-teams-ai/blob/main/src/renderer/components/team/kanban/KanbanBoard.tsx' },
  { label: 'Agent Teams terminal workspace', href: 'https://github.com/777genius/agent-teams-ai/blob/main/src/features/terminal-workspace/renderer/ui/TerminalWorkspacePanel.tsx' },
  { label: 'Agent Teams token usage budgets', href: 'https://github.com/777genius/agent-teams-ai/blob/main/src/features/token-usage/contracts/dto.ts' },
  { label: 'Agent Teams budget alerts', href: 'https://github.com/777genius/agent-teams-ai/blob/main/src/features/token-usage/core/application/TokenUsageBudgetNotificationEvaluator.ts' },
  { label: 'Agent Teams scheduled budget cap', href: 'https://github.com/777genius/agent-teams-ai/blob/main/src/main/services/schedule/ScheduledTaskExecutor.ts' },
  { label: 'Agent Teams runtime/provider readiness detection', href: 'https://github.com/777genius/agent-teams-ai/blob/main/src/main/services/infrastructure/CliInstallerService.ts' },
  { label: 'Agent Teams local provider autodetection', href: 'https://github.com/777genius/agent-teams-ai/blob/main/src/features/runtime-provider-management/main/infrastructure/OpenCodeLocalProviderConnector.ts' },
  { label: 'Agent Teams Solo Mode', href: 'https://github.com/777genius/agent-teams-ai/blob/main/src/renderer/components/team/dialogs/CreateTeamDialog.tsx' },
  { label: 'Agent Teams Changes viewer', href: 'https://github.com/777genius/agent-teams-ai/blob/main/src/renderer/components/team/review/ChangeReviewDialog.tsx' },
  { label: 'historical research notes (June 25, 2026)', href: 'https://github.com/777genius/agent-teams-ai/blob/main/docs/research/gastown-paperclip-comparison-2026-06-25.md' },
  { label: 'Gastown README', href: 'https://github.com/gastownhall/gastown' },
  { label: 'Gastown provider guide', href: 'https://github.com/gastownhall/gastown/blob/main/docs/agent-provider-integration.md' },
  { label: 'Gastown scheduler', href: 'https://github.com/gastownhall/gastown/blob/main/docs/design/scheduler.md' },
  {
    label: 'Gastown dashboard source',
    href: 'https://github.com/gastownhall/gastown/blob/main/internal/web/templates/convoy.html',
  },
  { label: 'Gastown release', href: 'https://github.com/gastownhall/gastown/releases/tag/v1.2.1' },
  { label: 'Paperclip README', href: 'https://github.com/paperclipai/paperclip' },
  {
    label: 'Paperclip adapters',
    href: 'https://github.com/paperclipai/paperclip/blob/master/docs/adapters/overview.md',
  },
  {
    label: 'Paperclip heartbeat protocol',
    href: 'https://github.com/paperclipai/paperclip/blob/master/docs/guides/agent-developer/heartbeat-protocol.md',
  },
  { label: 'Paperclip org chart', href: 'https://github.com/paperclipai/paperclip#the-systems' },
  {
    label: 'Paperclip OrgChart source',
    href: 'https://github.com/paperclipai/paperclip/blob/master/ui/src/pages/OrgChart.tsx',
  },
  {
    label: 'Paperclip budgets',
    href: 'https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/costs-and-budgets.md',
  },
  {
    label: 'Paperclip runtime services',
    href: 'https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/execution-workspaces-and-runtime-services.md',
  },
  {
    label: 'Paperclip Kanban source',
    href: 'https://github.com/paperclipai/paperclip/blob/master/ui/src/components/KanbanBoard.tsx',
  },
  {
    label: 'Paperclip work products',
    href: 'https://github.com/paperclipai/paperclip/blob/master/packages/shared/src/validators/work-product.ts',
  },
  { label: 'Paperclip release', href: 'https://github.com/paperclipai/paperclip/releases/tag/v2026.916.1' },
  { label: 'Cursor terminal', href: 'https://cursor.com/docs/agent/tools/terminal' },
  { label: 'Cursor Cloud Agents', href: 'https://cursor.com/docs/cloud-agent' },
  { label: 'Cursor Agent Review', href: 'https://cursor.com/docs/agent/agent-review' },
  { label: 'Cursor Bugbot', href: 'https://cursor.com/docs/bugbot' },
  { label: 'Cursor worktrees', href: 'https://cursor.com/docs/configuration/worktrees' },
  { label: 'Cursor Agents Window', href: 'https://cursor.com/docs/agent/agents-window' },
  { label: 'Cursor subagents', href: 'https://cursor.com/docs/subagents' },
  { label: 'Cursor Models & Pricing', href: 'https://cursor.com/docs/models-and-pricing' },
  { label: 'Cursor Team Pricing', href: 'https://cursor.com/docs/account/teams/pricing' },
  { label: 'Cursor pricing', href: 'https://cursor.com/pricing' },
  { label: 'Claude Code CLI', href: 'https://code.claude.com/docs/en/cli-usage' },
  { label: 'Claude Code agent teams', href: 'https://code.claude.com/docs/en/agent-teams' },
  { label: 'Claude Code cross-session messaging', href: 'https://code.claude.com/docs/en/cross-session-messaging' },
  { label: 'Claude Code worktrees', href: 'https://code.claude.com/docs/en/worktrees' },
  { label: 'Claude Code subagents', href: 'https://code.claude.com/docs/en/sub-agents' },
  { label: 'Claude Code workflows', href: 'https://code.claude.com/docs/en/workflows' },
  { label: 'Claude Code costs', href: 'https://code.claude.com/docs/en/costs' },
  { label: 'Claude pricing', href: 'https://claude.com/pricing' },
  { label: 'Claude Code release', href: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.278' },
]

onMounted(() => {
  if (comparisonScrollRef.value) {
    comparisonResizeObserver = new ResizeObserver(updateScrollState)
    comparisonResizeObserver.observe(comparisonScrollRef.value)
    updateScrollState()
  }
  if (!comparisonRobotRef.value) return

  comparisonRobotObserver = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return
      showComparisonRobotBubble.value = true
      comparisonRobotObserver?.disconnect()
      comparisonRobotObserver = null
    },
    {
      rootMargin: '0px 0px -12% 0px',
      threshold: 0.35,
    },
  )

  comparisonRobotObserver.observe(comparisonRobotRef.value)
})

onUnmounted(() => {
  comparisonResizeObserver?.disconnect()
  comparisonResizeObserver = null
  comparisonRobotObserver?.disconnect()
  comparisonRobotObserver = null
})

function getCellClass(cell: CellValue): string {
  switch (cell.status) {
    case 'yes': return 'comparison-table__cell--yes'
    case 'no': return 'comparison-table__cell--no'
    case 'partial': return 'comparison-table__cell--partial'
    case 'na': return 'comparison-table__cell--na'
    case 'free': return 'comparison-table__cell--free'
    case 'soon': return 'comparison-table__cell--soon'
    case 'text': return 'comparison-table__cell--text'
    default: return 'comparison-table__cell--text'
  }
}

function getStatusIcon(status: string): string {
  switch (status) {
    case 'yes': return '\u2713'
    case 'no': return '\u2717'
    case 'partial': return '\u25D2'
    case 'na': return locale.value === 'ru' ? 'Н/Д' : 'N/A'
    case 'free': return locale.value === 'ru' ? 'Бесплатно' : 'Free'
    case 'soon': return '\uD83D\uDCC5'
    default: return ''
  }
}

function getPowerBar(power: number): string {
  const normalizedPower = Math.max(0, Math.min(10, Math.round(power)))
  return `${'█'.repeat(normalizedPower)}${'░'.repeat(10 - normalizedPower)} ${normalizedPower}/10`
}

function getPowerLabel(power: number): string {
  return locale.value === 'ru'
    ? `Живая командная работа: ${power} из 10`
    : `Live team collaboration: ${power} out of 10`
}
</script>

<template>
  <section id="comparison" class="comparison-section section anchor-offset">
    <v-container>
      <div class="comparison-section__header">
        <h2 class="comparison-section__title">
          {{ t("comparison.sectionTitle") }}
        </h2>
        <p class="comparison-section__subtitle">
          {{ t("comparison.sectionSubtitle") }}
        </p>
      </div>

      <div class="comparison-table__wrap">
        <span
          ref="comparisonRobotRef"
          class="comparison-table__robot"
          aria-hidden="true"
        >
          <Transition name="comparison-robot-bubble">
            <RobotSpeechBubble
              v-if="showComparisonRobotBubble"
              class="comparison-table__robot-bubble"
              tail="right"
            >
              {{ t("comparison.robotBubble") }}
            </RobotSpeechBubble>
          </Transition>
          <img
            class="comparison-table__robot-image"
            :src="robotAvatarCyan"
            alt=""
            loading="lazy"
            decoding="async"
            draggable="false"
          >
        </span>
        <div class="comparison-table__toolbar">
          <p id="comparison-scroll-hint" class="comparison-table__scroll-hint">{{ scrollLabels.hint }}</p>
          <div class="comparison-table__scroll-controls">
            <button type="button" class="comparison-table__scroll-button" aria-controls="comparison-scroll" :disabled="!canScrollLeft" @click="scrollComparison(-1)">
              <span aria-hidden="true">←</span> {{ scrollLabels.left }}
            </button>
            <button type="button" class="comparison-table__scroll-button" aria-controls="comparison-scroll" :disabled="!canScrollRight" @click="scrollComparison(1)">
              {{ scrollLabels.right }} <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
        <div
          id="comparison-scroll"
          ref="comparisonScrollRef"
          class="comparison-table__scroll"
          role="region"
          :aria-label="t('comparison.sectionTitle')"
          aria-describedby="comparison-scroll-hint"
          tabindex="0"
          @scroll.passive="updateScrollState"
          @keydown.self="onComparisonKeydown"
        >
        <table class="comparison-table">
          <colgroup>
            <col class="comparison-table__feature-col">
            <col v-for="comp in competitors" :key="comp.key" class="comparison-table__tool-col">
          </colgroup>
          <thead>
            <tr>
              <th class="comparison-table__th comparison-table__th--feature">
                {{ t("comparison.feature") }}
              </th>
              <th
                v-for="comp in competitors"
                :key="comp.key"
                class="comparison-table__th"
                :class="{ 'comparison-table__th--highlight': comp.highlight }"
              >
                {{ comp.name }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in rows"
              :key="index"
              class="comparison-table__row"
            >
              <td class="comparison-table__td comparison-table__td--feature">
                {{ row.feature }}
              </td>
              <td
                v-for="comp in competitors"
                :key="comp.key"
                class="comparison-table__td"
                :class="[
                  getCellClass(row[comp.key as keyof ComparisonRow] as CellValue),
                  { 'comparison-table__td--highlight-col': comp.highlight }
                ]"
              >
                <div class="comparison-table__cell-inner">
                  <span class="comparison-table__cell-content">
                    <template v-if="(row[comp.key as keyof ComparisonRow] as CellValue).status === 'text'">
                      {{ (row[comp.key as keyof ComparisonRow] as CellValue).note }}
                    </template>
                    <template v-else>
                      {{ getStatusIcon((row[comp.key as keyof ComparisonRow] as CellValue).status) }}
                    </template>
                  </span>
                  <span
                    v-if="(row[comp.key as keyof ComparisonRow] as CellValue).power !== undefined"
                    class="comparison-table__power"
                    :aria-label="getPowerLabel((row[comp.key as keyof ComparisonRow] as CellValue).power!)"
                  >
                    {{ getPowerBar((row[comp.key as keyof ComparisonRow] as CellValue).power!) }}
                  </span>
                  <a
                    v-if="(row[comp.key as keyof ComparisonRow] as CellValue).noteLink && (row[comp.key as keyof ComparisonRow] as CellValue).status !== 'text'"
                    :href="(row[comp.key as keyof ComparisonRow] as CellValue).noteLink"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="comparison-table__cell-note comparison-table__cell-note--link"
                  >
                    {{ (row[comp.key as keyof ComparisonRow] as CellValue).note }}
                  </a>
                  <span
                    v-else-if="(row[comp.key as keyof ComparisonRow] as CellValue).note && (row[comp.key as keyof ComparisonRow] as CellValue).status !== 'text'"
                    class="comparison-table__cell-note"
                  >
                    {{ (row[comp.key as keyof ComparisonRow] as CellValue).note }}
                  </span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>

      <p class="comparison-section__rating-note">
        {{ autonomyRatingNote }}
      </p>

      <p class="comparison-section__sources">
        {{ sourcesPrefix }}
        <template v-for="(source, index) in sourceLinks" :key="source.href">
          <a :href="source.href" target="_blank" rel="noopener noreferrer">
            {{ sourceLabel(source.label) }}
          </a><span v-if="index < sourceLinks.length - 1">, </span>
        </template>.
      </p>
    </v-container>
  </section>
</template>

<style scoped>
.comparison-section {
  position: relative;
  --comparison-feature-width: 200px;
  --comparison-tool-width: 280px;
}

.comparison-section__header {
  text-align: center;
  max-width: 640px;
  margin: 0 auto 56px;
  position: relative;
  z-index: 1;
}

.comparison-section__title {
  font-size: 2.4rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.15;
  margin-bottom: 16px;
  background: linear-gradient(135deg, #e0e6ff 0%, #00f0ff 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.comparison-section__subtitle {
  font-size: 1.1rem;
  color: #8892b0;
  line-height: 1.6;
  margin: 0;
}

/* Table wrapper */
.comparison-table__wrap {
  border-radius: 16px;
  border: 1px solid rgba(0, 240, 255, 0.15);
  background: rgba(10, 10, 15, 0.6);
  backdrop-filter: blur(12px);
  position: relative;
  z-index: 1;
}

.comparison-table__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  color: #a8b4cf;
}

.comparison-table__scroll-hint {
  margin: 0;
  font-size: 0.8rem;
}

.comparison-table__scroll-controls {
  display: flex;
  gap: 8px;
}

.comparison-table__scroll-button {
  min-height: 44px;
  padding: 8px 14px;
  border: 1px solid currentColor;
  border-radius: 8px;
  color: #00d4e6;
  background: transparent;
  font-size: 0.85rem;
  cursor: pointer;
}

.comparison-table__scroll-button:disabled {
  opacity: 0.4;
  cursor: default;
}

.comparison-table__scroll {
  max-height: min(72vh, 820px);
  overflow: auto;
  scroll-padding-left: var(--comparison-feature-width);
  border-radius: 0 0 16px 16px;
  scrollbar-color: #0891b2 transparent;
}

.comparison-table__scroll:focus-visible,
.comparison-table__scroll-button:focus-visible {
  outline: 2px solid #0891b2;
  outline-offset: -2px;
}

.comparison-table__feature-col {
  width: var(--comparison-feature-width);
}

.comparison-table__tool-col {
  width: var(--comparison-tool-width);
}

.comparison-table__robot {
  position: absolute;
  right: clamp(28px, 7vw, 96px);
  bottom: calc(100% - 4px);
  z-index: 4;
  width: clamp(82px, 7.2vw, 124px);
  height: auto;
  pointer-events: none;
  user-select: none;
  transform: translateY(4px) rotate(-0.5deg);
  transform-origin: center bottom;
  animation: comparisonRobotIdle 5.2s ease-in-out infinite;
  filter:
    drop-shadow(0 18px 22px rgba(0, 0, 0, 0.5))
    drop-shadow(0 0 18px rgba(0, 234, 255, 0.26));
}

.comparison-table__robot-image {
  display: block;
  width: 100%;
  height: auto;
  transform:
    scaleX(-1)
    rotate(2deg);
  transform-origin: center bottom;
  user-select: none;
}

.comparison-table__robot::selection {
  background: transparent;
}

.comparison-table__robot-bubble {
  --robot-bubble-position: absolute;
  --robot-bubble-min-width: 96px;
  --robot-bubble-max-width: 190px;
  --robot-bubble-min-height: 42px;
  --robot-bubble-font-size: 0.66rem;
  --robot-bubble-padding: 8px 26px 8px 13px;

  top: 10px;
  right: calc(100% + 12px);
  transform: rotate(-5deg);
  transform-origin: right bottom;
  animation: comparisonRobotBubbleFloat 2.6s ease-in-out 0.42s infinite;
}

.comparison-robot-bubble-enter-active,
.comparison-robot-bubble-leave-active {
  transition:
    opacity 0.26s ease,
    filter 0.26s ease;
}

.comparison-robot-bubble-enter-active {
  animation: comparisonRobotBubblePop 0.52s cubic-bezier(0.18, 0.9, 0.2, 1.24);
}

.comparison-robot-bubble-enter-from,
.comparison-robot-bubble-leave-to {
  opacity: 0;
  filter: blur(2px);
}

@keyframes comparisonRobotIdle {
  0%,
  100% {
    transform: translate3d(0, 4px, 0) rotate(-0.55deg);
  }

  50% {
    transform: translate3d(1px, 3px, 0) rotate(0.75deg);
  }
}

@keyframes comparisonRobotBubblePop {
  0% {
    opacity: 0;
    transform: translate3d(14px, 18px, 0) scale(0.48) rotate(-13deg);
  }

  58% {
    opacity: 1;
    transform: translate3d(-3px, -4px, 0) scale(1.1) rotate(-4deg);
  }

  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1) rotate(-5deg);
  }
}

@keyframes comparisonRobotBubbleFloat {
  0%,
  100% {
    transform: translate3d(0, 0, 0) rotate(-5deg);
  }

  50% {
    transform: translate3d(0, -2px, 0) rotate(-4deg);
  }
}

.comparison-section__sources {
  max-width: 1040px;
  margin: 18px auto 0;
  color: rgba(136, 146, 176, 0.82);
  font-size: 0.78rem;
  line-height: 1.65;
  position: relative;
  z-index: 1;
}

.comparison-section__rating-note {
  max-width: 1040px;
  margin: 12px auto 0;
  color: rgba(136, 146, 176, 0.9);
  font-size: 0.75rem;
  line-height: 1.4;
  text-align: center;
}

.comparison-section__sources a {
  color: #00d4e6;
  text-decoration: none;
}

.comparison-section__sources a:hover {
  color: #00f0ff;
  text-decoration: underline;
}

.comparison-table {
  width: 100%;
  border-collapse: collapse;
  min-width: calc(var(--comparison-feature-width) + 6 * var(--comparison-tool-width));
  table-layout: fixed;
  font-size: 0.85rem;
}

/* Header */
.comparison-table thead {
  position: static;
}

.comparison-table__th {
  position: sticky;
  top: 0;
  z-index: 3;
  padding: 16px 12px;
  text-align: center;
  font-weight: 600;
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #8892b0;
  border-bottom: 1px solid rgba(0, 240, 255, 0.1);
  white-space: nowrap;
  font-family: "JetBrains Mono", monospace;
  background: rgb(10, 10, 15);
}

.comparison-table__th--feature {
  text-align: left;
  padding-left: 20px;
  white-space: normal;
}

.comparison-table__th--highlight {
  color: #00f0ff;
  background: rgba(0, 18, 20, 0.97);
  z-index: 4;
}

.comparison-table__th--highlight::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, #00f0ff, #39ff14);
}

/* Rows */
.comparison-table__row {
  transition: background-color 0.15s ease;
}

.comparison-table__row:hover {
  background: rgba(0, 240, 255, 0.03);
}

.comparison-table__row:not(:last-child) .comparison-table__td {
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

/* Cells */
.comparison-table__td {
  padding: 10px 8px;
  text-align: center;
  vertical-align: middle;
}

.comparison-table__td--feature {
  text-align: left;
  padding-left: 20px;
  color: #e0e6ff;
  font-weight: 500;
  font-size: 0.85rem;
}

.comparison-table__th--feature,
.comparison-table__td--feature {
  position: sticky;
  left: 0;
  z-index: 2;
  background: rgb(10, 10, 15);
  box-shadow: 1px 0 rgba(0, 240, 255, 0.15);
}

.comparison-table__th--feature {
  z-index: 5;
}

.comparison-table__td--highlight-col {
  background: rgba(0, 240, 255, 0.04);
}

.comparison-table__cell-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}

.comparison-table__cell-content {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 700;
}

.comparison-table__cell-note {
  font-size: 0.78rem;
  color: #6b7994;
  line-height: 1.3;
  max-width: calc(var(--comparison-tool-width) - 32px);
  text-align: center;
  white-space: normal;
}

.comparison-table__power {
  color: #00d4e6;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1.2;
  white-space: nowrap;
}

.comparison-table__cell-note--link {
  color: #00d4e6;
  text-decoration: underline;
  text-decoration-color: rgba(0, 212, 230, 0.3);
  text-underline-offset: 2px;
  transition: color 0.2s ease, text-decoration-color 0.2s ease;
}

.comparison-table__cell-note--link:hover {
  color: #00f0ff;
  text-decoration-color: rgba(0, 240, 255, 0.6);
}

/* Cell status variants */
.comparison-table__cell--yes .comparison-table__cell-content {
  color: #39ff14;
  background: rgba(57, 255, 20, 0.1);
}

.comparison-table__cell--no .comparison-table__cell-content {
  color: #ff4757;
  background: rgba(255, 71, 87, 0.08);
  opacity: 0.6;
}

.comparison-table__cell--partial .comparison-table__cell-content {
  color: #ffd700;
  background: rgba(255, 215, 0, 0.08);
}

.comparison-table__cell--na .comparison-table__cell-content {
  color: #4a5568;
  background: transparent;
}

.comparison-table__cell--soon .comparison-table__cell-content {
  width: auto;
  padding: 4px 10px;
  font-size: 0.75rem;
  color: #00f0ff;
  background: rgba(0, 240, 255, 0.08);
  font-family: "JetBrains Mono", monospace;
}

.comparison-table__cell--free .comparison-table__cell-content,
.comparison-table__cell--text .comparison-table__cell-content {
  width: auto;
  padding: 4px 10px;
  font-size: 0.75rem;
  font-family: "JetBrains Mono", monospace;
  letter-spacing: 0.04em;
}

.comparison-table__cell--free .comparison-table__cell-content {
  color: #39ff14;
  background: rgba(57, 255, 20, 0.1);
}

.comparison-table__cell--text .comparison-table__cell-content {
  color: #8892b0;
  background: rgba(255, 255, 255, 0.04);
}

/* Highlight column — our product */
.comparison-table__td--highlight-col.comparison-table__cell--yes .comparison-table__cell-content {
  box-shadow: 0 0 12px rgba(57, 255, 20, 0.2);
}

.comparison-table__td--highlight-col.comparison-table__cell--free .comparison-table__cell-content {
  box-shadow: 0 0 12px rgba(57, 255, 20, 0.2);
}

/* Light theme */
.v-theme--light .comparison-section__title {
  background: linear-gradient(135deg, #1e293b 0%, #0891b2 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.v-theme--light .comparison-section__subtitle {
  color: #475569;
}

.v-theme--light .comparison-table__toolbar {
  color: #475569;
}

.v-theme--light .comparison-table__scroll-button {
  color: #0e7490;
}

.v-theme--light .comparison-table__th--feature,
.v-theme--light .comparison-table__td--feature {
  background: #fff;
}

.v-theme--light .comparison-table__wrap {
  background: rgba(255, 255, 255, 0.8);
  border-color: rgba(0, 180, 200, 0.2);
}

.v-theme--light .comparison-section__sources {
  color: rgba(71, 85, 105, 0.82);
}

.v-theme--light .comparison-section__sources a {
  color: #0891b2;
}

.v-theme--light .comparison-section__sources a:hover {
  color: #0e7490;
}

.v-theme--light .comparison-table__th {
  color: #64748b;
  border-bottom-color: rgba(0, 0, 0, 0.08);
  background: #fff;
}

.v-theme--light .comparison-table__th--highlight {
  color: #0891b2;
  background: rgba(240, 253, 255, 0.97);
}

.v-theme--light .comparison-table__th--highlight::after {
  background: linear-gradient(90deg, #0891b2, #059669);
}

.v-theme--light .comparison-table__td--feature {
  color: #1e293b;
}

.v-theme--light .comparison-table__row:hover {
  background: rgba(8, 145, 178, 0.03);
}

.v-theme--light .comparison-table__row:not(:last-child) .comparison-table__td {
  border-bottom-color: rgba(0, 0, 0, 0.05);
}

.v-theme--light .comparison-table__td--highlight-col {
  background: rgba(8, 145, 178, 0.04);
}

.v-theme--light .comparison-table__cell-note {
  color: #64748b;
}

.v-theme--light .comparison-table__cell-note--link {
  color: #0891b2;
  text-decoration-color: rgba(8, 145, 178, 0.3);
}

.v-theme--light .comparison-table__cell-note--link:hover {
  color: #0e7490;
  text-decoration-color: rgba(14, 116, 144, 0.6);
}

.v-theme--light .comparison-table__cell--yes .comparison-table__cell-content {
  color: #059669;
  background: rgba(5, 150, 105, 0.1);
  text-shadow: none;
}

.v-theme--light .comparison-table__cell--no .comparison-table__cell-content {
  color: #dc2626;
  background: rgba(220, 38, 38, 0.06);
}

.v-theme--light .comparison-table__cell--partial .comparison-table__cell-content {
  color: #d97706;
  background: rgba(217, 119, 6, 0.08);
}

.v-theme--light .comparison-table__cell--free .comparison-table__cell-content {
  color: #059669;
  background: rgba(5, 150, 105, 0.1);
  text-shadow: none;
}

.v-theme--light .comparison-table__cell--soon .comparison-table__cell-content {
  color: #0891b2;
  background: rgba(8, 145, 178, 0.08);
}

.v-theme--light .comparison-table__cell--text .comparison-table__cell-content {
  color: #64748b;
  background: rgba(0, 0, 0, 0.04);
}

/* Responsive */
@media (max-width: 960px) {
  .comparison-section__title {
    font-size: 1.85rem;
  }

  .comparison-section__header {
    margin-bottom: 40px;
  }

  .comparison-section__subtitle {
    font-size: 1rem;
  }
}

@media (max-width: 600px) {
  .comparison-section {
    --comparison-feature-width: 144px;
    --comparison-tool-width: 220px;
  }

  .comparison-section__title {
    font-size: 1.6rem;
  }

  .comparison-section__header {
    margin-bottom: 32px;
  }

  .comparison-table {
    font-size: 0.8rem;
  }

  .comparison-table__th {
    padding: 12px 8px;
    font-size: 0.7rem;
  }

  .comparison-table__td {
    padding: 8px 6px;
  }

  .comparison-table__td--feature {
    padding-left: 14px;
    font-size: 0.8rem;
  }

  .comparison-table__cell-note {
    font-size: 0.7rem;
  }
}
</style>
