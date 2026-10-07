#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>
#include <filesystem>
#include <string>
#include <vector>

// Independent outer authority for only this disposable gate. Emergency cleanup is FAIL,
// even when the private product capability did not confirm or its control disappeared.
static std::wstring quote(const std::wstring& value) {
  std::wstring out=L"\""; size_t slashes=0;
  for(auto c:value) {
    if(c==L'\\') { ++slashes; continue; }
    if(c==L'\"') out.append(slashes*2+1,L'\\'); else out.append(slashes,L'\\');
    slashes=0; out+=c;
  }
  out.append(slashes*2,L'\\'); return out+L'\"';
}
static bool zero(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
  return QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&info,sizeof(info),nullptr)&&info.ActiveProcesses==0;
}
int wmain(int argc,wchar_t** argv) {
  if(argc<9) { std::fprintf(stderr,"Usage: gate-controller node.exe runner gate.ts staged-broker fixture birth-fault accounting-fault release-delay\n"); return 90; }
  wchar_t temporary[MAX_PATH+1]{}, unique[MAX_PATH+1]{};
  if(!GetTempPathW(MAX_PATH,temporary)||!GetTempFileNameW(temporary,L"opg",0,unique)) return 91;
  if(!DeleteFileW(unique)||!CreateDirectoryW(unique,nullptr)) return 92;
  const std::wstring sandbox=unique;
  std::wprintf(L"gate-owned-sandbox:%ls\n",sandbox.c_str()); std::fflush(stdout);
  HANDLE job=CreateJobObjectW(nullptr,nullptr);
  if(!job||!SetHandleInformation(job,HANDLE_FLAG_INHERIT,0)) return 93;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))) { CloseHandle(job); return 94; }
  SIZE_T size=0; InitializeProcThreadAttributeList(nullptr,2,0,&size);
  if(!size) { CloseHandle(job); return 95; }
  std::vector<unsigned char> storage(size);
  auto list=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if(!InitializeProcThreadAttributeList(list,2,0,&size)) { CloseHandle(job); return 96; }
  HANDLE handles[3]={GetStdHandle(STD_INPUT_HANDLE),GetStdHandle(STD_OUTPUT_HANDLE),GetStdHandle(STD_ERROR_HANDLE)};
  bool ok=true;
  for(auto handle:handles) if(!handle||handle==INVALID_HANDLE_VALUE||
    !SetHandleInformation(handle,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT)) ok=false;
  ok=ok&&UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,&job,sizeof(job),nullptr,nullptr)&&
    UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,sizeof(handles),nullptr,nullptr);
  if(!ok) { DeleteProcThreadAttributeList(list); CloseHandle(job); return 97; }
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb=sizeof(startup);
  startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput=handles[0]; startup.StartupInfo.hStdOutput=handles[1];
  startup.StartupInfo.hStdError=handles[2]; startup.lpAttributeList=list;
  std::wstring command;
  for(int i=1;i<argc;++i) { if(i>1) command+=L' '; command+=quote(argv[i]); }
  command+=L" --controller-sandbox "+quote(sandbox);
  if(command.size()>=32767) { DeleteProcThreadAttributeList(list); CloseHandle(job); return 105; }
  PROCESS_INFORMATION process{};
  ok=CreateProcessW(argv[1],command.data(),nullptr,nullptr,TRUE,
    EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT,
    nullptr,sandbox.c_str(),&startup.StartupInfo,&process)!=FALSE;
  DeleteProcThreadAttributeList(list);
  if(!ok) { CloseHandle(job); return 98; }
  bool emergency=false, rootExited=false; DWORD code=99;
  if(ResumeThread(process.hThread)!=1) emergency=true;
  CloseHandle(process.hThread);
  if(!emergency) {
    auto result=WaitForSingleObject(process.hProcess,120000);
    rootExited=result==WAIT_OBJECT_0;
    if(!rootExited||!GetExitCodeProcess(process.hProcess,&code)) emergency=true;
  }
  // Drop original handle after retaining signaled exit witness, so accounting can decay.
  if(rootExited) { CloseHandle(process.hProcess); process.hProcess=nullptr; }
  auto quietDeadline=GetTickCount64()+3000;
  while(!emergency&&!zero(job)&&GetTickCount64()<quietDeadline) Sleep(10);
  if(!zero(job)) emergency=true;
  if(emergency) {
    if(!TerminateJobObject(job,99)) { CloseHandle(job); return 100; }
    auto cleanupDeadline=GetTickCount64()+10000;
    while(GetTickCount64()<cleanupDeadline) {
      if(process.hProcess&&WaitForSingleObject(process.hProcess,0)==WAIT_OBJECT_0) {
        CloseHandle(process.hProcess); process.hProcess=nullptr; rootExited=true;
      }
      if(!process.hProcess&&zero(job)) break;
      Sleep(10);
    }
  }
  if(process.hProcess||!rootExited||!zero(job)) { CloseHandle(job); return 101; }
  if(!CloseHandle(job)) return 102;
  // Destructive sandbox cleanup follows fresh zero membership plus original-root exit.
  std::error_code error;
  std::filesystem::remove_all(sandbox,error);
  if(error) return 103;
  std::printf("{\"gateController\":\"%s\",\"rootExitCode\":%lu,\"activeProcesses\":0}\n",
    emergency?"emergency-fail":"drained",code);
  return !emergency&&code==0?0:104;
}
