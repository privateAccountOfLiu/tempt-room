import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-Agent room tokens derive from the startup secret, so they need no storage
 * and rotate with the service. Each token binds one Agent to one room; current
 * membership and enabled status are checked separately on every tool call.
 */
const validId = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const signature = (secret: string, agentId: string, roomId: string) => createHmac('sha256', secret).update(JSON.stringify(['room-agent-v1', agentId, roomId])).digest('hex');

export function issueAgentToken(secret: string, agentId: string, roomId: string): string {
  if (!validId(agentId) || !validId(roomId)) throw new Error('Invalid Agent or room identity');
  return `${agentId}.v1.${roomId}.${signature(secret, agentId, roomId)}`;
}

export function verifyAgentToken(secret: string, token: string, roomId: string): string | undefined {
  const [agentId, version, boundRoom, provided, extra] = token.split('.');
  if (extra !== undefined || version !== 'v1' || boundRoom !== roomId || !validId(agentId ?? '') || !validId(boundRoom ?? '') || !/^[0-9a-f]{64}$/.test(provided ?? '')) return undefined;
  const expected = signature(secret, agentId, boundRoom);
  const a = Buffer.from(provided, 'utf8'), b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return agentId;
}
