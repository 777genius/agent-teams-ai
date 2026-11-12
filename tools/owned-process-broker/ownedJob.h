#pragma once
#include <windows.h>

namespace owned_job {
inline HANDLE create() {
  HANDLE job=CreateJobObjectW(nullptr,nullptr);
  if(!job) throw GetLastError();
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(!SetHandleInformation(job,HANDLE_FLAG_INHERIT,0)||
    !SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))) {
    const DWORD error=GetLastError(); CloseHandle(job); throw error;
  }
  return job;
}
} // namespace owned_job
