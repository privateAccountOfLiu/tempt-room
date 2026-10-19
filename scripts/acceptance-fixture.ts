import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { isAbsolute,join,relative,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { FileChange } from '../apps/server/src/workspaces.ts';

export const originalGreeting="exports.greet = () => 'TODO';\n";
export const fixtureTests=`const assert=require('node:assert/strict');
const {greet}=require('./greet.cjs');const {prefix}=require('./requirements.json');
assert.equal(greet(' Alice '),prefix+', Alice!');
assert.equal(greet(''),prefix+', friend!');assert.equal(greet(null),prefix+', friend!');
console.log('fixture tests passed');\n`;
export function fixturePath(root:string,name:string){
  if(!/^[a-zA-Z0-9_-]+$/.test(name))throw new Error('Invalid acceptance fixture name');
  const parent=resolve(root,'fixtures'),path=resolve(parent,name),rel=relative(parent,path);
  if(isAbsolute(rel)||rel.startsWith('..'))throw new Error('Acceptance fixture escaped its root');
  return path;
}
export function createFixture(root:string,name:string){
  const project=fixturePath(root,name);mkdirSync(resolve(root,'fixtures'),{recursive:true});mkdirSync(project);
  writeFileSync(join(project,'greet.cjs'),originalGreeting);
  writeFileSync(join(project,'greet.spec.cjs'),fixtureTests);
  writeFileSync(join(project,'requirements.json'),JSON.stringify({prefix:'Hello'})+'\n');
  writeFileSync(join(project,'package.json'),JSON.stringify({name:'room-acceptance-fixture',private:true,scripts:{test:'node greet.spec.cjs'}})+'\n');
  const env={...process.env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_ATTR_NOSYSTEM:'1'};
  for(const args of [['-c','init.templateDir=','init','--quiet','.'],['add','--all'],['-c','user.name=Room Acceptance','-c','user.email=acceptance@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Fixture baseline']]){
    const result=spawnSync('git',args,{cwd:project,env,encoding:'utf8',windowsHide:true});if(result.status!==0)throw new Error('Cannot create acceptance fixture Git baseline: '+result.stderr);
  }
  return project;
}
export function checkFixtureChanges(changes:FileChange[]){
  if(changes.length!==1||changes[0].path!=='greet.cjs'||changes[0].binary||changes[0].after===null)throw new Error('Acceptance review only permits one text change to greet.cjs; tests and requirements must stay intact');
}
export function unchangedFixture(project:string){if(readFileSync(join(project,'greet.cjs'),'utf8')!==originalGreeting)throw new Error('Original fixture changed before explicit application');}
export function verifierSource(git:string){
  return `const cp=require('node:child_process');const {greet}=require('./greet.cjs');
const results=[' Alice ','',null,' Bob '].map(name=>greet(name));
cp.execFileSync(process.env.ComSpec,['/d','/c','npm test --silent'],{encoding:'utf8'});
cp.execFileSync(${JSON.stringify(git)},['status','--porcelain'],{encoding:'utf8'});
process.stdout.write(JSON.stringify({results,npm:true,git:true}));`;
}
export function checkVerifierOutput(output:string,prefix:'Hello'|'Goodbye'){
  const result=JSON.parse(output.trim());
  const expected=[`${prefix}, Alice!`,`${prefix}, friend!`,`${prefix}, friend!`,`${prefix}, Bob!`];
  if(JSON.stringify(result.results)!==JSON.stringify(expected)||result.npm!==true||result.git!==true)throw new Error('Isolated verifier returned incorrect behavior or missing tool evidence');
}
