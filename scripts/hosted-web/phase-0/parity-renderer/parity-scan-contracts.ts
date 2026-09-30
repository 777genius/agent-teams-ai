import { createHash } from 'node:crypto';

export const PINNED_BASE_SHA = 'cbe501ad0f1fa0e51a038e832ad35fce4120321b';
export const PHASE_START_SHA = 'a32f509e6d9bd31ba2135940e336729bf90c3d93';
export const API_SURFACES = ['TeamsAPI', 'ReviewAPI', 'CrossTeamAPI'] as const;
export const PHASE_START_API_COUNTS = {
  TeamsAPI: 86,
  ReviewAPI: 20,
  CrossTeamAPI: 3,
} as const;
export const CLIENT_SURFACES = {
  TeamsAPI: 'teams',
  ReviewAPI: 'review',
  CrossTeamAPI: 'crossTeam',
} as const;
export const CLIENT_ACCESSORS = {
  TeamsAPI: 'getTeamsApi',
  ReviewAPI: 'getReviewApi',
  CrossTeamAPI: 'getCrossTeamApi',
} as const;
export const REVIEWED_CONTROL_FILES = {
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
export const CONTROL_SCOPE_PREFIXES = [
  'src/renderer/components/team/',
  'src/features/change-review/renderer/',
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
export const INTERNAL_IMPORT_PREFIXES = [
  '.',
  '@features/',
  '@main/',
  '@preload/',
  '@renderer/',
  '@shared/',
] as const;
export const IMPLICIT_CONTROLS = new Set([
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

export const MOUNT_CHAINS = [
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

export type ApiSurface = (typeof API_SURFACES)[number];
export type SourceRef = { file: string; sourceHash: string; siteCount: number };
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

export const sha = (text: string, length?: number): string =>
  createHash('sha256').update(text).digest('hex').slice(0, length);
export const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim();
export const kebab = (text: string): string =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase();
