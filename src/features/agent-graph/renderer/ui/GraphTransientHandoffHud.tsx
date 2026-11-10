import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  ACTIVITY_LANE,
  getTransientHandoffCardAlpha,
  type TransientHandoffCard,
} from '@claude-teams/agent-graph';
import { buildMessageContext } from '@renderer/components/team/activity/activityMessageContext';
import { useStableTeamMentionMeta } from '@renderer/hooks/useStableTeamMentionMeta';

import { useGraphActivityContext } from '../hooks/useGraphActivityContext';

import { buildTransientHandoffMessage } from './buildTransientHandoffMessage';
import { GraphActivityCard } from './GraphActivityCard';

interface GraphTransientHandoffHudProps {
  teamName: string;
  getTransientHandoffSnapshot?: (options?: {
    focusNodeIds?: ReadonlySet<string> | null;
    focusEdgeIds?: ReadonlySet<string> | null;
  }) => { cards: TransientHandoffCard[]; time: number };
  getCameraZoom?: () => number;
  worldToScreen?: (x: number, y: number) => { x: number; y: number };
  getNodeWorldPosition?: (nodeId: string) => { x: number; y: number } | null;
  focusNodeIds: ReadonlySet<string> | null;
  focusEdgeIds: ReadonlySet<string> | null;
  enabled?: boolean;
}

const CARD_WIDTH = ACTIVITY_LANE.width;
const CARD_HEIGHT = 72;
const STACK_GAP = 10;

export const GraphTransientHandoffHud = ({
  teamName,
  getTransientHandoffSnapshot = () => ({ cards: [], time: 0 }),
  getCameraZoom = () => 1,
  worldToScreen,
  getNodeWorldPosition = () => null,
  focusNodeIds,
  focusEdgeIds,
  enabled = true,
}: GraphTransientHandoffHudProps): React.JSX.Element | null => {
  const worldLayerRef = useRef<HTMLDivElement | null>(null);
  const shellRefs = useRef(new Map<string, HTMLDivElement | null>());
  const signatureRef = useRef('');
  const [cards, setCards] = useState<TransientHandoffCard[]>([]);
  const { teamData, teams } = useGraphActivityContext(teamName);
  const messageContext = useMemo(() => buildMessageContext(teamData?.members), [teamData?.members]);
  const { teamNames, teamColorByName } = useStableTeamMentionMeta(teams);

  useEffect(() => {
    signatureRef.current = '';
    setCards([]);
  }, [teamName]);

  useLayoutEffect(() => {
    if (!enabled) {
      setCards([]);
      return;
    }

    let frameId = 0;
    const tick = (): void => {
      const snapshot = getTransientHandoffSnapshot({
        focusNodeIds,
        focusEdgeIds,
      });
      const nextCards = snapshot.cards.filter(
        (card) => card.anchorKind === 'lead' || card.anchorKind === 'member'
      );
      const nextSignature = nextCards
        .map((card) => `${card.key}:${card.count}:${card.updatedAt}:${card.anchorNodeId}`)
        .join('|');
      if (nextSignature !== signatureRef.current) {
        signatureRef.current = nextSignature;
        setCards(nextCards);
      }

      const worldLayer = worldLayerRef.current;
      if (worldLayer && worldToScreen) {
        const origin = worldToScreen(0, 0);
        const zoom = Math.max(getCameraZoom(), 0.001);
        worldLayer.style.transform = `translate(${Math.round(origin.x)}px, ${Math.round(origin.y)}px) scale(${zoom.toFixed(3)})`;
      }

      const stackIndexByAnchor = new Map<string, number>();
      for (const card of nextCards) {
        const shell = shellRefs.current.get(card.key);
        if (!shell) {
          continue;
        }

        const nodeWorld = getNodeWorldPosition(card.anchorNodeId);
        const alpha = getTransientHandoffCardAlpha(card, snapshot.time);
        if (!nodeWorld || !worldToScreen || alpha <= 0.001) {
          shell.style.opacity = '0';
          continue;
        }

        const stackIndex = stackIndexByAnchor.get(card.anchorNodeId) ?? 0;
        stackIndexByAnchor.set(card.anchorNodeId, stackIndex + 1);
        const lift = stackIndex * (CARD_HEIGHT * 0.34 + STACK_GAP);
        const scale = 0.94 + alpha * 0.06;

        shell.style.left = `${Math.round(nodeWorld.x)}px`;
        shell.style.top = `${Math.round(nodeWorld.y)}px`;
        shell.style.opacity = String(alpha);
        shell.style.transform = `translate(-50%, calc(-50% - ${lift.toFixed(1)}px)) scale(${scale.toFixed(3)})`;
      }

      frameId = window.requestAnimationFrame(tick);
    };

    tick();
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    enabled,
    focusEdgeIds,
    focusNodeIds,
    getCameraZoom,
    getNodeWorldPosition,
    getTransientHandoffSnapshot,
    worldToScreen,
  ]);

  const handoffMessages = useMemo(
    () =>
      cards.map((card, index) => ({
        card,
        message: buildTransientHandoffMessage(teamName, card),
        zebraShade: index % 2 === 1,
      })),
    [cards, teamName]
  );

  if (!enabled || !teamData || cards.length === 0) {
    return null;
  }

  return (
    <div
      ref={worldLayerRef}
      className="pointer-events-none absolute left-0 top-0 z-[9] origin-top-left select-none"
    >
      {handoffMessages.map(({ card, message, zebraShade }) => (
        <div
          key={card.key}
          ref={(element) => {
            shellRefs.current.set(card.key, element);
          }}
          className="pointer-events-none absolute z-[9] origin-center opacity-0 transition-opacity duration-150 ease-out"
          style={{
            width: `${CARD_WIDTH}px`,
            maxWidth: `${CARD_WIDTH}px`,
          }}
          onDragStart={(event) => {
            event.preventDefault();
          }}
        >
          <GraphActivityCard
            message={message}
            teamName={teamName}
            messageContext={messageContext}
            teamNames={teamNames}
            teamColorByName={teamColorByName}
            zebraShade={zebraShade}
            className="pointer-events-none drop-shadow-[0_0_22px_rgba(94,234,212,0.12)]"
          />
        </div>
      ))}
    </div>
  );
};
