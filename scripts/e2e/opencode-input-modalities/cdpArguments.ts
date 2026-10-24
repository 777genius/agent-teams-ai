import assert from 'node:assert/strict';

import type { HarnessCdp } from '../../fixtures/native-teammate-attachments/harnessSupport.ts';

type Operation =
  | 'api-start'
  | 'pending-read'
  | 'pending-delete'
  | 'navigate'
  | 'exists'
  | 'recipient'
  | 'point'
  | 'hit'
  | 'queue-read'
  | 'stage-target'
  | 'queue-observe'
  | 'focus'
  | 'focused';

export type Locator = { selector: string } | { label: string } | { prefix: string };
// Checked-in code only. Every external value travels through CDP CallArgument.value.
const FUNCTION = `async function(operation, data) {
  const locate = (locator) => 'selector' in locator ? document.querySelector(locator.selector)
    : Array.from(document.querySelectorAll('button')).find(button => button.offsetParent !== null &&
      ('label' in locator ? button.getAttribute('aria-label') === locator.label
        : button.getAttribute('aria-label')?.startsWith(locator.prefix)));
  if (operation === 'api-start') {
    const [key, source, path, args] = data;
    const root = source === 'store' ? window.__agentTeamsDevStore.getState() : window.electronAPI;
    let owner = root;
    for (const segment of path.slice(0, -1)) owner = owner[segment];
    window[key] = {done:false};
    Promise.resolve().then(() => owner[path.at(-1)](...args)).then(
      result => window[key] = {done:true,result}, error => window[key] = {done:true,error:String(error)});
    return true;
  }
  if (operation === 'pending-read') return window[data[0]]?.done ? window[data[0]] : null;
  if (operation === 'pending-delete') { delete window[data[0]]; return true; }
  if (operation === 'navigate') {
    const [team, project, names] = data;
    const store = window.__agentTeamsDevStore;
    if (!store || !window.electronAPI?.teams) return null;
    let s = store.getState();
    if (s.getActiveTab()?.type !== 'team' || s.getActiveTab()?.teamName !== team) s.openTeamTab(team, project);
    s = store.getState(); s.setMessagesPanelMode('sidebar');
    if (s.selectedTeamName !== team || (!s.selectedTeamData && !s.selectedTeamLoading))
      await s.selectTeam(team, {skipProjectAutoSelect:true});
    s = store.getState(); const active = s.getActiveTab();
    const row = locate({prefix:'image,'});
    return {timeOrigin:performance.timeOrigin,ready:active?.type === 'team' && active.teamName === team &&
      s.selectedTeamName === team && s.selectedTeamData?.teamName === team && !s.selectedTeamLoading &&
      names.every(name => s.selectedTeamData.members.some(member => member.name === name)) && Boolean(row)};
  }
  if (operation === 'exists') return Boolean(locate(data[0]));
  if (operation === 'recipient') return document.querySelector('.message-composer-target-selectors')?.textContent?.trim() === data[0];
  if (operation === 'point') {
    const el = locate(data[0]); if (!(el instanceof HTMLElement)) return null;
    el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect();
    return r.width && r.height ? {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height} : null;
  }
  if (operation === 'hit') {
    const [locator, previous] = data; const el = locate(locator);
    if (!(el instanceof HTMLElement)) return {ready:false,opacity:'0',hit:null};
    const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(previous.x,previous.y);
    const style = getComputedStyle(el);
    return {ready:r.width===previous.width && r.height===previous.height && r.x+r.width/2===previous.x &&
      r.y+r.height/2===previous.y && Number(style.opacity)>0 && style.visibility==='visible' &&
      !el.matches(':disabled') && Boolean(hit && (hit===el || el.contains(hit))),
      opacity:style.opacity,hit:hit?.getAttribute('aria-label') ?? hit?.tagName ?? null};
  }
  if (operation === 'queue-read') {
    const info = (await indexedDB.databases()).find(db => db.name==='keyval-store');
    if (!info?.version) throw Error('Existing queue database missing');
    return new Promise((resolve,reject) => {
      const request = indexedDB.open('keyval-store',info.version);
      request.onupgradeneeded=()=>{request.transaction?.abort();reject(Error('Queue database upgrade forbidden'));};
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains('keyval')){db.close();reject(Error('Existing queue store missing'));return;}
        const tx=db.transaction('keyval','readonly'); const read=tx.objectStore('keyval').get(data[0]); let value;
        read.onsuccess=()=>{value=read.result;}; tx.oncomplete=()=>{db.close();resolve(value);};
        tx.onerror=()=>{db.close();reject(tx.error);};
        tx.onabort=()=>{db.close();reject(tx.error ?? Error('Queue read aborted'));};
      };
    });
  }
  if (operation === 'stage-target') {
    const [model,cwd]=data; const store=window.__agentTeamsDevStore; const snapshot=store.getState().selectedTeamData;
    if(!window.TEST_originalTeamData)window.TEST_originalTeamData=snapshot;
    store.setState({selectedTeamData:{...snapshot,config:{...snapshot.config,projectPath:cwd},
      members:snapshot.members.map(member=>member.name==='both'?{...member,model,cwd}:member)}}); return true;
  }
  if (operation === 'queue-observe') {
    const button=locate(data[0]); if(!(button instanceof HTMLButtonElement))throw Error('Queue Send missing');
    const events=[]; const names=['focusin','focusout','keydown','keypress','keyup','pointerdown','mousedown','pointerup','mouseup','click','pointercancel'];
    const listener=event=>{
      const target=event.target instanceof Element?event.target:null; const r=button.getBoundingClientRect();
      const entry={rect:{x:r.x,y:r.y,width:r.width,height:r.height},activeQueueSend:document.activeElement===button,
        key:event instanceof KeyboardEvent?event.key:undefined,type:event.type,isTrusted:event.isTrusted,
        targetsQueueSend:target===button||button.contains(target),buttonConnected:button.isConnected,
        targetLabel:target?.closest('button')?.getAttribute('aria-label')??null,button:event.button,buttons:event.buttons,
        defaultPrevented:event.defaultPrevented};events.push(entry);queueMicrotask(()=>{entry.defaultPrevented=event.defaultPrevented;});
    };
    for(const name of names)document.addEventListener(name,listener,{capture:true,passive:true});
    window.TEST_queueActivation={events,stop:()=>{for(const name of names)document.removeEventListener(name,listener,true);}};
    return true;
  }
  if (operation === 'focus') {
    const button=locate(data[0]); if(!(button instanceof HTMLButtonElement)||button.disabled)return false;
    button.focus({preventScroll:true});return document.activeElement===button;
  }
  if (operation === 'focused') return document.activeElement===locate(data[0]) && !document.activeElement.matches(':disabled');
  throw Error('Unknown fixture CDP operation');
}`;

export async function browserCall<T>(
  cdp: HarnessCdp,
  operation: Operation,
  data: unknown[] = []
): Promise<T> {
  const global = await cdp.send('Runtime.evaluate', {
    expression: 'globalThis',
    returnByValue: false,
  });
  const objectId = (global.result as { objectId?: string } | undefined)?.objectId;
  assert(objectId, 'Owned renderer global object is required');
  try {
    const result = await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: FUNCTION,
      arguments: [{ value: operation }, { value: data }],
      awaitPromise: true,
      returnByValue: true,
    });
    const exception = result.exceptionDetails as
      | { exception?: { description?: string } }
      | undefined;
    assert(!exception, exception?.exception?.description ?? 'Renderer fixture call failed');
    return (result.result as { value: T }).value;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId });
  }
}
