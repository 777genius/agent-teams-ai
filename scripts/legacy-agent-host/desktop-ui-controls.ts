import assert from 'node:assert/strict';

const literalEscapes: Readonly<Record<string, string>> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\0': '\\u0000',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};
/** Serialize data embedded in TEST CDP JavaScript; never concatenate it as source. */
export function desktopJsLiteral(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') throw new TypeError('TEST CDP value is not JSON-serializable');
  return serialized.replace(/[<>\b\f\n\r\t\0\u2028\u2029]/g, (char) => literalEscapes[char]!);
}

export interface UiCdpPort {
  evaluate(expression: string): Promise<unknown>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
/** Shared TEST renderer input/navigation. DOM evaluation never dispatches app actions. */
export function createDesktopUiControls(
  cdp: UiCdpPort,
  options: {
    assertOwnedRenderer(): void;
    step(value: Record<string, unknown>): void;
  }
) {
  const step = options.step;
  const observeInput = async (): Promise<void> => {
    // macOS occlusion can leave this TEST Electron page hidden after reload.
    // Chromium then acknowledges Input commands without delivering DOM events.
    // Focus emulation is confined to this captured TEST renderer, never app state.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // TEST-only passive observation; handlers never prevent, dispatch or mutate app state.
    await cdp.evaluate(`(() => {
      window.__TEST_desktopInputEvents=[];
      window.__TEST_desktopDragEvents=[];
      const describe=el=>el instanceof Element?{tag:el.tagName,id:el.id,ariaLabel:el.getAttribute('aria-label'),className:String(el.className).slice(0,120)}:null;
      for(const type of ['pointerdown','pointerup','pointercancel','pointermove','click','keydown','keyup','focusin','focusout'])document.addEventListener(type,e=>{
        if(type==='pointermove'&&!e.buttons)return;
        const dragging=type==='pointermove'||type==='pointercancel';
        const rows=dragging?window.__TEST_desktopDragEvents:window.__TEST_desktopInputEvents;if(rows.length>=(dragging?32:96))rows.shift();
        const el=e.target instanceof Element?e.target.closest('button'):null;
        const row={type,timeMs:Math.round(performance.now()),x:e.clientX,y:e.clientY,button:e.button,buttons:e.buttons,key:e.key,code:e.code,
          trusted:e.isTrusted,buttonClass:el?.className?.slice(0,120)??null,
          target:describe(e.target),focusBefore:describe(document.activeElement),defaultPreventedBefore:e.defaultPrevented,
          sidebarRow:Boolean(el?.classList.contains('sidebar-task-item')),
          taskId:e.target instanceof Element?e.target.closest('.kanban-task-card')?.getAttribute('data-task-id')??null:null,
          activeSortable:[...document.querySelectorAll('[aria-roledescription="sortable"][aria-pressed="true"]')].map(el=>({taskId:el.querySelector('.kanban-task-card')?.getAttribute('data-task-id'),transform:el.style.transform})),
          dragAnnouncement:[...document.querySelectorAll('[id^="DndLiveRegion-"]')].map(el=>el.textContent)};
        rows.push(row);queueMicrotask(()=>{row.defaultPreventedAfterMicrotask=e.defaultPrevented;row.focusAfterMicrotask=describe(document.activeElement);
          setTimeout(()=>{row.defaultPreventedAfterDispatch=e.defaultPrevented;row.focusAfterDispatch=describe(document.activeElement);},0);});
      },{capture:true,passive:true});return true;
    })()`);
    assert.equal(
      await cdp.evaluate('document.visibilityState'),
      'visible',
      'captured TEST renderer is visible before dispatching user input'
    );
  };
  const waitRead = async (
    expression: string,
    label: string,
    timeoutMs = 30_000
  ): Promise<unknown> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      options.assertOwnedRenderer();
      try {
        const value = await cdp.evaluate(expression);
        if (value) return value;
      } catch (error) {
        if (
          !/execution context was destroyed|cannot find (?:default )?execution context|cannot find context with specified id/i.test(
            String(error)
          )
        )
          throw error;
      }
      await new Promise<void>((done) => setTimeout(done, 100));
    }
    throw new Error(`UI read timed out: ${label}; no mutation retry`);
  };
  // Each expression is a read-only DOM lookup returning at most one exact target.
  const target = (selector: string, text?: string): string => `(() => {
    const elements = [...document.querySelectorAll(${desktopJsLiteral(selector)})].filter(e => {
      const r=e.getBoundingClientRect(); return r.width>0&&r.height>0${text === undefined ? '' : `&&e.textContent.trim()===${desktopJsLiteral(text)}`};
    });
    if(elements.length!==1)return null;
    const e=elements[0], r=e.getBoundingClientRect(), x=r.x+r.width/2,y=r.y+r.height/2;
    const hit=document.elementFromPoint(x,y);
    if(!hit||!(hit===e||e.contains(hit))||e.matches(':disabled'))return null;
    return {x,y,text:e.textContent.trim().slice(0,300),tag:e.tagName};
  })()`;
  const click = async (selector: string, label: string, text?: string): Promise<void> => {
    await cdp.send('Page.bringToFront');
    let point = record(await waitRead(target(selector, text), label));
    options.assertOwnedRenderer();
    step({ action: 'mouseMoved', label: 'hover ' + label, selector, target: point });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    point = record(await waitRead(target(selector, text), label + ' after pointer enter'));
    assert.equal(typeof point.x, 'number');
    assert.equal(typeof point.y, 'number');
    options.assertOwnedRenderer();
    step({
      action: 'mouseClick',
      label,
      selector,
      expectedText: text,
      target: point,
      state: 'attempted',
    });
    // Never repeat a click after an uncertain response.
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
  };
  const scrollTo = async (selector: string, label: string, text?: string): Promise<void> => {
    for (let attempt = 0; attempt < 12; attempt++) {
      options.assertOwnedRenderer();
      const found = record(
        await waitRead(
          `(() => {
        const rows=[...document.querySelectorAll(${desktopJsLiteral(selector)})]${text === undefined ? '' : `.filter(e=>e.textContent.trim()===${desktopJsLiteral(text)})`};
        if(rows.length!==1)return null;
        const e=rows[0],r=e.getBoundingClientRect();
        let parent=e.parentElement;
        while(parent&&!(parent.scrollHeight>parent.clientHeight&&/auto|scroll/.test(getComputedStyle(parent).overflowY)))parent=parent.parentElement;
        const p=(parent??document.documentElement).getBoundingClientRect();
        const top=Math.max(0,p.top),bottom=Math.min(innerHeight,p.bottom);
        if(bottom<=top||!r.width||!r.height)return null;
        const x=Math.max(1,Math.min(innerWidth-1,p.x+p.width/2)),y=(top+bottom)/2;
        return {visible:r.top>=top&&r.bottom<=bottom,x,y,delta:Math.max(-600,Math.min(600,r.y+r.height/2-y))};
      })()`,
          label
        )
      );
      if (found.visible === true) return;
      assert.equal(typeof found.x, 'number');
      assert.equal(typeof found.y, 'number');
      assert.equal(typeof found.delta, 'number');
      step({ action: 'mouseWheel', label, selector, deltaY: found.delta });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: found.x,
        y: found.y,
        deltaX: 0,
        deltaY: found.delta,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`UI scroll timed out: ${label}; no effect retry`);
  };
  const sidebarExpression = (subject: string): string => `(() => {
    const rows=[...document.querySelectorAll('#sidebar-tasks-panel .sidebar-task-item')];
    const found=rows.filter(e=>[...e.querySelectorAll('span')].some(s=>s.textContent.trim()===${desktopJsLiteral(subject)}));
    if(found.length!==1)return null;
    return true;
  })()`;
  // Subject span selection is exact, and the click targets its ordinary button.
  const clickSidebar = async (subject: string): Promise<void> => {
    await cdp.send('Page.bringToFront');
    // The dev renderer can expose its bridge while modules and the first Team
    // snapshot are still loading. Only this initial read gets a startup budget;
    // clicks and mutation outcomes retain their existing bounds/no-retry rule.
    await waitRead(sidebarExpression(subject), 'canonical sidebar task', 90_000);
    const expression = `(() => {
      const rows=[...document.querySelectorAll('#sidebar-tasks-panel .sidebar-task-item')];
      const found=rows.filter(e=>[...e.querySelectorAll('span')].some(s=>s.textContent.trim()===${desktopJsLiteral(subject)}));
      if(found.length!==1)return null;
      const e=found[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
      return r.width>0&&r.height>0&&hit&&(e===hit||e.contains(hit))?{x,y}:null;
    })()`;
    const hoverPoint = record(await waitRead(expression, 'visible sidebar seed row'));
    options.assertOwnedRenderer();
    step({
      action: 'mouseMoved',
      label: 'hover sidebar row before measuring click',
      subject,
      target: hoverPoint,
    });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverPoint });
    // The ordinary row reveals owner/team details on pointer enter, changing its
    // height. Measure after that layout, as a human moving the mouse would do.
    // Background Electron windows throttle animation frames; use bounded reads
    // of the actual geometry instead of waiting for renderer frame callbacks.
    let point = record(await waitRead(expression, 'hovered sidebar row'));
    let stable = false;
    for (let sample = 0; sample < 10; sample++) {
      await new Promise<void>((done) => setTimeout(done, 100));
      const next = record(await waitRead(expression, 'hovered sidebar row geometry'));
      stable = point.x === next.x && point.y === next.y;
      point = next;
      if (stable) break;
    }
    assert.ok(stable, 'hovered row geometry stabilizes before the one click');
    options.assertOwnedRenderer();
    step({
      action: 'mouseClick',
      label: 'sidebar task',
      subject,
      target: point,
      state: 'attempted',
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    step({
      observation: 'passive input delivery after sidebar click',
      value: await cdp.evaluate(
        '({focused:document.hasFocus(),visibility:document.visibilityState,events:window.__TEST_desktopInputEvents})'
      ),
    });
    await click('[role="dialog"] button', 'Open team', 'Open team');
  };
  return { observeInput, waitRead, click, clickSidebar, scrollTo };
}
