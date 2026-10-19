import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentDescriptor, AgentOutput, CodexBinding, CodexRunState, Diagnostic } from '../../../packages/protocol/src/index.ts';
import type { AdapterContext } from './adapters.ts';
import { AttachedCodexChannel, CodexRpcError } from './codex-attached-channel.ts';
import { AsyncQueue } from './queue.ts';
import { ExecutionUnknown, RemoteCanceled } from './errors.ts';
import { redactDiagnostic } from './diagnostics.ts';

// Thread ids are globally unique. Locking by thread alone also covers URL aliases
// and multiple transports that happen to connect to the same backend.
const leasedThreads = new Set<string>();
export const codexThreadKey = (agent: AgentDescriptor | undefined) => agent?.connectionMode === 'attach' ? agent.codexBinding?.threadId : undefined;
const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const legacyHistory=new WeakSet<AttachedCodexChannel>();

async function readLegacyTurnPage(channel:AttachedCodexChannel,params:Record<string,unknown>){
  const response=await channel.request('thread/read',{threadId:params.threadId,includeTurns:true});
  if(response?.thread?.id!==params.threadId||!Array.isArray(response.thread.turns))throw new Error('Codex 旧式历史未返回完整轮次，不能核对执行');
  const offset=params.cursor===undefined?0:typeof params.cursor==='string'&&/^legacy:\d+$/.test(params.cursor)?Number(params.cursor.slice(7)):NaN;
  if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Codex 旧式历史游标无效');
  const turns=[...response.thread.turns].reverse(),limit=typeof params.limit==='number'?params.limit:50;
  if(turns.length>10000)throw new Error('Codex 旧式历史超过读取上限');
  if(turns.some(turn=>typeof turn?.id!=='string'||!Array.isArray(turn.items)||turn.itemsView&&turn.itemsView!=='full'))throw new Error('Codex 旧式历史没有完整条目，不能确认交付');
  return {data:turns.slice(offset,offset+limit).map(turn=>({...turn,itemsView:'full'})),nextCursor:offset+limit<turns.length?`legacy:${offset+limit}`:null};
}

async function readTurnPage(channel:AttachedCodexChannel,params:Record<string,unknown>){
  if(legacyHistory.has(channel))return readLegacyTurnPage(channel,params);
  try{return await channel.request('thread/turns/list',params);}
  catch(error){
    if(error instanceof CodexRpcError&&error.code===-32600&&error.detail.includes('is not materialized yet; thread/turns/list is unavailable before first user message'))return {data:[],nextCursor:null};
    if(error instanceof CodexRpcError&&error.code===-32601&&error.detail.includes('list_turns is not supported yet')){
      const result=await readLegacyTurnPage(channel,params);legacyHistory.add(channel);return result;
    }
    throw error;
  }
}

async function pages(channel: AttachedCodexChannel, method: string, params: Record<string, unknown>, maximum = 100): Promise<any[]> {
  const data: any[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maximum; page++) {
    let result:any;
    try { result=await channel.request(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) }); }
    catch(error){
      // An existing, loaded but unused persistent thread has no turn store yet.
      // This exact native error denotes an empty history, not another backend.
      if(method==='thread/turns/list'&&page===0&&error instanceof CodexRpcError&&error.code===-32600&&error.detail.includes('is not materialized yet; thread/turns/list is unavailable before first user message'))return [];
      throw error;
    }
    if (!Array.isArray(result?.data)) throw new Error(`Codex ${method} 响应形状无效`);
    data.push(...result.data);
    if (!result.nextCursor) return data;
    if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor)) throw new Error('Codex 分页游标无效');
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw new Error('Codex 分页超过核对上限，未自动执行');
}

export async function inspectAttachedThread(channel: AttachedCodexChannel, binding: CodexBinding, version?: string) {
  const userAgent = channel.server?.userAgent;
  if (typeof userAgent !== 'string' || !userAgent) throw new Error('Codex 后端没有报告版本信息');
  if (version && !userAgent.split(/[\s/()]+/).includes(version)) throw new Error('Codex 后端版本与固定版本不一致');
  const loaded = await pages(channel, 'thread/loaded/list', {});
  if (!loaded.includes(binding.threadId)) throw new Error('目标线程未加载在此后端：只能读取历史，未连接活动会话；不会自动 resume 或新建线程');
  const { thread } = await channel.request('thread/read', { threadId: binding.threadId, includeTurns: false });
  if (thread?.id !== binding.threadId || !['active', 'idle'].includes(thread.status?.type)) throw new Error('目标线程不在可附着状态');
  if (typeof thread.cwd !== 'string' || !samePath(thread.cwd, binding.expectedCwd)) throw new Error('Codex 线程工作目录与绑定配置不一致');
  if (thread.canAcceptDirectInput === false) throw new Error('该 Codex 线程不接受直接输入');
  return thread;
}

export async function diagnoseCodexAttachment(agent: AgentDescriptor): Promise<Diagnostic> {
  const checks: Diagnostic['checks'] = [];
  let channel: AttachedCodexChannel | undefined;
  try {
    if (agent.provider !== 'codex' || agent.executionMode !== 'host' || !agent.codexBinding) throw new Error('附着模式需要 Codex 已有宿主会话和完整线程绑定');
    channel = await AttachedCodexChannel.connect(agent.codexBinding, agent.executable);
    checks.push({ name: 'attach-transport', passed: true, detail: '已连接现有 App Server；本应用不拥有或终止其进程' });
    const thread = await inspectAttachedThread(channel, agent.codexBinding, agent.version);
    checks.push({ name: 'live-thread', passed: true, detail: `目标线程已加载，状态 ${thread.status.type}；工作目录校验通过` });
    await pages(channel, 'thread/queue/list', { threadId: thread.id });
    const history=await readTurnPage(channel,{threadId:thread.id,limit:1,itemsView:'full',sortDirection:'desc'});
    if(!Array.isArray(history?.data))throw new Error('Codex 轮次读取响应形状无效');
    checks.push({ name: 'attach-protocol', passed: true, detail: '原生队列和轮次读取可用；未发送模型请求或修改线程设置。本模式不接管审批或人工输入；这些能力需在原客户端核验' });
    checks.push({ name: 'execution-mode', passed: true, detail: '已有宿主会话：沿用 Codex 原有权限与目录，不代表 AppContainer 隔离已验证' });
  } catch (error) { checks.push({ name: 'codex-attach', passed: false, detail: redactDiagnostic(error instanceof CodexRpcError?error.message+': '+error.detail:error, [agent.codexBinding?.credentialEnv ? process.env[agent.codexBinding.credentialEnv] : undefined]) }); }
  finally { channel?.close(); }
  return { ready: checks.length > 0 && checks.every(check => check.passed), checks, checkedAt: new Date().toISOString(), provider: agent.provider };
}

type OwnedLocation = { kind: 'queued'; submission: any } | { kind: 'turn'; turn: any } | { kind: 'missing' };
export async function locateAttachedRun(channel: AttachedCodexChannel, state: CodexRunState): Promise<OwnedLocation> {
  const queue = await pages(channel, 'thread/queue/list', { threadId: state.binding.threadId });
  const submissions = queue.filter(item => item.clientUserMessageId === state.clientUserMessageId);
  if (submissions.length > 1) throw new ExecutionUnknown('发现重复的原生排队项，需要人工核对');
  if (submissions.length === 1) {
    if (state.queuedSubmissionId && submissions[0].id !== state.queuedSubmissionId) throw new ExecutionUnknown('原生排队标识发生变化');
    return { kind: 'queued', submission: submissions[0] };
  }
  let cursor:string|undefined;const seen=new Set<string>();
  for(let page=0;page<100;page++){
    const result=await readTurnPage(channel,{threadId:state.binding.threadId,itemsView:'full',sortDirection:'desc',limit:50,...(cursor?{cursor}:{})});
    if(!Array.isArray(result?.data))throw new Error('Codex 轮次读取响应形状无效');
    const owned=result.data.filter((turn:any)=>state.nativeTurnId?turn.id===state.nativeTurnId:turn.items?.some((item:any)=>item.type==='userMessage'&&item.clientId===state.clientUserMessageId));
    if(owned.length>1)throw new ExecutionUnknown('发现重复的原生轮次，需要人工核对');
    if(owned.length===1)return {kind:'turn',turn:owned[0]};
    if(!result.nextCursor)return {kind:'missing'};
    if(typeof result.nextCursor!=='string'||seen.has(result.nextCursor))throw new ExecutionUnknown('Codex 轮次分页游标无效');
    seen.add(result.nextCursor);cursor=result.nextCursor;
  }
  throw new ExecutionUnknown('Codex 轮次超过核对上限，需要人工核对');
}

/** Reconcile only, or cancel exactly the recorded queue/turn. Never send input. */
export async function reconcileAttachedRun(state: CodexRunState, executable?: string, cancel = false) {
  let channel: AttachedCodexChannel | undefined;
  try {
    channel = await AttachedCodexChannel.connect(state.binding, executable, 5000, AbortSignal.timeout(7000));
    await inspectAttachedThread(channel, state.binding, state.version);
    let found = await locateAttachedRun(channel, state);
    if (!cancel || found.kind === 'missing') return found;
    if (found.kind === 'queued') {
      state.queuedSubmissionId = found.submission.id;
      let removed = false;
      try { await channel.request('thread/queue/delete', { threadId: state.binding.threadId, queuedSubmissionId: found.submission.id }); removed = true; }
      catch (error) { if (!(error instanceof CodexRpcError)) throw error; }
      found = await locateAttachedRun(channel, state);
      // A successful delete plus absence is a cancellation confirmation. If a
      // desktop client started it concurrently, locate finds its owned turn.
      if (found.kind === 'missing') {
        if(!removed)throw new ExecutionUnknown('排队项删除未确认且轮次未找到');
        return { kind: 'canceled' as const };
      }
    }
    if (found.kind === 'turn' && found.turn.status === 'inProgress') {
      state.nativeTurnId = found.turn.id;
      await channel.request('turn/interrupt', { threadId: state.binding.threadId, turnId: found.turn.id });
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const current = await locateAttachedRun(channel, state);
        if (current.kind === 'turn' && current.turn.status !== 'inProgress') return current;
        await delay(100);
      }
      throw new ExecutionUnknown('取消已受理，但没有确认对应轮次停止');
    }
    return found;
  } finally { channel?.close(); }
}

export async function* attachedCodexRun(ctx: AdapterContext): AsyncIterable<AgentOutput> {
  const output = new AsyncQueue<AgentOutput>();
  const consumer = new AbortController();
  let failure: unknown;
  const completion = execute({ ...ctx, signal: AbortSignal.any([ctx.signal, consumer.signal]) }, output)
    .then(() => output.end(), error => { failure = error; output.end(error); });
  try { for await (const item of output) yield item; }
  finally {
    consumer.abort(new Error('Room 已停止接收此运行'));
    await completion;
    if (failure instanceof ExecutionUnknown) throw failure;
  }
}

async function execute(ctx: AdapterContext, output: AsyncQueue<AgentOutput>) {
  const binding = ctx.agent.codexBinding;
  if (!binding || ctx.agent.provider !== 'codex' || ctx.agent.executionMode !== 'host') throw new Error('无效的 Codex 附着配置');
  if (!samePath(ctx.workspace, binding.expectedCwd)) throw new Error('任务项目目录与附着线程目录不一致');
  if (!ctx.saveCodexState) throw new Error('附着执行必须提供持久化状态回调');
  if (leasedThreads.has(binding.threadId)) throw new Error('此 Codex 线程已有 Room 运行或状态核对');
  leasedThreads.add(binding.threadId);
  let channel: AttachedCodexChannel | undefined, state: CodexRunState | undefined, sent = false, lost: Error | undefined;
  const texts = new Map<string, string>(), completedItems = new Set<string>();
  let drainFrames=()=>{};
  const save = (update: Partial<CodexRunState>) => { state = { ...state!, ...update }; ctx.saveCodexState!(structuredClone(state)); if(state.nativeTurnId)drainFrames(); };
  const acceptItem = (item: any) => {
    if (item?.type !== 'agentMessage' || typeof item.id !== 'string' || typeof item.text !== 'string') return;
    const previous = texts.get(item.id) ?? '';
    if (!item.text.startsWith(previous)) throw new ExecutionUnknown('原生消息正文与已接收片段不一致，需要核对');
    const tail = item.text.slice(previous.length); texts.set(item.id, item.text);
    if (tail) output.push({ type: 'text', text: tail });
    completedItems.add(item.id);
  };
  const finishTurn = (turn: any) => {
    if (turn.status === 'inProgress') return false;
    if (turn.itemsView && turn.itemsView !== 'full') throw new ExecutionUnknown('后端未提供完整的本轮输出');
    for (const item of turn.items ?? []) acceptItem(item);
    if (turn.status === 'interrupted') { save({ phase: 'canceled', nativeStatus:'interrupted' }); throw new RemoteCanceled('Codex 已确认对应轮次停止'); }
    if(!['completed','failed'].includes(turn.status))throw new ExecutionUnknown('Codex 返回了未知轮次状态');
    save({ phase: 'completed', nativeStatus:turn.status });
    if (turn.status !== 'completed') throw new Error('Codex 对应轮次执行失败；详细信息请在原客户端查看');
    return true;
  };
  try {
    ctx.signal.throwIfAborted();
    channel = await AttachedCodexChannel.connect(binding, ctx.agent.executable, 10000, ctx.signal);
    await inspectAttachedThread(channel, binding, ctx.agent.version);
    const before = await pages(channel, 'thread/queue/list', { threadId: binding.threadId });
    const clientUserMessageId = `tempt_room_${ctx.run.id}_g${ctx.run.generation??1}`;
    if (before.some(item => item.clientUserMessageId === clientUserMessageId)) throw new ExecutionUnknown('已有同一请求的排队记录，请先核对，未重复提交');
    ctx.signal.throwIfAborted();
    state = { binding, version: ctx.agent.version || undefined, executable: ctx.agent.executable || undefined, clientUserMessageId, phase: 'prepared' };
    // Persist intent before a write; missing responses can then be reconciled.
    save({});
    channel.onClose = error => { lost = error; };
    const earlyFrames:any[]=[];let earlyBytes=0,disableStreaming=false;
    const handleFrame = (frame:any) => {
      if (!state?.nativeTurnId || frame.params?.threadId !== binding.threadId) return;
      const params = frame.params;
      if ((params.turnId ?? params.turn?.id) !== state.nativeTurnId) return;
      // Only append deltas on this connection. After reconnect, use authoritative
      // full items, never replay all item deltas or another desktop turn.
      if (!disableStreaming && frame.method === 'item/agentMessage/delta' && typeof params.itemId === 'string' && typeof params.delta === 'string' && !completedItems.has(params.itemId)) {
        texts.set(params.itemId, (texts.get(params.itemId) ?? '') + params.delta);
        output.push({ type: 'text', text: params.delta });
      }
    };
    drainFrames=()=>{for(const frame of earlyFrames.splice(0))handleFrame(frame);earlyBytes=0;};
    channel.onFrame=frame=>{
      if(frame.params?.threadId!==binding.threadId||frame.method!=='item/agentMessage/delta')return;
      if(state?.nativeTurnId){handleFrame(frame);return;}
      if(disableStreaming)return;
      earlyBytes+=typeof frame.params.delta==='string'?Buffer.byteLength(frame.params.delta):0;
      if(earlyFrames.length>=1000||earlyBytes>1024*1024){earlyFrames.length=0;disableStreaming=true;return;}
      earlyFrames.push(frame);
    };
    sent = true;
    let added: any;
    try { added = await channel.request('thread/queue/add', { threadId: binding.threadId, clientUserMessageId, input: [{ type: 'text', text: ctx.prompt, text_elements: [] }] }); }
    catch (error) { if (error instanceof CodexRpcError) { sent = false; save({ phase: 'canceled' }); } throw error; }
    if (typeof added?.queuedSubmission?.id !== 'string' || added.queuedSubmission.clientUserMessageId !== clientUserMessageId) throw new ExecutionUnknown('原生队列回执与请求不一致');
    save({ phase: 'queued', queuedSubmissionId: added.queuedSubmission.id });
    output.push({ type: 'session', id: binding.threadId });
    let started = false, missingSince=0;
    while (true) {
      ctx.signal.throwIfAborted();
      if (lost) throw lost;
      const found = await locateAttachedRun(channel, state);
      if(found.kind!=='missing')missingSince=0;
      if (found.kind === 'turn') {
        if (!state.nativeTurnId) save({ nativeTurnId: found.turn.id, nativeStatus:'inProgress', phase: 'running' });
        if (finishTurn(found.turn)) return;
      } else if (found.kind === 'queued') {
        if (state.nativeTurnId) throw new ExecutionUnknown('已经启动的轮次重新出现在队列中');
        const thread = await inspectAttachedThread(channel, binding, ctx.agent.version);
        if (thread.status.type === 'idle') {
          ctx.signal.throwIfAborted();
          // Always name our submission. Never start another client's queue head.
          try {
            const result = await channel.request('thread/queue/start', { threadId: binding.threadId, queuedSubmissionId: state.queuedSubmissionId });
            if (typeof result?.turn?.id !== 'string') throw new ExecutionUnknown('队列启动未返回轮次标识');
            save({ nativeTurnId: result.turn.id, nativeStatus:'inProgress', phase: 'running' }); started = true;
          } catch (error) {
            if (!(error instanceof CodexRpcError)) throw error;
            // Another client can become active between read and start. A clear
            // rejection is safe to inspect; a lost response is never resent.
            const current = await inspectAttachedThread(channel, binding, ctx.agent.version);
            if (current.status.type !== 'active') throw error;
          }
        }
      } else {
        // Queue consumption and durable turn materialization are asynchronous.
        // Wait for evidence using reads only; never resubmit a consumed item.
        missingSince ||= Date.now();
        if(Date.now()-missingSince>5000)throw new ExecutionUnknown('没有找到对应队列项或轮次，未自动重新发送');
      }
      await delay(started ? 150 : 250, undefined, { signal: ctx.signal });
    }
  } catch (error) {
    if (error instanceof RemoteCanceled || state?.phase === 'completed' || !sent) throw error;
    if (state) {
      save({ phase: 'uncertain' }); channel?.close(); channel = undefined;
      // Read-only reconnect, or scoped cancellation after abort. Never add or
      // start again when an earlier write has an unknown outcome.
      try {
        const found = await reconcileAttachedRun(state, ctx.agent.executable, ctx.signal.aborted);
        if (found.kind === 'canceled') { save({ phase: 'canceled' }); throw new RemoteCanceled('Codex 已确认移除本运行的排队项'); }
        if (found.kind === 'turn') {
          save({ nativeTurnId: found.turn.id });
          if (finishTurn(found.turn)) return;
        } else if (found.kind === 'queued') save({ queuedSubmissionId: found.submission.id, phase: 'uncertain' });
      } catch (recovery) { if (recovery instanceof RemoteCanceled || (state as CodexRunState).phase === 'completed') throw recovery; }
    }
    throw new ExecutionUnknown('Codex 执行状态未确认；已保留原生请求标识，未重试。请使用“核对状态”或“核对并停止”',{cause:error});
  } finally { channel?.close(); leasedThreads.delete(binding.threadId); }
}
