import { spawn,spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseAgentOutput,heartbeatDelayMs } from './room-runner-output.mjs';

/**
 * Optional "room duty" runner for external Agents.
 *
 * A headless CLI Agent has no event loop of its own. This runner long-polls the
 * room through its scoped MCP tool API, and when the Agent is mentioned it runs
 * the configured local CLI command with the message as prompt, then posts the
 * command's output back into the room as that Agent. Tempt Room still does not
 * manage the Agent process; start/stop this runner yourself (a terminal, a
 * scheduled task, ...). Usage and env vars:
 *
 *   ROOM_URL, ROOM_AGENT_TOKEN, ROOM_ROOM_ID  - values from the connect dialog
 *   ROOM_AGENT_COMMAND                        - absolute path to the CLI
 *   ROOM_AGENT_ARGS                           - JSON array, may contain "{prompt}"
 *   ROOM_AGENT_RESUME_ARGS                    - JSON array appended when a session exists, may contain "{session}"
 *   ROOM_AGENT_SESSION_FILE                   - where to persist the CLI session id (default: temp dir)
 *   ROOM_AGENT_MODE                           - "oneshot" (default) or "persistent" (keep one CLI process, feed stdin)
 *   ROOM_AGENT_CWD                            - working directory (default: cwd)
 *   ROOM_AGENT_TIMEOUT_MS                     - per-wake timeout (default 300000)
 *   ROOM_WAKE_ON                              - human "mention" (default) or any human "message"
 *   ROOM_POST_RESULT                          - "0" disables posting stdout back
 *   ROOM_CLAIM_OPEN                           - "1" also claims open tasks and completes them
 */
const args = parseArgs({ options: {
  url: { type: 'string' }, token: { type: 'string' }, room: { type: 'string' },
  command: { type: 'string' }, args: { type: 'string' }, cwd: { type: 'string' },
  wake: { type: 'string' }, timeout: { type: 'string' }, once: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
}, allowPositionals: false }).values;

if (args.help) { console.log('Usage: node scripts/room-agent-runner.mjs --url URL --token AGENT_TOKEN --room ROOM_ID --command "C:\\path\\agent.exe" [--args \'["-p","{prompt}"]\'] [--wake mention|message] [--once]'); process.exit(0); }

const base = (args.url ?? process.env.ROOM_URL ?? 'http://127.0.0.1:4317').replace(/\/+$/, '');
const token = args.token ?? process.env.ROOM_AGENT_TOKEN;
const roomId = args.room ?? process.env.ROOM_ROOM_ID;
const command = args.command ?? process.env.ROOM_AGENT_COMMAND;
const cwd = args.cwd ?? process.env.ROOM_AGENT_CWD ?? process.cwd();
const wakeOn = (args.wake ?? process.env.ROOM_WAKE_ON ?? 'mention').toLowerCase() === 'message' ? 'message' : 'mention';
const timeoutMs = Number(args.timeout ?? process.env.ROOM_AGENT_TIMEOUT_MS ?? 300000);
const postResult = process.env.ROOM_POST_RESULT !== '0';
const once = Boolean(args.once);
if (!token || !roomId || !command) { console.error('Missing credentials or command. Set ROOM_AGENT_TOKEN, ROOM_ROOM_ID and ROOM_AGENT_COMMAND (or pass flags).'); process.exit(2); }

let argvTemplate;
try { argvTemplate = JSON.parse(args.args ?? process.env.ROOM_AGENT_ARGS ?? '["-p","{prompt}"]'); } catch { console.error('ROOM_AGENT_ARGS must be a JSON array of strings'); process.exit(2); }
if (!Array.isArray(argvTemplate) || argvTemplate.some(item => typeof item !== 'string')) { console.error('ROOM_AGENT_ARGS must be a JSON array of strings'); process.exit(2); }

let resumeTemplate = [];
if (process.env.ROOM_AGENT_RESUME_ARGS) {
  try { resumeTemplate = JSON.parse(process.env.ROOM_AGENT_RESUME_ARGS); } catch { console.error('ROOM_AGENT_RESUME_ARGS must be a JSON array of strings'); process.exit(2); }
  if (!Array.isArray(resumeTemplate) || resumeTemplate.some(item => typeof item !== 'string')) { console.error('ROOM_AGENT_RESUME_ARGS must be a JSON array of strings'); process.exit(2); }
}
const agentId = token.split('.')[0];
const sessionFile = process.env.ROOM_AGENT_SESSION_FILE ?? join(tmpdir(), `tempt-room-agent-${agentId}-${roomId}.json`);
let sessionId;
try { sessionId = JSON.parse(readFileSync(sessionFile, 'utf8'))?.sessionId; } catch { /* first run */ }
const persistentMode = (process.env.ROOM_AGENT_MODE ?? 'oneshot').toLowerCase() === 'persistent';
const claimOpen = process.env.ROOM_CLAIM_OPEN === '1';
const saveSession = id => { try { mkdirSync(dirname(sessionFile), { recursive: true }); writeFileSync(sessionFile, JSON.stringify({ sessionId: id, agentId, roomId, updatedAt: new Date().toISOString() })); } catch (error) { console.error('[room-runner] cannot save session:', error.message); } };

const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'room-protocol-version': '0.1' };
async function tool(name, input = {}, commandId=randomUUID(),requestTimeoutMs=30000) {
  const response = await fetch(base + '/api/agent/tool', { method: 'POST', headers, signal:AbortSignal.timeout(requestTimeoutMs), body: JSON.stringify({ commandId, roomId, name, arguments: input }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? ('room tool HTTP ' + response.status));
  return body.result?.accepted===true?body.result.result:body.result;
}

function buildPrompt(messages) {
  const lines = messages.map(message => `[${message.actor.id}] ${String(message.text)}`).join('\n\n');
  return [
    `你在 Tempt Room 房间 ${roomId} 中被点名。以下是新消息：`, '', lines, '',
    '请在当前目录完成消息要求的工作。你处于无头运行环境，房间读写工具可能不可用；直接输出要发回房间的最终答复正文即可，运行器会把它作为你的房间消息发布。'
  ].join('\n');
}

const ownedChildren=new Set();
function stopCli(child){
  if(!child?.pid||child.exitCode!==null||child.signalCode!==null)return;
  if(process.platform==='win32')spawnSync(join(process.env.SystemRoot??'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000});
  else child.kill('SIGTERM');
}
function track(child){ownedChildren.add(child);child.once('close',()=>ownedChildren.delete(child));return child;}

function runCommand(prompt,signal) {
  return new Promise((resolve, reject) => {
    if(signal?.aborted)return reject(signal.reason);
    const template = sessionId && resumeTemplate.length ? [...argvTemplate, ...resumeTemplate] : argvTemplate;
    const argv = template.map(item => item === '{prompt}' ? prompt : item === '{session}' ? String(sessionId ?? '') : item);
    const env = { ...process.env, ROOM_AGENT_PROMPT: prompt };
    const child = track(spawn(command, argv, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    let stdout = '', stderr = '',settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
    const abort=()=>{stopCli(child);finish(signal.reason);};
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data', chunk => { stdout += chunk; if(stdout.length>1024*1024){stopCli(child);finish(new Error('Agent CLI output exceeded 1 MiB'));} });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setTimeout(() => { stopCli(child);finish(new Error('Agent CLI timed out')); }, timeoutMs);
    child.on('error', error => finish(error));
    child.on('close', code => { if(code!==0)return finish(new Error(`Agent CLI exit ${code}`));try{finish(undefined,parseAgentOutput(stdout));}catch(error){finish(error);} });
    if(signal?.aborted)abort();
  });
}

const log = message => console.error(`[room-runner] ${new Date().toLocaleTimeString()} ${message}`);
let running = true;

/**
 * Persistent mode keeps one CLI process alive and feeds each wake through its
 * stdin (Claude-style `--input-format stream-json`). It avoids process start-up
 * per message; the session id is still persisted for restarts.
 */
let persistentChild = null, persistentBuffer = '', persistentStderr = '', persistentPending = null;
function persistentArgv() {
  const args = argvTemplate.filter(item => item !== '{prompt}');
  if (sessionId && resumeTemplate.length) args.push(...resumeTemplate.map(item => item === '{session}' ? String(sessionId) : item));
  return args;
}
function startPersistent() {
  if (persistentChild) return;
  const child = track(spawn(command, persistentArgv(), { cwd, env: { ...process.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
  persistentChild = child; persistentBuffer = '';persistentStderr='';
  child.stdout.on('data', chunk => {
    if(persistentChild!==child)return;
    persistentBuffer += chunk;
    if(persistentBuffer.length>1024*1024){const pending=persistentPending;persistentPending=null;persistentChild=null;stopCli(child);pending?.finish(new Error('Agent CLI output exceeded 1 MiB'));return;}
    let index;
    while ((index = persistentBuffer.indexOf('\n')) >= 0) {
      const line = persistentBuffer.slice(0, index).trim(); persistentBuffer = persistentBuffer.slice(index + 1);
      if (!line) continue;
      let frame; try { frame = JSON.parse(line); } catch { continue; }
      if(frame?.parent_tool_use_id)continue;
      if (frame?.session_id && ['system','result'].includes(frame.type) && frame.session_id !== sessionId) { sessionId = frame.session_id; saveSession(sessionId); log(`session saved ${sessionId}`); }
      if (frame?.type === 'result' && persistentPending) {
        const pending = persistentPending;persistentPending=null;
        try{pending.finish(undefined,parseAgentOutput(line));}catch(error){pending.finish(error);}
      }
    }
  });
  child.stderr.on('data', chunk => { persistentStderr = (persistentStderr + chunk).slice(-4000); });
  child.on('exit', code => {
    if(persistentChild!==child)return;
    persistentChild = null;
    if (persistentPending) { const pending = persistentPending; persistentPending = null; pending.finish(new Error(`Agent CLI exited (${code})`)); }
    log(`persistent CLI exited (${code}); it will restart on the next wake`);
  });
  child.on('error', error => { if(persistentChild!==child)return;persistentChild=null;const pending=persistentPending;persistentPending=null;pending?.finish(error);log('persistent CLI spawn error: ' + error.message); });
  child.stdin.on('error',error=>{if(persistentChild!==child)return;persistentChild=null;const pending=persistentPending;persistentPending=null;stopCli(child);pending?.finish(error);});
}
function persistentRun(prompt,signal) {
  return new Promise((resolve, reject) => {
    if(signal?.aborted)return reject(signal.reason);
    startPersistent();
    if (!persistentChild) return reject(new Error('Agent CLI is not running'));
    let settled=false;const child=persistentChild;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
    const abort=()=>{persistentPending=null;persistentChild=null;stopCli(child);finish(signal?.reason??new Error('Agent CLI timed out'));};
    const timer=setTimeout(abort,timeoutMs);signal?.addEventListener('abort',abort,{once:true});
    persistentPending = { finish };
    persistentChild.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null }) + '\n', error => {
      if (error && persistentPending?.finish===finish) {persistentPending=null;persistentChild=null;stopCli(child);finish(error);}
    });
    if(signal?.aborted)abort();
  });
}
async function runPrompt(prompt,signal) {
  const result = persistentMode ? await persistentRun(prompt,signal) : await runCommand(prompt,signal);
  if (result.sessionId && result.sessionId !== sessionId) { sessionId = result.sessionId; saveSession(sessionId); log(`session saved ${sessionId}`); }
  return String(result.text ?? '').trim();
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal, () => { log('stopping'); running = false;for(const child of ownedChildren)stopCli(child);process.exit(0); });

let cursor;
try { const status = await tool('room_status'); cursor = status.room?.seq ?? 0; } catch (error) { console.error('[room-runner] Cannot read room:', error.message); process.exit(1); }
log(`listening room=${roomId} wake=${wakeOn} mode=${persistentMode ? 'persistent' : 'oneshot'} cursor=${cursor} command=${command}`);
log(`session=${sessionId ? sessionId + ' (resume enabled)' : 'none (first wake starts a new session)'} file=${sessionFile}`);
if (claimOpen) log('open-task claim polling enabled (ROOM_CLAIM_OPEN=1)');

while (running) {
  if (claimOpen) {
    try {
      const status = await tool('room_status');
      const open = (status.tasks ?? []).find(task => task.open && task.status === 'proposed' && (task.dependencies ?? []).every(id => status.tasks.some(dependency => dependency.id === id && dependency.status === 'completed')));
      if (open) {
        log(`claiming open task ${open.id}: ${String(open.title).slice(0, 80)}`);
        const claim = await tool('task_claim', { taskId: open.id });
        if(!Number.isSafeInteger(claim.version)||!claim.leaseUntil)throw new Error('Server did not return a versioned external task lease');
        const leaseAbort=new AbortController();let leaseError,heartbeat,renewing=true;
        const renew=leaseUntil=>{
          heartbeat=setTimeout(async()=>{
            try{const renewal=await tool('task_heartbeat',{taskId:open.id,taskVersion:claim.version,generation:claim.generation},randomUUID(),Math.max(1,Math.min(5000,heartbeatDelayMs(leaseUntil))));if(renewing)renew(renewal.leaseUntil);}
            catch(error){if(renewing){leaseError=error;leaseAbort.abort(error);log('heartbeat failed: '+error.message);}}
          },heartbeatDelayMs(leaseUntil));
        };
        renew(claim.leaseUntil);
        try {
          const output = await runPrompt([`Tempt Room 开放任务（${open.id}）：`, open.title, '', '请在当前目录完成该任务，并输出要发回房间的结果摘要。'].join('\n'),leaseAbort.signal);
          renewing=false;clearTimeout(heartbeat);
          if(leaseError)throw leaseError;
          const done = await tool('task_complete', { taskId: open.id, taskVersion: claim.version,generation:claim.generation, ok: true, summary: postResult?output.slice(0,8000):'' });
          log(`task completed ${open.id} status=${done.status}`);
        } catch (error) {
          log('claimed task failed: ' + error.message);
          if(!leaseError)await tool('task_complete', { taskId: open.id, taskVersion: claim.version,generation:claim.generation, ok: false, summary: '外部执行失败：' + error.message }).catch(() => {});
        } finally { renewing=false;clearTimeout(heartbeat); }
        if (once) { log('once mode complete'); break; }
        continue;
      }
    } catch (error) { log('open-task poll failed: ' + error.message); }
  }
  let waited;
  try { waited = await tool('room_wait', { afterSeq: cursor, timeoutMs: 20000 }); }
  catch (error) { log('room_wait failed: ' + error.message); await new Promise(resolve => setTimeout(resolve, 2000)); continue; }
  cursor = waited.throughSeq ?? cursor;
  if (waited.timeout) continue;
  const messages = (waited.messages ?? []).filter(message => {
    if (message?.actor?.kind !== 'human') return false;
    return wakeOn === 'message' || (message.mentions ?? []).includes(agentId);
  });
  if (!messages.length) continue;
  log(`woke by ${messages.length} message(s) from ${[...new Set(messages.map(message => message.actor.id))].join(',')}`);
  try {
    const prompt = buildPrompt(messages);
    const output = await runPrompt(prompt);
    if (postResult && output) {
      await tool('room_post', { text: output.slice(0, 30000) });
      log(`posted ${output.length} chars`);
    }
  } catch (error) { log('agent run failed: ' + error.message); }
  if (once) { log('once mode complete'); for(const child of ownedChildren)stopCli(child);break; }
}
for(const child of ownedChildren)stopCli(child);
