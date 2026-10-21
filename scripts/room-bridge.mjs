import net from 'node:net';
import readline from 'node:readline';
import { createHash,randomUUID } from 'node:crypto';
import { roomSendImage, roomSendImageTool, imageRoots } from './room-image-transfer.mjs';
const bridgeInstance=randomUUID();
const tools = [
  { name: 'room_read', description: 'Read the current room history and accepted decisions.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'room_post', description: 'Post a public message as yourself. Mentions do not grant execution authority. Use attachments returned by image uploads for image messages.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, mentions: { type: 'array', items: { type: 'string' } }, replyTo: { type: 'string' }, attachments: { type: 'array', items: { type: 'string' }, maxItems: 10 } }, additionalProperties: false } },
  roomSendImageTool,
  { name: 'task_propose', description: 'Propose a task for human review; never authorizes execution.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, agentId: { type: 'string' } }, required: ['title', 'agentId'], additionalProperties: false } },
  { name: 'artifact_publish', description: 'Publish a text report as an artifact in this room.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, text: { type: 'string' } }, required: ['name', 'text'], additionalProperties: false } }
];
for(const tool of tools)if(tool.name!=='room_read'){
  tool.inputSchema.properties.operationId={type:'string',pattern:'^[a-zA-Z0-9_-]{1,128}$',description:'Stable operation ID. Reuse this value when retrying the same write; never reuse it for different arguments.'};
}
function call(name, args, operationId) {
  return new Promise((resolve, reject) => {
    const pipe = process.env.ROOM_PIPE;
    if (!pipe?.startsWith('\\\\.\\pipe\\LOCAL\\TemptRoom-') && !pipe?.startsWith('\\\\.\\pipe\\TemptRoom-host-')) return reject(new Error('No scoped room pipe'));
    const socket = net.connect(pipe); let buffer = '';
    socket.setTimeout(30000, () => socket.destroy(new Error('Room request timed out')));
    socket.on('connect', () => socket.write(JSON.stringify({ name, arguments: args,operationId }) + '\n'));
    socket.on('data', chunk => { buffer += chunk.toString(); if (buffer.length > 2 ** 20) socket.destroy(new Error('Room response too large')); const end = buffer.indexOf('\n'); if (end >= 0) { try { resolve(JSON.parse(buffer.slice(0, end))); } catch(e) { reject(e); } socket.end(); } });
    socket.on('error', reject); socket.on('end', () => { if (!buffer.includes('\n')) reject(new Error('Room pipe closed')); });
  });
}
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  let request;
  try {
    if (line.length > 2 ** 20) throw new Error('Frame too large');
    request = JSON.parse(line); if (request.id === undefined) continue;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tempt-room', version: '0.1.0' } };
    else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/list') result = { tools };
    else if (request.method === 'tools/call') {
      if (!tools.some(t => t.name === request.params?.name)) throw new Error('Unknown room tool');
      const {operationId:explicitId,...args}=request.params.arguments??{};
      const operationId=explicitId??'mcp_'+createHash('sha256').update(JSON.stringify([bridgeInstance,request.id])).digest('hex');
      if (request.params.name === 'room_send_image') {
        try {
          const image = await roomSendImage(call, {...args, operationId}, imageRoots());
          result = { content: [{ type: 'text', text: JSON.stringify(image) }], isError: false };
        } catch (error) {
          result = { content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code ?? 'image_transfer_failed', message: error.message, stage: error.stage, artifactId: error.artifactId } }) }], isError: true };
        }
      } else {
        const response = await call(request.params.name,args,operationId);
        result = { content: [{ type: 'text', text: JSON.stringify(response) }], isError: Boolean(response.error) };
      }
    } else { process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:request.id, error:{code:-32601,message:'Method not found'} })+'\n'); continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  } catch (e) { if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: e.message } }) + '\n'); }
}
