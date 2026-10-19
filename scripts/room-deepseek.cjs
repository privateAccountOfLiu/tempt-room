'use strict';
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { registerHooks } = require('node:module');

// Verified from Desktop 0.2.0-rc.2. Unknown module contents fail explicitly.
const persistenceHash = '0845707017acc2b4a8a75eab2244fa3fd88587b8094ab32014321dce7ca1e31b';
const originalRoot = 'const root = parse(absolute).root;\n\tawait assertDirectory(root);';
function chooseWritableRoot(absolute, roots) {
  const canonical = value => typeof value === 'string' && /^[a-z]:[\\/]/i.test(value) && !/(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(value);
  if (!canonical(absolute) || !Array.isArray(roots) || !roots.length || roots.some(root => !canonical(root))) throw new Error('Invalid isolated writable roots');
  const normalized = absolute.replaceAll('/', '\\').toLowerCase();
  const candidates = roots.map(root => root.replace(/[\\/]+$/, '')).sort((a, b) => b.length - a.length);
  const root = candidates.find(root => { const prefix = root.replaceAll('/', '\\').toLowerCase(); return normalized === prefix || normalized.startsWith(prefix + '\\'); });
  if (!root) throw new Error('DSH persistence directory is outside the isolated writable roots');
  return root;
}
function rewritePersistence(source) {
  if (createHash('sha256').update(source).digest('hex') !== persistenceHash || source.split(originalRoot).length !== 2) throw new Error('Unsupported DSH persistence module; verify its version before enabling compatibility');
  return source.replace(originalRoot, `const root = (${chooseWritableRoot.toString()})(absolute, JSON.parse(process.env.ROOM_WRITABLE_ROOTS));\n\tawait assertDirectory(root);`);
}
module.exports = { chooseWritableRoot, rewritePersistence };

if (process.env.ROOM_WRITABLE_ROOTS) {
  if (require('./room-pipe-compat.node').installed !== true) throw new Error('DSH compatibility requires the verified native pipe module');
  const roots = JSON.parse(process.env.ROOM_WRITABLE_ROOTS);
  if (!Array.isArray(roots) || roots.length !== 2) throw new Error('Expected workspace and isolated home roots');
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.startsWith('file:')) return result;
      const path = fileURLToPath(url).replaceAll('\\', '/');
      if (!path.endsWith('/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')) return result;
      if (result.format !== 'module' || result.source === undefined) throw new Error('Unsupported DSH persistence loader format');
      const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
      return { ...result, source: rewritePersistence(source) };
    }
  });
}
