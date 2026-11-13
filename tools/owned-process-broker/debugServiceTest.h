#pragma once
// Native feasibility only. This file is compiled into an unstaged TEST binary,
// never into the product broker. No attach-by-PID, API fallback or SDK claim.
#include "serviceScopes.h"
#include "protocol.h"
#include <io.h>

namespace debug_service_test {
using owned_service::Stage;
using owned_service::duplicate;
using owned_service::sameObject;
inline owned_service::Scopes scopes{64};
// One bounded TEST diagnostic record, never a command or production wire receipt.
inline void failure(Stage stage,DWORD error,const DEBUG_EVENT& event={}) noexcept {
  const DWORD record[4]={static_cast<DWORD>(stage),error,event.dwDebugEventCode,event.dwProcessId};
  const auto file=reinterpret_cast<HANDLE>(_get_osfhandle(4));
  if(file==INVALID_HANDLE_VALUE||GetFileType(file)!=FILE_TYPE_DISK) return;
  DWORD written=0;
  WriteFile(file,record,sizeof(record),&written,nullptr); // best effort; exit remains failure
}

/** Called on the same existing admission thread that invoked CreateProcessW. */
inline bool run(DWORD rootPid,HANDLE root,HANDLE outer,std::unique_lock<std::timed_mutex>& stateLock) {
  HANDLE observedRoot=nullptr,observedOuter=nullptr;
  Stage stage=Stage::RetainRoot;
  // The ordinary watcher closes its root handle on exit. Retain both originals
  // while the existing admission lock still prevents observer/release races.
  try { observedRoot=duplicate(root); stage=Stage::RetainJob; observedOuter=duplicate(outer); }
  catch(DWORD error) { failure(stage,error); if(observedRoot) CloseHandle(observedRoot); return false; }
  catch(...) { failure(stage,ERROR_INVALID_DATA); if(observedRoot) CloseHandle(observedRoot); return false; }
  stateLock.unlock();
  bool ok=true;
  bool rootInitialBreakpoint=false;
  for(;;) {
    DEBUG_EVENT event{};
    if(!WaitForDebugEvent(&event,100)) {
      const DWORD error=GetLastError();
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      if(WaitForSingleObject(observedRoot,0)==WAIT_OBJECT_0&&
        QueryInformationJobObject(observedOuter,JobObjectBasicAccountingInformation,
          &accounting,sizeof(accounting),nullptr)&&accounting.ActiveProcesses==0) break;
      if(error==ERROR_SEM_TIMEOUT) {
        try { stage=Stage::Retire; scopes.retire(); }
        catch(DWORD failureCode) { failure(stage,failureCode,event); ok=false; }
        catch(...) { failure(stage,ERROR_INVALID_DATA,event); ok=false; }
        if(ok) continue;
        break;
      }
      failure(Stage::Wait,error,event); ok=false; break;
    }
    DWORD continuation=DBG_CONTINUE;
    try {
      if(event.dwDebugEventCode==CREATE_PROCESS_DEBUG_EVENT) {
        stage=Stage::RootIdentity;
        if(sameObject(event.u.CreateProcessInfo.hProcess,observedRoot)) {
          if(event.dwProcessId!=rootPid) throw DWORD{ERROR_INVALID_DATA};
        } else scopes.capture(event,observedRoot,observedOuter,stage);
        stage=Stage::ImageClose;
        if(event.u.CreateProcessInfo.hFile&&!CloseHandle(event.u.CreateProcessInfo.hFile))
          throw GetLastError();
      } else if(event.dwDebugEventCode==LOAD_DLL_DEBUG_EVENT) {
        stage=Stage::DllClose;
        if(event.u.LoadDll.hFile&&!CloseHandle(event.u.LoadDll.hFile)) throw GetLastError();
      } else if(event.dwDebugEventCode==EXCEPTION_DEBUG_EVENT) {
        // Feasibility fixture only: ordinary initial loader breakpoint is handled;
        // every other exception remains the native application's exception.
        bool initial=false;
        if(event.u.Exception.ExceptionRecord.ExceptionCode==EXCEPTION_BREAKPOINT) {
          const DWORD rootState=WaitForSingleObject(observedRoot,0);
          if(rootState==WAIT_FAILED) throw GetLastError();
          if(event.dwProcessId==rootPid&&rootState==WAIT_TIMEOUT) {
            initial=!rootInitialBreakpoint; rootInitialBreakpoint=true;
          } else initial=scopes.firstBreakpoint(event.dwProcessId);
        }
        if(!initial) continuation=DBG_EXCEPTION_NOT_HANDLED;
      } else if(event.dwDebugEventCode==RIP_EVENT) { stage=Stage::Rip; throw event.u.RipInfo.dwError; }
    } catch(DWORD error) { failure(stage,error,event); ok=false; }
    catch(...) { failure(stage,ERROR_INVALID_DATA,event); ok=false; }
    if(!ok) TerminateJobObject(observedOuter,1); // Failed prebirth admission never releases unowned code.
    // Never wait for root/Job exit here: EXIT cannot finish until this continuation.
    if(!ContinueDebugEvent(event.dwProcessId,event.dwThreadId,continuation)) {
      if(ok) failure(Stage::Continue,GetLastError(),event);
      ok=false;
    }
    if(ok) {
      try { stage=Stage::Retire; scopes.retire(); }
      catch(DWORD error) { failure(stage,error,event); ok=false; }
      catch(...) { failure(stage,ERROR_INVALID_DATA,event); ok=false; }
    }
    if(!ok) break;
  }
  if(!CloseHandle(observedOuter)) { if(ok) failure(Stage::JobClose,GetLastError()); ok=false; }
  if(!CloseHandle(observedRoot)) { if(ok) failure(Stage::RootClose,GetLastError()); ok=false; }
  // Registered originals remain pinned until existing command settlement or
  // broker teardown; unregistered empty scopes retire after actual EXIT.
  return ok;
}

/** Private TEST mode 2: register the exact retained original, then use only its scope. */
inline std::vector<uint8_t> stop(DWORD pid,uint64_t expectedBirth,DWORD budget) {
  const auto key=scopes.registerExact(pid,expectedBirth);
  const auto facts=scopes.stop(key,budget);
  std::vector<uint8_t> payload;
  wire::append(payload,uint8_t{2}); wire::append(payload,static_cast<uint8_t>(facts.rootExited));
  wire::append(payload,facts.active); wire::append(payload,facts.exitCode); wire::append(payload,facts.birth);
  wire::append(payload,facts.dispatchError); wire::append(payload,facts.queryError);
  return payload;
}

/** Private TEST mode 3: prove terminal retirement; never terminate any process. */
inline std::vector<uint8_t> retireExact(DWORD pid,uint64_t expectedBirth,DWORD budget) {
  if(budget) throw DWORD{ERROR_INVALID_PARAMETER};
  const auto key=scopes.registerExact(pid,expectedBirth);
  const auto facts=scopes.query(key);
  if(!owned_service::absent(facts)) throw DWORD{ERROR_INVALID_STATE};
  scopes.releaseRegistration(key);
  try { (void)scopes.query(key); throw DWORD{ERROR_INVALID_STATE}; }
  catch(DWORD error) { if(error!=ERROR_NOT_FOUND) throw; }
  std::vector<uint8_t> payload;
  wire::append(payload,uint8_t{3}); wire::append(payload,static_cast<uint8_t>(facts.rootExited));
  wire::append(payload,facts.active); wire::append(payload,facts.exitCode); wire::append(payload,facts.birth);
  wire::append(payload,DWORD{0}); wire::append(payload,facts.queryError); wire::append(payload,key);
  return payload;
}
} // namespace debug_service_test
