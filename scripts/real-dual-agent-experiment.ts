import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planDualAgentExperiment, roomIsIdle, type ExperimentAgent } from './real-experiment-lib.ts';

const args = new Set(process.argv.slice(2));
const base = (process.env.ROOM_EXPERIMENT_URL ?? 'http://127.0.0.1:4317').replace(/\/+$/, '');
const token = process.env.ROOM_EXPERIMENT_TOKEN ?? (() => { try { return readFileSync(resolve('.state/owner-session.token'), 'utf8').trim(); } catch { return ''; } })();
const projectPath = process.env.ROOM_EXPERIMENT_PROJECT;
const timeoutMs = Number(process.env.ROOM_EXPERIMENT_TIMEOUT_MS ?? 15 * 60 * 1000);
const headers = {'content-type': 'application/json', 'room-protocol-version': '0.1', 'authorization': `Bearer ${token}`};
if (!token) { console.error('缺少 owner token：设置 ROOM_EXPERIMENT_TOKEN 或先启动服务'); process.exit(2); }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(base + path, {...init, headers: {...headers, ...(init?.headers as any)}});
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

const agents = await call<ExperimentAgent[]>('/api/agents');
const plan = planDualAgentExperiment({agents, agentA: process.env.ROOM_EXPERIMENT_AGENT_A, agentB: process.env.ROOM_EXPERIMENT_AGENT_B, projectPath});
if (plan.warnings.length) console.error('警告：' + plan.warnings.join('；'));
if (plan.errors.length) { console.error('实验未就绪：\n- ' + plan.errors.join('\n- ')); process.exit(2); }
console.log(JSON.stringify({readiness: 'ready', agentA: plan.agentA, agentB: plan.agentB, steps: plan.steps}, null, 2));
if (!args.has('--execute')) { console.log('dry-run 完成；传 --execute 且设置 ROOM_EXPERIMENT_AUTHORIZED=1 才会调用真实模型。'); process.exit(0); }
if (process.env.ROOM_EXPERIMENT_AUTHORIZED !== '1') { console.error('真实模型实验需要显式授权：ROOM_EXPERIMENT_AUTHORIZED=1，并确认成本。'); process.exit(3); }

const agentA = plan.agentA!, agentB = plan.agentB!;
const command = async (type: string, payload: unknown) => call<{result: any}>('/api/commands', {method: 'POST', body: JSON.stringify({version: '0.1', commandId: `exp_${Date.now()}_${Math.random().toString(36).slice(2)}`, roomId: payload && (payload as any).roomId, type, payload})});
const created = await command('room.create', {name: `真实双 Agent 实验 ${new Date().toISOString()}`, description: 'E02 真实模型实验', members: [agentA.id, agentB.id]});
const roomId = created.result?.roomId ?? created.result?.room?.id;
if (!roomId) throw new Error('room.create 未返回 roomId');
const taskA = await command('task.create', {roomId, title: '实验 A：完成基线实现并提交交付物', agentId: agentA.id, ...(projectPath ? {projectPath} : {})});
const roomSnapshot = async () => call<any>(`/api/rooms/${roomId}/snapshot`);
const wait = async (taskId: string) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await roomSnapshot(), run = (snapshot.snapshot.runs as any[]).find(item => item.taskId === taskId);
    if (run && roomIsIdle([run])) return run;
    await new Promise(done => setTimeout(done, 2000));
  }
  throw new Error(`等待任务 ${taskId} 超时`);
};
const runA = await wait(taskA.result.taskId);
const taskB = await command('task.create', {roomId, title: '实验 B：复核 A 的交付物并给出验收结论', agentId: agentB.id, dependencies: [taskA.result.taskId]});
const runB = await wait(taskB.result.taskId);
const snapshot = await roomSnapshot();
const report = {
  createdAt: new Date().toISOString(), roomId, base, projectPath: projectPath ?? null,
  agents: {a: agentA, b: agentB},
  runs: [runA, runB],
  artifacts: (snapshot.snapshot.artifacts as any[]).filter(item => [runA.id, runB.id].includes(item.runId)).map(item => ({id: item.id, name: item.name, mediaType: item.mediaType, size: item.size, runId: item.runId})),
  usage: {a: runA.usage ?? null, b: runB.usage ?? null}
};
mkdirSync(resolve('.state/real-experiment'), {recursive: true});
const path = resolve(`.state/real-experiment/report-${report.createdAt.replaceAll(':', '-')}.json`);
writeFileSync(path, JSON.stringify(report, null, 2));
console.log(`真实双 Agent 实验完成：${path}`);
