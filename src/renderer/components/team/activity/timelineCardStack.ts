export type TimelineCardPosition = 'single' | 'first' | 'middle' | 'last';

const TIMELINE_CARD_RADIUS = '0.375rem';

export function getTimelineCardPosition(
  hasPreviousCard: boolean,
  hasNextCard: boolean
): TimelineCardPosition {
  if (!hasPreviousCard && !hasNextCard) return 'single';
  if (!hasPreviousCard) return 'first';
  if (!hasNextCard) return 'last';
  return 'middle';
}

export function getTimelineCardBorderRadius(position: TimelineCardPosition = 'single'): string {
  switch (position) {
    case 'first':
      return `${TIMELINE_CARD_RADIUS} ${TIMELINE_CARD_RADIUS} 0 0`;
    case 'middle':
      return '0';
    case 'last':
      return `0 0 ${TIMELINE_CARD_RADIUS} ${TIMELINE_CARD_RADIUS}`;
    case 'single':
    default:
      return TIMELINE_CARD_RADIUS;
  }
}

export function joinsPreviousTimelineCard(position: TimelineCardPosition = 'single'): boolean {
  return position === 'middle' || position === 'last';
}

export function getTimelineHeaderGradient(accentColor: string, isLight: boolean): string {
  const mix = isLight ? '9%' : '15%';
  return `linear-gradient(180deg, color-mix(in srgb, ${accentColor} ${mix}, transparent) 0%, transparent 58%)`;
}
