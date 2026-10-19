// Headless browser end-to-end smoke test over the Chrome DevTools Protocol.
// It starts an isolated Tempt Room instance with the deterministic demo member,
// drives the real React UI in headless Edge/Chrome, and writes a JSON report.
//
// Run: npm run test:browser
// Optional: ROOM_BROWSER=<absolute browser path> ROOM_E2E_HEADFUL=1
import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {contextDelta,advanceContext} from '../apps/server/src/context-reconciliation.ts';
import {createApp} from '../apps/server/src/app.ts';
import {issueAgentToken} from '../apps/server/src/agent-tokens.ts';

interface StepReport { name: string; at: string; detail?: Record<string, unknown> }
interface CdpReply { id?: number; result?: Record<string, any>; error?: { message: string }; method?: string; params?: Record<string, any> }

const project = resolve('.');
const parent = join(project, '.state', 'browser-e2e');
mkdirSync(parent, {recursive: true});
const runDir = mkdtempSync(join(parent, 'run-'));
const stateRoot = join(runDir, 'state');
const profileDir = join(runDir, 'profile');
mkdirSync(stateRoot, {recursive: true});
mkdirSync(profileDir, {recursive: true});

const report: { startedAt: string; finishedAt?: string; browser?: string; headless: boolean; steps: StepReport[]; consoleErrors: string[]; screenshots: string[]; ok: boolean; skipped?: boolean; error?: string } = {
  startedAt: new Date().toISOString(), headless: process.env.ROOM_E2E_HEADFUL !== '1', steps: [], consoleErrors: [], screenshots: [], ok: false
};
const reportPath = join(runDir, 'report.json');
const step = (name: string, detail?: Record<string, unknown>) => { report.steps.push({name, at: new Date().toISOString(), ...(detail ? {detail} : {})}); console.log(`${name}: PASS`); };
const fail = (message: string): never => { throw new Error(message); };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(label: string, action: () => Promise<T | undefined | false>, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await action(); if (value) return value; }
    catch (error) { last = error; }
    await sleep(200);
  }
  throw new Error(`等待超时：${label}${last instanceof Error ? `（最后错误：${last.message}）` : ''}`);
}

function findBrowser(): string | undefined {
  const candidates = [
    process.env.ROOM_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean) as string[];
  return candidates.find(candidate => existsSync(candidate));
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('无法分配调试端口'));
      server.close(() => resolvePort(address.port));
    });
  });
}

let browser: ChildProcess | undefined;
let appHandle: Awaited<ReturnType<typeof createApp>> | undefined;
let socket: WebSocket | undefined;
try {
  const browserPath = findBrowser();
  if (!browserPath) {
    report.skipped = true;
    report.error = '未找到 Edge/Chrome；可用 ROOM_BROWSER 指向浏览器可执行文件';
    console.log(`SKIP: ${report.error}`);
  } else {
    report.browser = browserPath;
    const debugPort = await freePort();
    browser = spawn(browserPath, [
      ...(report.headless ? ['--headless=new'] : []),
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      `--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`, '--window-size=1440,1000', 'about:blank'
    ], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
    let browserStderr = '';
    browser.stderr?.on('data', chunk => { browserStderr = (browserStderr + chunk.toString()).slice(-8000); });
    await waitFor('浏览器 DevTools 端点', async () => {
      try { return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok; }
      catch { return false; }
    }, 20000);
    const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json() as { webSocketDebuggerUrl: string; Browser: string };
    report.browser = `${version.Browser} (${browserPath})`;

    appHandle = await createApp({root: stateRoot, dev: true, startWorker: true, devHmrPort: await freePort()});
    const {app, store, token} = appHandle;
    await app.listen({host: '127.0.0.1', port: 0});
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('无法获取服务端口');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = {authorization: `Bearer ${token}`, 'room-protocol-version': '0.1', 'content-type': 'application/json'};
    const command = async (roomId: string, type: string, payload: Record<string, unknown>) => {
      const response = await fetch(`${base}/api/commands`, {method: 'POST', headers, body: JSON.stringify({version: '0.1', commandId: randomUUID(), roomId, type, payload})});
      if (!response.ok) fail(`初始化命令失败 ${type}: ${response.status} ${await response.text()}`);
      return response.json();
    };
    const roomId = store.rooms()[0].id;
    await command(roomId, 'room.members.set', {members: ['demo-planner', 'demo-reviewer']});
    await command(roomId, 'room.update', {name: '浏览器端到端', description: 'CDP 无模型浏览器验收'});
    step('isolated-server', {base, roomId, stateRoot});

    socket = new WebSocket(version.webSocketDebuggerUrl, {origin: 'http://127.0.0.1'});
    await new Promise<void>((resolveOpen, reject) => { socket!.once('open', () => resolveOpen()); socket!.once('error', reject); });
    let nextId = 0;
    const pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void}>();
    const eventWaiters = new Map<string, (params: Record<string, any>) => void>();
    const consoleErrors: string[] = [];
    let sessionId = '';
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as CdpReply;
      if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
        return;
      }
      if (message.method && eventWaiters.has(message.method)) { eventWaiters.get(message.method)!(message.params ?? {}); eventWaiters.delete(message.method); }
      if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(`exception: ${message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? 'unknown'}`);
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') consoleErrors.push(`console.error: ${(message.params.args ?? []).map((arg: any) => arg.value ?? arg.description ?? '').join(' ')}`);
    });
    const waitEvent = (method: string, timeoutMs = 15000) => new Promise<Record<string, any>>((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => { eventWaiters.delete(method); rejectEvent(new Error(`等待页面事件超时：${method}`)); }, timeoutMs);
      eventWaiters.set(method, params => { clearTimeout(timer); resolveEvent(params); });
    });
    const send = (method: string, params: Record<string, unknown> = {}, session?: string) => new Promise<any>((resolveSend, reject) => {
      const id = ++nextId;
      pending.set(id, {resolve: resolveSend, reject});
      socket!.send(JSON.stringify({id, method, params, ...(session ? {sessionId: session} : {})}));
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP 超时：${method}`)); }, 20000);
    });
    const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
    const attached = await send('Target.attachToTarget', {targetId, flatten: true});
    sessionId = attached.sessionId;
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Page.addScriptToEvaluateOnNewDocument', {source: `(() => {
      const Native = window.WebSocket;
      window.__roomSockets = [];
      function Wrapped(...args) { const socket = new Native(...args); window.__roomSockets.push(socket); return socket; }
      Wrapped.prototype = Native.prototype;
      for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Wrapped[key] = Native[key];
      window.WebSocket = Wrapped;
    })()`}, sessionId);
    const navigated = waitEvent('Page.loadEventFired');
    await send('Page.navigate', {url: `${base}/enter/${token}`}, sessionId);
    await navigated;
    const evaluate = async (expression: string) => {
      const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}, sessionId);
      if (result.exceptionDetails) fail(`页面脚本异常：${result.exceptionDetails.text ?? ''}`);
      return result.result?.value;
    };
    const bodyText = () => evaluate('document.body ? document.body.innerText : ""') as Promise<string>;
    try {
      await waitFor('页面应用壳与房间列表', async () => {
        const text = await bodyText();
        if (!text.includes('浏览器端到端')) return false;
        return await evaluate('!!document.querySelector(\'textarea[aria-label="消息内容"]\')');
      }, 30000);
    } catch (error) {
      const href = await evaluate('location.href').catch(() => 'unknown');
      const title = await evaluate('document.title').catch(() => 'unknown');
      const ready = await evaluate('document.readyState').catch(() => 'unknown');
      const text = await bodyText().catch(() => '');
      const html = await evaluate('document.documentElement ? document.documentElement.outerHTML.slice(0, 1200) : ""').catch(() => '');
      throw new Error(`等待超时：页面应用壳与房间列表；href=${href} title=${title} ready=${ready} body=${String(text).slice(0, 500)} html=${String(html).slice(0, 500)}`);
    }
    await waitFor('实时连接状态', async () => (await bodyText()).includes('实时连接'), 15000);
    step('app-load-and-auth', {textLength: (await bodyText()).length});
    step('connection-status-live');

    const sent = `浏览器端到端消息 ${Date.now()}`;
    const typed = await evaluate(`(() => {
      const el = document.querySelector('textarea[aria-label="消息内容"]');
      if (!el) return 'missing-textarea';
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(sent)});
      el.dispatchEvent(new Event('input', {bubbles: true}));
      return 'ok';
    })()`);
    if (typed !== 'ok') fail('找不到消息输入框或无法写入');
    await sleep(150);
    const clicked = await evaluate(`(() => { const button = document.querySelector('button.send-button, button[aria-label="发送消息"]'); if (!button) return 'missing-send'; button.click(); return 'ok'; })()`);
    if (clicked !== 'ok') fail('找不到发送按钮');
    await waitFor('界面消息出现在时间线', async () => (await bodyText()).includes(sent), 15000);
    step('ui-send-message', {sent});

    await command(roomId, 'message.send', {text: '@演示规划员 请回复一条确定性演示消息', mentions: ['demo-planner']});
    await waitFor('确定性演示成员的流式回复', async () => (await bodyText()).includes('确定性演示回复'), 30000);
    step('demo-agent-stream-reply');

    const reloaded = waitEvent('Page.loadEventFired');
    await send('Page.reload', {}, sessionId);
    await reloaded;
    await waitFor('刷新后消息恢复', async () => { const text = await bodyText(); return text.includes(sent) && text.includes('确定性演示回复'); }, 30000);
    step('reload-persists-history');

    const settingsOpened = await evaluate(`(() => { const buttons = [...document.querySelectorAll('button')]; const button = buttons.find(item => item.textContent && item.textContent.includes('运行设置')); if (!button) return 'missing-settings:' + buttons.map(item => (item.textContent ?? '').trim().slice(0, 24)).join('|'); button.click(); return 'ok'; })()`);
    if (settingsOpened !== 'ok') fail(`找不到运行设置入口（${settingsOpened}）`);
    await waitFor('运行设置对话框', async () => (await bodyText()).includes('单次内存上限'), 10000);
    await evaluate(`(() => { const buttons = [...document.querySelectorAll('button')]; const cancel = buttons.find(item => item.textContent && item.textContent.trim() === '取消'); if (cancel) cancel.click(); return 'ok'; })()`);
    step('settings-dialog-opens');

    const clickByText = async (selector: string, text: string) => evaluate(`(() => { const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(item => (item.textContent ?? '').includes(${JSON.stringify(text)})); if (!element) return 'missing'; element.click(); return 'ok'; })()`);
    const setTextareaValue = async (selector: string, value: string) => evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return 'missing'; const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', {bubbles: true})); return 'ok'; })()`);
    const setInputByLabel = async (label: string, value: string) => evaluate(`(() => { const input = [...document.querySelectorAll('dialog.modal input')].find(item => (item.closest('label')?.textContent ?? '').includes(${JSON.stringify(label)})); if (!input) return 'missing'; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', {bubbles: true})); return 'ok'; })()`);
    const setSelectByLabel = async (label: string, value: string) => evaluate(`(() => { const select = [...document.querySelectorAll('dialog.modal select')].find(item => (item.closest('label')?.textContent ?? '').includes(${JSON.stringify(label)})); if (!select) return 'missing'; const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, ${JSON.stringify(value)}); select.dispatchEvent(new Event('change', {bubbles: true})); return 'ok'; })()`);
    const toggleCheckboxByLabel = async (label: string, desired: boolean) => evaluate(`(() => { const input = [...document.querySelectorAll('dialog.modal input[type="checkbox"]')].find(item => (item.closest('label')?.textContent ?? '').includes(${JSON.stringify(label)})); if (!input) return 'missing'; if (input.checked !== ${desired}) input.click(); return 'ok'; })()`);
    const headerRoomName = () => evaluate(`document.querySelector('.room-title h1')?.textContent?.trim() ?? ''`) as Promise<string>;
    const taskCardText = (title: string) => evaluate(`(() => { const card = [...document.querySelectorAll('.task-card')].find(item => (item.textContent ?? '').includes(${JSON.stringify(title)})); return card ? card.innerText : ''; })()`) as Promise<string>;

    const taskTitle = `浏览器任务 ${Date.now()}`;
    if (await clickByText('button', '创建任务') !== 'ok') fail('找不到工具栏「创建任务」');
    await waitFor('任务表单', async () => (await bodyText()).includes('任务与验收要求'), 10000);
    if (await setTextareaValue('dialog.modal textarea', taskTitle) !== 'ok') fail('无法填写任务标题');
    const selectedOwner = await evaluate(`(() => { const select = [...document.querySelectorAll('dialog.modal select')].find(item => (item.closest('label')?.textContent ?? '').includes('负责人')); if (!select) return 'missing'; const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, 'demo-planner'); select.dispatchEvent(new Event('change', {bubbles: true})); return 'ok'; })()`);
    if (selectedOwner !== 'ok') fail('无法选择任务负责人');
    if (await clickByText('dialog.modal button', '创建任务') !== 'ok') fail('无法提交任务');
    await waitFor('任务卡片出现并完成', async () => (await taskCardText(taskTitle)).includes('已完成'), 30000);
    step('ui-create-task', {taskTitle});

    const handoff = await evaluate(`(() => { const card = [...document.querySelectorAll('.task-card')].find(item => (item.textContent ?? '').includes(${JSON.stringify(taskTitle)})); if (!card) return 'missing-card'; const select = card.querySelector('select'); if (!select) return 'missing-select'; const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, 'demo-reviewer'); select.dispatchEvent(new Event('change', {bubbles: true})); return 'ok'; })()`);
    if (handoff !== 'ok') fail(`无法转交任务（${handoff}）`);
    await waitFor('任务转交后由审阅员完成', async () => { const text = await taskCardText(taskTitle); return text.includes('演示审阅员') && text.includes('v2') && text.includes('已完成'); }, 30000);
    step('ui-task-handoff', {taskTitle});

    const mentionMessage = `界面提及消息 ${Date.now()}`;
    const mentionOpened = await evaluate(`(() => { const button = document.querySelector('button[aria-label="提及 Agent"]'); if (!button) return 'missing'; button.click(); return 'ok'; })()`);
    if (mentionOpened !== 'ok') fail('找不到提及成员按钮');
    await waitFor('提及成员菜单', async () => (await evaluate('document.querySelectorAll(".mention-menu button").length')) > 0, 10000);
    const picked = await evaluate(`(() => { const button = [...document.querySelectorAll('.mention-menu button')].find(item => (item.textContent ?? '').includes('演示规划员')); if (!button) return 'missing'; button.click(); return 'ok'; })()`);
    if (picked !== 'ok') fail('无法选择提及成员');
    await waitFor('提及成员标签', async () => (await evaluate('document.querySelectorAll(".mention-chip").length')) > 0, 10000);
    if (await setTextareaValue('textarea[aria-label="消息内容"]', mentionMessage) !== 'ok') fail('无法填写提及消息');
    await sleep(100);
    await evaluate('document.querySelector("button.send-button").click()');
    await waitFor('界面提及消息出现', async () => (await bodyText()).includes(mentionMessage), 15000);
    step('ui-mention-and-send', {mentionMessage});

    const goal = `浏览器讨论 ${Date.now()}`;
    if (await clickByText('button', '开启讨论') !== 'ok') fail('找不到「开启讨论」入口');
    await waitFor('讨论表单', async () => (await bodyText()).includes('这场讨论要解决什么'), 10000);
    if (await setTextareaValue('dialog.modal textarea', goal) !== 'ok') fail('无法填写讨论目标');
    const setNumberInput = async (label: string, value: number) => evaluate(`(() => { const input = [...document.querySelectorAll('dialog.modal input[type="number"]')].find(item => (item.closest('label')?.textContent ?? '').includes(${JSON.stringify(label)})); if (!input) return 'missing'; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(String(value))}); input.dispatchEvent(new Event('input', {bubbles: true})); return 'ok'; })()`);
    if (await setNumberInput('讨论轮次', 1) !== 'ok' || await setNumberInput('最多响应次数', 2) !== 'ok') fail('无法设置讨论轮次/响应上限');
    if (await clickByText('dialog.modal button', '开始讨论') !== 'ok') fail('无法提交讨论');
    // The handoff already produced one reviewer reply; the discussion must add another.
    const countOf = (text: string, needle: string) => text.split(needle).length - 1;
    await waitFor('讨论成员产生新回复', async () => countOf(await bodyText(), '不代表模型分析') >= 2, 30000);
    await waitFor('讨论结束并移除横幅', async () => {
      if ((await bodyText()).includes('讨论进行中')) return false;
      await sleep(400);
      return !(await bodyText()).includes('讨论进行中');
    }, 30000);
    step('ui-discussion', {goal});

    const socketCount = await evaluate('window.__roomSockets ? window.__roomSockets.length : 0');
    if (!socketCount) fail('页面没有可观测的 WebSocket 连接');
    await evaluate('window.__roomSockets.forEach(socket => socket.close())');
    await waitFor('断线状态提示', async () => (await bodyText()).includes('重新连接中'), 15000);
    step('offline-detected');
    await waitFor('WebSocket 自动重连', async () => (await bodyText()).includes('实时连接'), 20000);
    await waitFor('WebSocket 自动重连', async () => (await bodyText()).includes('实时连接'), 20000);
    const catchup = `断线恢复消息 ${Date.now()}`;
    await command(roomId, 'message.send', {text: catchup});
    await waitFor('重连后补取消息', async () => (await bodyText()).includes(catchup), 15000);
    step('reconnect-and-catchup', {catchup});

    const artifactName = `浏览器交付物 ${Date.now()}`;
    const artifactText = '这是浏览器端到端发布的确定性交付物内容。';
    const agentToken = issueAgentToken(token, 'demo-planner', roomId);
    const published = await fetch(`${base}/api/agent/tool`, {method: 'POST', headers: {authorization: `Bearer ${agentToken}`, 'room-protocol-version': '0.1', 'content-type': 'application/json'}, body: JSON.stringify({commandId: `e2e_${randomUUID()}`, roomId, name: 'artifact_publish', arguments: {name: artifactName, text: artifactText}})});
    if (!published.ok) fail(`发布交付物失败：${published.status} ${await published.text()}`);
    const artifactTab = await evaluate(`(() => { const tab = [...document.querySelectorAll('button[role="tab"]')].find(item => (item.textContent ?? '').includes('交付物')); if (!tab) return 'missing'; tab.click(); return 'ok'; })()`);
    if (artifactTab !== 'ok') fail('找不到交付物标签页');
    await waitFor('交付物列表', async () => (await bodyText()).includes(artifactName), 15000);
    const artifactOpened = await evaluate(`(() => { const row = [...document.querySelectorAll('.artifact-row')].find(item => (item.textContent ?? '').includes(${JSON.stringify(artifactName)})); if (!row) return 'missing'; row.click(); return 'ok'; })()`);
    if (artifactOpened !== 'ok') fail('无法打开交付物');
    await waitFor('交付物文本预览', async () => (await bodyText()).includes(artifactText), 10000);
    step('artifact-publish-and-preview', {artifactName});
    await evaluate(`(() => { const close = document.querySelector('dialog.modal button[aria-label="关闭"]'); if (close) { close.click(); return 'ok'; } return 'missing'; })()`);
    await evaluate(`(() => { const tab = [...document.querySelectorAll('button[role="tab"]')].find(item => (item.textContent ?? '').includes('任务')); if (tab) tab.click(); return 'ok'; })()`);

    await waitFor('任务卡片仍在任务视图', async () => (await taskCardText(taskTitle)).includes('已完成'), 10000);
    const reviseOpened = await evaluate(`(() => { const card = [...document.querySelectorAll('.task-card')].find(item => (item.textContent ?? '').includes(${JSON.stringify(taskTitle)})); if (!card) return 'missing-card'; const button = [...card.querySelectorAll('button')].find(item => (item.textContent ?? '').includes('修改目标')); if (!button) return 'missing-button'; button.click(); return 'ok'; })()`);
    if (reviseOpened !== 'ok') fail(`无法打开修改目标表单（${reviseOpened}）`);
    await waitFor('修改目标表单', async () => (await bodyText()).includes('新的任务目标'), 10000);
    const revisedTitle = `${taskTitle} · 改版`;
    if (await setTextareaValue('dialog.modal textarea', revisedTitle) !== 'ok') fail('无法填写新目标');
    if (await clickByText('dialog.modal button', '创建新版本') !== 'ok') fail('无法提交新版本');
    await waitFor('改版任务 v3 完成', async () => { const text = await taskCardText(revisedTitle); return text.includes('v3') && text.includes('已完成'); }, 30000);
    await waitFor('旧版本回复被标记', async () => (await bodyText()).includes('基于旧要求'), 15000);
    step('ui-task-revise', {revisedTitle});

    const newRoomName = `浏览器新房间 ${Date.now()}`;
    if (await clickByText('button', '新建一个房间') !== 'ok') fail('找不到新建房间入口');
    await waitFor('创建房间表单', async () => (await bodyText()).includes('创建一个共同工作的地方'), 10000);
    if (await setInputByLabel('房间名称', newRoomName) !== 'ok') fail('无法填写房间名称');
    if (await setInputByLabel('一句话描述', 'CDP 房间设置回归') !== 'ok') fail('无法填写房间描述');
    if (await clickByText('dialog.modal button', '创建房间') !== 'ok') fail('无法提交新房间');
    await waitFor('新房间已切换', async () => (await headerRoomName()) === newRoomName, 15000);
    step('ui-create-room', {newRoomName});

    const renamedRoom = `${newRoomName} 改`;
    const settingsButton = await evaluate(`(() => { const button = document.querySelector('button[aria-label="房间设置"]'); if (!button) return 'missing'; button.click(); return 'ok'; })()`);
    if (settingsButton !== 'ok') fail('找不到房间设置入口');
    await waitFor('房间设置表单', async () => (await bodyText()).includes('保存设置'), 10000);
    if (await setInputByLabel('房间名称', renamedRoom) !== 'ok') fail('无法修改房间名称');
    if (await clickByText('dialog.modal button', '保存设置') !== 'ok') fail('无法保存房间设置');
    await waitFor('房间名称已更新', async () => (await headerRoomName()) === renamedRoom, 15000);
    step('ui-room-settings', {renamedRoom});

    // Return to the original room so the screenshot keeps the rich collaboration state.
    const switchedBack = await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(item => (item.textContent ?? '').includes('浏览器端到端') && !(item.textContent ?? '').includes('新房间')); if (!button) return 'missing'; button.click(); return 'ok'; })()`);
    if (switchedBack !== 'ok') fail('无法切回原房间');
    await waitFor('切回原房间', async () => (await headerRoomName()) === '浏览器端到端', 15000);

    const agentName = `浏览器自建助手 ${Date.now() % 1000000}`;
    if (await clickByText('button', 'Agent 连接') !== 'ok') fail('找不到 Agent 连接入口');
    await waitFor('Agent 连接列表', async () => (await bodyText()).includes('添加 Agent'), 10000);
    if (await clickByText('button', '添加 Agent') !== 'ok') fail('找不到添加 Agent 入口');
    await waitFor('添加 Agent 表单', async () => (await bodyText()).includes('Agent 类型'), 10000);
    if (await setSelectByLabel('Agent 类型', 'api') !== 'ok') fail('无法选择 Agent 类型');
    if (await setInputByLabel('显示名称', agentName) !== 'ok') fail('无法填写 Agent 名称');
    if (await setSelectByLabel('接入方式', 'external') !== 'ok') fail('无法选择外部会话接入');
    if (await clickByText('dialog.modal button', '保存连接') !== 'ok') fail('无法保存 Agent');
    await waitFor('Agent 已保存', async () => (await bodyText()).includes('已添加成员'), 15000);
    if (await clickByText('button', 'Agent 连接') !== 'ok') fail('无法重新打开 Agent 列表');
    await waitFor('新 Agent 出现在列表', async () => (await bodyText()).includes(agentName), 10000);
    const saveListed = await evaluate(`(() => { const row = [...document.querySelectorAll('.connection-list button')].find(item => (item.textContent ?? '').includes(${JSON.stringify(agentName)})); return row ? row.innerText : ''; })()`) as string;
    if (!saveListed.includes('未启用')) fail(`新 Agent 默认启用状态不正确：${saveListed}`);
    step('ui-add-agent', {agentName});

    if (await clickByText('.connection-list button', agentName) !== 'ok') fail('无法打开新 Agent 设置');
    await waitFor('Agent 连接设置', async () => (await bodyText()).includes('允许在房间中被点名和分派任务'), 10000);
    if (await toggleCheckboxByLabel('允许在房间中被点名和分派任务', true) !== 'ok') fail('无法启用 Agent');
    if (await clickByText('dialog.modal button', '保存连接') !== 'ok') fail('无法保存 Agent 启用状态');
    if (await clickByText('button', 'Agent 连接') !== 'ok') fail('无法打开 Agent 列表检查启用状态');
    await waitFor('Agent 显示已启用', async () => { const text = await evaluate(`(() => { const row = [...document.querySelectorAll('.connection-list button')].find(item => (item.textContent ?? '').includes(${JSON.stringify(agentName)})); return row ? row.innerText : ''; })()`) as string; return text.includes('已启用'); }, 10000);
    step('ui-enable-agent', {agentName});


    const closeConnections = await evaluate(`(() => { const button = document.querySelector('dialog.modal button[aria-label="关闭"]'); if (button) { button.click(); return 'ok'; } return 'missing'; })()`);
    if (closeConnections !== 'ok') fail('无法关闭 Agent 连接列表');

    // Native Agent endpoint fields (Claude Anthropic-compatible gateway / Codex OpenAI-compatible base).
    if (await clickByText('button', 'Agent 连接') !== 'ok') fail('无法重新打开 Agent 连接');
    await waitFor('Agent 连接列表', async () => (await bodyText()).includes('添加 Agent'), 10000);
    if (await clickByText('dialog.modal button', '添加 Agent') !== 'ok') fail('无法打开添加 Agent 表单');
    await waitFor('Agent 类型选择', async () => (await bodyText()).includes('Agent 类型'), 10000);
    if (await setSelectByLabel('Agent 类型', 'claude') !== 'ok') fail('无法选择 Claude Agent 类型');
    await waitFor('Claude 兼容端点字段', async () => (await bodyText()).includes('Anthropic 兼容端点'), 10000);
    if (await setSelectByLabel('Agent 类型', 'codex') !== 'ok') fail('无法选择 Codex Agent 类型');
    await waitFor('Codex 兼容端点字段', async () => (await bodyText()).includes('OpenAI 兼容端点'), 10000);
    const closeEndpointDialog = await evaluate(`(() => { const button = document.querySelector('dialog.modal button[aria-label="关闭"]'); if (!button) return 'missing'; button.click(); return 'ok'; })()`);
    if (closeEndpointDialog !== 'ok') fail('无法关闭 Agent 类型测试对话框');
    step('ui-native-endpoint-fields', {providers: ['claude', 'codex']});
    const roomSettingsButton = await evaluate(`(() => { const button = document.querySelector('button[aria-label="房间设置"]'); if (!button) return 'missing'; button.click(); return 'ok'; })()`);
    if (roomSettingsButton !== 'ok') fail('找不到房间设置入口');
    await waitFor('房间设置表单（邀请成员）', async () => (await bodyText()).includes('保存设置'), 10000);
    if (await toggleCheckboxByLabel(agentName, true) !== 'ok') fail('无法邀请新成员');
    if (await clickByText('dialog.modal button', '保存设置') !== 'ok') fail('无法保存房间成员');
    await waitFor('新成员出现在房间', async () => (await bodyText()).includes(agentName), 15000);
    step('ui-invite-agent', {agentName});
    await waitFor('房间设置对话框已关闭', async () => !(await evaluate('!!document.querySelector("dialog.modal")')), 10000);

    const dependentTitle = `依赖任务 ${Date.now() % 1000000}`;
    if (await clickByText('button', '创建任务') !== 'ok') fail('找不到工具栏「创建任务」（依赖任务）');
    await waitFor('任务表单（依赖任务）', async () => (await bodyText()).includes('任务与验收要求'), 10000);
    if (await setTextareaValue('dialog.modal textarea', dependentTitle) !== 'ok') fail('无法填写依赖任务标题');
    if (await setSelectByLabel('负责人', 'demo-planner') !== 'ok') fail('无法选择依赖任务负责人');
    if (await toggleCheckboxByLabel(revisedTitle, true) !== 'ok') fail('无法勾选依赖的前序任务');
    if (await clickByText('dialog.modal button', '创建任务') !== 'ok') fail('无法提交依赖任务');
    await waitFor('依赖任务完成', async () => (await taskCardText(dependentTitle)).includes('已完成'), 30000);
    step('ui-dependent-task', {dependentTitle, dependsOn: revisedTitle});

    const parentV4 = `${revisedTitle} · 第二次改版`;
    const reviseParent = await evaluate(`(() => { const card = [...document.querySelectorAll('.task-card')].find(item => (item.textContent ?? '').includes(${JSON.stringify(revisedTitle)})); if (!card) return 'missing-card'; const button = [...card.querySelectorAll('button')].find(item => (item.textContent ?? '').includes('修改目标')); if (!button) return 'missing-button'; button.click(); return 'ok'; })()`);
    if (reviseParent !== 'ok') fail(`无法再次修改父任务（${reviseParent}）`);
    await waitFor('父任务改版表单', async () => (await bodyText()).includes('新的任务目标'), 10000);
    if (await setTextareaValue('dialog.modal textarea', parentV4) !== 'ok') fail('无法填写父任务新目标');
    if (await clickByText('dialog.modal button', '创建新版本') !== 'ok') fail('无法提交父任务新版本');
    await waitFor('父任务 v4 完成', async () => { const text = await taskCardText(parentV4); return text.includes('v4') && text.includes('已完成'); }, 30000);
    await waitFor('依赖任务随版本升级到 v2 并完成', async () => { const text = await taskCardText(dependentTitle); return text.includes('v2') && text.includes('已完成'); }, 30000);
    step('ui-dependency-version-cascade', {parentV4, dependentTitle});

    const settingsForRemoval = await evaluate(`(() => { const button = document.querySelector('button[aria-label="房间设置"]'); if (!button) return 'missing'; button.click(); return 'ok'; })()`);
    if (settingsForRemoval !== 'ok') fail('找不到房间设置入口（移除成员）');
    await waitFor('房间设置表单（移除成员）', async () => (await bodyText()).includes('保存设置'), 10000);
    if (await toggleCheckboxByLabel(agentName, false) !== 'ok') fail('无法取消邀请成员');
    if (await clickByText('dialog.modal button', '保存设置') !== 'ok') fail('无法保存成员移除');
    await waitFor('房间设置对话框已关闭（移除成员）', async () => !(await evaluate('!!document.querySelector("dialog.modal")')), 10000);
    await waitFor('成员已从房间移除', async () => !(await bodyText()).includes(agentName), 15000);
    step('ui-remove-member', {agentName});

    const stopGoal = `可停止的讨论 ${Date.now()}`;
    if (await clickByText('button', '开启讨论') !== 'ok') fail('找不到「开启讨论」（停止测试）');
    await waitFor('讨论表单（停止测试）', async () => (await bodyText()).includes('这场讨论要解决什么'), 10000);
    if (await setTextareaValue('dialog.modal textarea', stopGoal) !== 'ok') fail('无法填写讨论目标（停止测试）');
    if (await setNumberInput('讨论轮次', 3) !== 'ok' || await setNumberInput('最多响应次数', 10) !== 'ok') fail('无法设置讨论参数（停止测试）');
    if (await clickByText('dialog.modal button', '开始讨论') !== 'ok') fail('无法开始讨论（停止测试）');
    await waitFor('讨论进行中横幅', async () => (await bodyText()).includes('讨论进行中'), 15000);
    const stopped = await evaluate(`(() => { const banner = document.querySelector('.discussion-banner'); if (!banner) return 'missing-banner'; const button = [...banner.querySelectorAll('button')].find(item => (item.textContent ?? '').includes('停止')); if (!button) return 'missing-button'; button.click(); return 'ok'; })()`);
    if (stopped !== 'ok') fail(`无法停止讨论（${stopped}）`);
    await waitFor('讨论已停止', async () => !(await bodyText()).includes('讨论进行中'), 20000);
    step('ui-stop-discussion', {stopGoal});

    // Deterministic patch-apply fixture: no Agent writes files here. The worker is
    // stopped first so it cannot race the fixture, then a queued run is completed
    // manually with a text-only change and a real changes manifest.
    const fixtureProject = join(runDir, 'fixture-project');
    mkdirSync(fixtureProject, {recursive: true});
    writeFileSync(join(fixtureProject, 'answer.txt'), 'original\n');
    await appHandle.worker.close();
    const fixtureTask = await command(roomId, 'task.create', {title: '浏览器应用成果夹具', agentId: 'demo-planner', projectPath: fixtureProject}) as any;
    const fixtureTaskId = fixtureTask.result.taskId as string;
    const fixtureRun = appHandle.store.list<any>('runs', roomId).find((run: any) => run.taskId === fixtureTaskId);
    if (!fixtureRun) fail('没有为成果夹具创建运行');
    fixtureRun.status='running';appHandle.store.event(roomId,'run.started',{id:'system',kind:'system'},{run:fixtureRun});
    const snapshot = appHandle.worker.workspaces.snapshot(fixtureProject, fixtureRun.id);
    writeFileSync(join(snapshot.workspace, 'answer.txt'), 'applied via browser\n');
    const changes = appHandle.worker.workspaces.changes(fixtureRun.id);
    const patchArtifact = appHandle.worker.publishArtifact(fixtureRun, 'browser-apply.patch', changes.patch, 'text/x-diff', 'patch');
    writeFileSync(join(stateRoot, 'artifacts', `${patchArtifact.id}.changes.json`), JSON.stringify(changes));
    appHandle.worker.finish(fixtureRun, 'completed');
    const artifactTabForApply = await evaluate(`(() => { const tab = [...document.querySelectorAll('button[role="tab"]')].find(item => (item.textContent ?? '').includes('交付物')); if (!tab) return 'missing'; tab.click(); return 'ok'; })()`);
    if (artifactTabForApply !== 'ok') fail('找不到交付物标签页（应用夹具）');
    await waitFor('可应用补丁出现在交付物列表', async () => (await bodyText()).includes('browser-apply.patch'), 15000);
    const openPatch = await evaluate(`(() => { const row = [...document.querySelectorAll('.artifact-row')].find(item => (item.textContent ?? '').includes('browser-apply.patch')); if (!row) return 'missing'; row.click(); return 'ok'; })()`);
    if (openPatch !== 'ok') fail('无法打开可应用补丁');
    await waitFor('补丁预览与应用按钮', async () => (await bodyText()).includes('应用到原项目'), 10000);
    if (await clickByText('dialog.modal button', '应用到原项目') !== 'ok') fail('无法点击应用成果');
    await waitFor('成果写入原项目', async () => readFileSync(join(fixtureProject, 'answer.txt'), 'utf8') === 'applied via browser\n', 15000);
    const appliedArtifact = appHandle.store.get<any>('artifacts', patchArtifact.id);
    if (!appliedArtifact?.applied) fail('交付物没有标记为已应用');
    step('artifact-apply-ui', {artifact: patchArtifact.id, project: fixtureProject});
    await evaluate(`(() => { const tab = [...document.querySelectorAll('button[role="tab"]')].find(item => (item.textContent ?? '').includes('任务')); if (tab) tab.click(); return 'ok'; })()`);

    // Stale-version guard: an artifact created before a task revision must not be
    // applicable from the UI, and the project file must stay untouched.
    const staleTask = await command(roomId, 'task.create', {title: '过期成果夹具', agentId: 'demo-planner', projectPath: fixtureProject}) as any;
    const staleTaskId = staleTask.result.taskId as string;
    const staleRun = appHandle.store.list<any>('runs', roomId).find((run: any) => run.taskId === staleTaskId);
    if (!staleRun) fail('没有为过期成果夹具创建运行');
    staleRun.status='running';appHandle.store.event(roomId,'run.started',{id:'system',kind:'system'},{run:staleRun});
    const staleSnapshot = appHandle.worker.workspaces.snapshot(fixtureProject, staleRun.id);
    writeFileSync(join(staleSnapshot.workspace, 'answer.txt'), 'stale change\n');
    const staleChanges = appHandle.worker.workspaces.changes(staleRun.id);
    const staleArtifact = appHandle.worker.publishArtifact(staleRun, 'browser-stale.patch', staleChanges.patch, 'text/x-diff', 'patch');
    writeFileSync(join(stateRoot, 'artifacts', `${staleArtifact.id}.changes.json`), JSON.stringify(staleChanges));
    appHandle.worker.finish(staleRun, 'completed');
    await command(roomId, 'task.revise', {taskId: staleTaskId, title: '过期成果夹具 · 已改版'});
    const fileBeforeStaleApply = readFileSync(join(fixtureProject, 'answer.txt'), 'utf8');
    const artifactTabForStale = await evaluate(`(() => { const tab = [...document.querySelectorAll('button[role="tab"]')].find(item => (item.textContent ?? '').includes('交付物')); if (!tab) return 'missing'; tab.click(); return 'ok'; })()`);
    if (artifactTabForStale !== 'ok') fail('找不到交付物标签页（过期应用）');
    await waitFor('过期补丁出现在交付物列表', async () => (await bodyText()).includes('browser-stale.patch'), 15000);
    await waitFor('上一个预览已关闭', async () => !(await evaluate('!!document.querySelector("dialog.modal")')), 10000);
    const openStale = await evaluate(`(() => { const row = [...document.querySelectorAll('.artifact-row')].find(item => (item.textContent ?? '').includes('browser-stale.patch')); if (!row) return 'missing'; row.click(); return 'ok'; })()`);
    if (openStale !== 'ok') fail('无法打开过期补丁');
    await waitFor('过期补丁预览', async () => {
      const hasDialog = await evaluate('!!document.querySelector("dialog.modal")');
      return Boolean(hasDialog) && (await bodyText()).includes('应用到原项目');
    }, 10000);
    if (await clickByText('dialog.modal button', '应用到原项目') !== 'ok') fail('无法点击过期成果应用');
    await waitFor('旧版本应用被拒绝并提示', async () => (await bodyText()).includes('旧任务版本'), 15000);
    if (readFileSync(join(fixtureProject, 'answer.txt'), 'utf8') !== fileBeforeStaleApply) fail('旧版本应用不应修改项目文件');
    if (appHandle.store.get<any>('artifacts', staleArtifact.id)?.applied) fail('旧版本补丁不应被标记为已应用');
    step('artifact-stale-apply-rejected', {artifact: staleArtifact.id});
    await evaluate(`(() => { const close = document.querySelector('dialog.modal button[aria-label="关闭"]'); if (close) close.click(); return 'ok'; })()`);
    await evaluate(`(() => { const tab = [...document.querySelectorAll('button[role="tab"]')].find(item => (item.textContent ?? '').includes('任务')); if (tab) tab.click(); return 'ok'; })()`);

    // Durable draft fixture: no model or native process runs. Real HTTP/WS,
    // refresh and DOM assertions exercise draft-to-final replacement.
    const draftRoom=(await command(roomId, 'room.create',{name:'草稿恢复验收',members:['demo-planner']} ) as any).result.roomId as string;
    const draftTask=(await command(draftRoom,'task.create',{title:'Draft fixture',agentId:'demo-planner'}) as any).result.taskId as string;
    let draftRun=appHandle.store.list<any>('runs',draftRoom).find(run=>run.taskId===draftTask)!;
    draftRun.status='running';draftRun.executionId='browser_draft_execution';appHandle.store.event(draftRoom,'run.started',{id:'system',kind:'system'},{run:draftRun});
    const draftText='DURABLE_DRAFT_RECOVERY_01',finalText='FINAL_REPLACES_DRAFT_01',streamMessageId='browser_draft_stream';
    appHandle.worker.publishPartial(draftRun,draftText,streamMessageId,0);
    const loadedDraft=waitEvent('Page.loadEventFired');await send('Page.navigate',{url:base+'/?room='+draftRoom},sessionId);await loadedDraft;
    await waitFor('保存的草稿出现在独立视图',async()=>Boolean(await evaluate(`document.querySelector('.run-draft')?.textContent.includes(${JSON.stringify(draftText)})`)),15000);
    if(await evaluate(`document.querySelectorAll('.message:not(.run-draft)').length`) !== appHandle.store.list('messages',draftRoom).length)fail('草稿不应进入聊天消息投影');
    const reloadDraft=waitEvent('Page.loadEventFired');await send('Page.reload',{},sessionId);await reloadDraft;
    await waitFor('刷新后草稿仍显示一次',async()=>await evaluate(`document.querySelectorAll('.run-draft').length===1&&document.querySelector('.run-draft').textContent.includes(${JSON.stringify(draftText)})`),15000);
    step('durable-draft-refresh');
    const criterion=(await command(draftRoom,'decision.propose',{text:'BROWSER_CONTEXT_CRITERION'}) as any).result.decisionId;await command(draftRoom,'decision.accept',{decisionId:criterion});
    draftRun=advanceContext(appHandle.store,draftRun,contextDelta(appHandle.store,draftRun)!);
    await waitFor('上下文对账状态可见',async()=>Boolean((await bodyText()).includes('正在核对新增上下文')),15000);
    step('context-reconciliation-visible');
    for(const listener of appHandle.worker.streamListeners)listener({type:'message.delta',roomId:draftRoom,runId:draftRun.id,messageId:streamMessageId,generation:draftRun.generation,executionId:draftRun.executionId,index:0,text:finalText});
    await waitFor('流式和持久草稿只展示一份',async()=>await evaluate(`document.querySelectorAll('.run-draft').length===1&&document.querySelector('.run-draft').textContent.includes(${JSON.stringify(finalText)})`),10000);
    appHandle.store.event(draftRoom,'run.context.confirmed',{id:'system',kind:'system'},{runId:draftRun.id,generation:draftRun.generation,executionId:draftRun.executionId,throughSeq:draftRun.contextSeq});
    appHandle.worker.publishFinalMessage(draftRun,finalText,streamMessageId);appHandle.worker.finish(draftRun,'completed');
    await waitFor('最终回复替换草稿',async()=>await evaluate(`document.querySelectorAll('.run-draft').length===0&&[...document.querySelectorAll('.message-text')].filter(item=>item.textContent.includes(${JSON.stringify(finalText)})).length===1`),15000);
    step('draft-to-final-without-duplicate');
    const supersededTask=(await command(draftRoom,'task.create',{title:'Old draft goal',agentId:'demo-planner'}) as any).result.taskId as string;
    const supersededRun=appHandle.store.list<any>('runs',draftRoom).find(run=>run.taskId===supersededTask)!;
    supersededRun.status='running';supersededRun.executionId='browser_superseded_execution';appHandle.store.event(draftRoom,'run.started',{id:'system',kind:'system'},{run:supersededRun});
    appHandle.worker.publishPartial(supersededRun,'SUPERSEDED_DRAFT_01','superseded_stream',0);
    await command(draftRoom,'task.revise',{taskId:supersededTask,title:'New draft goal'});appHandle.worker.finish(supersededRun,'canceled');
    await waitFor('旧目标草稿保留并显示替代状态',async()=>await evaluate(`document.querySelector('.run-draft')?.textContent.includes('SUPERSEDED_DRAFT_01')&&document.querySelector('.run-draft')?.textContent.includes('已被新目标替代')`),15000);
    const draftShot=await send('Page.captureScreenshot',{format:'png'},sessionId);const draftShotPath=join(runDir,'partial-drafts.png');writeFileSync(draftShotPath,Buffer.from(draftShot.data,'base64'));report.screenshots.push(draftShotPath);
    step('superseded-draft-preserved',{screenshot:draftShotPath});

    // Lost-cookie recovery: clearing the HttpOnly session cookie must show the
    // reconnect screen, and pasting the startup URL/token must restore the app
    // without requiring a terminal round-trip.
    await send('Network.enable', {}, sessionId);
    await send('Network.clearBrowserCookies', {}, sessionId);
    const reloadedAfterClear = waitEvent('Page.loadEventFired');
    await send('Page.reload', {}, sessionId);
    await reloadedAfterClear;
    await waitFor('会话过期后的重新连接页', async () => {
      const text = await bodyText();
      return text.includes('重新连接本地工作室') && Boolean(await evaluate('!!document.querySelector(".start-screen input")'));
    }, 15000);
    step('session-expiry-reconnect-screen');
    const startupUrl = `${base}/#session=${token}`;
    const pasted = await evaluate(`(() => {
      const input = document.querySelector('.start-screen input');
      if (!input) return 'missing-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(startupUrl)});
      input.dispatchEvent(new Event('input', {bubbles: true}));
      const button = [...document.querySelectorAll('.start-screen button')].find(item => (item.textContent ?? '').trim() === '连接');
      if (!button || button.disabled) return 'missing-button';
      button.click();
      return 'ok';
    })()`);
    if (pasted !== 'ok') fail(`粘贴启动令牌失败：${pasted}`);
    await waitFor('粘贴令牌后恢复应用壳', async () => {
      const text = await bodyText();
      if (!text.includes('浏览器端到端')) return false;
      return await evaluate('!!document.querySelector("textarea[aria-label=\\"消息内容\\"]")');
    }, 20000);
    step('session-token-paste-recovery');
    await waitFor('恢复后实时连接状态', async () => (await bodyText()).includes('实时连接'), 15000);
    await waitFor('恢复后房间快照标题', async () => { const title = await evaluate("document.querySelector('.room-title h1')?.textContent?.trim() ?? ''"); return title && title !== '正在打开房间'; }, 15000);
    step('recovery-live-and-room-ready');

    const screenshot = await send('Page.captureScreenshot', {format: 'png'}, sessionId);
    const screenshotPath = join(runDir, 'ui.png');
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    report.screenshots.push(screenshotPath);
    step('screenshot', {path: screenshotPath});
    report.consoleErrors = consoleErrors;
    if (consoleErrors.length) fail(`页面出现 ${consoleErrors.length} 条控制台错误/异常：${consoleErrors.slice(0, 3).join(' | ')}`);
    report.ok = true;
    console.log('browser-e2e: PASS');
  }
} catch (error) {
  report.ok = false;
  report.error = (error as Error).message;
  console.error(`browser-e2e: FAIL - ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(join(parent, 'latest.json'), JSON.stringify({run: runDir, report: reportPath, ok: report.ok, browser: report.browser, finishedAt: report.finishedAt}, null, 2));
  console.log(`browser-e2e report: ${reportPath}`);
  try { socket?.close(); } catch { /* already closed */ }
  try { browser?.kill(); } catch { /* already exited */ }
  try { await appHandle?.app.close(); } catch { /* already closed */ }
  // Keep disk usage bounded: prune all but the five newest runs (the current one included).
  try {
    const runs = readdirSync(parent).filter(name => name.startsWith('run-')).map(name => ({name, path: join(parent, name), mtime: statSync(join(parent, name)).mtimeMs}));
    for (const old of runs.sort((a, b) => b.mtime - a.mtime).slice(5)) {
      try { rmSync(old.path, {recursive: true, force: true}); } catch { /* browser may still hold files */ }
    }
  } catch { /* best effort cleanup only */ }
}
