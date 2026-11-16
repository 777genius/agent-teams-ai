#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
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
static bool applicationBreakpoint(DWORD code) {
  bool delivered=false;
  __try { RaiseException(code,0,0,nullptr); }
  __except(GetExceptionCode()==code?EXCEPTION_EXECUTE_HANDLER:EXCEPTION_CONTINUE_SEARCH) {
    delivered=true;
  }
  return delivered;
}
enum class PrerequisiteStage : DWORD {
  RootBreakpoint=1, RootWow64Breakpoint, Wow64Module, Wow64QueryEntry, Wow64Path,
  Wow64Query, Wow64Architecture, Wow64Wait, Wow64ExitRead, Wow64ExitCode,
  Wow64HandleClose, Wow64PublicationOpen, Wow64PublicationWrite, Wow64PublicationCount,
  Wow64PublicationClose, ApplicationWait, ApplicationExitRead, ApplicationExitCode,
  ApplicationHandleClose, I386Query, I386Architecture, I386Wait, I386ExitRead,
  I386ExitCode, I386HandleClose
};
static bool prerequisiteFailure(PrerequisiteStage stage,const DWORD* result=nullptr) {
  if(result) std::printf("{\"TEST_SERVICE_PAIR_PREREQUISITE\":{\"stage\":%lu,\"result\":%lu}}\n",
    static_cast<DWORD>(stage),*result);
  else std::printf("{\"TEST_SERVICE_PAIR_PREREQUISITE\":{\"stage\":%lu}}\n",static_cast<DWORD>(stage));
  std::fflush(stdout); return false;
}
static std::wstring wow64Command() {
  // Resolve the documented API-set contract with one bounded module lifetime.
  const auto module=LoadLibraryExW(L"api-ms-win-core-wow64-l1-1-1.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);
  if(!module) return {};
  const auto directory=reinterpret_cast<decltype(&GetSystemWow64Directory2W)>(
    GetProcAddress(module,"GetSystemWow64Directory2W"));
  wchar_t path[MAX_PATH]{};
  const auto length=directory?directory(path,MAX_PATH,IMAGE_FILE_MACHINE_I386):0;
  const bool closed=FreeLibrary(module)!=FALSE;
  if(!closed||!length||length>=MAX_PATH) return {};
  return std::wstring(path)+L"\\cmd.exe";
}
static bool wow64Startup() {
  const auto module=GetModuleHandleW(L"Kernel32.dll");
  if(!module) return prerequisiteFailure(PrerequisiteStage::Wow64Module);
  const auto machine=reinterpret_cast<BOOL (WINAPI*)(HANDLE,USHORT*,USHORT*)>(
    GetProcAddress(module,"IsWow64Process2"));
  const auto executable=wow64Command();
  if(!machine) return prerequisiteFailure(PrerequisiteStage::Wow64QueryEntry);
  if(executable.empty()) return prerequisiteFailure(PrerequisiteStage::Wow64Path);
  // This finite Windows component is explicitly verified as x86 on both hosts.
  // Its ordinary loader must survive the real native + WOW64 startup events.
  const auto process=child(executable,L"/d /c exit 0");
  USHORT architecture=IMAGE_FILE_MACHINE_UNKNOWN;
  DWORD code=MAXDWORD;
  auto stage=PrerequisiteStage::Wow64Query;
  DWORD result=0;
  const bool passed=[&] {
    result=machine(process.hProcess,&architecture,nullptr); if(!result) return false;
    stage=PrerequisiteStage::Wow64Architecture; result=architecture;
    if(result!=IMAGE_FILE_MACHINE_I386) return false;
    stage=PrerequisiteStage::Wow64Wait; result=WaitForSingleObject(process.hProcess,5000);
    if(result!=WAIT_OBJECT_0) return false;
    stage=PrerequisiteStage::Wow64ExitRead; result=GetExitCodeProcess(process.hProcess,&code);
    if(!result) return false;
    stage=PrerequisiteStage::Wow64ExitCode; result=code; return result==0;
  }();
  const bool processClosed=CloseHandle(process.hProcess)!=FALSE;
  if(!passed) return prerequisiteFailure(stage,&result);
  if(!processClosed) return prerequisiteFailure(PrerequisiteStage::Wow64HandleClose);
  // The next original-root scenario consumes this exact verified path in the
  // same controller-created cwd. CREATE_NEW refuses stale or repeated publication.
  HANDLE file=CreateFileW(L"TEST-wow64-command.utf16",GENERIC_WRITE,0,nullptr,CREATE_NEW,
    FILE_ATTRIBUTE_NORMAL,nullptr);
  if(file==INVALID_HANDLE_VALUE) return prerequisiteFailure(PrerequisiteStage::Wow64PublicationOpen);
  const auto length=static_cast<DWORD>(executable.size()*sizeof(wchar_t));
  DWORD count=0;
  const bool wrote=WriteFile(file,executable.data(),length,&count,nullptr)!=FALSE;
  const bool written=wrote&&count==length;
  const bool closed=CloseHandle(file)!=FALSE;
  if(!written) return prerequisiteFailure(wrote?PrerequisiteStage::Wow64PublicationCount:
    PrerequisiteStage::Wow64PublicationWrite,wrote?&count:nullptr);
  if(!closed) return prerequisiteFailure(PrerequisiteStage::Wow64PublicationClose);
  return true;
}
static bool i386ApplicationChild(const std::wstring& executable) {
  const auto module=GetModuleHandleW(L"Kernel32.dll");
  const auto machine=module?reinterpret_cast<BOOL (WINAPI*)(HANDLE,USHORT*,USHORT*)>(
    GetProcAddress(module,"IsWow64Process2")):nullptr;
  if(!machine) return prerequisiteFailure(PrerequisiteStage::I386Query);
  const auto process=child(executable,L"application-breakpoints");
  const auto originalBirth=birth(process.hProcess);
  USHORT architecture=IMAGE_FILE_MACHINE_UNKNOWN;
  DWORD code=MAXDWORD, result=0;
  auto stage=PrerequisiteStage::I386Query;
  const bool passed=[&] {
    result=machine(process.hProcess,&architecture,nullptr); if(!result) return false;
    stage=PrerequisiteStage::I386Architecture; result=architecture;
    if(result!=IMAGE_FILE_MACHINE_I386) return false;
    stage=PrerequisiteStage::I386Wait; result=WaitForSingleObject(process.hProcess,5000);
    if(result!=WAIT_OBJECT_0) return false;
    stage=PrerequisiteStage::I386ExitRead; result=GetExitCodeProcess(process.hProcess,&code);
    if(!result) return false;
    stage=PrerequisiteStage::I386ExitCode; result=code; return result==0;
  }();
  const bool closed=CloseHandle(process.hProcess)!=FALSE;
  if(!passed) return prerequisiteFailure(stage,&result);
  if(!closed) return prerequisiteFailure(PrerequisiteStage::I386HandleClose);
  std::printf("{\"TEST_I386_CHILD\":{\"pid\":%lu,\"birth\":\"%016llx\",\"machine\":%u,\"exitCode\":0}}\n",
    process.dwProcessId,static_cast<unsigned long long>(originalBirth),static_cast<unsigned>(architecture));
  std::fflush(stdout); return true;
}
int wmain(int argc,wchar_t** argv) {
  if(argc<2) return 22;
  std::wstring mode=argv[1];
  const bool vendorHeld=mode.rfind(L"vendor-",0)==0;
  if(vendorHeld) {
    // TEST-only actors remain under the original controller's bounded outer Job.
    // Normal nativeGate modes keep their existing finite lifetimes unchanged.
    wchar_t go[2]{}; BOOL inJob=FALSE;
    if(GetEnvironmentVariableW(L"OWNED_PROCESS_VENDOR_TEST_GO",go,2)!=1||go[0]!=L'1'||
      !IsProcessInJob(GetCurrentProcess(),nullptr,&inJob)||!inJob) return 51;
    mode=mode.substr(7);
    if(mode!=L"tree"&&mode!=L"branch"&&mode!=L"leaf"&&mode!=L"sentinel"&&mode!=L"wait-gated"&&mode!=L"query-wait-gated") return 52;
  }
  if(mode==L"tree"||mode==L"root-first"||mode==L"root-first-gated"||mode==L"service-pair"||mode==L"service-first"||mode==L"service-race"||mode==L"race-child"||mode==L"flood"||mode==L"breakaway"||mode==L"stdio"||mode==L"selection"||
    mode==L"application-breakpoints-root") {
    // The target-only first observable effect precedes child creation/output/scenario work.
    if((mode==L"selection"?argc!=7:argc!=4)||wcslen(argv[3])!=36) return 31;
    HANDLE marker=CreateFileW(argv[2],GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);
    if(marker==INVALID_HANDLE_VALUE) return 32;
    char nonce[36];
    for(size_t i=0;i<36;++i) { if(argv[3][i]>127) return 33; nonce[i]=static_cast<char>(argv[3][i]); }
    DWORD count=0; auto written=WriteFile(marker,nonce,sizeof(nonce),&count,nullptr);
    CloseHandle(marker); if(!written||count!=sizeof(nonce)) return 34;
  }
  if(mode==L"race-child") return 0;
  if(mode==L"wait"||mode==L"wait-gated"||mode==L"query-wait-gated") {
    if(mode==L"query-wait-gated"&&!vendorHeld) {
      // The finite source gate uses its original outer Job, without vendor admission.
      // Keep the ordinary 15s native wait; vendor actors retain their separate guard.
      BOOL inJob=FALSE;
      if(!IsProcessInJob(GetCurrentProcess(),nullptr,&inJob)||!inJob) return 54;
    }
    if(argc!=4) return 23;
    DWORD pid=static_cast<DWORD>(wcstoul(argv[2],nullptr,10));
    uint64_t expected=_wcstoui64(argv[3],nullptr,16);
    HANDLE process=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);
    if(!process||birth(process)!=expected) return 24;
    std::puts("captured"); std::fflush(stdout);
    if(mode==L"query-wait-gated") {
      unsigned queries=0;
      for(;;) {
        char command; DWORD count=0;
        if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),&command,1,&count,nullptr)||count!=1) {
          CloseHandle(process); return 55;
        }
        if(command=='W') break;
        if(command!='Q'||++queries>4) { CloseHandle(process); return 56; }
        // Same HANDLE captured before the provider's first resume. No PID reopen or signal.
        const auto state=WaitForSingleObject(process,0);
        if(state!=WAIT_TIMEOUT&&state!=WAIT_OBJECT_0) { CloseHandle(process); return 57; }
        std::puts(state==WAIT_TIMEOUT?"alive":"absent"); std::fflush(stdout);
      }
    } else if(mode==L"wait-gated") {
      char ack; DWORD count=0;
      if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),&ack,1,&count,nullptr)||count!=1||ack!='1') return 47;
    }
    auto result=WaitForSingleObject(process,vendorHeld?INFINITE:15000); CloseHandle(process);
    return result==WAIT_OBJECT_0?0:25;
  }
  if(mode==L"exit-fast") return 0;
  if(mode==L"application-breakpoints"||mode==L"application-breakpoints-root")
    return applicationBreakpoint(EXCEPTION_BREAKPOINT)&&applicationBreakpoint(0x4000001f)?0:61;
  if(mode==L"source-sentinel") {
    // Only the source gate holds this original pipe inside its existing 120s outer Job.
    // Ordinary sentinel and vendor actors keep their original lifetime contracts.
    BOOL inJob=FALSE;
    if(argc!=2||!IsProcessInJob(GetCurrentProcess(),nullptr,&inJob)||!inJob) return 58;
    std::puts("sentinel"); std::fflush(stdout);
    char command; DWORD count=0;
    if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),&command,1,&count,nullptr))
      return GetLastError()==ERROR_BROKEN_PIPE?0:59;
    return count==0?0:60; // Any byte is refused; only original parent EOF can finish normally.
  }
  if(mode==L"leaf") { Sleep(vendorHeld?INFINITE:60000); return 0; }
  if(mode==L"sentinel") { std::puts("sentinel"); std::fflush(stdout); Sleep(vendorHeld?INFINITE:60000); return 0; }
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
  if(mode!=L"tree"&&mode!=L"root-first"&&mode!=L"root-first-gated"&&mode!=L"branch"&&mode!=L"branch-first"&&mode!=L"branch-race"&&mode!=L"service-pair"&&mode!=L"service-first"&&mode!=L"service-race") return 28;
  BOOL inJob=FALSE;
  if(!IsProcessInJob(GetCurrentProcess(),nullptr,&inJob)||!inJob) return 29;
  const bool branch=mode==L"branch"||mode==L"branch-first"||mode==L"branch-race";
  if(!branch) std::printf("{\"root\":{\"pid\":%lu,\"birth\":\"%016llx\"}}\n",
    GetCurrentProcessId(),static_cast<unsigned long long>(birth(GetCurrentProcess())));
  if(mode==L"service-pair") {
    if(!applicationBreakpoint(EXCEPTION_BREAKPOINT)) {
      prerequisiteFailure(PrerequisiteStage::RootBreakpoint); return 62;
    }
    if(!applicationBreakpoint(0x4000001f)) {
      prerequisiteFailure(PrerequisiteStage::RootWow64Breakpoint); return 62;
    }
    if(!wow64Startup()) return 62;
    const auto application=child(executable,L"application-breakpoints");
    DWORD applicationCode=MAXDWORD;
    auto stage=PrerequisiteStage::ApplicationWait;
    DWORD result=WaitForSingleObject(application.hProcess,5000);
    bool applicationPassed=result==WAIT_OBJECT_0;
    if(applicationPassed) {
      stage=PrerequisiteStage::ApplicationExitRead; result=GetExitCodeProcess(application.hProcess,&applicationCode);
      applicationPassed=result!=0;
    }
    if(applicationPassed) {
      stage=PrerequisiteStage::ApplicationExitCode; result=applicationCode; applicationPassed=result==0;
    }
    const bool closed=CloseHandle(application.hProcess)!=FALSE;
    if(!applicationPassed) { prerequisiteFailure(stage,&result); return 63; }
    if(!closed) { prerequisiteFailure(PrerequisiteStage::ApplicationHandleClose); return 63; }
    std::puts("{\"wow64StartupAndApplicationBreakpoints\":true}"); std::fflush(stdout);
    wchar_t i386Fixture[32768]{};
    const auto i386Length=GetEnvironmentVariableW(L"OWNED_PROCESS_TEST_I386_FIXTURE",i386Fixture,32768);
    if(i386Length>=32768||(i386Length&&!i386ApplicationChild(i386Fixture))) return 63;
    // Sequential original HANDLE exits exceed the debug registry's64 live cap.
    // This is cumulative churn, never80 simultaneously owned live children.
    for(DWORD index=0;index<80;++index) {
      auto transient=child(executable,L"exit-fast");
      DWORD code=MAXDWORD;
      const bool exited=WaitForSingleObject(transient.hProcess,5000)==WAIT_OBJECT_0&&
        GetExitCodeProcess(transient.hProcess,&code)!=FALSE;
      if(!CloseHandle(transient.hProcess)||!exited||code!=0) return 53;
    }
    std::puts("{\"retiredChildren\":80}"); std::fflush(stdout);
  }
  const std::wstring branchMode=mode==L"service-first"
    ? L"branch-first \""+std::wstring(argv[2])+L".branch-release\""
    : mode==L"service-race"?L"branch-race \""+std::wstring(argv[2])+L"\" "+argv[3]
      : (vendorHeld?L"vendor-branch":L"branch");
  const std::wstring leafMode=vendorHeld?L"vendor-leaf":L"leaf";
  auto a=child(executable,branch?leafMode:branchMode), b=child(executable,leafMode);
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
  if(mode==L"branch-race") {
    if(argc!=4||wcslen(argv[3])!=36) return 64;
    const auto release=std::wstring(argv[2])+L".race-release";
    const auto deadline=GetTickCount64()+10000;
    while(GetFileAttributesW(release.c_str())==INVALID_FILE_ATTRIBUTES) {
      if(GetLastError()!=ERROR_FILE_NOT_FOUND||GetTickCount64()>=deadline) return 65;
      Sleep(5);
    }
    // The TEST debugger parks this CREATE before it admits the child's own Job.
    const auto pending=child(executable,L"race-child \""+std::wstring(argv[2])+L".race-effect\" "+argv[3]);
    CloseHandle(pending.hProcess);
  }
  if(mode==L"root-first") return 0;
  if(mode==L"service-pair"||mode==L"service-first"||mode==L"service-race") {
    char input[64]; DWORD count=0;
    while(ReadFile(GetStdHandle(STD_INPUT_HANDLE),input,sizeof(input),&count,nullptr)&&count) {
      std::puts("{\"providerAlive\":true}"); std::fflush(stdout);
    }
    return 46;
  }
  Sleep(vendorHeld?INFINITE:60000); return 0;
}
