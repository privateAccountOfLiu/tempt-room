using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace JobLauncher;

/// <summary>Transparent stdio proxy that starts a child inside a Windows Job Object
/// with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. If this process dies, the kernel closes
/// the job handle and terminates the whole child tree.</summary>
internal static class Program
{
    private const uint KillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimitInformation info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int handle);

    public static int Main(string[] args)
    {
        if (args.Length < 2 || args[0] != "--")
        {
            Console.Error.WriteLine("usage: job-launcher -- <executable> [args...]");
            return 64;
        }

        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            Console.Error.WriteLine("CreateJobObject failed: " + Marshal.GetLastWin32Error());
            return 65;
        }
        var limits = new ExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = KillOnJobClose;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf<ExtendedLimitInformation>()))
        {
            Console.Error.WriteLine("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
            return 65;
        }

        var start = new ProcessStartInfo(args[1])
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WorkingDirectory = Environment.CurrentDirectory
        };
        for (var i = 2; i < args.Length; i++) start.ArgumentList.Add(args[i]);

        using var child = new Process { StartInfo = start };
        if (!child.Start())
        {
            Console.Error.WriteLine("failed to start child");
            return 66;
        }
        if (!AssignProcessToJobObject(job, child.Handle))
        {
            Console.Error.WriteLine("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
            try { child.Kill(true); } catch { }
            return 67;
        }

        var stdout = new Thread(() => { try { child.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()); } catch (Exception ex) { try { Console.Error.WriteLine("job-launcher stdout: " + ex.Message); } catch { } } }) { IsBackground = true };
        var stderr = new Thread(() => { try { child.StandardError.BaseStream.CopyTo(Console.OpenStandardError()); } catch { } }) { IsBackground = true };
        var stdin = new Thread(() =>
        {
            try
            {
                using var input = new FileStream(new SafeFileHandle(GetStdHandle(-10), ownsHandle: false), FileAccess.Read, 81920, false);
                var buffer = new byte[8192];
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    child.StandardInput.BaseStream.Write(buffer, 0, read);
                    child.StandardInput.BaseStream.Flush();
                }
            }
            catch (Exception ex) { try { Console.Error.WriteLine("job-launcher stdin: " + ex.Message); } catch { } }
            finally
            {
                try { child.StandardInput.Close(); } catch { }
            }
        }) { IsBackground = true };
        stdout.Start(); stderr.Start(); stdin.Start();

        child.WaitForExit();
        try { stdout.Join(2000); stderr.Join(2000); } catch { }
        Console.Out.Flush();
        Console.Error.Flush();
        return child.ExitCode;
    }
}
