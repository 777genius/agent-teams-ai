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
  if(mode==L"tree"||mode==L"root-first"||mode==L"root-first-gated"||mode==L"service-pair"||mode==L"service-first"||mode==L"flood"||mode==L"breakaway"||mode==L"stdio"||mode==L"selection") {
    // The target-only first observable effect precedes child creation/output/scenario work.
    if((mode==L"selection"?argc!=7:argc!=4)||wcslen(argv[3])!=36) return 31;
    HANDLE marker=CreateFileW(argv[2],GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);
    if(marker==INVALID_HANDLE_VALUE) return 32;
    char nonce[36];
    for(size_t i=0;i<36;++i) { if(argv[3][i]>127) return 33; nonce[i]=static_cast<char>(argv[3][i]); }
    DWORD count=0; auto written=WriteFile(marker,nonce,sizeof(nonce),&count,nullptr);
    CloseHandle(marker); if(!written||count!=sizeof(nonce)) return 34;
  }
  if(mode==L"wait"||mode==L"wait-gated") {
    if(argc!=4) return 23;
    DWORD pid=static_cast<DWORD>(wcstoul(argv[2],nullptr,10));
    uint64_t expected=_wcstoui64(argv[3],nullptr,16);
    HANDLE process=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);
    if(!process||birth(process)!=expected) return 24;
    std::puts("captured"); std::fflush(stdout);
    if(mode==L"wait-gated") {
      char ack; DWORD count=0;
      if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),&ack,1,&count,nullptr)||count!=1||ack!='1') return 47;
    }
    auto result=WaitForSingleObject(process,15000); CloseHandle(process);
    return result==WAIT_OBJECT_0?0:25;
  }
  if(mode==L"leaf") { Sleep(60000); return 0; }
  if(mode==L"sentinel") { std::puts("sentinel"); std::fflush(stdout); Sleep(60000); return 0; }
  if(mode==L"selection") {
    if(std::wstring(argv[4])!=L""||std::wstring(argv[5])!=L"space quote \" slash\\ end\\"||
      std::wstring(argv[6])!=L"\u042f\u65e5") return 42;
    wchar_t selected[32768], current[32768];
    if(!GetEnvironmentVariableW(L"TEST_CAPTURED_VALUE",selected,32768)||
      std::wstring(selected)!=L"space quote \" slash\\ end\\ \u042f\u65e5") return 43;
    if(!GetEnvironmentVariableW(L"TEST_CAPTURED_CWD",selected,32768)||
      !GetCurrentDirectoryW(32768,current)||std::wstring(selected)!=current) return 44;
    if(GetEnvironmentVariableW(L"TEST_UNCAPTURED_PARENT",selected,32768)!=0) return 45;
    mode=L"stdio";
  }
  if(mode==L"stdio") {
    char bytes[8192]; DWORD count=0;
    for(;;) {
      if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),bytes,sizeof(bytes),&count,nullptr)) {
        if(GetLastError()!=ERROR_BROKEN_PIPE) return 39;
        break;
      }
      if(!count) break;
      DWORD offset=0;
      while(offset<count) {
        DWORD written=0;
        if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),bytes+offset,count-offset,&written,nullptr)||!written) return 38;
        offset+=written;
      }
    }
    const char output[]="TEST native stdout tail\n", error[]="TEST native stderr tail\n";
    if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),output,sizeof(output)-1,&count,nullptr)||count!=sizeof(output)-1) return 40;
    if(!WriteFile(GetStdHandle(STD_ERROR_HANDLE),error,sizeof(error)-1,&count,nullptr)||count!=sizeof(error)-1) return 41;
    return 7;
  }
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
  if(mode!=L"tree"&&mode!=L"root-first"&&mode!=L"root-first-gated"&&mode!=L"branch"&&mode!=L"branch-first"&&mode!=L"service-pair"&&mode!=L"service-first") return 28;
  BOOL inJob=FALSE;
  if(!IsProcessInJob(GetCurrentProcess(),nullptr,&inJob)||!inJob) return 29;
  const bool branch=mode==L"branch"||mode==L"branch-first";
  if(!branch) std::printf("{\"root\":{\"pid\":%lu,\"birth\":\"%016llx\"}}\n",
    GetCurrentProcessId(),static_cast<unsigned long long>(birth(GetCurrentProcess())));
  const std::wstring branchMode=mode==L"service-first"
    ? L"branch-first \""+std::wstring(argv[2])+L".branch-release\"" : L"branch";
  auto a=child(executable,branch?std::wstring(L"leaf"):branchMode), b=child(executable,L"leaf");
  std::printf("{\"children\":[{\"pid\":%lu,\"birth\":\"%016llx\"},{\"pid\":%lu,\"birth\":\"%016llx\"}],\"parent\":%lu}\n",
    a.dwProcessId,static_cast<unsigned long long>(birth(a.hProcess)),
    b.dwProcessId,static_cast<unsigned long long>(birth(b.hProcess)),GetCurrentProcessId());
  CloseHandle(a.hProcess); CloseHandle(b.hProcess);
  std::printf("{\"final\":true}\n"); std::fflush(stdout);
  if(mode==L"root-first-gated") {
    char ack; DWORD count=0;
    if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),&ack,1,&count,nullptr)||count!=1||ack!='1') return 48;
    return 0;
  }
  if(mode==L"branch-first") {
    if(argc!=3) return 49;
    const auto deadline=GetTickCount64()+10000;
    while(GetFileAttributesW(argv[2])==INVALID_FILE_ATTRIBUTES) {
      if(GetLastError()!=ERROR_FILE_NOT_FOUND||GetTickCount64()>=deadline) return 50;
      Sleep(5); // Wait for explicit TEST witness-captured barrier, never infer capture from time.
    }
    return 0;
  }
  if(mode==L"root-first") return 0;
  if(mode==L"service-pair"||mode==L"service-first") {
    char input[64]; DWORD count=0;
    while(ReadFile(GetStdHandle(STD_INPUT_HANDLE),input,sizeof(input),&count,nullptr)&&count) {
      std::puts("{\"providerAlive\":true}"); std::fflush(stdout);
    }
    return 46;
  }
  Sleep(60000); return 0;
}
