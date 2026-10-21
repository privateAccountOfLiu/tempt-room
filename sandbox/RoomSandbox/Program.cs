using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.NetworkInformation;
using System.Text.Json;
using RoomSandbox;

// The IPC transport carries UTF-8 JSON with non-ASCII text. Without this the
// redirected console defaults to the system ANSI code page and corrupts frames.
Console.InputEncoding = new System.Text.UTF8Encoding(false);
Console.OutputEncoding = new System.Text.UTF8Encoding(false);

var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
if (args.Contains("--probe-child")) { await Probe.Child(args); return; }
if(args.Contains("--probe-peer-reader")){Probe.PeerReader(args);return;}
if(args.Contains("--probe-peer-holder")){Console.WriteLine(JsonSerializer.Serialize(new {ownsFile=File.ReadAllText(args[1])=="peer-private"}));await Task.Delay(Timeout.Infinite);return;}
if (args.Contains("--probe-leaf")) { Console.WriteLine(JsonSerializer.Serialize(new { appContainer = Native.IsAppContainer(Native.GetCurrentProcess()) })); return; }
if(args.Contains("--probe-hold-leaf")){await Task.Delay(Timeout.Infinite);return;}
if(args.Contains("--probe-hold-root")){
    var childStart=new ProcessStartInfo(System.Environment.ProcessPath!){UseShellExecute=false,CreateNoWindow=true};childStart.ArgumentList.Add("--probe-hold-leaf");
    using var child=Process.Start(childStart)!;
    Console.WriteLine(JsonSerializer.Serialize(new {pid=System.Environment.ProcessId,childPid=child.Id,appContainer=Native.IsAppContainer(Native.GetCurrentProcess())}));
    await Task.Delay(Timeout.Infinite);return;
}
string root = Path.GetFullPath(args.SkipWhile(x => x != "--root").Skip(1).FirstOrDefault() ?? throw new ArgumentException("--root is required"));
Directory.CreateDirectory(root);
Native.PrepareManagedRoot(root);
object outputLock = new();
void Emit(object value) { lock (outputLock) { Console.WriteLine(JsonSerializer.Serialize(value, json)); } }
var active = new ConcurrentDictionary<string, SandboxProcess>();
var pending = new ConcurrentDictionary<string, Task>();
try {
    string? line;
    while ((line = await Console.In.ReadLineAsync()) != null) {
        if (line.Length > 2 * 1024 * 1024) { Emit(new { type = "error", message = "IPC frame exceeds limit" }); continue; }
        string? requestId = null;
        try {
            using var doc = JsonDocument.Parse(line); var req = doc.RootElement;
            requestId = req.GetProperty("id").GetString(); string method = req.GetProperty("method").GetString()!;
            if (method == "probe") {
                var tools=req.TryGetProperty("tools",out var toolSpec)?toolSpec.Deserialize<ProbeTools>(json):null;
                var result = await Probe.Run(root, Emit, tools); Emit(new { id = requestId, result });
            } else if (method == "launch") {
                var spec = req.GetProperty("spec").Deserialize<LaunchSpec>(json)!;
                if (active.ContainsKey(spec.RunId)) throw new InvalidOperationException("Duplicate run");
                var process = new SandboxProcess(root, spec, Emit);
                try { process.Start(); if (!active.TryAdd(spec.RunId, process)) throw new InvalidOperationException("Duplicate run"); }
                catch { process.Dispose(); throw; }
                Emit(new { id = requestId, result = new { pid = process.Pid } });
                pending[spec.RunId] = Task.Run(async () => {
                    try { var exitCode = await process.Wait(); Emit(new { type = "sandbox.exit", runId = spec.RunId, exitCode, canceled = process.CancelRequested, jobEmpty = true }); }
                    catch (Exception e) { Emit(new { type = "sandbox.error", runId = spec.RunId, message = e.Message }); }
                    finally { active.TryRemove(spec.RunId, out _); process.Dispose(); pending.TryRemove(spec.RunId, out _); }
                });
            } else if (method == "input" || method == "cancel" || method == "closeInput" || method == "toolResponse") {
                var runId = req.GetProperty("runId").GetString()!;
                if (!active.TryGetValue(runId, out var process)) throw new InvalidOperationException("Run is not active");
                if (method == "input") process.Write(req.GetProperty("data").GetString()!);
                else if (method == "cancel") process.Cancel();
                else if (method == "toolResponse") process.ResolveTool(req.GetProperty("requestId").GetString()!, req.GetProperty("result"));
                else process.CloseInput();
                Emit(new { id = requestId, result = new { accepted = true } });
            } else throw new ArgumentException("Unknown IPC method");
        } catch (Exception e) { Emit(new { id = requestId, error = new { message = e.Message, code = e is System.ComponentModel.Win32Exception w ? w.NativeErrorCode : -1 } }); }
    }
} finally {
    foreach (var process in active.Values) { try { process.Cancel(); } catch { } }
    try { await Task.WhenAll(pending.Values).WaitAsync(TimeSpan.FromSeconds(5)); } catch { }
    foreach (var process in active.Values) process.Dispose();
}

internal sealed record ProbeTools(string Node,string Npm,string Git,string Shell,string[] RuntimeRoots);
internal sealed record ProbeNetwork(bool Loop4,bool Loop6,bool Private4,string Private6,int Private6Port,bool Private6Reachable,string Database);

internal static class Probe
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    internal static async Task<object> Run(string root, Action<object> emit, ProbeTools? tools)
    {
        string id = "probe-" + Guid.NewGuid().ToString("N"), directory = Path.Combine(root, "probes", id);
        string workspace = Path.Combine(directory, "workspace"), home = Path.Combine(directory, "home"), secret = Path.Combine(directory, "host-secret.txt");
        Directory.CreateDirectory(workspace); Directory.CreateDirectory(home); File.WriteAllText(secret, "outside-" + Guid.NewGuid());
        // Protected DACL: unlike the workspace, this file is never granted to the AppContainer.
        var file = new FileInfo(secret); var acl = file.GetAccessControl(); acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(System.Security.Principal.WindowsIdentity.GetCurrent().User!, System.Security.AccessControl.FileSystemRights.FullControl, System.Security.AccessControl.AccessControlType.Allow)); file.SetAccessControl(acl);
        using var loop4 = new TcpListener(IPAddress.Loopback, 0); loop4.Start();
        using var loop6 = new TcpListener(IPAddress.IPv6Loopback, 0); loop6.Start();
        using var lan = new TcpListener(IPAddress.Any, 0); lan.Start();
        using var lan6=new TcpListener(IPAddress.IPv6Any,0);lan6.Start();
        var privateIp = Dns.GetHostAddresses(Dns.GetHostName()).FirstOrDefault(ip => ip.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(ip) && IsPrivate(ip));
        var private6=NetworkInterface.GetAllNetworkInterfaces().Where(item=>item.OperationalStatus==OperationalStatus.Up).SelectMany(item=>item.GetIPProperties().UnicastAddresses).Select(item=>item.Address).FirstOrDefault(ip=>ip.AddressFamily==AddressFamily.InterNetworkV6&&(ip.IsIPv6LinkLocal||(ip.GetAddressBytes()[0]&0xfe)==0xfc));
        string database=Path.Combine(root,"room.sqlite");if(!File.Exists(database)){database=Path.Combine(directory,"host-app-state.bin");File.WriteAllText(database,"app-state-canary");}
        var network=new ProbeNetwork(await Reachable(IPAddress.Loopback,((IPEndPoint)loop4.LocalEndpoint).Port),await Reachable(IPAddress.IPv6Loopback,((IPEndPoint)loop6.LocalEndpoint).Port),privateIp!=null&&await Reachable(privateIp,((IPEndPoint)lan.LocalEndpoint).Port),private6?.ToString()??"",((IPEndPoint)lan6.LocalEndpoint).Port,private6!=null&&await Reachable(private6,((IPEndPoint)lan6.LocalEndpoint).Port),database);
        var lines = new System.Text.StringBuilder();
        var pipeErrors = new ConcurrentQueue<string>();
        var pipeTrace = new ConcurrentQueue<string>();
        string pipeName = @"LOCAL\TemptRoom-" + id;
        var spec = new LaunchSpec(id, System.Environment.ProcessPath!, ["--probe-child", workspace, secret, ((IPEndPoint)loop4.LocalEndpoint).Port.ToString(), ((IPEndPoint)loop6.LocalEndpoint).Port.ToString(), privateIp?.ToString() ?? "", ((IPEndPoint)lan.LocalEndpoint).Port.ToString(), System.Environment.ProcessId.ToString(), pipeName,JsonSerializer.Serialize(tools,Json),JsonSerializer.Serialize(network,Json)], workspace, home, [AppContext.BaseDirectory,..tools?.RuntimeRoots??[]], null, 1024, 32, 60000, pipeName);
        SandboxProcess? running = null;
        using var process = new SandboxProcess(root, spec, e => {
            var element = JsonSerializer.SerializeToElement(e, Json);
            if (element.TryGetProperty("stream", out var stream) && stream.GetString() == "stdout") lines.Append(element.GetProperty("data").GetString());
            if(element.GetProperty("type").GetString()=="sandbox.pipeError")pipeErrors.Enqueue(element.GetProperty("message").GetString()??"Pipe failed");
            if(element.GetProperty("type").GetString()=="sandbox.pipeTrace")pipeTrace.Enqueue(element.GetProperty("stage").GetString()??"");
            if(element.GetProperty("type").GetString()=="sandbox.toolRequest")running!.ResolveTool(element.GetProperty("requestId").GetString()!,JsonSerializer.SerializeToElement(new { ok=true }));
        });
        running=process;
        try {
            process.Start(); process.CloseInput(); var exit = await process.Wait();
            var report = JsonSerializer.Deserialize<JsonElement>(lines.ToString().Trim(), Json);
            var checks=report.GetProperty("checks").EnumerateArray().Select(c=>c.Clone()).ToList();
            await CheckCancel(root,checks);
            await CheckHostExit(root,checks);
            await CheckPeerIsolation(root,checks);
            foreach(var error in pipeErrors)checks.Add(JsonSerializer.SerializeToElement(new {name="room-ipc-host",passed=false,detail=error},Json));
            if(checks.Any(c=>c.GetProperty("name").GetString()=="room-ipc"&&!c.GetProperty("passed").GetBoolean()))checks.Add(JsonSerializer.SerializeToElement(new {name="room-ipc-stages",passed=false,detail=string.Join(" -> ",pipeTrace)},Json));
            return new { ready = checks.All(c=>c.GetProperty("passed").GetBoolean()) && exit == 0, checks, checkedAt = DateTimeOffset.UtcNow };
        } catch (Exception e) { return new { ready = false, checks = new[] { new { name = "native-launch", passed = false, detail = e.Message } }, checkedAt = DateTimeOffset.UtcNow }; }
    }
    static bool IsPrivate(IPAddress ip) { var b = ip.GetAddressBytes(); return b[0] == 10 || b[0] == 192 && b[1] == 168 || b[0] == 172 && b[1] is >= 16 and <= 31 || b[0] == 169 && b[1] == 254; }
    static async Task<bool> Reachable(IPAddress address,int port){try{using var socket=new TcpClient(address.AddressFamily);await socket.ConnectAsync(address,port).WaitAsync(TimeSpan.FromSeconds(2));return true;}catch{return false;}}
    internal static async Task Child(string[] args)
    {
        var checks = new List<object>(); bool ready = true;
        void Add(string name, bool passed, string detail) { checks.Add(new { name, passed, detail }); ready &= passed; }
        var workspace = args[1];
        var network=JsonSerializer.Deserialize<ProbeNetwork>(args[10],Json)!;
        Add("appcontainer-token", Native.IsAppContainer(Native.GetCurrentProcess()), "OS token inspection");
        Native.IsProcessInJob(Native.GetCurrentProcess(), IntPtr.Zero, out var job); Add("job-membership", job, "Process is inside a Job Object");
        try { string path = Path.Combine(workspace, "probe.txt"); await File.WriteAllTextAsync(path, "ok"); Add("workspace-write", await File.ReadAllTextAsync(path) == "ok", "Write/read in assigned workspace"); } catch (Exception e) { Add("workspace-write", false, e.Message); }
        bool denied = false; try { await File.ReadAllTextAsync(args[2]); } catch (UnauthorizedAccessException) { denied = true; } Add("host-file-denied", denied, "Unassigned protected host file");
        var database=Native.CreateFileW(network.Database,0x80000000,7,IntPtr.Zero,3,0,IntPtr.Zero);int databaseError=System.Runtime.InteropServices.Marshal.GetLastWin32Error();Add("app-database-denied",database==new IntPtr(-1)&&databaseError==5,"Managed database (or protected app-state canary) must deny read access, not merely fail due to sharing");if(database!=new IntPtr(-1))Native.CloseHandle(database);
        var handle = Native.OpenProcess(0x1 | 0x20, false, int.Parse(args[7])); Add("host-process-denied", handle == IntPtr.Zero, "Cannot terminate or write host process"); if (handle != IntPtr.Zero) Native.CloseHandle(handle);
        string ipcStage="connect";
        try {
            var pipeHandle=Native.CreateFileW(@"\\.\pipe\"+args[8],0xC0000000,0,IntPtr.Zero,3,0x40000000,IntPtr.Zero);Native.Check(pipeHandle!=new IntPtr(-1),"Connect scoped room pipe");
            using var pipe=new System.IO.Pipes.NamedPipeClientStream(System.IO.Pipes.PipeDirection.InOut,true,true,new Microsoft.Win32.SafeHandles.SafePipeHandle(pipeHandle,true));
            using var writer=new StreamWriter(pipe,leaveOpen:true){AutoFlush=true};using var reader=new StreamReader(pipe,leaveOpen:true);
            ipcStage="write";await writer.WriteLineAsync("{\"name\":\"probe\",\"arguments\":{}}");ipcStage="response";var response=await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));Add("room-ipc",response?.Contains("true")==true,"Scoped room IPC and verified sandbox client identity");
        } catch(Exception e){Add("room-ipc",false,ipcStage+": "+e.Message);}
        async Task<bool> Connect(string host, int port) { try {var address=IPAddress.Parse(host);using var c = new TcpClient(address.AddressFamily); await c.ConnectAsync(address, port).WaitAsync(TimeSpan.FromSeconds(2)); return true; } catch { return false; } }
        Add("loopback-ipv4-denied", network.Loop4&&!await Connect("127.0.0.1", int.Parse(args[3])),network.Loop4?"Host-reachable IPv4 listener must be blocked":"Host IPv4 positive control failed; not certified");
        Add("loopback-ipv6-denied", network.Loop6&&!await Connect("::1", int.Parse(args[4])),network.Loop6?"Host-reachable IPv6 listener must be blocked":"Host IPv6 positive control failed; not certified");
        Add("private-network-denied", network.Private4&&!await Connect(args[5], int.Parse(args[6])),network.Private4?"Host-reachable LAN IPv4 listener must be blocked":"No reachable private IPv4 positive control; not certified");
        Add("private-ipv6-denied",network.Private6Reachable&&!await Connect(network.Private6,network.Private6Port),network.Private6Reachable?"Host-reachable private/link-local IPv6 listener must be blocked":"No reachable private IPv6 positive control; not certified");
        try { using var handler=new SocketsHttpHandler {UseProxy=false};using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(8) }; using var response = await http.GetAsync("https://example.com"); Add("public-network", response.IsSuccessStatusCode, "Direct HTTPS, without ambient host proxy"); } catch (Exception e) { Add("public-network", false, e.GetType().Name+": "+e.Message); }
        try {
            var start = new ProcessStartInfo(System.Environment.ProcessPath!) { RedirectStandardOutput = true, UseShellExecute = false }; start.ArgumentList.Add("--probe-leaf");
            using var child = Process.Start(start)!; string text = await child.StandardOutput.ReadToEndAsync(); await child.WaitForExitAsync(); Add("child-inherits-isolation", text.Contains("true") && child.ExitCode == 0, "Nested native process remains in AppContainer");
        } catch (Exception e) { Add("child-inherits-isolation", false, e.Message); }
        var tools=JsonSerializer.Deserialize<ProbeTools>(args[9],Json);
        if(tools==null)Add("toolchain",false,"Node/npm/Git toolchain was not provided");
        else {
            async Task<(int code,string output)> RunTool(string executable,string[] arguments){
                var start=new ProcessStartInfo(executable){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=workspace};foreach(var argument in arguments)start.ArgumentList.Add(argument);
                using var child=Process.Start(start)!;var output=child.StandardOutput.ReadToEndAsync();var error=child.StandardError.ReadToEndAsync();
                try{await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15));}
                catch(TimeoutException){child.Kill(true);await child.WaitForExitAsync();throw new TimeoutException("Tool exceeded 15 seconds. Partial output:\n"+((await output)+"\n"+(await error)).Trim());}
                return(child.ExitCode,(await output)+"\n"+(await error));
            }
            try {
                var script=Path.Combine(workspace,"node-isolation.cjs");
                await File.WriteAllTextAsync(script,"const fs=require('node:fs'),cp=require('node:child_process');console.log('Node '+process.version+'; libuv '+process.versions.uv);fs.writeFileSync('node-write.txt','ok');let denied=false;try{fs.readFileSync(process.argv[3])}catch(e){denied=e.code==='EACCES'||e.code==='EPERM'}console.log('Starting child with piped stdio');const leaf=JSON.parse(cp.execFileSync(process.argv[2],['--probe-leaf'],{encoding:'utf8'}));if(!denied||!leaf.appContainer)process.exit(1);console.log('node-isolated');");
                var result=await RunTool(tools.Node,[script,System.Environment.ProcessPath!,args[2]]);Add("node-toolchain",result.code==0&&result.output.Contains("node-isolated"),result.code==0?"Node writes workspace, denies host file and keeps a nested process isolated":result.output);
            }catch(Exception e){Add("node-toolchain",false,e.Message);}
            try {
                var script=Path.Combine(workspace,"node-mcp.cjs");
                await File.WriteAllTextAsync(script,"""
const cp=require('node:child_process');
const requests=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'room_read',arguments:{}}}];
const output=cp.execFileSync(process.execPath,[process.argv[2]],{input:requests.map(frame=>JSON.stringify(frame)).join('\n')+'\n',encoding:'utf8',timeout:10000});
const frames=output.trim().split(/\r?\n/).map(line=>JSON.parse(line));
if(frames.length!==3||frames[0].result.protocolVersion!=='2025-06-18'||frames[1].result.tools.map(tool=>tool.name).join(',')!=='room_read,room_post,room_send_image,task_propose,artifact_publish'||frames[2].result.isError||!JSON.parse(frames[2].result.content[0].text).ok)throw new Error('MCP handshake or scoped tool response failed');
console.log('node-room-mcp-ok');
""");
                var result=await RunTool(tools.Node,[script,Path.Combine(Path.GetDirectoryName(tools.Node)!,"room-bridge.mjs")]);
                Add("node-room-mcp",result.code==0&&result.output.Contains("node-room-mcp-ok"),result.code==0?"Real Node stdio MCP initialize, tool discovery and room_read traverse the verified per-Job pipe":result.output);
            }catch(Exception e){Add("node-room-mcp",false,e.Message);}
            try {
                await File.WriteAllTextAsync(Path.Combine(workspace,"package.json"),"{\"name\":\"sandbox-probe\",\"private\":true,\"scripts\":{\"test\":\"node -e \\\"console.log('sandbox-npm-ok')\\\"\"}}");
                var result=await RunTool(tools.Shell,["/d","/c","npm test --silent"]);Add("npm-test",result.code==0&&result.output.Contains("sandbox-npm-ok"),result.code==0?"npm invokes a test inside the isolated workspace":result.output);
            }catch(Exception e){Add("npm-test",false,e.Message);}
            try {
                async Task<string> Git(params string[] arguments){var result=await RunTool(tools.Git,arguments);if(result.code!=0)throw new InvalidOperationException("git "+string.Join(' ',arguments)+" failed: "+result.output);return result.output.Trim();}
                await Git("--version");await Git("-c","init.templateDir=","init","--quiet",".");
                if(await Git("rev-parse","--show-ref-format")!="reftable")throw new InvalidOperationException("The isolated Git default must use reftable");
                await Git("config","user.name","Sandbox probe");await Git("config","user.email","probe@example.invalid");await Git("config","commit.gpgsign","false");await Git("config","core.autocrlf","false");
                string tracked=Path.Combine(workspace,"git-probe.txt");await File.WriteAllTextAsync(tracked,"first\n");
                await Git("add","git-probe.txt");await Git("commit","--quiet","-m","Probe baseline");
                var baseline=await Git("rev-parse","HEAD");
                await Git("switch","--quiet","-c","probe-branch");await File.WriteAllTextAsync(tracked,"second\n");
                if(!(await Git("diff","--","git-probe.txt")).Contains("+second"))throw new InvalidOperationException("Git did not report the expected workspace diff");
                await Git("add","git-probe.txt");await Git("commit","--quiet","-m","Probe modification");
                if(await Git("status","--porcelain","--","git-probe.txt")!="")throw new InvalidOperationException("Committed path is still dirty");
                await Git("rm","--quiet","git-probe.txt");await Git("commit","--quiet","-m","Probe deletion");
                if(File.Exists(tracked))throw new InvalidOperationException("Git deletion did not remove the tracked file");
                await Git("switch","--quiet","--detach",baseline);
                if(await File.ReadAllTextAsync(tracked)!="first\n")throw new InvalidOperationException("Git checkout did not restore the baseline");
                await Git("fsck","--no-reflogs");
                Add("git-toolchain",true,"Staged Git uses reftable and completes init, add, commit, branch, diff, status, deletion, checkout and object checks inside the AppContainer");
            }catch(Exception e){Add("git-toolchain",false,e.Message);}
            try {
                await File.WriteAllTextAsync(Path.Combine(workspace,"shell-probe.cmd"),"@echo off\r\n\""+System.Environment.ProcessPath+"\" --probe-leaf\r\n");
                var result=await RunTool(tools.Shell,["/d","/c","shell-probe.cmd"]);Add("shell-toolchain",result.code==0&&result.output.Contains("true"),result.code==0?"Command shell child remains in AppContainer":result.output);
            }catch(Exception e){Add("shell-toolchain",false,e.Message);}
        }
        Console.WriteLine(JsonSerializer.Serialize(new { ready, checks }, Json));
    }

    static void Check(List<JsonElement> checks,string name,bool passed,string detail)=>checks.Add(JsonSerializer.SerializeToElement(new {name,passed,detail},Json));
    static bool Exited(int pid){try{using var process=Process.GetProcessById(pid);return process.HasExited;}catch(ArgumentException){return true;}}
    internal static void PeerReader(string[] args){
        var checks=new List<JsonElement>();bool denied=false;try{File.ReadAllText(args[1]);}catch(UnauthorizedAccessException){denied=true;}Check(checks,"other-sandbox-file-denied",denied,"Another live AppContainer owns the readable canary; this sandbox cannot read it");
        bool processDenied=true;foreach(uint access in new uint[]{0x1,0x8,0x10,0x20,0x40}){var process=Native.OpenProcess(access,false,int.Parse(args[2]));if(process!=IntPtr.Zero){processDenied=false;Native.CloseHandle(process);}}Check(checks,"other-sandbox-process-denied",processDenied,"Individual read/write, handle-duplication and termination requests must each be denied");
        var pipe=Native.CreateFileW(args[3],0xC0000000,0,IntPtr.Zero,3,0x40000000,IntPtr.Zero);var error=System.Runtime.InteropServices.Marshal.GetLastWin32Error();Check(checks,"other-sandbox-ipc-denied",pipe==new IntPtr(-1)&&(error==5||error==2),"The exact peer pipe path was reachable by the broker but is inaccessible from this sandbox");if(pipe!=new IntPtr(-1))Native.CloseHandle(pipe);
        Console.WriteLine(JsonSerializer.Serialize(new {checks},Json));
    }
    static async Task CheckPeerIsolation(string root,List<JsonElement> checks){
        string id="peer-"+Guid.NewGuid().ToString("N"),directory=Path.Combine(root,"probes",id),peerWorkspace=Path.Combine(directory,"peer-workspace"),peerHome=Path.Combine(directory,"peer-home"),secret=Path.Combine(peerWorkspace,"peer-secret.txt");Directory.CreateDirectory(peerWorkspace);Directory.CreateDirectory(peerHome);File.WriteAllText(secret,"peer-private");
        var ready=new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);var peerOutput=new System.Text.StringBuilder();
        var peerSpec=new LaunchSpec(id,System.Environment.ProcessPath!,["--probe-peer-holder",secret],peerWorkspace,peerHome,[AppContext.BaseDirectory],null,512,16,30000,@"LOCAL\TemptRoom-"+id);
        using var peer=new SandboxProcess(root,peerSpec,value=>{var frame=JsonSerializer.SerializeToElement(value,Json);if(frame.TryGetProperty("stream",out var stream)&&stream.GetString()=="stdout"){peerOutput.Append(frame.GetProperty("data").GetString());if(peerOutput.ToString().Contains('\n')){try{ready.TrySetResult(JsonSerializer.Deserialize<JsonElement>(peerOutput.ToString(),Json).GetProperty("ownsFile").GetBoolean());}catch{}}}});
        try{
            peer.Start();if(!await ready.Task.WaitAsync(TimeSpan.FromSeconds(8)))throw new InvalidOperationException("Peer could not read its own canary");
            var baseline=Native.CreateFileW(peer.PipePath!,0xC0000000,0,IntPtr.Zero,3,0x40000000,IntPtr.Zero);if(baseline==new IntPtr(-1))throw new InvalidOperationException("Peer pipe positive control failed");Native.CloseHandle(baseline);
            var output=new System.Text.StringBuilder();var readerSpec=new LaunchSpec(id+"-reader",System.Environment.ProcessPath!,["--probe-peer-reader",secret,peer.Pid.ToString(),peer.PipePath!],Path.Combine(directory,"reader-workspace"),Path.Combine(directory,"reader-home"),[AppContext.BaseDirectory],null,512,16,15000);Directory.CreateDirectory(readerSpec.Workspace);Directory.CreateDirectory(readerSpec.Home);
            using var reader=new SandboxProcess(root,readerSpec,value=>{var frame=JsonSerializer.SerializeToElement(value,Json);if(frame.TryGetProperty("stream",out var stream)&&stream.GetString()=="stdout")output.Append(frame.GetProperty("data").GetString());});reader.Start();reader.CloseInput();var code=await reader.Wait();
            if(code!=0)throw new InvalidOperationException("Peer isolation reader failed");var result=JsonSerializer.Deserialize<JsonElement>(output.ToString(),Json);foreach(var check in result.GetProperty("checks").EnumerateArray())checks.Add(check.Clone());
        }catch(Exception error){Check(checks,"other-sandbox-isolation",false,error.Message);}
        finally{if(peer.Pid!=0){try{peer.Cancel();await peer.Wait();}catch{}}}
    }
    static async Task CheckCancel(string root,List<JsonElement> checks){
        string id="cancel-"+Guid.NewGuid().ToString("N"),directory=Path.Combine(root,"probes",id);var started=new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);var buffer=new System.Text.StringBuilder();
        var spec=new LaunchSpec(id,System.Environment.ProcessPath!,["--probe-hold-root"],Path.Combine(directory,"workspace"),Path.Combine(directory,"home"),[AppContext.BaseDirectory],null,512,16,20000);
        Directory.CreateDirectory(spec.Workspace);Directory.CreateDirectory(spec.Home);
        using var process=new SandboxProcess(root,spec,value=>{var frame=JsonSerializer.SerializeToElement(value,Json);if(frame.TryGetProperty("stream",out var stream)&&stream.GetString()=="stdout"){buffer.Append(frame.GetProperty("data").GetString());if(buffer.ToString().Contains('\n')){try{started.TrySetResult(JsonSerializer.Deserialize<JsonElement>(buffer.ToString(),Json));}catch{}}}});
        try{
            process.Start();var info=await started.Task.WaitAsync(TimeSpan.FromSeconds(8));int child=info.GetProperty("childPid").GetInt32();
            process.Cancel();await process.Wait();Check(checks,"cancel-process-tree",process.CancelRequested&&Exited(process.Pid)&&Exited(child),"Cancel terminates both the root and a live child; Job accounting confirms zero active processes");
        }catch(Exception e){Check(checks,"cancel-process-tree",false,e.Message);}
    }
    static async Task CheckHostExit(string root,List<JsonElement> checks){
        string id="hostexit-"+Guid.NewGuid().ToString("N"),directory=Path.Combine(root,"probes",id);Directory.CreateDirectory(directory);
        var start=new ProcessStartInfo(System.Environment.ProcessPath!){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};start.ArgumentList.Add("--root");start.ArgumentList.Add(directory);
        using var controller=Process.Start(start)!;Process? rootProcess=null,childProcess=null;var error=controller.StandardError.ReadToEndAsync();
        try{
            var spec=new LaunchSpec(id,System.Environment.ProcessPath!,["--probe-hold-root"],Path.Combine(directory,"workspace"),Path.Combine(directory,"home"),[AppContext.BaseDirectory],null,512,16,20000);
            Directory.CreateDirectory(spec.Workspace);Directory.CreateDirectory(spec.Home);
            await controller.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new {id="launch",method="launch",spec},Json));await controller.StandardInput.FlushAsync();
            using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(10));var buffer=new System.Text.StringBuilder();
            while(true){var line=await controller.StandardOutput.ReadLineAsync(deadline.Token);if(line==null)throw new InvalidOperationException("Probe controller exited: "+await error);var frame=JsonSerializer.Deserialize<JsonElement>(line,Json);if(frame.TryGetProperty("error",out var problem))throw new InvalidOperationException(problem.GetRawText());if(frame.TryGetProperty("stream",out var stream)&&stream.GetString()=="stdout"){buffer.Append(frame.GetProperty("data").GetString());if(buffer.ToString().Contains('\n'))break;}}
            var info=JsonSerializer.Deserialize<JsonElement>(buffer.ToString(),Json);rootProcess=Process.GetProcessById(info.GetProperty("pid").GetInt32());childProcess=Process.GetProcessById(info.GetProperty("childPid").GetInt32());
            controller.Kill();await controller.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));await Task.WhenAll(rootProcess.WaitForExitAsync(),childProcess.WaitForExitAsync()).WaitAsync(TimeSpan.FromSeconds(5));
            Check(checks,"host-exit-process-tree",rootProcess.HasExited&&childProcess.HasExited,"Abrupt controller exit closes its Job handle and terminates root and child without a tree-kill request");
        }catch(Exception e){Check(checks,"host-exit-process-tree",false,e.Message);}
        finally{foreach(var owned in new[]{controller,rootProcess,childProcess}){if(owned!=null){try{if(!owned.HasExited)owned.Kill();}catch{}if(owned!=controller)owned.Dispose();}}}
    }
}
