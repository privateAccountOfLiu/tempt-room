import { parseArgs } from 'node:util';
import { agentSchema } from '../packages/protocol/src/index.ts';
import { diagnoseCodexAttachment } from '../apps/server/src/codex-attach.ts';

const { values } = parseArgs({ options: {
  endpoint: { type: 'string' }, thread: { type: 'string' }, cwd: { type: 'string' },
  transport: { type: 'string', default: 'websocket' }, 'credential-env': { type: 'string', default: 'ROOM_CODEX_ATTACH_TOKEN' },
  codex: { type: 'string', default: '' }, version: { type: 'string', default: '' }, help: { type: 'boolean' }
} });
if (values.help) {
  console.log('npm run codex:check-attach -- --endpoint <ws://127.0.0.1:port> --thread <threadId> --cwd <absolute-path> [--credential-env ROOM_CODEX_ATTACH_TOKEN] [--version <version>]\nControl socket: --transport control-socket --endpoint <absolute-socket-path> --codex <absolute-codex.exe>\nRead-only: no thread creation, resume, queue writes, model prompts or configuration changes.');
} else {
  const agent = agentSchema.parse({ id: 'codex-attach-check', name: 'Codex attach check', provider: 'codex', connectionMode: 'attach', executionMode: 'host', executable: values.codex, version: values.version,
    codexBinding: { transport: values.transport, endpoint: values.endpoint, credentialEnv: values['credential-env'], threadId: values.thread, expectedCwd: values.cwd } });
  const report = await diagnoseCodexAttachment(agent);
  console.log(JSON.stringify({ ...report, modelRequests: 0, mutatingMethods: [] }, null, 2));
  if (!report.ready) process.exitCode = 1;
}
