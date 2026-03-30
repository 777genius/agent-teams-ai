import type { GraphDomainRef, GraphEdge } from './types';

/**
 * Event callback port — graph fires these when user interacts with nodes/edges.
 * Host project provides handlers to navigate to domain-specific views.
 */
export interface GraphEventPort {
  /** Single click on a node — show popover with details */
  onNodeClick?: (ref: GraphDomainRef) => void;
  /** Double click on a node — open full detail dialog */
  onNodeDoubleClick?: (ref: GraphDomainRef) => void;
  /** Click on an edge */
  onEdgeClick?: (edge: GraphEdge) => void;
  /** Click on empty canvas background */
  onBackgroundClick?: () => void;
  /** "Send Message" action from node popover */
  onSendMessage?: (memberName: string, teamName: string) => void;
  /** "Open Task Detail" action from task popover */
  onOpenTaskDetail?: (taskId: string, teamName: string) => void;
  /** "Open Member Profile" action from member popover */
  onOpenMemberProfile?: (memberName: string, teamName: string) => void;
}
