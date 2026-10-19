import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ProtocolError } from '../../../packages/protocol/src/index.ts';

export function publicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a,b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19));
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    // IPv4 mapped, NAT64, local, documentation and non-global routes are not accepted.
    return /^[23][0-9a-f]{3}:/.test(lower) && !lower.startsWith('2001:db8:') && !lower.startsWith('2002:') && !lower.startsWith('2001:0:');
  }
  return false;
}
export async function remoteRequest(urlString: string, options: { method?: string; body?: unknown; token?: string; signal?: AbortSignal; headers?: Record<string,string> } = {}) {
  const url = new URL(urlString);
  if (url.protocol !== 'https:' || url.username || url.password) throw new ProtocolError('endpoint_rejected', '远程端点必须为无内嵌凭据的公网 HTTPS URL');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new ProtocolError('endpoint_rejected', '端点解析到了本机、内网或其他受限地址');
  const selected = addresses[0];
  return new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const request = https.request(url, { method: options.method ?? (body ? 'POST' : 'GET'), agent: false, signal: options.signal, timeout: 120000,
      lookup: ((_host: string, opts: any, callback: any) => opts.all ? callback(null, [{address: selected.address, family: selected.family}]) : callback(null, selected.address, selected.family)) as any,
      headers: { accept: 'application/json, text/event-stream', ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body).toString() } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers }
    }, response => {
      if ((response.statusCode ?? 500) >= 300) { response.resume(); reject(new Error(`远程服务返回 HTTP ${response.statusCode}（不自动跟随重定向）`)); }
      else resolve(response);
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error('远程服务连接超时'))); request.end(body);
  });
}
export async function readJson(response: import('node:http').IncomingMessage): Promise<any> {
  let text = ''; for await (const chunk of response) { text += chunk.toString(); if (text.length > 8 * 1024 * 1024) { response.destroy(); throw new Error('远程响应过大'); } } return JSON.parse(text);
}
export async function* sse(response: import('node:http').IncomingMessage): AsyncGenerator<any> {
  let buffer = '', total = 0; const decoder = new TextDecoder();
  for await (const chunk of response) {
    total += chunk.length; if (total > 16 * 1024 * 1024) { response.destroy(); throw new Error('流式输出超过上限'); }
    buffer += decoder.decode(chunk, { stream: true }); buffer = buffer.replaceAll('\r\n', '\n');
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (data === '[DONE]') return; if (data) yield JSON.parse(data);
    }
  }
}
