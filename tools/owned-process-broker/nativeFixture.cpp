#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <string>
#include <vector>

static uint64_t birth(HANDLE process) {
  FILETIME c{},e{},k{},u{};
  if(!GetProcessTimes(process,&c,&e,&k,&u)) ExitProcess(20);
  return (static_cast<uint64_t>(c.dwHighDateTime)<<32)|c.dwLowDateTime;
}
static PROCESS_INFORMATION child(const std::wstring& executable,const std::wstring& mode,DWORD flags=0) {
  std::wstring command=L"\""+executable+L"\" "+mode;
  STARTUPINFOW startup{}; startup.cb=sizeof(startup); PROCESS_INFORMATION process{};
  startup.dwFlags=STARTF_USESTDHANDLES;
  startup.hStdInput=GetStdHandle(STD_INPUT_HANDLE); startup.hStdOutput=GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError=GetStdHandle(STD_ERROR_HANDLE);
  if(!CreateProcessW(executable.c_str(),command.data(),nullptr,nullptr,TRUE,flags,
    nullptr,nullptr,&startup,&process)) ExitProcess(21);
  CloseHandle(process.hThread); return process;
}
int wmain(int argc,wchar_t** argv) {
  if(argc<2) return 22;
  std::wstring mode=argv[1];
  if(mode==L"tree"||mode==L"root-first"||mode==L"flood"||mode==L"breakaway") {
    // The target-only first observable effect precedes child creation/output/scenario work.
    if(argc!=4||wcslen(argv[3])!=36) return 31;
    HANDLE marker=CreateFileW(argv[2],GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);
    if(marker==INVALID_HANDLE_VALUE) return 32;
    char nonce[36];
    for(size_t i=0;i<36;++i) { if(argv[3][i]>127) return 33; nonce[i]=static_cast<char>(argv[3][i]); }
    DWORD count=0; auto written=WriteFile(marker,nonce,sizeof(nonce),&count,nullptr);
    CloseHandle(marker); if(!written||count!=sizeof(nonce)) return 34;
  }
  if(mode==L"wait") {
    if(argc!=4) return 23;
    DWORD pid=static_cast<DWORD>(wcstoul(argv[2],nullptr,10));
    uint64_t expected=_wcstoui64(argv[3],nullptr,16);
    HANDLE process=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);
    if(!process||birth(process)!=expected) return 24;
    std::puts("captured"); std::fflush(stdout);
    auto result=WaitForSingleObject(process,15000); CloseHandle(process);
    return result==WAIT_OBJECT_0?0:25;
  }
  if(mode==L"leaf") { Sleep(60000); return 0; }
  if(mode==L"sentinel") { std::puts("sentinel"); std::fflush(stdout); Sleep(60000); return 0; }
  std::vector<wchar_t> path(32768);
  auto n=GetModuleFileNameW(nullptr,path.data(),static_cast<DWORD>(path.size()));
  if(!n||n>=path.size()) return 26;
  std::wstring executable(path.data(),n);
  if(mode==L"flood") {
    HANDLE progress=CreateFileW((std::wstring(argv[2])+L".progress").c_str(),GENERIC_WRITE,
      FILE_SHARE_READ,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);
    if(progress==INVALID_HANDLE_VALUE) return 35;
    std::vector<char> bytes(8192,'x'); DWORD total=0;
    while(total<8*1024*1024) {
      DWORD count=0;
      if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)||!count) return 36;
      total+=count;
      char evidence[40]; for(size_t i=0;i<36;++i) evidence[i]=static_cast<char>(argv[3][i]);
      std::memcpy(evidence+36,&total,sizeof(total)); LARGE_INTEGER beginning{};
      if(!SetFilePointerEx(progress,beginning,nullptr,FILE_BEGIN)||
        !WriteFile(progress,evidence,sizeof(evidence),&count,nullptr)||count!=sizeof(evidence)) return 37;
    }
    CloseHandle(progress); Sleep(60000); return 0;
  }
  if(mode==L"breakaway") {
    std::wstring command=L"\""+executable+L"\" leaf";
    STARTUPINFOW startup{}; startup.cb=sizeof(startup); PROCESS_INFORMATION process{};
    if(!CreateProcessW(executable.c_str(),command.data(),nullptr,nullptr,FALSE,
      CREATE_BREAKAWAY_FROM_JOB,nullptr,nullptr,&startup,&process)) {
      if(GetLastError()!=ERROR_ACCESS_DENIED) return 30;
      std::puts("breakaway-denied"); std::fflush(stdout); return 0;
    }
    TerminateProcess(process.hProcess,27); WaitForSingleObject(process.hProcess,5000);
    CloseHandle(process.hProcess); CloseHandle(process.hThread); return 27;
  }
  if(mode!=L"tree"&&mode!=L"root-first"&&mode!=L"branch") return 28;
  BOOL inJob=FALSE;
  if(!IsProcessInJob(GetCurrentProcess(),nullptr,&inJob)||!inJob) return 29;
  auto a=child(executable,mode==L"branch"?L"leaf":L"branch"), b=child(executable,L"leaf");
  std::printf("{\"children\":[{\"pid\":%lu,\"birth\":\"%016llx\"},{\"pid\":%lu,\"birth\":\"%016llx\"}]}\n",
    a.dwProcessId,static_cast<unsigned long long>(birth(a.hProcess)),
    b.dwProcessId,static_cast<unsigned long long>(birth(b.hProcess)));
  CloseHandle(a.hProcess); CloseHandle(b.hProcess);
  std::printf("{\"final\":true}\n"); std::fflush(stdout);
  if(mode==L"root-first") return 0;
  Sleep(60000); return 0;
}
