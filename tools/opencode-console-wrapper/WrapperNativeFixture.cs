// TEST-only native Windows fixture. No providers, user profiles or shared processes.
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class WrapperNativeFixture
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SI { public int cb; public string reserved, desktop, title; public int x,y,xs,ys,xc,yc,fill,flags; public short show, cb2; public IntPtr reserved2,input,output,error; }
    [StructLayout(LayoutKind.Sequential)]
    struct PI { public IntPtr process,thread; public int pid,tid; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("ws2_32.dll")] static extern int getsockname(IntPtr socket, byte[] address, ref int size);
    [DllImport("ws2_32.dll")] static extern int WSAStartup(ushort version, IntPtr data);
    [DllImport("ws2_32.dll")] static extern int WSACleanup();
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static string Quote(string value) { return "\"" + value + "\""; }
    static void WaitFile(string file) {
        DateTime until=DateTime.UtcNow.AddSeconds(10);
        while (!File.Exists(file) && DateTime.UtcNow < until) Thread.Sleep(20);
        Check(File.Exists(file), "Missing owned child receipt");
    }
    static bool Alive(int pid) { try { return !Process.GetProcessById(pid).HasExited; } catch (ArgumentException) { return false; } }
    static int Main(string[] args)
    {
        try {
            if (args[0] == "grandchild") { Thread.Sleep(30000); return 0; }
            if (args[0] == "child") {
                // Check before opening files/stdio so numeric handle reuse cannot hide a leaked socket.
                IntPtr winsock=Marshal.AllocHGlobal(512);
                bool inherited;
                try {
                    Check(WSAStartup(0x0202,winsock)==0,"Could not initialize TEST Winsock");
                    byte[] address = new byte[128]; int size=address.Length;
                    inherited = getsockname(new IntPtr(long.Parse(args[1])), address, ref size) == 0;
                    WSACleanup();
                } finally { Marshal.FreeHGlobal(winsock); }
                if (inherited) return 91;
                Check(Console.ReadLine() == "TEST stdin", "stdin not preserved");
                Console.Out.WriteLine("TEST stdout"); Console.Error.WriteLine("TEST stderr");
                return 37;
            }
            if (args[0] == "tree") {
                ProcessStartInfo start = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "grandchild");
                start.UseShellExecute=false; start.CreateNoWindow=true;
                Process child=Process.Start(start);
                string temporaryReceipt=args[1]+".tmp";
                File.WriteAllText(temporaryReceipt, Process.GetCurrentProcess().Id + "," + child.Id);
                File.Move(temporaryReceipt,args[1]);
                Thread.Sleep(30000); return 0;
            }
            string wrapper=Path.GetFullPath(args[0]);
            string root=Path.Combine(Path.GetTempPath(), "TEST-wrapper-native-"+Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            string fixture=Process.GetCurrentProcess().MainModule.FileName;
            Environment.SetEnvironmentVariable("OPENCODE_CONSOLE_WRAPPER_TARGET", fixture);
            bool succeeded=false;
            try {
                using (Socket unrelated=new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp)) {
                    unrelated.Bind(new IPEndPoint(IPAddress.Loopback,0)); unrelated.Listen(1);
                    Check(SetHandleInformation(unrelated.Handle,1,1), "Could not mark TEST socket inheritable");
                    string input=Path.Combine(root,"stdin"); File.WriteAllText(input,"TEST stdin\n");
                    string output=Path.Combine(root,"stdout"), error=Path.Combine(root,"stderr");
                    // A direct native launch must detect the leak; otherwise the negative probe is invalid.
                    foreach(string binary in new string[]{fixture,wrapper})
                    using(FileStream i=File.OpenRead(input)) using(FileStream o=File.Create(output)) using(FileStream e=File.Create(error)) {
                        SI si=new SI(); si.cb=Marshal.SizeOf(typeof(SI)); si.flags=0x100;
                        si.input=i.SafeFileHandle.DangerousGetHandle(); si.output=o.SafeFileHandle.DangerousGetHandle(); si.error=e.SafeFileHandle.DangerousGetHandle();
                        foreach(IntPtr handle in new IntPtr[]{si.input,si.output,si.error}) Check(SetHandleInformation(handle,1,1),"Could not inherit TEST stdio");
                        PI pi;
                        Check(CreateProcessW(null,new StringBuilder(Quote(binary)+" child "+unrelated.Handle.ToInt64()),IntPtr.Zero,IntPtr.Zero,true,0x08000000,IntPtr.Zero,root,ref si,out pi),"Could not launch TEST wrapper");
                        try {
                            Check(WaitForSingleObject(pi.process,10000)==0,"Wrapper stdio fixture timed out");
                            uint code; uint expected=binary==fixture ? 91u : 37u;
                            Check(GetExitCodeProcess(pi.process,out code) && code==expected,"Unrelated socket inheritance probe or stdio/exit code failed");
                        } finally { TerminateProcess(pi.process,112); CloseHandle(pi.thread); CloseHandle(pi.process); }
                    }
                    Check(File.ReadAllText(output).Contains("TEST stdout"),"stdout lost");
                    Check(File.ReadAllText(error).Contains("TEST stderr"),"stderr lost");
                }
                string receipt=Path.Combine(root,"tree");
                ProcessStartInfo treeStart=new ProcessStartInfo(wrapper,"tree "+Quote(receipt));
                treeStart.UseShellExecute=false; treeStart.CreateNoWindow=true;
                using(Process wrapperProcess=Process.Start(treeStart)) {
                    try {
                        WaitFile(receipt);
                        string[] pids=File.ReadAllText(receipt).Split(',');
                        int child=int.Parse(pids[0]), grandchild=int.Parse(pids[1]);
                        Check(Alive(child)&&Alive(grandchild),"Owned tree did not start");
                        wrapperProcess.Kill(); wrapperProcess.WaitForExit(10000);
                        DateTime until=DateTime.UtcNow.AddSeconds(10);
                        while((Alive(child)||Alive(grandchild))&&DateTime.UtcNow<until) Thread.Sleep(20);
                        Check(!Alive(child)&&!Alive(grandchild),"Wrapper job leaked owned descendants");
                    } finally { if(!wrapperProcess.HasExited) wrapperProcess.Kill(); }
                }
                Console.WriteLine("PASS: unrelated inheritable socket excluded; stdio/exit preserved; owned job tree drains");
                succeeded=true;
            } finally {
                Environment.SetEnvironmentVariable("OPENCODE_CONSOLE_WRAPPER_TARGET",null);
                try { Directory.Delete(root,true); }
                catch(Exception cleanupError) {
                    Console.Error.WriteLine("TEST fixture cleanup failed: "+cleanupError.Message);
                    if(succeeded) throw;
                }
            }
            return 0;
        } catch(Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
