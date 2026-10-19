import type {AgentOutput} from '../../../packages/protocol/src/index.ts';
import {AsyncQueue} from './queue.ts';
import {ExecutionUnknown} from './errors.ts';

/** Closing the consumer revokes execution and waits for adapter cleanup. */
export async function* nativeExecutionStream(signal:AbortSignal,execute:(signal:AbortSignal,output:AsyncQueue<AgentOutput>)=>Promise<void>):AsyncIterable<AgentOutput>{
  const consumer=new AbortController(),output=new AsyncQueue<AgentOutput>();let failure:unknown;
  const completion=execute(AbortSignal.any([signal,consumer.signal]),output).then(()=>output.end(),error=>{failure=error;output.end(error);});
  try{for await(const item of output)yield item;}
  finally{
    consumer.abort(new Error('Room 已停止消费原生输出'));
    await completion;
    if(failure instanceof ExecutionUnknown)throw failure;
  }
}
