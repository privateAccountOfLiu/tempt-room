// AppContainer compatibility for Node/Electron's ancestor-walking realpath.
// This never grants filesystem access. Missing targets and reparse points stay
// errors. Only paths within roots attested by the native host can fall back.
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

function install(targetFs, roots, syncExports = () => {}) {
  const original = targetFs.realpathSync, native = original.native;
  const under = (root, value) => { const rel = path.relative(root, value); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };
  const fallback = (value, options, error) => {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    if (typeof value !== 'string' && !Buffer.isBuffer(value)) throw error;
    const absolute = path.resolve(String(value)), root = roots.find(root => under(root, absolute));
    if (!root) throw error;
    let current = root;
    for (const part of ['', ...path.relative(root, absolute).split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      // Inspect each component below the prevalidated root. In particular,
      // ENOENT is never converted into a successful realpath result.
      if (targetFs.lstatSync(current).isSymbolicLink()) throw error;
    }
    return options === 'buffer' || options?.encoding === 'buffer' ? Buffer.from(absolute) : absolute;
  };
  const wrap = fn => function(value, options) { try { return fn.call(targetFs, value, options); } catch (error) { return fallback(value, options, error); } };
  targetFs.realpathSync = wrap(original);
  targetFs.realpathSync.native = wrap(native || original);
  const asyncWrap = fn => function(value, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (typeof callback !== 'function') throw new TypeError('realpath requires a callback');
    fn.call(targetFs, value, options, (error, result) => {
      if (!error) return callback(null, result);
      let replacement;
      try { replacement = fallback(value, options, error); } catch (next) { return callback(next); }
      callback(null, replacement);
    });
  };
  const asyncOriginal = targetFs.realpath;
  targetFs.realpath = asyncWrap(asyncOriginal);
  targetFs.realpath.native = asyncWrap(asyncOriginal.native || asyncOriginal);
  const promised = targetFs.promises.realpath.bind(targetFs.promises);
  targetFs.promises.realpath = async (value, options) => { try { return await promised(value, options); } catch (error) { return fallback(value, options, error); } };
  syncExports();
}

module.exports = { install };
if (process.env.ROOM_RUNTIME_ROOTS) {
  const roots = JSON.parse(process.env.ROOM_RUNTIME_ROOTS);
  if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new Error('Invalid sandbox runtime roots');
  install(fs, roots.map(root => path.resolve(root)).sort((a,b)=>b.length-a.length), syncBuiltinESMExports);
}
