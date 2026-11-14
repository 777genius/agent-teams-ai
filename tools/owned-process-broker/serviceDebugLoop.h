#pragma once
// One creating/debugging thread and its existing original Job/Scope registry.
// Product and TEST binaries share custody; only TEST supplies a diagnostic sink.
#include "serviceScopes.h"

namespace owned_service {
using FailureReporter=void (*)(Stage,DWORD,const DEBUG_EVENT&) noexcept;
/** Called on the same existing admission thread that invoked CreateProcessW. */
inline bool runDebugLoop(DWORD rootPid,HANDLE root,HANDLE outer,
  std::unique_lock<std::timed_mutex>& stateLock,Scopes& scopes,FailureReporter reporter=nullptr) {
  const auto failure=[reporter](Stage stage,DWORD error,const DEBUG_EVENT& event=DEBUG_EVENT{}) noexcept {
    if(reporter) reporter(stage,error,event);
  };
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
        // Only the ordinary initial loader breakpoint is handled here;
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

} // namespace owned_service
