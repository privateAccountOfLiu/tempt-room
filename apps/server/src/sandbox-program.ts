import { NativeChannel,ExecutionUnknown } from './adapters.ts';
import type { SandboxHost } from './sandbox.ts';

export interface SandboxProgram {
  runId:string;executable:string;args:string[];workspace:string;home:string;runtimeRoots:string[];
  timeoutMs?:number;memoryMb?:number;maxProcesses?:number;
}
/** Internal verifier helper; never exposed as an Agent or HTTP execution tool. */
export async function runSandboxProgram(host:SandboxHost,spec:SandboxProgram):Promise<string>{
  const channel=new NativeChannel(host,spec.runId,false);let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    await host.launch({...spec,memoryMb:spec.memoryMb??1024,maxProcesses:spec.maxProcesses??16,timeoutMs:spec.timeoutMs??30000});
    if(!channel.started)throw new Error('Verifier did not receive sandbox identity proof');
    const exit=await Promise.race([channel.exit,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Verifier timed out')),(spec.timeoutMs??30000)+10000);})]);
    if(exit.type!=='sandbox.exit'||!exit.jobEmpty)throw new ExecutionUnknown('Verifier process-tree exit was not confirmed');
    if(exit.exitCode!==0)throw channel.diagnostic(new Error(`Verifier exited with code ${exit.exitCode}`));
    return channel.rawStdout;
  }finally{clearTimeout(timer);try{await channel.terminate();}finally{channel.dispose();}}
}
