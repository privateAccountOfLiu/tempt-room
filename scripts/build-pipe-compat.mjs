import { execFileSync,spawnSync } from 'node:child_process';
import { existsSync,realpathSync } from 'node:fs';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname,join,resolve,relative,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=join(root,'sandbox','RoomPipeCompat','compat.cpp'),out=join(root,'sandbox','RoomPipeCompat','bin','x64');
const within=path=>{const rel=relative(root,resolve(path));if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))throw new Error('Compiler output escaped this project');};
const quote=path=>{if(/["%\r\n!]/.test(path))throw new Error('Unsupported build path');return '"'+path+'"';};
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Pipe compatibility build requires Windows x64');
within(out);await mkdir(out,{recursive:true});within(realpathSync(out));
const vswhere=join(process.env['ProgramFiles(x86)']??'C:\\Program Files (x86)','Microsoft Visual Studio','Installer','vswhere.exe');
const installations=JSON.parse(execFileSync(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-format','json'],{encoding:'utf8',windowsHide:true}));
const vs=installations[0];if(!vs)throw new Error('Visual Studio C++ x64 tools are required');
const vcvars=join(vs.installationPath,'VC','Auxiliary','Build','vcvarsall.bat');
const command=join(out,'build.cmd'),binary=join(out,'room-pipe-compat.node');
const sourceBytes=await readFile(source),sourceHash=createHash('sha256').update(sourceBytes).digest('hex');
const inputHash=createHash('sha256').update(sourceBytes).update(await readFile(fileURLToPath(import.meta.url))).update(vs.installationVersion).update(await readFile(join(vs.installationPath,'VC','Auxiliary','Build','Microsoft.VCToolsVersion.default.txt'))).digest('hex');
try{
 const previous=JSON.parse(await readFile(join(out,'build.json'),'utf8'));
 if(previous.inputHash===inputHash&&previous.binarySha256===createHash('sha256').update(await readFile(binary)).digest('hex')){console.log(`Compatibility module is current: ${binary}`);process.exit(0);}
}catch{}
await writeFile(command,`@echo off\r\ncall ${quote(vcvars)} amd64 >nul\r\nif errorlevel 1 exit /b 1\r\ncl.exe /nologo /LD /O2 /MT /EHsc /std:c++17 /Fo${quote(join(out,'compat.obj'))} /Fe${quote(binary)} ${quote(source)} /link /INCREMENTAL:NO /MACHINE:X64 advapi32.lib\r\nexit /b %errorlevel%\r\n`);
const result=spawnSync(process.env.ComSpec??'C:\\Windows\\System32\\cmd.exe',['/d','/c',command],{cwd:out,windowsHide:true,stdio:'inherit'});
if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);
if(!existsSync(binary))throw new Error('Compiler did not produce the compatibility module');
await writeFile(join(out,'build.json'),JSON.stringify({inputHash,sourceSha256:sourceHash,binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),visualStudio:vs.installationVersion,builtAt:new Date().toISOString()},null,2));
console.log(`Built ${binary}`);
