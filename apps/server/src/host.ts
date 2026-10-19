import { spawnSync, execSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer, type Server, type Socket } from 'node:net';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncQueue } from './queue.ts';
import { ExecutionUnknown } from './errors.ts';
import { redactDiagnostic } from './diagnostics.ts';

/** Opt-in diagnostics for host-mode launches (`ROOM_DEBUG_HOST_LOG`). */
export function hostDebug(line: string): void {
  const file = process.env.ROOM_DEBUG_HOST_LOG;
  if (!file) return;
  try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `${new Date().toISOString()} ${line}\n`); } catch { /* debug only */ }
}

/** Kill a native child together with everything it spawned. */
export function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* best effort */ }
}

/** Debug helper: log direct children of a host-mode Agent process. */
export function hostDebugProcesses(pid: number | undefined): void {
  if (!pid || !process.env.ROOM_DEBUG_HOST_LOG) return;
  try {
    const out = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"`, { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
    hostDebug(`[children ${pid}] ${out.slice(0, 1800)}`);
  } catch { /* debug only */ }
}

function pipeName(runId: string): string {
  return `TemptRoom-host-${runId.replace(/[^a-zA-Z0-9_-]/g, '')}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Named-pipe room tools for host-mode Agents. The pipe lives in the current
 * user's namespace, so only the same user's processes can reach it. The tool
 * handler runs in the Tempt Room process and keeps the Agent's actor binding.
 */
export class HostRoomPipe {
  readonly pipePath: string;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private listening = false;

  constructor(readonly runId: string, private readonly handler: (request: any) => Promise<any>) {
    this.pipePath = `\\\\.\\pipe\\${pipeName(runId)}`;
    this.server = createServer(socket => this.serve(socket));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server.off('listening', onListening); reject(error); };
      const onListening = () => { this.server.off('error', onError); this.listening = true; resolve(); };
      this.server.once('error', onError); this.server.once('listening', onListening);
      this.server.listen(this.pipePath);
    });
    hostDebug(`[pipe] listening ${this.pipePath}`);
  }

  private serve(socket: Socket) {
    this.sockets.add(socket); hostDebug(`[pipe] connection for ${this.runId}`);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line) continue;
        void this.handle(line).then(result => { if (!socket.destroyed) socket.write(JSON.stringify(result) + '\n'); });
      }
    });
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));
  }

  private async handle(line: string): Promise<any> {
    try { const request = JSON.parse(line); hostDebug(`[pipe] request ${String(request?.name ?? '?')} for ${this.runId}`); return await this.handler(request); }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }

  close() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.listening) { try { this.server.close(); } catch { /* already closing */ } }
    this.listening = false;
  }
}

/**
 * A stdio JSON-RPC channel to a native (non-sandboxed) Agent process.
 * It mirrors the slice of NativeChannel used by the adapters.
 */
export class HostChannel {
  readonly frames = new AsyncQueue<any>();
  started = true;
  ended = false;
  rawStdout = '';
  stderr = '';
  onFrame?: (frame: any) => void;
  private buffer = '';
  private counter = 0;
  private readonly rpc = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private resolveExitFn!: (value: any) => void;
  readonly exit: Promise<any>;

  constructor(public readonly child: ChildProcessWithoutNullStreams, public readonly runId: string) {
    this.exit = new Promise(resolve => { this.resolveExitFn = resolve; });
    hostDebug(`[host] spawned pid=${child.pid} run=${runId}`);
    createInterface({ input: child.stdout }).on('line', line => {
      if (!line.trim()) return;
      try { this.accept(JSON.parse(line)); } catch { this.rawStdout = (this.rawStdout + line + '\n').slice(-8192); }
    });
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-8192); hostDebug(`[stderr] ${String(chunk).slice(-400)}`); });
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.ended) return;
      this.ended = true;
      hostDebug(`[host] exit code=${code} run=${runId}`);
      const exit = { type: 'process.exit', exitCode: code ?? -1, signal };
      this.resolveExitFn(exit);
      this.rejectPending(new Error('Agent 进程已退出'));
      this.frames.end();
    };
    child.on('exit', finish);
    child.on('error', error => { if (!this.ended) { this.stderr = (this.stderr + error.message).slice(-8192); finish(-1, null); } });
  }

  private accept(frame: any) {
    if (frame.id !== undefined && frame.method === undefined && this.rpc.has(frame.id)) {
      const pending = this.rpc.get(frame.id)!; this.rpc.delete(frame.id); clearTimeout(pending.timer);
      frame.error
        ? pending.reject(new Error((frame.error.message ?? 'Agent RPC error') + (frame.error.data === undefined ? '' : '\nRPC detail: ' + (typeof frame.error.data === 'string' ? frame.error.data : JSON.stringify(frame.error.data)))))
        : pending.resolve(frame.result);
    } else { this.onFrame?.(frame); this.frames.push(frame); }
  }

  private rejectPending(error: Error) { for (const pending of this.rpc.values()) { clearTimeout(pending.timer); pending.reject(error); } this.rpc.clear(); }
  private fail(error: Error) { this.rejectPending(error); this.frames.end(error); }

  async write(data: string): Promise<void> {
    if (!this.child.stdin.writable) throw new Error('Agent stdin 已关闭');
    await new Promise<void>((resolve, reject) => { this.child.stdin.write(data, error => error ? reject(error) : resolve()); });
  }
  async closeInput(): Promise<void> { try { this.child.stdin.end(); } catch { /* already closed */ } }
  async send(method: string, params?: unknown) { await this.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n'); }
  request(method: string, params?: unknown, timeoutMs = 120000): Promise<any> {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.rpc.delete(id); reject(new Error(`${method} 超时`)); }, timeoutMs);
      this.rpc.set(id, { resolve, reject, timer });
      this.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n')
        .catch(error => { clearTimeout(timer); this.rpc.delete(id); reject(error); });
    });
  }
  async reply(id: unknown, result: unknown) { await this.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
  async replyError(id: unknown, message: string) { await this.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }) + '\n'); }

  async terminate(): Promise<void> {
    if (this.ended) return;
    killProcessTree(this.child.pid);
    try {
      await Promise.race([this.exit, delay(10000).then(() => { throw new ExecutionUnknown('未确认本机 Agent 进程树退出'); })]);
    } catch (error) {
      if (error instanceof ExecutionUnknown) throw error;
    }
  }
  dispose() { this.rejectPending(new Error('Channel closed')); this.frames.end(); }
  diagnostic(error: unknown, secrets: readonly (string | undefined)[] = []) {
    return new Error(redactDiagnostic(`${error instanceof Error ? error.message : String(error)}${this.stderr ? '\nAgent stderr（尾部）：\n' + this.stderr : ''}`, secrets));
  }
}
