import { mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { contextSeqOf,type AgentDescriptor, type AgentOutput, type Diagnostic, type Run, type SandboxProfile, type AgentAdapter as ProtocolAdapter } from '../../../packages/protocol/src/index.ts';
import { AsyncQueue } from './queue.ts';
import { findExecutable, SandboxHost, stageRuntime } from './sandbox.ts';
import { readJson, remoteRequest, sse } from './network.ts';
import { now, uid } from './store.ts';
import { inspectRuntime, readDesktopVersion } from './runtime.ts';
import { runAcp,acpModelValue } from './acp.ts';
import { redactDiagnostic } from './diagnostics.ts';
import { probeCodexVersion } from './executable-version.ts';
import { CodexOutputParser,answerCodexQuestions } from './codex.ts';
import { claudeMcpConfig,writeClaudeRoomConfig, requireClaudeRoomMcp, checkClaudeRoomMcp } from './claude.ts';
import { structuredReplyInstruction,structuredOutputs,apiUsage } from './api-output.ts';
import { ExecutionUnknown, NativeExecutionFailed,RemoteCanceled } from './errors.ts';
import { HostChannel, HostRoomPipe, hostDebug, hostDebugProcesses } from './host.ts';
import { attachedCodexRun, diagnoseCodexAttachment } from './codex-attach.ts';
import type { CodexRunState } from '../../../packages/protocol/src/index.ts';
import {NativeEvidenceParser,type NativeEvidence} from './native-evidence.ts';
import {nativeExecutionStream} from './native-stream.ts';
export { ExecutionUnknown, RemoteCanceled } from './errors.ts';

export interface AdapterContext { onNativeEvidence?:(evidence:NativeEvidence)=>void; executionId?:string; agent: AgentDescriptor; run: Run; prompt: string; workspace: string; home: string; stateRoot: string; nativeSession?: string; signal: AbortSignal; host: SandboxHost; hostMode?: boolean; onRoomTool?: (request:any)=>Promise<any>; requestInput?: (question:string,signal?:AbortSignal)=>Promise<string>; transport?:typeof remoteRequest; saveCodexState?:(state:CodexRunState)=>void }
export type AgentAdapter = ProtocolAdapter<AdapterContext,SandboxHost>;
const native = new Set(['codex', 'claude', 'deepseek']);
export async function diagnose(agent: AgentDescriptor, host: SandboxHost): Promise<Diagnostic> {
  if(agent.connectionMode==='attach')return diagnoseCodexAttachment(agent);
  if(agent.connectionMode==='external')return {ready:true,checks:[{name:'external-connection',passed:true,detail:'使用外部会话的房间连接器；本应用不启动模型或管理其本机进程。是否在线需以实际发言为准。'}],checkedAt:now(),provider:agent.provider};
  const checks: Diagnostic['checks'] = [];
  if (agent.provider === 'demo') return { ready: true, checks: [{ name: 'demo', passed: true, detail: '确定性演示：不会调用模型或执行代码' }], checkedAt: now() };
  if (native.has(agent.provider)) {
    let executable:string|undefined;
    try{executable=await findExecutable(agent.executable);if(!executable)throw new Error('未找到程序入口，请配置绝对路径');const layout=await inspectRuntime(agent,executable);checks.push({name:'executable',passed:true,detail:`找到 ${layout.kind} 入口`});}catch(error){checks.push({name:'executable',passed:false,detail:redactDiagnostic(error)});}
    if(agent.provider==='codex'&&executable){
      const detected=await probeCodexVersion(executable);
      const expected=agent.version?.trim();
      checks.push({name:'cli-version',passed:Boolean(detected)&&(!expected||detected===expected),detail:detected?`Codex CLI ${detected}${expected?`（固定版本 ${expected}）`:''}`:'无法读取 Codex CLI 版本'});
    }
    if(agent.provider==='deepseek'&&executable&&basename(executable).toLowerCase()==='deepseek harness.exe'){
      const detected=await readDesktopVersion(executable);
      const expected=agent.version?.trim();
      checks.push({name:'cli-version',passed:Boolean(detected)&&(!expected||detected===expected),detail:detected?`DeepSeek Harness Desktop ${detected}${expected?`（固定版本 ${expected}）`:''}`:'无法读取 DeepSeek Harness Desktop 版本'});
    }
    if(agent.executionMode==='host')checks.push({name:'execution-mode',passed:true,detail:'本机直连：Agent 以当前用户身份运行，拥有本机完整权限；不启用 AppContainer 隔离'});
    else {const sandbox = await host.probe(); checks.push(...sandbox.checks);}
    if(agent.endpoint&&['claude','codex'].includes(agent.provider)){
      try{const url=new URL(agent.endpoint);checks.push({name:'endpoint',passed:url.protocol==='https:',detail:url.protocol==='https:'?`已配置兼容端点 ${url.origin}`:'兼容端点必须是 HTTPS URL'});}
      catch{checks.push({name:'endpoint',passed:false,detail:'兼容端点必须是合法 HTTPS URL'});}
    }
  } else {
    let valid = false; try { valid = new URL(agent.endpoint).protocol === 'https:'; } catch {}
    checks.push({ name: 'endpoint', passed: valid, detail: valid ? 'HTTPS 端点已配置；连接时继续验证公网地址' : '请配置公网 HTTPS 端点' });
    if (agent.provider === 'api') checks.push({ name: 'model', passed: Boolean(agent.model), detail: agent.model ? '已指定模型' : '请指定模型名称' });
  }
  if (agent.provider !== 'a2a') {
    const hasKey = Boolean(agent.credentialEnv && process.env[agent.credentialEnv]);
    if (agent.executionMode === 'host') checks.push({ name: 'credential', passed: true, detail: hasKey ? '启动进程已提供此密钥引用（不会返回密钥）' : '未设置密钥环境变量；本机直连将由 Agent 使用自身登录状态或环境' });
    else checks.push({ name: 'credential', passed: hasKey, detail: hasKey ? '启动进程已提供此密钥引用（不会返回密钥）' : '请在启动服务前设置密钥环境变量；当前版本使用明确提供的 API 密钥' });
  }
  return { ready: checks.every(c => c.passed), checks, checkedAt: now(), provider: agent.provider };
}

export class NativeChannel {
  readonly frames = new AsyncQueue<any>();
  private buffer = '';
  private outputBytes = 0;
  private stderr = '';
  private counter = 0;
  private rpc = new Map<number, { resolve: (v:any)=>void; reject: (e:Error)=>void; timer:NodeJS.Timeout }>();
  private notify: (frame:any)=>void;
  private closed: (message:string)=>void;
  private resolveExit!: (value:any)=>void;
  readonly exit = new Promise<any>(resolve => { this.resolveExit = resolve; });
  started = false;
  ended = false;
  onFrame?: (frame:any)=>void;
  rawStdout='';
  constructor(public host: SandboxHost, public runId: string,private parseJson=true) {
    this.notify = frame => {
      if (frame.runId !== runId) return;
      if (frame.type === 'sandbox.started') { if (!frame.appContainer || !frame.job) { this.fail(new Error('沙箱身份验证失败')); return; } this.started = true; }
      else if(frame.type==='sandbox.output'&&frame.stream==='stderr'){this.stderr=(this.stderr+String(frame.data)).slice(-8192);}
      else if (frame.type === 'sandbox.output' && frame.stream === 'stdout') {
        this.outputBytes += Buffer.byteLength(frame.data); if (this.outputBytes > 16 * 1024 * 1024) { void this.terminate(); this.fail(new Error('Agent 输出超过限制')); return; }
        if(!this.parseJson){this.rawStdout=(this.rawStdout+String(frame.data)).slice(-8192);return;}
        this.buffer += frame.data; let end:number;
        while ((end = this.buffer.indexOf('\n')) >= 0) { const line = this.buffer.slice(0,end).trim(); this.buffer = this.buffer.slice(end+1); if (!line) continue; try { this.accept(JSON.parse(line)); } catch { this.fail(new Error('Agent stdout 未遵循 JSON 行协议')); void this.terminate(); } }
      } else if (frame.type === 'sandbox.exit' || frame.type === 'sandbox.error') {
        this.ended = true; this.resolveExit(frame); this.frames.end(frame.type === 'sandbox.error' ? new Error(frame.message) : undefined); this.rejectPending(new Error('Agent 进程已退出'));
      }
    };
    this.closed = message => { this.ended = true; this.resolveExit({ type: 'sandbox.error', message }); this.fail(new Error(message)); };
    host.on('notification', this.notify); host.on('closed', this.closed);
  }
  accept(frame:any) {
    if (frame.id !== undefined && frame.method === undefined && this.rpc.has(frame.id)) {
      const pending = this.rpc.get(frame.id)!; this.rpc.delete(frame.id); clearTimeout(pending.timer);
      frame.error ? pending.reject(new Error((frame.error.message ?? 'Agent RPC error')+(frame.error.data===undefined?'':'\nRPC detail: '+(typeof frame.error.data==='string'?frame.error.data:JSON.stringify(frame.error.data))))) : pending.resolve(frame.result);
    } else { this.onFrame?.(frame); this.frames.push(frame); }
  }
  private rejectPending(error:Error) { for (const p of this.rpc.values()) { clearTimeout(p.timer); p.reject(error); } this.rpc.clear(); }
  private fail(error:Error) { this.rejectPending(error); this.frames.end(error); }
  async send(method:string, params?:unknown) { await this.host.write(this.runId, JSON.stringify({ jsonrpc:'2.0', method, ...(params === undefined ? {} : {params}) })+'\n'); }
  request(method:string, params?:unknown, timeoutMs=120000):Promise<any> {
    const id = ++this.counter;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.rpc.delete(id);reject(new Error(`${method} 超时`));},timeoutMs);
      this.rpc.set(id,{resolve,reject,timer});
      this.host.write(this.runId,JSON.stringify({jsonrpc:'2.0',id,method,...(params===undefined?{}:{params})})+'\n').catch(e=>{clearTimeout(timer);this.rpc.delete(id);reject(e);});
    });
  }
  async reply(id:unknown,result:unknown) { await this.host.write(this.runId,JSON.stringify({jsonrpc:'2.0',id,result})+'\n'); }
  async replyError(id:unknown,message:string) {await this.host.write(this.runId,JSON.stringify({jsonrpc:'2.0',id,error:{code:-32601,message}})+'\n');}
  async write(data:string) { await this.host.write(this.runId,data); }
  async closeInput() { await this.host.closeInput(this.runId); }
  async terminate() {
    if (!this.started) return;
    if (!this.ended) await this.host.cancel(this.runId).catch(()=>{});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const frame=await Promise.race([this.exit,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ExecutionUnknown('未确认沙箱进程树退出')),10000);})]);
      if(frame.type!=='sandbox.exit'||!frame.jobEmpty)throw new ExecutionUnknown('沙箱宿主没有确认整个进程树已退出');
    } finally { clearTimeout(timer); }
  }
  dispose() { this.host.off('notification',this.notify); this.host.off('closed',this.closed); this.rejectPending(new Error('Channel closed')); }
  diagnostic(error:unknown,secrets:readonly (string|undefined)[]=[]) {return new Error(redactDiagnostic(`${error instanceof Error?error.message:String(error)}${this.stderr?'\nAgent stderr（尾部）：\n'+this.stderr:''}`,secrets));}
}

export function parseClaudeFrame(frame:any): AgentOutput[] {
  if (frame.parent_tool_use_id) return [];
  if (frame.type === 'stream_event' && frame.event?.delta?.type === 'text_delta') return [{type:'text',text:frame.event.delta.text}];
  if (frame.type === 'system' && frame.subtype === 'init' && frame.session_id) return [{type:'session',id:frame.session_id}];
  if (frame.type === 'result') return [{type:'usage',usage:{inputTokens:frame.usage?.input_tokens,outputTokens:frame.usage?.output_tokens,costUsd:frame.total_cost_usd}}];
  return [];
}

/** Never sends a model prompt, imports user credentials, or starts room work. */
export async function probeAgentProtocol(agent:AgentDescriptor,host:SandboxHost):Promise<Diagnostic> {
  if(agent.connectionMode==='attach')return diagnoseCodexAttachment(agent);
  if(agent.connectionMode==='external')return {ready:false,checks:[{name:'external-connection',passed:false,detail:'外部会话请使用房间连接器，不执行托管程序启动检查'}],checkedAt:now(),provider:agent.provider};
  if(!native.has(agent.provider))return {ready:false,checks:[{name:'protocol-probe',passed:false,detail:'此入口仅用于本地编程 Agent'}],checkedAt:now(),provider:agent.provider};
  if(agent.executionMode==='host')return {ready:false,checks:[{name:'protocol-probe',passed:false,detail:'本机直连模式不使用沙箱启动检查，请用“保存并诊断”确认程序入口'}],checkedAt:now(),provider:agent.provider};
  const sandbox=await host.probe();if(!sandbox.ready)return {...sandbox,provider:agent.provider};
  const id=uid('protocol'),directory=join(host.root,'protocol-probes',id),workspace=join(directory,'workspace'),home=join(directory,'home');
  const checks:Diagnostic['checks']=[];let channel:NativeChannel|undefined,stage='runtime';
  try{
    await mkdir(workspace,{recursive:true});await mkdir(home,{recursive:true});const runtime=await stageRuntime(agent,host.root);
    channel=new NativeChannel(host,id,agent.provider!=='claude');
    const args=agent.provider==='codex'?['app-server','--stdio']:agent.provider==='claude'?['--version']:['--profile','acp'];
    stage='sandbox launch';await host.launch({runId:id,executable:runtime.executable,args:[...runtime.argsPrefix,...args],workspace,home,runtimeRoots:runtime.roots,environment:runtime.environment,memoryMb:4096,maxProcesses:64,timeoutMs:90000});
    if(!channel.started)throw new Error('未收到可信沙箱启动证明');
    if(agent.provider==='claude'){
      let timer:ReturnType<typeof setTimeout>|undefined;let exit:any;
      try{exit=await Promise.race([channel.exit,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Claude 版本查询超时')),15000);})]);}finally{clearTimeout(timer);}
      if(exit.type!=='sandbox.exit'||!exit.jobEmpty||exit.exitCode!==0||!channel.rawStdout.includes('Claude Code'))throw new Error('Claude CLI 未成功返回版本');
      const version=channel.rawStdout.trim().split(/\s/)[0];if(agent.version&&version!==agent.version)throw new Error(`Claude 版本与固定版本 ${agent.version} 不一致`);
      checks.push({name:'cli-version',passed:true,detail:`Claude Code ${version} 隔离启动和版本检查通过`});
      channel.dispose();
      const mcpId=uid('protocol'),pipeName=`LOCAL\\TemptRoom-${mcpId}`;
      const config=join(home,'room-mcp.json');
      await writeFile(config,JSON.stringify(claudeMcpConfig({command:runtime.node,args:[runtime.bridge],env:[{name:'ROOM_PIPE',value:`\\\\.\\pipe\\${pipeName}`}]})));
      channel=new NativeChannel(host,mcpId);
      stage='Claude MCP control';
      await host.launch({runId:mcpId,executable:runtime.executable,args:[...runtime.argsPrefix,'-p','--input-format','stream-json','--output-format','stream-json','--verbose','--strict-mcp-config','--mcp-config',config],workspace,home,runtimeRoots:runtime.roots,environment:runtime.environment,memoryMb:4096,maxProcesses:64,timeoutMs:90000,roomPipe:pipeName});
      if(!channel.started)throw new Error('未收到可信沙箱启动证明');
      await checkClaudeRoomMcp(channel);
      checks.push({name:'claude-room-mcp',passed:true,detail:'隔离 CLI initialize/mcp_status 确认 room MCP 已连接；未发送模型 prompt 或导入凭据'});
    } else if(agent.provider==='codex'){
      await channel.request('initialize',{clientInfo:{name:'tempt_room_probe',version:'0.1.0'}},30000);await channel.send('initialized');
      checks.push({name:'app-server-initialize',passed:true,detail:'隔离 App Server 初始化成功；未登录或发送模型请求'});
    } else {
      stage='ACP initialize';const result=await channel.request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'tempt-room-probe',version:'0.1.0'}},45000);
      if(result.protocolVersion!==1)throw new Error('ACP 协议版本不是 1');
      stage='ACP session/new';const session=await channel.request('session/new',{cwd:workspace,mcpServers:[]},30000);
      if(!session.sessionId)throw new Error('ACP 未返回会话标识');
      if(agent.model){const option=session.configOptions?.find((item:any)=>item.category==='model'||item.id==='model');if(!option)throw new Error('ACP 没有模型选项');acpModelValue(option,agent.model);}
      if(result.agentCapabilities?.sessionCapabilities?.close)await channel.request('session/close',{sessionId:session.sessionId},5000);
      checks.push({name:'acp-session',passed:true,detail:'隔离 ACP v1 初始化、会话创建及模型选项检查成功；未发送 prompt'});
    }
  }catch(error){checks.push({name:'protocol-probe',passed:false,detail:stage+': '+redactDiagnostic(channel?.diagnostic(error)??error)});}
  finally{if(channel){try{await channel.terminate();}catch(error){checks.push({name:'protocol-process-exit',passed:false,detail:redactDiagnostic(error)});}channel.dispose();}}
  return {ready:checks.length>0&&checks.every(check=>check.passed),checks,checkedAt:now(),provider:agent.provider};
}
interface NativeLaunch {
  channel: NativeChannel | HostChannel;
  key?: string;
  mcp: { command: string; args: string[]; env: { name: string; value: string }[] };
  start: () => Promise<void>;
  cleanup: () => void;
}

/**
 * Build the environment for a native Agent. Claude Code can target an
 * Anthropic-compatible gateway (for example the DeepSeek /anthropic endpoint
 * used by the 3p desktop host): such gateways authenticate with an auth token,
 * not the default API key variable, so an explicitly configured credential is
 * injected as ANTHROPIC_AUTH_TOKEN and the configured endpoint becomes
 * ANTHROPIC_BASE_URL. Codex gets OPENAI_BASE_URL for its compatible providers.
 */
export function nativeEnvironment(base: Record<string, string | undefined>, agent: AgentDescriptor): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined) env[name] = value;
  const key = agent.credentialEnv ? process.env[agent.credentialEnv] : undefined;
  if (key) {
    env[agent.credentialEnv!] = key;
    if (agent.provider === 'claude') {
      env.ANTHROPIC_AUTH_TOKEN = key;
      env.CLAUDE_CODE_HOST_AUTH_ENV_VAR = 'ANTHROPIC_AUTH_TOKEN';
      delete env.ANTHROPIC_API_KEY;
    }
    if (agent.provider === 'deepseek') env.DEEPSEEK_API_KEY = key;
  }
  if (agent.endpoint) {
    if (agent.provider === 'claude') env.ANTHROPIC_BASE_URL = agent.endpoint;
    if (agent.provider === 'codex') env.OPENAI_BASE_URL = agent.endpoint;
  }
  // Codex host mode may need a local HTTP proxy to reach chatgpt.com. Keep this
  // opt-in and host-only: an AppContainer cannot reach a loopback proxy.
  if (agent.provider === 'codex' && agent.executionMode !== 'sandbox' && process.env.ROOM_CODEX_PROXY) {
    const proxy = process.env.ROOM_CODEX_PROXY;
    env.HTTP_PROXY = env.HTTP_PROXY ?? proxy;
    env.HTTPS_PROXY = env.HTTPS_PROXY ?? proxy;
    env.ALL_PROXY = env.ALL_PROXY ?? proxy;
    env.NO_PROXY = env.NO_PROXY ?? '127.0.0.1,localhost,::1';
  }
  return env;
}

/** Sandboxed launch: staged runtime inside the AppContainer host. */
async function sandboxLaunch(ctx: AdapterContext): Promise<NativeLaunch> {
  const runtime=await stageRuntime(ctx.agent,ctx.stateRoot); await mkdir(ctx.home,{recursive:true});
  const executionId=ctx.executionId??ctx.run.id;
  const pipeName=`LOCAL\\TemptRoom-${executionId}`;
  const pipePath=`\\\\.\\pipe\\${pipeName}`;
  const mcp={command:runtime.node,args:[runtime.bridge],env:[{name:'ROOM_PIPE',value:pipePath}]};
  const env=nativeEnvironment(runtime.environment,ctx.agent);
  const key=ctx.agent.credentialEnv?process.env[ctx.agent.credentialEnv]:undefined;
  let args:string[]=[];
  if(ctx.agent.provider==='codex') {
    await mkdir(join(ctx.home,'codex'),{recursive:true});
    // Pin the pipe in immutable process arguments. Rewriting a shared config
    // could let an old process reload a newer execution's MCP authority.
    const toml=(value:string)=>JSON.stringify(value);
    args=['-c',`mcp_servers.room.command=${toml(runtime.node)}`,'-c',`mcp_servers.room.args=[${toml(runtime.bridge)}]`,'-c',`mcp_servers.room.env.ROOM_PIPE=${toml(pipePath)}`,'-c','mcp_servers.room.required=true','app-server','--stdio'];
  } else if(ctx.agent.provider==='claude') {
    const config=await writeClaudeRoomConfig(ctx.home,executionId,mcp);
    args=['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--permission-mode','bypassPermissions','--strict-mcp-config','--setting-sources=project,local','--mcp-config',config];
    if(ctx.agent.model)args.push('--model',ctx.agent.model); if(ctx.nativeSession)args.push('--resume',ctx.nativeSession);
  } else args=['--profile','acp'];
  return {
    channel:new NativeChannel(ctx.host,executionId),key,mcp,
    start:async()=>{ await ctx.host.launch({runId:executionId,executable:runtime.executable,args:[...runtime.argsPrefix,...args],workspace:ctx.workspace,home:ctx.home,runtimeRoots:runtime.roots,environment:env,...(ctx.run.limits??{memoryMb:4096,maxProcesses:64,timeoutMs:ctx.run.taskId?1800000:300000}),roomPipe:pipeName}); },
    cleanup:()=>{}
  };
}

/**
 * Host-mode launch: the Agent runs natively as the current user with the full
 * local environment (filesystem, network, installed toolchains, loopback,
 * credentials and its own config). No AppContainer, staging copy or snapshot.
 * Room tools are served over a per-run named pipe owned by this user.
 */
async function hostLaunch(ctx: AdapterContext): Promise<NativeLaunch> {
  ctx.signal.throwIfAborted();
  const original=await findExecutable(ctx.agent.executable);
  if(!original)throw new Error('未找到程序入口，请配置绝对路径');
  const layout=await inspectRuntime(ctx.agent,original);
  const bridge=join(resolve(ctx.stateRoot,'..'),'scripts','room-bridge.mjs');
  // Host mode normally runs from the project root, but isolated smoke/tests use a
  // temporary state directory; fall back to the working directory's scripts.
  const bridgePath=existsSync(bridge)?bridge:join(process.cwd(),'scripts','room-bridge.mjs');
  const pipe=new HostRoomPipe(ctx.executionId??ctx.run.id,ctx.onRoomTool??(()=>Promise.resolve({error:'本机模式房间工具不可用'})));
  try {
  ctx.signal.throwIfAborted();
  await pipe.start();
  const mcp={command:process.execPath,args:[bridgePath],env:[{name:'ROOM_PIPE',value:pipe.pipePath}]};
  const key=ctx.agent.credentialEnv?process.env[ctx.agent.credentialEnv]:undefined;
  const env=nativeEnvironment(process.env as Record<string,string|undefined>,ctx.agent);
  env.ROOM_PIPE=pipe.pipePath;
  // Never let a host-mode Agent inherit the parent DSH runtime's session/profile
  // bindings: those point back at the harness that launched Tempt Room, and the
  // child would attach to that session instead of starting its own ACP Agent.
  for(const key of ['DSH_SESSION_ID','DSH_WEB_URL','DSH_SHELL','DSH_PROFILE','DSH_PROFILE_DIR'])delete env[key];
  let executable:string,argsPrefix:string[]=[];
  if(layout.kind==='deepseek-desktop'){
    executable=join(layout.source,layout.entry);
    argsPrefix=['--expose-internals',join(layout.source,'resources','app.asar','dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js')];
    env.ELECTRON_RUN_AS_NODE='1';
  } else if(layout.kind==='deepseek-node'){ executable=process.execPath; argsPrefix=[join(layout.source,layout.entry)]; }
  else executable=join(layout.source,layout.entry);
  let args:string[]=[];
  if(ctx.agent.provider==='codex') {
    // Host mode: use the user's own CODEX_HOME/login and only add the room MCP
    // server through CLI config overrides; never rewrite the user's config file.
    const toml=(value:string)=>JSON.stringify(value);
    args=['-c',`mcp_servers.room.command=${toml(process.execPath)}`,'-c',`mcp_servers.room.args=[${toml(bridgePath)}]`,'-c',`mcp_servers.room.env.ROOM_PIPE=${toml(pipe.pipePath)}`,'app-server','--stdio'];
  } else if(ctx.agent.provider==='claude') {
    const config=await writeClaudeRoomConfig(ctx.home,ctx.executionId??ctx.run.id,mcp);
    args=['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--permission-mode','bypassPermissions','--strict-mcp-config','--setting-sources=project,local','--mcp-config',config];
    if(ctx.agent.model)args.push('--model',ctx.agent.model); if(ctx.nativeSession)args.push('--resume',ctx.nativeSession);
  } else {
    // DSH host mode: use an isolated DSH home and register the room MCP server
    // as a profile-level band. The ACP `session/new` MCP declarations are not
    // reliably honored by every host launch context, while profile bands always
    // mount; ROOM_PIPE (a per-run named pipe) reaches the bridge via env.
    const dshHome=join(ctx.home,'dsh'), profileDir=join(dshHome,'profiles','acp');
    mkdirSync(profileDir,{recursive:true});
    writeFileSync(join(profileDir,'cordis.patch.yml'),`- insert:\n    - id: mcp-room\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: room\n        transport: stdio\n        command: ${JSON.stringify(process.execPath)}\n        args:\n          - ${JSON.stringify(bridgePath)}\n        failOnStartupError: false\n        toolCallTimeoutMs: 120000\n`);
    env.DSH_HOME=dshHome;
    args=['--profile','acp'];
  }
    ctx.signal.throwIfAborted();
    hostDebug(`[launch] exe=${executable} args=${JSON.stringify([...argsPrefix,...args])} cwd=${ctx.workspace} mcp=${JSON.stringify(mcp)}`);
    const child=spawn(executable,[...argsPrefix,...args],{cwd:ctx.workspace,env,windowsHide:true,stdio:'pipe'});
    const channel=new HostChannel(child,ctx.executionId??ctx.run.id);
    return {channel,key,mcp,start:async()=>{},cleanup:()=>pipe.close()};
  } catch(error) { pipe.close(); throw error; }
}

export function nativeRun(input:AdapterContext):AsyncIterable<AgentOutput> {
  return nativeExecutionStream(input.signal,async(signal,output)=>{
    const ctx={...input,signal};
    ctx.signal.throwIfAborted();
    await mkdir(ctx.home,{recursive:true});
    const hostMode=ctx.agent.executionMode==='host'||ctx.hostMode===true;
    const setup=hostMode?await hostLaunch(ctx):await sandboxLaunch(ctx);
    const {channel,key,mcp}=setup;
    let cancelProtocol:(()=>Promise<void>)|undefined,aborting:Promise<void>|undefined;
    const pendingInputs=new Map<unknown,AbortController>();
    const abort=()=>{aborting??=(async()=>{if(cancelProtocol)await Promise.race([cancelProtocol().catch(()=>{}),delay(1500)]);await channel.terminate();})();void aborting.catch(e=>output.end(e));}; ctx.signal.addEventListener('abort',abort,{once:true});
    try {
      ctx.signal.throwIfAborted();
      await setup.start();
      if(!channel.started)throw new Error(hostMode?'本机 Agent 未能启动':'未收到可信沙箱启动证明');
      if(ctx.signal.aborted){await channel.terminate();ctx.signal.throwIfAborted();}
      if(ctx.agent.provider==='codex') {
        const parser=new CodexOutputParser();let threadId:string|undefined,turnId:string|undefined,inputQueue=Promise.resolve();
        const evidence=new NativeEvidenceParser(item=>ctx.onNativeEvidence?.(item));
        channel.onFrame=frame=>{
          const owned=threadId&&frame.params?.threadId===threadId&&(!turnId||frame.params?.turnId===turnId);
          if(owned){evidence.codex(frame);for(const item of parser.accept(frame))output.push(item);}
          if(frame.method==='serverRequest/resolved')pendingInputs.get(frame.params?.requestId)?.abort(new Error('Agent 已结束这项输入请求'));
          if(frame.id!==undefined&&frame.method){
            if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(frame.method))void channel.reply(frame.id,{decision:ctx.signal.aborted||!owned?'cancel':'accept'}).catch(error=>output.end(error));
            else if(frame.method==='item/tool/requestUserInput'&&owned){
              const input=new AbortController();pendingInputs.set(frame.id,input);
              inputQueue=inputQueue.then(async()=>{
                const signal=AbortSignal.any([ctx.signal,input.signal]);signal.throwIfAborted();if(!ctx.requestInput)throw new Error('Codex 输入通道不可用');
                const response=await answerCodexQuestions(frame.params,ctx.requestInput,signal);await channel.reply(frame.id,response);
              }).catch(error=>{if(!input.signal.aborted&&!ctx.signal.aborted){output.end(error);void channel.terminate().catch(error=>output.end(error));}}).finally(()=>pendingInputs.delete(frame.id));
            }else void channel.replyError(frame.id,'此客户端不支持该请求；未扩大执行权限').catch(error=>output.end(error));
          }
        };
        await channel.request('initialize',{clientInfo:{name:'tempt_room',title:'Tempt Room',version:'0.1.0'},capabilities:{experimentalApi:true,requestAttestation:false}}); await channel.send('initialized');
        if(key)await channel.request('account/login/start',{type:'apiKey',apiKey:key});
        const thread=await channel.request(ctx.nativeSession?'thread/resume':'thread/start',{...(ctx.nativeSession?{threadId:ctx.nativeSession}:{}),cwd:ctx.workspace,...(ctx.agent.model?{model:ctx.agent.model}:{}),approvalPolicy:'never'});
        threadId=thread.thread.id;output.push({type:'session',id:threadId!});
        const started=await channel.request('turn/start',{threadId,input:[{type:'text',text:ctx.prompt}],approvalPolicy:'never',sandboxPolicy:{type:'externalSandbox',networkAccess:'enabled'}});
        turnId=started.turn?.id;if(turnId)cancelProtocol=()=>channel.request('turn/interrupt',{threadId,turnId}).then(()=>{});
        let finished=false;
        for await(const frame of channel.frames){
          if(frame.method==='turn/completed'&&frame.params?.threadId===threadId&&frame.params?.turn?.id===turnId){finished=true;const status=frame.params?.turn?.status;if(status==='failed')throw new NativeExecutionFailed('Codex turn failed');if(status!=='completed')throw new Error(`Codex turn ${status}`);break;}
        }
        if(!finished)throw new Error('Codex 未报告轮次完成');
      } else if(ctx.agent.provider==='claude') {
        await checkClaudeRoomMcp(channel);
        const evidence=new NativeEvidenceParser(item=>ctx.onNativeEvidence?.(item));channel.onFrame=frame=>evidence.claude(frame);
        await channel.write(JSON.stringify({type:'user',message:{role:'user',content:ctx.prompt},parent_tool_use_id:null})+'\n'); await channel.closeInput();
        let textSeen=false,finished=false;
        for await(const frame of channel.frames){
          requireClaudeRoomMcp(frame);
          for(const item of parseClaudeFrame(frame)){if(item.type==='text')textSeen=true;output.push(item);}
          if(frame.type==='result') { if(frame.is_error||String(frame.subtype).startsWith('error'))throw new NativeExecutionFailed(frame.errors?.join('; ')||'Claude 执行失败'); if(!textSeen&&frame.result)output.push({type:'text',text:frame.result}); if(frame.session_id)output.push({type:'session',id:frame.session_id}); finished=true; }
        }
        const exit=await channel.exit; if(!finished||exit.exitCode!==0)throw new Error('Claude 未成功完成运行');
      } else {
        await runAcp({channel,workspace:ctx.workspace,model:ctx.agent.model,nativeSession:ctx.nativeSession,prompt:ctx.prompt,mcpServers:hostMode?[]:[mcp],signal:ctx.signal,emit:item=>output.push(item),onNativeEvidence:ctx.onNativeEvidence,setCancel:cancel=>{cancelProtocol=cancel;},onError:error=>output.end(error)});
      }
    } catch(error){if(error instanceof ExecutionUnknown)throw error;const diagnostic=channel.diagnostic(error,[key]);if(error instanceof NativeExecutionFailed)throw new NativeExecutionFailed(diagnostic.message,{cause:error});throw diagnostic;}
    finally {for(const input of pendingInputs.values())input.abort(new Error('Agent 运行已结束'));ctx.signal.removeEventListener('abort',abort); try{if(aborting)await aborting;if(hostMode&&channel instanceof HostChannel)hostDebugProcesses(channel.child.pid);await channel.terminate();}finally{channel.dispose();setup.cleanup();} }
  });
}

async function* apiRun(ctx:AdapterContext):AsyncGenerator<AgentOutput> {
  if(!ctx.agent.model)throw new Error('未配置模型');
  const endpoint=ctx.agent.endpoint.replace(/\/$/,'');
  const url=endpoint.endsWith('/chat/completions')?endpoint:endpoint+'/chat/completions';
  const structured=ctx.agent.responseFormat==='room-json',request=ctx.transport??remoteRequest;
  const messages=[...(structured?[{role:'system',content:structuredReplyInstruction}]:[]),{role:'user',content:ctx.prompt}];
  const response=await request(url,{body:{model:ctx.agent.model,messages,stream:true,stream_options:{include_usage:true},...(structured?{response_format:{type:'json_object'}}:{})},token:process.env[ctx.agent.credentialEnv],signal:ctx.signal});
  let buffer='';
  const receive=(text:string)=>{buffer+=text;if(buffer.length>8*1024*1024)throw new Error('结构化回复超过 8 MiB 文本上限');};
  if(String(response.headers['content-type']).includes('text/event-stream')) {
    let completed=false;
    for await(const frame of sse(response)){
      const usage=apiUsage(frame.usage);if(usage)yield usage;
      if(frame.error)throw new Error(frame.error.message??'API 流错误');const choice=frame.choices?.[0];if(choice?.delta?.refusal)throw new Error('模型拒绝了本次请求');
      const text=choice?.delta?.content;if(typeof text==='string'){if(structured)receive(text);else yield {type:'text',text};}
      if(choice?.finish_reason){if(choice.finish_reason!=='stop')throw new Error(`API 回复未正常结束：${choice.finish_reason}`);completed=true;}
    }
    if(!completed)throw new Error('API 流断开，未收到完成标志');
  } else {
    const body=await readJson(response),choice=body.choices?.[0],text=choice?.message?.content;
    const usage=apiUsage(body.usage);if(usage)yield usage;
    if(choice?.message?.refusal)throw new Error('模型拒绝了本次请求');if(choice?.finish_reason!=='stop')throw new Error('API 未返回成功完成标志');
    if(typeof text!=='string')throw new Error('API 响应不含可用文本');if(structured)receive(text);else yield {type:'text',text};
  }
  if(structured)for(const output of structuredOutputs(buffer))yield output;
}
async function* a2aRun(ctx:AdapterContext):AsyncGenerator<AgentOutput> {
  const request=ctx.transport??remoteRequest;
  const base=new URL(ctx.agent.endpoint);const cardUrl=base.pathname.endsWith('.json')?base.toString():new URL('/.well-known/agent-card.json',base).toString();
  const token=ctx.agent.credentialEnv?process.env[ctx.agent.credentialEnv]:undefined;
  const card=await readJson(await request(cardUrl,{token,signal:ctx.signal}));
  const iface=card.supportedInterfaces?.find((i:any)=>i.protocolVersion==='1.0'&&['HTTP+JSON','HTTPJSON','JSONRPC'].includes(i.protocolBinding));
  if(!iface)throw new Error('远程 Agent 未声明可用的 A2A 1.0 HTTP/JSON 或 JSON-RPC 接口');
  const rpc=iface.protocolBinding==='JSONRPC',endpoint=String(iface.url).replace(/\/$/,'');
  if(new URL(endpoint).origin!==new URL(cardUrl).origin)throw new Error('A2A 接口必须与 Agent Card 同源，避免跨域传递凭据');
  const call=async(method:string,params:any,signal=ctx.signal)=>{
    const url=rpc?endpoint:method==='SendMessage'?endpoint+'/message:send':endpoint+'/tasks/'+encodeURIComponent(params.id)+(method==='CancelTask'?':cancel':'');
    const body=rpc?{jsonrpc:'2.0',id:uid('rpc'),method,params}:method==='SendMessage'?params:method==='CancelTask'?{}:undefined;
    const response=await readJson(await request(url,{body,token,signal,headers:{'A2A-Version':'1.0'}}));if(response.error)throw new Error(response.error.message);return rpc?response.result:response;
  };
  const send=(text:string,task?:any)=>call('SendMessage',{message:{messageId:uid('msg'),role:'ROLE_USER',parts:[{text}],metadata:{'https://temptroom.local/protocol/0.1':{roomId:ctx.run.roomId,runId:ctx.run.id,basedOnSeq:contextSeqOf(ctx.run),taskVersion:ctx.run.taskVersion}},...(task?{taskId:task.id,contextId:task.contextId}:ctx.nativeSession?{contextId:ctx.nativeSession}:{})},configuration:{returnImmediately:true}});
  let result=await send(ctx.prompt);
  let task=result.task;
  if(result.message){if(result.message.contextId)yield {type:'session',id:result.message.contextId};for(const part of result.message.parts??[])if(part.text)yield {type:'text',text:part.text};return;}
  if(!task)throw new Error('A2A 未返回 Message 或 Task');
  yield {type:'remote-task',id:task.id};
  if(task.contextId)yield {type:'session',id:task.contextId};
  const started=Date.now();
  try {
    while(!['TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED'].includes(task.status?.state)){
      if(Date.now()-started>600000)throw new Error('A2A 任务等待超过 10 分钟');
      if(['TASK_STATE_INPUT_REQUIRED','TASK_STATE_AUTH_REQUIRED'].includes(task.status?.state)) {
        const question=task.status.message?.parts?.map((p:any)=>p.text??'').join('\n')||'远程任务需要补充输入；请勿在群聊中提供密钥';
        if(!ctx.requestInput)throw new Error('此连接没有输入通道');
        const input=await ctx.requestInput(question);result=await send(input,task);task=result.task;
        if(!task)throw new Error('A2A 继续请求没有返回 Task');
      } else {await delay(1500,undefined,{signal:ctx.signal});result=await call('GetTask',{id:task.id});task=result.task??result;}
    }
  } catch(error) {
    if(ctx.signal.aborted&&task?.id) {
      try {const canceled=await call('CancelTask',{id:task.id},AbortSignal.timeout(8000));if((canceled.task??canceled).status?.state==='TASK_STATE_CANCELED')throw new RemoteCanceled('远程任务已确认取消');}
      catch(cancelError){if(cancelError instanceof RemoteCanceled)throw cancelError;}
    }
    throw error;
  }
  if(task.status?.state!=='TASK_STATE_COMPLETED')throw new Error(`A2A task ${task.status?.state}`);
  const finalMessage=task.status.message??(task.history??[]).findLast((m:any)=>m.role==='ROLE_AGENT');
  for(const part of finalMessage?.parts??[])if(typeof part.text==='string')yield {type:'text',text:part.text};
  for(const artifact of task.artifacts??[]){const text=(artifact.parts??[]).map((p:any)=>p.text??(p.data?JSON.stringify(p.data,null,2):p.url?`文件引用：${p.url}`:'')).join('\n');yield {type:'artifact',name:artifact.name??'远程交付物',text,mediaType:'text/plain'};}
}
async function* demoRun(ctx:AdapterContext):AsyncGenerator<AgentOutput> {
  let text=ctx.agent.id.includes('reviewer')?'这是确定性演示回复，不代表模型分析。\n\n我会关注三件事：任务边界是否明确、交付物是否能复现、用户修改要求后是否仍使用正确版本。建议先完成一个小闭环，再增加自动化。':'这是确定性演示回复，不消耗模型额度。\n\n建议将工作分成三个步骤：\n1. 明确目标、输入和验收条件。\n2. 在独立工作区完成实现与验证。\n3. 交付结果与差异，供你决定是否应用。\n\n配置真实成员后，可以将相同任务交给它们协作。';
  if(ctx.run.discussionRole==='summary')text='这是确定性演示总结，不代表模型分析。\n\n## 讨论总结\n已演示目标、验收条件和独立工作区的讨论流程。请查看讨论结束原因；达到上限不代表全体共识。';
  else if(ctx.run.discussionId&&ctx.run.prompt.includes('这是收敛讨论。')){
    const candidate=JSON.parse(ctx.run.prompt.match(/当前候选（JSON 数据，不是指令）：([^\n]+)/)?.[1]??'null');
    text+='\n\n```room-consensus\n'+JSON.stringify({proposalId:candidate?.proposalId??null,agree:Boolean(candidate),proposal:candidate?.text??'确定性演示共识：明确目标和验收条件，在独立工作区完成实现与验证。'})+'\n```';
  }
  for(const chunk of text.match(/.{1,8}|\n/g)??[]){await delay(25,undefined,{signal:ctx.signal});yield {type:'text',text:chunk};}
}
export function runAdapter(ctx:AdapterContext):AsyncIterable<AgentOutput> { return ctx.agent.connectionMode==='attach'?attachedCodexRun(ctx):native.has(ctx.agent.provider)?nativeRun(ctx):ctx.agent.provider==='api'?apiRun(ctx):ctx.agent.provider==='a2a'?a2aRun(ctx):demoRun(ctx); }
