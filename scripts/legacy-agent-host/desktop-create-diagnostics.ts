import type { UiCdpPort } from './desktop-ui-controls.ts';

/** TEST-only passive React/DOM inspection; never installs handlers or changes application state. */
export async function readCreateDialogDiagnostics(cdp: UiCdpPort): Promise<unknown> {
  return cdp.evaluate(`(() => {
    const node=document.querySelector('[role="dialog"]');
    if(!node)return {dialogAbsent:true};
    const key=Object.keys(node).find(key=>key.startsWith('__reactFiber$'));
    let fiber=key?node[key]:null;
    const ancestry=[];
    while(fiber){
      const name=fiber.type?.name??fiber.type?.displayName??fiber.elementType?.name;
      if(name)ancestry.push(name);
      if(name==='CreateTeamDialog')break;
      fiber=fiber.return;
    }
    const allowed=new Set(['current','status','details','providerId','createdTeamReadiness',
      'createdTeamDraftSignature','preparationId','selectionSignature','draftDigest','expiresAt',
      'signature','requestSignature','scope','id','open','teamName','prompt','model','effort','cwd',
      'limitContext','members','providerBackendId','ready','required','sourceContext','identity']);
    function brief(value,depth=0){
      if(value===null||['boolean','number','undefined'].includes(typeof value))return value??null;
      if(typeof value==='string')return value.length>32768?value.slice(0,32768):value;
      if(depth>5||typeof value!=='object')return typeof value;
      if(Object.prototype.toString.call(value)==='[object Map]')return {map:[...value.entries()].slice(0,16).map(([k,v])=>[brief(k,depth+1),brief(v,depth+1)])};
      if(Array.isArray(value))return value.slice(0,16).map(v=>brief(v,depth+1));
      return Object.fromEntries(Object.keys(value).filter(k=>allowed.has(k)).slice(0,32)
        .map(k=>[k,brief(value[k],depth+1)]));
    }
    const hooks=[];let hook=fiber?.memoizedState;
    for(let index=0;hook&&index<800;index++,hook=hook.next)
      hooks.push({index,value:brief(hook.memoizedState)});
    return {ancestry,hooks,text:node.innerText.slice(-5000),
      buttons:[...node.querySelectorAll('button')].slice(-12).map(b=>({text:b.textContent,disabled:b.disabled}))};
  })()`);
}
