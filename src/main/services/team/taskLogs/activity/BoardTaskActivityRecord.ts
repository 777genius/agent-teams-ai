import type {
  BoardTaskActivityAction,
  BoardTaskActivityActor,
  BoardTaskActivityActorContext,
  BoardTaskActivityLinkKind,
  BoardTaskActivityTargetRole,
  BoardTaskActivityTaskRef,
} from '@shared/types';

export interface BoardTaskActivityRecord {
  id: string;
  timestamp: string;
  task: BoardTaskActivityTaskRef;
  linkKind: BoardTaskActivityLinkKind;
  targetRole: BoardTaskActivityTargetRole;
  actor: BoardTaskActivityActor;
  actorContext: BoardTaskActivityActorContext;
  action?: BoardTaskActivityAction;
  source: {
    messageUuid: string;
    filePath: string;
    toolUseId?: string;
    sourceOrder: number;
  };
}
