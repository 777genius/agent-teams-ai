import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { observerFailureReceipt } from './windows-observer-receipt.mts';
import type { ObserverFailurePhase } from './windows-observer-receipt.mts';

import { ownerCimTicks } from './windows-owned-uia-metadata.mts';

import {
  selectedWindowsPowerShell,
  windowsShellCompilerReferences,
  windowsShellTestEnvironment,
} from './windows-powershell.mts';

import type { ChildProcess } from 'node:child_process';
import type { WindowsProcess, windowsNative } from './windows-native.mts';
import type { HeldFocusOwner } from './windows-owned-uia-metadata.mts';

export { assertOwnedUiaMetadata } from './windows-owned-uia-metadata.mts';
export type { OwnedUiaMetadata } from './windows-owned-uia-metadata.mts';

export function observeInstallerChild(
  child: ChildProcess,
  executable: string,
  native: Pick<Awaited<ReturnType<typeof windowsNative>>, 'processes' | 'installerLineage'>,
  save: (receipt: unknown) => Promise<void>,
  spawnEnv?: NodeJS.ProcessEnv
) {
  const receipt = {
    scope: 'Read-only NSIS spawn and one25second lineage; no process adoption',
    qualifying: false,
    executable,
    events: [] as object[],
    identity: null as Omit<WindowsProcess, 'command'> | null,
    lineage: null as unknown,
    diagnosticError: null as string | null,
    persistenceError: null as string | null,
    closeObserved: false,
  };
  let timer: ReturnType<typeof setTimeout> | undefined,
    ended = false;
  let pending = Promise.resolve(),
    writes = Promise.resolve();
  const record = (event: string, details: object = {}) => {
    receipt.events.push({ event, at: new Date().toISOString(), ...details });
    writes = writes
      .then(() => save(receipt))
      .catch((error: unknown) => {
        receipt.persistenceError = String(error);
      });
  };
  child.once('spawn', () => {
    const pid = child.pid;
    record('spawn', { pid });
    pending = native
      .processes(executable)
      .then((owners) => {
        const owner = owners.find((item) => item.pid === pid);
        if (owner) {
          receipt.identity = {
            pid: owner.pid,
            parent: owner.parent,
            executable: owner.executable,
            start: owner.start,
            sid: owner.sid,
            session: owner.session,
          };
        }
        record('identity', { available: receipt.identity !== null });
      })
      .catch((error: unknown) => {
        receipt.diagnosticError = String(error);
        record('identity-unavailable');
      });
    timer = setTimeout(() => {
      pending = pending
        .then(async () => {
          if (ended || !receipt.identity) return;
          receipt.lineage = await native.installerLineage(receipt.identity, spawnEnv);
          record('lineage-at25s');
        })
        .catch((error: unknown) => {
          receipt.diagnosticError = String(error);
          record('lineage-unavailable');
        });
    }, 25_000);
  });
  child.once('error', (error) => {
    ended = true;
    clearTimeout(timer);
    record('error', { error: String(error) });
  });
  child.once('exit', (code, signal) => {
    ended = true;
    clearTimeout(timer);
    record('exit', { code, signal });
  });
  child.once('close', (code, signal) => {
    receipt.closeObserved = true;
    record('close', { code, signal });
  });
  return async () => {
    clearTimeout(timer);
    await pending;
    // Exit is decisive; pipe closure may follow later and must not extend the installer deadline.
    record('observation-finalized', { closeObserved: receipt.closeObserved });
    await writes;
  };
}

export interface NativeNames {
  Names: string[];
  Error: string | null;
  HResult: number;
  Visited: number;
  RootChildren: number;
  MaxDepth: number;
  Characters: number;
  ProcessIds: number[];
  RootHwnd: string;
  RootPid: number;
  RootThread: number;
}
export function assertNativeNames(ownerPid: number, hwnd: string, observation: NativeNames) {
  assert.equal(observation.Error, null, observation.Error ?? 'Native UIA error');
  assert.equal(observation.HResult, 0);
  assert.equal(observation.RootPid, ownerPid);
  assert.equal(observation.RootHwnd, hwnd);
  assert(Number.isInteger(observation.RootThread) && observation.RootThread > 0);
  assert(
    Number.isInteger(observation.Visited) &&
      observation.Visited > 0 &&
      observation.Visited <= 20_000
  );
  assert(
    Number.isInteger(observation.MaxDepth) &&
      observation.MaxDepth >= 0 &&
      observation.MaxDepth <= 64
  );
  assert(observation.RootChildren >= 0 && observation.RootChildren < observation.Visited);
  assert(observation.Characters >= 0 && observation.Characters <= 1_000_000);
  assert(observation.Names.length <= observation.Visited);
  assert(observation.Names.every((name) => typeof name === 'string' && name.length <= 4096));
  assert(observation.ProcessIds.length <= observation.Visited);
  assert(observation.ProcessIds.every((pid) => Number.isInteger(pid) && pid > 0));
}
export interface NativeRootFocus extends NativeNames {
  Focus: {
    Before: HeldFocusOwner;
    After: HeldFocusOwner;
    Focusable: boolean;
    Requested: boolean;
    Synchronized: boolean;
    SetFocusHResult: number | null;
    CimTicks: string;
    ForegroundHwnd: string;
    ComparisonResolution100nsTicks: number;
  };
}
export function assertNativeRootFocus(
  owner: Omit<WindowsProcess, 'command'>,
  hwnd: string,
  caption: {
    pid: number;
    hwnd: string;
    thread: number;
    sent: number;
    error: number;
    restored: boolean;
    restorationError: string | null;
  },
  observation: NativeRootFocus
) {
  assert.equal(caption.pid, owner.pid);
  assert.equal(caption.hwnd, hwnd);
  assert.equal(caption.sent, 0, 'No UIA retry after actual/partial input');
  assert.equal(caption.error, 0);
  assert.equal(caption.restored, true);
  assert.equal(caption.restorationError, null);
  assert.equal(observation.Error, null);
  assert.equal(observation.HResult, 0);
  assert.equal(observation.RootHwnd, hwnd);
  assert.equal(observation.RootPid, owner.pid);
  assert.equal(observation.RootThread, caption.thread);
  assert(Number.isInteger(caption.thread) && caption.thread > 0);
  assert.equal(observation.Visited, 0, 'SetFocus observes only the exact root');
  assert.deepEqual(observation.Names, []);
  assert.deepEqual(observation.ProcessIds, []);
  const proof = observation.Focus;
  assert.equal(typeof proof.Focusable, 'boolean');
  assert.equal(proof.Requested, true);
  assert.equal(proof.SetFocusHResult, 0);
  assert.equal(proof.Synchronized, true);
  assert.equal(proof.ForegroundHwnd, hwnd, 'S_OK is insufficient without owned foreground');
  assert.equal(proof.ComparisonResolution100nsTicks, 10);
  assert.deepEqual(proof.Before, proof.After, 'Held exact raw identity must remain unchanged');
  assert.equal(proof.Before.Pid, owner.pid);
  assert.equal(proof.Before.Executable.toLowerCase(), owner.executable.toLowerCase());
  assert.equal(proof.Before.Sid, owner.sid);
  assert.equal(proof.Before.Session, owner.session);
  const cimTicks = ownerCimTicks(owner.start);
  assert.equal(proof.CimTicks, cimTicks.toString());
  assert(/^\d+$/.test(proof.Before.BirthFileTime));
  // FILETIME starts1601, DateTime ticks start0001; compare only CIM's documented microsecond.
  assert.equal(
    BigInt(proof.Before.BirthFileTime) / 10n,
    (cimTicks - 504_911_232_000_000_000n) / 10n
  );
}

export const windowsUiaSource = String.raw`
// Exact IUnknown prefixes from Microsoft's UIAutomationClient.h; unused slots are never called.
[ComImport,Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface TestAutomation {
  void CompareElements(); void CompareRuntimeIds(); void GetRootElement();
  [PreserveSig] int ElementFromHandle(IntPtr hwnd,out TestElement element);
  void ElementFromPoint(); void GetFocusedElement(); void GetRootElementBuildCache();
  void ElementFromHandleBuildCache(); void ElementFromPointBuildCache(); void GetFocusedElementBuildCache();
  void CreateTreeWalker(); void ControlViewWalker(); void ContentViewWalker();
  [PreserveSig] int RawViewWalker(out TestWalker walker);
}
[ComImport,Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface TestElement {
  [PreserveSig] int SetFocus(); void GetRuntimeId(); void FindFirst(); void FindAll();
  void FindFirstBuildCache(); void FindAllBuildCache(); void BuildUpdatedCache();
  [PreserveSig] int GetCurrentPropertyValue(int id,[MarshalAs(UnmanagedType.Struct)] out object value);
}
[ComImport,Guid("4042c624-389c-4afc-a630-9df854a541fc"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface TestWalker {
  void GetParentElement();
  [PreserveSig] int FirstChild(TestElement element,out TestElement child);
  void GetLastChildElement();
  [PreserveSig] int NextSibling(TestElement element,out TestElement sibling);
}
public static class TestOtaObserver {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string file,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle file,StringBuilder path,uint count,uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
  [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved,uint flags);
  [DllImport("ole32.dll")] static extern void CoUninitialize();
  public static string Canonical(string file) {
    using(SafeFileHandle handle=CreateFile(file,0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero)) {
      if(handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      StringBuilder result=new StringBuilder(32768);
      uint size=GetFinalPathNameByHandle(handle,result,(uint)result.Capacity,0);
      if(size==0 || size>=result.Capacity) throw new Exception("Cannot resolve actual installed file");
      string value=result.ToString();
      if(value.StartsWith(@"\\?\")) value=value.Substring(4);
      if(value.StartsWith("UNC",StringComparison.OrdinalIgnoreCase)) throw new Exception("TEST files must be local");
      return value;
    }
  }
  public sealed class Observation {
    public string[] Names=new string[0]; public string Error;
    public int HResult,Visited,RootChildren,MaxDepth,Characters;
    public int[] ProcessIds=new int[0]; public string RootHwnd; public uint RootPid,RootThread;
    public FocusObservation Focus;
    public MetadataObservation Metadata; public ForegroundObservation Foreground;
  }
  static object Property(TestElement element,int id) {
    object value; Marshal.ThrowExceptionForHR(element.GetCurrentPropertyValue(id,out value)); return value;
  }
  static IntPtr ElementHandle(TestElement element) {
    return new IntPtr(unchecked((long)(uint)Convert.ToInt32(Property(element,30020))));
  }
  static void RootOwner(IntPtr hwnd,uint pid,uint thread) {
    uint actual; uint current=GetWindowThreadProcessId(hwnd,out actual);
    if(actual!=pid || current==0 || (thread!=0 && current!=thread)) throw new Exception("Native UIA HWND identity changed");
  }
  static void Walk(TestElement element,TestWalker walker,IntPtr window,List<string> names,HashSet<int> pids,Observation result,int depth) {
    if(depth>64 || ++result.Visited>20000) throw new Exception("Native UIA subtree exceeds observer bounds");
    result.MaxDepth=Math.Max(result.MaxDepth,depth);
    IntPtr handle=ElementHandle(element);
    if(handle!=IntPtr.Zero && GetAncestor(handle,2)!=window) throw new Exception("Native UIA element outside owned HWND root");
    pids.Add(Convert.ToInt32(Property(element,30002)));
    string name=Property(element,30005) as string;
    if(name!=null) {
      result.Characters+=name.Length;
      if(name.Length>4096 || result.Characters>1000000) throw new Exception("Native UIA name budget exceeded");
      if(!String.IsNullOrWhiteSpace(name)) names.Add(name);
    }
    TestElement child=null;
    try {
      Marshal.ThrowExceptionForHR(walker.FirstChild(element,out child));
      while(child!=null) {
        if(depth==0) result.RootChildren++;
        Walk(child,walker,window,names,pids,result,depth+1);
        TestElement next=null;
        try { Marshal.ThrowExceptionForHR(walker.NextSibling(child,out next)); }
        catch { if(next!=null) Marshal.ReleaseComObject(next); throw; }
        Marshal.ReleaseComObject(child); child=next;
      }
    } finally { if(child!=null) Marshal.ReleaseComObject(child); }
  }
  static void Release(object value,Observation result) {
    if(value==null) return;
    try { Marshal.ReleaseComObject(value); }
    catch(Exception error) { if(result.Error==null) { result.Error=error.Message; result.HResult=error.HResult; } }
  }
  static Observation Observe(IntPtr window,uint pid,bool compileOnly,FocusRequest focus=null,bool metadata=false,PinnedMetadataOwner[] pins=null,MetadataPins lifetime=null) {
    Observation result=new Observation { RootHwnd=window.ToInt64().ToString("x"),RootPid=pid,Focus=focus==null || metadata?null:new FocusObservation() };
    Exception failure=null;
    Thread worker=new Thread(()=> {
      TestAutomation automation=null; TestWalker walker=null; TestElement root=null;
      bool initialized=false; List<string> names=new List<string>(); HashSet<int> pids=new HashSet<int>();
      try {
        Marshal.ThrowExceptionForHR(CoInitializeEx(IntPtr.Zero,0)); initialized=true;
        automation=(TestAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e"),true));
        Marshal.ThrowExceptionForHR(automation.RawViewWalker(out walker));
        if(walker==null) throw new Exception("Native UIA RawViewWalker unavailable");
        if(!compileOnly) {
          uint actual; result.RootThread=GetWindowThreadProcessId(window,out actual);
          RootOwner(window,pid,result.RootThread);
          if(focus!=null && result.RootThread!=focus.Thread) throw new Exception("UIA focus root thread changed");
          Marshal.ThrowExceptionForHR(automation.ElementFromHandle(window,out root));
          if(root==null || Convert.ToInt32(Property(root,30002))!=pid || ElementHandle(root)!=window) throw new Exception("Native UIA root HWND/PID mismatch");
          if(focus==null) Walk(root,walker,window,names,pids,result,0);
          else if(metadata) InspectRoot(root,walker,window,pid,focus,result,pins);
          else FocusRoot(root,window,pid,focus,result);
          if(Convert.ToInt32(Property(root,30002))!=pid || ElementHandle(root)!=window) throw new Exception("Native UIA root changed after traversal");
          RootOwner(window,pid,result.RootThread);
        }
      } catch(Exception error) { failure=error; result.Error=error.Message; result.HResult=error.HResult; }
      finally { try {
        result.Names=names.ToArray(); result.ProcessIds=new List<int>(pids).ToArray();
        Release(root,result); Release(walker,result); Release(automation,result);
        if(initialized) CoUninitialize();
        if(result.Metadata!=null && result.Error!=null) { result.Metadata.Error=result.Error; result.Metadata.Complete=false; }
      } finally { if(lifetime!=null) lifetime.WorkerFinished(); } }
    });
    worker.IsBackground=true; worker.SetApartmentState(ApartmentState.MTA); worker.Start();
    if(!worker.Join(15000)) { if(lifetime!=null) lifetime.Transfer(); throw new Exception("Native UIA MTA observation exceeded15seconds"); }
    if(compileOnly && result.Error!=null) throw new Exception(result.Error,failure);
    return result;
  }
    [DllImport("kernel32.dll",SetLastError=true)] static extern SafeProcessHandle OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(SafeProcessHandle process,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(SafeProcessHandle process,uint flags,StringBuilder image,ref int size);
  [DllImport("kernel32.dll")] static extern uint GetProcessId(SafeProcessHandle process);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(SafeProcessHandle process,uint milliseconds);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(SafeProcessHandle process,uint access,out SafeAccessTokenHandle token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(SafeAccessTokenHandle token,int kind,out int session,int size,out int needed);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint message,UIntPtr wParam,IntPtr lParam,uint flags,uint timeout,out UIntPtr result);
  public sealed class FocusRequest { public string Executable,Sid; public int Session; public long CimTicks; public uint Thread,Pid,ParentPid; }
  public sealed class HeldOwner { public uint Pid; public string Executable,Sid,BirthFileTime; public int Session; }
  public sealed class FocusObservation {
    public HeldOwner Before,After; public bool Focusable,Requested,Synchronized;
    public int? SetFocusHResult; public string CimTicks,ForegroundHwnd;
    public int ComparisonResolution100nsTicks=10;
  }
  static HeldOwner ReadHeld(SafeProcessHandle handle,uint pid,FocusRequest expected) {
    if(handle.IsInvalid || WaitForSingleObject(handle,0)!=0x102 || GetProcessId(handle)!=pid) throw new Exception("Held owned process unavailable");
    long birth,exit,kernel,user; int size=32768; StringBuilder image=new StringBuilder(size);
    if(!GetProcessTimes(handle,out birth,out exit,out kernel,out user) || !QueryFullProcessImageName(handle,0,image,ref size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    SafeAccessTokenHandle token;
    if(!OpenProcessToken(handle,8,out token)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    string sid; int session,needed;
    using(token) using(System.Security.Principal.WindowsIdentity identity=new System.Security.Principal.WindowsIdentity(token.DangerousGetHandle())) {
      if(identity.User==null || !GetTokenInformation(token,12,out session,4,out needed) || needed!=4) throw new Exception("Held process token identity unavailable");
      sid=identity.User.Value;
    }
    // CIM_DATETIME carries six microsecond digits; held-handle raw100ns birth stays exact before/after.
    if(String.IsNullOrEmpty(image.ToString()) || (expected!=null && (!String.Equals(image.ToString(),expected.Executable,StringComparison.OrdinalIgnoreCase) || sid!=expected.Sid || session!=expected.Session || DateTime.FromFileTimeUtc(birth).Ticks/10!=expected.CimTicks/10))) throw new Exception("Held process identity differs from fresh CIM owner");
    return new HeldOwner { Pid=pid,Executable=image.ToString(),Sid=sid,Session=session,BirthFileTime=birth.ToString(System.Globalization.CultureInfo.InvariantCulture) };
  }
  static void FocusRoot(TestElement root,IntPtr window,uint pid,FocusRequest expected,Observation result) {
    using(SafeProcessHandle handle=OpenProcess(0x100000|0x1000,false,pid)) {
      FocusObservation proof=result.Focus; proof.CimTicks=expected.CimTicks.ToString(System.Globalization.CultureInfo.InvariantCulture);
      proof.Before=ReadHeld(handle,pid,expected); RootOwner(window,pid,expected.Thread);
      if(ElementHandle(root)!=window || Convert.ToInt32(Property(root,30002))!=pid) throw new Exception("Root-only UIA focus identity changed");
      object focusable=Property(root,30009); proof.Focusable=focusable is bool && (bool)focusable;
      // Native SetFocus has no advertised capability precondition; retain the observed value.
      HeldOwner immediate=ReadHeld(handle,pid,expected);
      if(immediate.BirthFileTime!=proof.Before.BirthFileTime) throw new Exception("Held creation changed before SetFocus");
      RootOwner(window,pid,expected.Thread); proof.Requested=true; proof.SetFocusHResult=root.SetFocus();
      Marshal.ThrowExceptionForHR(proof.SetFocusHResult.Value);
      if(proof.SetFocusHResult!=0) throw new Exception("Owned root SetFocus did not return S_OK");
      proof.After=ReadHeld(handle,pid,expected); RootOwner(window,pid,expected.Thread);
      if(proof.After.BirthFileTime!=proof.Before.BirthFileTime || ElementHandle(root)!=window || Convert.ToInt32(Property(root,30002))!=pid) throw new Exception("Owned identity changed after root SetFocus");
      proof.ForegroundHwnd=GetForegroundWindow().ToInt64().ToString("x"); UIntPtr ignored;
      if(GetForegroundWindow()!=window) throw new Exception("Root SetFocus did not activate owned foreground");
      proof.Synchronized=SendMessageTimeout(window,0,UIntPtr.Zero,IntPtr.Zero,0x22,500,out ignored)!=IntPtr.Zero;
      if(ReadHeld(handle,pid,expected).BirthFileTime!=proof.Before.BirthFileTime) throw new Exception("Held exact creation changed after owned WM_NULL");
      RootOwner(window,pid,expected.Thread);
      if(!proof.Synchronized || GetForegroundWindow()!=window) throw new Exception("Owned UIA focus foreground synchronization failed");
    }
  }
  public sealed class MetadataNode {
    public int Index,ParentIndex,Depth,Pid,OwnerIndex=-1; public uint NativePid;
    public string Hwnd,RootAncestor; public bool? Enabled,Focusable; public bool Boundary;
  }
  public sealed class MetadataObservation {
    public string RootHwnd,CimTicks,StopReason,Error; public uint RootPid,RootThread;
    public HeldOwner Before,After; public bool Requested=false,Complete; public int InputSent=0;
    public long ElapsedMs; public List<MetadataNode> Nodes=new List<MetadataNode>();
    public MetadataProcessOwner[] Owners; public ForegroundObservation Foreground;
  }
  static bool MetadataBudget(MetadataObservation receipt,long started,int depth) {
    if(Environment.TickCount64-started>=3000) receipt.StopReason="time-limit";
    else if(receipt.Nodes.Count>=128) receipt.StopReason="node-limit";
    else if(depth>16) receipt.StopReason="depth-limit";
    return receipt.StopReason==null;
  }
  static bool MetadataWalk(TestElement element,TestWalker walker,IntPtr window,uint pid,uint thread,MetadataObservation receipt,long started,int parent,int depth,Dictionary<uint,PinnedMetadataOwner> pins) {
    if(!MetadataBudget(receipt,started,depth)) return false;
    RootOwner(window,pid,thread);
    int elementPid=Convert.ToInt32(Property(element,30002));
    MetadataNode row=new MetadataNode { Index=receipt.Nodes.Count,ParentIndex=parent,Depth=depth,Pid=elementPid };
    receipt.Nodes.Add(row);
    PinnedMetadataOwner pin;
    if(!pins.TryGetValue(unchecked((uint)elementPid),out pin)) { row.Boundary=true; receipt.StopReason="foreign-boundary"; return false; }
    row.OwnerIndex=pin.Proof.Index; if(ReadHeld(pin.Handle,pin.Request.Pid,pin.Request).BirthFileTime!=pin.Proof.Before.BirthFileTime) throw new Exception("Pinned metadata PID identity changed");
    IntPtr hwnd=ElementHandle(element); row.Hwnd=hwnd.ToInt64().ToString("x");
    if(hwnd!=IntPtr.Zero) {
      uint nativePid; uint nativeThread=GetWindowThreadProcessId(hwnd,out nativePid);
      row.NativePid=nativePid; row.RootAncestor=GetAncestor(hwnd,2).ToInt64().ToString("x");
      if(!pins.ContainsKey(nativePid) || nativeThread==0 || row.RootAncestor!=receipt.RootHwnd) throw new Exception("Metadata element outside exact owned HWND");
    }
    object enabled=Property(element,30010),focusable=Property(element,30009);
    if(!(enabled is bool) || !(focusable is bool)) throw new Exception("Metadata capability is not Boolean");
    row.Enabled=(bool)enabled; row.Focusable=(bool)focusable;
    if(!MetadataBudget(receipt,started,depth)) return false;
    TestElement child=null;
    try {
      Marshal.ThrowExceptionForHR(walker.FirstChild(element,out child));
      while(child!=null) {
        if(!MetadataWalk(child,walker,window,pid,thread,receipt,started,row.Index,depth+1,pins)) return false;
        TestElement next=null;
        try { Marshal.ThrowExceptionForHR(walker.NextSibling(child,out next)); }
        catch { if(next!=null) Marshal.ReleaseComObject(next); throw; }
        Marshal.ReleaseComObject(child); child=next;
      }
    } finally { if(child!=null) Marshal.ReleaseComObject(child); }
    return MetadataBudget(receipt,started,depth);
  }
  public sealed class MetadataProcessOwner { public int Index; public uint ParentPid; public string CimTicks; public HeldOwner Before,After; }
  public sealed class PinnedMetadataOwner { public FocusRequest Request; public SafeProcessHandle Handle; public MetadataProcessOwner Proof; }
  sealed class MetadataPins {
    public List<PinnedMetadataOwner> Owners=new List<PinnedMetadataOwner>();
    readonly object gate=new object(); bool completed,transferred,released;
    void DisposePins() { if(released) return; released=true; foreach(PinnedMetadataOwner pin in Owners) pin.Handle.Dispose(); }
    public void WorkerFinished() { lock(gate) { completed=true; if(transferred) DisposePins(); } }
    public void Transfer() { lock(gate) { transferred=true; if(completed) DisposePins(); } }
    public void ReleaseCaller() { lock(gate) { if(!transferred) DisposePins(); } }
  }
  static void InspectRoot(TestElement root,TestWalker walker,IntPtr window,uint pid,FocusRequest expected,Observation result,PinnedMetadataOwner[] pins) {
    MetadataObservation receipt=new MetadataObservation { RootHwnd=window.ToInt64().ToString("x"),RootPid=pid,RootThread=expected.Thread,CimTicks=expected.CimTicks.ToString(System.Globalization.CultureInfo.InvariantCulture) };
    result.Metadata=receipt; long started=Environment.TickCount64;
    Dictionary<uint,PinnedMetadataOwner> known=new Dictionary<uint,PinnedMetadataOwner>();
    foreach(PinnedMetadataOwner pin in pins) known.Add(pin.Request.Pid,pin);
    try {
      receipt.Before=ReadHeld(pins[0].Handle,pid,expected); RootOwner(window,pid,expected.Thread);
      if(Convert.ToInt32(Property(root,30002))!=pid || ElementHandle(root)!=window) throw new Exception("Metadata root HWND/PID mismatch");
      MetadataWalk(root,walker,window,pid,expected.Thread,receipt,started,-1,0,known);
    } catch(Exception error) { receipt.Error=error.Message; }
    finally {
      try {
        receipt.After=ReadHeld(pins[0].Handle,pid,expected); RootOwner(window,pid,expected.Thread);
        if(receipt.Before==null || receipt.Before.BirthFileTime!=receipt.After.BirthFileTime || Convert.ToInt32(Property(root,30002))!=pid || ElementHandle(root)!=window) throw new Exception("Metadata held identity or root changed");
      } catch(Exception error) { receipt.Error=receipt.Error??error.Message; }
      receipt.ElapsedMs=Environment.TickCount64-started;
      if(receipt.ElapsedMs>=3000 && receipt.StopReason==null) receipt.StopReason="time-limit";
      receipt.Complete=receipt.Error==null && receipt.StopReason==null;
    }
  }
  public static Observation FocusMetadata(long hwnd,uint pid,uint thread,string executable,string sid,int session,long cimTicks,Func<FocusRequest[]> inventory) {
    MetadataPins lifetime=new MetadataPins(); List<PinnedMetadataOwner> pins=lifetime.Owners; Observation result=null; PinnedForeground foreground=PinForeground();
    try {
      FocusRequest[] before=inventory();
      if(before.Length<1 || before.Length>8 || before[0].Pid!=pid || before[0].CimTicks!=cimTicks) throw new Exception("Metadata bounded root inventory changed");
      for(int index=0;index<before.Length;index++) {
        FocusRequest request=before[index];
        if((index>0 && request.ParentPid!=pid) || !String.Equals(request.Executable,executable,StringComparison.OrdinalIgnoreCase) || request.Sid!=sid || request.Session!=session || request.CimTicks<cimTicks) throw new Exception("Metadata process is not a direct owned child");
        PinnedMetadataOwner pin=new PinnedMetadataOwner { Request=request,Handle=OpenProcess(0x100000|0x1000,false,request.Pid),Proof=new MetadataProcessOwner { Index=index,ParentPid=request.ParentPid,CimTicks=request.CimTicks.ToString(System.Globalization.CultureInfo.InvariantCulture) } };
        pins.Add(pin); pin.Proof.Before=ReadHeld(pin.Handle,request.Pid,request);
        if(index>0 && Int64.Parse(pin.Proof.Before.BirthFileTime)<Int64.Parse(pins[0].Proof.Before.BirthFileTime)) throw new Exception("Metadata child predates held root");
      }
      result=Observe(new IntPtr(hwnd),pid,false,new FocusRequest { Thread=thread,Executable=executable,Sid=sid,Session=session,CimTicks=cimTicks },true,pins.ToArray(),lifetime);
      FocusRequest[] after=inventory();
      if(after.Length!=before.Length) throw new Exception("Metadata direct inventory changed after traversal");
      foreach(PinnedMetadataOwner pin in pins) {
        FocusRequest current=Array.Find(after,item=>item.Pid==pin.Request.Pid);
        if(current==null || current.ParentPid!=pin.Request.ParentPid || current.CimTicks!=pin.Request.CimTicks || current.Executable!=pin.Request.Executable || current.Sid!=pin.Request.Sid || current.Session!=pin.Request.Session) throw new Exception("Metadata direct lineage changed after traversal");
        pin.Proof.After=ReadHeld(pin.Handle,pin.Request.Pid,pin.Request);
        if(pin.Proof.After.BirthFileTime!=pin.Proof.Before.BirthFileTime) throw new Exception("Metadata pinned birth changed after traversal");
      }
      RootOwner(new IntPtr(hwnd),pid,thread);
      if(result.Metadata!=null) result.Metadata.Owners=pins.ConvertAll(pin=>pin.Proof).ToArray();
      return result;
    } catch(Exception error) {
      if(result==null) result=new Observation { RootHwnd=hwnd.ToString("x"),RootPid=pid,RootThread=thread };
      result.Error=error.Message; result.HResult=error.HResult;
      if(result.Metadata!=null) { result.Metadata.Error=error.Message; result.Metadata.Complete=false; }
      return result;
    } finally {
      FinishForeground(foreground); lifetime.ReleaseCaller();
      if(result!=null) { result.Foreground=foreground.Proof; if(result.Metadata!=null) result.Metadata.Foreground=foreground.Proof; }
    }
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int GetPackageFullName(SafeProcessHandle process,ref uint size,StringBuilder name);
  public sealed class ForegroundObservation {
    public string Hwnd,AfterHwnd,PackageBefore,PackageAfter,Error;
    public uint Pid,Thread,AfterPid,AfterThread; public int PackageBeforeStatus,PackageAfterStatus;
    public HeldOwner Before,After;
  }
  sealed class PinnedForeground { public SafeProcessHandle Handle; public ForegroundObservation Proof=new ForegroundObservation(); }
  static string ReadPackage(SafeProcessHandle handle,out int status) {
    uint length=0; status=GetPackageFullName(handle,ref length,null);
    if(status==15700) return null; // APPMODEL_ERROR_NO_PACKAGE, not an access error.
    if(status!=122 || length<1 || length>1024) throw new System.ComponentModel.Win32Exception(status);
    StringBuilder name=new StringBuilder((int)length); status=GetPackageFullName(handle,ref length,name);
    if(status!=0 || length>1024 || name.Length==0) throw new System.ComponentModel.Win32Exception(status);
    return name.ToString();
  }
  static PinnedForeground PinForeground() {
    PinnedForeground pin=new PinnedForeground(); ForegroundObservation proof=pin.Proof;
    try {
      IntPtr hwnd=GetForegroundWindow(); proof.Hwnd=hwnd.ToInt64().ToString("x");
      proof.Thread=GetWindowThreadProcessId(hwnd,out proof.Pid);
      if(hwnd==IntPtr.Zero || proof.Thread==0 || proof.Pid==0) throw new Exception("Foreground identity unavailable");
      pin.Handle=OpenProcess(0x100000|0x1000,false,proof.Pid);
      if(pin.Handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      proof.Before=ReadHeld(pin.Handle,proof.Pid,null); proof.PackageBefore=ReadPackage(pin.Handle,out proof.PackageBeforeStatus);
      uint checkPid; if(GetForegroundWindow()!=hwnd || GetWindowThreadProcessId(hwnd,out checkPid)!=proof.Thread || checkPid!=proof.Pid) throw new Exception("Foreground changed before diagnostic");
    } catch(Exception error) { proof.Error=error.Message; }
    return pin;
  }
  static void FinishForeground(PinnedForeground pin) {
    ForegroundObservation proof=pin.Proof;
    try {
      IntPtr hwnd=GetForegroundWindow(); proof.AfterHwnd=hwnd.ToInt64().ToString("x"); proof.AfterThread=GetWindowThreadProcessId(hwnd,out proof.AfterPid);
      if(proof.Error!=null) return;
      proof.After=ReadHeld(pin.Handle,proof.Pid,null); proof.PackageAfter=ReadPackage(pin.Handle,out proof.PackageAfterStatus);
      uint checkPid; if(GetForegroundWindow()!=hwnd || GetWindowThreadProcessId(hwnd,out checkPid)!=proof.AfterThread || checkPid!=proof.AfterPid) throw new Exception("Foreground changed after diagnostic reads");
      if(proof.AfterHwnd!=proof.Hwnd || proof.AfterPid!=proof.Pid || proof.AfterThread!=proof.Thread || proof.Before.BirthFileTime!=proof.After.BirthFileTime || proof.Before.Executable!=proof.After.Executable || proof.Before.Sid!=proof.After.Sid || proof.Before.Session!=proof.After.Session || proof.PackageBeforeStatus!=proof.PackageAfterStatus || proof.PackageBefore!=proof.PackageAfter) throw new Exception("Foreground identity changed during diagnostic");
    } catch(Exception error) { proof.Error=proof.Error??error.Message; }
    finally { if(pin.Handle!=null) pin.Handle.Dispose(); }
  }
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr SendCloseMessage(IntPtr hwnd,uint message,UIntPtr wParam,IntPtr lParam,uint flags,uint timeout,out UIntPtr result);
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  public sealed class CloudCloseReceipt {
    public string Outcome="failed"; public ForegroundObservation Before,AfterForeground; public HeldOwner Immediate,AfterHeld;
    public int Requested,SendError,InputSent,Message; public bool SendReturned,WindowGone,ProcessExited,Qualifying; public long ElapsedMs; public string Error;
  }
  public static CloudCloseReceipt CloseTestCloudExperience(string image,string sid,int session,Action signature,Action<CloudCloseReceipt> progress) {
    const string package="Microsoft.Windows.CloudExperienceHost_10.0.26100.1_neutral_neutral_cw5n1h2txyewy";
    CloudCloseReceipt proof=new CloudCloseReceipt(); PinnedForeground pin=PinForeground(); proof.Before=pin.Proof; long started=Environment.TickCount64;
    try {
      if(pin.Proof.Error!=null) throw new Exception(pin.Proof.Error);
      HeldOwner owner=pin.Proof.Before; IntPtr hwnd=new IntPtr(Convert.ToInt64(pin.Proof.Hwnd,16));
      if(pin.Proof.PackageBefore!=package && !(pin.Proof.PackageBefore??"").StartsWith("Microsoft.Windows.CloudExperienceHost_",StringComparison.OrdinalIgnoreCase) && !String.Equals(System.IO.Path.GetFileName(owner.Executable),"WWAHost.exe",StringComparison.OrdinalIgnoreCase)) {
        FinishForeground(pin);
        if(pin.Proof.Error!=null || owner.Sid!=sid || owner.Session!=session) throw new Exception("Non-Cloud foreground identity not stable or not in TEST session");
        proof.Outcome="no-action"; return proof;
      }
      if(pin.Proof.PackageBeforeStatus!=0 || pin.Proof.PackageBefore!=package || !String.Equals(owner.Executable,image,StringComparison.OrdinalIgnoreCase) || owner.Sid!=sid || owner.Session!=session) throw new Exception("TEST CloudExperienceHost identity not exact");
      signature();
      proof.Immediate=ReadHeld(pin.Handle,owner.Pid,null);
      if(proof.Immediate.BirthFileTime!=owner.BirthFileTime || proof.Immediate.Executable!=owner.Executable || proof.Immediate.Sid!=owner.Sid || proof.Immediate.Session!=owner.Session) throw new Exception("CloudExperienceHost held identity changed before close");
      int status; if(ReadPackage(pin.Handle,out status)!=package || status!=0) throw new Exception("CloudExperienceHost package changed before close");
      progress(proof); // Durable before-request evidence; timeout remains uncertain, never retry.
      proof.Immediate=ReadHeld(pin.Handle,owner.Pid,null);
      if(proof.Immediate.BirthFileTime!=owner.BirthFileTime || proof.Immediate.Executable!=owner.Executable || proof.Immediate.Sid!=owner.Sid || proof.Immediate.Session!=owner.Session) throw new Exception("CloudExperienceHost identity changed immediately before close");
      RootOwner(hwnd,owner.Pid,pin.Proof.Thread);
      if(GetForegroundWindow()!=hwnd) throw new Exception("CloudExperienceHost foreground changed before close");
      UIntPtr ignored; SetLastError(0); proof.Requested=1; proof.Message=0x10;
      proof.SendReturned=SendCloseMessage(hwnd,0x10,UIntPtr.Zero,IntPtr.Zero,0x23,1000,out ignored)!=IntPtr.Zero;
      proof.SendError=Marshal.GetLastWin32Error();
      long deadline=Environment.TickCount64+3000;
      while(Environment.TickCount64<deadline) {
        proof.ProcessExited=WaitForSingleObject(pin.Handle,0)==0;
        proof.WindowGone=!IsWindow(hwnd);
        if(proof.WindowGone || proof.ProcessExited) break;
        RootOwner(hwnd,owner.Pid,pin.Proof.Thread); Thread.Sleep(50);
      }
      if(!proof.WindowGone) throw new Exception("CloudExperienceHost window did not close or handle reused");
      proof.ProcessExited=WaitForSingleObject(pin.Handle,0)==0;
      if(!proof.ProcessExited) {
        try { proof.AfterHeld=ReadHeld(pin.Handle,owner.Pid,null); }
        catch { if(WaitForSingleObject(pin.Handle,0)!=0) throw; proof.ProcessExited=true; proof.AfterHeld=null; }
      }
      if(proof.AfterHeld!=null) {
        if(proof.AfterHeld.BirthFileTime!=owner.BirthFileTime || proof.AfterHeld.Executable!=owner.Executable || proof.AfterHeld.Sid!=owner.Sid || proof.AfterHeld.Session!=owner.Session) throw new Exception("CloudExperienceHost held identity changed after close");
      }
      signature();
      PinnedForeground after=PinForeground(); FinishForeground(after); proof.AfterForeground=after.Proof;
      if(after.Proof.Error!=null || (after.Proof.PackageBefore??"").StartsWith("Microsoft.Windows.CloudExperienceHost_",StringComparison.OrdinalIgnoreCase) || String.Equals(System.IO.Path.GetFileName(after.Proof.Before.Executable),"WWAHost.exe",StringComparison.OrdinalIgnoreCase) || after.Proof.Hwnd==pin.Proof.Hwnd) throw new Exception("CloudExperienceHost closure not independently observed");
      if(IsWindow(hwnd)) throw new Exception("CloudExperienceHost HWND recycled during closure proof");
      proof.Outcome="closed";
    } catch(Exception error) { proof.Error=error.Message; }
    finally { if(pin.Handle!=null) pin.Handle.Dispose(); proof.ElapsedMs=Environment.TickCount64-started; }
    return proof;
  }
  public static Observation Focus(long hwnd,uint pid,uint thread,string executable,string sid,int session,long cimTicks) {
    return Observe(new IntPtr(hwnd),pid,false,new FocusRequest { Thread=thread,Executable=executable,Sid=sid,Session=session,CimTicks=cimTicks });
  }
  public static Observation Compile() { return Observe(IntPtr.Zero,0,true); }
  public static Observation WindowNames(long handle,uint pid) { return Observe(new IntPtr(handle),pid,false); }
}
`;

const execute = promisify(execFile);
const script = String.raw`
param([string]$InputFile,[string]$TrustedModulePath)
$ErrorActionPreference='Stop'
[Environment]::SetEnvironmentVariable('PSModulePath',$TrustedModulePath,'Process')
$data=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($InputFile))
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.ToString() -ne $data.shell.version -or $PSHOME -ne $data.shell.psHome -or [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -ne $data.shell.executable) { throw 'Selected installed PS7 identity changed' }
$refs=[string[]]@($data.references.assemblies | Where-Object { [IO.Path]::GetDirectoryName($_.file) -eq [IO.Path]::Combine($PSHOME,'ref') } | ForEach-Object { $_.file })
if ($refs.Count -lt 4) { throw 'Installed PSHOME references required' }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
${windowsUiaSource}
'@ -ReferencedAssemblies $refs
function Get-StartUtcTicks([object]$value) {
  # ConvertFrom-Json can produce DateTime; compare instants without string coercion.
  if ($value -is [DateTimeOffset]) { return $value.UtcDateTime.Ticks }
  if ($value -is [DateTime]) {
    if ($value.Kind -eq [DateTimeKind]::Unspecified) { throw 'Process start must include a time zone' }
    return $value.ToUniversalTime().Ticks
  }
  if ($value -is [string] -and $value -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$') {
    return [DateTimeOffset]::Parse($value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None).UtcDateTime.Ticks
  }
  throw 'Invalid process start timestamp'
}
function Test-SameStart([object]$actual,[object]$expected) {
  return (Get-StartUtcTicks $actual) -eq (Get-StartUtcTicks $expected)
}
function Test-Canonical([string]$file) {
  $full=[TestOtaObserver]::Canonical($file)
  $prefix=[IO.Path]::GetFullPath($data.root)+[IO.Path]::DirectorySeparatorChar
  if (-not $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'File outside owned TEST root' }
  return $full
}
function Read-Owned([string]$file) {
  $expected=Test-Canonical $file
  $items=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFileName($_.ExecutablePath) -eq [IO.Path]::GetFileName($expected) })
  return @($items | ForEach-Object {
    $actual=Test-Canonical $_.ExecutablePath
    if ($actual -eq $expected) {
      $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid
      if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or $_.SessionId -ne (Get-Process -Id $PID).SessionId) { throw 'TEST process owner/session mismatch' }
      @{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; executable=$actual; actualExecutable=$_.ExecutablePath; command=$_.CommandLine; start=$_.CreationDate.ToUniversalTime().ToString('o'); session=[int]$_.SessionId; sid=$owner.Sid }
    }
  })
}
switch ($data.operation) {
  'compile' { $result=[TestOtaObserver]::Compile() }
  'processes' { $result=@(Read-Owned $data.file) }
  'watch-installer' {
    $result=@(); $deadline=[DateTime]::UtcNow.AddSeconds(5)
    [IO.File]::WriteAllText([IO.Path]::Combine($data.root,'ota-installer-observer.ready'),[DateTime]::UtcNow.ToString('o'))
    while ([DateTime]::UtcNow -lt $deadline) {
      $result+=@(Read-Owned $data.file)
      [Threading.Thread]::Sleep(100)
    }
  }
  'firewall-add' {
    $canonical=Test-Canonical $data.file
    if ($data.group -notmatch '^TEST-updater-windows-[a-f0-9-]+$' -or -not $data.name.StartsWith($data.group+'-',[StringComparison]::Ordinal)) { throw 'Not an owned Firewall rule' }
    if ($canonical -ne $data.canonical) { throw 'Pending installer canonical identity changed' }
    if (@(Get-NetFirewallProfile | Where-Object { -not $_.Enabled }).Count -or (Get-NetFirewallRule -Name $data.name -ErrorAction SilentlyContinue)) { throw 'Firewall containment prerequisite failed' }
    New-NetFirewallRule -Name $data.name -DisplayName $data.name -Group $data.group -Direction Outbound -Action Block -Program $data.file -Profile Any -RemoteAddress @('0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255','::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff') | Out-Null
    $result=@{ program=$data.file; canonical=$canonical; name=$data.name }
  }
  'names' {
    $owner=@(Read-Owned $data.owner.executable | Where-Object { $_.pid -eq $data.owner.pid -and (Test-SameStart $_.start $data.owner.start) })
    if ($owner.Count -ne 1 -or $owner[0].sid -ne $data.owner.sid -or $owner[0].session -ne $data.owner.session) { throw 'Native window PID identity changed' }
    $result=[TestOtaObserver]::WindowNames([Convert]::ToInt64($data.hwnd,16),[uint32]$data.owner.pid)
    $again=@(Read-Owned $data.owner.executable | Where-Object { $_.pid -eq $data.owner.pid -and (Test-SameStart $_.start $data.owner.start) })
    if ($again.Count -ne 1 -or $again[0].sid -ne $data.owner.sid -or $again[0].session -ne $data.owner.session) { throw 'Native window identity changed during accessibility read' }
  }
  'stop' {
    foreach($owner in $data.owners) {
      $current=@(Read-Owned $owner.executable | Where-Object { $_.pid -eq $owner.pid })
      if ($current.Count -eq 0) { continue }
      if ($current.Count -ne 1 -or -not (Test-SameStart $current[0].start $owner.start) -or $current[0].sid -ne $owner.sid -or $current[0].session -ne $owner.session) { throw 'Refuse changed TEST PID identity' }
      Stop-Process -Id $owner.pid -Force -ErrorAction Stop
    }
    $result=@()
  }
  default { throw 'Unknown TEST observer operation' }
}
ConvertTo-Json -InputObject $result -Depth 12 -Compress
`;

export async function windowsOtaObserver(root: string, evidence: string) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert(path.basename(root).startsWith('TEST-updater-windows-'));
  const shell = await selectedWindowsPowerShell();
  const references = await windowsShellCompilerReferences(shell);
  const env = await windowsShellTestEnvironment(root, shell);
  const filename = path.join(root, 'ota-observer.ps1');
  const directory = await mkdtemp(path.join(evidence, 'ota-native-observer-'));
  await writeFile(filename, script);
  await writeFile(path.join(directory, 'native-source.ps1'), script);
  await writeFile(
    path.join(directory, 'compiler-references.json'),
    JSON.stringify(references, null, 2)
  );
  let sequence = 0;
  async function call<T>(operation: string, values: Record<string, unknown> = {}): Promise<T> {
    const input = path.join(root, `ota-native-${++sequence}.json`);
    await writeFile(input, JSON.stringify({ root, shell, references, operation, ...values }));
    const startedAt = Date.now();
    let childPid: number | undefined;
    let completed: { stdout: string; stderr: string } | undefined;
    let phase: ObserverFailurePhase = 'execution';
    try {
      const pending = execute(
        shell.executable,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          filename,
          '-InputFile',
          input,
          '-TrustedModulePath',
          shell.modules.join(path.delimiter),
        ],
        { env, timeout: 20_000, windowsHide: true, maxBuffer: 4_194_304 }
      );
      childPid = pending.child.pid;
      pending.child.stdin?.end();
      const result = await pending;
      completed = result;
      phase = 'receipt';
      await writeFile(
        path.join(directory, path.basename(input)),
        JSON.stringify(
          {
            operation,
            childPid,
            input: JSON.parse(await readFile(input, 'utf8')) as unknown,
            elapsedMs: Date.now() - startedAt,
            ...result,
          },
          null,
          2
        )
      );
      phase = 'json-parse';
      return JSON.parse(result.stdout.trim()) as T;
    } catch (error) {
      await writeFile(
        path.join(directory, path.basename(input)),
        JSON.stringify(
          {
            operation,
            childPid,
            ...observerFailureReceipt(error, phase, completed),
            elapsedMs: Date.now() - startedAt,
          },
          null,
          2
        )
      );
      throw error;
    }
  }
  await call('compile');
  return {
    watchReadyFile: path.join(root, 'ota-installer-observer.ready'),
    processes: (file: string) => call<WindowsProcess[]>('processes', { file }),
    watchInstaller: (file: string) => call<WindowsProcess[]>('watch-installer', { file }),
    addPendingFirewall: (group: string, name: string, file: string, canonical: string) =>
      call('firewall-add', { group, name, file, canonical }),
    names: (owner: WindowsProcess, hwnd: string) => call<NativeNames>('names', { owner, hwnd }),
    stop: (owners: WindowsProcess[]) => call<never[]>('stop', { owners }),
  };
}
