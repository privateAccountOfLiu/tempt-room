import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, delimiter, join, resolve } from 'node:path';
import { type AgentDescriptor, type Diagnostic, defaultSandbox, ProtocolError } from '../../../packages/protocol/src/index.ts';
import { now, uid } from './store.ts';
import { stageToolchain } from './toolchain.ts';
import { inspectRuntime,stageAgentRuntime } from './runtime.ts';

export async function findExecutable(name: string): Promise<string | undefined> {
  if (!name) return;
  if (/[\\/]/.test(name)) return existsSync(resolve(name)) ? resolve(name) : undefined;
  const variants = process.platform === 'win32' && !name.endsWith('.exe') ? [name, `${name}.exe`, `${name}.cmd`] : [name];
  for (const path of (process.env.PATH ?? '').split(delimiter)) for (const variant of variants) { const candidate = join(path.replaceAll('"', ''), variant); try { if ((await stat(candidate)).isFile()) return candidate; } catch {} }
}

export class SandboxHost extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private requests = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private cachedProbe?: Promise<Diagnostic>;
  constructor(public root: string, public executable: string) { super(); }
  private start() {
    if (this.child && !this.child.killed) return;
    if (process.platform !== 'win32') throw new ProtocolError('windows_required', '本地执行需要 Windows AppContainer', 503);
    if (!existsSync(this.executable)) throw new ProtocolError('sandbox_not_built', '请先运行 npm run build:sandbox', 503);
    const child = spawn(this.executable, ['--root', this.root], { windowsHide: true, stdio: 'pipe' }); this.child = child;
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    createInterface({ input: child.stdout }).on('line', line => {
      let frame: any; try { frame = JSON.parse(line); } catch { this.emit('protocol-error', '沙箱宿主输出不是 JSON'); return; }
      if (frame.id && this.requests.has(frame.id)) {
        const pending = this.requests.get(frame.id)!; this.requests.delete(frame.id); clearTimeout(pending.timer);
        if (frame.error) pending.reject(new Error(frame.error.message)); else pending.resolve(frame.result);
      } else this.emit('notification', frame);
    });
    const closed = (message: string) => {
      if (this.child !== child) return; this.child = undefined; this.cachedProbe = undefined;
      for (const p of this.requests.values()) { clearTimeout(p.timer); p.reject(new Error(message)); } this.requests.clear(); this.emit('closed', message);
    };
    child.on('error', e => closed(e.message)); child.on('exit', () => closed(`沙箱宿主已退出${stderr ? '：' + stderr : ''}`));
  }
  request(method: string, payload: Record<string, unknown> = {}, timeoutMs = 45000): Promise<any> {
    this.start(); const id = uid('ipc');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error(`沙箱请求超时：${method}`)); }, timeoutMs);
      this.requests.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, ...payload }) + '\n', error => { if (error) { clearTimeout(timer); this.requests.delete(id); reject(error); } });
    });
  }
  probe(force = false): Promise<Diagnostic> {
    if (force) this.cachedProbe = undefined;
    return this.cachedProbe ??= stageToolchain(this.root).then(tools=>this.request('probe',{tools},120000)).catch(error => ({ ready: false, checks: [{ name: 'native-host', passed: false, detail: error.message }], checkedAt: now() }));
  }
  async launch(spec: Record<string, unknown>): Promise<{ pid: number }> {
    const report = await this.probe();
    if (!report.ready) throw new ProtocolError('sandbox_unverified', `沙箱未通过验证：${report.checks.filter(c => !c.passed).map(c => c.detail).join('；')}`, 503);
    return this.request('launch', { spec: { ...defaultSandbox, ...spec } });
  }
  async cancel(runId: string) { await this.request('cancel', { runId }); }
  async write(runId: string, data: string) { await this.request('input', { runId, data }); }
  async closeInput(runId: string) { await this.request('closeInput', { runId }); }
  close() { this.child?.stdin.end(); }
}

export async function stageRuntime(agent: AgentDescriptor, stateRoot: string): Promise<{ executable: string; roots: string[]; node: string; bridge: string; argsPrefix:string[]; environment:Record<string,string> }> {
  const original = await findExecutable(agent.executable);
  if (!original) throw new ProtocolError('executable_missing', `未找到 ${agent.name} 的可执行文件`, 503);
  const layout=await inspectRuntime(agent,original),destination=await stageAgentRuntime(layout,stateRoot,agent.id);
  const tools=await stageToolchain(stateRoot),node=tools.node,bridge=join(dirname(node),'room-bridge.mjs');
  const compatibility=join(dirname(node),'room-realpath.cjs');
  const deepseekCompatibility=join(dirname(node),'room-deepseek.cjs');
  const argsPrefix=layout.kind==='deepseek-desktop'?['--expose-internals','--preserve-symlinks','--preserve-symlinks-main','-r',compatibility,'-r',join(dirname(node),'room-pipes.cjs'),'-r',deepseekCompatibility,join(destination,'resources','app.asar','dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js')]:layout.kind==='deepseek-node'?['-r',compatibility,'-r',deepseekCompatibility,join(destination,layout.entry)]:[];
  return { executable:layout.kind==='deepseek-node'?node:join(destination,layout.entry), roots: [destination,...tools.runtimeRoots], node, bridge,argsPrefix,environment:layout.kind==='deepseek-desktop'?{ELECTRON_RUN_AS_NODE:'1'}:{} };
}
