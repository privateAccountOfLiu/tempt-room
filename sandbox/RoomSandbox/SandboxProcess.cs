using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace RoomSandbox;

internal sealed record LaunchSpec(string RunId, string Executable, string[] Args, string Workspace, string Home, string[] RuntimeRoots,
    Dictionary<string,string>? Environment, int MemoryMb = 4096, int MaxProcesses = 64, int TimeoutMs = 1800000, string? RoomPipe = null);

internal sealed class SandboxProcess : IDisposable
{
    readonly string profile = "TemptRoom." + Guid.NewGuid().ToString("N");
    readonly List<string> granted = [];
    IntPtr sid, job, process;
    SecurityIdentifier? identity;
    StreamWriter? input;
    Task? outputTask, errorTask;
    public int Pid { get; private set; }
    public bool CancelRequested { get; private set; }
    readonly Action<object> emit;
    readonly string root;
    readonly LaunchSpec spec;
    RoomPipe? roomPipe;
    internal string? PipePath=>roomPipe?.HostPath;
    public SandboxProcess(string root, LaunchSpec spec, Action<object> emit) { this.root = Path.GetFullPath(root); this.spec = spec; this.emit = emit; }

    static string Canonical(string path)
    {
        var full = Path.GetFullPath(path);
        for (DirectoryInfo? d = new DirectoryInfo(Directory.Exists(full) ? full : Path.GetDirectoryName(full)!); d != null; d = d.Parent)
            if ((d.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Reparse points are not allowed in sandbox paths");
        if (File.Exists(full) && (File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Reparse executable");
        return full;
    }
    bool UnderRoot(string path) => path.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    public void Start()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows AppContainer is required");
        if (!System.Text.RegularExpressions.Regex.IsMatch(spec.RunId, "^[a-zA-Z0-9_-]{1,128}$")) throw new ArgumentException("Invalid run id");
        string workspace = Canonical(spec.Workspace), home = Canonical(spec.Home), exe = Canonical(spec.Executable);
        if (!UnderRoot(workspace) || !UnderRoot(home) || workspace == home) throw new InvalidOperationException("Workspace and home must be inside managed state");
        if (!File.Exists(exe)) throw new FileNotFoundException("Agent executable not found", exe);
        var roots = spec.RuntimeRoots.Select(Canonical).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        foreach (var path in roots)
            if (!UnderRoot(path) && !string.Equals(path.TrimEnd('\\'), AppContext.BaseDirectory.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Runtime roots must be staged in managed state");
        if (!roots.Any(path => exe.StartsWith(path.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))) throw new InvalidOperationException("Executable is not inside a staged runtime");
        int hr = Native.CreateAppContainerProfile(profile, profile, "Tempt Room isolated agent", IntPtr.Zero, 0, out sid);
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        identity = new SecurityIdentifier(sid);
        foreach (var path in new[] { workspace, home }) { Directory.CreateDirectory(path); granted.Add(path); Native.Grant(path, identity, FileSystemRights.Modify | FileSystemRights.Synchronize, true); }
        foreach (var path in roots) { granted.Add(path); Native.Grant(path, identity, FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize, false); }
        foreach (var sub in new[] { "temp", "AppData/Local", "AppData/Roaming", "codex", "claude", "dsh" }) Directory.CreateDirectory(Path.Combine(home, sub));
        foreach(var sub in new[]{"Temp","INetCache","INetCookies","LocalCache"})
            Directory.CreateDirectory(Path.Combine(home,"AppData","Local","Packages",profile.ToLowerInvariant(),"AC",sub));
        var env = new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase) {
            ["SystemRoot"] = System.Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows",
            ["WINDIR"] = System.Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows",
            ["PATH"] = string.Join(';', roots) + @";C:\Windows\System32;C:\Windows\System32\WindowsPowerShell\v1.0",
            ["USERPROFILE"] = home, ["HOME"] = home, ["TEMP"] = Path.Combine(home,"temp"), ["TMP"] = Path.Combine(home,"temp"),
            ["LOCALAPPDATA"] = Path.Combine(home,"AppData/Local"), ["APPDATA"] = Path.Combine(home,"AppData/Roaming"),
            ["CODEX_HOME"] = Path.Combine(home,"codex"), ["CLAUDE_CONFIG_DIR"] = Path.Combine(home,"claude"), ["DSH_HOME"] = Path.Combine(home,"dsh"),
            ["GIT_DEFAULT_REF_FORMAT"] = "reftable",
            ["DOTNET_EnableDiagnostics"] = "0", ["DOTNET_SKIP_FIRST_TIME_EXPERIENCE"] = "1", ["NO_COLOR"] = "1"
        };
        env["NODE_OPTIONS"]="--preserve-symlinks --preserve-symlinks-main";
        env["ROOM_RUNTIME_ROOTS"]=System.Text.Json.JsonSerializer.Serialize(new[]{workspace,home}.Concat(roots));
        env["ROOM_WRITABLE_ROOTS"]=System.Text.Json.JsonSerializer.Serialize(new[]{workspace,home});
        var compatibility=roots.Select(path=>Path.Combine(path,"room-realpath.cjs")).FirstOrDefault(File.Exists);
        if(compatibility!=null)env["NODE_OPTIONS"]+=" --require "+Native.Quote(compatibility);
        var pipes=roots.Select(path=>Path.Combine(path,"room-pipes.cjs")).FirstOrDefault(File.Exists);
        if(pipes!=null)env["NODE_OPTIONS"]+=" --require "+Native.Quote(pipes);
        env["PATHEXT"]=".COM;.EXE;.BAT;.CMD";
        env["ComSpec"]=Path.Combine(env["SystemRoot"],"System32","cmd.exe");
        foreach (var entry in spec.Environment ?? []) {
            if (env.ContainsKey(entry.Key) && entry.Key != "PATH") throw new InvalidOperationException("Reserved sandbox environment variable");
            if (entry.Key.Contains('=') || entry.Key.Contains('\0') || entry.Value.Contains('\0')) throw new ArgumentException("Invalid environment");
            if (entry.Key == "PATH") throw new InvalidOperationException("PATH cannot be overridden");
            env[entry.Key] = entry.Value;
        }
        job = Native.CreateJobObjectW(IntPtr.Zero, null); Native.Check(job != IntPtr.Zero, "CreateJobObject");
        var limit = new Native.EXTENDED_LIMIT { basic = new() { flags = 0x2000 | 0x8 | 0x200, activeProcesses = (uint)Math.Clamp(spec.MaxProcesses, 1, 128) }, jobMemory = (UIntPtr)((ulong)Math.Clamp(spec.MemoryMb, 256, 16384) * 1024 * 1024) };
        Native.Check(Native.SetInformationJobObject(job, 9, ref limit, Marshal.SizeOf<Native.EXTENDED_LIMIT>()), "Set job limits");
        if (spec.RoomPipe != null) {
            if (!System.Text.RegularExpressions.Regex.IsMatch(spec.RoomPipe, "^LOCAL\\\\TemptRoom-[a-zA-Z0-9_-]+$")) throw new ArgumentException("Invalid room pipe name");
            roomPipe = new RoomPipe(spec.RoomPipe, spec.RunId, identity, job, emit);
            env["ROOM_PIPE"] = @"\\.\pipe\" + spec.RoomPipe;
        }
        IntPtr attributes = IntPtr.Zero, attrSize = IntPtr.Zero, caps = IntPtr.Zero, capEntry = IntPtr.Zero, capSid = IntPtr.Zero, handles = IntPtr.Zero, envPtr = IntPtr.Zero;
        IntPtr inRead = IntPtr.Zero, inWrite = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero;
        try {
            var sa = new Native.SECURITY_ATTRIBUTES { length = Marshal.SizeOf<Native.SECURITY_ATTRIBUTES>(), inherit = true };
            Native.Check(Native.CreatePipe(out inRead, out inWrite, ref sa, 0), "Create stdin pipe");
            Native.Check(Native.CreatePipe(out outRead, out outWrite, ref sa, 0), "Create stdout pipe");
            Native.Check(Native.CreatePipe(out errRead, out errWrite, ref sa, 0), "Create stderr pipe");
            Native.Check(Native.SetHandleInformation(inWrite, 1, 0) && Native.SetHandleInformation(outRead, 1, 0) && Native.SetHandleInformation(errRead, 1, 0), "Protect host pipe handles");
            // Grant only the documented, well-known internetClient capability;
            // no private-network, server or custom capability is requested.
            var capIdentity = new SecurityIdentifier("S-1-15-3-1"); var capBytes = new byte[capIdentity.BinaryLength]; capIdentity.GetBinaryForm(capBytes, 0);
            capSid = Marshal.AllocHGlobal(capBytes.Length); Marshal.Copy(capBytes, 0, capSid, capBytes.Length);
            capEntry = Marshal.AllocHGlobal(Marshal.SizeOf<Native.SID_AND_ATTRIBUTES>());
            Marshal.StructureToPtr(new Native.SID_AND_ATTRIBUTES { sid = capSid, attributes = 4 }, capEntry, false);
            caps = Marshal.AllocHGlobal(Marshal.SizeOf<Native.SECURITY_CAPABILITIES>());
            Marshal.StructureToPtr(new Native.SECURITY_CAPABILITIES { sid = sid, capabilities = capEntry, count = 1 }, caps, false);
            Native.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attrSize);
            attributes = Marshal.AllocHGlobal(attrSize);
            Native.Check(Native.InitializeProcThreadAttributeList(attributes, 2, 0, ref attrSize), "Initialize attributes");
            Native.Check(Native.UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x20009, caps, (IntPtr)Marshal.SizeOf<Native.SECURITY_CAPABILITIES>(), IntPtr.Zero, IntPtr.Zero), "Set AppContainer capabilities");
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3); Marshal.Copy(new[] { inRead, outWrite, errWrite }, 0, handles, 3);
            Native.Check(Native.UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x20002, handles, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "Limit inherited handles");
            envPtr = Marshal.StringToHGlobalUni(string.Join('\0', env.Select(x => x.Key + "=" + x.Value)) + "\0\0");
            var startup = new Native.STARTUPINFOEX { info = new() { cb = Marshal.SizeOf<Native.STARTUPINFOEX>(), flags = 0x100, stdin = inRead, stdout = outWrite, stderr = errWrite }, attributes = attributes };
            var cmd = new StringBuilder(string.Join(' ', new[] { exe }.Concat(spec.Args).Select(Native.Quote)));
            Native.Check(Native.CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, true, 0x08080404, envPtr, workspace, ref startup, out var pi), "Create isolated process");
            process = pi.process; Pid = pi.processId;
            try {
                Native.Check(Native.AssignProcessToJobObject(job, process), "Assign sandbox job");
                if (!Native.IsAppContainer(process)) throw new InvalidOperationException("Child is not an AppContainer");
                Native.Check(Native.IsProcessInJob(process, job, out var inJob) && inJob, "Verify sandbox job");
                input = new StreamWriter(new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write)) { AutoFlush = true }; inWrite = IntPtr.Zero;
                outputTask = Pump(outRead, "stdout"); outRead = IntPtr.Zero;
                errorTask = Pump(errRead, "stderr"); errRead = IntPtr.Zero;
                emit(new { type = "sandbox.started", runId = spec.RunId, pid = Pid, appContainer = true, job = true, network = "public-only",limits=new {memoryMb=Math.Clamp(spec.MemoryMb,256,16384),maxProcesses=Math.Clamp(spec.MaxProcesses,1,128),timeoutMs=Math.Clamp(spec.TimeoutMs,1000,7200000)} });
                if (Native.ResumeThread(pi.thread) == uint.MaxValue) throw new InvalidOperationException("Could not resume sandboxed process");
            } catch { Native.TerminateProcess(process, 1); throw; }
            finally { Native.CloseHandle(pi.thread); }
        } finally {
            foreach (var h in new[] { inRead, inWrite, outRead, outWrite, errRead, errWrite }) if (h != IntPtr.Zero) Native.CloseHandle(h);
            if (attributes != IntPtr.Zero) { Native.DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            foreach (var p in new[] { caps, capEntry, capSid, handles, envPtr }) if (p != IntPtr.Zero) Marshal.FreeHGlobal(p);
        }
    }
    async Task Pump(IntPtr handle, string stream)
    {
        using var reader = new StreamReader(new FileStream(new SafeFileHandle(handle, true), FileAccess.Read), Encoding.UTF8);
        var buffer = new char[4096]; int n;
        try { while ((n = await reader.ReadAsync(buffer)) > 0) emit(new { type = "sandbox.output", runId = spec.RunId, stream, data = new string(buffer, 0, n) }); } catch (IOException) { }
    }
    public void Write(string data) { if (data.Length > 1024 * 1024) throw new ArgumentException("Input too large"); input?.Write(data); }
    public void CloseInput() { input?.Dispose(); input = null; }
    public void ResolveTool(string id, System.Text.Json.JsonElement result) { if (roomPipe == null) throw new InvalidOperationException("No room bridge"); roomPipe.Resolve(id, result); }
    public void Cancel() { CancelRequested = true; if (job != IntPtr.Zero) Native.Check(Native.TerminateJobObject(job, 130), "Terminate sandbox job"); }
    public async Task<uint> Wait()
    {
        var wait = Task.Run(() => Native.WaitForSingleObject(process, uint.MaxValue));
        if (await Task.WhenAny(wait, Task.Delay(Math.Clamp(spec.TimeoutMs, 1000, 7200000))) != wait) { Cancel(); }
        await wait;
        Native.GetExitCodeProcess(process, out var code);
        // No detached background work may survive the root agent.
        Native.Check(Native.TerminateJobObject(job, 130), "Stop remaining sandbox processes");
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (true) {
            Native.Check(Native.QueryInformationJobObject(job, 1, out var accounting, Marshal.SizeOf<Native.BASIC_ACCOUNTING>(), IntPtr.Zero), "Confirm empty sandbox job");
            if (accounting.activeProcesses == 0) break;
            if (DateTime.UtcNow >= deadline) throw new InvalidOperationException("Sandbox process tree termination was not confirmed");
            await Task.Delay(25);
        }
        await Task.WhenAll(outputTask ?? Task.CompletedTask, errorTask ?? Task.CompletedTask).WaitAsync(TimeSpan.FromSeconds(5));
        return code;
    }
    public void Dispose()
    {
        roomPipe?.Dispose(); input?.Dispose(); if (job != IntPtr.Zero) { Native.TerminateJobObject(job, 130); Native.CloseHandle(job); job = IntPtr.Zero; }
        if (process != IntPtr.Zero) { Native.CloseHandle(process); process = IntPtr.Zero; }
        if (identity != null) foreach (var path in granted) Native.Revoke(path, identity);
        if (sid != IntPtr.Zero) { Native.FreeSid(sid); sid = IntPtr.Zero; }
        Native.DeleteAppContainerProfile(profile);
    }
}
