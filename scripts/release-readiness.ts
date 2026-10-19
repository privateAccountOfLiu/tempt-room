// Aggregate the latest local verification reports into a human-readable release
// readiness summary. It only reads existing reports and never calls a model.
//
// Run: npm run report:readiness
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const project = resolve('.');
const state = join(project, '.state');
const output = join(project, 'docs', 'RELEASE-READINESS.md');
const generatedAt = new Date().toISOString();

interface Gate {name: string; ok: boolean | 'missing'; detail: string; evidence: string; extra?: string; optional?: boolean}
const gates: Gate[] = [];

function readJson<T>(file: string): T | undefined {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : undefined; } catch { return undefined; }
}
function newestChild(dir: string, prefix: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const entries = readdirSync(dir).filter(name => name.startsWith(prefix)).map(name => ({name, path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs}));
  return entries.sort((a, b) => b.mtime - a.mtime)[0]?.path;
}
function latestRun(reportDir: string, fileName = 'report.json'): string | undefined {
  const dir = newestChild(reportDir, 'run-');
  if (!dir) return undefined;
  const file = join(dir, fileName);
  return existsSync(file) ? file : undefined;
}
function addGate(name: string, ok: boolean | 'missing', detail: string, evidence: string, extra?: string, optional = false) { gates.push({name, ok, detail, evidence, extra, optional}); }

// Preflight / browser E2E / production smoke each publish {run, report, ok}.
for (const [name, dir, label] of [
  ['预发布检查（preflight）', 'preflight', 'typecheck→test→build→SDK→浏览器→生产'],
  ['浏览器端到端（browser-e2e）', 'browser-e2e', '真实无头 Edge/Chrome'],
  ['生产构建启动（production-smoke）', 'production-smoke', 'dist 产物 + 隔离数据目录']
] as const) {
  const latest = readJson<{run: string; report: string; ok: boolean}>(join(state, dir, 'latest.json'));
  const report = latest?.report ? readJson<{steps?: Array<{name: string; ok: boolean; skipped?: boolean}>}>(latest.report) : undefined;
  if (!latest) addGate(name, 'missing', `${label}：尚无报告`, join('.state', dir, 'latest.json'));
  else {
    const steps = report?.steps ?? [];
    const passed = steps.filter(step => step.ok !== false).length;
    addGate(name, latest.ok, latest.ok ? `${label}：通过（${passed}/${steps.length} 步）` : `${label}：存在失败`, latest.report);
  }
}

const sandbox = readJson<{ready?: boolean; checks?: Array<{passed: boolean}>}>(join(state, 'diagnostics', 'sandbox.json'));
if (!sandbox) addGate('Windows 原生沙箱', 'missing', '尚无探测报告', '.state/diagnostics/sandbox.json');
else addGate('Windows 原生沙箱', sandbox.ready === true, `${(sandbox.checks ?? []).filter(check => check.passed).length}/${(sandbox.checks ?? []).length} 项通过`, '.state/diagnostics/sandbox.json');

const secretScan = readJson<{ok?: boolean; checkedAt?: string; findings?: unknown[]}>(join(state, 'secret-scan', 'latest.json'));
if (!secretScan) addGate('仓库密钥扫描', 'missing', '尚未运行 npm run check:secrets', '.state/secret-scan/latest.json');
else addGate('仓库密钥扫描', secretScan.ok === true, `${secretScan.ok ? '源码/文档未发现疑似 API Key 或房间令牌' : `发现 ${(secretScan.findings ?? []).length} 个疑似密钥`}（${secretScan.checkedAt ?? '?'}）`, '.state/secret-scan/latest.json');

const claudeSmoke = readJson<{run?: string; report?: string; ok?: boolean; mode?: string; finishedAt?: string}>(join(state, 'claude-smoke', 'latest.json'));
if (!claudeSmoke || !claudeSmoke.report) addGate('Claude 沙箱真实轮次（单项）', 'missing', '尚未运行 npm run test:claude -- --allow-paid', '.state/claude-smoke/latest.json');
else addGate('Claude 沙箱真实轮次（单项）', claudeSmoke.ok === true, `${claudeSmoke.mode ?? 'unknown'} · ${claudeSmoke.ok ? 'AppContainer + 原生会话 + 回复通过' : '失败'}`, claudeSmoke.report);

const sandboxArtifactSmoke = readJson<{run?: string; report?: string; ok?: boolean; finishedAt?: string}>(join(state, 'sandbox-artifact-smoke', 'latest.json'));
if (!sandboxArtifactSmoke || !sandboxArtifactSmoke.report) addGate('沙箱真实 Agent 成果应用（Claude）', 'missing', '尚未运行 npm run test:sandbox-artifact -- --allow-paid', '.state/sandbox-artifact-smoke/latest.json');
else addGate('沙箱真实 Agent 成果应用（Claude）', sandboxArtifactSmoke.ok === true, `${sandboxArtifactSmoke.ok ? '沙箱文件差异交付物已应用到原项目并校验内容' : '失败'}`, sandboxArtifactSmoke.report);

const sandboxHandoffSmoke = readJson<{run?: string; report?: string; ok?: boolean; finishedAt?: string}>(join(state, 'sandbox-handoff-smoke', 'latest.json'));
if (!sandboxHandoffSmoke || !sandboxHandoffSmoke.report) addGate('沙箱两 Agent 任务接力（Claude + DeepSeek）', 'missing', '尚未运行 npm run test:sandbox-handoff -- --allow-paid', '.state/sandbox-handoff-smoke/latest.json');
else addGate('沙箱两 Agent 任务接力（Claude + DeepSeek）', sandboxHandoffSmoke.ok === true, `${sandboxHandoffSmoke.ok ? 'Claude v1 完成并应用成果，交接 DeepSeek v2 完成，两条运行均带 AppContainer 证明' : '失败'}`, sandboxHandoffSmoke.report);

const codexSmoke = readJson<{run?: string; report?: string; ok?: boolean; mode?: string; finishedAt?: string}>(join(state, 'codex-smoke', 'latest.json'));
if (!codexSmoke || !codexSmoke.report) addGate('Codex 本机直连真实轮次（单项）', 'missing', '尚未运行 npm run test:codex -- --allow-paid', '.state/codex-smoke/latest.json');
else addGate('Codex 本机直连真实轮次（单项）', codexSmoke.ok === true, `${codexSmoke.mode ?? 'unknown'} · ${codexSmoke.ok ? 'ChatGPT 登录 + 房间 MCP + 回复通过' : '失败'}`, codexSmoke.report);

const deepseekSmoke = readJson<{run?: string; report?: string; ok?: boolean; mode?: string; finishedAt?: string}>(join(state, 'deepseek-smoke', 'latest.json'));
if (!deepseekSmoke || !deepseekSmoke.report) addGate('DeepSeek 本机直连真实轮次（单项）', 'missing', '尚未运行 npm run test:deepseek -- --allow-paid', '.state/deepseek-smoke/latest.json');
else addGate('DeepSeek 本机直连真实轮次（单项）', deepseekSmoke.ok === true, `${deepseekSmoke.mode ?? 'unknown'} · ${deepseekSmoke.ok ? 'DSH + 房间 MCP + 回复通过' : '失败'}`, deepseekSmoke.report);

const externalMcp = readJson<{report?: string; ok?: boolean; checkedAt?: string}>(join(state, 'external-mcp', 'latest.json'));
if (!externalMcp || !externalMcp.report) addGate('外部会话令牌（Claude Code / Codex）', 'missing', '尚未运行 npm run test:external-mcp', '.state/external-mcp/latest.json');
else addGate('外部会话令牌（Claude Code / Codex）', externalMcp.ok === true, `room_status 检查通过（${externalMcp.checkedAt ?? '?'}）`, externalMcp.report);

const runnerSmoke = readJson<{run?: string; report?: string; ok?: boolean; finishedAt?: string}>(join(state, 'runner-smoke', 'latest.json'));
if (!runnerSmoke || !runnerSmoke.report) addGate('外部 Agent 自动值守运行器（假 CLI）', 'missing', '尚未运行 npm run test:runner', '.state/runner-smoke/latest.json');
else addGate('外部 Agent 自动值守运行器（假 CLI）', runnerSmoke.ok === true, `${runnerSmoke.ok ? '@提及后启动 CLI 并以 Agent 身份回帖，无模型请求' : '失败'}`, runnerSmoke.report);

const runnerRealSmoke = readJson<{run?: string; report?: string; ok?: boolean; finishedAt?: string}>(join(state, 'runner-real-smoke', 'latest.json'));
if (!runnerRealSmoke || !runnerRealSmoke.report) addGate('外部 Agent 自动值守真实模型（Claude CLI）', 'missing', '尚未运行 npm run test:runner-real -- --allow-paid', '.state/runner-real-smoke/latest.json');
else addGate('外部 Agent 自动值守真实模型（Claude CLI）', runnerRealSmoke.ok === true, `${runnerRealSmoke.ok ? '@提及 → 启动真实 Claude CLI → 模型回复以 claude-code 身份回帖' : '失败'}`, runnerRealSmoke.report);

const teamSmoke = readJson<{run?: string; report?: string; ok?: boolean; finishedAt?: string}>(join(state, 'team-smoke', 'latest.json'));
if (!teamSmoke || !teamSmoke.report) addGate('三 Agent host 协作真实轮次（账号登录）', 'missing', '尚未运行 npm run test:team-host -- --allow-paid', '.state/team-smoke/latest.json');
else addGate('三 Agent host 协作真实轮次（账号登录）', teamSmoke.ok === true, `${teamSmoke.ok ? 'Claude/Codex/DeepSeek 同一房间均完成回复' : '失败'}`, teamSmoke.report);

const hostTaskSmoke = readJson<{run?: string; report?: string; ok?: boolean; finishedAt?: string}>(join(state, 'host-task-smoke', 'latest.json'));
if (!hostTaskSmoke || !hostTaskSmoke.report) addGate('账号登录 host 任务编辑（单项）', 'missing', '尚未运行 npm run test:host-task -- --allow-paid', '.state/host-task-smoke/latest.json');
else addGate('账号登录 host 任务编辑（单项）', hostTaskSmoke.ok === true, `${hostTaskSmoke.ok ? '真实模型修改项目文件并完成 task_complete' : '失败'}`, hostTaskSmoke.report);

const hostCommandSmoke = readJson<{run?: string; report?: string; ok?: boolean; finishedAt?: string}>(join(state, 'host-commands-smoke', 'latest.json'));
if (!hostCommandSmoke || !hostCommandSmoke.report) addGate('账号登录 host 命令/测试执行（单项）', 'missing', '尚未运行 npm run test:host-commands -- --allow-paid', '.state/host-commands-smoke/latest.json');
else addGate('账号登录 host 命令/测试执行（单项）', hostCommandSmoke.ok === true, `${hostCommandSmoke.ok ? '真实运行 npm test 并保存输出后完成任务' : '失败'}`, hostCommandSmoke.report);

const hostCancelSmoke = readJson<{run?: string; report?: string; ok?: boolean; finishedAt?: string}>(join(state, 'host-cancel-smoke', 'latest.json'));
if (!hostCancelSmoke || !hostCancelSmoke.report) addGate('账号登录 host 取消运行（单项）', 'missing', '尚未运行 npm run test:host-cancel -- --allow-paid', '.state/host-cancel-smoke/latest.json');
else addGate('账号登录 host 取消运行（单项）', hostCancelSmoke.ok === true, `${hostCancelSmoke.ok ? '长命令运行被取消并进入 canceled 终态' : '失败'}`, hostCancelSmoke.report);

const hostHandoffSmoke = readJson<{run?: string; report?: string; ok?: boolean; finishedAt?: string}>(join(state, 'host-handoff-smoke', 'latest.json'));
if (!hostHandoffSmoke || !hostHandoffSmoke.report) addGate('账号登录 host 任务接力（两 Agent）', 'missing', '尚未运行 npm run test:host-handoff -- --allow-paid', '.state/host-handoff-smoke/latest.json');
else addGate('账号登录 host 任务接力（两 Agent）', hostHandoffSmoke.ok === true, `${hostHandoffSmoke.ok ? 'Claude v1 完成后交接 DeepSeek v2 并完成' : '失败'}`, hostHandoffSmoke.report);

const connectorFile = latestRun(join(state, 'connector-probes'));
const connector = connectorFile ? readJson<{checks?: Array<{passed: boolean}>}>(connectorFile) : undefined;
if (!connector) addGate('Windows 连接器进程树', 'missing', '尚无探测报告', join(state, 'connector-probes'));
else {
  const checks = connector.checks ?? [];
  addGate('Windows 连接器进程树', checks.length > 0 && checks.every(check => check.passed), `${checks.filter(check => check.passed).length}/${checks.length} 项通过`, connectorFile ?? join(state, 'connector-probes'));
}

const protocolDir = join(state, 'native-pipecompat-20261017', 'diagnostics');
const protocols = readJson<Record<string, {ready?: boolean}>>(join(protocolDir, 'agent-protocols.json'));
if (!protocols) addGate('原生 Agent 协议预检', 'missing', '尚无探测报告', join(protocolDir, 'agent-protocols.json'));
else {
  const entries = Object.entries(protocols);
  addGate('原生 Agent 协议预检', entries.every(([, value]) => value?.ready === true), entries.map(([id, value]) => `${id}:${value?.ready ? '通过' : '未通过'}`).join(' / '), join(protocolDir, 'agent-protocols.json'));
}

const suiteRoot = join(state, 'native-pipecompat-20261017', 'acceptance-tests');
const suites = existsSync(suiteRoot)
  ? readdirSync(suiteRoot).filter(name => name.startsWith('suite-')).map(name => ({name, dir: join(suiteRoot, name), mtime: statSync(join(suiteRoot, name)).mtimeMs})).sort((a, b) => b.mtime - a.mtime)
  : [];
const suiteData = (dir: string) => readJson<{mode?: string; outcome?: string; checks?: Array<{status: string}>; agents?: unknown[]; finishedAt?: string}>(join(dir, 'acceptance.json'));
const precheckSuite = suites.find(suite => suiteData(suite.dir)?.mode === 'no-model-preflight');
const paidSuite = suites.find(suite => suiteData(suite.dir)?.mode === 'paid-full-suite');
const precheck = precheckSuite ? suiteData(precheckSuite.dir) : undefined;
if (!precheckSuite || !precheck) addGate('完整验收前置（--check）', 'missing', '尚无 no-model-preflight 验收报告', suiteRoot);
else addGate('完整验收前置（--check）', precheck.outcome === 'ready-for-paid-tests', `${precheck.outcome ?? 'unknown'}（${(precheck.checks ?? []).filter(check => check.status === 'passed').length}/${(precheck.checks ?? []).length} 步，agents=${(precheck.agents ?? []).length}）`, join(precheckSuite.dir, 'acceptance.json'));
const paid = paidSuite ? suiteData(paidSuite.dir) : undefined;
const paidPass = paid?.outcome === 'passed-real-agent-scenarios';
// Account-login environments have no API keys for Claude Code / Codex. When all
// account-login real-turn gates pass, the sandbox + API-key scenario is optional.
const accountLoginReady = Boolean(claudeSmoke?.ok && codexSmoke?.ok && deepseekSmoke?.ok && externalMcp?.ok && teamSmoke?.ok);
if (paidPass) addGate('真实 Agent 场景（沙箱 + 显式密钥）', true, `passed-real-agent-scenarios（${(paid?.checks ?? []).filter(check => check.status === 'passed').length}/${(paid?.checks ?? []).length} 步）`, join(paidSuite!.dir, 'acceptance.json'));
else if (accountLoginReady) addGate('真实 Agent 场景（沙箱 + 显式密钥）', 'missing', '可选档：本机使用账号登录，已由单 Agent / 外部 MCP / 三 Agent host 门禁覆盖；如有 API Key 可运行 --allow-paid', paidSuite ? join(paidSuite.dir, 'acceptance.json') : suiteRoot, undefined, true);
else addGate('真实 Agent 场景（沙箱 + 显式密钥）', paid?.outcome ? false : 'missing', paid ? `${paid.outcome ?? 'unknown'}（${(paid.checks ?? []).filter(check => check.status === 'passed').length}/${(paid.checks ?? []).length} 步，finishedAt=${paid.finishedAt ?? '?'}）` : '尚未执行 --allow-paid，且账号登录证据不完整', paidSuite ? join(paidSuite.dir, 'acceptance.json') : suiteRoot);

const required = gates.filter(gate => !gate.optional);
const missing = required.filter(gate => gate.ok === 'missing').length;
const failed = required.filter(gate => gate.ok === false).length;
const hasOptional = gates.some(gate => gate.optional);
const overall = missing ? '证据不完整' : failed ? '存在失败门禁' : hasOptional ? '必需门禁全部通过（可选沙箱密钥档未执行）' : '无模型门禁与真实场景均通过';
const lines: string[] = [];
lines.push('# Tempt Room 发布就绪摘要', '');
lines.push(`> 自动生成于 ${generatedAt}。仅汇总本机已有报告，不触发任何模型请求。`, '');
lines.push('## 门禁结果', '');
lines.push('| 门禁 | 结果 | 说明 | 证据 |', '| --- | --- | --- | --- |');
for (const gate of gates) {
  const status = gate.optional ? (gate.ok === true ? '通过（可选）' : '可选，未执行') : gate.ok === 'missing' ? '缺失' : gate.ok ? '通过' : '失败';
  const evidence = gate.evidence.replaceAll('\\', '/').replaceAll(project.replaceAll('\\', '/') + '/', '');
  lines.push(`| ${gate.name}${gate.optional ? '（可选）' : ''} | ${status} | ${gate.detail.replaceAll('|', '/')} | \`${evidence}\` |`);
}
lines.push('', '## 结论', '', `- 当前自动汇总：**${overall}**。`);
lines.push('- `test:preflight` 与上述报告均不调用模型；单 Agent 与三 Agent host 真实轮次使用账号登录，沙箱密钥档为可选最高门槛。');
lines.push('', '## 仍待完成 / 可选门槛', '');
lines.push('1. **沙箱 + 显式密钥档（可选最高门槛）**：现有 `test:acceptance` 完整场景要求 managed + sandbox + 显式凭据，仅适用于提供 Codex API Key 的环境；本机 Claude Code / Codex 使用账号登录，账号登录档已由单 Agent、外部 MCP、三 Agent host 协作门禁覆盖（见 `docs/ACCOUNT-LOGIN.md`）。如要额外保留沙箱最高门槛，提供 Codex `OPENAI_API_KEY` 后运行：');
lines.push('   ```powershell');
lines.push('   # 先关闭使用相同 .state 的服务');
lines.push('   npm run test:acceptance -- --allow-paid');
lines.push('   ```');
lines.push('2. **真实第三方 A2A 联调**：当前仅完成本地 HTTP 线上格式测试；生产出口策略要求公网 HTTPS，尚未与外部 A2A 服务对接。');
lines.push('3. **账号登录 host 档**：已完成三 Agent 同房间真实回复、单项冒烟与外部会话验证；后续可扩展到编辑/测试/取消/成果应用的完整场景脚本。');
lines.push('', '## 复现命令', '');
lines.push('```powershell');
lines.push('npm run test:preflight                 # 无模型发布检查（可加 --skip-browser / --skip-sdk）');
lines.push('npm run test:preflight -- --with-native  # 追加连接器与沙箱探测（Windows）');
lines.push('npm run test:browser                   # 真实浏览器端到端（不调用模型）');
lines.push('npm run test:production                # 生产构建启动冒烟（先 npm run build）');
lines.push('npm run test:acceptance -- --check     # 沙箱密钥档前置检查（不调用模型）');
lines.push('npm run test:acceptance -- --allow-paid # 沙箱密钥档真实场景（付费，需用户显式执行）');
lines.push('npm run test:team-host -- --allow-paid  # 账号登录档：三 Agent 同房间真实回复（付费）');
lines.push('npm run test:claude -- --check          # 各单 Agent 配置/协议检查（无模型）');
lines.push('npm run test:external-mcp               # 外部 Claude Code / Codex 令牌巡检（无模型）');
lines.push('```');
lines.push('', '## 证据说明', '', '- 报告目录均位于 `.state/`（本机数据）；分享前请自行检查其中是否包含敏感路径或业务内容。', '- 所有时间戳均来自对应报告文件的生成时间。', '');
mkdirSync(join(project, 'docs'), {recursive: true});
writeFileSync(output, lines.join('\n'));
console.log(`release readiness: ${overall}`);
for (const gate of gates) console.log(`- ${gate.name}: ${gate.ok === 'missing' ? 'MISSING' : gate.ok ? 'PASS' : 'FAIL'} (${gate.detail})`);
console.log(`written: ${output}`);
if (failed || missing) process.exitCode = 1;
