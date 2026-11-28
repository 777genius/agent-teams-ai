#pragma once
// Original kernel-object custody shared by one broker's service-scope adapter.
// No PID reopening, process-table adoption, or provider-wide termination here.
#include "ownedJob.h"
#include <cstdint>
#include <exception>
#include <map>
#include <memory>
#include <mutex>
#include <vector>

namespace owned_service {
enum class Stage : DWORD { RetainRoot=1, RetainJob, Wait, RootIdentity, RetainChild,
  ChildIdentity, OuterMembership, CreateJob, AssignJob, VerifyJob, ImageClose,
  DllClose, Rip, Continue, JobClose, RootClose, Registry, Retire };
using Key=uint64_t;

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
  constexpr DWORD access=PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE|
    PROCESS_SET_QUOTA|PROCESS_TERMINATE;
  if(!DuplicateHandle(GetCurrentProcess(),original,GetCurrentProcess(),&retained,
    access,FALSE,0)) throw GetLastError();
  return retained;
}
inline bool sameObject(HANDLE first,HANDLE second) {
  static const auto compare=[] {
    const auto module=GetModuleHandleW(L"KernelBase.dll");
    if(!module) throw GetLastError();
    const auto address=GetProcAddress(module,"CompareObjectHandles");
    if(!address) throw GetLastError();
    return reinterpret_cast<decltype(&CompareObjectHandles)>(address);
  }();
  return compare(first,second)!=FALSE;
}

struct StartupBreakpoints {
  bool wow64=false, nativeSeen=false, wow64Seen=false;
  void capture(HANDLE original) {
    static const auto query=[] {
      const auto module=GetModuleHandleW(L"Kernel32.dll");
      if(!module) throw GetLastError();
      const auto address=GetProcAddress(module,"IsWow64Process2");
      if(!address&&GetLastError()!=ERROR_PROC_NOT_FOUND) throw GetLastError();
      return reinterpret_cast<decltype(&IsWow64Process2)>(address);
    }();
    // Older native64 Windows keeps its original startup handling. An unavailable
    // architecture query never authorizes the additional x86-only exception.
    if(!query) return;
    USHORT processMachine=IMAGE_FILE_MACHINE_UNKNOWN;
    if(!query(original,&processMachine,nullptr)) throw GetLastError();
    wow64=processMachine==IMAGE_FILE_MACHINE_I386;
  }
  bool accept(const EXCEPTION_DEBUG_INFO& event) noexcept {
    if(!event.dwFirstChance) return false;
    const DWORD code=event.ExceptionRecord.ExceptionCode;
    if(code==EXCEPTION_BREAKPOINT&&!nativeSeen) { nativeSeen=true; return true; }
    // A native debugger sees the x86 loader breakpoint after the native one.
    // The two startup events never authorize later application breakpoints.
    if(code==0x4000001f&&wow64&&nativeSeen&&!wow64Seen) { wow64Seen=true; return true; }
    return false;
  }
};

struct Scope {
  HANDLE process=nullptr, job=nullptr;
  DWORD pid=0;
  uint64_t birth=0;
  Key key=0;
  StartupBreakpoints startup;
  bool registered=false, stopping=false, terminationDispatched=false, inheritedTermination=false;
  Scope()=default;
  Scope(const Scope&)=delete;
  Scope& operator=(const Scope&)=delete;
  ~Scope() noexcept {
    // Only this record owns these handles. An impossible close failure cannot
    // be reported as a successful retirement or release.
    const bool closedJob=!job||CloseHandle(job)!=FALSE;
    const bool closedProcess=!process||CloseHandle(process)!=FALSE;
    if(!closedJob||!closedProcess) std::terminate();
  }
};
struct Facts {
  Key key=0;
  uint64_t birth=0;
  bool rootExited=false;
  DWORD active=MAXDWORD, exitCode=0, queryError=0, dispatchError=0;
};
inline bool absent(const Facts& value) {
  return value.rootExited&&value.active==0&&!value.queryError;
}
inline Facts observe(const Scope& selected) {
  Facts facts; facts.key=selected.key; facts.birth=selected.birth;
  const DWORD waited=WaitForSingleObject(selected.process,0);
  if(waited==WAIT_OBJECT_0) {
    facts.rootExited=true;
    if(!GetExitCodeProcess(selected.process,&facts.exitCode)) facts.queryError=GetLastError();
  } else if(waited!=WAIT_TIMEOUT) facts.queryError=GetLastError();
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if(!QueryInformationJobObject(selected.job,JobObjectBasicAccountingInformation,
    &accounting,sizeof(accounting),nullptr)) {
    if(!facts.queryError) facts.queryError=GetLastError();
  } else facts.active=accounting.ActiveProcesses;
  return facts;
}

class Scopes {
  std::mutex mutex;
  std::map<Key,std::shared_ptr<Scope>> records;
  std::map<DWORD,Key> currentPids;
  Key next=1;
  const size_t limit;
#if defined(OWNED_PROCESS_TEST_DEBUG_SERVICE)
  void (*testAdmissionBarrier)(HANDLE)=nullptr;
  void (*testAdmittedBarrier)(const Scope&)=nullptr;
  void (*testBreakpointObserver)(const Scope&,const EXCEPTION_DEBUG_INFO&,bool) noexcept=nullptr;
#endif

  std::shared_ptr<Scope> find(Key key) {
    const auto found=records.find(key);
    if(!key||found==records.end()) throw DWORD{ERROR_NOT_FOUND};
    return found->second;
  }
  std::shared_ptr<Scope> findService(Key key) {
    const auto selected=find(key);
    if(selected->inheritedTermination) throw DWORD{ERROR_NOT_FOUND};
    return selected;
  }
  /** Any one proven original terminating Job suffices, including nested/duplicate
   * witnesses: the inherited debug record grants no public service authority. */
  std::shared_ptr<Scope> terminatingOwner(HANDLE process) {
    for(const auto& item:records) {
      const auto& selected=item.second;
      if(!selected->terminationDispatched) continue;
      BOOL member=FALSE;
      if(!IsProcessInJob(process,selected->job,&member)) throw GetLastError();
      if(member) return selected; // Includes debug-only duplicates of this same original Job.
    }
    return {};
  }
  void finishStop(const std::shared_ptr<Scope>& selected) noexcept {
    std::lock_guard<std::mutex> lock(mutex);
    selected->stopping=false;
  }
  struct StopLease {
    Scopes& owner;
    std::shared_ptr<Scope> selected;
    ~StopLease() noexcept { owner.finishStop(selected); }
  };
public:
  explicit Scopes(size_t liveLimit):limit(liveLimit) {
    if(!limit||limit>4096) throw DWORD{ERROR_INVALID_PARAMETER};
  }
#if defined(OWNED_PROCESS_TEST_DEBUG_SERVICE)
  void setTestAdmissionBarriers(void (*before)(HANDLE),void (*after)(const Scope&)) {
    testAdmissionBarrier=before; testAdmittedBarrier=after;
  }
  void setTestBreakpointObserver(void (*observer)(const Scope&,const EXCEPTION_DEBUG_INFO&,bool) noexcept) {
    testBreakpointObserver=observer;
  }
  Key testRegisteredAncestor(HANDLE child) {
    std::lock_guard<std::mutex> lock(mutex);
    for(const auto& item:records) {
      if(!item.second->registered||item.second->inheritedTermination) continue;
      BOOL member=FALSE;
      if(!IsProcessInJob(child,item.second->job,&member)) throw GetLastError();
      if(member) return item.first;
    }
    return 0;
  }
  bool testOriginalDispatch(Key key,HANDLE child) {
    std::lock_guard<std::mutex> lock(mutex);
    const auto selected=findService(key);
    BOOL member=FALSE;
    if(!IsProcessInJob(child,selected->job,&member)) throw GetLastError();
    if(!member) throw DWORD{ERROR_INVALID_DATA};
    return selected->terminationDispatched;
  }
#endif

  /** Only the creating debugger thread may admit this original prebirth event. */
  void capture(const DEBUG_EVENT& event,HANDLE originalRoot,HANDLE outer,Stage& stage) {
    const HANDLE original=event.u.CreateProcessInfo.hProcess;
    if(!original) throw DWORD{ERROR_INVALID_HANDLE};
    auto selected=std::make_shared<Scope>();
    stage=Stage::RetainChild; selected->process=retainProcess(original);
    stage=Stage::ChildIdentity;
    selected->pid=GetProcessId(selected->process);
    if(!selected->pid) throw GetLastError();
    if(selected->pid!=event.dwProcessId||!sameObject(original,selected->process)||
      sameObject(original,originalRoot)) throw DWORD{ERROR_INVALID_DATA};
    selected->birth=birthOf(selected->process);
    selected->startup.capture(selected->process);
    stage=Stage::OuterMembership; BOOL member=FALSE;
    if(!IsProcessInJob(selected->process,outer,&member)) throw GetLastError();
    if(!member) throw DWORD{ERROR_INVALID_DATA};
#if defined(OWNED_PROCESS_TEST_DEBUG_SERVICE)
    if(testAdmissionBarrier) testAdmissionBarrier(selected->process); // No registry/state lock is held.
#endif

    // Pin the original termination fact before this capture can retire an empty
    // public scope. The pin lasts only for this admission, never as history.
    std::shared_ptr<Scope> inherited;
    { std::lock_guard<std::mutex> lock(mutex); inherited=terminatingOwner(selected->process); }
    stage=Stage::Retire; retire();
    std::unique_lock<std::mutex> lock(mutex);
    stage=Stage::Registry;
    if(records.size()>=limit||!next) throw DWORD{ERROR_TOO_MANY_OPEN_FILES};
    const auto previous=currentPids.find(selected->pid);
    if(previous!=currentPids.end()) {
      const auto old=find(previous->second);
      // Retained HANDLEs pin the native process identity; exact scope keys stay
      // separate from this defensive current-event PID index.
      if(WaitForSingleObject(old->process,0)!=WAIT_OBJECT_0||
        sameObject(old->process,selected->process)) throw DWORD{ERROR_INVALID_DATA};
    }
    stage=Stage::CreateJob; selected->job=owned_job::create();
    stage=Stage::AssignJob;
    if(!AssignProcessToJobObject(selected->job,selected->process)) {
      const DWORD assignmentError=GetLastError();
      try {
        if(!inherited) inherited=terminatingOwner(selected->process);
        member=FALSE;
        if(!inherited||!inherited->terminationDispatched||
          !IsProcessInJob(selected->process,inherited->job,&member)||!member) throw assignmentError;
        const HANDLE retained=duplicate(inherited->job);
        if(!CloseHandle(selected->job)) { CloseHandle(retained); throw assignmentError; }
        selected->job=retained;
        selected->inheritedTermination=true;
        selected->terminationDispatched=true;
      } catch(...) { throw assignmentError; } // Preserve the first native failure if proof is incomplete.
    }
    stage=Stage::VerifyJob;
    if(!IsProcessInJob(selected->process,selected->job,&member)) throw GetLastError();
    if(!member) throw DWORD{ERROR_INVALID_DATA};
    selected->key=next;
    next=next==UINT64_MAX?0:next+1;
    records.emplace(selected->key,selected);
    currentPids[selected->pid]=selected->key;
#if defined(OWNED_PROCESS_TEST_DEBUG_SERVICE)
    lock.unlock();
    if(testAdmittedBarrier) testAdmittedBarrier(*selected); // Registration probes must acquire mutex.
#endif
  }

  /** First admission selects only the current live prebirth capture of this broker.
   * A PID is not historical identity; later operations use the returned original key. */
  Key registerCurrent(DWORD pid) {
    std::lock_guard<std::mutex> lock(mutex);
    if(!pid) throw DWORD{ERROR_INVALID_PARAMETER};
    const auto indexed=currentPids.find(pid);
    if(indexed==currentPids.end()) throw DWORD{ERROR_NOT_FOUND};
    const auto selected=findService(indexed->second);
    if(selected->pid!=pid||selected->key!=indexed->second)
      throw DWORD{ERROR_INVALID_DATA};
    const DWORD waited=WaitForSingleObject(selected->process,0);
    if(waited==WAIT_OBJECT_0) throw DWORD{ERROR_NOT_FOUND};
    if(waited==WAIT_FAILED) throw GetLastError();
    if(waited!=WAIT_TIMEOUT) throw DWORD{ERROR_INVALID_DATA};
    selected->registered=true;
    return selected->key;
  }

  /** Exact retained identity only; current TEST callers already captured its birth.
   * Lookup never adopts a PID or substitutes the current-event index for a scope. */
  Key registerExact(DWORD pid,uint64_t birth) {
    std::lock_guard<std::mutex> lock(mutex);
    std::shared_ptr<Scope> selected;
    for(const auto& item:records) {
      if(item.second->inheritedTermination) continue;
      if(item.second->pid!=pid||item.second->birth!=birth) continue;
      if(selected) throw DWORD{ERROR_INVALID_DATA};
      selected=item.second;
    }
    if(!selected) throw DWORD{ERROR_NOT_FOUND};
    selected->registered=true;
    return selected->key;
  }

  /** Read-only facts from the same retained record, never a signal or tree receipt. */
  Facts query(Key key) {
    std::shared_ptr<Scope> selected;
    { std::lock_guard<std::mutex> lock(mutex); selected=findService(key); }
    return observe(*selected);
  }

  bool firstBreakpoint(DWORD pid,const EXCEPTION_DEBUG_INFO& event) {
    std::lock_guard<std::mutex> lock(mutex);
    const auto found=currentPids.find(pid);
    if(found==currentPids.end()) throw DWORD{ERROR_NOT_FOUND};
    auto selected=find(found->second);
#if defined(OWNED_PROCESS_TEST_DEBUG_SERVICE)
    const bool accepted=selected->startup.accept(event);
    if(testBreakpointObserver&&selected->startup.wow64) testBreakpointObserver(*selected,event,accepted);
    return accepted;
#else
    return selected->startup.accept(event);
#endif
  }

  /** The existing broker frame cache owns attempt deduplication, not this record. */
  Facts stop(Key key,DWORD budget,ULONGLONG admittedAt=GetTickCount64()) {
    if(budget>60000||admittedAt>GetTickCount64()||admittedAt>UINT64_MAX-budget)
      throw DWORD{ERROR_INVALID_PARAMETER};
    const auto deadline=admittedAt+budget; // Queue/registry delay consumes the same admitted budget.
    std::shared_ptr<Scope> selected;
    {
      std::lock_guard<std::mutex> lock(mutex);
      selected=findService(key);
      if(!selected->registered) throw DWORD{ERROR_INVALID_STATE};
      if(selected->stopping) throw DWORD{ERROR_BUSY};
      selected->stopping=true;
    }
    StopLease lease{*this,selected};
    Facts facts=observe(*selected);
    DWORD queryError=facts.queryError, dispatchError=0;
    if(!budget||GetTickCount64()>=deadline) {
      facts.queryError=queryError?queryError:WAIT_TIMEOUT; return facts;
    }
    {
      std::lock_guard<std::mutex> lock(mutex);
      // Admission may have held the registry lock: its delay consumes this same budget.
      if(GetTickCount64()>=deadline) {
        facts.queryError=queryError?queryError:WAIT_TIMEOUT; return facts;
      }
      if(!absent(facts)) {
        if(TerminateJobObject(selected->job,1)) selected->terminationDispatched=true;
        else dispatchError=GetLastError();
      }
    }
    for(;;) {
      facts=observe(*selected);
      if(facts.queryError&&!queryError) queryError=facts.queryError;
      if(GetTickCount64()>=deadline) {
        if(!queryError) queryError=WAIT_TIMEOUT;
        break;
      }
      if(absent(facts)) break;
      Sleep(5); // Registry mutex is not held; the debugger can finish EXIT events.
    }
    if(!absent(facts)&&!queryError) queryError=WAIT_TIMEOUT;
    facts.queryError=queryError; facts.dispatchError=dispatchError;
    return facts;
  }

  /** Existing command settlement may release a registration only after fresh absence. */
  void releaseRegistration(Key key) {
    {
      std::lock_guard<std::mutex> lock(mutex);
      const auto selected=findService(key);
      if(!selected->registered||selected->stopping||!absent(observe(*selected)))
        throw DWORD{ERROR_INVALID_STATE};
      selected->registered=false;
    }
    retire();
  }

  void retire() {
    std::vector<std::shared_ptr<Scope>> retired;
    {
      std::lock_guard<std::mutex> lock(mutex);
      for(auto item=records.begin();item!=records.end();) {
        const auto& selected=item->second;
        if(selected->registered||selected->stopping||!absent(observe(*selected))) { ++item; continue; }
        const auto indexed=currentPids.find(selected->pid);
        if(indexed!=currentPids.end()&&indexed->second==selected->key) currentPids.erase(indexed);
        retired.push_back(std::move(item->second));
        item=records.erase(item);
      }
    }
    // Closing originals happens outside the registry lock. Any in-flight reader
    // still retains its own shared record; no copied numeric HANDLE outlives it.
  }
};
} // namespace owned_service
