// OpenCode console wrapper (Windows only).
//
// Problem: the claude-multimodel orchestrator spawns `opencode.exe serve` hosts
// DETACHED (no console). Every console-subsystem child those hosts start
// (cmd.exe for the bash tool, cursor-agent.cmd -> powershell, ...) therefore
// allocates a NEW visible console window that flashes and steals focus.
//
// Fix: this WinExe (no console of its own) is registered as the OpenCode binary.
// It starts the real opencode.exe with the identical command line and
// CREATE_NO_WINDOW: the host gets an invisible console and all of its children
// inherit it, so nothing flashes. stdin/stdout/stderr handles are passed
// through, the exit code is propagated, and a kill-on-close job object makes
// sure the real host (and its whole tree) dies when this wrapper is killed.
//
// Target resolution: OPENCODE_CONSOLE_WRAPPER_TARGET env var, else the
// opencode.real.path sidecar (written by the app), else opencode.real.exe next
// to this executable.
//
// Build: node scripts/stage-opencode-console-wrapper.mjs
// (csc /target:winexe /optimize /out:opencode.exe OpenCodeConsoleWrapper.cs).
// The assembly is AnyCPU on purpose: it is pure IL over kernel32 P/Invokes, so
// the CLR runs it on every Windows architecture the app ships for.
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class OpenCodeConsoleWrapper
{
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);
    private const int STARTF_USESTDHANDLES = 0x00000100;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const uint HANDLE_FLAG_INHERIT = 0x1;
    private const uint INFINITE = 0xFFFFFFFF;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr hThread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpInfo, int cbInfo);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetCommandLineW();

    private static void Fail(string message)
    {
        try { Console.Error.WriteLine("opencode-console-wrapper: " + message); } catch { }
        Environment.Exit(112);
    }

    private static string ResolveTarget()
    {
        string fromEnv = Environment.GetEnvironmentVariable("OPENCODE_CONSOLE_WRAPPER_TARGET");
        if (!string.IsNullOrEmpty(fromEnv) && File.Exists(fromEnv)) return Path.GetFullPath(fromEnv);
        string here = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string sidecar = Path.Combine(here, "opencode.real.path");
        if (File.Exists(sidecar))
        {
            try
            {
                string fromFile = File.ReadAllText(sidecar).Trim();
                if (fromFile.Length > 0 && File.Exists(fromFile)) return Path.GetFullPath(fromFile);
            }
            catch { }
        }
        string sibling = Path.Combine(here, "opencode.real.exe");
        if (File.Exists(sibling)) return sibling;
        Fail("real opencode.exe not found (set OPENCODE_CONSOLE_WRAPPER_TARGET, write opencode.real.path, or place opencode.real.exe next to the wrapper)");
        return null;
    }

    /// Replace the first token (this executable, possibly quoted) of the raw command line with the quoted target path.
    private static string RebuildCommandLine(string target)
    {
        string raw = Marshal.PtrToStringUni(GetCommandLineW()) ?? string.Empty;
        int index = 0;
        if (raw.Length > 0 && raw[0] == '"')
        {
            int close = raw.IndexOf('"', 1);
            index = close < 0 ? raw.Length : close + 1;
        }
        else
        {
            while (index < raw.Length && !char.IsWhiteSpace(raw[index])) index++;
        }
        string rest = raw.Substring(index);
        return "\"" + target + "\"" + rest;
    }

    private static IntPtr InheritableStdHandle(int which)
    {
        IntPtr handle = GetStdHandle(which);
        if (handle != IntPtr.Zero && handle != new IntPtr(-1))
        {
            if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not prepare standard handle");
        }
        return handle;
    }

    private static int Main()
    {
        try { return Run(); }
        catch (Win32Exception error) { Fail(error.Message + " (Win32 " + error.NativeErrorCode + ")"); return 112; }
        catch (Exception error) { Fail(error.Message); return 112; }
    }

    private static int Run()
    {
        string target = ResolveTarget();
        StringBuilder commandLine = new StringBuilder(RebuildCommandLine(target));

        STARTUPINFOEX si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = InheritableStdHandle(STD_INPUT_HANDLE);
        si.StartupInfo.hStdOutput = InheritableStdHandle(STD_OUTPUT_HANDLE);
        si.StartupInfo.hStdError = InheritableStdHandle(STD_ERROR_HANDLE);
        List<IntPtr> handles = new List<IntPtr>();
        foreach (IntPtr handle in new IntPtr[] { si.StartupInfo.hStdInput, si.StartupInfo.hStdOutput, si.StartupInfo.hStdError })
            if (handle != IntPtr.Zero && handle != new IntPtr(-1) && !handles.Contains(handle)) handles.Add(handle);

        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create owned job");
        IntPtr handleList = IntPtr.Zero;
        bool attributesInitialized = false;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        bool completed = false;
        try
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not configure owned job");
            if (handles.Count > 0)
            {
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not size handle attributes");
                si.lpAttributeList = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, ref size))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not initialize handle attributes");
                attributesInitialized = true;
                handleList = Marshal.AllocHGlobal(handles.Count * IntPtr.Size);
                Marshal.Copy(handles.ToArray(), 0, handleList, handles.Count);
                if (!UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                    handleList, new IntPtr(handles.Count * IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not restrict inherited handles");
            }
            // bInheritHandles is required by HANDLE_LIST, but only explicit stdio handles cross.
            // With no valid stdio handles, inherit nothing at all.
            bool created = CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, handles.Count > 0,
                CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                IntPtr.Zero, null, ref si, out pi);
            if (!created) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not start owned target");
            if (!AssignProcessToJobObject(job, pi.hProcess))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not assign owned target to job");
            if (ResumeThread(pi.hThread) == uint.MaxValue)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not resume owned target");
            if (WaitForSingleObject(pi.hProcess, INFINITE) != 0)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not wait for owned target");
            uint exitCode;
            if (!GetExitCodeProcess(pi.hProcess, out exitCode))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read owned target exit");
            completed = true;
            return unchecked((int)exitCode);
        }
        finally
        {
            // Only this invocation's newly created child is eligible for termination.
            if (!completed && pi.hProcess != IntPtr.Zero) TerminateProcess(pi.hProcess, 112);
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            CloseHandle(job);
            if (attributesInitialized) DeleteProcThreadAttributeList(si.lpAttributeList);
            if (si.lpAttributeList != IntPtr.Zero) Marshal.FreeHGlobal(si.lpAttributeList);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
        }
    }
}
