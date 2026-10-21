import { copyFile,mkdir,readdir,readFile,stat,lstat,writeFile,rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname,join,resolve,delimiter,basename } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';

export interface Toolchain { node:string;npm:string;git:string;shell:string;runtimeRoots:string[] }
const staged=new Map<string,Promise<Toolchain>>();

async function find(name:string) {
  for(const directory of (process.env.PATH??'').split(delimiter)){
    const candidate=join(directory.replaceAll('"',''),name);
    try{if((await stat(candidate)).isFile())return candidate;}catch{}
  }
}

export async function copyRuntimeTree(source:string,destination:string,budget={files:0,bytes:0}) {
  const sourceInfo=await lstat(source);
  if(sourceInfo.isSymbolicLink())throw new Error('运行文件目录不能包含重解析链接');
  if(!sourceInfo.isDirectory())throw new Error('运行文件目录不存在');
  await mkdir(destination,{recursive:true});
  for(const entry of await readdir(source,{withFileTypes:true})){
    const from=join(source,entry.name),to=join(destination,entry.name),info=await lstat(from);
    if(info.isSymbolicLink())throw new Error('运行文件目录不能包含重解析链接');
    if(info.isDirectory())await copyRuntimeTree(from,to,budget);
    else if(info.isFile()){
      if(++budget.files>30000||(budget.bytes+=info.size)>1024**3)throw new Error('运行文件超过 30,000 文件或 1 GiB');
      await copyFile(from,to);
    }
  }
}

export function stageToolchain(stateRoot:string):Promise<Toolchain> {
  const root=resolve(stateRoot);
  let promise=staged.get(root);
  if(!promise){promise=materialize(root).catch(error=>{staged.delete(root);throw error;});staged.set(root,promise);}
  return promise;
}

async function materialize(root:string):Promise<Toolchain> {
  if(process.platform!=='win32')throw new Error('本地工具链需要 Windows');
  // The host service can keep its installed Node. A separately built compatible
  // runtime is selected explicitly for AppContainer tools only.
  const nodeSource=resolve(process.env.ROOM_SANDBOX_NODE??process.execPath),nodeDirectory=dirname(process.execPath);
  if(!nodeSource.toLowerCase().endsWith('.exe')||!existsSync(nodeSource))throw new Error('ROOM_SANDBOX_NODE 必须指向存在的 node.exe');
  const npmSource=join(nodeDirectory,'node_modules','npm');
  if(!existsSync(join(npmSource,'bin','npm-cli.js')))throw new Error('Node 安装中缺少 npm，请使用带 npm 的 Node.js 24 安装');
  const gitSource=process.env.ROOM_SANDBOX_GIT?resolve(process.env.ROOM_SANDBOX_GIT):await find('git.exe');if(!gitSource||!existsSync(gitSource))throw new Error('找不到 Git for Windows，请安装 Git 后重启服务');
  const gitDirectory=['cmd','bin'].includes(basename(dirname(gitSource)).toLowerCase())?dirname(dirname(gitSource)):dirname(gitSource);
  if(!existsSync(join(gitDirectory,'mingw64','bin','git.exe')))throw new Error('需要标准 Git for Windows 运行文件（mingw64/bin/git.exe）');
  const bridgeSource=resolve('scripts/room-bridge.mjs'),imageTransferSource=resolve('scripts/room-image-transfer.mjs'),compatSource=resolve('scripts/room-realpath.cjs'),pipesSource=resolve('scripts/room-pipes.cjs'),deepseekSource=resolve('scripts/room-deepseek.cjs'),nativePipes=resolve('sandbox/RoomPipeCompat/bin/x64/room-pipe-compat.node');
  if(!existsSync(nativePipes))throw new Error('请先运行 npm run build:pipe-compat，编译隔离 Node 管道兼容模块');
  const fingerprint=createHash('sha256').update(await readFile(nodeSource)).update(await readFile(join(gitDirectory,'mingw64','bin','git.exe'))).update(await readFile(bridgeSource)).update(await readFile(imageTransferSource)).update(await readFile(compatSource)).update(await readFile(pipesSource)).update(await readFile(deepseekSource)).update(await readFile(nativePipes)).update(await readFile(join(npmSource,'package.json'))).digest('hex').slice(0,24);
  const destination=join(root,'runtimes','tools',fingerprint),complete=join(destination,'complete.json');
  if(!existsSync(complete)){
    const temporary=destination+'.preparing-'+randomUUID();await mkdir(temporary,{recursive:true});
    const nodeTarget=join(temporary,'node');await mkdir(nodeTarget,{recursive:true});
    await copyFile(nodeSource,join(nodeTarget,'node.exe'));
    for(const name of ['npm.cmd','npx.cmd'])await copyFile(join(nodeDirectory,name),join(nodeTarget,name));
    await copyRuntimeTree(npmSource,join(nodeTarget,'node_modules','npm'));
    const budget={files:0,bytes:0};
    for(const part of ['cmd','mingw64/bin','mingw64/libexec/git-core','mingw64/etc','etc','usr/bin']){
      const from=join(gitDirectory,part);if(existsSync(from))await copyRuntimeTree(from,join(temporary,'git',part),budget);
    }
    await copyFile(bridgeSource,join(nodeTarget,'room-bridge.mjs'));
    await copyFile(imageTransferSource,join(nodeTarget,'room-image-transfer.mjs'));
    await copyFile(compatSource,join(nodeTarget,'room-realpath.cjs'));
    await copyFile(pipesSource,join(nodeTarget,'room-pipes.cjs'));
    await copyFile(nativePipes,join(nodeTarget,'room-pipe-compat.node'));
    await copyFile(deepseekSource,join(nodeTarget,'room-deepseek.cjs'));
    await writeFile(join(temporary,'complete.json'),JSON.stringify({nodeSource,gitSourceHash:fingerprint,createdAt:new Date().toISOString()}));
    try{await rename(temporary,destination);}catch(error){if(!existsSync(complete))throw error;}
  }
  const node=join(destination,'node','node.exe'),npm=join(destination,'node','npm.cmd');
  const git=join(destination,'git','cmd','git.exe'),shell=join(process.env.SystemRoot??'C:\\Windows','System32','cmd.exe');
  return {node,npm,git,shell,runtimeRoots:[join(destination,'node'),join(destination,'git'),join(destination,'git','cmd'),join(destination,'git','mingw64','bin'),join(destination,'git','usr','bin')]};
}
