// Read-only DOM history around endpoint Save. Never capture the token input value.
export const startProviderUiDiagnostics = `(() => {
  const frames = [];
  const identities = new WeakMap();
  let nextIdentity = 0;
  let previous = '';
  let droppedFrames = 0;
  const capture = () => {
    const dialog = document.querySelector('[role=dialog]');
    if (dialog && !identities.has(dialog)) identities.set(dialog, ++nextIdentity);
    const cards = [...(dialog?.querySelectorAll('[data-testid^="connection-method-"]') ?? [])];
    const endpoint = dialog?.querySelector('#anthropic-compatible-base-url');
    const token = dialog?.querySelector('#anthropic-compatible-auth-token');
    const frame = {
      dialogIdentity: dialog ? identities.get(dialog) : null,
      selectedTab: dialog?.querySelector('[role=tab][aria-selected=true]')?.textContent?.trim() ?? null,
      cards: cards.map(card => ({
        id: card.getAttribute('data-testid'),
        checked: card.getAttribute('aria-checked'),
        disabled: card.disabled,
      })),
      endpointInputPresent: Boolean(endpoint),
      endpointUrl: endpoint?.value ?? null,
      tokenInputPresent: Boolean(token),
      tokenInputHasValue: Boolean(token?.value),
      summary: dialog?.querySelector('[data-testid=provider-runtime-summary]')?.textContent?.trim() ?? null,
    };
    const serialized = JSON.stringify(frame);
    if (serialized === previous) return;
    previous = serialized;
    frames.push({ at: new Date().toISOString(), ...frame });
    if (frames.length > 64) { frames.shift(); droppedFrames += 1; }
  };
  const observer = new MutationObserver(capture);
  observer.observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['aria-checked', 'aria-selected', 'disabled'],
  });
  capture();
  globalThis.__issue684_providerUiDiagnostics = () => {
    capture();
    observer.disconnect();
    return { frames, droppedFrames, dialogInstances: nextIdentity };
  };
})()`;

export const readProviderUiDiagnostics = `globalThis.__issue684_providerUiDiagnostics?.() ?? null`;
