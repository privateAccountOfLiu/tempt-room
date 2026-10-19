import { createApp } from './app.ts';
import { loadOrCreateOwnerToken, readOwnerToken } from './session-token.ts';
import { openBrowser } from './open-browser.ts';
import { mkdirSync,openSync,writeFileSync,readFileSync,unlinkSync,closeSync } from 'node:fs';
import { join,resolve } from 'node:path';
const root=resolve(process.env.ROOM_STATE_DIR??'.state');mkdirSync(root,{recursive:true});
const port=Number(process.env.ROOM_PORT??4317);
const lockPath=join(root,'server.lock');let lock:number;
try{lock=openSync(lockPath,'wx');}catch(error){
  if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
  const previous=JSON.parse(readFileSync(lockPath,'utf8'));let alive=true;try{process.kill(previous.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
  if(alive){
    const token=readOwnerToken(root);
    console.log(`Tempt Room 已在运行（PID ${previous.pid}），无需重复启动。`);
    if(token){
      const url=`http://127.0.0.1:${port}/#session=${token}`;
      console.log(`Open: ${url}`);
      if(process.env.ROOM_OPEN_BROWSER==='1')openBrowser(url);
    } else console.log('未找到持久化会话令牌；请先关闭已有进程再启动。');
    process.exit(0);
  }
  unlinkSync(lockPath);lock=openSync(lockPath,'wx');
}
writeFileSync(lock,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
process.once('exit',()=>{closeSync(lock);try{unlinkSync(lockPath);}catch{}});
const session=loadOrCreateOwnerToken(root,{rotate:process.env.ROOM_ROTATE_SESSION==='1'});
const { app, token } = await createApp({ dev: !process.argv[1]?.includes('dist'), root, token: session.token });
await app.listen({ host: '127.0.0.1', port });
const url=`http://127.0.0.1:${port}/#session=${token}`;
console.log(`Tempt Room is running locally. Open: ${url}`);
if(session.rotated)console.log('本地会话令牌已按 ROOM_ROTATE_SESSION=1 轮换；旧浏览器会话与外部 Agent 令牌需要更新。');
else if(session.created)console.log('已创建本地会话令牌；以后重启会复用它，浏览器无需重新打开。');
else console.log('本地会话令牌已在数据目录中保留；服务重启后浏览器与外部 Agent 会话仍然有效。');
console.log('The startup fragment is exchanged for an HttpOnly local cookie; do not share the startup URL.');
if(process.env.ROOM_OPEN_BROWSER==='1')openBrowser(url);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
