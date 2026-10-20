import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { VERSION,payloadSchemas, agentToolCallSchema, ProtocolError, type AgentDescriptor, type Artifact, type RoomEvent,type ServerCapabilities,type Run,type ToolOperation,type CapabilityEvidence,type ProjectBinding,type Integration } from '../../../packages/protocol/src/index.ts';
import { Store, now, OWNER, uid } from './store.ts';
import {agentCapabilityFingerprint,capabilityNames,probeConfiguredAgent,verifiedCapabilityState} from './adapter-capabilities.ts';
import { RoomService } from './service.ts';
import { Worker } from './worker.ts';
import { diagnose,probeAgentProtocol } from './adapters.ts';
import { issueAgentToken, verifyAgentToken } from './agent-tokens.ts';
import { detectLocalExecutables } from './detect.ts';
import { installConnector, previewConnector, uninstallConnector, type InstallTarget } from './connector-install.ts';

export interface AppOptions { root?: string; token?: string; dev?: boolean; startWorker?: boolean; devHmrPort?: number }
export async function createApp(options: AppOptions = {}) {
  const root = resolve(options.root ?? '.state'); mkdirSync(root, { recursive: true });
  const store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), worker = new Worker(store, service, root);
  const token = options.token ?? randomBytes(32).toString('hex'), tokenHash = createHash('sha256').update(token).digest();
  const tokenSecret = token;
  // Cookies share a host across ports. Bind the name to this data directory so
  // signing into an independent preview cannot replace the daily room session.
  const sessionCookie=`room_session_${createHash('sha256').update(root).digest('hex').slice(0,16)}`;
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, requestTimeout: 30000 });
  await app.register(cookie); await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 3 } });
  function authorized(value: unknown) { return typeof value === 'string' && timingSafeEqual(createHash('sha256').update(value).digest(), tokenHash); }
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options','nosniff').header('referrer-policy','no-referrer').header('x-frame-options','DENY');
    if(!options.dev)reply.header('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const host = request.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return reply.code(403).send({ code: 'invalid_host', message: '只允许 loopback 主机名' });
    const origin = request.headers.origin;
    if (origin && !new Set([`http://${host}`, `https://${host}`]).has(origin)) return reply.code(403).send({ code: 'invalid_origin', message: '跨来源访问被拒绝' });
    if (!request.url.startsWith('/api/')) return;
    if(request.headers['room-client-type']!==undefined&&!['browser','sdk'].includes(String(request.headers['room-client-type'])))return reply.code(400).send({code:'client_type_rejected',message:'HTTP 客户端类型只能为 browser 或 sdk；Agent 使用绑定身份的连接器'});
    if (request.url === '/api/session' && request.method === 'POST') return;
    // External MCP Agents authenticate with their own scoped token inside the route.
    if (request.url === '/api/agent/tool' && request.method === 'POST') return;
    const bearer = request.headers.authorization?.replace(/^Bearer /, '');
    const wsToken = request.headers['sec-websocket-protocol']?.split(',').map(s=>s.trim()).find(s=>s.startsWith('room-token.'))?.slice(11);
    if (!authorized(request.cookies[sessionCookie]) && !authorized(bearer) && !(request.url==='/api/events'&&authorized(wsToken))) return reply.code(401).send({ code: 'unauthorized', message: '本地会话已过期，请使用启动地址或粘贴启动令牌重新连接' });
    const binaryDownload = request.method==='GET' && /^\/api\/artifacts\/[^/]+$/.test(request.url);
    if (!request.url.startsWith('/api/events') && !binaryDownload && request.headers['room-protocol-version'] !== VERSION) return reply.code(426).send({ code: 'version_mismatch', message: `需要 Room Protocol ${VERSION}` });
  });
  app.setErrorHandler((error, request, reply) => {
    const known = error as Error & { statusCode?: number };
    const status = error instanceof ProtocolError ? error.status : error instanceof z.ZodError ? 400 : (known.statusCode ?? 500);
    return reply.code(status).send({ code: error instanceof ProtocolError ? error.code : error instanceof z.ZodError ? 'validation_error' : 'operation_failed', message: known.message ?? '请求失败' });
  });
  app.post('/api/session', async (request, reply) => {
    const input = z.object({ token: z.string().max(200) }).parse(request.body);
    if (!authorized(input.token)) return reply.code(401).send({ code: 'invalid_session', message: '启动凭据无效' });
    reply.setCookie(sessionCookie, token, { httpOnly: true, sameSite: 'strict', path: '/', secure: false, maxAge: 60*60*24*30 }); return { version: VERSION, owner: OWNER };
  });
  // Local convenience entry: exchanges the startup credential for the HttpOnly
  // cookie and redirects to the clean app URL, so a copied link cannot lose its
  // #session fragment. The token is never accepted for API authorization here.
  app.get<{ Params: { token: string }; Querystring: { room?: string } }>('/enter/:token', async (request, reply) => {
    if (!authorized(request.params.token)) return reply.code(401).send({ code: 'invalid_session', message: '启动凭据无效' });
    reply.setCookie(sessionCookie, request.params.token, { httpOnly: true, sameSite: 'strict', path: '/', secure: false, maxAge: 60*60*24*30 });
    const room = typeof request.query.room === 'string' ? request.query.room : '';
    return reply.redirect('/' + (room ? `?room=${encodeURIComponent(room)}` : ''));
  });
  app.get('/api/rooms', () => store.rooms());
  app.get<{ Params: { id: string } }>('/api/rooms/:id', request => { if (!store.room(request.params.id)) throw new ProtocolError('not_found', '房间不存在', 404); return store.snapshotWithTail(request.params.id).snapshot; });
  app.get<{Params:{id:string};Querystring:{cursor?:string;limit?:string}}>('/api/rooms/:id/snapshot',request=>{
    const room=store.room(request.params.id);if(!room)throw new ProtocolError('not_found','房间不存在',404);
    const cursor=request.query.cursor===undefined?undefined:z.coerce.number().int().nonnegative().parse(request.query.cursor),limit=z.coerce.number().int().min(1).max(2000).parse(request.query.limit??1000);
    if(cursor!==undefined&&cursor>room.seq)throw new ProtocolError('invalid_cursor','游标超出当前房间事件序号',400);
    return store.snapshotWithTail(room.id,cursor,limit);
  });
  app.post<{Params:{id:string}}>('/api/rooms/:id/projections/rebuild',request=>{
    if(!store.room(request.params.id))throw new ProtocolError('not_found','房间不存在',404);
    const {fromSeq}=z.object({fromSeq:z.number().int().nonnegative().default(0)}).strict().parse(request.body??{});
    return store.rebuildProjections(request.params.id,fromSeq);
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/rooms/:id/events', request => {
    if (!store.room(request.params.id)) throw new ProtocolError('not_found', '房间不存在', 404);
    return store.events(request.params.id, z.coerce.number().int().min(0).parse(request.query.after ?? 0));
  });
  // Local audit trail export: one JSON event per line. It passes through the
  // normal owner authorization hook, so it is not available to Agent tokens.
  app.get<{ Params: { id: string } }>('/api/rooms/:id/audit/export', (request, reply) => {
    const roomId = request.params.id;
    if (!store.room(roomId)) throw new ProtocolError('not_found', '房间不存在', 404);
    const throughSeq = store.room(roomId)!.seq, floorSeq = store.projectionStatus(roomId).historyFloor;
    reply.header('content-type', 'application/x-ndjson; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${roomId}-audit.jsonl"`);
    reply.header('cache-control', 'no-store');
    reply.header('x-audit-history-floor', String(floorSeq));
    reply.header('x-audit-through-seq', String(throughSeq));
    return reply.send(Readable.from((function* () {
      for (const event of store.scanEvents(roomId, {afterSeq: 0, throughSeq})) yield JSON.stringify(event) + '\n';
    })()));
  });
  app.get('/api/agents', () => store.list('agents'));
  // Read-only discovery of locally installed Agent programs for the setup form.
  app.get('/api/agents/autodetect', () => {
    const detected = detectLocalExecutables();
    return { detected, executable: { claude: detected.claude ?? '', deepseek: detected.deepseek ?? '', codex: detected.codex ?? '' } };
  });
  // External MCP/plugin integration: an Agent running in its own environment
  // (Claude Code, DSH, Codex, ...) joins one room with a scoped token.
  app.get<{ Params: { id: string }; Querystring: { roomId?: string } }>('/api/agents/:id/connect', request => {
    const agent = store.get<AgentDescriptor>('agents', request.params.id);
    if (!agent) throw new ProtocolError('not_found', 'Agent 不存在', 404);
    const roomId = String(request.query.roomId ?? '');
    const room = roomId ? store.room(roomId) : undefined;
    if (!room || !room.members.includes(agent.id)) throw new ProtocolError('forbidden', '请选择包含该 Agent 的房间', 403);
    const host = request.headers.host ?? '127.0.0.1:4317';
    const url = `http://${host}`;
    const bridge = resolve(root, '..', 'scripts', 'room-agent-mcp.mjs');
    const runner = resolve(root, '..', 'scripts', 'room-agent-runner.mjs');
    const pluginDir = resolve(root, '..', 'plugins', 'tempt-room-claude');
    const token = issueAgentToken(tokenSecret, agent.id, roomId);
    const env = { ROOM_URL: url, ROOM_AGENT_TOKEN: token, ROOM_ROOM_ID: roomId };
    const mcpServers = { room: { command: process.execPath, args: [bridge], env } };
    const codex = [`[mcp_servers.room]`, `command = ${JSON.stringify(process.execPath)}`, `args = [${JSON.stringify(bridge)}]`, ``, `[mcp_servers.room.env]`, ...Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`)].join('\n');
    const dsh = ['- insert:', '    - id: mcp-room', "      name: '@deepseek-ai/dsh-mcp-client'", '      config:', '        serverName: room', '        transport: stdio', `        command: ${JSON.stringify(process.execPath)}`, '        args:', `          - ${JSON.stringify(bridge)}`, '        env:', ...Object.entries(env).map(([key, value]) => `          ${key}: ${JSON.stringify(value)}`)].join('\n');
    return {
      agentId: agent.id, roomId, url, token, mcpServers, pluginDir, runner,
      snippets: {
        claude: `方式一（配置文件）：把 mcpServers 保存为 room-mcp.json，然后运行：\nclaude --mcp-config room-mcp.json\n\n${JSON.stringify({ mcpServers }, null, 2)}\n\n方式二（插件包）：先设置 ROOM_URL / ROOM_AGENT_TOKEN / ROOM_ROOM_ID，再运行：\nclaude --plugin-dir ${JSON.stringify(pluginDir)}`,
        codex: `写入 ~/.codex/config.toml：\n\n${codex}`,
        dsh: `写入 acp profile 的 cordis.patch.yml：\n\n${dsh}`,
        runner: `可选：自动值守。先在终端设置以下环境变量（令牌随服务重启失效）：\n$env:ROOM_URL = ${JSON.stringify(url)}\n$env:ROOM_AGENT_TOKEN = ${JSON.stringify(token)}\n$env:ROOM_ROOM_ID = ${JSON.stringify(roomId)}\n$env:ROOM_AGENT_COMMAND = '<本机 CLI 绝对路径，例如 claude.exe>'\n$env:ROOM_AGENT_ARGS = '["-p","{prompt}"]'\n$env:ROOM_AGENT_MODE = 'oneshot'   # 可选 persistent：保持一个常驻 CLI 进程，prompt 经 stdin 流入\nnode ${JSON.stringify(runner)}\n\n收到 @ 时它会启动该 CLI，并把输出作为该 Agent 的消息发回房间（oneshot 每次新进程；persistent 复用同一进程与会话；可用 ROOM_WAKE_ON=message 改为任意新消息触发）。`
      },
      note: '令牌只代表该 Agent、只能访问该房间；服务重启后失效。外部 Agent 运行时使用自己的权限与目录，Tempt Room 不托管其进程；不会自动唤醒空闲的 Agent。'
    };
  });
  // Write ready-to-use connector files into the managed state directory so the
  // user can copy/start them without hand-editing JSON, TOML or YAML.
  app.post<{ Params: { id: string }; Body: { roomId?: string } }>('/api/agents/:id/connect/write', request => {
    const agent = store.get<AgentDescriptor>('agents', request.params.id);
    if (!agent) throw new ProtocolError('not_found', 'Agent 不存在', 404);
    const roomId = String(request.body?.roomId ?? '');
    const room = roomId ? store.room(roomId) : undefined;
    if (!room || !room.members.includes(agent.id)) throw new ProtocolError('forbidden', '请选择包含该 Agent 的房间', 403);
    const host = request.headers.host ?? '127.0.0.1:4317', url = `http://${host}`;
    const bridge = resolve(root, '..', 'scripts', 'room-agent-mcp.mjs');
    const runner = resolve(root, '..', 'scripts', 'room-agent-runner.mjs');
    const token = issueAgentToken(tokenSecret, agent.id, roomId);
    const env = { ROOM_URL: url, ROOM_AGENT_TOKEN: token, ROOM_ROOM_ID: roomId };
    const dir = join(root, 'connectors', `${agent.id}_${roomId}`);
    mkdirSync(dir, { recursive: true });
    const mcpServers = { mcpServers: { room: { command: process.execPath, args: [bridge], env } } };
    writeFileSync(join(dir, 'claude-room-mcp.json'), JSON.stringify(mcpServers, null, 2));
    writeFileSync(join(dir, 'codex-config.toml'), [`[mcp_servers.room]`, `command = ${JSON.stringify(process.execPath)}`, `args = [${JSON.stringify(bridge)}]`, ``, `[mcp_servers.room.env]`, ...Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`)].join('\n'));
    writeFileSync(join(dir, 'dsh-patch.yml'), ['- insert:', '    - id: mcp-room', "      name: '@deepseek-ai/dsh-mcp-client'", '      config:', '        serverName: room', '        transport: stdio', `        command: ${JSON.stringify(process.execPath)}`, '        args:', `          - ${JSON.stringify(bridge)}`, '        env:', ...Object.entries(env).map(([key, value]) => `          ${key}: ${JSON.stringify(value)}`)].join('\n'));
    writeFileSync(join(dir, 'run-runner.ps1'), [`# ${agent.id} -> ${room.name} (${roomId})`, ...Object.entries(env).map(([key, value]) => `$env:${key} = '${value}'`), `$env:ROOM_AGENT_COMMAND = '<本机 CLI 绝对路径，例如 claude.exe>'`, `$env:ROOM_AGENT_ARGS = '["-p","{prompt}"]'`, `node '${runner}'`].join('\n'));
    writeFileSync(join(dir, 'README.txt'), [`Tempt Room external connector files for ${agent.id} in room "${room.name}" (${roomId}).`, `URL: ${url}`, `Token: ${token}`, '', 'claude-room-mcp.json  -> claude --mcp-config <file>', 'codex-config.toml     -> merge into ~/.codex/config.toml', 'dsh-patch.yml         -> merge into the acp profile cordis.patch.yml', 'run-runner.ps1        -> edit ROOM_AGENT_COMMAND then run in PowerShell for room duty', '', 'The token only acts as this Agent in this room and becomes invalid when the Tempt Room service restarts.', 'Do not share this directory.'].join('\n'));
    return { dir, files: ['claude-room-mcp.json', 'codex-config.toml', 'dsh-patch.yml', 'run-runner.ps1', 'README.txt'], note: '令牌随服务重启失效；该目录只在本机使用。' };
  });
  // One-click install into the client's own user configuration (with backup).
  const installTargetOf = (value?: string): InstallTarget => {
    const target = value as InstallTarget;
    if (!['claude', 'codex', 'dsh', 'claude-project'].includes(target)) throw new ProtocolError('validation_error', 'target 必须是 claude/codex/dsh/claude-project', 400);
    return target;
  };
  const projectDirOf = (value?: string) => {
    const raw = String(value ?? '').trim();
    if (!raw) throw new ProtocolError('validation_error', '请填写项目目录', 400);
    const dir = resolve(raw);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ProtocolError('validation_error', '项目目录不存在或不是目录', 400);
    return dir;
  };
  app.post<{ Params: { id: string }; Body: { roomId?: string; target?: string; projectPath?: string } }>('/api/agents/:id/connect/install', request => {
    const agent = store.get<AgentDescriptor>('agents', request.params.id);
    if (!agent) throw new ProtocolError('not_found', 'Agent 不存在', 404);
    const roomId = String(request.body?.roomId ?? '');
    const room = roomId ? store.room(roomId) : undefined;
    if (!room || !room.members.includes(agent.id)) throw new ProtocolError('forbidden', '请选择包含该 Agent 的房间', 403);
    const target = installTargetOf(request.body?.target);
    const host = request.headers.host ?? '127.0.0.1:4317';
    return installConnector(target, {
      url: `http://${host}`, token: issueAgentToken(tokenSecret, agent.id, roomId), roomId,
      node: process.execPath, bridge: resolve(root, '..', 'scripts', 'room-agent-mcp.mjs'),
      projectPath: target === 'claude-project' ? projectDirOf(request.body?.projectPath) : undefined
    });
  });
  app.post<{ Params: { id: string }; Body: { roomId?: string; target?: string; projectPath?: string } }>('/api/agents/:id/connect/preview', request => {
    const agent = store.get<AgentDescriptor>('agents', request.params.id);
    if (!agent) throw new ProtocolError('not_found', 'Agent 不存在', 404);
    const roomId = String(request.body?.roomId ?? '');
    const room = roomId ? store.room(roomId) : undefined;
    if (!room || !room.members.includes(agent.id)) throw new ProtocolError('forbidden', '请选择包含该 Agent 的房间', 403);
    const target = installTargetOf(request.body?.target);
    const host = request.headers.host ?? '127.0.0.1:4317';
    return previewConnector(target, {
      url: `http://${host}`, token: issueAgentToken(tokenSecret, agent.id, roomId), roomId,
      node: process.execPath, bridge: resolve(root, '..', 'scripts', 'room-agent-mcp.mjs'),
      projectPath: target === 'claude-project' ? projectDirOf(request.body?.projectPath) : undefined
    });
  });
  app.post<{ Params: { id: string }; Body: { target?: string; projectPath?: string } }>('/api/agents/:id/connect/uninstall', request => {
    const target = installTargetOf(request.body?.target);
    return uninstallConnector(target, { projectPath: target === 'claude-project' ? projectDirOf(request.body?.projectPath) : undefined });
  });
  app.post<{ Body: { roomId?: string; name?: string; arguments?: Record<string, unknown> } }>('/api/agent/tool', async (request, reply) => {
    if (request.headers['room-protocol-version'] !== VERSION) return reply.code(426).send({ code: 'version_mismatch', message: `需要 Room Protocol ${VERSION}` });
    const bearer = request.headers.authorization?.replace(/^Bearer /, '');
    const input = agentToolCallSchema.parse(request.body);
    const agentId = bearer ? verifyAgentToken(tokenSecret, bearer, input.roomId) : undefined;
    if (!agentId) return reply.code(401).send({ code: 'invalid_agent_token', message: 'Agent 接入令牌无效' });
    try {
      return { result: await worker.agentTool(agentId, input.roomId, input.name, input.arguments, input.commandId) };
    } catch (error) {
      if (error instanceof ProtocolError) return reply.code(error.status).send({ code: error.code, message: error.message });
      return reply.code(400).send({ code: 'tool_failed', message: (error as Error).message });
    }
  });
  app.get('/api/capabilities',request=>({version:VERSION,supportedVersions:[VERSION],clientType:request.headers['room-client-type']==='browser'?'browser':'sdk',actor:OWNER,commands:Object.keys(payloadSchemas),messageFormats:['text/plain','application/json'],visibility:['room-public'],transports:['http','websocket']} satisfies ServerCapabilities));
  app.get('/api/settings',()=>store.settings());
  app.get<{Params:{id:string}}>('/api/runs/:id/operations',request=>{
    const run=store.get<Run>('runs',request.params.id);if(!run)throw new ProtocolError('not_found','运行不存在',404);
    return store.list<ToolOperation>('operations',run.roomId).filter(operation=>operation.runId===run.id);
  });
  app.get<{Params:{id:string}}>('/api/rooms/:id/integrations', request => {
    const room = store.room(request.params.id); if (!room) throw new ProtocolError('not_found', '房间不存在', 404);
    return store.list<Integration>('integrations', room.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  app.get<{Params:{id:string}}>('/api/rooms/:id/project-bindings', request => {
    const room = store.room(request.params.id); if (!room) throw new ProtocolError('not_found', '房间不存在', 404);
    return store.list<ProjectBinding>('project_bindings', room.id).sort((a, b) => b.version - a.version);
  });
  app.get<{Params:{id:string;agentId:string}}>('/api/rooms/:id/agents/:agentId/capabilities', request => {
    const room = store.room(request.params.id); if (!room) throw new ProtocolError('not_found', '房间不存在', 404);
    const agent = store.get<AgentDescriptor>('agents', request.params.agentId); if (!agent) throw new ProtocolError('not_found', 'Agent 不存在', 404);
    const fingerprint = agentCapabilityFingerprint(agent);
    const evidence = store.list<CapabilityEvidence>('capability_evidence', room.id).filter(item => item.fingerprint === fingerprint);
    const states = capabilityNames.map(capability => {
      const match = evidence.find(item => item.capability === capability);
      return {capability, state: verifiedCapabilityState(fingerprint, evidence, capability), mode: match?.mode ?? 'not_run', testedAt: match?.testedAt ?? null};
    });
    return {fingerprint, states, member: room.members.includes(agent.id)};
  });
  app.post<{Params:{id:string};Body:{roomId?:string}}>('/api/agents/:id/capabilities/probe', request => {
    const roomId = request.body?.roomId; const room = roomId ? store.room(roomId) : undefined;
    if (!roomId || !room) throw new ProtocolError('not_found', '房间不存在', 404);
    const agent = store.get<AgentDescriptor>('agents', request.params.id);
    if (!agent) throw new ProtocolError('not_found', 'Agent 不存在', 404);
    if (!room.members.includes(agent.id)) throw new ProtocolError('not_member', 'Agent 不是该房间成员', 403);
    const {fingerprint, evidence} = probeConfiguredAgent(agent);
    service.execute({version:VERSION,commandId:uid('capability'),type:'capability.verify',roomId,payload:{fingerprint,evidence}});
    return {fingerprint, evidence};
  });
  app.get<{ Params: { id: string } }>('/api/agents/:id/diagnostics', async request => {
    const agent = store.get<AgentDescriptor>('agents', request.params.id); if (!agent) throw new ProtocolError('not_found', 'Agent 不存在', 404); return diagnose(agent, worker.host);
  });
  app.post<{Params:{id:string}}>('/api/runs/:id/codex/reconcile',async request=>{
    const {cancel}=z.object({cancel:z.boolean().default(false)}).strict().parse(request.body??{});
    return worker.reconcileCodex(request.params.id,cancel);
  });
  app.post('/api/sandbox/probe', () => worker.host.probe(true));
  app.post<{Params:{id:string}}>('/api/agents/:id/protocol-probe',async request=>{
    const agent=store.get<AgentDescriptor>('agents',request.params.id);if(!agent)throw new ProtocolError('not_found','Agent 不存在',404);
    return probeAgentProtocol(agent,worker.host);
  });
  app.post('/api/commands', request => service.execute(request.body));
  app.post<{ Params: { roomId: string } }>('/api/rooms/:roomId/attachments', async request => {
    if (!store.room(request.params.roomId)) throw new ProtocolError('not_found', '房间不存在', 404);
    const part = await request.file(); if (!part) throw new ProtocolError('file_required', '请选择文件');
    const bytes = await part.toBuffer();
    const artifact: Artifact = { id: uid('artifact'), roomId: request.params.roomId, name: part.filename.slice(0,160), kind: 'file', mediaType: part.mimetype, size: bytes.length, createdAt: now() };
    mkdirSync(join(root, 'artifacts'), { recursive: true }); writeFileSync(join(root, 'artifacts', artifact.id), bytes);
    store.atomic(() => {  store.event(artifact.roomId, 'artifact.created', OWNER, { artifact }); }); return artifact;
  });
  app.get<{ Params: { id: string } }>('/api/artifacts/:id', (request, reply) => {
    const artifact = store.get<Artifact>('artifacts', request.params.id); if (!artifact) throw new ProtocolError('not_found', '交付物不存在', 404);
    return reply.header('content-type', 'application/octet-stream').header('x-content-type-options', 'nosniff').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`).send(readFileSync(join(root, 'artifacts', artifact.id)));
  });
  app.get<{ Params: { id: string } }>('/api/artifacts/:id/preview', request => {
    const artifact = store.get<Artifact>('artifacts', request.params.id); if (!artifact) throw new ProtocolError('not_found', '交付物不存在', 404);
    if (artifact.size > 2 ** 20 || !/^(text\/|application\/(json|xml))/.test(artifact.mediaType)) return { artifact, text: null };
    return { artifact, text: readFileSync(join(root, 'artifacts', artifact.id), 'utf8') };
  });
  app.get('/api/events', { websocket: true }, (socket, request) => {
    let roomId: string | undefined, handshake = false;
    const timeout = setTimeout(() => { if (!handshake) socket.close(1008, 'Handshake required'); }, 5000);
    const durable=(event:RoomEvent)=>{if(socket.readyState!==1)return false;if(socket.bufferedAmount>1024*1024){socket.close(1013,'Durable replay required');return false;}socket.send(JSON.stringify(event));return true;};
    const eventListener = (event: RoomEvent) => { if (event.roomId === roomId) durable(event); };
    const deltaListener = (delta: any) => { if (delta.roomId === roomId && socket.readyState === 1 && socket.bufferedAmount<256*1024) socket.send(JSON.stringify(delta)); };
    socket.on('message', raw => {
      try {
        if (handshake) throw new Error('Already subscribed');
        const input = z.object({ version: z.literal(VERSION), roomId: z.string(), after: z.number().int().min(0),clientType:z.enum(['browser','sdk']).default('browser') }).strict().parse(JSON.parse(raw.toString()));
        const room = store.room(input.roomId); if (!room || input.after > room.seq) throw new Error('Invalid room or cursor');
        roomId = input.roomId; handshake = true; clearTimeout(timeout);
        // Synchronous replay and subscription registration cannot interleave with a commit.
        let cursor = input.after;
        while (cursor < room.seq) { const page = store.events(roomId, cursor, 1000); if (!page.length) break; for (const event of page)if(!durable(event))return; cursor = page.at(-1)!.seq; }
        store.listeners.add(eventListener); worker.streamListeners.add(deltaListener);
        socket.send(JSON.stringify({ type: 'subscribed', version: VERSION, roomId, seq: room.seq,clientType:input.clientType,actor:OWNER }));
      } catch { socket.close(1008, 'Invalid protocol handshake'); }
    });
    socket.on('close', () => { clearTimeout(timeout); store.listeners.delete(eventListener); worker.streamListeners.delete(deltaListener); });
  });
  if (options.dev) {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true, ...(options.devHmrPort ? { hmr: { port: options.devHmrPort } } : {}) }, appType: 'spa' });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ code: 'not_found', message: '接口不存在' });
      reply.hijack(); vite.middlewares(request.raw, reply.raw, () => { reply.raw.statusCode = 404; reply.raw.end('Not found'); });
    });
    app.addHook('onClose', async () => { await vite.close(); });
  } else if (existsSync(resolve('dist/web/index.html'))) {
    await app.register(staticFiles, { root: resolve('dist/web'), wildcard: false });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ code: 'not_found', message: '接口不存在' }) : reply.sendFile('index.html'));
  }
  app.addHook('onClose', async () => { await worker.close(); store.close(); });
  if (options.startWorker !== false) worker.start();
  return { app, store, service, worker, token };
}
