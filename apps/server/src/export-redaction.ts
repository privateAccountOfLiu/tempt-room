const sensitiveKey = /(?:password|passwd|secret|token|api[-_]?key|authorization|credential|private[-_]?key)/i;
const secretValue = new RegExp([
  String.raw`sk-[A-Za-z0-9]{16,}`,
  String.raw`gh[pousr]_[A-Za-z0-9]{20,}`,
  String.raw`xox[baprs]-[A-Za-z0-9-]{10,}`,
  String.raw`AKIA[0-9A-Z]{16}`,
  String.raw`Bearer\s+[A-Za-z0-9._~+/=-]{16,}`,
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`
].join('|'), 'g');

export interface RedactionResult<T> {
  value: T;
  redactions: number;
}

/** Best-effort export redaction. This is defense in depth, not a replacement
 * for reviewing an export before sharing it outside the room. */
export function redactExport<T>(input: T): RedactionResult<T> {
  let redactions = 0;
  const walk = (value: any, key = ''): any => {
    if (typeof value === 'string') {
      if (key && sensitiveKey.test(key)) { redactions++; return '[REDACTED]'; }
      const replaced = value.replace(secretValue, () => { redactions++; return '[REDACTED]'; });
      return replaced;
    }
    if (Array.isArray(value)) return value.map(item => walk(item, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, sensitiveKey.test(childKey) && item !== null && typeof item !== 'object' ? (redactions++, '[REDACTED]') : walk(item, childKey)]));
    }
    return value;
  };
  return {value: walk(input), redactions};
}
