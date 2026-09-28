/** The floating composer can cover the bottom of the conversation scroll area. */
export function findConversationFooter(scroll: HTMLElement): HTMLElement | null {
  return (
    scroll
      .closest<HTMLElement>('[data-messages-thread-layout]')
      ?.querySelector<HTMLElement>('[data-messages-thread-footer]') ?? null
  );
}

export function getConversationVisibleBottom(scroll: HTMLElement): number {
  const scrollRect = scroll.getBoundingClientRect();
  const footer = findConversationFooter(scroll);
  if (!footer) return scrollRect.bottom;

  const footerRect = footer.getBoundingClientRect();
  if (footerRect.bottom <= scrollRect.top || footerRect.top >= scrollRect.bottom) {
    return scrollRect.bottom;
  }
  const fade = scroll.parentElement?.querySelector<HTMLElement>(
    '[data-messages-thread-footer-fade]'
  );
  return Math.max(scrollRect.top, fade?.getBoundingClientRect().top ?? footerRect.top);
}
