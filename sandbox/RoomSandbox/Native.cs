using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace RoomSandbox;

internal static class Native
{
    [StructLayout(LayoutKind.Sequential)] internal struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct STARTUPINFO
    {
        public int cb; public string? reserved; public string? desktop; public string? title;
        public int x, y, xSize, ySize, xChars, yChars, fill, flags;
        public short show, reserved2; public IntPtr reservedPtr, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct STARTUPINFOEX { public STARTUPINFO info; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] internal struct PROCESS_INFORMATION { public IntPtr process, thread; public int processId, threadId; }
    [StructLayout(LayoutKind.Sequential)] internal struct SID_AND_ATTRIBUTES { public IntPtr sid; public uint attributes; }
    [StructLayout(LayoutKind.Sequential)] internal struct SECURITY_CAPABILITIES { public IntPtr sid, capabilities; public int count, reserved; }
    [StructLayout(LayoutKind.Sequential)] internal struct BASIC_LIMIT
    {
        public long processTime, jobTime; public uint flags; public UIntPtr minWorkingSet, maxWorkingSet;
        public uint activeProcesses; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct IO_COUNTERS { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] internal struct EXTENDED_LIMIT
    { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] internal struct BASIC_ACCOUNTING
    { public long userTime, kernelTime, periodUserTime, periodKernelTime; public uint faults, totalProcesses, activeProcesses, terminatedProcesses; }
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] internal static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, int count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] internal static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] internal static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("advapi32.dll")] internal static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll")] internal static extern IntPtr LocalFree(IntPtr p);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool CreateProcessW(string? application, System.Text.StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attrs, int size);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] internal static extern IntPtr CreateFileW(string path,uint access,uint sharing,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr CreateJobObjectW(IntPtr attrs, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMIT info, int length);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out BASIC_ACCOUNTING info, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] internal static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] internal static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] internal static extern bool GetExitCodeProcess(IntPtr process, out uint exit);
    [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr result, int length, out int required);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool SetFileSecurityW(string path, uint info, IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr sacl, out bool defaulted);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] internal static extern uint SetNamedSecurityInfoW(string name, int kind, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    internal static void Check(bool ok, string operation) { if (!ok) { var error = Marshal.GetLastWin32Error(); throw new Win32Exception(error, $"{operation} (Win32 {error})"); } }
    internal static bool IsAppContainer(IntPtr process)
    {
        Check(OpenProcessToken(process, 8, out var token), "OpenProcessToken");
        var ptr = Marshal.AllocHGlobal(4);
        try { Check(GetTokenInformation(token, 29, ptr, 4, out _), "TokenIsAppContainer"); return Marshal.ReadInt32(ptr) != 0; }
        finally { Marshal.FreeHGlobal(ptr); CloseHandle(token); }
    }
    internal static void PrepareManagedRoot(string path)
    {
        // On volumes that grant Authenticated Users only Modify, being the
        // owner permits WRITE_DAC but does not implicitly grant WRITE_OWNER.
        // LABEL_SECURITY_INFORMATION needs WRITE_OWNER. Establish an explicit
        // owner ACE on our own state root, never on a user's project directory.
        var info = new DirectoryInfo(path);
        if ((info.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Managed state cannot be a reparse point");
        var current = WindowsIdentity.GetCurrent().User!;
        var existing = info.GetAccessControl();
        if (!current.Equals(existing.GetOwner(typeof(SecurityIdentifier)))) throw new UnauthorizedAccessException("Managed state must be owned by the current account");
        var acl = existing;
        acl.SetAccessRuleProtection(true, false);
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, false, typeof(SecurityIdentifier))) acl.RemoveAccessRuleSpecific(rule);
        foreach (var principal in new[] { current, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
            acl.AddAccessRule(new FileSystemAccessRule(principal, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        info.SetAccessControl(acl);
    }
    internal static void Grant(string path, SecurityIdentifier sid, FileSystemRights rights, bool writable)
    {
        var info = new DirectoryInfo(path);
        var acl = info.GetAccessControl();
        acl.AddAccessRule(new FileSystemAccessRule(sid, rights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        info.SetAccessControl(acl);
        if (writable)
        {
            Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("S:(ML;OICI;NW;;;LW)", 1, out var descriptor, out _), "Create low integrity label");
            try {
                Check(GetSecurityDescriptorSacl(descriptor, out _, out var sacl, out _), "Read low integrity label");
                uint result = SetNamedSecurityInfoW(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
                if (result != 0) throw new Win32Exception((int)result, $"Set low integrity label (Win32 {result})");
            }
            finally { LocalFree(descriptor); }
        }
    }
    internal static void Revoke(string path, SecurityIdentifier sid)
    {
        try { var info = new DirectoryInfo(path); var acl = info.GetAccessControl(); acl.PurgeAccessRules(sid); info.SetAccessControl(acl); } catch { }
    }
    internal static string Quote(string text)
    {
        if (!text.Contains(' ') && !text.Contains('\t') && !text.Contains('"') && text.Length > 0) return text;
        var result = new System.Text.StringBuilder("\""); int slashes = 0;
        foreach (var ch in text) { if (ch == '\\') { slashes++; continue; } if (ch == '"') { result.Append('\\', slashes * 2 + 1); result.Append(ch); } else { result.Append('\\', slashes); result.Append(ch); } slashes = 0; }
        result.Append('\\', slashes * 2).Append('"'); return result.ToString();
    }
}
