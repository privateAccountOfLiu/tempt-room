import { createReadStream } from 'node:fs';
import { lstat, open, readdir, readFile, mkdir, copyFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentDescriptor } from '../../../packages/protocol/src/index.ts';
import { probeClaudeVersion, probeCodexVersion } from './executable-version.ts';
import { retryIo } from './retry.ts';

export interface RuntimeLayout { source: string; entry: string; kind: 'native'|'deepseek-desktop'|'deepseek-node'; curated: boolean }
const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../');};
async function present(path:string){try{return (await lstat(path)).isFile();}catch{return false;}}

/**
 * Read the packaged application version from an Electron asar archive without
 * extracting it. asar layouts start with a small pickle: 16-byte header, the
 * JSON header (length at offset 12) then file data. Offsets in the JSON header
 * are relative to the start of the file data.
 */
export async function readAsarVersion(asarPath:string):Promise<string|undefined>{
  let handle;
  try{
    handle=await open(asarPath,'r');
    const meta=Buffer.alloc(16);
    await handle.read(meta,0,16,0);
    const headerSize=meta.readUInt32LE(12);
    if(!Number.isFinite(headerSize)||headerSize<=0||headerSize>32*1024*1024)return undefined;
    const headerBuf=Buffer.alloc(headerSize);
    await handle.read(headerBuf,0,headerSize,16);
    const header=JSON.parse(headerBuf.toString('utf8'));
    const entry=header?.files?.['package.json'];
    if(!entry||typeof entry.offset!=='string'||!Number.isSafeInteger(Number(entry.size)))return undefined;
    const data=Buffer.alloc(Number(entry.size));
    await handle.read(data,0,Number(entry.size),16+headerSize+Number(entry.offset));
    const manifest=JSON.parse(data.toString('utf8'));
    return typeof manifest.version==='string'?manifest.version:undefined;
  }catch{return undefined;}
  finally{try{await handle?.close();}catch{/* best effort */}}
}

/** Read the app version of an installed DeepSeek Harness Desktop directory. */
export async function readDesktopVersion(desktopExe:string):Promise<string|undefined>{
  return readAsarVersion(join(dirname(desktopExe),'resources','app.asar'));
}

/** Only recognized launchers are interpreted. Shell shim text is never executed. */
export async function inspectRuntime(agent:AgentDescriptor,executable:string):Promise<RuntimeLayout> {
  const entry=resolve(executable),source=resolve(agent.runtimeDirectory||dirname(entry));
  if(!inside(source,entry))throw new Error('程序入口必须位于运行文件目录内');
  const info=await lstat(entry);if(!info.isFile()||info.isSymbolicLink())throw new Error('程序入口不能是重解析链接');
  if(agent.provider==='deepseek'&&basename(entry).toLowerCase()==='deepseek harness.exe'){
    const asar=join(source,'resources','app.asar');
    if(!await present(asar))throw new Error('DSH Desktop 运行目录缺少 resources/app.asar');
    const version=await readDesktopVersion(entry);
    if(agent.version&&version!==agent.version)throw new Error(`DSH Desktop 版本 ${version??'未知'} 与固定版本 ${agent.version} 不一致`);
    return {source,entry:relative(source,entry),kind:'deepseek-desktop',curated:true};
  }
  if(agent.provider==='deepseek'&&['.js','.mjs','.cjs'].includes(extname(entry).toLowerCase())){
    let directory=dirname(entry),manifest:any,packageRoot='';
    while(directory===source||inside(source,directory)){
      try{manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));if(manifest.name==='@deepseek-ai/dsh'){packageRoot=directory;break;}}catch{}
      const parent=dirname(directory);if(parent===directory)break;directory=parent;
    }
    const bin=typeof manifest?.bin==='string'?manifest.bin:manifest?.bin?.dsh;
    if(!packageRoot||!bin||resolve(packageRoot,bin)!==entry)throw new Error('请选择官方 @deepseek-ai/dsh 包 package.json 声明的 dsh JavaScript 入口，并指定包含依赖的运行文件目录');
    if(agent.version&&manifest.version!==agent.version)throw new Error(`DSH 包版本 ${manifest.version} 与固定版本 ${agent.version} 不一致`);
    return {source,entry:relative(source,entry),kind:'deepseek-node',curated:false};
  }
  if(extname(entry).toLowerCase()!=='.exe')throw new Error('请选择原生 .exe，或官方 DSH npm 包的 JavaScript 入口；不能执行 .cmd 包装器');
  if(agent.version&&agent.provider==='codex'){const found=await probeCodexVersion(entry);if(found!==agent.version)throw new Error(`Codex CLI 版本 ${found??'未知'} 与固定版本 ${agent.version} 不一致`);}
  if(agent.version&&agent.provider==='claude'){const found=await probeClaudeVersion(entry);if(found!==agent.version)throw new Error(`Claude Code 版本 ${found??'未知'} 与固定版本 ${agent.version} 不一致`);}
  return {source,entry:relative(source,entry),kind:'native',curated:!agent.runtimeDirectory};
}

interface RuntimeFile { path:string; size:number }
async function inventory(layout:RuntimeLayout):Promise<RuntimeFile[]> {
  const files:RuntimeFile[]=[],base=await lstat(layout.source);let bytes=0;
  if(!base.isDirectory()||base.isSymbolicLink())throw new Error('运行文件目录不能是重解析链接');
  const walk=async(path:string)=>{
    const absolute=join(layout.source,path),info=await lstat(absolute);
    if(info.isSymbolicLink())throw new Error('运行文件目录不能包含重解析链接');
    if(info.isDirectory())for(const entry of (await readdir(absolute)).sort())await walk(join(path,entry));
    else if(info.isFile()){
      if(files.length>=30000||(bytes+=info.size)>2*1024**3)throw new Error('Agent 运行文件超过 30,000 文件或 2 GiB');
      files.push({path,size:info.size});
    }
  };
  if(layout.kind==='deepseek-desktop'){
    for(const entry of (await readdir(layout.source,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name)))if(entry.isFile())await walk(entry.name);
    await walk(join('resources','app.asar'));await walk(join('resources','app.asar.unpacked'));
  } else if(layout.curated)await walk(layout.entry);
  else for(const entry of (await readdir(layout.source)).sort())await walk(entry);
  return files;
}

/** Content addressing includes dependencies; incomplete copies are never reused. */
export async function stageAgentRuntime(layout:RuntimeLayout,stateRoot:string,agentId:string):Promise<string> {
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(agentId))throw new Error('Invalid Agent runtime identity');
  const files=await inventory(layout),hash=createHash('sha256').update(JSON.stringify({kind:layout.kind,entry:layout.entry}));
  if(files.some(file=>file.path.toLowerCase()==='complete.json'))throw new Error('运行文件根包含保留缓存标记 complete.json，请选择专用程序目录');
  for(const file of files){hash.update(JSON.stringify([file.path,file.size]));for await(const chunk of createReadStream(join(layout.source,file.path)))hash.update(chunk);}
  const fingerprint=hash.digest('hex'),parent=join(stateRoot,'runtimes',agentId),destination=join(parent,fingerprint),complete=join(destination,'complete.json');
  try{const record=JSON.parse(await readFile(complete,'utf8'));if(record.fingerprint===fingerprint)return destination;}catch{}
  const temporary=destination+'.preparing-'+randomUUID();await mkdir(temporary,{recursive:true});
  const copiedHash=createHash('sha256').update(JSON.stringify({kind:layout.kind,entry:layout.entry}));
  for(const file of files){
    const source=join(layout.source,file.path),target=join(temporary,file.path);const info=await lstat(source);
    if(!info.isFile()||info.isSymbolicLink())throw new Error('复制时运行文件发生变化');
    await mkdir(dirname(target),{recursive:true});await copyFile(source,target);
    copiedHash.update(JSON.stringify([file.path,(await lstat(target)).size]));for await(const chunk of createReadStream(target))copiedHash.update(chunk);
  }
  if(copiedHash.digest('hex')!==fingerprint)throw new Error('复制期间运行文件发生变化，请关闭更新程序后重试');
  await writeFile(join(temporary,'complete.json'),JSON.stringify({fingerprint,kind:layout.kind,createdAt:new Date().toISOString(),files:files.length}));
  try{await retryIo(()=>rename(temporary,destination));}catch(error){try{if(JSON.parse(await readFile(complete,'utf8')).fingerprint!==fingerprint)throw error;}catch{throw error;}}
  return destination;
}
