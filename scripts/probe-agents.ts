import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdir,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { SandboxHost } from '../apps/server/src/sandbox.ts';
import { probeAgentProtocol } from '../apps/server/src/adapters.ts';
import type { AgentDescriptor } from '../packages/protocol/src/index.ts';

const root=resolve(process.env.ROOM_STATE_DIR??'.state');
if(existsSync(join(root,'server.lock')))throw new Error('请先正常关闭使用该数据目录的服务');
if(!existsSync(join(root,'room.sqlite')))throw new Error('请先启动应用并配置 Agent 入口');
const database=new DatabaseSync(join(root,'room.sqlite'),{readOnly:true});
const selected=process.argv.find(arg=>arg.startsWith('--agent='))?.slice(8);
const agents=database.prepare('SELECT body FROM agents').all().map((row:any)=>JSON.parse(row.body) as AgentDescriptor).filter(agent=>['codex','claude','deepseek'].includes(agent.provider)&&(!selected||agent.id===selected));database.close();
if(!agents.length)throw new Error('没有匹配的本地 Agent');
const host=new SandboxHost(root,resolve('sandbox/RoomSandbox/bin/Release/net10.0-windows/RoomSandbox.exe'));
const reports:Record<string,unknown>={};
try{const sandbox=await host.probe();await mkdir(join(root,'diagnostics'),{recursive:true});await writeFile(join(root,'diagnostics','sandbox.json'),JSON.stringify(sandbox,null,2));for(const agent of agents){const report=await probeAgentProtocol(agent,host);reports[agent.id]=report;console.log(`${agent.name}: ${report.ready?'通过':'未通过'}`);for(const check of report.checks.filter(check=>!check.passed))console.log(`  ${check.name}: ${check.detail}`);if(!report.ready)process.exitCode=1;}}
finally{host.close();await mkdir(join(root,'diagnostics'),{recursive:true});await writeFile(join(root,'diagnostics','agent-protocols.json'),JSON.stringify(reports,null,2));}
