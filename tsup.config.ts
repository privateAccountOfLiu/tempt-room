import { defineConfig } from 'tsup';
// node:sqlite is a prefix-only builtin. Removing "node:" makes production
// incorrectly resolve it as an npm package, even though TypeScript succeeds.
export default defineConfig({ removeNodeProtocol:false });
