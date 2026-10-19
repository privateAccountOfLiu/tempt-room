import { execFileSync,spawnSync } from 'node:child_process';
import { existsSync,createWriteStream,createReadStream,realpathSync } from 'node:fs';
import { mkdir,readFile,writeFile,rename,lstat } from 'node:fs/promises';
import { dirname,join,resolve,relative,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash,randomUUID } from 'node:crypto';
import { Readable,Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..'),cache=join(project,'.cache','node-build');
const version='24.21.0',patchRef='2cadaa401670';
const safe=path=>{const absolute=resolve(path),rel=relative(project,absolute);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))throw new Error('Build path escaped this workspace');return absolute;};
const run=(exe,args,cwd=project)=>{const child=spawnSync(exe,args,{cwd,windowsHide:true,stdio:'inherit'});if(child.error)throw child.error;if(child.status!==0)throw new Error(`${exe} failed (${child.status})`);};
const hash=async path=>{const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest('hex');};
async function download(url,path,maxBytes,headers){
  if(existsSync(path))return;
  let response;
  try{response=await fetch(url,{headers,signal:AbortSignal.timeout(45000)});}catch(error){throw new Error(`Download from ${new URL(url).hostname} failed (${error.cause?.code??error.name})`);}
  if(!response.ok||!response.body)throw new Error(`Official source ${new URL(url).hostname} returned HTTP ${response.status}`);
  const temporary=safe(path+'.downloading-'+randomUUID());let bytes=0;
  const limit=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;callback(bytes>maxBytes?new Error('Source download exceeded its bound'):null,chunk);}});
  await pipeline(Readable.fromWeb(response.body),limit,createWriteStream(temporary,{flags:'wx'}));
  try{await rename(temporary,path);}catch(error){if(!existsSync(path))throw error;}
}
async function main(){
  if(process.platform!=='win32')throw new Error('This runtime build requires Windows');
  const prepareOnly=process.argv.includes('--prepare-only');
  for(const command of ['python.exe','git.exe'])execFileSync('where.exe',[command],{windowsHide:true,stdio:'ignore'});
  execFileSync('python.exe',['-c','import sys; sys.exit(0 if sys.version_info >= (3, 12) else "Python 3.12+ is required")'],{windowsHide:true,stdio:'inherit'});
  let vs;
  if(!prepareOnly){
  const vswhere=join(process.env['ProgramFiles(x86)']??'C:\\Program Files (x86)','Microsoft Visual Studio','Installer','vswhere.exe');
  if(!existsSync(vswhere))throw new Error('Visual Studio C++ tools were not found');
  const installed=JSON.parse(execFileSync(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-format','json'],{encoding:'utf8',windowsHide:true}));
  vs=installed[0];if(!vs)throw new Error('Visual Studio C++ x64 tools were not found');
  const clang=join(vs.installationPath,'VC','Tools','Llvm','x64','bin','clang.exe');
  if(!existsSync(clang))throw new Error('Missing Visual Studio C++ Clang tools for Windows. Install that component before building Node 24. No download, execution-policy change, or system modification was performed.');
  if(process.argv.includes('--check-tools')){console.log('Node source build prerequisites are available');return;}
  }
  safe(cache);await mkdir(cache,{recursive:true});
  const archiveName=`node-v${version}.tar.gz`,archive=join(cache,archiveName),sums=join(cache,`node-v${version}-SHASUMS256.txt`),patch=join(cache,`libuv-${patchRef}.patch`);
  await download(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`,sums,2*1024**2);
  const checksum=(await readFile(sums,'utf8')).split(/\r?\n/).map(line=>line.trim().split(/\s+/)).filter(parts=>parts[1]===archiveName&&/^[a-f0-9]{64}$/.test(parts[0]));
  if(checksum.length!==1)throw new Error('Official checksum manifest did not identify the pinned source archive');
  const sourceHash=checksum[0][0];await download(`https://nodejs.org/dist/v${version}/${archiveName}`,archive,512*1024**2);
  if(await hash(archive)!==sourceHash)throw new Error('Node source checksum mismatch; cached files were retained for inspection');
  try{await download(`https://github.com/libuv/libuv/commit/${patchRef}.patch`,patch,16*1024**2);}
  catch(first){
    console.warn(first.message+'; retrying the same pinned commit through the official GitHub API');
    await download(`https://api.github.com/repos/libuv/libuv/commits/${patchRef}`,patch,16*1024**2,{Accept:'application/vnd.github.patch','User-Agent':'tempt-room-runtime-builder'});
  }
  const patchText=(await readFile(patch,'utf8')).replaceAll('\r\n','\n'),commit=patchText.match(/^From ([a-f0-9]{40}) /)?.[1];
  if(!commit?.startsWith(patchRef))throw new Error('The patch is not the pinned upstream libuv commit');
  const marker='diff --git a/src/win/pipe.c b/src/win/pipe.c',start=patchText.indexOf(marker);
  if(start<0)throw new Error('Pinned patch does not contain the expected Windows pipe implementation');
  const end=patchText.indexOf('\ndiff --git ',start+marker.length),selected=end<0?patchText.slice(start):patchText.slice(start,end)+'\n';
  const selectedPatch=join(cache,`libuv-${patchRef}-pipe-only.patch`);await writeFile(selectedPatch,selected);const patchHash=await hash(selectedPatch);
  const source=safe(join(cache,`node-v${version}-appcontainer-${patchRef}`)),manifestPath=join(source,'.room-build.json');
  if(!existsSync(manifestPath)){
    if(existsSync(source))throw new Error('An incomplete source directory exists; inspect it before retrying');
    const temporary=safe(source+'.preparing-'+randomUUID());await mkdir(temporary);
    run('python.exe',[join(project,'scripts','extract-node-source.py'),archive,temporary,`node-v${version}`]);
    run('git.exe',['-C',temporary,'apply','--check','--directory=deps/uv',selectedPatch]);
    run('git.exe',['-C',temporary,'apply','--directory=deps/uv',selectedPatch]);
    await writeFile(join(temporary,'.room-build.json'),JSON.stringify({nodeVersion:version,sourceSha256:sourceHash,upstreamCommit:commit,pipePatchSha256:patchHash,preparedAt:new Date().toISOString()},null,2));
    safe(temporary);safe(source);try{await rename(temporary,source);}catch(error){if(!existsSync(manifestPath))throw error;}
  }
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  if(manifest.sourceSha256!==sourceHash||manifest.pipePatchSha256!==patchHash)throw new Error('Prepared source provenance does not match the requested build');
  if(prepareOnly){console.log(`Patched source prepared: ${source}`);return;}
  // vcbuild may remove its previous Release output/junction. Verify every
  // affected target remains under this workspace before invoking that build.
  for(const part of ['Release','out/Release']){const path=safe(join(source,part));if(existsSync(path))safe(realpathSync(path));}
  if((await lstat(source)).isSymbolicLink())throw new Error('Build source must not be a reparse point');
  const target=Number(vs.installationVersion.split('.')[0])>=18?'vs2026':'vs2022';
  run(process.env.ComSpec??'C:\\Windows\\System32\\cmd.exe',['/d','/c',`vcbuild.bat release x64 ${target} no-cctest openssl-no-asm`],source);
  const binary=safe(join(source,'out','Release','node.exe'));if(!existsSync(binary))throw new Error('Official build did not produce node.exe');
  manifest.binarySha256=await hash(binary);manifest.builtAt=new Date().toISOString();await writeFile(manifestPath,JSON.stringify(manifest,null,2));
  console.log(`Locally built Node: ${binary}\nSet ROOM_SANDBOX_NODE to this file, restart the app, and run npm run test:sandbox. A build or version string does not prove isolation or piped child-process compatibility.`);
}
await main().catch(error=>{console.error(error.message);process.exitCode=1;});
