<script setup lang="ts">
import robotAvatarCyan from "~/assets/images/hero/robots/robot-avatar-cyan-v1.webp";

const { t, locale } = useI18n()
const comparisonRobotRef = ref<HTMLElement | null>(null)
const showComparisonRobotBubble = ref(false)
let comparisonRobotObserver: IntersectionObserver | null = null

const ruNotes: Record<string, string> = {
  'Messages between separate teams': 'Сообщения между отдельными командами',
  'Coordination across groups': 'Координация между группами',
  'Company-scoped org work': 'Оргработа на уровне компании',
  'Native real-time mailbox': 'Нативный mailbox в реальном времени',
  'Mailboxes + handoffs': 'Mailbox и handoff',
  'Comments + @mentions': 'Комментарии и @mentions',
  'Team mailbox, no UI': 'Командный mailbox, без UI',
  'Tasks can link to and block each other': 'Задачи могут связываться и блокировать друг друга',
  'Task deps + grouped work': 'Зависимости задач и группировка работ',
  'Goals, parent tasks, blockers': 'Цели, родительские задачи, блокеры',
  'Shared task list': 'Общий список задач',
  'Task logs + token usage': 'Логи задач и расход токенов',
  'Session recall, feed, metrics': 'Память сессий, лента, метрики',
  'Run transcripts + cost audit': 'Транскрипты запусков и аудит стоимости',
  'Run transcripts + audit log': 'Транскрипты запусков и журнал аудита',
  'Usage command, no UI': 'Команда usage, без UI',
  'Auto-attach, agents read & attach': 'Автоприкрепление, агенты читают и добавляют вложения',
  'Not task-level': 'Не на уровне задач',
  'Docs, attachments, work products': 'Документы, вложения, рабочие артефакты',
  'Chat session only': 'Только сессия чата',
  'Chat images only': 'Только изображения в чате',
  'Accept / reject individual hunks': 'Принятие или отклонение отдельных фрагментов',
  'Bring your own review': 'Ревью нужно делать отдельно',
  'With Git support': 'С поддержкой Git',
  'Control plane, not editor': 'Панель управления, не редактор',
  'Full IDE': 'Полная IDE',
  'Plan, assign, work, and review': 'Планирует, назначает, работает и ревьюит',
  'Coordinator, grouped work, recovery': 'Координатор, группировка работ, восстановление',
  'Wake-up runs + governance': 'Отложенные запуски и управление',
  'Cloud agents, not teams': 'Cloud agents, не команды',
  'Experimental CLI teams': 'Экспериментальные CLI-команды',
  'Tasks wait for blockers automatically': 'Задачи автоматически ждут блокеры',
  'Dependency waves': 'Волны зависимостей',
  'Blockers + execution locks': 'Блокеры и execution locks',
  'Team task deps, no UI': 'Зависимости командных задач, без UI',
  'Agents review each other': 'Агенты ревьюят друг друга',
  'Merge queue': 'Merge queue',
  'Merge queue, no diff UI': 'Merge queue, без diff UI',
  'Approvals + governance': 'Подтверждения и управление',
  'PR/BugBot only': 'Только PR/BugBot',
  'Team review, no UI': 'Командное ревью, без UI',
  'Guided runtime setup': 'Пошаговая настройка runtime',
  'Manual CLI stack': 'Ручной CLI-стек',
  'npx + local database': 'npx и локальная база',
  'CLI + env flag': 'CLI и env-флаг',
  '5 columns, real-time': '5 колонок, в реальном времени',
  'Dashboard, not Kanban': 'Панель, не канбан',
  '7 columns, drag-and-drop': '7 колонок, перетаскивание',
  'Tools, reasoning trace, and timeline': 'Инструменты, ход рассуждений и таймлайн',
  'Feed, metrics, dashboard': 'Лента, метрики, панель',
  'Agent chat + terminal': 'Чат агента и терминал',
  'View, stop, open URLs': 'Просмотр, остановка, открытие URL',
  'Agent health dashboard': 'Dashboard здоровья агентов',
  'Manual services + previews': 'Ручные сервисы и previews',
  'Native terminal only': 'Только нативный терминал',
  'CPU/RAM history for each live teammate': 'История CPU/RAM для каждого живого участника',
  'Activity/health, not CPU/RAM': 'Активность/здоровье, не CPU/RAM',
  'Run status/cost, not CPU/RAM': 'Статус/стоимость запуска, не CPU/RAM',
  'Remote agent/terminal only': 'Только remote agent/terminal',
  'Accept / reject / comment': 'Принять, отклонить или прокомментировать',
  'PR/work products, no diff UI': 'PR/рабочие артефакты, без diff UI',
  'BugBot on PRs': 'BugBot для PR',
  'Per-action approvals + notifications': 'Подтверждения и уведомления для каждого действия',
  'Проверки, эскалация, восстановление': 'Проверки, эскалация, восстановление',
  'Подтверждения на доске, пауза, остановка': 'Подтверждения на доске, пауза, остановка',
  'Cloud agents run commands': 'Cloud agents запускают команды',
  'Permissions + hooks': 'Permissions и hooks',
  'Optional': 'Опционально',
  'Core primitive': 'Ключевая примитивная модель',
  'Worktrees / branches': 'Worktrees / branches',
  'Agents Window worktrees': 'Worktrees в Agents Window',
  'Manual worktrees': 'Ручные worktrees',
  'Claude, Codex, and OpenCode in one team': 'Claude, Codex и OpenCode в одной команде',
  'Many providers, terminal-first': 'Много провайдеров, terminal-first',
  'Bring your own agents/runtimes': 'Подключайте своих агентов и runtimes',
  'Multi-model agents, no shared team': 'Мультимодельные агенты, без общей команды',
  'Claude-only experimental teams': 'Экспериментальные команды только для Claude',
  'Teammates, tasks, blockers, handoffs, activity, logs': 'Участники, задачи, блокеры, передачи, активность, логи',
  'Agent tree + feed panels': 'Дерево агентов и панели ленты',
  'Org chart/status, not a task/log map': 'Оргструктура/статус, не карта задач и логов',
  'Watch teammates work and message them directly': 'Смотрите работу участников и пишите им напрямую',
  'Terminal-based agent sessions': 'Терминальные сессии агентов',
  'Agents wake up for runs, then sleep': 'Агенты просыпаются для запусков, потом засыпают',
  'Cloud agents per task': 'Cloud agents на задачу',
  'CLI teams, no desktop view': 'CLI-команды, без desktop-экрана',
  'Tasks, logs, Kanban, review, and teammates in one app': 'Задачи, логи, канбан, ревью и участники в одном приложении',
  'Mail/feed/dashboard across tools': 'Почта, лента и панель между tools',
  'Board + transcripts, less live teammate view': 'Доска и транскрипты, меньше live-вида участников',
  'IDE chats/tasks, not team view': 'IDE-чаты/задачи, не командный вид',
  'No desktop UI': 'Нет desktop UI',
  'Know who started, who is stuck, and who replied': 'Видно кто стартовал, кто застрял и кто ответил',
  'Session health, less clear message status': 'Здоровье сессии, менее ясный статус сообщений',
  'Run status, not live teammate status': 'Статус запуска, не live-статус участника',
  'CLI mailbox, no visual status': 'CLI mailbox, без визуального статуса',
  'Organization map + approvals': 'Оргкарта и подтверждения',
  'Roles + approvals, no org chart': 'Роли и подтверждения, без оргструктуры',
  'Roles + escalation': 'Роли и эскалация',
  'Org chart + board governance': 'Оргструктура и управление доской',
  'Team admin only': 'Только администрирование команды',
  'Usage budgets + scheduled hard caps': 'Бюджеты расхода и жёсткие лимиты запусков',
  'Cost/token visibility, no hard caps': 'Видимость стоимости/токенов, без жёстких лимитов',
  'Cost tiers + digest, no hard caps': 'Тарифные уровни и дайджест, без жёстких лимитов',
  'Per-agent budgets + hard stops': 'Бюджеты на агента и жёсткие остановки',
  'Usage + cloud spend limits': 'Usage и лимиты cloud-расходов',
  '/usage + workspace limits': '/usage и лимиты workspace',
  'OSS + free model with no auth, paid providers optional': 'OSS и бесплатная модель без авторизации, платные провайдеры опциональны',
  'OSS, runtime plans needed': 'OSS, нужны тарифы runtime',
  'OSS, self-hosted + infra': 'OSS, self-hosted и инфраструктура',
  'Free + paid usage': 'Бесплатно плюс платное использование',
  'Claude plan or API usage': 'Claude plan или API usage',
}

function note(text: string): string {
  return locale.value === 'ru' ? (ruNotes[text] ?? text) : text
}

const sourcesPrefix = computed(() => (
  locale.value === 'ru'
    ? 'Факты Agent Teams проверены по локальному исходному коду 6 июля 2026; источники конкурентов проверены 25 июня 2026:'
    : 'Agent Teams product facts checked in local source on July 6, 2026; competitor sources checked on June 25, 2026:'
))

const ruSourceLabels: Record<string, string> = {
  'Agent Teams organizations feature': 'фича организаций Agent Teams',
  'Agent Teams token usage budgets': 'бюджеты расхода токенов Agent Teams',
  'Agent Teams scheduled budget cap': 'лимит бюджета scheduled runs Agent Teams',
  'detailed research notes': 'подробные заметки исследования',
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
  'Cursor Cloud Agents': 'cloud agents Cursor',
  'Cursor Agent Review': 'agent review Cursor',
  'Cursor worktrees': 'worktrees Cursor',
  'Cursor Models & Pricing': 'модели и цены Cursor',
  'Cursor Team Pricing': 'team pricing Cursor',
  'Claude Code agent teams': 'команды агентов Claude Code',
  'Claude Code subagents': 'сабагенты Claude Code',
  'Claude Code workflows': 'workflows Claude Code',
  'Claude Code costs': 'стоимость Claude Code',
  'Claude pricing': 'цены Claude',
}

function sourceLabel(label: string): string {
  return locale.value === 'ru' ? (ruSourceLabels[label] ?? label) : label
}


interface CellValue {
  status: string
  note?: string
  noteLink?: string
}

interface ComparisonRow {
  feature: string
  us: CellValue
  gastown: CellValue
  paperclip: CellValue
  cursor: CellValue
  claudeCli: CellValue
}

const rows = computed<ComparisonRow[]>(() => [
  {
    feature: t('comparison.features.crossTeam'),
    us: { status: 'yes', note: note('Messages between separate teams') },
    gastown: { status: 'partial', note: note('Coordination across groups') },
    paperclip: { status: 'partial', note: note('Company-scoped org work') },
    cursor: { status: 'na' },
    claudeCli: { status: 'no' },
  },
  {
    feature: t('comparison.features.agentMessaging'),
    us: { status: 'yes', note: note('Native real-time mailbox') },
    gastown: { status: 'yes', note: note('Mailboxes + handoffs') },
    paperclip: { status: 'partial', note: note('Comments + @mentions') },
    cursor: { status: 'no' },
    claudeCli: { status: 'yes', note: note('Team mailbox, no UI') },
  },
  {
    feature: t('comparison.features.linkedTasks'),
    us: { status: 'yes', note: note('Tasks can link to and block each other') },
    gastown: { status: 'partial', note: note('Task deps + grouped work') },
    paperclip: { status: 'yes', note: note('Goals, parent tasks, blockers') },
    cursor: { status: 'no' },
    claudeCli: { status: 'yes', note: note('Shared task list') },
  },
  {
    feature: t('comparison.features.sessionAnalysis'),
    us: { status: 'yes', note: note('Task logs + token usage') },
    gastown: { status: 'partial', note: note('Session recall, feed, metrics') },
    paperclip: { status: 'partial', note: note('Run transcripts + cost audit') },
    cursor: { status: 'no' },
    claudeCli: { status: 'partial', note: note('Usage command, no UI') },
  },
  {
    feature: t('comparison.features.taskAttachments'),
    us: { status: 'yes', note: note('Auto-attach, agents read & attach') },
    gastown: { status: 'no', note: note('Not task-level') },
    paperclip: { status: 'yes', note: note('Docs, attachments, work products') },
    cursor: { status: 'partial', note: note('Chat session only') },
    claudeCli: { status: 'partial', note: note('Chat images only') },
  },
  {
    feature: t('comparison.features.hunkReview'),
    us: { status: 'yes', note: note('Accept / reject individual hunks') },
    gastown: { status: 'no' },
    paperclip: { status: 'no', note: note('Bring your own review') },
    cursor: { status: 'yes' },
    claudeCli: { status: 'no' },
  },
  {
    feature: t('comparison.features.codeEditor'),
    us: { status: 'yes', note: note('With Git support') },
    gastown: { status: 'no' },
    paperclip: { status: 'no', note: note('Control plane, not editor') },
    cursor: { status: 'yes', note: note('Full IDE') },
    claudeCli: { status: 'no' },
  },
  {
    feature: t('comparison.features.fullAutonomy'),
    us: { status: 'yes', note: note('Plan, assign, work, and review') },
    gastown: { status: 'yes', note: note('Coordinator, grouped work, recovery') },
    paperclip: { status: 'yes', note: note('Wake-up runs + governance') },
    cursor: { status: 'partial', note: note('Cloud agents, not teams') },
    claudeCli: { status: 'yes', note: note('Experimental CLI teams') },
  },
  {
    feature: t('comparison.features.taskDeps'),
    us: { status: 'yes', note: note('Tasks wait for blockers automatically') },
    gastown: { status: 'yes', note: note('Dependency waves') },
    paperclip: { status: 'yes', note: note('Blockers + execution locks') },
    cursor: { status: 'no' },
    claudeCli: { status: 'yes', note: note('Team task deps, no UI') },
  },
  {
    feature: t('comparison.features.reviewWorkflow'),
    us: { status: 'yes', note: note('Agents review each other') },
    gastown: { status: 'partial', note: note('Merge queue') },
    paperclip: { status: 'yes', note: note('Approvals + governance') },
    cursor: { status: 'partial', note: note('PR/BugBot only') },
    claudeCli: { status: 'yes', note: note('Team review, no UI') },
  },
  {
    feature: t('comparison.features.zeroSetup'),
    us: { status: 'yes', note: note('Guided runtime setup') },
    gastown: { status: 'no', note: note('Manual CLI stack') },
    paperclip: { status: 'partial', note: note('npx + local database') },
    cursor: { status: 'yes' },
    claudeCli: { status: 'partial', note: note('CLI + env flag') },
  },
  {
    feature: t('comparison.features.kanban'),
    us: { status: 'yes', note: note('5 columns, real-time') },
    gastown: { status: 'no', note: note('Dashboard, not Kanban') },
    paperclip: { status: 'yes', note: note('7 columns, drag-and-drop') },
    cursor: { status: 'no' },
    claudeCli: { status: 'no' },
  },
  {
    feature: t('comparison.features.execLog'),
    us: { status: 'yes', note: note('Tools, reasoning trace, and timeline') },
    gastown: { status: 'partial', note: note('Feed, metrics, dashboard') },
    paperclip: { status: 'yes', note: note('Run transcripts + audit log') },
    cursor: { status: 'partial', note: note('Agent chat + terminal') },
    claudeCli: { status: 'no' },
  },
  {
    feature: t('comparison.features.liveProcesses'),
    us: { status: 'yes', note: note('View, stop, open URLs') },
    gastown: { status: 'partial', note: note('Agent health dashboard') },
    paperclip: { status: 'partial', note: note('Manual services + previews') },
    cursor: { status: 'partial', note: note('Native terminal only') },
    claudeCli: { status: 'no' },
  },
  {
    feature: t('comparison.features.runtimeLoad'),
    us: { status: 'yes', note: note('CPU/RAM history for each live teammate') },
    gastown: { status: 'partial', note: note('Activity/health, not CPU/RAM') },
    paperclip: { status: 'partial', note: note('Run status/cost, not CPU/RAM') },
    cursor: { status: 'no', note: note('Remote agent/terminal only') },
    claudeCli: { status: 'no' },
  },
  {
    feature: t('comparison.features.perTaskReview'),
    us: { status: 'yes', note: note('Accept / reject / comment') },
    gastown: { status: 'partial', note: note('Merge queue, no diff UI') },
    paperclip: { status: 'partial', note: note('PR/work products, no diff UI') },
    cursor: { status: 'yes', note: note('BugBot on PRs') },
    claudeCli: { status: 'no' },
  },
  {
    feature: t('comparison.features.flexAutonomy'),
    us: { status: 'yes', note: note('Per-action approvals + notifications') },
    gastown: { status: 'yes', note: note('Проверки, эскалация, восстановление') },
    paperclip: { status: 'yes', note: note('Подтверждения на доске, пауза, остановка') },
    cursor: { status: 'partial', note: note('Cloud agents run commands') },
    claudeCli: { status: 'yes', note: note('Permissions + hooks') },
  },
  {
    feature: t('comparison.features.worktree'),
    us: { status: 'yes', note: note('Optional') },
    gastown: { status: 'yes', note: note('Core primitive') },
    paperclip: { status: 'yes', note: note('Worktrees / branches') },
    cursor: { status: 'yes', note: note('Agents Window worktrees') },
    claudeCli: { status: 'partial', note: note('Manual worktrees') },
  },
  {
    feature: t('comparison.features.multiAgent'),
    us: { status: 'yes', note: note('Claude, Codex, and OpenCode in one team') },
    gastown: { status: 'yes', note: note('Many providers, terminal-first') },
    paperclip: { status: 'yes', note: note('Bring your own agents/runtimes') },
    cursor: { status: 'partial', note: note('Multi-model agents, no shared team') },
    claudeCli: { status: 'partial', note: note('Claude-only experimental teams') },
  },
  {
    feature: t('comparison.features.liveWorkGraph'),
    us: { status: 'yes', note: note('Teammates, tasks, blockers, handoffs, activity, logs') },
    gastown: { status: 'partial', note: note('Agent tree + feed panels') },
    paperclip: { status: 'partial', note: note('Org chart/status, not a task/log map') },
    cursor: { status: 'no' },
    claudeCli: { status: 'no' },
  },
  {
    feature: t('comparison.features.liveTeam'),
    us: { status: 'yes', note: note('Watch teammates work and message them directly') },
    gastown: { status: 'partial', note: note('Terminal-based agent sessions') },
    paperclip: { status: 'partial', note: note('Agents wake up for runs, then sleep') },
    cursor: { status: 'partial', note: note('Cloud agents per task') },
    claudeCli: { status: 'partial', note: note('CLI teams, no desktop view') },
  },
  {
    feature: t('comparison.features.teamWorkspace'),
    us: { status: 'yes', note: note('Tasks, logs, Kanban, review, and teammates in one app') },
    gastown: { status: 'partial', note: note('Mail/feed/dashboard across tools') },
    paperclip: { status: 'partial', note: note('Board + transcripts, less live teammate view') },
    cursor: { status: 'partial', note: note('IDE chats/tasks, not team view') },
    claudeCli: { status: 'no', note: note('No desktop UI') },
  },
  {
    feature: t('comparison.features.launchProof'),
    us: { status: 'yes', note: note('Know who started, who is stuck, and who replied') },
    gastown: { status: 'partial', note: note('Session health, less clear message status') },
    paperclip: { status: 'partial', note: note('Run status, not live teammate status') },
    cursor: { status: 'no' },
    claudeCli: { status: 'partial', note: note('CLI mailbox, no visual status') },
  },
  {
    feature: t('comparison.features.orgGovernance'),
    us: { status: 'yes', note: note('Organization map + approvals') },
    gastown: { status: 'partial', note: note('Roles + escalation') },
    paperclip: { status: 'yes', note: note('Org chart + board governance') },
    cursor: { status: 'partial', note: note('Team admin only') },
    claudeCli: { status: 'no' },
  },
  {
    feature: t('comparison.features.budgetControls'),
    us: { status: 'yes', note: note('Usage budgets + scheduled hard caps') },
    gastown: { status: 'partial', note: note('Cost tiers + digest, no hard caps') },
    paperclip: { status: 'yes', note: note('Per-agent budgets + hard stops') },
    cursor: { status: 'partial', note: note('Usage + cloud spend limits') },
    claudeCli: { status: 'partial', note: note('/usage + workspace limits') },
  },
  {
    feature: t('comparison.features.price'),
    us: { status: 'free', note: note('OSS + free model with no auth, paid providers optional') },
    gastown: { status: 'free', note: note('OSS, runtime plans needed') },
    paperclip: { status: 'free', note: note('OSS, self-hosted + infra') },
    cursor: { status: 'text', note: note('Free + paid usage') },
    claudeCli: { status: 'text', note: note('Claude plan or API usage') },
  },
])

const competitors = [
  { key: 'us', name: 'Agent Teams', highlight: true },
  { key: 'gastown', name: 'Gastown' },
  { key: 'paperclip', name: 'Paperclip' },
  { key: 'cursor', name: 'Cursor' },
  { key: 'claudeCli', name: 'Claude Code CLI' },
]

const sourceLinks = [
  {
    label: 'Agent Teams organizations feature',
    href: 'https://github.com/777genius/agent-teams-ai/blob/main/src/features/organizations/README.md',
  },
  {
    label: 'Agent Teams token usage budgets',
    href: 'https://github.com/777genius/agent-teams-ai/blob/main/src/features/token-usage/contracts/dto.ts',
  },
  {
    label: 'Agent Teams scheduled budget cap',
    href: 'https://github.com/777genius/agent-teams-ai/blob/main/src/main/services/schedule/ScheduledTaskExecutor.ts',
  },
  {
    label: 'detailed research notes',
    href: 'https://github.com/777genius/agent-teams-ai/blob/main/docs/research/gastown-paperclip-comparison-2026-06-25.md',
  },
  { label: 'Gastown README', href: 'https://github.com/gastownhall/gastown' },
  {
    label: 'Gastown provider guide',
    href: 'https://github.com/gastownhall/gastown/blob/main/docs/agent-provider-integration.md',
  },
  {
    label: 'Gastown scheduler',
    href: 'https://github.com/gastownhall/gastown/blob/main/docs/design/scheduler.md',
  },
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
  { label: 'Paperclip org chart', href: 'https://paperclip.inc/docs/guides/board-operator/org-structure/' },
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
  { label: 'Paperclip release', href: 'https://github.com/paperclipai/paperclip/releases/tag/v2026.618.0' },
  { label: 'Cursor Cloud Agents', href: 'https://cursor.com/docs/cloud-agent' },
  { label: 'Cursor Agent Review', href: 'https://cursor.com/docs/agent/agent-review' },
  { label: 'Cursor Bugbot', href: 'https://cursor.com/docs/bugbot' },
  { label: 'Cursor worktrees', href: 'https://cursor.com/docs/configuration/worktrees' },
  { label: 'Cursor Models & Pricing', href: 'https://cursor.com/docs/models-and-pricing' },
  { label: 'Cursor Team Pricing', href: 'https://cursor.com/docs/account/teams/pricing' },
  { label: 'Claude Code agent teams', href: 'https://code.claude.com/docs/en/agent-teams' },
  { label: 'Claude Code subagents', href: 'https://code.claude.com/docs/en/sub-agents' },
  { label: 'Claude Code workflows', href: 'https://code.claude.com/docs/en/common-workflows' },
  { label: 'Claude Code costs', href: 'https://code.claude.com/docs/en/costs' },
  { label: 'Claude pricing', href: 'https://claude.com/pricing' },
]

onMounted(() => {
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
        <table class="comparison-table">
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
  --comparison-sticky-header-offset: 76px;
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
  overflow-x: clip;
  border-radius: 16px;
  border: 1px solid rgba(0, 240, 255, 0.15);
  background: rgba(10, 10, 15, 0.6);
  backdrop-filter: blur(12px);
  position: relative;
  z-index: 1;
}

.comparison-table__robot {
  position: absolute;
  right: clamp(28px, 7vw, 96px);
  bottom: calc(100% - 20px);
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
  min-width: 780px;
  font-size: 0.85rem;
}

/* Header */
.comparison-table thead {
  position: static;
}

.comparison-table__th {
  position: sticky;
  top: var(--comparison-sticky-header-offset);
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
  min-width: 180px;
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
  max-width: 140px;
  text-align: center;
  white-space: normal;
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
  text-shadow: 0 0 8px rgba(57, 255, 20, 0.4);
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
  text-shadow: 0 0 8px rgba(57, 255, 20, 0.4);
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
  background: rgba(255, 255, 255, 0.95);
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
  color: #94a3b8;
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
  .comparison-section {
    --comparison-sticky-header-offset: 60px;
  }

  .comparison-table__wrap {
    overflow-x: auto;
  }

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

@media (min-width: 1600px) {
  .comparison-section {
    --comparison-sticky-header-offset: 124px;
  }
}

@media (max-width: 600px) {
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
    max-width: 110px;
  }
}
</style>
