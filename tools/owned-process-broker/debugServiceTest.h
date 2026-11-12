#pragma once
// Native feasibility only. This file is compiled into an unstaged TEST binary,
// never into the product broker. No attach-by-PID, API fallback or SDK claim.
#include "ownedJob.h"
#include "protocol.h"
#include <io.h>
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
// One bounded TEST diagnostic record, on a private regular-file fd. It never
// holds target stdio open and is not a command or a production wire receipt.
enum class Stage : DWORD { RetainRoot=1, RetainJob, Wait, RootIdentity, RetainChild,
  ChildIdentity, OuterMembership, CreateJob, AssignJob, VerifyJob, ImageClose,
  DllClose, Rip, Continue, JobClose, RootClose };
inline void failure(Stage stage,DWORD error,const DEBUG_EVENT& event={}) noexcept {
  const DWORD record[4]={static_cast<DWORD>(stage),error,event.dwDebugEventCode,event.dwProcessId};
  const auto file=reinterpret_cast<HANDLE>(_get_osfhandle(4));
  if(file==INVALID_HANDLE_VALUE||GetFileType(file)!=FILE_TYPE_DISK) return;
  DWORD written=0;
  WriteFile(file,record,sizeof(record),&written,nullptr); // best effort; exit remains failure
}

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
inline HANDLE retainProcess(HANDLE original) {
  HANDLE retained=nullptr;
  // A debug event promises memory access, not Job assignment/query/wait rights.
  // Ask Windows for the exact needed access on the SAME original object. A
  // denied request fails admission; it never falls back to reopening a PID.
  constexpr DWORD access=PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE|
    PROCESS_SET_QUOTA|PROCESS_TERMINATE;
  if(!DuplicateHandle(GetCurrentProcess(),original,GetCurrentProcess(),&retained,
    access,FALSE,0)) throw GetLastError();
  return retained;
}
inline void capture(const DEBUG_EVENT& event,HANDLE outer,Stage& stage) {
  const HANDLE original=event.u.CreateProcessInfo.hProcess;
  if(!original) throw DWORD{ERROR_INVALID_HANDLE};
  std::lock_guard<std::mutex> lock(recordsMutex);
  if(records.size()>=64||records.count(event.dwProcessId)) throw DWORD{ERROR_INVALID_DATA};
  Service selected;
  try {
    // This exact handle came from the kernel create event, before user-mode code.
    // Duplicate because ContinueDebugEvent closes the system-owned handle on exit.
    stage=Stage::RetainChild; selected.process=retainProcess(original);
    stage=Stage::ChildIdentity;
    const DWORD pid=GetProcessId(selected.process);
    if(!pid) throw GetLastError();
    if(pid!=event.dwProcessId||!CompareObjectHandles(original,selected.process))
      throw DWORD{ERROR_INVALID_DATA};
    selected.birth=birthOf(selected.process);
    stage=Stage::OuterMembership; BOOL member=FALSE;
    if(!IsProcessInJob(selected.process,outer,&member)) throw GetLastError();
    if(!member) throw DWORD{ERROR_INVALID_DATA};
    stage=Stage::CreateJob;
    selected.job=owned_job::create();
    stage=Stage::AssignJob;
    if(!AssignProcessToJobObject(selected.job,selected.process)) throw GetLastError();
    stage=Stage::VerifyJob;
    if(!IsProcessInJob(selected.process,selected.job,&member)) throw GetLastError();
    if(!member) throw DWORD{ERROR_INVALID_DATA};
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
  Stage stage=Stage::RetainRoot;
  // The ordinary watcher closes its root handle on exit. Retain both originals
  // while the existing admission lock still prevents observer/release races.
  try { observedRoot=duplicate(root); stage=Stage::RetainJob; observedOuter=duplicate(outer); }
  catch(DWORD error) { failure(stage,error); if(observedRoot) CloseHandle(observedRoot); return false; }
  catch(...) { failure(stage,ERROR_INVALID_DATA); if(observedRoot) CloseHandle(observedRoot); return false; }
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
      failure(Stage::Wait,error,event); ok=false; break;
    }
    DWORD continuation=DBG_CONTINUE;
    try {
      if(event.dwDebugEventCode==CREATE_PROCESS_DEBUG_EVENT) {
        if(event.dwProcessId==rootPid) {
          stage=Stage::RootIdentity;
          // Kernel object equality needs no assumed query rights on debug handles.
          if(!CompareObjectHandles(event.u.CreateProcessInfo.hProcess,observedRoot))
            throw DWORD{ERROR_INVALID_DATA};
        } else capture(event,observedOuter,stage);
        stage=Stage::ImageClose;
        if(event.u.CreateProcessInfo.hFile&&!CloseHandle(event.u.CreateProcessInfo.hFile))
          throw GetLastError();
      } else if(event.dwDebugEventCode==LOAD_DLL_DEBUG_EVENT) {
        stage=Stage::DllClose;
        if(event.u.LoadDll.hFile&&!CloseHandle(event.u.LoadDll.hFile)) throw GetLastError();
      } else if(event.dwDebugEventCode==EXCEPTION_DEBUG_EVENT) {
        // Feasibility fixture only: ordinary initial loader breakpoint is handled;
        // every other exception remains the native application's exception.
        const bool initial=event.u.Exception.ExceptionRecord.ExceptionCode==EXCEPTION_BREAKPOINT&&
          initialBreakpoints.insert(event.dwProcessId).second;
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
    if(!ok) break;
  }
  if(!CloseHandle(observedOuter)) { if(ok) failure(Stage::JobClose,GetLastError()); ok=false; }
  if(!CloseHandle(observedRoot)) { if(ok) failure(Stage::RootClose,GetLastError()); ok=false; }
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
