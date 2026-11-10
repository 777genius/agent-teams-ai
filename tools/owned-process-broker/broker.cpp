#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include "protocol.h"
#include <io.h>
#include <fcntl.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <map>
#include <thread>

namespace {
enum Creation : uint8_t { Never=0, Suspended=1, Running=2, Uncertain=3 };
HANDLE control=INVALID_HANDLE_VALUE, job=nullptr, root=nullptr, primaryThread=nullptr;
std::timed_mutex state;
std::mutex repliesMutex;
std::condition_variable repliesReady;
std::deque<wire::Frame> replies;
std::map<uint64_t,wire::Frame> cachedReplies;
std::array<uint8_t,16> generation{};
std::atomic<bool> sealed{false}, launched{false}, admissionDone{false}, stopBusy{false};
std::atomic<bool> releaseAccepted{false};
#ifdef OWNED_PROCESS_TEST_RELEASE_CONTENTION
bool releaseContentionEnabled=false;
std::atomic<bool> releaseContentionRequested{false}, releaseContentionHeld{false};
std::atomic<bool> releaseContentionObserved{false}, releaseContentionFinished{false};
#endif
#ifdef OWNED_PROCESS_TEST_ACCOUNTING_FAILURE
std::atomic<bool> accountingFailurePending{true};
#endif
#ifdef OWNED_PROCESS_TEST_POST_LAUNCH_PENDING_READ
std::atomic<bool> postLaunchReadPending{false};
#endif
Creation creation=Never;
bool birthKnown=false, rootExited=false, rootPublished=false, confirmed=false;
bool targetCopiesClosed=false; // single admission owns CRT copies; state lock required
uint64_t birth=0;
DWORD rootCode=0;
wire::Frame confirmedStop{};

[[noreturn]] void abandon(DWORD cause=wire::ProtocolFailure) {
  sealed=true;
  // Process teardown closes the sole private Job handle even if admission is blocked.
  // This contains; it never manufactures a termination receipt.
  wire::terminateFailure(cause);
}
void reply(uint16_t op,uint64_t id,const std::vector<uint8_t>& payload={}) {
  std::lock_guard<std::mutex> lock(repliesMutex);
  if(replies.size()>=8) abandon();
  if(op==wire::Stopped||op==wire::Released||op==wire::Failed) {
    if(cachedReplies.size()>=66&&!cachedReplies.count(id)) abandon();
    cachedReplies[id]={op,id,generation,payload};
  }
  replies.push_back({op,id,generation,payload}); repliesReady.notify_one();
}
void failure(uint64_t id,Creation fact,DWORD code) {
  std::vector<uint8_t> p; wire::append(p,static_cast<uint8_t>(fact)); wire::append(p,code);
  reply(wire::Failed,id,p);
}
[[noreturn]] void exitReleased() {
  if(!wire::releaseWon()) abandon(wire::failureCause()?wire::failureCause():wire::ProtocolFailure);
#ifdef OWNED_PROCESS_TEST_RELEASE_DELAY
  Sleep(50); // both success paths preserve the fixture's post-ACK delay
#endif
  ExitProcess(0); // immutable CAS winner; no failure can replace it
}
#ifdef OWNED_PROCESS_TEST_RELEASE_DELAY
std::atomic<bool> terminalRaceAckComplete{false}; // private full-ACK fact, never authority
bool terminalRaceFixture() {
  return wire::terminalRaceEnabled;
}
[[noreturn]] void terminalRaceBarrierFailed() {
  // Fixture-only failure status; retain the immutable terminal winner, but never exit74 as proof.
  TerminateProcess(GetCurrentProcess(),wire::ProtocolFailure);
  for(;;) Sleep(INFINITE);
}
#endif
void writer() {
  for(;;) {
    wire::Frame frame;
    { std::unique_lock<std::mutex> lock(repliesMutex);
      repliesReady.wait(lock,[]{return !replies.empty();});
      frame=std::move(replies.front()); replies.pop_front(); }
    auto bytes=wire::encode(frame); const auto deadline=GetTickCount64()+5000;
    wire::writeExact(control,bytes,deadline); // separate OVERLAPPED/event; one whole-frame budget
    if(frame.op==wire::Released) {
#ifdef OWNED_PROCESS_TEST_RELEASE_DELAY
      if(terminalRaceFixture()) {
        terminalRaceAckComplete=true; // only after genuine whole-frame writeExact returned
        const auto barrierDeadline=GetTickCount64()+5000;
        while(!wire::failureCause()&&GetTickCount64()<barrierDeadline) Sleep(1);
        if(wire::failureCause()!=wire::WriteDeadline) terminalRaceBarrierFailed();
      }
#endif
      const bool successWon=wire::chooseReleased();
#ifdef OWNED_PROCESS_TEST_RELEASE_DELAY
      if(terminalRaceFixture()&&!successWon&&wire::failureCause()==wire::WriteDeadline) {
        wire::terminalRaceRejected=true; // set only after the actual success CAS lost to failure
        const auto observedDeadline=GetTickCount64()+5000;
        while(!wire::terminalRaceObserved&&GetTickCount64()<observedDeadline) Sleep(1);
        if(!wire::terminalRaceObserved) terminalRaceBarrierFailed();
      }
#endif
      if(!successWon) abandon(wire::failureCause());
      exitReleased(); // complete in-budget ACK chose success atomically against every failure
    }
  }
}
void observeRoot() { // state lock required; no PID-based reopening
  if(!root||rootExited) return;
  auto status=WaitForSingleObject(root,0);
  if(status==WAIT_FAILED) { sealed=true; return; }
  if(status!=WAIT_OBJECT_0) return;
  DWORD code=0; if(!GetExitCodeProcess(root,&code)) { sealed=true; return; }
  rootExited=true; rootCode=code;
  CloseHandle(root); root=nullptr;
  if(primaryThread) { CloseHandle(primaryThread); primaryThread=nullptr; }
  if(birthKnown&&!rootPublished) {
    rootPublished=true; std::vector<uint8_t> p;
    wire::append(p,rootCode); wire::append(p,birth); reply(wire::RootExit,0,p);
  }
}
void watcher() {
  for(;;) {
    if(state.try_lock()) {
#ifdef OWNED_PROCESS_TEST_RELEASE_CONTENTION
      if(releaseContentionRequested.exchange(false)) {
        releaseContentionHeld=true; // this watcher actually owns the original state mutex
        const auto deadline=GetTickCount64()+5000;
        while(!releaseContentionObserved&&GetTickCount64()<deadline) Sleep(1);
        if(!releaseContentionObserved) abandon();
        Sleep(25); // bounded contention, only after the actual failed lock probe
        releaseContentionFinished=true;
      }
#endif
      observeRoot();
      state.unlock();
    }
    Sleep(10);
  }
}
void closeTargetCopies() {
  if(targetCopiesClosed) return;
  targetCopiesClosed=true; // claim before closing; later failure cleanup must not close reused fds
  // CRT owns fd0-2. _close closes its OS handle too; do not CloseHandle it again.
  _close(0); _close(1); _close(2);
  SetStdHandle(STD_INPUT_HANDLE,nullptr); SetStdHandle(STD_OUTPUT_HANDLE,nullptr);
  SetStdHandle(STD_ERROR_HANDLE,nullptr);
}
void pendingReadObserved() {
#ifdef OWNED_PROCESS_TEST_POST_LAUNCH_PENDING_READ
  if(launched.load()) postLaunchReadPending=true;
#endif
}
void admit(wire::Frame frame) {
#ifdef OWNED_PROCESS_TEST_POST_LAUNCH_PENDING_READ
  const auto barrierDeadline=GetTickCount64()+5000;
  while(!postLaunchReadPending.load()&&GetTickCount64()<barrierDeadline) Sleep(1);
  if(!postLaunchReadPending.load()) abandon(wire::PendingReadBarrier);
#endif
  std::unique_lock<std::timed_mutex> lock(state);
  if(sealed) { admissionDone=true; closeTargetCopies(); failure(frame.id,Never,ERROR_CANCELLED); return; }
  try {
    auto spec=wire::launch(frame.payload);
    job=CreateJobObjectW(nullptr,nullptr);
    if(!job) throw GetLastError();
    if(!SetHandleInformation(job,HANDLE_FLAG_INHERIT,0)) throw GetLastError();
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))
      throw GetLastError();
    HANDLE inherited[3]={reinterpret_cast<HANDLE>(_get_osfhandle(0)),
      reinterpret_cast<HANDLE>(_get_osfhandle(1)),reinterpret_cast<HANDLE>(_get_osfhandle(2))};
    for(auto h:inherited) {
      if(h==INVALID_HANDLE_VALUE||!h||!SetHandleInformation(h,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT))
        throw GetLastError();
    }
    SIZE_T attributeSize=0;
    InitializeProcThreadAttributeList(nullptr,2,0,&attributeSize);
    if(!attributeSize) throw GetLastError();
    std::vector<uint8_t> attributes(attributeSize);
    auto list=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
    if(!InitializeProcThreadAttributeList(list,2,0,&attributeSize)) throw GetLastError();
    bool attributesOk=UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,
      &job,sizeof(job),nullptr,nullptr)&&UpdateProcThreadAttribute(list,0,
      PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited),nullptr,nullptr);
    if(!attributesOk) { auto error=GetLastError(); DeleteProcThreadAttributeList(list); throw error; }
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb=sizeof(startup);
    startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput=inherited[0]; startup.StartupInfo.hStdOutput=inherited[1];
    startup.StartupInfo.hStdError=inherited[2]; startup.lpAttributeList=list;
    PROCESS_INFORMATION process{};
    BOOL ok=FALSE; DWORD error=ERROR_CANCELLED;
    if(!sealed) {
      creation=Uncertain; // any interrupted admission is uncertain until positively returned
      ok=CreateProcessW(spec.executable.c_str(),spec.command.data(),nullptr,nullptr,TRUE,
        EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW,
        spec.env.data(),spec.cwd.c_str(),&startup.StartupInfo,&process);
      error=GetLastError();
    }
    DeleteProcThreadAttributeList(list);
    closeTargetCopies();
    if(!ok) { creation=Never; throw error; }
    root=process.hProcess; primaryThread=process.hThread; creation=Suspended;
#ifdef OWNED_PROCESS_TEST_BIRTH_FAILURE
    throw DWORD{ERROR_GEN_FAILURE}; // separate test-only binary; never staged as capability
#endif
    FILETIME created{},exit{},kernel{},user{};
    if(!GetProcessTimes(root,&created,&exit,&kernel,&user)) throw GetLastError();
    birth=(static_cast<uint64_t>(created.dwHighDateTime)<<32)|created.dwLowDateTime;
    birthKnown=true; admissionDone=true;
    std::vector<uint8_t> p; wire::append(p,process.dwProcessId); wire::append(p,birth);
    reply(wire::Prepared,frame.id,p);
  } catch(DWORD error) {
    admissionDone=true; closeTargetCopies(); failure(frame.id,creation,error);
  } catch(...) {
    admissionDone=true; closeTargetCopies(); failure(frame.id,creation,ERROR_INVALID_DATA);
  }
}
std::vector<uint8_t> stopFacts(DWORD active,DWORD dispatchError,DWORD queryError) {
  std::vector<uint8_t> p; wire::append(p,static_cast<uint8_t>(creation));
  wire::append(p,static_cast<uint8_t>(rootExited&&birthKnown));
  wire::append(p,active); wire::append(p,rootCode); wire::append(p,birth);
  wire::append(p,dispatchError); wire::append(p,queryError); return p;
}
void stop(wire::Frame frame) {
  const auto budget=wire::get<uint32_t>(frame.payload.data());
  auto deadline=GetTickCount64()+budget;
  DWORD active=MAXDWORD,dispatchError=0,queryError=0;
  bool dispatched=false;
  while(GetTickCount64()<deadline) {
    if(state.try_lock_for(std::chrono::milliseconds(5))) {
      std::unique_lock<std::timed_mutex> lock(state,std::adopt_lock);
      if(confirmed) { auto p=confirmedStop.payload; lock.unlock(); stopBusy=false;
        reply(wire::Stopped,frame.id,p); return; }
      if(!launched||admissionDone) {
        if(creation==Never) {
          active=0; auto p=stopFacts(active,0,0); confirmed=true;
          confirmedStop={wire::Stopped,frame.id,generation,p}; lock.unlock(); stopBusy=false;
          reply(wire::Stopped,frame.id,p); return;
        }
        observeRoot();
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
        bool queried=job&&QueryInformationJobObject(job,JobObjectBasicAccountingInformation,
          &accounting,sizeof(accounting),nullptr);
        DWORD queryFailure=queried?0:(job?GetLastError():ERROR_INVALID_HANDLE);
#ifdef OWNED_PROCESS_TEST_ACCOUNTING_FAILURE
        if(accountingFailurePending.exchange(false)) { queried=false; queryFailure=ERROR_GEN_FAILURE; }
#endif
        if(!queried) { if(!queryError) queryError=queryFailure?queryFailure:ERROR_GEN_FAILURE; }
        else active=accounting.ActiveProcesses; // a successful observation cannot erase this attempt's failure
        if(active==0&&rootExited&&birthKnown) {
          auto p=stopFacts(active,dispatchError,queryError);
          if(!queryError&&!dispatchError) { confirmed=true; confirmedStop={wire::Stopped,frame.id,generation,p}; }
          lock.unlock(); stopBusy=false; reply(wire::Stopped,frame.id,p); return;
        }
        if(job&&!dispatched&&(active!=0||queryError)) {
          if(!TerminateJobObject(job,1)) dispatchError=GetLastError();
          dispatched=true; // API failure remains latched unknown for this attempt
        }
      }
    }
    Sleep(5);
  }
  // Never wait indefinitely on a CreateProcess call holding the state lock.
  if(state.try_lock()) {
    auto p=stopFacts(active,dispatchError,queryError?queryError:WAIT_TIMEOUT);
    state.unlock(); stopBusy=false; reply(wire::Stopped,frame.id,p);
  } else {
    std::vector<uint8_t> p; wire::append(p,static_cast<uint8_t>(Uncertain)); wire::append(p,uint8_t{0});
    wire::append(p,MAXDWORD); wire::append(p,DWORD{0}); wire::append(p,uint64_t{0});
    wire::append(p,DWORD{0}); wire::append(p,DWORD{WAIT_TIMEOUT}); stopBusy=false; reply(wire::Stopped,frame.id,p);
  }
}
} // namespace

int main() {
  control=reinterpret_cast<HANDLE>(_get_osfhandle(3));
  if(control==INVALID_HANDLE_VALUE||!control||!SetHandleInformation(control,HANDLE_FLAG_INHERIT,0)) return wire::Bootstrap;
#ifdef OWNED_PROCESS_TEST_RELEASE_DELAY
  wchar_t flag[2]{};
  wire::terminalRaceEnabled=GetEnvironmentVariableW(L"OWNED_PROCESS_TEST_TERMINAL_RACE",flag,2)==1&&flag[0]==L'1';
#endif
#ifdef OWNED_PROCESS_TEST_RELEASE_CONTENTION
  wchar_t contentionFlag[2]{};
  releaseContentionEnabled=GetEnvironmentVariableW(L"OWNED_PROCESS_TEST_RELEASE_CONTENTION",contentionFlag,2)==1&&contentionFlag[0]==L'1';
#endif
  std::thread(writer).detach(); std::thread(watcher).detach();
  uint64_t lastId=0; bool bound=false; size_t frames=0;
  std::map<uint64_t,wire::Frame> idempotentRequests;
  try {
    wire::Frame frame;
    while(wire::read(control,frame,pendingReadObserved)) {
      if(++frames>1024||!frame.id) abandon();
      if(!bound) { generation=frame.generation; bound=true; }
      if(frame.generation!=generation) abandon();
      if(frame.id<=lastId) {
        auto previous=idempotentRequests.find(frame.id);
        if(previous==idempotentRequests.end()||previous->second.op!=frame.op||
          previous->second.payload!=frame.payload) abandon();
        std::lock_guard<std::mutex> lock(repliesMutex);
        auto cached=cachedReplies.find(frame.id);
        if(cached!=cachedReplies.end()) {
          if(replies.size()>=8) abandon();
          replies.push_back(cached->second); repliesReady.notify_one();
        }
        continue; // identical in-flight duplicate does not redispatch
      }
      lastId=frame.id;
      if(frame.op==wire::Stop||frame.op==wire::Release) {
        if(idempotentRequests.size()>=65) abandon();
        idempotentRequests.emplace(frame.id,frame);
      }
      if(frame.op==wire::Launch) {
        if(launched.exchange(true)) abandon();
        std::thread(admit,std::move(frame)).detach();
      } else if(frame.op==wire::Stop) {
        sealed=true; // before state lock / stalled admission / any asynchronous wait
        if(frame.payload.size()!=5||frame.payload[4]!=1||wire::get<uint32_t>(frame.payload.data())>60000)
          abandon();
        if(stopBusy.exchange(true)) abandon();
        std::thread(stop,std::move(frame)).detach();
      } else if(frame.op==wire::Resume) {
        if(!frame.payload.empty()||!state.try_lock_for(std::chrono::milliseconds(100))) abandon();
        std::unique_lock<std::timed_mutex> lock(state,std::adopt_lock);
        if(sealed||creation!=Suspended||!birthKnown||!primaryThread) {
          failure(frame.id,creation,ERROR_CANCELLED); continue;
        }
        if(ResumeThread(primaryThread)==MAXDWORD) { sealed=true; failure(frame.id,creation,GetLastError()); continue; }
        CloseHandle(primaryThread); primaryThread=nullptr; creation=Running;
        reply(wire::Resumed,frame.id);
      } else if(frame.op==wire::Release) {
        if(!frame.payload.empty()) abandon();
#ifdef OWNED_PROCESS_TEST_RELEASE_CONTENTION
        if(releaseContentionEnabled) {
          releaseContentionRequested=true;
          const auto deadline=GetTickCount64()+5000;
          while(!releaseContentionHeld&&GetTickCount64()<deadline) Sleep(1);
          if(!releaseContentionHeld) abandon();
          if(state.try_lock()) { state.unlock(); abandon(); }
          releaseContentionObserved=true; // contention was observed, not inferred from a delay
        }
#endif
        // Same bounded command-state budget as Resume; a watcher may briefly own this lock.
        if(!state.try_lock_for(std::chrono::milliseconds(100))) abandon();
        std::unique_lock<std::timed_mutex> lock(state,std::adopt_lock);
        if(!confirmed||stopBusy) { failure(frame.id,creation,ERROR_INVALID_STATE); continue; }
        if(job&&!CloseHandle(job)) { failure(frame.id,creation,GetLastError()); continue; }
        job=nullptr; releaseAccepted=true;
        std::vector<uint8_t> releasedFacts;
#ifdef OWNED_PROCESS_TEST_RELEASE_CONTENTION
        if(releaseContentionEnabled) {
          wire::append(releasedFacts,static_cast<uint8_t>(releaseContentionHeld.load()));
          wire::append(releasedFacts,static_cast<uint8_t>(releaseContentionObserved.load()));
          wire::append(releasedFacts,static_cast<uint8_t>(releaseContentionFinished.load()));
        }
#endif
        reply(wire::Released,frame.id,releasedFacts);
        break; // this command read completed; do not issue another read after accepted Release
      } else abandon();
    }
  } catch(...) { abandon(); }
  if(releaseAccepted) {
    const auto deadline=GetTickCount64()+5000;
#ifdef OWNED_PROCESS_TEST_RELEASE_DELAY
    if(terminalRaceFixture()) {
      while(!terminalRaceAckComplete&&!wire::failureCause()&&GetTickCount64()<deadline) Sleep(1);
      if(!terminalRaceAckComplete||GetTickCount64()>=deadline) terminalRaceBarrierFailed();
      DWORD active=0;
      if(!wire::terminalChoice.compare_exchange_strong(active,wire::WriteDeadline))
        terminalRaceBarrierFailed(); // this main thread must actually win the first-failure CAS
      while(!wire::terminalRaceRejected&&GetTickCount64()<deadline) Sleep(1);
      if(!wire::terminalRaceRejected||GetTickCount64()>=deadline) terminalRaceBarrierFailed();
      wire::terminalRaceObserved=true; // exit74 is now permitted: actual losing CAS was observed
    } else
#endif
    {
      while(!wire::releaseWon()&&!wire::failureCause()&&GetTickCount64()<deadline) Sleep(1);
      if(wire::releaseWon()) exitReleased();
    }
  }
  abandon(releaseAccepted?wire::WriteDeadline:wire::OwnerEof); // no receipt from pre-release EOF
}
