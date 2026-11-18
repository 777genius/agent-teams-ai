import process from 'node:process';

// Serialized into the original final hit sample. This observer has no authority
// to select an option, focus a control, change a deadline, or dispatch input.
function installScheduleOptionObservation(browser, document, option, point, expectedTeamName) {
  const slot = '__teamsScheduleOptionObservation';
  const triggerSelector = '[role=dialog] button[role=combobox]';
  if (Object.getOwnPropertyDescriptor(browser, slot)) return false;
  const record = { version: 1, expectedTeamName, before: null, after: null,
    events: [], eventsCapped: false, finished: null, setup: 'pending', cleanupAttempted: false, cleanupComplete: false };
  const listeners = [];
  const nodeIds = new WeakMap();
  let nextNodeId = 0;
  let disposed = false;
  let trigger = null;
  let popup = null;
  const safely = (read) => { try { return read(); } catch { return null; } };
  const boolean = (value) => typeof value === 'boolean' ? value : null;
  const number = (value) => Number.isFinite(value) && Math.abs(value) <= 1_000_000 ? value : null;
  const contains = (parent, child) => safely(() => Boolean(parent && child && parent.contains(child)));
  const same = (left, right) => left != null && right != null ? left === right : null;
  const tag = (node) => {
    const name = safely(() => node?.tagName);
    return ['BUTTON', 'INPUT', 'DIV', 'SPAN', 'P', 'BODY', 'HTML'].includes(name) ? name : name ? 'other' : null;
  };
  // IDs identify only retained DOM objects within this observer. Never emit DOM
  // text, attributes, selectors, or a foreign team's name in event diagnostics.
  const nodeId = (node) => safely(() => {
    if (!node || typeof node !== 'object') return null;
    if (nodeIds.has(node)) return nodeIds.get(node);
    if (nextNodeId === 64) return null;
    const id = ++nextNodeId;
    nodeIds.set(node, id);
    return id;
  });
  const box = (node) => safely(() => {
    const rect = node?.getBoundingClientRect();
    return rect ? [rect.left, rect.top, rect.width, rect.height].map(number) : null;
  });
  const item = (node) => safely(() => {
    for (let depth = 0; node && depth < 8; node = node.parentElement, depth++) {
      if (node.getAttribute?.('role') === 'option') return node;
    }
    return null;
  });
  const node = (element) => {
    const optionAncestor = item(element);
    return { id: nodeId(element), tag: tag(element), connected: safely(() => boolean(element?.isConnected)),
      box: box(element), item: nodeId(optionAncestor), intended: same(optionAncestor, option), inPopup: contains(popup, element) };
  };
  const scroll = (element) => safely(() => {
    const rows = [];
    let depth = 0;
    for (; element && depth < 8; element = element.parentElement, depth++) {
      if (element.scrollTop || element.scrollLeft || element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
        if (rows.length === 3) return { rows, capped: true };
        // Each row is [observer node ID, scrollLeft, scrollTop].
        rows.push([nodeId(element), number(element.scrollLeft), number(element.scrollTop)]);
      }
    }
    return { rows, capped: Boolean(element) };
  });
  const layout = (target, hit) => ({
    intended: { id: nodeId(option), box: box(option) }, target: node(target), hit: node(hit),
    scroll: { intended: scroll(option), hit: scroll(hit),
      viewport: [browser.scrollX, browser.scrollY, browser.innerWidth, browser.innerHeight].map(number) },
  });
  const state = () => {
    const currentTrigger = safely(() => document.querySelector(triggerSelector));
    const focus = safely(() => document.activeElement);
    return {
      visible: safely(() => document.visibilityState === 'visible'),
      focused: safely(() => document.hasFocus()),
      optionConnected: safely(() => boolean(option?.isConnected)),
      optionDisabled: safely(() => option?.getAttribute('aria-disabled') === 'true'),
      optionSelected: safely(() => option?.getAttribute('aria-selected') === 'true'),
      optionValueMatches: safely(() => option?.getAttribute('data-value') === expectedTeamName),
      triggerConnected: safely(() => boolean(trigger?.isConnected)),
      triggerSame: same(trigger, currentTrigger),
      triggerDisabled: safely(() => Boolean(currentTrigger?.matches(':disabled'))),
      triggerExpanded: safely(() => currentTrigger?.getAttribute('aria-expanded') === 'true'),
      triggerTextMatches: safely(() => currentTrigger?.textContent?.trim() === expectedTeamName),
      focusTag: tag(focus), focusInOption: contains(option, focus), focusInTrigger: contains(trigger, focus),
    };
  };
  const geometry = () => {
    const rect = safely(() => option?.getBoundingClientRect());
    const hit = safely(() => document.elementFromPoint(point.x, point.y));
    let running = 0, animationsCapped = false, ancestorsCapped = false;
    const animations = safely(() => {
      let node = option, depth = 0;
      for (; node && depth < 16; node = node.parentElement, depth++) {
        const rows = node.getAnimations();
        animationsCapped ||= rows.length > 16;
        for (const animation of rows.slice(0, 16)) if (animation.playState === 'running') running++;
      }
      ancestorsCapped = Boolean(node);
      return running;
    });
    return { x: number(point.x), y: number(point.y), left: number(rect?.left), top: number(rect?.top),
      width: number(rect?.width), height: number(rect?.height), hitTag: tag(hit), hitInOption: contains(option, hit),
      animations, animationsCapped, ancestorsCapped };
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    record.cleanupAttempted = true;
    record.cleanupComplete = true;
    for (const [kind, listener, capture] of listeners) {
      try { document.removeEventListener(kind, listener, { capture }); } catch { record.cleanupComplete = false; }
    }
    listeners.length = 0;
  };
  const observe = (event, kind, phase) => {
    try {
      if (disposed) return;
      if (record.events.length >= 12) { record.eventsCapped = true; return; }
      const target = event.target;
      const x = number(event.clientX), y = number(event.clientY);
      const hit = x === null || y === null ? null : safely(() => document.elementFromPoint(x, y));
      record.events.push({ kind, phase, trusted: boolean(event.isTrusted), prevented: boolean(event.defaultPrevented),
        targetTag: tag(target), targetSameOption: same(option, target), targetInOption: contains(option, target),
        targetInTrigger: contains(trigger, target), x, y, hitInOption: contains(option, hit), state: state(),
        // Capture-phase geometry; keep the original bubble state
        // and the existing 12-event / 12 KiB bounds without duplicate geometry.
        layout: phase === 'capture' ? safely(() => layout(target, hit)) : null });
    } catch { /* A failed observation cannot affect delivery or the original wait. */ }
  };
  const recorder = Object.freeze({
    read(teamName, outcome) {
      if (teamName !== expectedTeamName) return null;
      try {
        record.after = { state: state(), geometry: geometry() };
        record.finished = outcome === 'success' ? 'success' : 'failure';
      } catch { record.after = null; }
      finally { dispose(); }
      try {
        const raw = JSON.stringify(record);
        return raw.length <= 12_288 && /^[\x20-\x7e]*$/.test(raw) ? JSON.parse(raw) : null;
      } catch { return null; }
    },
  });
  try {
    trigger = document.querySelector(triggerSelector);
    const popupId = trigger?.getAttribute('aria-controls');
    popup = typeof popupId === 'string' && popupId.length <= 256 ? document.getElementById(popupId) : null;
    record.before = { state: state(), geometry: geometry(),
      optionRoleMatches: option?.getAttribute('role') === 'option', optionInTriggerPopup: contains(popup, option),
      triggerInScheduleDialog: contains(document.querySelector('[role=dialog] #schedule-label')?.closest('[role=dialog]'), trigger) };
    Object.defineProperty(browser, slot, { value: recorder });
    for (const kind of ['pointerdown', 'pointerup', 'click']) for (const capture of [true, false]) {
      const listener = event => observe(event, kind, capture ? 'capture' : 'bubble');
      listeners.push([kind, listener, capture]);
      document.addEventListener(kind, listener, { capture, passive: true });
    }
    record.setup = 'armed';
    return true;
  } catch { record.setup = 'failed'; dispose(); return false; }
}

export function scheduleOptionObservationSource(teamName) {
  try {
    if (typeof teamName !== 'string' || teamName.length > 256 || !/^[a-z0-9-]+$/.test(teamName)) return '';
    return `if (target) { try { (${installScheduleOptionObservation.toString()})(window, document, element, target, ${JSON.stringify(teamName)}); } catch {} }`;
  } catch { return ''; }
}

export async function observeScheduleTeamSelection(client, teamName) {
  const teamOption = "Array.from(document.querySelectorAll('[cmdk-item]'))" +
    ".find(option => option.textContent?.includes(" + JSON.stringify(teamName) + "))";
  let outcome = 'failure';
  try {
    await client.click(teamOption, null, teamName);
    await client.waitFor(
      "document.querySelector('[role=dialog] button[role=combobox]')?.textContent?.trim() === " +
        JSON.stringify(teamName) + " && document.querySelector('#schedule-saved-prompt-reviewed')",
      'saved prompt acknowledgement for the exact fixture team visible before Save', 45_000);
    outcome = 'success';
  } finally {
    try {
      const snapshot = await client.evaluate(`(() => { try {
        return window.__teamsScheduleOptionObservation?.read(${JSON.stringify(teamName)}, ${JSON.stringify(outcome)}) ?? null;
      } catch { return null; } })()`);
      process.stderr.write(`${JSON.stringify({ label: 'schedule-team-option-observation', snapshot, cleanupConfirmed: snapshot?.cleanupComplete === true })}\n`);
    } catch {
      try { process.stderr.write('{"label":"schedule-team-option-observation","snapshot":null,"readUnavailable":true,"cleanupConfirmed":false}\n'); }
      catch { /* Diagnostics and their cleanup cannot replace the original outcome. */ }
    }
  }
}
