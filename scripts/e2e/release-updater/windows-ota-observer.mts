import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  selectedWindowsPowerShell,
  windowsShellCompilerReferences,
  windowsShellTestEnvironment,
} from './windows-powershell.mts';

import type { ChildProcess } from 'node:child_process';
import type { WindowsProcess, windowsNative } from './windows-native.mts';

export function observeInstallerChild(
  child: ChildProcess,
  executable: string,
  native: Pick<Awaited<ReturnType<typeof windowsNative>>, 'processes' | 'installerLineage'>,
  save: (receipt: unknown) => Promise<void>
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
    writes = writes.then(() => save(receipt));
    void writes.catch((error: unknown) => {
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
          receipt.lineage = await native.installerLineage(receipt.identity);
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
interface HeldFocusOwner {
  Pid: number;
  Executable: string;
  Sid: string;
  Session: number;
  BirthFileTime: string;
}
export interface OwnedUiaMetadata {
  RootHwnd: string;
  RootPid: number;
  RootThread: number;
  Before: HeldFocusOwner;
  After: HeldFocusOwner;
  CimTicks: string;
  Requested: false;
  InputSent: 0;
  Complete: boolean;
  StopReason: 'node-limit' | 'depth-limit' | 'time-limit' | 'foreign-boundary' | null;
  Error: string | null;
  ElapsedMs: number;
  Nodes: {
    Index: number;
    ParentIndex: number;
    Depth: number;
    Pid: number;
    Hwnd: string | null;
    NativePid: number;
    RootAncestor: string | null;
    Enabled: boolean | null;
    Focusable: boolean | null;
    Boundary: boolean;
  }[];
}
export function assertOwnedUiaMetadata(
  owner: Omit<WindowsProcess, 'command'>,
  hwnd: string,
  thread: number,
  receipt: OwnedUiaMetadata
) {
  assert.equal(receipt.Error, null);
  assert.equal(receipt.RootPid, owner.pid);
  assert.equal(receipt.RootHwnd, hwnd);
  assert.equal(receipt.RootThread, thread);
  assert(Number.isInteger(thread) && thread > 0);
  assert.equal(receipt.Requested, false);
  assert.equal(receipt.InputSent, 0);
  assert.deepEqual(receipt.Before, receipt.After);
  assert.equal(receipt.Before.Pid, owner.pid);
  assert.equal(receipt.Before.Executable.toLowerCase(), owner.executable.toLowerCase());
  assert.equal(receipt.Before.Sid, owner.sid);
  assert.equal(receipt.Before.Session, owner.session);
  const ticks = ownerCimTicks(owner.start);
  assert.equal(receipt.CimTicks, ticks.toString());
  assert(/^\d+$/.test(receipt.Before.BirthFileTime));
  assert.equal(
    BigInt(receipt.Before.BirthFileTime) / 10n,
    (ticks - 504_911_232_000_000_000n) / 10n
  );
  assert(
    ['node-limit', 'depth-limit', 'time-limit', 'foreign-boundary', null].includes(
      receipt.StopReason
    )
  );
  assert.equal(receipt.Complete, receipt.StopReason === null);
  assert(
    Number.isInteger(receipt.ElapsedMs) && receipt.ElapsedMs >= 0 && receipt.ElapsedMs < 15_000
  );
  assert(receipt.StopReason === 'time-limit' || receipt.ElapsedMs <= 3000);
  assert(receipt.Nodes.length > 0 && receipt.Nodes.length <= 128);
  if (receipt.StopReason === 'node-limit') assert.equal(receipt.Nodes.length, 128);
  if (receipt.StopReason === 'depth-limit') assert(receipt.Nodes.some((node) => node.Depth === 16));
  if (receipt.StopReason === 'time-limit') assert(receipt.ElapsedMs >= 3000);
  receipt.Nodes.forEach((node, index) => assertMetadataNode(receipt, node, index));
}
function assertMetadataNode(
  receipt: OwnedUiaMetadata,
  node: OwnedUiaMetadata['Nodes'][number],
  index: number
) {
  assert.equal(node.Index, index);
  assert.equal(typeof node.Boundary, 'boolean');
  assert(Number.isInteger(node.Pid) && node.Pid > 0);
  assert(Number.isInteger(node.Depth) && node.Depth >= 0 && node.Depth <= 16);
  if (index === 0) {
    assert.equal(node.ParentIndex, -1);
    assert.equal(node.Depth, 0);
    assert.equal(node.Hwnd, receipt.RootHwnd);
  } else {
    assert(Number.isInteger(node.ParentIndex) && node.ParentIndex >= 0 && node.ParentIndex < index);
    const parent = receipt.Nodes[node.ParentIndex];
    assert(parent);
    assert.equal(parent.Boundary, false);
    assert.equal(parent.Pid, receipt.RootPid);
    assert.equal(node.Depth, parent.Depth + 1);
  }
  if (node.Boundary) {
    assert.notEqual(node.Pid, receipt.RootPid);
    assert.equal(node.Hwnd, null);
    assert.equal(node.RootAncestor, null);
    assert.equal(node.NativePid, 0);
    assert.equal(node.Enabled, null);
    assert.equal(node.Focusable, null);
    assert.equal(receipt.StopReason, 'foreign-boundary');
    assert.equal(index, receipt.Nodes.length - 1);
  } else {
    assert.equal(node.Pid, receipt.RootPid);
    assert.equal(typeof node.Enabled, 'boolean');
    assert.equal(typeof node.Focusable, 'boolean');
    assert(/^[a-f0-9]+$/.test(node.Hwnd ?? ''));
    assert.equal(node.NativePid, node.Hwnd === '0' ? 0 : receipt.RootPid);
    assert.equal(node.RootAncestor, node.Hwnd === '0' ? null : receipt.RootHwnd);
  }
}
function ownerCimTicks(start: string) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/.exec(start);
  assert(match, 'Owned creation must be explicit UTC');
  const seconds = Date.parse(`${match[1]}Z`);
  assert(Number.isFinite(seconds));
  return (
    BigInt(seconds) * 10_000n + BigInt((match[2] ?? '').padEnd(7, '0')) + 621_355_968_000_000_000n
  );
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
    public MetadataObservation Metadata;
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
  static Observation Observe(IntPtr window,uint pid,bool compileOnly,FocusRequest focus=null,bool metadata=false) {
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
          else if(metadata) InspectRoot(root,walker,window,pid,focus,result);
          else FocusRoot(root,window,pid,focus,result);
          if(Convert.ToInt32(Property(root,30002))!=pid || ElementHandle(root)!=window) throw new Exception("Native UIA root changed after traversal");
          RootOwner(window,pid,result.RootThread);
        }
      } catch(Exception error) { failure=error; result.Error=error.Message; result.HResult=error.HResult; }
      finally {
        result.Names=names.ToArray(); result.ProcessIds=new List<int>(pids).ToArray();
        Release(root,result); Release(walker,result); Release(automation,result);
        if(initialized) CoUninitialize();
        if(result.Metadata!=null && result.Error!=null) { result.Metadata.Error=result.Error; result.Metadata.Complete=false; }
      }
    });
    worker.IsBackground=true; worker.SetApartmentState(ApartmentState.MTA); worker.Start();
    if(!worker.Join(15000)) throw new Exception("Native UIA MTA observation exceeded15seconds");
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
  public sealed class FocusRequest { public string Executable,Sid; public int Session; public long CimTicks; public uint Thread; }
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
    if(String.IsNullOrEmpty(image.ToString()) || !String.Equals(image.ToString(),expected.Executable,StringComparison.OrdinalIgnoreCase) || sid!=expected.Sid || session!=expected.Session || DateTime.FromFileTimeUtc(birth).Ticks/10!=expected.CimTicks/10) throw new Exception("Held process identity differs from fresh CIM owner");
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
    public int Index,ParentIndex,Depth,Pid; public uint NativePid;
    public string Hwnd,RootAncestor; public bool? Enabled,Focusable; public bool Boundary;
  }
  public sealed class MetadataObservation {
    public string RootHwnd,CimTicks,StopReason,Error; public uint RootPid,RootThread;
    public HeldOwner Before,After; public bool Requested=false,Complete; public int InputSent=0;
    public long ElapsedMs; public List<MetadataNode> Nodes=new List<MetadataNode>();
  }
  static bool MetadataBudget(MetadataObservation receipt,long started,int depth) {
    if(Environment.TickCount64-started>=3000) receipt.StopReason="time-limit";
    else if(receipt.Nodes.Count>=128) receipt.StopReason="node-limit";
    else if(depth>16) receipt.StopReason="depth-limit";
    return receipt.StopReason==null;
  }
  static bool MetadataWalk(TestElement element,TestWalker walker,IntPtr window,uint pid,uint thread,MetadataObservation receipt,long started,int parent,int depth) {
    if(!MetadataBudget(receipt,started,depth)) return false;
    RootOwner(window,pid,thread);
    int elementPid=Convert.ToInt32(Property(element,30002));
    MetadataNode row=new MetadataNode { Index=receipt.Nodes.Count,ParentIndex=parent,Depth=depth,Pid=elementPid };
    receipt.Nodes.Add(row);
    if(elementPid!=(int)pid) { row.Boundary=true; receipt.StopReason="foreign-boundary"; return false; }
    IntPtr hwnd=ElementHandle(element); row.Hwnd=hwnd.ToInt64().ToString("x");
    if(hwnd!=IntPtr.Zero) {
      uint nativePid; uint nativeThread=GetWindowThreadProcessId(hwnd,out nativePid);
      row.NativePid=nativePid; row.RootAncestor=GetAncestor(hwnd,2).ToInt64().ToString("x");
      if(nativePid!=pid || nativeThread==0 || row.RootAncestor!=receipt.RootHwnd) throw new Exception("Metadata element outside exact owned HWND");
    }
    object enabled=Property(element,30010),focusable=Property(element,30009);
    if(!(enabled is bool) || !(focusable is bool)) throw new Exception("Metadata capability is not Boolean");
    row.Enabled=(bool)enabled; row.Focusable=(bool)focusable;
    if(!MetadataBudget(receipt,started,depth)) return false;
    TestElement child=null;
    try {
      Marshal.ThrowExceptionForHR(walker.FirstChild(element,out child));
      while(child!=null) {
        if(!MetadataWalk(child,walker,window,pid,thread,receipt,started,row.Index,depth+1)) return false;
        TestElement next=null;
        try { Marshal.ThrowExceptionForHR(walker.NextSibling(child,out next)); }
        catch { if(next!=null) Marshal.ReleaseComObject(next); throw; }
        Marshal.ReleaseComObject(child); child=next;
      }
    } finally { if(child!=null) Marshal.ReleaseComObject(child); }
    return MetadataBudget(receipt,started,depth);
  }
  static void InspectRoot(TestElement root,TestWalker walker,IntPtr window,uint pid,FocusRequest expected,Observation result) {
    MetadataObservation receipt=new MetadataObservation { RootHwnd=window.ToInt64().ToString("x"),RootPid=pid,RootThread=expected.Thread,CimTicks=expected.CimTicks.ToString(System.Globalization.CultureInfo.InvariantCulture) };
    result.Metadata=receipt; long started=Environment.TickCount64;
    using(SafeProcessHandle handle=OpenProcess(0x100000|0x1000,false,pid)) {
      try {
        receipt.Before=ReadHeld(handle,pid,expected); RootOwner(window,pid,expected.Thread);
        if(Convert.ToInt32(Property(root,30002))!=pid || ElementHandle(root)!=window) throw new Exception("Metadata root HWND/PID mismatch");
        MetadataWalk(root,walker,window,pid,expected.Thread,receipt,started,-1,0);
        receipt.Complete=receipt.StopReason==null;
      } catch(Exception error) { receipt.Error=error.Message; }
      finally {
        try {
          receipt.After=ReadHeld(handle,pid,expected); RootOwner(window,pid,expected.Thread);
          if(receipt.Before==null || receipt.Before.BirthFileTime!=receipt.After.BirthFileTime || Convert.ToInt32(Property(root,30002))!=pid || ElementHandle(root)!=window) throw new Exception("Metadata held identity or root changed");
        } catch(Exception error) { receipt.Error=receipt.Error??error.Message; }
        receipt.ElapsedMs=Environment.TickCount64-started;
        if(receipt.ElapsedMs>=3000 && receipt.StopReason==null) receipt.StopReason="time-limit";
        receipt.Complete=receipt.Error==null && receipt.StopReason==null;
      }
    }
  }
  public static Observation FocusMetadata(long hwnd,uint pid,uint thread,string executable,string sid,int session,long cimTicks) {
    return Observe(new IntPtr(hwnd),pid,false,new FocusRequest { Thread=thread,Executable=executable,Sid=sid,Session=session,CimTicks=cimTicks },true);
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
      return JSON.parse(result.stdout.trim()) as T;
    } catch (error) {
      const failure =
        error instanceof Error
          ? (error as Error & {
              stdout?: string;
              stderr?: string;
              code?: number | string;
              signal?: string;
              killed?: boolean;
            })
          : undefined;
      await writeFile(
        path.join(directory, path.basename(input)),
        JSON.stringify(
          {
            operation,
            childPid,
            error: String(error),
            stdout: failure?.stdout,
            stderr: failure?.stderr,
            code: failure?.code,
            signal: failure?.signal,
            killed: failure?.killed,
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
