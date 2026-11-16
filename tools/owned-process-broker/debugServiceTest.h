#pragma once
// Native feasibility only. This file is compiled into an unstaged TEST binary,
// never into the product broker. No attach-by-PID, API fallback or SDK claim.
#include "serviceDebugLoop.h"
#include "protocol.h"
#include <io.h>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <string>

namespace debug_service_test {
using owned_service::Stage;
inline owned_service::Scopes scopes{64};
inline std::wstring admissionPath;
inline char admissionNonce[37]{};
inline bool admissionUsed=false, admissionCompleted=false;
inline ULONGLONG admissionDeadline=0;
// Optional TEST-only I386 observations: 15 records and one reserved overflow record.
// The existing admission thread copies already retained identity and decisions only.
inline DWORD breakpointRows[16][8]{};
inline std::atomic<DWORD> breakpointCount{0};
inline HANDLE breakpointOutput=nullptr;
inline DWORD breakpointRootPid=0;
inline uint64_t breakpointRootBirth=0;
inline void observeBreakpoint(DWORD pid,uint64_t birth,const EXCEPTION_DEBUG_INFO& event,bool accepted) noexcept {
  const DWORD index=breakpointCount.load(std::memory_order_relaxed);
  if(!breakpointOutput||index>=16) return;
  auto& row=breakpointRows[index];
  row[0]=index==15?2:1; row[1]=index+1;
  if(row[0]==1) {
    row[2]=pid; row[3]=static_cast<DWORD>(birth); row[4]=static_cast<DWORD>(birth>>32);
    row[5]=event.ExceptionRecord.ExceptionCode; row[6]=event.dwFirstChance; row[7]=accepted?1:0;
  }
  breakpointCount.store(index+1,std::memory_order_release);
}
inline void observeChildBreakpoint(const owned_service::Scope& child,const EXCEPTION_DEBUG_INFO& event,bool accepted) noexcept {
  observeBreakpoint(child.pid,child.birth,event,accepted);
}
inline void observeRootBreakpoint(const EXCEPTION_DEBUG_INFO& event,bool accepted) noexcept {
  observeBreakpoint(breakpointRootPid,breakpointRootBirth,event,accepted);
}
inline void configureBreakpointObservations() {
  wchar_t expected[2]{};
  const auto length=GetEnvironmentVariableW(L"OWNED_PROCESS_TEST_I386_EVENTS",expected,2);
  if(!length) return;
  if(length!=1||expected[0]!=L'1') throw DWORD{ERROR_INVALID_PARAMETER};
  breakpointOutput=reinterpret_cast<HANDLE>(_get_osfhandle(5));
  if(breakpointOutput==INVALID_HANDLE_VALUE||GetFileType(breakpointOutput)!=FILE_TYPE_DISK)
    throw DWORD{ERROR_INVALID_HANDLE};
  scopes.setTestBreakpointObserver(observeChildBreakpoint);
}
inline bool flushBreakpointObservations() noexcept {
  const DWORD count=breakpointCount.load(std::memory_order_acquire);
  if(!breakpointOutput||!count) return true;
  const DWORD requested=static_cast<DWORD>(count*sizeof(breakpointRows[0]));
  DWORD written=0;
  return WriteFile(breakpointOutput,breakpointRows,requested,&written,nullptr)&&written==requested;
}
inline void checkAdmissionDeadline() {
  if(GetTickCount64()>=admissionDeadline) throw DWORD{WAIT_TIMEOUT};
}
inline void configureAdmissionBarrier() {
  wchar_t path[1024]{}, nonce[37]{};
  const DWORD pathLength=GetEnvironmentVariableW(L"OWNED_PROCESS_TEST_ADMISSION_BARRIER",path,1024);
  if(!pathLength) return;
  if(pathLength>=1024||GetEnvironmentVariableW(L"OWNED_PROCESS_TEST_ADMISSION_NONCE",nonce,37)!=36)
    throw DWORD{ERROR_INVALID_PARAMETER};
  admissionPath=path;
  for(size_t index=0;index<36;++index) {
    if(nonce[index]>127) throw DWORD{ERROR_INVALID_PARAMETER};
    admissionNonce[index]=static_cast<char>(nonce[index]);
  }
}
inline void writeAdmissionBarrier(const wchar_t* suffix,const char* bytes,DWORD length) {
  checkAdmissionDeadline();
  const auto target=admissionPath+suffix;
  HANDLE file=CreateFileW(target.c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,CREATE_NEW,
    FILE_ATTRIBUTE_NORMAL,nullptr);
  if(file==INVALID_HANDLE_VALUE) throw GetLastError();
  DWORD count=0;
  const bool written=WriteFile(file,bytes,length,&count,nullptr)!=FALSE;
  DWORD error=written?(count==length?0:ERROR_INVALID_DATA):GetLastError();
  if(!CloseHandle(file)&&!error) error=GetLastError();
  if(error) throw error;
  checkAdmissionDeadline();
}
inline void waitAdmissionBarrier(const wchar_t* suffix) {
  const auto release=admissionPath+suffix;
  for(;;) {
    checkAdmissionDeadline();
    HANDLE file=CreateFileW(release.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL,nullptr);
    if(file!=INVALID_HANDLE_VALUE) {
      char actual[37]{}; DWORD count=0;
      const bool read=ReadFile(file,actual,sizeof(actual),&count,nullptr)!=FALSE;
      DWORD error=read?(count==36&&std::memcmp(actual,admissionNonce,36)==0?0:ERROR_INVALID_DATA):GetLastError();
      if(!CloseHandle(file)&&!error) error=GetLastError();
      if(error) throw error;
      checkAdmissionDeadline();
      break;
    }
    const auto error=GetLastError();
    if(error!=ERROR_FILE_NOT_FOUND) throw error;
    Sleep(1);
  }
}
inline void admissionBarrier(HANDLE child) {
  if(admissionPath.empty()||admissionUsed) return;
  const auto key=scopes.testRegisteredAncestor(child);
  if(!key) return;
  admissionUsed=true;
  admissionDeadline=GetTickCount64()+5000;
  writeAdmissionBarrier(L".captured",admissionNonce,36);
  while(!scopes.testOriginalDispatch(key,child)) {
    checkAdmissionDeadline();
    Sleep(1);
  }
  writeAdmissionBarrier(L".dispatched",admissionNonce,36);
  waitAdmissionBarrier(L".dispatch-continue");
  const auto pending=scopes.query(key);
  if(pending.queryError||owned_service::absent(pending)||!scopes.testOriginalDispatch(key,child))
    throw DWORD{ERROR_INVALID_DATA}; // Pending CREATE cannot complete the original scope.
  checkAdmissionDeadline();
}
inline void admittedBarrier(const owned_service::Scope& child) {
  if(!admissionUsed||admissionCompleted) return;
  if(!child.inheritedTermination||!child.terminationDispatched) throw DWORD{ERROR_INVALID_DATA};
  char value[160]{};
  const int length=std::snprintf(value,sizeof(value),"{\"nonce\":\"%s\",\"pid\":%lu,\"birth\":\"%016llx\"}",
    admissionNonce,child.pid,static_cast<unsigned long long>(child.birth));
  if(length<=0||static_cast<size_t>(length)>=sizeof(value)) throw DWORD{ERROR_INVALID_DATA};
  writeAdmissionBarrier(L".admitted",value,static_cast<DWORD>(length));
  waitAdmissionBarrier(L".admission-continue");
  admissionCompleted=true;
}
// One bounded TEST diagnostic record, never a command or production wire receipt.
inline void failure(Stage stage,DWORD error,const DEBUG_EVENT& event={}) noexcept {
  const DWORD record[4]={static_cast<DWORD>(stage),error,event.dwDebugEventCode,event.dwProcessId};
  const auto file=reinterpret_cast<HANDLE>(_get_osfhandle(4));
  if(file==INVALID_HANDLE_VALUE||GetFileType(file)!=FILE_TYPE_DISK) return;
  DWORD written=0;
  WriteFile(file,record,sizeof(record),&written,nullptr); // best effort; exit remains failure
}

/** Called on the same existing admission thread; TEST alone supplies FD4 diagnostics. */
inline bool run(DWORD rootPid,HANDLE root,HANDLE outer,std::unique_lock<std::timed_mutex>& stateLock) {
  configureAdmissionBarrier();
  configureBreakpointObservations();
  wchar_t expected[2]{};
  const auto length=GetEnvironmentVariableW(L"OWNED_PROCESS_TEST_I386_ROOT",expected,2);
  if(length) {
    const auto module=GetModuleHandleW(L"Kernel32.dll");
    if(!module) throw GetLastError();
    const auto query=reinterpret_cast<BOOL (WINAPI*)(HANDLE,USHORT*,USHORT*)>(
      GetProcAddress(module,"IsWow64Process2"));
    if(!query) throw GetLastError();
    USHORT machine=IMAGE_FILE_MACHINE_UNKNOWN;
    if(!query(root,&machine,nullptr)) throw GetLastError();
    if(length!=1||expected[0]!=L'1'||machine!=IMAGE_FILE_MACHINE_I386) throw DWORD{ERROR_INVALID_DATA};
    if(breakpointOutput) {
      // Capture once under the original state lock, before the debug loop releases it.
      breakpointRootPid=rootPid;
      breakpointRootBirth=owned_service::birthOf(root);
      if(!breakpointRootPid||!breakpointRootBirth) throw DWORD{ERROR_INVALID_DATA};
    }
  }
  scopes.setTestAdmissionBarriers(admissionBarrier,admittedBarrier);
  const bool result=owned_service::runDebugLoop(rootPid,root,outer,stateLock,scopes,failure,
    breakpointRootBirth?observeRootBreakpoint:nullptr);
  if(result&&!admissionPath.empty()&&!admissionCompleted) {
    failure(Stage::Registry,ERROR_INVALID_DATA); return false;
  }
  return result;
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
