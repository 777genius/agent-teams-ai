#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include "protocol.h"
#include <bcrypt.h>
#include <cstdio>
#include <type_traits>

namespace {
constexpr DWORD Bytes=1024*1024, Slots=8, Fields=24;
// Shared POD: writer owns header0-13/slots, supervisor owns header32-47. Final after original exit.
struct alignas(8) Witness { DWORD header[64]; DWORD operations[Slots][Fields]; };
static_assert(sizeof(Witness)==1024&&std::is_standard_layout_v<Witness>);
static_assert(offsetof(Witness,operations)%4==0&&Slots<=16);
enum Header { Schema, Mode, Pending, Overflow, OperationCount, DeadlineLow, DeadlineHigh,
  FirstCause, SelfCause, Undrained, Returned, Destroyed, Sequence, FailureOrder };
enum Field { Ordinal, Size, Immediate, IssueError, Incomplete, ProbeOk, ProbeError, ProbeCount,
  WaitResult, ResultOk, ResultError, ResultCount, Cancelled, CancelOk, CancelError,
  CancelResultOk, CancelResultError, CancelResultCount, Closed, CloseOk, Identity,
  QueryOrder, CancelOrder, CloseOrder };
enum ReadField { ReadIssue=32, ReadPending, ReadQuery, ReadClose, ReadBytes, ReadIdentity,
  ReadBudget, ReadImmediate, ReadIssueError, ReadWait, ReadQueryOk, ReadQueryError,
  ReadCount, ReadCloseError };
Witness* witness=nullptr;
HANDLE writerPipe=nullptr, activeEvent=nullptr;
OVERLAPPED* activeOperation=nullptr;
void* activeBuffer=nullptr;
const std::vector<uint8_t>* writerBytes=nullptr;
DWORD activeSlot=Slots;
LONG load(DWORD& cell) { return InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(&cell),0,0); }
void publish(DWORD& cell,DWORD value) { InterlockedExchange(reinterpret_cast<volatile LONG*>(&cell),static_cast<LONG>(value)); }
[[noreturn]] void fatal(DWORD code) {
  TerminateProcess(GetCurrentProcess(),code);
  for(;;) Sleep(INFINITE); // never unwind a pending connect/read operation on failure
}
DWORD order() { return ++witness->header[Sequence]; }
bool zero(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
  return QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&info,sizeof(info),nullptr)&&info.ActiveProcesses==0;
}
struct Security {
  alignas(8) std::array<uint8_t,256> token{},acl{};
  SECURITY_DESCRIPTOR descriptor{};
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES),&descriptor,FALSE};
  Security() {
    HANDLE processToken=nullptr; DWORD size=0;
    if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&processToken)) fatal(90);
    const BOOL ok=GetTokenInformation(processToken,TokenUser,token.data(),static_cast<DWORD>(token.size()),&size);
    CloseHandle(processToken);
    if(!ok||!InitializeAcl(reinterpret_cast<PACL>(acl.data()),static_cast<DWORD>(acl.size()),ACL_REVISION)||
      !AddAccessAllowedAce(reinterpret_cast<PACL>(acl.data()),ACL_REVISION,GENERIC_ALL,
        reinterpret_cast<TOKEN_USER*>(token.data())->User.Sid)||
      !InitializeSecurityDescriptor(&descriptor,SECURITY_DESCRIPTOR_REVISION)||
      !SetSecurityDescriptorDacl(&descriptor,TRUE,reinterpret_cast<PACL>(acl.data()),FALSE)) fatal(90);
  }
};
std::wstring nonce() {
  std::array<UCHAR,16> random{};
  if(BCryptGenRandom(nullptr,random.data(),static_cast<ULONG>(random.size()),BCRYPT_USE_SYSTEM_PREFERRED_RNG)!=0) fatal(90);
  std::wstring result;
  for(auto byte:random) { result+=L"0123456789abcdef"[byte>>4]; result+=L"0123456789abcdef"[byte&15]; }
  return result;
}
[[noreturn]] void cancelSupervisor(HANDLE pipe,OVERLAPPED& operation) {
  // This operation belongs to the supervisor, not its writer Job. No cleanup by inner Job proof.
  const BOOL cancelled=CancelIoEx(pipe,&operation);
  const DWORD cancelError=cancelled?ERROR_SUCCESS:GetLastError();
  (void)cancelError;
  DWORD count=0; const BOOL completed=GetOverlappedResult(pipe,&operation,&count,FALSE);
  const DWORD error=completed?ERROR_SUCCESS:GetLastError();
  if(completed||wire::terminalIoError(error)) CloseHandle(operation.hEvent);
  fatal(91); // ambiguous completion preserves stack/event/buffer through original supervisor death
}
void connected(HANDLE server,HANDLE& client,const std::wstring& name,Security& security) {
  OVERLAPPED operation{}; operation.hEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);
  if(!operation.hEvent) fatal(91);
  const BOOL immediate=ConnectNamedPipe(server,&operation);
  const DWORD error=immediate?ERROR_SUCCESS:GetLastError();
  if(!immediate&&error!=ERROR_IO_PENDING) fatal(91);
  security.attributes.bInheritHandle=TRUE;
  client=CreateFileW(name.c_str(),GENERIC_WRITE,0,&security.attributes,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr);
  security.attributes.bInheritHandle=FALSE;
  if(client==INVALID_HANDLE_VALUE) cancelSupervisor(server,operation);
  if(!immediate&&WaitForSingleObject(operation.hEvent,2000)!=WAIT_OBJECT_0) cancelSupervisor(server,operation);
  DWORD count=0;
  if(!GetOverlappedResult(server,&operation,&count,FALSE)) cancelSupervisor(server,operation);
  if(!CloseHandle(operation.hEvent)) fatal(91);
}
DWORD drain(HANDLE server,ULONGLONG deadline) {
  std::array<uint8_t,64*1024> buffer{}; DWORD total=0;
  witness->header[ReadIdentity]=1; witness->header[ReadBudget]=1;
  while(total<Bytes) {
    OVERLAPPED operation{}; operation.hEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);
    if(!operation.hEvent) fatal(91);
    const auto originalEvent=operation.hEvent; const auto originalBuffer=buffer.data();
    if(GetTickCount64()>=deadline) { CloseHandle(operation.hEvent); fatal(91); }
    const DWORD requested=(std::min)(static_cast<DWORD>(buffer.size()),Bytes-total);
    const BOOL immediate=ReadFile(server,buffer.data(),requested,nullptr,&operation);
    const DWORD issuedError=immediate?ERROR_SUCCESS:GetLastError();
    ++witness->header[ReadIssue]; witness->header[ReadImmediate]=immediate?1u:0u;
    witness->header[ReadIssueError]=issuedError;
    if(!immediate&&issuedError!=ERROR_IO_PENDING) { CloseHandle(operation.hEvent); fatal(91); }
    if(!immediate) {
      const auto now=GetTickCount64();
      if(now>=deadline) cancelSupervisor(server,operation);
      const DWORD waited=WaitForSingleObject(operation.hEvent,static_cast<DWORD>(deadline-now));
      ++witness->header[ReadPending]; witness->header[ReadWait]=waited;
      if(waited!=WAIT_OBJECT_0) cancelSupervisor(server,operation);
    }
    DWORD count=0; const BOOL completed=GetOverlappedResult(server,&operation,&count,FALSE);
    const DWORD error=completed?ERROR_SUCCESS:GetLastError();
    ++witness->header[ReadQuery]; witness->header[ReadQueryOk]=completed?1u:0u;
    witness->header[ReadQueryError]=error; witness->header[ReadCount]=count;
    if(!completed) { (void)error; cancelSupervisor(server,operation); }
    // Data is inspected only after the original operation's terminal result, within original deadline.
    const BOOL closed=CloseHandle(operation.hEvent); const DWORD closeError=closed?ERROR_SUCCESS:GetLastError();
    witness->header[ReadCloseError]=closeError; if(closed) ++witness->header[ReadClose];
    if(operation.hEvent!=originalEvent||buffer.data()!=originalBuffer) witness->header[ReadIdentity]=0;
    witness->header[ReadBudget]&=GetTickCount64()<deadline?1u:0u;
    if(!closed||!witness->header[ReadBudget]||!count||count>requested) fatal(91);
    for(DWORD i=0;i<count;++i) if(buffer[i]!=0x5a) fatal(91);
    total+=count;
    witness->header[ReadBytes]=total;
  }
  return total;
}
PROCESS_INFORMATION startWriter(HANDLE job,HANDLE pipe,const std::wstring& mapping,DWORD mode) {
  std::array<wchar_t,32768> executable{};
  const DWORD length=GetModuleFileNameW(nullptr,executable.data(),static_cast<DWORD>(executable.size()));
  if(!length||length>=executable.size()) fatal(92);
  std::wstring command=L"\""+std::wstring(executable.data(),length)+L"\" writer "+
    std::to_wstring(mode)+L" "+mapping;
  if(command.size()>=32767) fatal(92);
  HANDLE handles[3]={pipe,GetStdHandle(STD_OUTPUT_HANDLE),GetStdHandle(STD_ERROR_HANDLE)};
  for(auto handle:handles) if(!handle||handle==INVALID_HANDLE_VALUE||
    !SetHandleInformation(handle,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT)) fatal(92);
  SIZE_T size=0; InitializeProcThreadAttributeList(nullptr,2,0,&size);
  if(!size) fatal(92);
  std::vector<uint8_t> storage(size);
  auto list=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if(!InitializeProcThreadAttributeList(list,2,0,&size)||
    !UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,&job,sizeof(job),nullptr,nullptr)||
    !UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,sizeof(handles),nullptr,nullptr)) fatal(92);
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb=sizeof(startup);
  startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput=handles[0];
  startup.StartupInfo.hStdOutput=handles[1]; startup.StartupInfo.hStdError=handles[2]; startup.lpAttributeList=list;
  PROCESS_INFORMATION process{};
  const BOOL created=CreateProcessW(executable.data(),command.data(),nullptr,nullptr,TRUE,
    EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT,nullptr,nullptr,&startup.StartupInfo,&process);
  DeleteProcThreadAttributeList(list);
  if(!created) fatal(92);
  return process;
}
void printFacts(DWORD mode,DWORD code,DWORD bytes) {
  // 256 u32s plus fixed keys: maximum below 4096 bytes, never stream the source/vector/name/handles.
  std::printf("{\"schema\":1,\"mode\":%lu,\"writerExit\":%lu,\"activeProcesses\":0,\"readBytes\":%lu,\"header\":[",mode,code,bytes);
  for(DWORD i=0;i<64;++i) std::printf("%s%lu",i?",":"",witness->header[i]);
  std::printf("],\"operations\":[");
  for(DWORD i=0;i<Slots;++i) {
    std::printf("%s[",i?",":"");
    for(DWORD j=0;j<Fields;++j) std::printf("%s%lu",j?",":"",witness->operations[i][j]);
    std::printf("]");
  }
  std::printf("]}\n");
}
int supervise(DWORD mode) {
  Security security; const auto id=nonce();
  const std::wstring mappingName=L"Local\\opw-"+id, pipeName=L"\\\\.\\pipe\\opw-"+id;
  HANDLE mapping=CreateFileMappingW(INVALID_HANDLE_VALUE,&security.attributes,PAGE_READWRITE,0,sizeof(Witness),mappingName.c_str());
  const DWORD mappingError=mapping?GetLastError():ERROR_INVALID_HANDLE;
  if(!mapping||mappingError==ERROR_ALREADY_EXISTS) fatal(90);
  witness=static_cast<Witness*>(MapViewOfFile(mapping,FILE_MAP_ALL_ACCESS,0,0,sizeof(Witness)));
  if(!witness) fatal(90);
  witness->header[Schema]=1; witness->header[Mode]=mode;
  HANDLE server=CreateNamedPipeW(pipeName.c_str(),PIPE_ACCESS_INBOUND|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,4096,4096,0,&security.attributes);
  if(server==INVALID_HANDLE_VALUE) fatal(90);
  DWORD flags=0,output=0,input=0,instances=0;
  if(!GetNamedPipeInfo(server,&flags,&output,&input,&instances)||flags&PIPE_TYPE_MESSAGE||input>64*1024) fatal(90);
  HANDLE client=INVALID_HANDLE_VALUE; connected(server,client,pipeName,security);
  HANDLE job=CreateJobObjectW(&security.attributes,nullptr);
  if(!job||!SetHandleInformation(job,HANDLE_FLAG_INHERIT,0)) fatal(92);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))) fatal(92);
  auto process=startWriter(job,client,mappingName,mode);
  if(!CloseHandle(client)) fatal(92);
  const auto observedDeadline=GetTickCount64()+8000;
  if(ResumeThread(process.hThread)!=1) fatal(92);
  CloseHandle(process.hThread);
  while(!load(witness->header[Pending])) {
    if(GetTickCount64()>=observedDeadline||WaitForSingleObject(process.hProcess,0)!=WAIT_TIMEOUT) fatal(93);
    Sleep(1);
  }
  const auto deadline=(static_cast<ULONGLONG>(witness->header[DeadlineHigh])<<32)|witness->header[DeadlineLow];
  const DWORD readBytes=mode==0?drain(server,deadline):0;
  const auto now=GetTickCount64();
  if(now>=observedDeadline||WaitForSingleObject(process.hProcess,static_cast<DWORD>(observedDeadline-now))!=WAIT_OBJECT_0) fatal(93);
  DWORD code=0;
  if(!GetExitCodeProcess(process.hProcess,&code)||!CloseHandle(process.hProcess)) fatal(93);
  // Final mutable witness is read only after original death, then fresh zero inner Job accounting.
  while(!zero(job)) { if(GetTickCount64()>=observedDeadline) fatal(93); Sleep(1); }
  if(witness->header[Overflow]||!witness->header[OperationCount]||witness->header[OperationCount]>Slots||
    (mode==0&&code!=0)||(mode==1&&code!=(wire::WriteDeadline|(witness->header[Undrained]?128u:0u)))) fatal(94);
  if(!CloseHandle(job)||!CloseHandle(server)) fatal(94);
  printFacts(mode,code,readBytes);
  if(!UnmapViewOfFile(witness)||!CloseHandle(mapping)) fatal(94);
  return 0;
}
struct BufferLifetime { ~BufferLifetime() { witness->header[Destroyed]=1; } };
int writeFixture(const std::wstring& name,DWORD mode) {
  if(name.size()!=42||name.substr(0,10)!=L"Local\\opw-"||
    name.find_first_not_of(L"0123456789abcdef",10)!=std::wstring::npos) fatal(90);
  HANDLE mapping=OpenFileMappingW(FILE_MAP_ALL_ACCESS,FALSE,name.c_str());
  if(!mapping) fatal(90);
  witness=static_cast<Witness*>(MapViewOfFile(mapping,FILE_MAP_ALL_ACCESS,0,0,sizeof(Witness)));
  if(!witness||witness->header[Schema]!=1||witness->header[Mode]!=mode) fatal(90);
  writerPipe=GetStdHandle(STD_INPUT_HANDLE);
  if(!writerPipe||writerPipe==INVALID_HANDLE_VALUE||!SetHandleInformation(writerPipe,HANDLE_FLAG_INHERIT,0)) fatal(90);
  {
    BufferLifetime lifetime;
    std::vector<uint8_t> bytes(Bytes,0x5a); writerBytes=&bytes;
    wire::writeExact(writerPipe,bytes,GetTickCount64()+5000);
    witness->header[Returned]=1;
  }
  if(!CloseHandle(writerPipe)) fatal(94);
  if(!UnmapViewOfFile(witness)||!CloseHandle(mapping)) fatal(94);
  return 0;
}
} // namespace

void wire::observeTestIo(TestIo step,HANDLE pipe,OVERLAPPED& operation,BOOL result,DWORD error,
  DWORD count,void* buffer,DWORD size,ULONGLONG deadline) noexcept {
  if(!witness) return;
  if(step==TestIo::Issue) {
    activeSlot=witness->header[OperationCount]++;
    if(activeSlot>=Slots) { publish(witness->header[Overflow],1); return; }
    activeOperation=&operation; activeEvent=operation.hEvent; activeBuffer=buffer;
    auto& row=witness->operations[activeSlot]; row[Ordinal]=activeSlot+1; row[Size]=size;
    row[Immediate]=result?1u:0u; row[IssueError]=error;
    row[Identity]=pipe==writerPipe&&buffer==writerBytes->data()+(Bytes-size)?15u:0u;
    if(!result&&error==ERROR_IO_PENDING) {
      DWORD transferred=0; const BOOL completed=GetOverlappedResult(pipe,&operation,&transferred,FALSE);
      const DWORD probeError=completed?ERROR_SUCCESS:GetLastError();
      row[ProbeOk]=completed?1u:0u; row[ProbeError]=probeError; row[ProbeCount]=transferred;
      if(!completed&&probeError==ERROR_IO_INCOMPLETE) {
        row[Incomplete]=1;
        if(!load(witness->header[Pending])) {
          witness->header[DeadlineLow]=static_cast<DWORD>(deadline);
          witness->header[DeadlineHigh]=static_cast<DWORD>(deadline>>32);
          publish(witness->header[Pending],1); // release after immutable deadline/native pending facts
        }
      }
    }
    return;
  }
  if(activeSlot>=Slots) return;
  auto& row=witness->operations[activeSlot];
  if(pipe!=writerPipe||&operation!=activeOperation||operation.hEvent!=activeEvent||
    activeBuffer!=writerBytes->data()+(Bytes-row[Size])) row[Identity]=0;
  if(step==TestIo::Wait) row[WaitResult]=error;
  else if(step==TestIo::Result) { row[ResultOk]=result?1u:0u; row[ResultError]=error; row[ResultCount]=count; row[QueryOrder]=order(); }
  else if(step==TestIo::Cancel) {
    row[Cancelled]=1;
    row[CancelOk]=result?1u:0u; row[CancelError]=error; row[CancelOrder]=order();
  } else if(step==TestIo::CancelResult) {
    row[CancelResultOk]=result?1u:0u; row[CancelResultError]=error;
    row[CancelResultCount]=count; row[QueryOrder]=order();
  } else if(step==TestIo::EventClose) { row[Closed]=1; row[CloseOk]=result?1u:0u; row[CloseOrder]=order(); }
}
void wire::observeTestTerminal(DWORD cause,bool undrained) noexcept {
  if(!witness) return;
  witness->header[SelfCause]=cause; witness->header[Undrained]=undrained?1u:0u;
}
void wire::observeTestFailure(DWORD cause) noexcept {
  if(!witness||witness->header[FirstCause]) return;
  witness->header[FirstCause]=cause; witness->header[FailureOrder]=order();
}
int wmain(int argc,wchar_t** argv) {
  if(argc==2&&std::wstring(argv[1])==L"complete") return supervise(0);
  if(argc==2&&std::wstring(argv[1])==L"deadline") return supervise(1);
  if(argc==4&&std::wstring(argv[1])==L"writer"&&(std::wstring(argv[2])==L"0"||std::wstring(argv[2])==L"1"))
    return writeFixture(argv[3],argv[2][0]==L'1'?1u:0u);
  return 95;
}
