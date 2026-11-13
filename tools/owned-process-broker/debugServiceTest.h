#pragma once
// Native feasibility only. This file is compiled into an unstaged TEST binary,
// never into the product broker. No attach-by-PID, API fallback or SDK claim.
#include "serviceDebugLoop.h"
#include "protocol.h"
#include <io.h>

namespace debug_service_test {
using owned_service::Stage;
inline owned_service::Scopes scopes{64};
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
  return owned_service::runDebugLoop(rootPid,root,outer,stateLock,scopes,failure);
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
