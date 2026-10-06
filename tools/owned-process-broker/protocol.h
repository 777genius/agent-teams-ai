#pragma once
#include <windows.h>
#include <array>
#include <atomic>
#include <algorithm>
#include <cwctype>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace wire {
constexpr uint16_t Version = 1;
constexpr uint32_t LaunchLimit = 1024 * 1024, ControlLimit = 4096;
enum Op : uint16_t { Launch=1, Resume=2, Stop=3, Release=4,
  Prepared=101, Resumed=102, Stopped=103, Released=104, Failed=105, RootExit=106 };
struct Frame { uint16_t op; uint64_t id; std::array<uint8_t,16> generation;
  std::vector<uint8_t> payload; };
template<class T> T get(const uint8_t* p) { T v; std::memcpy(&v,p,sizeof(v)); return v; }
template<class T> void append(std::vector<uint8_t>& out,T v) {
  auto p=reinterpret_cast<const uint8_t*>(&v); out.insert(out.end(),p,p+sizeof(v));
}
// Exit categories carry no launch values. Bit128 means cancellation was not proven drained.
enum Exit : DWORD { OwnerEof=70, Bootstrap=71, ReadFailure=72, WriteFailure=73,
  WriteDeadline=74, ProtocolFailure=75, CancelUndrained=76, PendingReadBarrier=77 };
constexpr DWORD ReleasedTerminal=1;
inline std::atomic<DWORD> terminalChoice{0}; // active -> first failure OR completed-ACK success
#ifdef OWNED_PROCESS_TEST_RELEASE_DELAY
inline bool terminalRaceEnabled=false; // immutable bootstrap value, only in unstaged fixture
inline std::atomic<bool> terminalRaceRejected{false}, terminalRaceObserved{false};
#endif
inline DWORD failureCause() {
  const auto choice=terminalChoice.load(); return choice==ReleasedTerminal?0:choice;
}
inline bool releaseWon() { return terminalChoice.load()==ReleasedTerminal; }
inline bool chooseReleased() {
  DWORD active=0; return terminalChoice.compare_exchange_strong(active,ReleasedTerminal);
}
inline void latchFailure(DWORD cause) {
  DWORD active=0; terminalChoice.compare_exchange_strong(active,cause);
}
[[noreturn]] inline void terminateFailure(DWORD cause,bool undrained=false) {
  latchFailure(cause);
  const auto winner=terminalChoice.load();
  DWORD status=winner;
#ifdef OWNED_PROCESS_TEST_RELEASE_DELAY
  // Complete ACK bytes plus an unrelated early write deadline must not impersonate the CAS gate.
  if(terminalRaceEnabled&&winner==WriteDeadline&&
    (!terminalRaceRejected.load()||!terminalRaceObserved.load())) status=ProtocolFailure;
#endif
  if(winner!=ReleasedTerminal)
    TerminateProcess(GetCurrentProcess(),status|(undrained?128u:0u));
  // A stale failure losing to completed ACK cannot replace its winner; writer owns success exit.
  // Even an unexpectedly failed self-termination cannot unwind live I/O storage.
  for(;;) Sleep(INFINITE);
}
inline bool disconnected(DWORD error) {
  return error==ERROR_BROKEN_PIPE||error==ERROR_PIPE_NOT_CONNECTED;
}
inline bool terminalIoError(DWORD error) {
  return disconnected(error)||error==ERROR_OPERATION_ABORTED;
}
[[noreturn]] inline void cancelAndFail(HANDLE pipe,OVERLAPPED& operation,DWORD cause) {
  latchFailure(cause); // cancellation/late success cannot replace the first terminal cause
  CancelIoEx(pipe,&operation); // ERROR_NOT_FOUND is not completion evidence
  DWORD ignored=0;
  const bool completed=GetOverlappedResult(pipe,&operation,&ignored,FALSE)!=FALSE;
  const DWORD error=completed?ERROR_SUCCESS:GetLastError();
  const bool terminal=completed||terminalIoError(error);
  if(terminal) CloseHandle(operation.hEvent);
  terminateFailure(cause,!terminal);
}
struct Transfer { DWORD count,error; };
inline Transfer transfer(HANDLE pipe,void* data,DWORD size,bool writing,ULONGLONG deadline=0,
  void (*pendingRead)()=nullptr) {
  if(failureCause()) terminateFailure(failureCause());
  OVERLAPPED operation{};
  operation.hEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr); // private manual-reset event per operation
  if(!operation.hEvent) terminateFailure(writing?WriteFailure:ReadFailure);
  const BOOL immediate=writing?WriteFile(pipe,data,size,nullptr,&operation):
    ReadFile(pipe,data,size,nullptr,&operation);
  const DWORD issuedError=immediate?ERROR_SUCCESS:GetLastError();
  if(!immediate&&issuedError!=ERROR_IO_PENDING) {
    CloseHandle(operation.hEvent); return {0,issuedError}; // API rejected; no outstanding request
  }
  if(!immediate) {
    if(!writing&&pendingRead) pendingRead(); // actual ERROR_IO_PENDING, with this read storage alive
    const auto now=GetTickCount64();
    if(deadline&&now>=deadline) cancelAndFail(pipe,operation,WriteDeadline);
    const DWORD budget=deadline?static_cast<DWORD>(deadline-now):INFINITE;
    const DWORD wait=WaitForSingleObject(operation.hEvent,budget);
    if(wait!=WAIT_OBJECT_0) cancelAndFail(pipe,operation,
      wait==WAIT_TIMEOUT?WriteDeadline:CancelUndrained);
  }
  DWORD count=0;
  if(!GetOverlappedResult(pipe,&operation,&count,FALSE)) {
    const DWORD error=GetLastError();
    if(!terminalIoError(error)) cancelAndFail(pipe,operation,CancelUndrained);
    CloseHandle(operation.hEvent); return {0,error};
  }
  CloseHandle(operation.hEvent); // result query proved terminal, never just event signal
  if(deadline&&GetTickCount64()>=deadline) terminateFailure(WriteDeadline);
  if(failureCause()) terminateFailure(failureCause());
  if(count>size) terminateFailure(writing?WriteFailure:ReadFailure);
  return {count,ERROR_SUCCESS};
}
inline bool readExact(HANDLE pipe,void* data,DWORD size,void (*pendingRead)()=nullptr) {
  auto p=static_cast<uint8_t*>(data); bool partial=false;
  while(size) {
    const auto result=transfer(pipe,p,size,false,0,pendingRead);
    if(result.error&&!disconnected(result.error)) terminateFailure(ReadFailure);
    if(result.error||!result.count) {
      if(partial) terminateFailure(ProtocolFailure); // only an untouched next header may end at EOF
      return false;
    }
    p+=result.count; size-=result.count; partial=true;
  }
  return true;
}
inline void writeExact(HANDLE pipe,std::vector<uint8_t>& bytes,ULONGLONG deadline) {
  size_t offset=0;
  while(offset<bytes.size()) {
    if(GetTickCount64()>=deadline) terminateFailure(WriteDeadline);
    const auto result=transfer(pipe,bytes.data()+offset,
      static_cast<DWORD>(bytes.size()-offset),true,deadline);
    if(result.error||!result.count) terminateFailure(WriteFailure);
    offset+=result.count;
  }
}
inline bool read(HANDLE pipe,Frame& frame,void (*pendingRead)()=nullptr) {
  std::array<uint8_t,32> header{};
  if(!readExact(pipe,header.data(),32,pendingRead)) return false;
  uint32_t size=get<uint32_t>(header.data());
  frame.op=get<uint16_t>(header.data()+6);
  if(get<uint16_t>(header.data()+4)!=Version||frame.op<Launch||frame.op>Release||
    size>(frame.op==Launch?LaunchLimit:ControlLimit)) throw std::runtime_error("header");
  frame.id=get<uint64_t>(header.data()+8);
  std::copy(header.begin()+16,header.end(),frame.generation.begin());
  frame.payload.resize(size);
  if(size&&!readExact(pipe,frame.payload.data(),size,pendingRead)) throw std::runtime_error("truncated");
  return true;
}
inline std::vector<uint8_t> encode(const Frame& frame) {
  std::vector<uint8_t> out;
  append(out,static_cast<uint32_t>(frame.payload.size())); append(out,Version);
  append(out,frame.op); append(out,frame.id);
  out.insert(out.end(),frame.generation.begin(),frame.generation.end());
  out.insert(out.end(),frame.payload.begin(),frame.payload.end()); return out;
}
struct LaunchSpec { std::wstring executable,command,cwd; std::vector<wchar_t> env; };
class Cursor {
  const std::vector<uint8_t>& bytes; size_t position=0;
public:
  explicit Cursor(const std::vector<uint8_t>& data):bytes(data){}
  uint32_t integer() { if(position+4>bytes.size()) throw std::runtime_error("length");
    auto v=get<uint32_t>(bytes.data()+position); position+=4; return v; }
  std::wstring text() {
    auto size=integer();
    if(size%2||size>65534||position+size>bytes.size()) throw std::runtime_error("string");
    std::wstring s(size/2,L'\0'); std::memcpy(s.data(),bytes.data()+position,size); position+=size;
    for(size_t i=0;i<s.size();++i) {
      auto c=static_cast<uint16_t>(s[i]); if(!c) throw std::runtime_error("nul");
      if(c>=0xd800&&c<=0xdbff) { if(++i>=s.size()||s[i]<0xdc00||s[i]>0xdfff)
        throw std::runtime_error("surrogate"); }
      else if(c>=0xdc00&&c<=0xdfff) throw std::runtime_error("surrogate");
    } return s;
  }
  void end() { if(position!=bytes.size()) throw std::runtime_error("trailing"); }
};
inline bool absolute(const std::wstring& s) {
  return (s.size()>2&&iswalpha(s[0])&&s[1]==L':'&&s[2]==L'\\')||
    (s.size()>2&&s[0]==L'\\'&&s[1]==L'\\');
}
inline LaunchSpec launch(const std::vector<uint8_t>& payload) {
  Cursor cursor(payload); LaunchSpec s;
  s.executable=cursor.text(); s.command=cursor.text(); s.cwd=cursor.text();
  if(!absolute(s.executable)||!absolute(s.cwd)||s.command.empty()) throw std::runtime_error("path");
  auto count=cursor.integer(); if(count>4096) throw std::runtime_error("environment");
  std::vector<std::wstring> entries;
  for(uint32_t i=0;i<count;++i) {
    auto entry=cursor.text(); auto split=entry.find(L'=');
    if(split==std::wstring::npos||!split) throw std::runtime_error("environment");
    entries.push_back(std::move(entry));
  }
  auto name=[](const std::wstring& e) { return e.substr(0,e.find(L'=')); };
  std::sort(entries.begin(),entries.end(),[&](const auto& a,const auto& b) {
    return CompareStringOrdinal(name(a).c_str(),-1,name(b).c_str(),-1,TRUE)==CSTR_LESS_THAN;
  });
  for(size_t i=0;i<entries.size();++i) {
    if(i&&CompareStringOrdinal(name(entries[i-1]).c_str(),-1,name(entries[i]).c_str(),-1,TRUE)==CSTR_EQUAL)
      throw std::runtime_error("duplicate environment");
    s.env.insert(s.env.end(),entries[i].begin(),entries[i].end()); s.env.push_back(0);
  }
  s.env.push_back(0); if(!count) s.env.push_back(0); cursor.end(); return s;
}
} // namespace wire
