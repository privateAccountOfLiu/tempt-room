/** Only completed top-level Claude stream-json results can become room replies. */
export function parseAgentOutput(stdout) {
  const lines=stdout.split('\n').map(line=>line.trim()).filter(Boolean);
  if(!lines.length)return {text:stdout,sessionId:undefined};
  const frames=[];
  for(const line of lines){try{frames.push(JSON.parse(line));}catch{frames.push(undefined);}}
  const structured=frames.some(frame=>frame&&['system','assistant','user','stream_event','result','control_response'].includes(frame.type));
  if(!structured)return {text:stdout,sessionId:undefined};
  if(frames.some(frame=>!frame))throw new Error('Agent stream-json contains invalid output');
  let result,sessionId;
  for(const frame of frames){
    if(frame.parent_tool_use_id)continue;
    if((frame.type==='system'&&frame.subtype==='init')||frame.type==='result')sessionId=frame.session_id??sessionId;
    if(frame.type==='result'){
      if(frame.is_error||String(frame.subtype).startsWith('error'))throw new Error('Agent CLI reported an unsuccessful result');
      if(typeof frame.result!=='string')throw new Error('Agent CLI result is missing text');
      result=frame.result;
    }
  }
  if(result===undefined)throw new Error('Agent CLI did not report a completed result');
  return {text:result,sessionId};
}

export function heartbeatDelayMs(leaseUntil,now=Date.now()){
  const remaining=Date.parse(leaseUntil)-now;
  if(!Number.isFinite(remaining)||remaining<=0)throw new Error('External task lease has expired');
  return Math.max(1,Math.min(30000,Math.floor(remaining/3)));
}
