import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** ACP uses an env array; Claude's stdio MCP configuration uses a string map. */
export function claudeMcpConfig(server: { command: string; args: string[]; env: { name: string; value: string }[] }) {
  return { mcpServers: { room: { command: server.command, args: server.args, env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) } } };
}

/** Each physical execution keeps its own immutable room transport configuration. */
export async function writeClaudeRoomConfig(home:string,executionId:string,server:Parameters<typeof claudeMcpConfig>[0]){
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(executionId))throw new Error('Invalid execution identity');
  const path=join(home,`${executionId}.room-mcp.json`);
  await writeFile(path,JSON.stringify(claudeMcpConfig(server)),{flag:'wx'});
  return path;
}

interface ClaudeControlChannel {
  onFrame?: (frame: any) => void;
  write(data: string): Promise<void>;
  exit: Promise<unknown>;
}

/** Control messages initialize the CLI and inspect MCP without a model prompt. */
export async function checkClaudeRoomMcp(channel: ClaudeControlChannel, timeoutMs = 30000): Promise<void> {
  const previous = channel.onFrame;
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  channel.onFrame = frame => {
    previous?.(frame);
    const response = frame.type === 'control_response' ? frame.response : undefined;
    const request = response && pending.get(response.request_id);
    if (!request) return;
    pending.delete(response.request_id); clearTimeout(request.timer);
    if (response.subtype === 'error') request.reject(new Error(response.error ?? 'Claude 控制请求失败'));
    else request.resolve(response.response);
  };
  const deadline = Date.now() + timeoutMs;
  const request = (subtype: string) => {
    const id = randomUUID();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Claude ${subtype} 超时`)); }, Math.max(1, deadline - Date.now()));
      pending.set(id, { resolve, reject, timer });
      channel.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } }) + '\n')
        .catch(error => { pending.delete(id); clearTimeout(timer); reject(error); });
    });
  };
  const closed = () => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('Claude 控制通道已退出')); } pending.clear(); };
  void channel.exit.then(closed, closed);
  try {
    await request('initialize');
    while (Date.now() < deadline) {
      const status = await request('mcp_status');
      const room = status?.mcpServers?.find((server: any) => server.name === 'room');
      if (room?.status !== 'pending') { requireClaudeRoomMcp({ type: 'system', subtype: 'init', mcp_servers: status?.mcpServers }); return; }
      await delay(Math.min(250, Math.max(0, deadline - Date.now())));
    }
    throw new Error('Claude 房间 MCP 连接超时');
  } finally {
    channel.onFrame = previous;
    closed();
  }
}

/** A model reply alone does not prove that the room tools were mounted. */
export function requireClaudeRoomMcp(frame: any): void {
  if (frame.type !== 'system' || frame.subtype !== 'init') return;
  const room = frame.mcp_servers?.find((server: any) => server.name === 'room');
  if (room?.status === 'connected') return;
  const errors = frame.mcp_server_errors?.filter((error: any) => error.name === 'room' || error.serverName === 'room');
  const detail = errors?.map((error: any) => error.error ?? error.message ?? '配置无效').join('; ');
  throw new Error(`Claude 房间 MCP 未连接：${room?.status ?? '未加载 room 服务'}${detail ? '; ' + detail : ''}`);
}
