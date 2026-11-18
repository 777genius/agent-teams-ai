import assert from 'node:assert/strict';
import { PROVIDER_LAUNCH_AUTHORITY_MARKER_ATTRIBUTE, PROVIDER_LAUNCH_AUTHORITY_MARKER_LIMIT,
  readProviderLaunchAuthorityMarker, UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER
} from '../../src/shared/utils/providerLaunchAuthorityMarker.ts';

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
interface ScrollBeforeClick {
  label: string;
  selector?: string;
  requireCenterHit?: true;
}

/** Observe two visible renderer frames without changing focus, DOM, or input. */
export function desktopAnimationFramesExpression(remainingMs: number): string {
  assert.ok(Number.isFinite(remainingMs) && remainingMs > 0 && remainingMs <= 30_000);
  return `new Promise(resolve => {
    if(document.visibilityState!=='visible'){resolve(false);return;}
    let frame=0,finished=false;
    const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);cancelAnimationFrame(frame);resolve(value);};
    const timer=setTimeout(()=>finish(false),${remainingMs});
    frame=requestAnimationFrame(()=>{
      if(finished)return;
      frame=requestAnimationFrame(()=>finish(document.visibilityState==='visible'));
    });
  })`;
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
      const teamNavigation=e=>{
        const own=(value,key)=>{if(!value||(typeof value!=='object'&&typeof value!=='function'))throw Error();const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d))throw Error();return d.value;};
        const id=value=>typeof value==='string'&&value.length>0&&value.length<=128&&!/[^A-Za-z0-9_.:-]/.test(value);
        const key=value=>{if(typeof value!=='string'||value.length>256||!value.startsWith('host-team:'))return false;const handle=decodeURIComponent(value.slice(10));return handle.length>0&&handle.length<=256&&!handle.includes('\\0')&&'host-team:'+encodeURIComponent(handle)===value;};
        const sample=()=>{
          try{
            const store=own(window,'__agentTeamsDevStore'),getState=own(store,'getState');if(typeof getState!=='function')throw Error();
            const state=getState.call(store),layout=own(state,'paneLayout'),focused=own(layout,'focusedPaneId'),panes=own(layout,'panes'),selected=own(state,'selectedTeamName');
            if(!id(focused)||!(selected===null||key(selected))||!Array.isArray(panes))throw Error();
            const paneCount=own(panes,'length');if(!Number.isSafeInteger(paneCount)||paneCount<1||paneCount>4)throw Error();
            const seen=new Set();let pane=null;
            for(let index=0;index<paneCount;index++){const item=own(panes,index),paneId=own(item,'id');if(!id(paneId)||seen.has(paneId))throw Error();seen.add(paneId);if(paneId===focused)pane=item;}
            if(!pane)throw Error();const active=own(pane,'activeTabId'),tabs=own(pane,'tabs');
            if(!(active===null||id(active))||!Array.isArray(tabs))throw Error();
            const tabCount=own(tabs,'length');if(!Number.isSafeInteger(tabCount)||tabCount<0||tabCount>128)throw Error();
            let tab=null,tabType=null,tabTeam=null;
            if(active!==null){
              for(let index=0;index<tabCount;index++){const item=own(tabs,index),tabId=own(item,'id');if(!id(tabId))throw Error();if(tabId===active){if(tab)throw Error();tab=item;}}
              if(!tab)throw Error();const type=own(tab,'type');if(typeof type!=='string'||!type)throw Error();tabType=type==='team'?'team':'other';
              if(tabType==='team'){tabTeam=own(tab,'teamName');if(!key(tabTeam))throw Error();}
            }
            return {status:'available',focusedPaneId:focused,activeTabId:active,activeTabType:tabType,activeTabTeamName:tabTeam,selectedTeamName:selected};
          }catch{return {status:'unavailable'};}
        };
        let target=null;
        try{const card=e.target instanceof Element?e.target.closest('[data-team-name]'):null;if(card&&card.matches('.team-row-zebra-card')){const name=card.getAttribute('data-team-name');target=key(name)?name:undefined;}}catch{target=undefined;}
        let observation=target===null?null:typeof target==='string'?{schemaVersion:1,status:'available',source:'original-passive-input',atomicWithNavigation:false,targetTeamName:target,before:null,microtask:null,afterDispatch:null}:{schemaVersion:1,status:'unavailable',reason:'target'};
        return (row,phase)=>{
          try{
            if(observation?.status==='available')observation=Object.freeze({...observation,[phase]:Object.freeze(sample())});
            row.teamNavigation=JSON.stringify(observation).length<=4096?observation:{schemaVersion:1,status:'unavailable',reason:'projection-limit'};
          }catch{}
        };
      };
      const taskClarification=e=>{
        try{
          const target=e.target instanceof Element?e.target:null,dialog=target?.closest('[role="dialog"]');
          if(!dialog||!dialog.getClientRects().length)return null;
          const buttons=dialog.querySelectorAll('button');if(buttons.length>128)return null;
          const matches=[...buttons].filter(button=>button.textContent?.trim()==='Mark resolved');
          if(matches.length!==1||!(matches[0] instanceof HTMLButtonElement))return null;
          const control=matches[0],rect=control.getBoundingClientRect();
          const point=Number.isFinite(e.clientX)&&Number.isFinite(e.clientY);
          const geometry=[rect.left,rect.right,rect.top,rect.bottom,rect.width,rect.height].every(Number.isFinite);
          const hit=point?document.elementFromPoint(e.clientX,e.clientY):null;
          const pointer=getComputedStyle(control).pointerEvents;
          const facts={
            targetIsControl:target===control||control.contains(target),
            targetIsControlParent:target===control.parentElement,
            pointInsideControl:point&&geometry?rect.width>0&&rect.height>0&&e.clientX>=rect.left&&e.clientX<rect.right&&e.clientY>=rect.top&&e.clientY<rect.bottom:null,
            pointHitsControl:point?hit===control||control.contains(hit):null,
            controlConnected:control.isConnected,controlDisabled:control.disabled,
            pointerEvents:pointer==='auto'||pointer==='none'?pointer:typeof pointer==='string'&&pointer?'other':null,
            renderedOwner:null,storedSurfaceMatches:null,storedRevisionMatches:null,
            contextMatches:null,selectedTeamMatches:null,detailPhase:null,
            detailLoading:null,detailRefreshPending:null,deletionIntentPresent:null
          };
          const finish=()=>JSON.stringify(facts).length<=768?facts:null;
          const own=(value,key)=>{
            if(!value||(typeof value!=='object'&&typeof value!=='function'))return undefined;
            const descriptor=Object.getOwnPropertyDescriptor(value,key);
            return descriptor&&'value' in descriptor?descriptor.value:undefined;
          };
          const text=value=>typeof value==='string'&&value.length>0;
          const bool=value=>typeof value==='boolean'?value:null;
          const currentFiber=node=>{
            const keys=Object.keys(node).filter(key=>key.startsWith('__reactFiber$'));
            if(keys.length!==1)return null;const fiber=own(node,keys[0]);
            for(const candidate of [fiber,own(fiber,'alternate')]){
              if(!candidate)continue;let root=candidate,depth=0;
              while(own(root,'return')&&depth++<256)root=own(root,'return');
              if(!own(root,'return')&&own(own(root,'stateNode'),'current')===root)return candidate;
            }
            return null;
          };
          const controllers=new Set();let ambiguous=false,fiber=currentFiber(dialog),depth=0;
          for(;fiber&&depth<128;fiber=own(fiber,'return'),depth++){
            const props=own(fiber,'memoizedProps'),controller=own(props,'sessionController');
            if(own(props,'open')!==true||controller===undefined)continue;
            const identity=own(controller,'identity'),team=own(props,'teamName'),task=own(own(props,'task'),'id');
            if(!text(team)||!text(task)||!text(own(identity,'contextId'))||
              own(identity,'teamName')!==team||own(identity,'taskId')!==task||!text(own(controller,'surfaceId'))){
              ambiguous=true;continue;
            }
            controllers.add(controller);
          }
          if(fiber||ambiguous||controllers.size!==1)return finish();
          const controller=[...controllers][0],identity=own(controller,'identity'),surface=own(controller,'surfaceId');
          facts.renderedOwner=bool(own(controller,'isOwner'));
          const getState=own(own(window,'__agentTeamsDevStore'),'getState');
          if(typeof getState!=='function')return finish();const state=getState();
          const context=own(identity,'contextId'),team=own(identity,'teamName'),task=own(identity,'taskId');
          const key=JSON.stringify([context,team,task]);
          const session=own(own(state,'taskDetailSessionById'),key),renderedSession=own(controller,'session');
          const storedSurface=own(session,'ownerSurfaceId');
          facts.storedSurfaceMatches=storedSurface===null||text(storedSurface)?storedSurface===surface:null;
          const storedRevision=own(session,'ownerRevision'),renderedRevision=own(renderedSession,'ownerRevision');
          facts.storedRevisionMatches=Number.isSafeInteger(storedRevision)&&storedRevision>=0&&Number.isSafeInteger(renderedRevision)&&renderedRevision>=0?storedRevision===renderedRevision:null;
          const activeContext=own(state,'activeContextId'),switching=own(state,'isContextSwitching'),selectedTeam=own(state,'selectedTeamName');
          facts.contextMatches=text(activeContext)&&typeof switching==='boolean'?!switching&&activeContext===context:null;
          facts.selectedTeamMatches=selectedTeam===null||text(selectedTeam)?selectedTeam===team:null;
          const detail=own(own(state,'taskDetailById'),key),detailIdentity=own(detail,'identity');
          if(own(detailIdentity,'contextId')===context&&own(detailIdentity,'teamName')===team&&own(detailIdentity,'taskId')===task){
            const phase=own(detail,'phase'),deletion=own(detail,'deletionIntent');
            facts.detailPhase=['hydrating','ready','missing','deleted','provisioning','unavailable'].includes(phase)?phase:null;
            facts.detailLoading=bool(own(detail,'loading'));facts.detailRefreshPending=bool(own(detail,'refreshPending'));
            facts.deletionIntentPresent=deletion===null?false:deletion==='deleting'||deletion==='restoring'?true:null;
          }
          return finish();
        }catch{return null;}
      };
      for(const type of ['pointerdown','pointerup','pointercancel','pointermove','click','keydown','keyup','focusin','focusout'])document.addEventListener(type,e=>{
        if(type==='pointermove'&&!e.buttons)return;
        const navigation=type==='pointerdown'||type==='pointerup'||type==='click'?teamNavigation(e):null;
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
        if(type==='pointerdown'||type==='pointerup'||type==='click')row.taskClarification=taskClarification(e);
        if(navigation)navigation(row,'before');
        rows.push(row);queueMicrotask(()=>{row.defaultPreventedAfterMicrotask=e.defaultPrevented;row.focusAfterMicrotask=describe(document.activeElement);
          if(navigation)navigation(row,'microtask');
          setTimeout(()=>{row.defaultPreventedAfterDispatch=e.defaultPrevented;row.focusAfterDispatch=describe(document.activeElement);if(navigation)navigation(row,'afterDispatch');},0);});
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
    timeoutMs = 30_000,
    isReady: (value: unknown) => boolean = Boolean,
    readOptions?: { deadline: number; beforeRead?(): Promise<void> },
    diagnosticPhase: 'initial' | 'after-hover' | 'stable' | 'other' = 'other'
  ): Promise<unknown> => {
    const deadline = readOptions?.deadline ?? Date.now() + timeoutMs;
    const observation = {
      phase: ['initial', 'after-hover', 'stable'].includes(diagnosticPhase) ? diagnosticPhase : 'other',
      boundary: 'loop', cutoff: 'none', firstCheckAtMs: null as number | null, lastCheckAtMs: null as number | null,
      ownerStarted: 0, ownerResolved: 0, preparationStarted: 0, preparationResolved: 0,
      readsStarted: 0, readsResolved: 0, postReadLate: 0, contextRetries: 0,
    };
    const checkTime = (): number => {
      const now = Date.now();
      observation.firstCheckAtMs ??= now; observation.lastCheckAtMs = now;
      return now;
    };
    try {
      while (checkTime() < deadline) {
        observation.boundary = 'owner'; observation.ownerStarted = Math.min(observation.ownerStarted + 1, 4096);
        options.assertOwnedRenderer();
        observation.ownerResolved = Math.min(observation.ownerResolved + 1, 4096);
        if (readOptions?.beforeRead) {
          // Preparation failures are terminal, including context-like input errors.
          observation.boundary = 'preparation'; observation.preparationStarted = Math.min(observation.preparationStarted + 1, 4096);
          await readOptions.beforeRead();
          observation.preparationResolved = Math.min(observation.preparationResolved + 1, 4096);
          observation.boundary = 'owner'; observation.ownerStarted = Math.min(observation.ownerStarted + 1, 4096);
          options.assertOwnedRenderer();
          observation.ownerResolved = Math.min(observation.ownerResolved + 1, 4096);
          if (checkTime() >= deadline) { observation.cutoff = 'after-preparation'; break; }
        }
        try {
          observation.boundary = 'evaluate'; observation.readsStarted = Math.min(observation.readsStarted + 1, 4096);
          const value = await cdp.evaluate(expression);
          observation.readsResolved = Math.min(observation.readsResolved + 1, 4096);
          if (checkTime() >= deadline) { observation.cutoff = 'after-evaluate'; observation.postReadLate++; break; }
          observation.boundary = 'predicate';
          if (isReady(value)) return value;
        } catch (error) {
          if (
            !/execution context was destroyed|cannot find (?:default )?execution context|cannot find context with specified id/i.test(
              String(error)
            )
          )
            throw error;
          observation.contextRetries = Math.min(observation.contextRetries + 1, 4096);
        }
        observation.boundary = 'pause';
        await new Promise<void>((done) => setTimeout(done, 100));
      }
      if (observation.cutoff === 'none') observation.cutoff = 'loop';
      throw new Error(`UI read timed out: ${label}; no mutation retry`);
    } catch (error) {
      try {
        const stamp = (value: number | null): number | null =>
          typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
        console.log(JSON.stringify({ kind: 'TEST_DESKTOP_READ_WAIT', read: {
          ...observation, deadlineMs: stamp(deadline),
          firstCheckAtMs: stamp(observation.firstCheckAtMs), lastCheckAtMs: stamp(observation.lastCheckAtMs),
        } }));
      } catch {
        // Reporting uses no extra clock, owner or DOM read and cannot replace the original refusal.
      }
      throw error;
    }
  };
  const finiteSourceCreate = (selector: string | undefined, label: string, text: string | undefined): boolean =>
    selector === '[data-testid="create-team-page"] button' &&
    label === 'Create and Launch original solo source exactly once' && text === 'Create';
  const createFactsExpression = `(() => {
    try {
      const page=e.closest('[data-testid="create-team-page"]');
      if(!page||document.querySelectorAll('[data-testid="create-team-page"]').length!==1)return {createPageUnique:false};
      return {
        createPageUnique:true,
        createLaunchChecked:page.querySelector('#launch-team')?.getAttribute('data-state')==='checked',
        createAuthorityDescribed:e.getAttribute('aria-describedby')==='create-team-launch-authority-blocker',
        createAuthorityNoticePresent:Boolean(page.querySelector('#create-team-launch-authority-blocker')),
        createSubmittingSpinner:Boolean(e.querySelector('svg.animate-spin')),
        createAlertCount:Math.min(page.querySelectorAll('[role="alert"]').length,33),
        createInvalidAttributeCount:Math.min(page.querySelectorAll('[aria-invalid="true"]').length,33),
        createAuthorityMarker:(()=>{try{const notices=page.querySelectorAll('#create-team-launch-authority-blocker');
          if(notices.length!==1)return null;
          const marker=notices[0].getAttribute(${desktopJsLiteral(PROVIDER_LAUNCH_AUTHORITY_MARKER_ATTRIBUTE)});
          return typeof marker==='string'&&marker.length<=${PROVIDER_LAUNCH_AUTHORITY_MARKER_LIMIT}?marker:null;
        }catch{return null;}})()
      };
    } catch { return null; }
  })()`;
  // Each expression is a read-only DOM lookup returning at most one exact target.
  const target = (selector: string, text?: string, requiredContent?: string, createDiagnostics = false): string => `(() => {
    const elements = [...document.querySelectorAll(${desktopJsLiteral(selector)})].filter(e => {
      const r=e.getBoundingClientRect(); return r.width>0&&r.height>0${text === undefined ? '' : `&&e.textContent.trim()===${desktopJsLiteral(text)}`};
    });
    if(elements.length!==1)return {unavailableTarget:true,matches:Math.min(elements.length,256)};${requiredContent === undefined ? '' : `
    if(!elements[0].textContent.includes(${desktopJsLiteral(requiredContent)}))return {unavailableTarget:true,matches:1};`}
    const e=elements[0], r=e.getBoundingClientRect(), x=r.x+r.width/2,y=r.y+r.height/2;
    const hit=document.elementFromPoint(x,y), disabled=e.matches(':disabled');
    if(!hit||!(hit===e||e.contains(hit))||disabled)return {
      unavailableTarget:true,matches:1,disabled,ariaDisabled:e.getAttribute('aria-disabled')==='true',
      pointerEventsNone:getComputedStyle(e).pointerEvents==='none',
      centerInViewport:x>=0&&y>=0&&x<innerWidth&&y<innerHeight,hitPresent:Boolean(hit)${createDiagnostics ? `,createFacts:${createFactsExpression}` : ''}
    };
    const geometry=(() => {
      try {
        const rectangle=value => {
          const numbers=[value.x,value.y,value.width,value.height];
          return numbers.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=1000000)?numbers:null;
        };
        const animations=value => {
          if(!value||typeof value.getAnimations!=='function')return null;
          const items=value.getAnimations();
          return items.length>64?65:items.filter(item=>item.playState==='running'||item.pending===true).length;
        };
        const dialog=e.closest('[role="dialog"]'), fonts=document.fonts?.status;
        return {targetRect:rectangle(r),dialogRect:dialog?rectangle(dialog.getBoundingClientRect()):null,
          targetAnimations:animations(e),dialogAnimations:animations(dialog),
          fonts:fonts==='loaded'||fonts==='loading'?fonts:null};
      } catch { return null; }
    })();
    return {x,y,text:e.textContent.trim().slice(0,300),tag:e.tagName,geometry};
  })()`;
  const clickExpression = async (
    expression: string,
    label: string,
    selector?: string,
    text?: string,
    readiness?: { waitForFinalReadiness?: true; waitForRenderFrames?: true; scrollBeforeClick?: ScrollBeforeClick }
  ): Promise<void> => {
    await cdp.send('Page.bringToFront');
    // Every passive phase spends the original first-read budget, including a
    // temporarily pending owner at the final lookup. Never reset it after hover.
    const readDeadline = Date.now() + 30_000;
    const assertReadDeadline = (): void => {
      if (Date.now() >= readDeadline) {
        // Preserve any stricter caller-owned cutoff or renderer refusal.
        options.assertOwnedRenderer();
        throw new Error(`UI read timed out: ${label} final target; no mutation retry`);
      }
    };
    const scroll = readiness?.scrollBeforeClick && { ...readiness.scrollBeforeClick };
    const scrollBudget = { deadline: readDeadline, remainingWheels: 12 };
    const prepareScroll = scroll ? async (): Promise<void> => {
      assert.equal(typeof selector, 'string', 'original click selector is required for preparation');
      options.assertOwnedRenderer();
      assertReadDeadline();
      await scrollTo(scroll.selector ?? selector!, scroll.label, text, 12,
        { requireCenterHit: scroll.requireCenterHit }, scrollBudget);
      options.assertOwnedRenderer();
      assertReadDeadline();
    } : undefined;
    const geometryTrace: { samples: Record<string, unknown>[]; overflow: boolean } = { samples: [], overflow: false };
    const observeGeometry = (phase: 'initial' | 'after-hover' | 'stable' | 'final', point: Record<string, unknown>): void => {
      try {
        if (geometryTrace.samples.length >= 18) { geometryTrace.overflow = true; return; }
        const own = (value: unknown, key: string): unknown => {
          if (!value || typeof value !== 'object') return undefined;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          return descriptor && 'value' in descriptor ? descriptor.value : undefined;
        };
        const finite = (value: unknown): number | null =>
          typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000 ? value : null;
        const rectangle = (value: unknown): number[] | null => {
          if (!Array.isArray(value) || own(value, 'length') !== 4) return null;
          const numbers = ['0', '1', '2', '3'].map(key => finite(own(value, key)));
          return numbers.every(number => number !== null) ? numbers as number[] : null;
        };
        const count = (value: unknown): number | null =>
          typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65 ? value : null;
        const geometry = own(point, 'geometry'), tag = own(point, 'tag'), fonts = own(geometry, 'fonts');
        geometryTrace.samples.push({
          phase, unavailable: own(point, 'unavailableTarget') === true, x: finite(own(point, 'x')), y: finite(own(point, 'y')),
          tag: tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' ? tag : null,
          targetRect: rectangle(own(geometry, 'targetRect')), dialogRect: rectangle(own(geometry, 'dialogRect')),
          targetAnimations: count(own(geometry, 'targetAnimations')), dialogAnimations: count(own(geometry, 'dialogAnimations')),
          fonts: fonts === 'loaded' || fonts === 'loading' ? fonts : null,
        });
      } catch {
        // Missing diagnostic data never changes the original target or failure.
      }
    };
    // Reuse the original passive reads and deadline. Retain only closed facts,
    // never raw DOM text/HTML, unvalidated attributes or another request after a failed click.
    const readPoint = async (phase: string): Promise<Record<string, unknown>> => {
      const bootstrapRead = phase === label && label === 'open existing More menu' &&
        selector === 'button[aria-label="More actions"]';
      const readExpression = bootstrapRead
        ? `(() => {
            const point = ${expression};
            if (!point || point.unavailableTarget !== true) return point;
            try {
              const root = document.getElementById('root'), splash = document.getElementById('splash');
              const bounds = splash?.getBoundingClientRect(), child = root?.firstElementChild;
              return { ...point, bootstrapFacts: {
                rawMatches: Math.min(document.querySelectorAll(${desktopJsLiteral(selector)}).length, 256),
                rootPresent: root !== null, rootChildren: Math.min(root?.childElementCount ?? 0, 16),
                uiInitialized: window.__claudeTeamsUiDidInit === true,
                splashPresent: splash !== null, splashPositiveSize: Boolean(bounds && bounds.width > 0 && bounds.height > 0),
                splashError: splash?.classList.contains('splash-status-error') === true,
                splashSlow: splash?.classList.contains('splash-status-slow') === true,
                documentComplete: document.readyState === 'complete',
                languageEnglish: document.documentElement.lang === 'en',
                languageEmpty: document.documentElement.lang === '',
                rootFallbackShape: Boolean(root?.childElementCount === 1 &&
                  child?.matches('div.flex.h-screen.flex-col.items-center.justify-center') &&
                  child.querySelector(':scope > div > h1.text-2xl.font-semibold') &&
                  child.querySelector(':scope > div > svg.size-10.text-red-500'))
              } };
            } catch { return point; }
          })()`
        : expression;
      let facts: Record<string, boolean | number | string> | undefined;
      let preparationPending = false;
      const readOptions = prepareScroll ? { deadline: readDeadline, beforeRead: async () => {
        preparationPending = true;
        await prepareScroll();
      } } : undefined;
      try {
        const observed = record(await waitRead(readExpression, phase, readDeadline - Date.now(), value => {
          preparationPending = false;
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const row = value as Record<string, unknown>;
            if (row.unavailableTarget === true) {
              facts = {
                matches: Number.isSafeInteger(row.matches) && Number(row.matches) >= 0
                  ? Math.min(Number(row.matches), 256) : 0,
                disabled: row.disabled === true, ariaDisabled: row.ariaDisabled === true,
                pointerEventsNone: row.pointerEventsNone === true,
                centerInViewport: row.centerInViewport === true, hitPresent: row.hitPresent === true,
              };
              if (finiteSourceCreate(selector, label, text)) {
                facts.createAuthorityMarker = UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER;
                try {
                  const own = (value: unknown, key: string): unknown => {
                    if (!value || typeof value !== 'object') return undefined;
                    const descriptor = Object.getOwnPropertyDescriptor(value, key);
                    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
                  };
                  const create = own(row, 'createFacts');
                  for (const key of ['createPageUnique', 'createLaunchChecked', 'createAuthorityDescribed',
                    'createAuthorityNoticePresent', 'createSubmittingSpinner']) {
                    const value = own(create, key); if (typeof value === 'boolean') facts[key] = value;
                  }
                  for (const key of ['createAlertCount', 'createInvalidAttributeCount']) {
                    const value = own(create, key);
                    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 33) facts[key] = value;
                  }
                  if (own(create, 'createPageUnique') === true)
                    facts.createAuthorityMarker = readProviderLaunchAuthorityMarker(own(create, 'createAuthorityMarker'));
                } catch { /* Optional closed facts cannot replace the original target refusal. */ }
              }
              if (bootstrapRead && row.bootstrapFacts && typeof row.bootstrapFacts === 'object' &&
                  !Array.isArray(row.bootstrapFacts)) {
                const bootstrap = row.bootstrapFacts as Record<string, unknown>;
                for (const key of ['rootPresent', 'uiInitialized', 'splashPresent', 'splashPositiveSize',
                  'splashError', 'splashSlow', 'documentComplete', 'languageEnglish', 'languageEmpty',
                  'rootFallbackShape']) {
                  if (typeof bootstrap[key] === 'boolean') facts[key] = bootstrap[key];
                }
                for (const [key, limit] of [['rawMatches', 256], ['rootChildren', 16]] as const) {
                  if (Number.isSafeInteger(bootstrap[key]) && Number(bootstrap[key]) >= 0)
                    facts[key] = Math.min(Number(bootstrap[key]), limit);
                }
              }
              return false;
            }
          }
          return Boolean(value);
        }, readOptions, phase === label ? 'initial' : phase === label + ' after pointer enter' ? 'after-hover' : 'stable'));
        observeGeometry(phase === label ? 'initial' : phase === label + ' after pointer enter' ? 'after-hover' : 'stable', observed);
        return observed;
      } catch (error) {
        // Never replace a preparation/transport refusal with earlier geometry facts.
        if (preparationPending) throw error;
        if (facts) throw new Error(`UI target read failed: ${phase}; facts=${JSON.stringify(facts)}`, { cause: error });
        throw error;
      }
    };
    let point = await readPoint(label);
    options.assertOwnedRenderer();
    step({ action: 'mouseMoved', label: 'hover ' + label, selector, target: point, geometryTrace });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    point = await readPoint(label + ' after pointer enter');
    // Async Host hydration can shift the DOM after hover. Check the original
    // target is stable before ONE physical click, never replay an uncertain click.
    let stableSamples = 0, remainingPointSamples = 16;
    // Frame-gated clicks reserve a post-owner read inside the same 16-sample budget.
    const finalReads = readiness?.waitForRenderFrames ? 2 : 1;
    while (remainingPointSamples > finalReads && stableSamples < 2) {
      await new Promise<void>((done) => setTimeout(done, 100));
      remainingPointSamples--;
      const next = await readPoint(label + ' stable target');
      stableSamples =
        next.x === point.x && next.y === point.y && next.tag === point.tag
          ? stableSamples + 1
          : 0;
      point = next;
      if (stableSamples !== 2) continue;
      assert.equal(typeof point.x, 'number');
      assert.equal(typeof point.y, 'number');
      options.assertOwnedRenderer();
      remainingPointSamples--;
      assertReadDeadline();
      if (readiness?.waitForRenderFrames) {
        const observed = await cdp.evaluate(desktopAnimationFramesExpression(readDeadline - Date.now()));
        options.assertOwnedRenderer();
        assertReadDeadline();
        assert.equal(observed, true, 'Original UI target render frames did not settle');
        step({ observation: 'two original renderer frames before final target read', label });
      }
      if (prepareScroll) {
        await prepareScroll();
        options.assertOwnedRenderer();
        assertReadDeadline();
      }
      for (let finalRead = 0; finalRead < finalReads; finalRead++) {
        if (finalRead === 1) {
          // The original final ownership census can let the renderer move. Reacquire
          // before the one input, then fence ownership again; this is not atomic.
          options.assertOwnedRenderer();
          assertReadDeadline();
          remainingPointSamples--;
        }
        let finalValue = await cdp.evaluate(expression);
        // A null owner observation is still pending, unlike an explicit unavailable
        // target or transport rejection. Re-read only this original expression.
        while (readiness?.waitForFinalReadiness && finalValue === null && Date.now() < readDeadline) {
          options.assertOwnedRenderer();
          await new Promise<void>((done) => setTimeout(done, Math.min(100, readDeadline - Date.now())));
          assertReadDeadline();
          options.assertOwnedRenderer();
          if (prepareScroll) {
            await prepareScroll();
            options.assertOwnedRenderer();
            assertReadDeadline();
          }
          finalValue = await cdp.evaluate(expression);
        }
        if (finalRead === 1) options.assertOwnedRenderer();
        assertReadDeadline();
        const finalPoint = record(finalValue);
        observeGeometry('final', finalPoint);
        let resample = false;
        try {
          assert.notEqual(finalPoint.unavailableTarget, true, 'Original UI target unavailable after ownership check');
          resample = remainingPointSamples >= 2 + finalReads &&
            [point.x, point.y, finalPoint.x, finalPoint.y].every(value => typeof value === 'number' && Number.isFinite(value)) &&
            finalPoint.tag === point.tag &&
            (!Object.is(finalPoint.x, point.x) || !Object.is(finalPoint.y, point.y));
          if (!resample) assert.deepEqual(
            [finalPoint.x, finalPoint.y, finalPoint.tag],
            [point.x, point.y, point.tag],
            'Original UI target moved after ownership check'
          );
        } catch (error) {
          try {
            console.log(JSON.stringify({ kind: 'TEST_DESKTOP_CLICK_GEOMETRY', geometry: geometryTrace }));
          } catch {
            // The exact original final-target refusal remains authoritative.
          }
          throw error;
        }
        if (resample) {
          options.assertOwnedRenderer();
          point = finalPoint;
          stableSamples = 0;
          break;
        }
      }
    }
    assert.ok(stableSamples === 2, 'Original UI target did not settle before one click');
    if (finalReads === 1) options.assertOwnedRenderer();
    assertReadDeadline();
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
  const click = (selector: string, label: string, text?: string, requiredContent?: string,
    readiness?: { scrollBeforeClick?: ScrollBeforeClick }): Promise<void> =>
    clickExpression(target(selector, text, requiredContent, finiteSourceCreate(selector, label, text)), label, selector, text, readiness);
  const hoverExpression = async (expression: string, label: string): Promise<void> => {
    let previous: { x: number; y: number } | undefined, stable = 0;
    // Canonical effects can settle before their renderer layout. Sample the
    // original eligible target within one read deadline, then move only once.
    const point = record(await waitRead(expression, label, 30_000, value => {
      const row = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
      if (!row || row.unavailableTarget === true || typeof row.x !== 'number' ||
          typeof row.y !== 'number' || !Number.isFinite(row.x) || !Number.isFinite(row.y)) {
        previous = undefined; stable = 0;
        return false;
      }
      stable = previous?.x === row.x && previous?.y === row.y ? stable + 1 : 1;
      previous = { x: row.x, y: row.y };
      return stable >= 3;
    }));
    options.assertOwnedRenderer();
    step({ action: 'mouseMoved', label, target: point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  };
  const scrollTo = async (
    selector: string, label: string, text?: string, maxWheelEvents = 12,
    scrollOptions: { requireCenterHit?: boolean } = {},
    preparation?: { deadline: number; remainingWheels: number }
  ): Promise<void> => {
    assert.ok(Number.isSafeInteger(maxWheelEvents) && maxWheelEvents >= 1 && maxWheelEvents <= 32);
    const assertPreparation = (): void => {
      if (!preparation) return;
      options.assertOwnedRenderer();
      if (Date.now() >= preparation.deadline)
        throw new Error(`UI read timed out: ${label}; no mutation retry`);
    };
    // Allow one final visibility read after the last wheel; never dispatch
    // an extra input event after reaching the TEST-only bounded budget.
    for (let attempt = 0; attempt <= maxWheelEvents; attempt++) {
      options.assertOwnedRenderer();
      assertPreparation();
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
        if(!r.width||!r.height)return null;
        // An offscreen inner clip still owns visibility; reveal it using an outer wheel.
        let wheelRect=p;
        if(bottom<=top){
          let outer=parent?.parentElement;
          while(outer){
            if(outer.scrollHeight>outer.clientHeight&&/auto|scroll/.test(getComputedStyle(outer).overflowY)){
              const rect=outer.getBoundingClientRect();
              if(Math.min(innerHeight,rect.bottom)>Math.max(0,rect.top)){wheelRect=rect;break;}
            }
            outer=outer.parentElement;
          }
          if(!outer)wheelRect=document.documentElement.getBoundingClientRect();
        }
        const wheelTop=Math.max(0,wheelRect.top),wheelBottom=Math.min(innerHeight,wheelRect.bottom);
        if(wheelBottom<=wheelTop)return null;
        const x=Math.max(1,Math.min(innerWidth-1,wheelRect.x+wheelRect.width/2)),y=(wheelTop+wheelBottom)/2;
        const centerY=bottom<=top?(p.top+p.bottom)/2:r.y+r.height/2;
        const hit=${scrollOptions.requireCenterHit === true ? 'document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)' : 'e'};
        return {visible:bottom>top&&r.top>=top&&r.bottom<=bottom&&Boolean(hit&&(hit===e||e.contains(hit))),x,y,delta:Math.max(-600,Math.min(600,centerY-y))};
      })()`,
          label, preparation ? preparation.deadline - Date.now() : 30_000, Boolean, preparation
        )
      );
      assertPreparation();
      if (found.visible === true) return;
      if (attempt === maxWheelEvents || preparation?.remainingWheels === 0) break;
      assert.equal(typeof found.x, 'number');
      assert.equal(typeof found.y, 'number');
      assert.equal(typeof found.delta, 'number');
      assertPreparation();
      if (preparation) preparation.remainingWheels--;
      step({ action: 'mouseWheel', label, selector, deltaY: found.delta });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: found.x,
        y: found.y,
        deltaX: 0,
        deltaY: found.delta,
      });
      assertPreparation();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      assertPreparation();
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
  const clickSidebar = async (subject: string, readiness?: { waitForRenderFrames: true }): Promise<void> => {
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
    await clickExpression(target('[role="dialog"] button', 'Open team'), 'Open team', '[role="dialog"] button', 'Open team', readiness);
  };
  return { observeInput, waitRead, click, clickExpression, clickSidebar, scrollTo, hoverExpression };
}
