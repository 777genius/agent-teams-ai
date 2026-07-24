import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import ts from 'typescript';

export const PINNED_BASE_SHA = 'cbe501ad0f1fa0e51a038e832ad35fce4120321b';
export const PHASE_START_SHA = 'a32f509e6d9bd31ba2135940e336729bf90c3d93';
const API_SURFACES = ['TeamsAPI', 'ReviewAPI', 'CrossTeamAPI'] as const;
const CLIENT_SURFACES = {
  TeamsAPI: 'teams',
  ReviewAPI: 'review',
  CrossTeamAPI: 'crossTeam',
} as const;
const REVIEWED_CONTROL_FILES = {
  list: 'src/renderer/components/team/TeamListView.tsx',
  detail: 'src/renderer/components/team/TeamDetailView.tsx',
  create: 'src/renderer/components/team/dialogs/CreateTeamDialog.tsx',
  providers:
    'src/features/runtime-provider-management/renderer/ui/RuntimeProviderManagementPanelView.tsx',
} as const;
export const CONTROL_ROOTS = [
  REVIEWED_CONTROL_FILES.list,
  REVIEWED_CONTROL_FILES.detail,
  'src/renderer/components/team/ToolApprovalSheet.tsx',
  'src/renderer/components/team/dialogs/GlobalTaskDetailDialog.tsx',
  REVIEWED_CONTROL_FILES.providers,
] as const;
const CONTROL_SCOPE_PREFIXES = [
  'src/renderer/components/team/',
  'src/features/runtime-provider-management/renderer/',
] as const;
// Complete React interaction families plus the Radix value/open callbacks used by mounted controls.
// Keeping whole families together prevents the previous allowlist bug where onBlur, onPaste,
// onContextMenu, and onDragStart silently disappeared while sibling events were scanned. Additional
// on* callbacks on components imported from external packages are discovered from each source file
// rather than maintained as another selective allowlist.
const EVENT_PROPS = new Set([
  'onAnimationEnd',
  'onAnimationIteration',
  'onAnimationStart',
  'onAbort',
  'onAuxClick',
  'onBeforeInput',
  'onBeforeToggle',
  'onBlur',
  'onCanPlay',
  'onCanPlayThrough',
  'onChange',
  'onCheckedChange',
  'onClick',
  'onCompositionEnd',
  'onCompositionStart',
  'onCompositionUpdate',
  'onContextMenu',
  'onCopy',
  'onCut',
  'onDoubleClick',
  'onDrag',
  'onDragEnd',
  'onDragEnter',
  'onDragExit',
  'onDragLeave',
  'onDragOver',
  'onDragStart',
  'onDrop',
  'onDurationChange',
  'onEmptied',
  'onEncrypted',
  'onEnded',
  'onError',
  'onFocus',
  'onInput',
  'onInvalid',
  'onKeyDown',
  'onKeyPress',
  'onKeyUp',
  'onLoad',
  'onLoadedData',
  'onLoadedMetadata',
  'onLoadStart',
  'onMouseDown',
  'onMouseEnter',
  'onMouseLeave',
  'onMouseMove',
  'onMouseOut',
  'onMouseOver',
  'onMouseUp',
  'onOpenChange',
  'onPaste',
  'onPointerCancel',
  'onPointerDown',
  'onPointerEnter',
  'onPointerLeave',
  'onPointerMove',
  'onPointerOut',
  'onPointerOver',
  'onPointerUp',
  'onGotPointerCapture',
  'onLostPointerCapture',
  'onPause',
  'onPlay',
  'onPlaying',
  'onProgress',
  'onRateChange',
  'onReset',
  'onScroll',
  'onScrollEnd',
  'onSeeked',
  'onSeeking',
  'onSelect',
  'onSubmit',
  'onStalled',
  'onSuspend',
  'onTimeUpdate',
  'onTouchCancel',
  'onTouchEnd',
  'onTouchMove',
  'onTouchStart',
  'onToggle',
  'onTransitionCancel',
  'onTransitionEnd',
  'onTransitionRun',
  'onTransitionStart',
  'onValueChange',
  'onVolumeChange',
  'onWaiting',
  'onWheel',
]);
export const isEventProp = (name: string): boolean =>
  EVENT_PROPS.has(name) ||
  (name.endsWith('Capture') && EVENT_PROPS.has(name.slice(0, -'Capture'.length)));
const INTERNAL_IMPORT_PREFIXES = [
  '.',
  '@features/',
  '@main/',
  '@preload/',
  '@renderer/',
  '@shared/',
] as const;
const IMPLICIT_CONTROLS = new Set([
  'Button',
  'SelectItem',
  'SelectTrigger',
  'TabsTrigger',
  'a',
  'button',
]);

export const LEGACY_CHILD_API_ACTION_IDS = {
  'team.legacy-control.dialogs.add.member.dialog.handle-submit': 'team.lifecycle.add-member',
  'team.legacy-control.members.member.card.handle-restart-member': 'team.lifecycle.restart-member',
  'team.legacy-control.members.member.card.handle-restore-member': 'team.lifecycle.restore-member',
} as const;

const MOUNT_CHAINS = [
  {
    root: 'src/renderer/components/team/ToolApprovalSheet.tsx',
    edges: [
      {
        from: 'src/renderer/App.tsx',
        to: 'src/renderer/components/team/ToolApprovalSheet.tsx',
        component: 'ToolApprovalSheet',
      },
    ],
  },
  {
    root: 'src/renderer/components/team/dialogs/GlobalTaskDetailDialog.tsx',
    edges: [
      {
        from: 'src/renderer/components/layout/TabbedLayout.tsx',
        to: 'src/renderer/components/layout/GlobalTaskDetailDialogSlot.tsx',
        component: 'GlobalTaskDetailDialogSlot',
      },
      {
        from: 'src/renderer/components/layout/GlobalTaskDetailDialogSlot.tsx',
        to: 'src/renderer/components/team/dialogs/GlobalTaskDetailDialog.tsx',
        component: 'GlobalTaskDetailDialog',
      },
    ],
  },
] as const;

type ApiSurface = (typeof API_SURFACES)[number];
type SourceRef = { file: string; sourceHash: string; siteCount: number };
export type SemanticRow = {
  id: string;
  owner: string;
  disposition: 'direct' | 'decomposed' | 'desktop-only' | 'deferred';
  securityClass: string;
  target: string;
  evidence: string[];
  sourceRefs: SourceRef[];
};
export type AbsenceRow = { id: string; reason: string; sourceRefs: SourceRef[] };
export type ControlSite = {
  file: string;
  sourceHash: string;
  element: string;
  prop: string;
  text: string;
  effects: Array<'containment' | 'semantic'>;
};
export type ChildControlCatalog = {
  schemaId: string;
  schemaVersion: number;
  evidenceId: string;
  packetRevision: string;
  pinnedBaseSha: string;
  phaseStartSha: string;
  roots: string[];
  sourceFiles: string[];
  actions: Record<string, string>;
  absences: Record<string, string>;
  mappings: Record<string, string>;
};

const sha = (text: string, length?: number): string =>
  createHash('sha256').update(text).digest('hex').slice(0, length);
const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim();
const kebab = (text: string): string =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase();

const apiGroups: Array<{
  surface: ApiSurface;
  owner: string;
  namespace: string;
  disposition: SemanticRow['disposition'];
  securityClass: string;
  target: string;
  members: string[];
}> = [
  {
    surface: 'TeamsAPI',
    owner: 'team-lifecycle',
    namespace: 'team.lifecycle',
    disposition: 'decomposed',
    securityClass: 'team-resource',
    target: 'WP-7-TEAM-LIFECYCLE',
    members: [
      'list',
      'getData',
      'deleteTeam',
      'restoreTeam',
      'permanentlyDeleteTeam',
      'deleteDraft',
      'prepareProvisioning',
      'createTeam',
      'getProvisioningStatus',
      'getLaunchFailureDiagnostics',
      'cancelProvisioning',
      'stop',
      'createConfig',
      'launchTeam',
      'updateConfig',
      'addMember',
      'replaceMembers',
      'removeMember',
      'restoreMember',
      'updateMemberRole',
      'getMemberSpawnStatuses',
      'restartMember',
      'skipMemberForLaunch',
    ],
  },
  {
    surface: 'TeamsAPI',
    owner: 'workspace-registry',
    namespace: 'workspace.registry',
    disposition: 'decomposed',
    securityClass: 'workspace-authorization',
    target: 'WP-3-WORKSPACE-REGISTRY',
    members: [
      'getWorktreeGitStatus',
      'initializeGitRepository',
      'createInitialGitCommit',
      'getProjectBranch',
      'setProjectBranchTracking',
      'onProjectBranchChange',
    ],
  },
  {
    surface: 'TeamsAPI',
    owner: 'team-task-board',
    namespace: 'team.task',
    disposition: 'decomposed',
    securityClass: 'team-resource',
    target: 'WP-8-TASK-BOARD',
    members: [
      'getTaskChangePresence',
      'setChangePresenceTracking',
      'createTask',
      'getTask',
      'requestReview',
      'updateKanban',
      'updateKanbanColumnOrder',
      'updateTaskStatus',
      'updateTaskOwner',
      'updateTaskFields',
      'startTask',
      'startTaskByUser',
      'getAllTasks',
      'addTaskComment',
      'setTaskClarification',
      'softDeleteTask',
      'restoreTask',
      'getDeletedTasks',
      'addTaskRelationship',
      'removeTaskRelationship',
    ],
  },
  {
    surface: 'TeamsAPI',
    owner: 'team-messaging',
    namespace: 'team.message',
    disposition: 'decomposed',
    securityClass: 'team-resource',
    target: 'WP-8-MESSAGING',
    members: [
      'getSavedRequest',
      'sendMessage',
      'getOpenCodeRuntimeDeliveryStatus',
      'getMessagesPage',
      'processSend',
    ],
  },
  {
    surface: 'TeamsAPI',
    owner: 'team-runtime-control',
    namespace: 'team.runtime',
    disposition: 'decomposed',
    securityClass: 'runtime-operator',
    target: 'WP-5-RUNTIME-CONTROL',
    members: [
      'setToolActivityTracking',
      'setTaskLogStreamTracking',
      'getClaudeLogs',
      'getMemberActivityMeta',
      'processAlive',
      'aliveList',
      'getMemberLogs',
      'getLogsForTask',
      'getTaskActivity',
      'getTaskActivityDetail',
      'getTaskLogStreamSummary',
      'getTaskLogStream',
      'getTaskExactLogSummaries',
      'getTaskExactLogDetail',
      'getMemberStats',
      'killProcess',
      'getLeadActivity',
      'getLeadContext',
      'getTeamAgentRuntime',
      'retryFailedOpenCodeSecondaryLanes',
    ],
  },
  {
    surface: 'TeamsAPI',
    owner: 'agent-attachments',
    namespace: 'agent.attachment',
    disposition: 'decomposed',
    securityClass: 'bounded-content',
    target: 'WP-9-ATTACHMENTS',
    members: ['getAttachments', 'saveTaskAttachment', 'getTaskAttachment', 'deleteTaskAttachment'],
  },
  {
    surface: 'TeamsAPI',
    owner: 'team-approvals',
    namespace: 'team.approval',
    disposition: 'decomposed',
    securityClass: 'approval-policy',
    target: 'WP-9-APPROVALS',
    members: [
      'respondToToolApproval',
      'validateCliArgs',
      'onToolApprovalEvent',
      'updateToolApprovalSettings',
      'readFileForToolApproval',
    ],
  },
  {
    surface: 'TeamsAPI',
    owner: 'team-console',
    namespace: 'team.console',
    disposition: 'direct',
    securityClass: 'renderer-local',
    target: 'WP-7-TEAM-CONSOLE',
    members: ['showMessageNotification', 'onTeamChange', 'onProvisioningProgress'],
  },
  {
    surface: 'ReviewAPI',
    owner: 'team-review',
    namespace: 'team.review',
    disposition: 'decomposed',
    securityClass: 'review-change-set',
    target: 'WP-9-REVIEW',
    members: [
      'getAgentChanges',
      'getTaskChanges',
      'getTeamTaskChangeSummaries',
      'invalidateTaskChangeSummaries',
      'getChangeStats',
      'getFileContent',
      'applyDecisions',
      'executeMutation',
      'retryMutationRecovery',
      'restoreHistory',
      'checkConflict',
      'rejectHunks',
      'rejectFile',
      'previewReject',
      'saveEditedFile',
      'deleteEditedFile',
      'restoreRejectedRename',
      'reapplyRejectedRename',
      'watchFiles',
      'unwatchFiles',
      'onExternalFileChange',
      'loadDecisions',
      'saveDecisions',
      'clearDecisions',
      'loadDraftHistory',
      'saveDraftHistoryEntry',
      'clearDraftHistory',
    ],
  },
  {
    surface: 'ReviewAPI',
    owner: 'team-review',
    namespace: 'team.review',
    disposition: 'desktop-only',
    securityClass: 'desktop-shell',
    target: 'DEFERRED-DESKTOP-ONLY',
    members: ['onCmdN', 'getGitFileLog'],
  },
  {
    surface: 'CrossTeamAPI',
    owner: 'team-messaging',
    namespace: 'team.message.cross-team',
    disposition: 'decomposed',
    securityClass: 'cross-team-resource',
    target: 'WP-8-MESSAGING',
    members: ['send', 'listTargets', 'getOutbox'],
  },
];

// These are reviewed semantic assignments. Source hashes are refreshable evidence, never identity.
const actionSeeds: Array<
  Omit<SemanticRow, 'sourceRefs'> & {
    refs: Array<[keyof typeof REVIEWED_CONTROL_FILES, string]>;
  }
> = [
  {
    id: 'team.console.select',
    owner: 'team-console',
    disposition: 'direct',
    securityClass: 'team-read',
    target: 'WP-7-TEAM-CONSOLE',
    evidence: ['keyboard/click equivalence', 'selection generation'],
    refs: [
      ['list', '7ae3e9868fb0d4a2'],
      ['list', '3d61968c3b27192f'],
      ['create', 'a41ca0eb05d0e44d'],
    ],
  },
  {
    id: 'team.lifecycle.launch',
    owner: 'team-lifecycle',
    disposition: 'decomposed',
    securityClass: 'team-operator',
    target: 'WP-7-TEAM-LIFECYCLE',
    evidence: ['idempotent accepted run', 'runtime outcome'],
    refs: [
      ['list', '6316b98384b52106'],
      ['detail', '57315f4848354f04'],
      ['detail', 'b0f60eaa09e35acc'],
    ],
  },
  {
    id: 'team.lifecycle.stop',
    owner: 'team-lifecycle',
    disposition: 'decomposed',
    securityClass: 'team-operator',
    target: 'WP-7-TEAM-LIFECYCLE',
    evidence: ['lifecycle generation', 'runtime stop outcome'],
    refs: [
      ['list', '9e5a0346eee1dc22'],
      ['detail', 'f24d2defb60f97d3'],
    ],
  },
  {
    id: 'team.lifecycle.copy-draft',
    owner: 'team-lifecycle',
    disposition: 'decomposed',
    securityClass: 'team-mutation',
    target: 'WP-7-TEAM-LIFECYCLE',
    evidence: ['new stable team identity'],
    refs: [['list', 'caca7b02e0fe8e0c']],
  },
  {
    id: 'team.lifecycle.delete',
    owner: 'team-lifecycle',
    disposition: 'decomposed',
    securityClass: 'destructive-team-operator',
    target: 'WP-7-TEAM-LIFECYCLE',
    evidence: ['tombstone generation', 'partial cleanup outcome'],
    refs: [
      ['list', '31aff054fdea44fc'],
      ['detail', '7d3361a6fdf74099'],
      ['detail', 'b8f7b322927174be'],
    ],
  },
  {
    id: 'team.lifecycle.restore',
    owner: 'team-lifecycle',
    disposition: 'decomposed',
    securityClass: 'team-operator',
    target: 'WP-7-TEAM-LIFECYCLE',
    evidence: ['tombstone generation check'],
    refs: [['list', '4aed9e873872f4c9']],
  },
  {
    id: 'team.lifecycle.permanently-delete',
    owner: 'team-lifecycle',
    disposition: 'decomposed',
    securityClass: 'destructive-team-operator',
    target: 'WP-7-TEAM-LIFECYCLE',
    evidence: ['explicit irreversible confirmation'],
    refs: [['list', 'f94e171aad27f966']],
  },
  {
    id: 'team.lifecycle.list.refresh',
    owner: 'team-lifecycle',
    disposition: 'direct',
    securityClass: 'team-read',
    target: 'WP-7-TEAM-LIFECYCLE',
    evidence: ['bounded freshness generation'],
    refs: [['list', 'e51dbba28734b4f3']],
  },
  {
    id: 'team.lifecycle.create-draft',
    owner: 'team-lifecycle',
    disposition: 'decomposed',
    securityClass: 'team-mutation',
    target: 'WP-7-TEAM-LIFECYCLE',
    evidence: ['draft identity before provisioning'],
    refs: [
      ['list', '51e06c68cf47389f'],
      ['create', '4fb257c290cbb747'],
    ],
  },
  {
    id: 'team.lifecycle.delete-draft',
    owner: 'team-lifecycle',
    disposition: 'decomposed',
    securityClass: 'destructive-team-operator',
    target: 'WP-7-TEAM-LIFECYCLE',
    evidence: ['draft-only deletion'],
    refs: [['detail', '1524fdc2302874a8']],
  },
  {
    id: 'team.lifecycle.edit-config',
    owner: 'team-lifecycle',
    disposition: 'decomposed',
    securityClass: 'team-mutation',
    target: 'WP-7-TEAM-LIFECYCLE',
    evidence: ['config revision conflict'],
    refs: [['detail', 'f5174a77b50a0515']],
  },
  {
    id: 'team.lifecycle.add-member',
    owner: 'team-lifecycle',
    disposition: 'decomposed',
    securityClass: 'team-mutation',
    target: 'WP-7-TEAM-LIFECYCLE',
    evidence: ['roster generation'],
    refs: [['detail', '2822e8d54b308717']],
  },
  {
    id: 'team.lifecycle.remove-member',
    owner: 'team-lifecycle',
    disposition: 'decomposed',
    securityClass: 'destructive-team-operator',
    target: 'WP-7-TEAM-LIFECYCLE',
    evidence: ['roster generation and runtime outcome'],
    refs: [['detail', 'e39a599d1bf8f481']],
  },
  {
    id: 'team.task.create',
    owner: 'team-task-board',
    disposition: 'decomposed',
    securityClass: 'team-mutation',
    target: 'WP-8-TASK-BOARD',
    evidence: ['task revision and delivery outcome'],
    refs: [
      ['detail', 'f6be75adbc83db1b'],
      ['detail', 'f2ce29562f9b62f6'],
    ],
  },
  {
    id: 'team.task.request-changes',
    owner: 'team-task-board',
    disposition: 'decomposed',
    securityClass: 'team-mutation',
    target: 'WP-8-TASK-BOARD',
    evidence: ['task revision and review reference'],
    refs: [['detail', '9e2ce9a330923369']],
  },
  {
    id: 'team.console.local-view',
    owner: 'team-console',
    disposition: 'direct',
    securityClass: 'renderer-local',
    target: 'WP-7-TEAM-CONSOLE',
    evidence: ['no server authority'],
    refs: [
      ['list', 'c40241bfedec76c5'],
      ['list', 'bfb04384019ff8a2'],
      ['list', '4fd19e07a723a058'],
      ['list', '7253b728045c5be7'],
      ['list', '495711757cb25a3d'],
      ['detail', '93356b94c86b9a31'],
      ['detail', '60524c5c20d1e755'],
      ['detail', '082021ccdae5c5a7'],
      ['detail', '5391ea0fc7047eb7'],
      ['create', '8ae85785caeac217'],
      ['create', 'bbd620637e74d07a'],
    ],
  },
  {
    id: 'team.console.desktop-editor',
    owner: 'team-console',
    disposition: 'desktop-only',
    securityClass: 'desktop-shell',
    target: 'ABSENT-BEFORE-HOSTED-MOUNT',
    evidence: ['hosted chunk import exclusion'],
    refs: [['detail', '4d51206ae5cc9e46']],
  },
  {
    id: 'team.lifecycle.draft.configure',
    owner: 'team-lifecycle',
    disposition: 'direct',
    securityClass: 'renderer-local-draft',
    target: 'WP-7-TEAM-LIFECYCLE',
    evidence: ['server revalidates accepted draft'],
    refs: [
      ['create', 'd5fe5d760046156d'],
      ['create', '6d8853fe55f75739'],
      ['create', 'fed55a4d724f8753'],
      ['create', '6eb6d60bd8a2b4f9'],
      ['create', '460a6a2c6167d111'],
      ['create', 'b595fc47dbad28f4'],
      ['create', 'cdb8b3b29e5bd5dc'],
      ['create', 'f57186dc2c15e899'],
      ['create', '2def27cf5dcb15c3'],
      ['create', '1a7ffd59f07eefa3'],
      ['create', '4f195bffd0ffd15b'],
      ['create', 'f021d7f085c99bfa'],
      ['create', 'd07a1c16e844146d'],
      ['create', 'f4d5123b4759ab0a'],
      ['create', 'efe1b616c01dac38'],
    ],
  },
  {
    id: 'provider.management.credentials.edit',
    owner: 'runtime-provider-management',
    disposition: 'direct',
    securityClass: 'secret-local-input',
    target: 'WP-4-PROVIDER-AVAILABILITY',
    evidence: ['credential never enters renderer evidence'],
    refs: [
      ['providers', '475f2078f99114db'],
      ['providers', '3816eb21807a0310'],
      ['providers', '9bfec2d3b0f3b701'],
      ['providers', 'c6ce0f9d97c1db56'],
      ['providers', '8e6244151887f85f'],
      ['providers', '0866a69dd465cea2'],
      ['providers', '32a0b93f9100520a'],
      ['providers', '90b5386bbc48f0ef'],
      ['providers', 'e61e6699ac805f3d'],
      ['providers', '2e96c75568c654f7'],
    ],
  },
  {
    id: 'provider.management.connect',
    owner: 'runtime-provider-management',
    disposition: 'direct',
    securityClass: 'provider-credential',
    target: 'WP-4-PROVIDER-AVAILABILITY',
    evidence: ['provider availability/auth result'],
    refs: [
      ['providers', '69d499064c5acd68'],
      ['providers', '6bc3452b02286516'],
      ['providers', '0762178282badb9e'],
      ['providers', '29c4895caee155e7'],
      ['providers', 'e05b1f72353d30ba'],
      ['providers', 'd168672245c63043'],
      ['providers', '3ad8822f863003a5'],
      ['providers', '1495ee29bd7c3e90'],
      ['providers', 'ac9b52278c788f42'],
    ],
  },
  {
    id: 'provider.management.connect.cancel',
    owner: 'runtime-provider-management',
    disposition: 'direct',
    securityClass: 'renderer-local',
    target: 'WP-4-PROVIDER-AVAILABILITY',
    evidence: ['no team lifecycle effect'],
    refs: [['providers', 'ad293317df8ded48']],
  },
  {
    id: 'provider.management.refresh',
    owner: 'runtime-provider-management',
    disposition: 'direct',
    securityClass: 'provider-read',
    target: 'WP-4-PROVIDER-AVAILABILITY',
    evidence: ['fresh availability projection'],
    refs: [
      ['providers', 'bcc0207e64dd80e9'],
      ['providers', '4db1c0b6fb7b9ffb'],
      ['providers', '08bc5dc7c332dd08'],
    ],
  },
  {
    id: 'provider.management.forget',
    owner: 'runtime-provider-management',
    disposition: 'direct',
    securityClass: 'destructive-provider-operator',
    target: 'WP-4-PROVIDER-AVAILABILITY',
    evidence: ['credential deletion outcome'],
    refs: [
      ['providers', '022abe36d0ffbc03'],
      ['providers', '2a7c06563fa1b014'],
    ],
  },
  {
    id: 'provider.management.provider.select',
    owner: 'runtime-provider-management',
    disposition: 'direct',
    securityClass: 'renderer-local',
    target: 'WP-4-PROVIDER-AVAILABILITY',
    evidence: ['keyboard/click equivalence'],
    refs: [
      ['providers', 'ac11e711a5ad0984'],
      ['providers', '70a068044f5b9d78'],
      ['providers', '884c2ef7b9d904ef'],
    ],
  },
  {
    id: 'provider.management.model.select',
    owner: 'runtime-provider-management',
    disposition: 'direct',
    securityClass: 'renderer-local',
    target: 'WP-4-PROVIDER-AVAILABILITY',
    evidence: ['keyboard/click equivalence'],
    refs: [['providers', 'ae63125fb8afa652']],
  },
  {
    id: 'provider.management.model.test',
    owner: 'runtime-provider-management',
    disposition: 'direct',
    securityClass: 'provider-execution-probe',
    target: 'WP-4-PROVIDER-AVAILABILITY',
    evidence: ['bounded test result'],
    refs: [
      ['providers', 'a64b1f2f3678ae66'],
      ['providers', 'b3f7d874e4b531e1'],
    ],
  },
  {
    id: 'provider.management.model.use-for-new-teams',
    owner: 'runtime-provider-management',
    disposition: 'direct',
    securityClass: 'provider-setting',
    target: 'WP-4-PROVIDER-AVAILABILITY',
    evidence: ['setting scope'],
    refs: [['providers', '4b4454a17e34e226']],
  },
  {
    id: 'provider.management.model.set-default',
    owner: 'runtime-provider-management',
    disposition: 'direct',
    securityClass: 'provider-setting',
    target: 'WP-4-PROVIDER-AVAILABILITY',
    evidence: ['setting scope'],
    refs: [['providers', '34e3adf63bf25705']],
  },
  {
    id: 'provider.management.model.page',
    owner: 'runtime-provider-management',
    disposition: 'direct',
    securityClass: 'provider-read',
    target: 'WP-4-PROVIDER-AVAILABILITY',
    evidence: ['bounded cursor and pagination'],
    refs: [['providers', 'c5c2275db5ceba29']],
  },
  {
    id: 'provider.management.directory.search',
    owner: 'runtime-provider-management',
    disposition: 'direct',
    securityClass: 'provider-read',
    target: 'WP-4-PROVIDER-AVAILABILITY',
    evidence: ['bounded query and pagination'],
    refs: [
      ['providers', '4e64864b4b16cd70'],
      ['providers', '6b69132fab97a1a0'],
      ['providers', 'b22672f4d62f3453'],
    ],
  },
  {
    id: 'provider.management.local-view',
    owner: 'runtime-provider-management',
    disposition: 'direct',
    securityClass: 'renderer-local',
    target: 'WP-4-PROVIDER-AVAILABILITY',
    evidence: ['no team lifecycle effect'],
    refs: [
      ['providers', '1cecb00a557a2370'],
      ['providers', '93445a71a9071b64'],
      ['providers', '6da470eb3cf1d2d1'],
      ['providers', '1a7ffd59f07eefa3'],
      ['providers', '17d88b307c87a317'],
      ['providers', '620ec57979b46e1d'],
      ['providers', 'e43bedc18cd77f93'],
      ['providers', '1e310b0bae09ff97'],
      ['providers', 'ea696b218060f2e5'],
      ['providers', 'abb468deaa0c78f4'],
      ['providers', '45ae2001fbe22fe4'],
      ['providers', '86ccffc56c2917aa'],
    ],
  },
];

const absenceSeeds: Array<
  Omit<AbsenceRow, 'sourceRefs'> & {
    refs: Array<[keyof typeof REVIEWED_CONTROL_FILES, string]>;
  }
> = [
  {
    id: 'P0.W1.ABSENCE.dialog-state',
    reason: 'Dialog open/cancel state is local and creates no hosted command.',
    refs: [
      ['list', '6f151970571293da'],
      ['detail', '257597c3ce8bca4e'],
      ['detail', 'a30b08f387e731a0'],
      ['detail', '00e75ccb184739af'],
      ['detail', '85535c3fe2325671'],
      ['detail', '613400ca3d7039e8'],
      ['create', '089f3839d882cd3f'],
    ],
  },
  {
    id: 'P0.W1.ABSENCE.event-containment',
    reason: 'Event containment is not a semantic action.',
    refs: [
      ['providers', '49a1bb745fad7f34'],
      ['providers', '54f6c7a4459a5ffa'],
      ['providers', '60e136772eb5c4bc'],
      ['providers', '8b8e8db68dec5b0a'],
      ['providers', '66f02e5325663a12'],
    ],
  },
  {
    id: 'P0.W1.ABSENCE.disabled-wrapper',
    reason: 'A disabled presentation wrapper without a handler is not an action.',
    refs: [['providers', '726e1410bc9bb643']],
  },
];

export function scanApiInterfaces(
  sourceText: string
): Array<{ surface: ApiSurface; member: string; signature: string; signatureHash: string }> {
  const source = ts.createSourceFile(
    'api.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const printer = ts.createPrinter({ removeComments: true });
  const rows: Array<{
    surface: ApiSurface;
    member: string;
    signature: string;
    signatureHash: string;
  }> = [];
  for (const statement of source.statements) {
    if (
      !ts.isInterfaceDeclaration(statement) ||
      !API_SURFACES.includes(statement.name.text as ApiSurface)
    )
      continue;
    const surface = statement.name.text as ApiSurface;
    for (const member of statement.members) {
      if ((!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) || !member.name)
        continue;
      const name = member.name.getText(source).replace(/^['"]|['"]$/g, '');
      const signature = normalized(printer.printNode(ts.EmitHint.Unspecified, member, source));
      rows.push({ surface, member: name, signature, signatureHash: `sha256:${sha(signature)}` });
    }
  }
  return rows;
}

function jsxElement(node: ts.JsxAttribute): string {
  const parent = node.parent.parent;
  return ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)
    ? parent.tagName.getText()
    : 'unknown';
}

export function scanControls(sourceText: string, file: string): ControlSite[] {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const rows: ControlSite[] = [];
  const externalComponentRoots = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    if (INTERNAL_IMPORT_PREFIXES.some((prefix) => moduleSpecifier.startsWith(prefix))) continue;
    const clause = statement.importClause;
    if (!clause?.isTypeOnly && clause?.name) externalComponentRoots.add(clause.name.text);
    if (!clause?.isTypeOnly && clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        externalComponentRoots.add(clause.namedBindings.name.text);
      } else {
        for (const specifier of clause.namedBindings.elements) {
          if (!specifier.isTypeOnly) externalComponentRoots.add(specifier.name.text);
        }
      }
    }
  }
  const isInteractionProp = (element: string, prop: string): boolean =>
    isEventProp(prop) ||
    (/^on[A-Z]/.test(prop) && externalComponentRoots.has(element.split('.')[0]));
  const classifyEffects = (
    initializer: ts.JsxAttributeValue | undefined
  ): ControlSite['effects'] => {
    if (!initializer) return ['semantic'];
    let containment = false;
    let semantic = false;
    const visitEffect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const method =
          ts.isPropertyAccessExpression(expression) || ts.isPropertyAccessChain(expression)
            ? expression.name.text
            : undefined;
        if (
          method &&
          ['preventDefault', 'stopImmediatePropagation', 'stopPropagation'].includes(method)
        ) {
          containment = true;
        } else {
          semantic = true;
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        semantic = true;
      } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
        semantic = true;
      }
      ts.forEachChild(node, visitEffect);
    };
    visitEffect(initializer);
    // A referenced callback is an opaque semantic effect at the JSX boundary. Inline handlers that
    // only contain propagation/default suppression remain deliberate absences.
    if (!containment && !semantic) semantic = true;
    return [containment ? 'containment' : undefined, semantic ? 'semantic' : undefined].filter(
      (effect): effect is 'containment' | 'semantic' => effect !== undefined
    );
  };
  const add = (
    element: string,
    prop: string,
    text: string,
    effects: ControlSite['effects'] = ['semantic']
  ): void => {
    const clean = normalized(text);
    rows.push({
      file,
      element,
      prop,
      text: clean,
      sourceHash: sha(`${element}|${prop}|${clean}`, 16),
      effects,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && isInteractionProp(jsxElement(node), node.name.getText(source))) {
      add(
        jsxElement(node),
        node.name.getText(source),
        node.initializer?.getText(source) ?? '',
        classifyEffects(node.initializer)
      );
    }
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      IMPLICIT_CONTROLS.has(node.tagName.getText(source))
    ) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const names = new Set(attributes.map((attribute) => attribute.name.getText(source)));
      const element = node.tagName.getText(source);
      if (![...names].some((name) => isInteractionProp(element, name)) && !names.has('asChild')) {
        add(element, element === 'a' ? 'navigate' : 'implicitAction', node.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return rows;
}

function importedModuleSpecifiers(sourceText: string, file: string): string[] {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const specifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.add(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...specifiers].sort();
}

function resolveImportedModule(
  from: string,
  specifier: string,
  readSource: (path: string) => string | undefined
): string | undefined {
  const base = (
    specifier.startsWith('@renderer/components/team/')
      ? `src/renderer/components/team/${specifier.slice('@renderer/components/team/'.length)}`
      : specifier.startsWith('@features/runtime-provider-management/')
        ? `src/features/runtime-provider-management/${specifier.slice('@features/runtime-provider-management/'.length)}`
        : specifier.startsWith('.')
          ? join(dirname(from), specifier)
          : ''
  ).replaceAll('\\', '/');
  if (!base) return undefined;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts').replaceAll('\\', '/'),
    join(base, 'index.tsx').replaceAll('\\', '/'),
  ];
  return candidates.find((candidate) => readSource(candidate) !== undefined);
}

export function discoverControlClosure(
  roots: readonly string[],
  readSource: (path: string) => string | undefined
): string[] {
  const pending = [...roots];
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.shift()!;
    if (visited.has(file)) continue;
    const source = readSource(file);
    if (source === undefined) throw new Error(`Missing reachable control module: ${file}`);
    visited.add(file);
    for (const specifier of importedModuleSpecifiers(source, file)) {
      const imported = resolveImportedModule(file, specifier, readSource);
      if (!imported || !CONTROL_SCOPE_PREFIXES.some((prefix) => imported.startsWith(prefix)))
        continue;
      if (!visited.has(imported)) pending.push(imported);
    }
  }
  return [...visited].filter((file) => file.endsWith('.tsx')).sort();
}

export function validateMountedControlRoots(
  readSource: (path: string) => string | undefined
): Array<{ root: string; mountChain: string[] }> {
  return MOUNT_CHAINS.map(({ root, edges }) => {
    for (const edge of edges) {
      const source = readSource(edge.from);
      if (source === undefined) throw new Error(`Missing mount module: ${edge.from}`);
      const importsTarget = importedModuleSpecifiers(source, edge.from).some(
        (specifier) => resolveImportedModule(edge.from, specifier, readSource) === edge.to
      );
      if (!importsTarget || !source.includes(`<${edge.component}`)) {
        throw new Error(
          `Mounted control root is not reachable through ${edge.from} -> ${edge.to} (${edge.component})`
        );
      }
    }
    return { root, mountChain: edges.map((edge) => `${edge.from}#${edge.component}`) };
  });
}

export function validateControlClosure(discovered: string[], declared: string[]): void {
  const expected = [...new Set(discovered)].sort();
  const actual = [...new Set(declared)].sort();
  if (actual.length !== declared.length)
    throw new Error('Control closure contains duplicate files');
  const missing = expected.filter((file) => !actual.includes(file));
  const extra = actual.filter((file) => !expected.includes(file));
  if (missing.length || extra.length) {
    throw new Error(
      `Control closure mismatch; missing=[${missing.join(',')}]; extra=[${extra.join(',')}]`
    );
  }
}

export function validateChildControlCatalog(
  sites: ControlSite[],
  catalog: ChildControlCatalog
): void {
  const actualByKey = new Map<string, number>();
  for (const site of sites) {
    const key = `${site.file}#sha256:${site.sourceHash}`;
    actualByKey.set(key, (actualByKey.get(key) ?? 0) + 1);
  }
  for (const [key, encoded] of Object.entries(catalog.mappings)) {
    const separator = encoded.indexOf('|');
    const siteCount = Number(encoded.slice(0, separator));
    const actionId = encoded.slice(separator + 1);
    if (separator < 1 || !Number.isInteger(siteCount) || siteCount < 1 || !actionId) {
      throw new Error(`Invalid child control mapping encoding: ${key}`);
    }
    if (!catalog.actions[actionId] && !catalog.absences[actionId]) {
      throw new Error(`Child control mapping references an unknown disposition: ${actionId}`);
    }
    if (actualByKey.get(key) !== siteCount) {
      throw new Error(`Child control reference is stale: ${key}`);
    }
  }
  const reviewedFiles = new Set<string>(Object.values(REVIEWED_CONTROL_FILES));
  for (const key of actualByKey.keys()) {
    const hashSeparator = key.lastIndexOf('#sha256:');
    const file = key.slice(0, hashSeparator);
    if (!reviewedFiles.has(file) && !(key in catalog.mappings)) {
      throw new Error(`Missing child control mapping: ${key}`);
    }
  }
}

function childCatalogActions(catalog: ChildControlCatalog): SemanticRow[] {
  const refsByAction = new Map<string, SourceRef[]>();
  for (const [key, encoded] of Object.entries(catalog.mappings)) {
    const separator = encoded.indexOf('|');
    const siteCount = Number(encoded.slice(0, separator));
    const actionId = encoded.slice(separator + 1);
    const hashSeparator = key.lastIndexOf('#sha256:');
    const file = key.slice(0, hashSeparator);
    const sourceHash = key.slice(hashSeparator + 1);
    const current = refsByAction.get(actionId) ?? [];
    current.push({ file, sourceHash, siteCount });
    refsByAction.set(actionId, current);
  }
  return Object.entries(catalog.actions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, encoded]) => {
      const [owner, disposition, securityClass, target, ...evidence] = encoded.split('|');
      if (
        !owner ||
        !['direct', 'decomposed', 'desktop-only', 'deferred'].includes(disposition) ||
        !securityClass ||
        !target ||
        !evidence.length
      ) {
        throw new Error(`Invalid child action encoding for ${id}`);
      }
      const sourceRefs = refsByAction.get(id) ?? [];
      if (!sourceRefs.length) throw new Error(`Unused child action: ${id}`);
      return {
        id,
        owner,
        disposition: disposition as SemanticRow['disposition'],
        securityClass,
        target,
        evidence,
        sourceRefs: sourceRefs.sort((left, right) =>
          `${left.file}#${left.sourceHash}`.localeCompare(`${right.file}#${right.sourceHash}`)
        ),
      };
    });
}

function childCatalogAbsences(catalog: ChildControlCatalog): AbsenceRow[] {
  const refsByAbsence = new Map<string, SourceRef[]>();
  for (const [key, encoded] of Object.entries(catalog.mappings)) {
    const separator = encoded.indexOf('|');
    const siteCount = Number(encoded.slice(0, separator));
    const absenceId = encoded.slice(separator + 1);
    if (!catalog.absences[absenceId]) continue;
    const hashSeparator = key.lastIndexOf('#sha256:');
    const file = key.slice(0, hashSeparator);
    const sourceHash = key.slice(hashSeparator + 1);
    const current = refsByAbsence.get(absenceId) ?? [];
    current.push({ file, sourceHash, siteCount });
    refsByAbsence.set(absenceId, current);
  }
  return Object.entries(catalog.absences)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, reason]) => {
      const sourceRefs = refsByAbsence.get(id) ?? [];
      if (!sourceRefs.length) throw new Error(`Unused child absence: ${id}`);
      return {
        id,
        reason,
        sourceRefs: sourceRefs.sort((left, right) =>
          `${left.file}#${left.sourceHash}`.localeCompare(`${right.file}#${right.sourceHash}`)
        ),
      };
    });
}

export function validateLegacyChildApiActionMappings(
  actions: SemanticRow[],
  apiActions: Array<{ actionId: string; owningFeature: string }>
): Array<{ childActionId: string; apiActionId: string; owner: string }> {
  const childActions = new Map(actions.map((action) => [action.id, action]));
  const apiOwners = new Map(apiActions.map((action) => [action.actionId, action.owningFeature]));

  return Object.entries(LEGACY_CHILD_API_ACTION_IDS).map(([childActionId, apiActionId]) => {
    const childAction = childActions.get(childActionId);
    if (!childAction) throw new Error(`Missing API-linked child action: ${childActionId}`);
    const apiOwner = apiOwners.get(apiActionId);
    if (!apiOwner) throw new Error(`Missing API action for child mapping: ${apiActionId}`);
    if (childAction.owner !== apiOwner) {
      throw new Error(
        `Child/API ownership conflict: ${childActionId} (${childAction.owner}) -> ${apiActionId} (${apiOwner})`
      );
    }
    return { childActionId, apiActionId, owner: apiOwner };
  });
}

function refsFor(
  repoRoot: string,
  refs: Array<[keyof typeof REVIEWED_CONTROL_FILES, string]>,
  sites: ControlSite[]
): SourceRef[] {
  return refs.map(([key, sourceHash]) => {
    const file = REVIEWED_CONTROL_FILES[key];
    const siteCount = sites.filter(
      (site) => site.file === file && site.sourceHash === sourceHash
    ).length;
    if (!siteCount) throw new Error(`Reviewed source reference disappeared: ${file}#${sourceHash}`);
    if (!existsSync(join(repoRoot, file))) throw new Error(`Missing reviewed source file: ${file}`);
    return { file, sourceHash: `sha256:${sourceHash}`, siteCount };
  });
}

export function validateSemanticCatalog(
  sites: ControlSite[],
  actions: SemanticRow[],
  absences: AbsenceRow[]
): void {
  const ids = [...actions.map((row) => row.id), ...absences.map((row) => row.id)];
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate semantic action/absence ID');
  for (const action of actions) {
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(action.id))
      throw new Error(`Non-canonical action ID: ${action.id}`);
  }
  const mapped = new Map<string, number>();
  const mappedDisposition = new Map<string, 'action' | 'absence'>();
  for (const row of [...actions, ...absences])
    for (const ref of row.sourceRefs) {
      const key = `${ref.file}#${ref.sourceHash.replace('sha256:', '')}`;
      if (mapped.has(key)) throw new Error(`Source reference assigned twice: ${key}`);
      mapped.set(key, ref.siteCount);
      mappedDisposition.set(key, 'reason' in row ? 'absence' : 'action');
    }
  const actual = new Map<string, number>();
  for (const site of sites) {
    const key = `${site.file}#${site.sourceHash}`;
    actual.set(key, (actual.get(key) ?? 0) + 1);
  }
  for (const [key, count] of actual)
    if (mapped.get(key) !== count) throw new Error(`Missing or stale semantic mapping: ${key}`);
  for (const site of sites) {
    const key = `${site.file}#${site.sourceHash}`;
    if (
      site.effects.includes('containment') &&
      site.effects.includes('semantic') &&
      mappedDisposition.get(key) === 'absence'
    ) {
      throw new Error(`Mixed containment/semantic handler must map to a semantic action: ${key}`);
    }
  }
  for (const key of mapped.keys())
    if (!actual.has(key)) throw new Error(`Catalog reference has no source site: ${key}`);
}

export function validateApiDispositions(
  apiRows: ReturnType<typeof scanApiInterfaces>,
  dispositions: Array<{ source: ApiSurface; sourceMember: string }>
): void {
  const expected = apiRows.map((row) => `${row.surface}.${row.member}`).sort();
  const actual = dispositions.map((row) => `${row.source}.${row.sourceMember}`).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error('API dispositions must contain every pinned member exactly once');
  }
}

export function findDynamicDispatch(sourceText: string): string[] {
  const dynamic = [
    ...sourceText.matchAll(/api\.(?:teams|review|crossTeam)\s*\[\s*([^'"\]]+?)\s*\]/g),
  ];
  return dynamic
    .filter(
      (match) =>
        !sourceText
          .slice(Math.max(0, match.index! - 160), match.index)
          .includes('@hosted-web-dynamic-action')
    )
    .map((match) => match[0]);
}

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function rendererCallers(repoRoot: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const absolute of [
    ...walk(join(repoRoot, 'src/renderer')),
    ...walk(join(repoRoot, 'src/features')),
  ].filter((file) => /\.tsx?$/.test(file))) {
    const text = readFileSync(absolute, 'utf8');
    for (const [surface, client] of Object.entries(CLIENT_SURFACES) as Array<
      [ApiSurface, string]
    >) {
      const expression = new RegExp(
        `(?:api|window\\.electronAPI)\\.${client}\\.([A-Za-z_$][\\w$]*)`,
        'g'
      );
      for (const match of text.matchAll(expression)) {
        const key = `${surface}.${match[1]}`;
        if (!result.has(key)) result.set(key, new Set());
        result.get(key)!.add(relative(repoRoot, absolute));
      }
    }
    if (findDynamicDispatch(text).length)
      throw new Error(`Unannotated dynamic API dispatch: ${relative(repoRoot, absolute)}`);
  }
  return result;
}

function bypassEvidence(repoRoot: string): {
  summary: Record<string, number>;
  rows: Array<{ id: string; kind: string; path: string; sourceHash: string }>;
} {
  const rules = [
    ['direct-electron-global', /window\.electronAPI\.teams/g],
    ['global-mega-client-call', /\bapi\.(?:teams|review|crossTeam)\./g],
    [
      'structural-capability-check',
      /(?:typeof\s+[^\n]+===\s*['"]function|\?\.(?:teams|review|crossTeam))/g,
    ],
    [
      'fabricated-browser-success',
      /(?:not available in browser mode|return\s+\[\]|return\s+\{\}|no-op)/gi,
    ],
  ] as const;
  const rows: Array<{ id: string; kind: string; path: string; sourceHash: string }> = [];
  for (const absolute of [
    ...walk(join(repoRoot, 'src/renderer')),
    ...walk(join(repoRoot, 'src/features')),
  ].filter((file) => /\.tsx?$/.test(file))) {
    const text = readFileSync(absolute, 'utf8');
    const path = relative(repoRoot, absolute);
    for (const [kind, pattern] of rules)
      for (const match of text.matchAll(pattern)) {
        const context = normalized(
          text.slice(
            Math.max(0, match.index! - 80),
            Math.min(text.length, match.index! + match[0].length + 80)
          )
        );
        const sourceHash = `sha256:${sha(context)}`;
        rows.push({
          id: `P0.W1.BYPASS.${sha(`${kind}:${path}:${sourceHash}`, 16)}`,
          kind,
          path,
          sourceHash,
        });
      }
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const summary = Object.fromEntries(
    rules.map(([kind]) => [kind, rows.filter((row) => row.kind === kind).length])
  );
  return { summary, rows };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeCompactJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

type SchemaNode = {
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
};

export function validateJsonSchema(value: unknown, schema: SchemaNode, label = '$'): void {
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error(`${label} must be an object`);
  }
  if (schema.type === 'array' && !Array.isArray(value))
    throw new Error(`${label} must be an array`);
  if (schema.type === 'string' && typeof value !== 'string')
    throw new Error(`${label} must be a string`);
  if (schema.type === 'number' && typeof value !== 'number')
    throw new Error(`${label} must be a number`);
  if (schema.type === 'boolean' && typeof value !== 'boolean')
    throw new Error(`${label} must be a boolean`);
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? [])
      if (!(key in record)) throw new Error(`${label}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) validateJsonSchema(record[key], child, `${label}.${key}`);
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateJsonSchema(item, schema.items!, `${label}[${index}]`));
  }
}

function evidenceSchemas(outputRoot: string): void {
  const base = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: [
      'schemaId',
      'schemaVersion',
      'evidenceId',
      'packetRevision',
      'pinnedBaseSha',
      'phaseStartSha',
    ],
  };
  const schemas = {
    'api-parity-ledger.schema.json': {
      ...base,
      required: [...base.required, 'counts', 'members'],
      properties: {
        members: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'stableId',
              'source',
              'sourceMember',
              'legacySignature',
              'sourceSignatureHash',
              'rendererCallers',
              'owningFeature',
              'disposition',
              'securityClass',
              'requiredSemanticEvidence',
              'actionId',
              'targetWorkPackage',
            ],
          },
        },
      },
    },
    'renderer-action-inventory.schema.json': {
      ...base,
      required: [
        ...base.required,
        'roots',
        'mountProofs',
        'sourceFiles',
        'excludedSourceFiles',
        'actions',
        'apiActionBindings',
        'legacyChildApiActionBindings',
        'deliberateAbsences',
      ],
      properties: {
        roots: { type: 'array', items: { type: 'string' } },
        mountProofs: {
          type: 'array',
          items: { type: 'object', required: ['root', 'mountChain'] },
        },
        sourceFiles: {
          type: 'array',
          items: { type: 'object', required: ['path', 'sha256', 'interactionSiteCount'] },
        },
        excludedSourceFiles: {
          type: 'array',
          items: { type: 'object', required: ['path', 'reason', 'interactionSiteCount'] },
        },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'id',
              'owner',
              'disposition',
              'securityClass',
              'target',
              'evidence',
              'sourceRefs',
            ],
          },
        },
        apiActionBindings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['actionId', 'owner', 'source', 'sourceMember', 'rendererCallers'],
          },
        },
        legacyChildApiActionBindings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['childActionId', 'apiActionId', 'owner'],
          },
        },
        deliberateAbsences: {
          type: 'array',
          items: { type: 'object', required: ['id', 'reason', 'sourceRefs'] },
        },
      },
    },
    'renderer-child-control-catalog.schema.json': {
      ...base,
      required: [...base.required, 'roots', 'sourceFiles', 'actions', 'absences', 'mappings'],
      properties: {
        roots: { type: 'array', items: { type: 'string' } },
        sourceFiles: { type: 'array', items: { type: 'string' } },
        actions: { type: 'object' },
        absences: { type: 'object' },
        mappings: { type: 'object' },
      },
    },
    'legacy-bypass-inventory.schema.json': {
      ...base,
      required: [...base.required, 'summary', 'rawArtifact'],
      properties: {
        rawArtifact: {
          type: 'object',
          required: [
            'format',
            'recordCount',
            'sha256',
            'externalPath',
            'pathScope',
            'reproductionCommand',
          ],
          properties: {
            externalPath: { const: 'legacy-bypass-raw.json' },
            pathScope: { const: 'artifact-pack-relative' },
            reproductionCommand: {
              const:
                'W1_RAW_EVIDENCE_ROOT=<artifact-pack-dir> node --import tsx scripts/hosted-web/phase-0/parity-renderer/scan-api-and-actions.ts',
            },
          },
        },
      },
    },
    'estimate-input.schema.json': {
      ...base,
      required: [...base.required, 'unit', 'buckets', 'varianceAssessment'],
      properties: {
        buckets: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'bucketId',
              'packages',
              'productionLines',
              'testLines',
              'deletedLines',
              'netLines',
              'excludedGeneratedVendorLines',
              'overlap',
              'confidence',
              'assumptions',
              'evidenceRefs',
            ],
          },
        },
        varianceAssessment: {
          type: 'object',
          required: [
            'parentRangeStillSupported',
            'uniqueBucketOverTwentyPercent',
            'scopeReviewRequired',
            'changes',
          ],
        },
      },
    },
  };
  for (const [name, schema] of Object.entries(schemas))
    writeJson(join(outputRoot, 'schemas', name), schema);
}

export function generateEvidence(
  repoRoot: string,
  rawRoot = '/tmp/agent-teams-hosted-web-refactor-phase-00-remediation-w1-v9-artifacts'
): { rawPath: string; rawHash: string; apiCount: number; controlCount: number } {
  const outputRoot = join(repoRoot, 'docs/research/hosted-web/phase-0/parity-renderer');
  const apiRows = scanApiInterfaces(
    readFileSync(join(repoRoot, 'src/shared/types/api.ts'), 'utf8')
  );
  const callers = rendererCallers(repoRoot);
  const dispositions = apiGroups.flatMap((group) =>
    group.members.map((sourceMember) => {
      const source = group.surface;
      const scanned = apiRows.find((row) => row.surface === source && row.member === sourceMember);
      if (!scanned) throw new Error(`Explicit API disposition is stale: ${source}.${sourceMember}`);
      return {
        stableId: `P0.W1.API.${source}.${sourceMember}`,
        source,
        sourceMember,
        legacySignature: scanned.signature,
        sourceSignatureHash: scanned.signatureHash,
        rendererCallers: [...(callers.get(`${source}.${sourceMember}`) ?? [])].sort(),
        owningFeature: group.owner,
        disposition: group.disposition,
        securityClass: group.securityClass,
        requiredSemanticEvidence: [
          'normalized success/error contract',
          'support distinct from resource allowance',
          'revision/idempotency/event obligation',
        ],
        actionId: `${group.namespace}.${kebab(sourceMember)}`,
        targetWorkPackage: group.target,
      };
    })
  );
  validateApiDispositions(apiRows, dispositions);

  const readRepoSource = (file: string): string | undefined => {
    const absolute = join(repoRoot, file);
    return existsSync(absolute) && statSync(absolute).isFile()
      ? readFileSync(absolute, 'utf8')
      : undefined;
  };
  const mountProofs = validateMountedControlRoots(readRepoSource);
  const controlFiles = discoverControlClosure(CONTROL_ROOTS, readRepoSource);
  const teamControlCandidates = walk(join(repoRoot, 'src/renderer/components/team'))
    .filter((absolute) => absolute.endsWith('.tsx') && !/\.(?:test|stories)\.tsx$/.test(absolute))
    .map((absolute) => relative(repoRoot, absolute))
    .sort();
  const excludedControlFiles = teamControlCandidates.filter((file) => !controlFiles.includes(file));
  const catalogPath = join(outputRoot, 'renderer-child-control-catalog.json');
  if (!existsSync(catalogPath))
    throw new Error(`Missing reviewed child-control catalog: ${catalogPath}`);
  const childCatalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as ChildControlCatalog;
  if (
    childCatalog.pinnedBaseSha !== PINNED_BASE_SHA ||
    childCatalog.phaseStartSha !== PHASE_START_SHA
  ) {
    throw new Error('Child-control catalog provenance does not match the pinned W1 source');
  }
  if (JSON.stringify(childCatalog.roots) !== JSON.stringify(CONTROL_ROOTS)) {
    throw new Error('Child-control catalog roots do not match the mounted team roots');
  }
  validateControlClosure(controlFiles, childCatalog.sourceFiles);
  const sites = controlFiles.flatMap((file) => scanControls(readRepoSource(file)!, file));
  validateChildControlCatalog(sites, childCatalog);
  const actions: SemanticRow[] = [
    ...actionSeeds.map(({ refs, ...row }) => ({
      ...row,
      sourceRefs: refsFor(repoRoot, refs, sites),
    })),
    ...childCatalogActions(childCatalog),
  ];
  const deliberateAbsences: AbsenceRow[] = [
    ...absenceSeeds.map(({ refs, ...row }) => ({
      ...row,
      sourceRefs: refsFor(repoRoot, refs, sites),
    })),
    ...childCatalogAbsences(childCatalog),
  ];
  validateSemanticCatalog(sites, actions, deliberateAbsences);
  const ownerByAction = new Map(dispositions.map((row) => [row.actionId, row.owningFeature]));
  for (const action of actions) {
    const apiOwner = ownerByAction.get(action.id);
    if (apiOwner && apiOwner !== action.owner)
      throw new Error(`Cross-lane ownership conflict for ${action.id}`);
  }
  if (ownerByAction.get('team.lifecycle.stop') !== 'team-lifecycle')
    throw new Error('Team stop must remain team-lifecycle owned');
  if (
    actions.find((row) => row.id === 'provider.management.credentials.edit')?.owner !==
    'runtime-provider-management'
  )
    throw new Error('Provider credential controls must remain provider-management owned');
  const legacyChildApiActionBindings = validateLegacyChildApiActionMappings(actions, dispositions);
  const apiActionBindings = dispositions
    .filter((row) => row.rendererCallers.length)
    .map((row) => ({
      actionId: row.actionId,
      owner: row.owningFeature,
      source: row.source,
      sourceMember: row.sourceMember,
      rendererCallers: row.rendererCallers,
    }));

  const bypasses = bypassEvidence(repoRoot);
  const rawPath = join(rawRoot, 'legacy-bypass-raw.json');
  writeCompactJson(rawPath, bypasses.rows);
  const rawText = readFileSync(rawPath, 'utf8');
  const rawHash = `sha256:${sha(rawText)}`;

  const envelope = {
    schemaVersion: 2,
    packetRevision: 'phase-00-r2',
    pinnedBaseSha: PINNED_BASE_SHA,
    phaseStartSha: PHASE_START_SHA,
  };
  writeJson(join(outputRoot, 'api-parity-ledger.json'), {
    schemaId: 'p0-w1-api-parity-ledger',
    evidenceId: 'P0.W1.API_PARITY_LEDGER',
    ...envelope,
    counts: Object.fromEntries(
      API_SURFACES.map((surface) => [
        surface,
        apiRows.filter((row) => row.surface === surface).length,
      ])
    ),
    historicalCountDifference:
      'ReviewAPI +9 since the phase-start AST: current 86/29/3 versus historical 86/20/3',
    members: dispositions,
  });
  writeJson(join(outputRoot, 'renderer-action-inventory.json'), {
    schemaId: 'p0-w1-renderer-action-inventory',
    evidenceId: 'P0.W1.RENDERER_ACTIONS',
    ...envelope,
    identityRule:
      'Semantic IDs are reviewed contract identifiers; source hashes, handler text, counts, file paths, and line positions are refreshable references and never enter identity.',
    roots: [...CONTROL_ROOTS],
    mountProofs,
    sourceFiles: controlFiles.map((file) => ({
      path: file,
      sha256: `sha256:${sha(readRepoSource(file)!)}`,
      interactionSiteCount: sites.filter((site) => site.file === file).length,
    })),
    excludedSourceFiles: excludedControlFiles.map((file) => ({
      path: file,
      reason:
        'No relative or renderer-alias static/dynamic import path exists from the mounted W1 team roots; the file is absent from this mount closure.',
      interactionSiteCount: scanControls(readRepoSource(file)!, file).length,
    })),
    transitiveActionCoverage:
      'The checked-in child-control catalog exactly matches the recursively discovered team/provider renderer closure. Every scanner-visible site maps once to a reviewed semantic action or deliberate absence; direct renderer IPC callers remain bound to the 118-member parity ledger. Every other production team TSX file is listed as excluded and rechecked as unreachable from these roots.',
    actions,
    apiActionBindings,
    legacyChildApiActionBindings,
    deliberateAbsences,
    dynamicDispatch: {
      unannotatedCount: 0,
      annotation: '@hosted-web-dynamic-action <semantic-id>',
    },
  });
  writeJson(join(outputRoot, 'legacy-bypass-inventory.json'), {
    schemaId: 'p0-w1-legacy-bypass-inventory',
    evidenceId: 'P0.W1.LEGACY_BYPASSES',
    ...envelope,
    summary: bypasses.summary,
    rawArtifact: {
      format: 'deterministically sorted compact JSON',
      recordCount: bypasses.rows.length,
      sha256: rawHash,
      externalPath: basename(rawPath),
      pathScope: 'artifact-pack-relative',
      reproductionCommand:
        'W1_RAW_EVIDENCE_ROOT=<artifact-pack-dir> node --import tsx scripts/hosted-web/phase-0/parity-renderer/scan-api-and-actions.ts',
    },
    requiredDisposition:
      'Supported hosted actions use a real feature facet; unavailable and desktop-only controls are absent before mount. No optional-method check or fabricated success is capability proof.',
  });
  const buckets = [
    {
      bucketId: 'EST-CONTRACTS',
      packages: ['shared capability/action contracts', 'ADR-19 parity gate'],
      productionLines: { low: 1200, high: 1800 },
      testLines: { low: 800, high: 1200 },
      deletedLines: { low: 0, high: 0 },
      netLines: { low: 2000, high: 3000 },
      excludedGeneratedVendorLines: ['Phase 0 evidence', 'lockfiles', 'vendor'],
      overlap: 'W1 parity contracts only.',
      confidence: 'high',
      assumptions: ['No replacement mega-interface.'],
      evidenceRefs: ['P0.W1.API_PARITY_LEDGER', 'P0.W1.SCANNER'],
    },
    {
      bucketId: 'EST-RENDERER-LIFECYCLE',
      packages: ['team-console', 'team lifecycle renderer composition'],
      productionLines: { low: 1800, high: 2800 },
      testLines: { low: 1200, high: 2000 },
      deletedLines: { low: 900, high: 1600 },
      netLines: { low: 2100, high: 3200 },
      excludedGeneratedVendorLines: ['Phase 0 evidence', 'format churn'],
      overlap: 'Task/message/review/provider actions stay with their canonical owners.',
      confidence: 'medium',
      assumptions: ['Desktop-only controls are absent before hosted mount.'],
      evidenceRefs: ['P0.W1.RENDERER_ACTIONS', 'P0.W1.SELECTION_INVARIANTS'],
    },
    {
      bucketId: 'EST-REMAINING-PARITY',
      packages: [
        'team-task-board',
        'team-messaging',
        'team-review',
        'team-approvals',
        'agent-attachments',
      ],
      productionLines: { low: 2500, high: 3900 },
      testLines: { low: 1500, high: 2600 },
      deletedLines: { low: 1200, high: 2300 },
      netLines: { low: 2800, high: 4200 },
      excludedGeneratedVendorLines: ['Phase 0 evidence', 'post-v1 terminal'],
      overlap: 'Server/runtime/auth work remains in its owning non-W1 bucket.',
      confidence: 'medium-low',
      assumptions: ['One owning feature per semantic action.'],
      evidenceRefs: ['P0.W1.API_PARITY_LEDGER', 'P0.W1.RENDERER_ACTIONS', 'P0.W1.LEGACY_BYPASSES'],
    },
  ];
  writeJson(join(outputRoot, 'estimate-input.json'), {
    schemaId: 'p0-w1-estimate-input',
    evidenceId: 'P0.W1.ESTIMATE',
    ...envelope,
    unit: 'net integrated source lines; aligned low/high = production + test - deleted',
    buckets,
    varianceAssessment: {
      parentRangeStillSupported: false,
      uniqueBucketOverTwentyPercent: true,
      scopeReviewRequired: true,
      changes: [
        {
          bucketId: 'EST-RENDERER-LIFECYCLE',
          baseline: { low: 3000, high: 5000 },
          recomputed: { low: 2100, high: 3200 },
          variancePercent: { low: -30, high: -36 },
        },
        {
          bucketId: 'EST-REMAINING-PARITY',
          baseline: { low: 4000, high: 6500 },
          recomputed: { low: 2800, high: 4200 },
          variancePercent: { low: -30, high: -35.38 },
        },
      ],
      controllerDisposition:
        'scope review required before estimate freeze; W1 does not suppress or self-approve either variance',
    },
  });
  evidenceSchemas(outputRoot);
  const generatedJsonPaths = [
    'api-parity-ledger',
    'renderer-action-inventory',
    'legacy-bypass-inventory',
    'estimate-input',
  ].flatMap((stem) => [
    join(outputRoot, `${stem}.json`),
    join(outputRoot, 'schemas', `${stem}.schema.json`),
  ]);
  generatedJsonPaths.push(
    join(outputRoot, 'schemas', 'renderer-child-control-catalog.schema.json')
  );
  execFileSync(
    process.execPath,
    [join(repoRoot, 'node_modules/prettier/bin/prettier.cjs'), '--write', ...generatedJsonPaths],
    { cwd: repoRoot, stdio: 'ignore' }
  );
  for (const stem of [
    'api-parity-ledger',
    'renderer-action-inventory',
    'renderer-child-control-catalog',
    'legacy-bypass-inventory',
    'estimate-input',
  ]) {
    const document = JSON.parse(readFileSync(join(outputRoot, `${stem}.json`), 'utf8')) as unknown;
    const schema = JSON.parse(
      readFileSync(join(outputRoot, 'schemas', `${stem}.schema.json`), 'utf8')
    ) as SchemaNode;
    validateJsonSchema(document, schema, stem);
  }
  return { rawPath, rawHash, apiCount: apiRows.length, controlCount: sites.length };
}

function findRoot(start: string): string {
  let current = resolve(start);
  while (!existsSync(join(current, 'package.json'))) {
    const parent = dirname(current);
    if (parent === current) throw new Error('Repository root not found');
    current = parent;
  }
  return current;
}

if (process.argv[1]?.endsWith('scan-api-and-actions.ts')) {
  const result = generateEvidence(findRoot(process.cwd()), process.env.W1_RAW_EVIDENCE_ROOT);
  console.log(JSON.stringify({ status: 'ok', ...result }));
}
