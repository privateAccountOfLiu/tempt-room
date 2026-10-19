using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RoomSandbox;

internal sealed class RoomPipe : IDisposable
{
    readonly CancellationTokenSource stop = new();
    readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> pending = new();
    readonly string name, runId;
    readonly string hostPath;
    internal string HostPath=>hostPath;
    readonly string securityDescriptor;
    readonly Action<object> emit;
    readonly IntPtr job;
    internal RoomPipe(string name, string runId, SecurityIdentifier sid, IntPtr job, Action<object> emit)
    {
        this.name = name; this.runId = runId; this.job = job; this.emit = emit;
        // AppContainer redirects LOCAL pipes into its own NPFS namespace.
        // The full-trust broker creates the matching qualified name there.
        var leaf=name["LOCAL\\".Length..];
        hostPath=$@"\\.\pipe\Sessions\{System.Diagnostics.Process.GetCurrentProcess().SessionId}\AppContainerNamedObjects\{sid.Value}\{leaf}";
        securityDescriptor = $"D:P(A;;GA;;;{WindowsIdentity.GetCurrent().User!.Value})(A;;GRGW;;;{sid.Value})S:(ML;;NW;;;LW)";
        _ = Accept();
    }
    async Task Accept()
    {
        while (!stop.IsCancellationRequested) {
            NamedPipeServerStream? pipe = null;
            try {
                // PipeSecurity persists its SACL with ACCESS_SYSTEM_SECURITY,
                // which requires SeSecurityPrivilege even for a low label.
                // Creating our own low-labelled object does not require that
                // privilege: pass the descriptor at creation instead.
                Native.Check(Native.ConvertStringSecurityDescriptorToSecurityDescriptorW(securityDescriptor,1,out var descriptor,out _),"Create room pipe security");
                try {
                    var attributes=new Native.SECURITY_ATTRIBUTES {length=Marshal.SizeOf<Native.SECURITY_ATTRIBUTES>(),descriptor=descriptor,inherit=false};
                    var handle=CreateNamedPipeW(hostPath,0x40000003,0x8,8,16384,16384,0,ref attributes);
                    Native.Check(handle!=new IntPtr(-1),"Create scoped room pipe");
                    pipe=new NamedPipeServerStream(PipeDirection.InOut,true,false,new SafePipeHandle(handle,true));
                } finally {Native.LocalFree(descriptor);}
                emit(new {type="sandbox.pipeTrace",runId,stage="listening"});
                await pipe.WaitForConnectionAsync(stop.Token);
                emit(new {type="sandbox.pipeTrace",runId,stage="connected"});
                var connected = pipe; pipe = null;
                _ = Serve(connected);
            } catch (OperationCanceledException) { break; }
            catch (Exception e) { if (!stop.IsCancellationRequested) emit(new { type = "sandbox.pipeError", runId, message = e.Message }); break; }
            finally { pipe?.Dispose(); }
        }
    }
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeClientProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateNamedPipeW(string name,uint openMode,uint pipeMode,uint maxInstances,uint outBuffer,uint inBuffer,uint timeout,ref Native.SECURITY_ATTRIBUTES attributes);
    async Task Serve(NamedPipeServerStream pipe)
    {
        bool waitingForRequest=true;
        using (pipe) {
            try {
                Native.Check(GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var pid), "Identify room pipe client");
                var process = Native.OpenProcess(0x1000, false, (int)pid);
                if (process == IntPtr.Zero) throw new UnauthorizedAccessException("Pipe client is inaccessible");
                try { if (!Native.IsAppContainer(process) || !Native.IsProcessInJob(process, job, out bool belongs) || !belongs) throw new UnauthorizedAccessException("Room bridge client is outside the owning sandbox job"); }
                finally { Native.CloseHandle(process); }
                emit(new {type="sandbox.pipeTrace",runId,stage="verified"});
                using var reader = new StreamReader(pipe, Encoding.UTF8, false, 4096, true);
                using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
                while (!stop.IsCancellationRequested) {
                    var text = new StringBuilder();
                    while (true) { var buf = new char[1]; int n = await reader.ReadAsync(buf.AsMemory(), stop.Token); if (n == 0) return; if (buf[0] == '\n') break; if (text.Length >= 1024 * 1024) throw new InvalidDataException("Room frame too large"); text.Append(buf[0]); }
                    using var doc = JsonDocument.Parse(text.ToString()); var req = doc.RootElement;
                    waitingForRequest=false;
                    emit(new {type="sandbox.pipeTrace",runId,stage="request"});
                    string requestId = Guid.NewGuid().ToString("N");
                    var completion = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously); pending[requestId] = completion;
                    try {
                        emit(new { type = "sandbox.toolRequest", runId, requestId, request = req.Clone() });
                        var result = await completion.Task.WaitAsync(TimeSpan.FromSeconds(30), stop.Token);
                        await writer.WriteLineAsync(result.GetRawText());
                        waitingForRequest=true;
                    } finally { pending.TryRemove(requestId, out _); }
                }
            } catch (IOException) when (waitingForRequest) { /* Idle peer disconnect, including StreamWriter's final flush. */ }
            catch (Exception e) { if (!stop.IsCancellationRequested) emit(new { type = "sandbox.pipeError", runId, message = e.Message }); }
        }
    }
    internal void Resolve(string id, JsonElement result) { if (!pending.TryRemove(id, out var completion)) throw new InvalidOperationException("Tool request no longer active"); completion.TrySetResult(result.Clone()); }
    public void Dispose() { stop.Cancel(); foreach (var completion in pending.Values) completion.TrySetCanceled(); pending.Clear(); }
}
