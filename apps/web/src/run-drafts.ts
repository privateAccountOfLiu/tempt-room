import {terminalStates,type Run,type Message} from '../../../packages/protocol/src/index.ts';
export interface DraftStream {generation?:number;text:string;index:number;fromIndex:number;runId:string}
export function appendDraftStream(previous:Record<string,DraftStream>,delta:{generation?:number;messageId:string;runId:string;index:number;text:string}){
  const old=previous[delta.messageId];if(old&&delta.index<=old.index)return previous;
  const fromIndex=old?(old.index+1===delta.index?old.fromIndex:-1):delta.index;
  return {...previous,[delta.messageId]:{text:(old?.text??'')+delta.text,index:delta.index,fromIndex,generation:delta.generation,runId:delta.runId}};
}
export function runDrafts(runs:Run[],messages:Message[],streams:Record<string,DraftStream>){
  return runs.flatMap(run=>{
    if(run.finalMessageId||messages.some(message=>message.runId===run.id&&message.final))return [];
    const active=!terminalStates.has(run.status)&&run.status!=='cancel_requested';
    const stream=active?Object.values(streams).find(stream=>stream.runId===run.id&&(stream.generation??1)===(run.generation??1)&&stream.fromIndex===0):undefined;
    const useStream=stream&&(!run.partial||stream.index>=run.partial.streamIndex);
    const text=useStream?stream.text:run.partial?.text;
    if(!text)return [];
    return [{run,text,live:Boolean(useStream),truncated:!useStream&&Boolean(run.partial?.truncated)}];
  });
}
