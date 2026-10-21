using System.Diagnostics;
using System.Runtime.InteropServices;

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

        var stdout = Task.Run(() => child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput()));
        var stderr = Task.Run(() => child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError()));
        var stdin = Task.Run(() =>
        {
            try
            {
                Console.OpenStandardInput().CopyTo(child.StandardInput.BaseStream);
            }
            catch { }
            finally
            {
                try { child.StandardInput.Close(); } catch { }
            }
        });

        child.WaitForExit();
        try { stdout.Wait(2000); stderr.Wait(2000); } catch { }
        Console.Out.Flush();
        Console.Error.Flush();
        return child.ExitCode;
    }
}
