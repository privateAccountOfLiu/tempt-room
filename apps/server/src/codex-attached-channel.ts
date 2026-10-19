import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import WebSocket from 'ws';
import { codexBindingSchema, type CodexBinding } from '../../../packages/protocol/src/index.ts';

export class CodexRpcError extends Error {
  constructor(public method: string, public code: number, public detail='') { super(`Codex ${method} 拒绝请求（RPC ${code}）`); }
}

/** Owns a client connection (or a proxy), never the existing App Server process. */
export class AttachedCodexChannel {
  private socket?: WebSocket;
  private proxy?: ChildProcessWithoutNullStreams;
  private counter = 0;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout; method: string }>();
  private closed = false;
  private removeAbort?: () => void;
  onFrame?: (frame: any) => void;
  onClose?: (error: Error) => void;
  server?: any;

  static async connect(binding: CodexBinding, executable?: string, timeoutMs = 10000, signal?: AbortSignal): Promise<AttachedCodexChannel> {
    codexBindingSchema.parse(binding);
    signal?.throwIfAborted();
    const channel = new AttachedCodexChannel();
    if(signal){
      const abort=()=>channel.fail(new Error('Codex 附着连接已取消或超时'));
      signal.addEventListener('abort',abort,{once:true});channel.removeAbort=()=>signal.removeEventListener('abort',abort);
    }
    try {
      if (binding.transport === 'websocket') {
        const token = process.env[binding.credentialEnv];
        if (!token || /[\r\n]/.test(token)) throw new Error('Codex WebSocket 认证环境变量未设置或无效');
        const socket = channel.socket = new WebSocket(binding.endpoint, {
          headers: { Authorization: `Bearer ${token}` }, followRedirects: false,
          handshakeTimeout: timeoutMs, maxPayload: 16 * 1024 * 1024
        });
        socket.on('error', () => channel.fail(new Error('Codex 附着连接失败，请检查端点与认证配置')));
        socket.on('close', () => channel.fail(new Error('Codex 附着连接已断开')));
        socket.on('message', data => channel.accept(String(data)));
        await new Promise<void>((resolve, reject) => {
          socket.once('open', resolve);
          socket.once('error', () => reject(new Error('Codex WebSocket 握手失败，请检查端点与认证配置')));
          socket.once('close', () => reject(new Error('Codex WebSocket 握手已关闭')));
        });
      } else {
        if (!executable || !isAbsolute(executable)) throw new Error('控制 socket 附着需要 Codex 可执行文件的绝对路径');
        const proxy = channel.proxy = spawn(executable, ['app-server', 'proxy', '--sock', binding.endpoint], {
          stdio: 'pipe', windowsHide: true, shell: false
        });
        let buffer = '';
        proxy.stdout.setEncoding('utf8');
        proxy.stdout.on('data', data => {
          buffer += data;
          if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { channel.fail(new Error('Codex proxy 帧超过大小限制')); return; }
          let end: number;
          while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line.trim()) channel.accept(line); }
        });
        proxy.stderr.resume(); // Do not copy backend diagnostics or credentials into room data.
        proxy.on('error', () => channel.fail(new Error('Codex proxy 无法启动')));
        proxy.on('exit', () => channel.fail(new Error('Codex proxy 已退出，控制 socket 可能不可用')));
      }
      channel.server = await channel.request('initialize', {
        clientInfo: { name: 'tempt_room_attach', title: 'Tempt Room', version: '0.1.0' },
        capabilities: { experimentalApi: true }
      }, timeoutMs);
      await channel.send({ method: 'initialized', params: {} });
      return channel;
    } catch (error) { channel.close(); throw error; }
  }

  request(method: string, params: unknown = {}, timeoutMs = 10000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex 附着连接已关闭'));
    const id = `room_${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 回执超时，执行状态需核对`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      void this.send({ id, method, params }).catch(error => {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }

  private send(frame: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Codex 附着连接已关闭'));
    const data = JSON.stringify(frame);
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(data, error => error ? reject(new Error('Codex WebSocket 写入失败')) : resolve());
      else if (this.proxy?.stdin.writable) this.proxy.stdin.write(data + '\n', error => error ? reject(new Error('Codex proxy 写入失败')) : resolve());
      else reject(new Error('Codex 附着连接不可写'));
    });
  }

  private accept(data: string) {
    try {
      const frame = JSON.parse(data);
      if (frame.method === undefined && this.pending.has(frame.id)) {
        const pending = this.pending.get(frame.id)!;
        this.pending.delete(frame.id); clearTimeout(pending.timer);
        frame.error ? pending.reject(new CodexRpcError(pending.method, frame.error.code, typeof frame.error.message==='string'?frame.error.message.slice(0,2000):'')) : pending.resolve(frame.result);
      } else if (typeof frame.method === 'string' && frame.id === undefined) {
        this.onFrame?.(frame);
      }
      // Server requests stay with the desktop client. This observer must not
      // grant permissions or answer questions belonging to a different client.
    } catch { this.fail(new Error('Codex 附着端点返回了无效协议帧')); }
  }

  private fail(error: Error) {
    if (this.closed) return;
    const handler = this.onClose;
    this.close(); handler?.(error);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.removeAbort?.();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Codex 附着连接已关闭')); }
    this.pending.clear(); this.onFrame = undefined; this.onClose = undefined;
    this.socket?.terminate();
    // This is our short-lived transport proxy, not a process-tree cancellation.
    this.proxy?.stdin.end(); this.proxy?.kill();
  }
}
