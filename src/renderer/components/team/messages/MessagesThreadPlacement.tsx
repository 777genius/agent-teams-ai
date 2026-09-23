import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ExpandedChatHost {
  target: HTMLElement | null;
  available: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

interface MoveBeforeTarget extends HTMLElement {
  moveBefore(node: Node, child: Node | null): void;
}

export function supportsStatePreservingMove(
  target: HTMLElement | null
): target is MoveBeforeTarget {
  return target !== null && typeof (target as Partial<MoveBeforeTarget>).moveBefore === 'function';
}

interface MessagesThreadPlacementProps {
  sidebarTarget: HTMLElement | null;
  expandedHost?: ExpandedChatHost;
  children: React.ReactNode;
}

/** Keeps one React tree and one DOM subtree alive while its host changes. */
export const MessagesThreadPlacement = ({
  sidebarTarget,
  expandedHost,
  children,
}: Readonly<MessagesThreadPlacementProps>): React.JSX.Element | null => {
  const [container] = useState(() => {
    const element = document.createElement('div');
    element.className = 'flex size-full min-h-0 min-w-0 flex-col overflow-hidden';
    element.dataset.messagesThreadContainer = 'true';
    return element;
  });
  const [attached, setAttached] = useState(false);
  const target = expandedHost?.expanded ? expandedHost.target : sidebarTarget;

  useLayoutEffect(() => {
    if (!target || !target.isConnected) return;
    if (container.parentNode === target) {
      if (!attached) setAttached(true);
      return;
    }

    try {
      if (container.parentNode === null) {
        target.appendChild(container);
      } else if (supportsStatePreservingMove(target)) {
        target.moveBefore(container, null);
      } else {
        expandedHost?.onExpandedChange(false);
        return;
      }
      setAttached(true);
    } catch (error) {
      console.warn('[MessagesThreadPlacement] Failed to move live thread', error);
      if (sidebarTarget?.isConnected && container.parentNode !== sidebarTarget) {
        try {
          const restoreTarget = sidebarTarget as HTMLElement & {
            moveBefore?: (node: Node, child: Node | null) => void;
          };
          if (typeof restoreTarget.moveBefore === 'function') {
            try {
              restoreTarget.moveBefore(container, null);
            } catch {
              restoreTarget.appendChild(container);
            }
          } else {
            restoreTarget.appendChild(container);
          }
        } catch (fallbackError) {
          console.warn('[MessagesThreadPlacement] Failed to restore sidebar thread', fallbackError);
        }
      }
      expandedHost?.onExpandedChange(false);
    }
  }, [attached, container, expandedHost, sidebarTarget, target]);

  useLayoutEffect(
    () => () => {
      container.remove();
    },
    [container]
  );

  return attached ? createPortal(children, container) : null;
};
