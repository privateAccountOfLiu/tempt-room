import readline from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { roomSendImage, roomSendImageTool, imageRoots } from './room-image-transfer.mjs';

/**
 * External room MCP connector.
 *
 * Runs inside the Agent's own environment (Claude Code, DSH, Codex, ...) and
 * connects it to one Tempt Room as one bound Agent identity. The Agent keeps
 * its own permissions, working directory and credentials; this process only
 * relays room reads/posts/tasks/reports over the local HTTP API.
 *
 * Required environment:
 *   ROOM_URL          e.g. http://127.0.0.1:4317
 *   ROOM_AGENT_TOKEN  issued from the Agent connection dialog
 *   ROOM_ROOM_ID      target room id
 */
const base = (process.env.ROOM_URL ?? 'http://127.0.0.1:4317').replace(/\/+$/, '');
const token = process.env.ROOM_AGENT_TOKEN;
const roomId = process.env.ROOM_ROOM_ID;
const connectorId = randomUUID();

const tools = [
  { name: 'room_read', description: 'Read this room: recent messages, members and accepted decisions.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name:'room_inbox',description:'Read contiguous room events after a durable cursor. This does not acknowledge task context.',inputSchema:{type:'object',properties:{afterSeq:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:200}},additionalProperties:false} },
  { name: 'room_post', description: 'Post a public message as yourself. Mentions do not grant execution authority. Use attachments returned by image uploads for image messages.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, mentions: { type: 'array', items: { type: 'string' } }, replyTo: { type: 'string' }, attachments: { type: 'array', items: { type: 'string' }, maxItems: 10 } }, additionalProperties: false } },
  roomSendImageTool,
  { name: 'task_propose', description: 'Propose a task for human review. Optional dependencies are task ids in this room; the human still has to accept it.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, agentId: { type: 'string' }, dependencies: { type: 'array', items: { type: 'string' } } }, required: ['title', 'agentId'], additionalProperties: false } },
  { name: 'task_claim', description: 'Claim an open task in this room. External connectors claim without starting a Tempt Room managed run, then finish it with task_complete.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false } },
  { name: 'task_context', description: 'Read a bounded context delta for your active external task lease. Reconcile your existing candidate with the returned input; fetch further pages while hasMore. Use the returned contextToken in task_complete. This does not renew the lease or authorize new work.', inputSchema: {type:'object',properties:{taskId:{type:'string'},taskVersion:{type:'integer',minimum:1},generation:{type:'integer',minimum:1}},required:['taskId','taskVersion'],additionalProperties:false} },
  { name: 'task_complete', description: 'Finish your externally claimed task while its lease is valid. Echo taskVersion, generation and contextToken returned by task_claim or task_context; context_outdated requires reading task_context and reconciling your candidate first. ok=false marks it failed; summary becomes a room message.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, taskVersion: { type: 'integer', minimum: 1 },generation:{type:'integer',minimum:1}, contextToken:{type:'string'}, ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['taskId','taskVersion','contextToken'], additionalProperties: false } },
  { name: 'task_heartbeat', description: 'Renew your active external task lease. Use the taskVersion returned as version by task_claim; expired or replaced leases cannot be renewed.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, taskVersion: { type: 'integer', minimum: 1 },generation:{type:'integer',minimum:1} }, required: ['taskId','taskVersion'], additionalProperties: false } },
  { name: 'artifact_publish', description: 'Publish a text report as an artifact in this room.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, text: { type: 'string' } }, required: ['name', 'text'], additionalProperties: false } },
  { name: 'room_status', description: 'Read room metadata and task statuses.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'room_wait', description: 'Wait up to 25s for new public messages after a sequence number. Returns timeout=true when nothing arrived.', inputSchema: { type: 'object', properties: { afterSeq: { type: 'number', description: 'Wait for messages after this room sequence; defaults to the current latest sequence.' }, timeoutMs: { type: 'number', description: 'Wait budget in milliseconds (500-25000, default 15000).' } }, additionalProperties: false } },
  { name:'session_inbox', description:'Page durable inbox deliveries for your explicit AgentSession without acknowledging them.', inputSchema:{ type:'object', properties:{ agentSessionId:{type:'string'}, afterSeq:{type:'integer',minimum:0}, limit:{type:'integer',minimum:1,maximum:200} }, required:['agentSessionId'], additionalProperties:false } },
  { name:'session_ack', description:'Acknowledge specific pending inbox deliveries for your explicit AgentSession. Repeating the same acknowledgement is idempotent.', inputSchema:{ type:'object', properties:{ agentSessionId:{type:'string'}, deliveryIds:{type:'array',items:{type:'string'},minItems:1,maxItems:500} }, required:['agentSessionId','deliveryIds'], additionalProperties:false } },
];

async function call(name, args, commandId) {
  if (!token || !roomId) throw new Error('缺少 ROOM_AGENT_TOKEN 或 ROOM_ROOM_ID');
  const response = await fetch(base + '/api/agent/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'room-protocol-version': '0.1' },
    body: JSON.stringify({ commandId, roomId, name, arguments: args ?? {} })
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('房间服务返回非 JSON 响应'); }
  if (!response.ok) throw new Error(body.message ?? ('房间服务 HTTP ' + response.status));
  return body.result;
}

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  let request;
  try {
    if (line.length > 2 ** 20) throw new Error('Frame too large');
    request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tempt-room-connector', version: '0.1.0' } };
    else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/list') result = { tools };
    else if (request.method === 'tools/call') {
      if (!tools.some(tool => tool.name === request.params?.name)) throw new Error('Unknown room tool');
      const {operationId:explicitId,...args}=request.params.arguments??{};
      const rootOperationId=explicitId??`mcp_${createHash('sha256').update(JSON.stringify([connectorId,request.id])).digest('hex')}`;
      const commandId=`mcp_${connectorId}_${createHash('sha256').update(JSON.stringify([request.id,request.params.name])).digest('hex')}`;
      if (request.params.name === 'room_send_image') {
        try {
          const image = await roomSendImage(call, {...args, operationId: rootOperationId}, imageRoots());
          result = { content: [{ type: 'text', text: JSON.stringify(image) }], isError: false };
        } catch (error) {
          result = { content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code ?? 'image_transfer_failed', message: error.message, stage: error.stage, artifactId: error.artifactId } }) }], isError: true };
        }
      } else {
        const response = await call(request.params.name, args, explicitId ? `mcp_${createHash('sha256').update(explicitId).digest('hex')}` : commandId);
        result = { content: [{ type: 'text', text: JSON.stringify(response) }], isError: Boolean(response?.error) };
      }
    } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  } catch (error) {
    if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error.message } }) + '\n');
  }
}
