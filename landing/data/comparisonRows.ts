export interface CellValue {
  status: string
  note?: string
  noteLink?: string
  power?: number
}

export interface ComparisonRow {
  feature: string
  us: CellValue
  gastown: CellValue
  paperclip: CellValue
  cursor: CellValue
  claudeCli: CellValue
  openrig: CellValue
}

export function createComparisonRows(
  t: (key: string) => string,
  note: (text: string) => string,
): ComparisonRow[] {
  return [
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
  ]
}
