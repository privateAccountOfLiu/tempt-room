function privateIPv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/** Owner-configured webhook URLs must not become an SSRF primitive. */
export function validateOutboundUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('外发地址必须是合法 URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('外发地址只允许 http/https');
  if (url.username || url.password) throw new Error('外发地址不能包含凭据');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '169.254.169.254' || host === 'metadata.google.internal') throw new Error('禁止访问云元数据地址');
  const local = host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || privateIPv4(host) || host.startsWith('::ffff:127.');
  if (local && !allowPrivate) throw new Error('默认禁止外发到 loopback/私网地址；请显式开启 outboundAllowPrivate');
  return url;
}
