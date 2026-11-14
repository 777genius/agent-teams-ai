#pragma once
// Native feasibility only. This file is compiled into an unstaged TEST binary,
// never into the product broker. No attach-by-PID, API fallback or SDK claim.
#include "ownedJob.h"
#include "protocol.h"
#include <map>
#include <mutex>
#include <set>

namespace debug_service_test {
struct Service {
  HANDLE process=nullptr, job=nullptr;
  uint64_t birth=0;
  bool terminationRequested=false;
  DWORD dispatchError=0;
};
inline std::mutex recordsMutex;
inline std::map<DWORD,Service> records;

inline uint64_t birthOf(HANDLE process) {
  FILETIME created{},exit{},kernel{},user{};
  if(!GetProcessTimes(process,&created,&exit,&kernel,&user)) throw GetLastError();
  return (static_cast<uint64_t>(created.dwHighDateTime)<<32)|created.dwLowDateTime;
}
inline HANDLE duplicate(HANDLE original) {
  HANDLE retained=nullptr;
  if(!DuplicateHandle(GetCurrentProcess(),original,GetCurrentProcess(),&retained,
    0,FALSE,DUPLICATE_SAME_ACCESS)) throw GetLastError();
  return retained;
}
inline void capture(const DEBUG_EVENT& event,HANDLE outer) {
  const HANDLE original=event.u.CreateProcessInfo.hProcess;
  BOOL member=FALSE;
  if(!original||GetProcessId(original)!=event.dwProcessId||
    !IsProcessInJob(original,outer,&member)||!member) throw DWORD{ERROR_INVALID_DATA};
  std::lock_guard<std::mutex> lock(recordsMutex);
  if(records.size()>=64||records.count(event.dwProcessId)) throw DWORD{ERROR_INVALID_DATA};
  Service selected;
  try {
    // This exact handle came from the kernel create event, before user-mode code.
    // Duplicate because ContinueDebugEvent closes the system-owned handle on exit.
    selected.process=duplicate(original); selected.birth=birthOf(selected.process);
    selected.job=owned_job::create();
    if(!AssignProcessToJobObject(selected.job,selected.process)||
      !IsProcessInJob(selected.process,selected.job,&member)||!member) throw GetLastError();
    records.emplace(event.dwProcessId,selected);
  } catch(...) {
    if(selected.job) CloseHandle(selected.job);
    if(selected.process) CloseHandle(selected.process);
    throw;
  }
}

/** Called on the same existing admission thread that invoked CreateProcessW. */
inline bool run(DWORD rootPid,HANDLE root,HANDLE outer,std::unique_lock<std::timed_mutex>& stateLock) {
  HANDLE observedRoot=nullptr,observedOuter=nullptr;
  // The ordinary watcher closes its root handle on exit. Retain both originals
  // while the existing admission lock still prevents observer/release races.
  try { observedRoot=duplicate(root); observedOuter=duplicate(outer); }
  catch(...) { if(observedRoot) CloseHandle(observedRoot); return false; }
  stateLock.unlock();
  bool ok=true;
  std::set<DWORD> initialBreakpoints;
  for(;;) {
    DEBUG_EVENT event{};
    if(!WaitForDebugEvent(&event,100)) {
      const DWORD error=GetLastError();
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      if(WaitForSingleObject(observedRoot,0)==WAIT_OBJECT_0&&
        QueryInformationJobObject(observedOuter,JobObjectBasicAccountingInformation,
          &accounting,sizeof(accounting),nullptr)&&accounting.ActiveProcesses==0) break;
      if(error==ERROR_SEM_TIMEOUT) continue;
      ok=false; break;
    }
    DWORD continuation=DBG_CONTINUE;
    try {
      if(event.dwDebugEventCode==CREATE_PROCESS_DEBUG_EVENT) {
        if(event.dwProcessId==rootPid) {
          if(GetProcessId(event.u.CreateProcessInfo.hProcess)!=GetProcessId(observedRoot)||
            birthOf(event.u.CreateProcessInfo.hProcess)!=birthOf(observedRoot)) throw DWORD{ERROR_INVALID_DATA};
        } else capture(event,observedOuter);
        if(event.u.CreateProcessInfo.hFile&&!CloseHandle(event.u.CreateProcessInfo.hFile))
          throw GetLastError();
      } else if(event.dwDebugEventCode==LOAD_DLL_DEBUG_EVENT) {
        if(event.u.LoadDll.hFile&&!CloseHandle(event.u.LoadDll.hFile)) throw GetLastError();
      } else if(event.dwDebugEventCode==EXCEPTION_DEBUG_EVENT) {
        // Feasibility fixture only: ordinary initial loader breakpoint is handled;
        // every other exception remains the native application's exception.
        const bool initial=event.u.Exception.ExceptionRecord.ExceptionCode==EXCEPTION_BREAKPOINT&&
          initialBreakpoints.insert(event.dwProcessId).second;
        if(!initial) continuation=DBG_EXCEPTION_NOT_HANDLED;
      } else if(event.dwDebugEventCode==RIP_EVENT) throw DWORD{ERROR_INVALID_DATA};
    } catch(...) { ok=false; }
    if(!ok) TerminateJobObject(observedOuter,1); // Failed prebirth admission never releases unowned code.
    // Never wait for root/Job exit here: EXIT cannot finish until this continuation.
    if(!ContinueDebugEvent(event.dwProcessId,event.dwThreadId,continuation)) ok=false;
    if(!ok) break;
  }
  if(!CloseHandle(observedOuter)) ok=false;
  if(!CloseHandle(observedRoot)) ok=false;
  // The bounded retained originals are closed by broker process teardown after
  // its genuine whole-provider release. Production retirement is not claimed.
  return ok;
}

/** Private TEST mode 2: target a retained original nested Job, never a whole provider. */
inline std::vector<uint8_t> stop(DWORD pid,uint64_t expectedBirth,DWORD budget) {
  Service selected;
  {
    std::lock_guard<std::mutex> lock(recordsMutex);
    const auto found=records.find(pid);
    if(found==records.end()||found->second.birth!=expectedBirth) throw DWORD{ERROR_NOT_FOUND};
    if(!found->second.terminationRequested) {
      found->second.terminationRequested=true;
      if(!TerminateJobObject(found->second.job,1)) found->second.dispatchError=GetLastError();
    }
    selected=found->second;
  }
  const auto deadline=GetTickCount64()+budget;
  DWORD active=MAXDWORD,queryError=0,exitCode=0;
  bool exited=false;
  do {
    const DWORD waited=WaitForSingleObject(selected.process,0);
    if(waited==WAIT_OBJECT_0) {
      exited=true;
      if(!GetExitCodeProcess(selected.process,&exitCode)&&!queryError) queryError=GetLastError();
    } else if(waited!=WAIT_TIMEOUT&&!queryError) queryError=GetLastError();
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if(!QueryInformationJobObject(selected.job,JobObjectBasicAccountingInformation,
      &accounting,sizeof(accounting),nullptr)) { if(!queryError) queryError=GetLastError(); }
    else active=accounting.ActiveProcesses;
    if(exited&&active==0) break;
    Sleep(5);
  } while(GetTickCount64()<deadline);
  if((!exited||active!=0)&&!queryError) queryError=WAIT_TIMEOUT;
  std::vector<uint8_t> payload;
  wire::append(payload,uint8_t{2}); wire::append(payload,static_cast<uint8_t>(exited));
  wire::append(payload,active); wire::append(payload,exitCode); wire::append(payload,selected.birth);
  wire::append(payload,selected.dispatchError); wire::append(payload,queryError);
  return payload;
}
} // namespace debug_service_test
