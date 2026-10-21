import { VERSION, agentToolCallSchema, type AgentToolCall, type AgentToolName, type Command, type Receipt, type Room, type RoomEvent, type RoomSnapshot, type StreamDelta, type AgentDescriptor,type ServerCapabilities,type SnapshotEnvelope } from '../../protocol/src/index.ts';
import {RoomEventCursor} from './event-cursor.ts';
import {uploadImage,sendImage,ImageUploadError,type UploadedImage,type ImageUploadOptions,type SendImageOptions,type RoomSendImageResult} from './image-upload.ts';
export {RoomEventCursor} from './event-cursor.ts';
export {uploadImage,sendImage,ImageUploadError,type UploadedImage,type ImageUploadOptions,type SendImageOptions,type RoomSendImageResult} from './image-upload.ts';
export { VERSION };
export type { AgentToolCall,AgentToolName,Command, Receipt, Room, RoomEvent, RoomSnapshot, StreamDelta, AgentDescriptor,ServerCapabilities };
export class RoomClient {
  constructor(public baseUrl = '', public options: { token?: string; fetch?: typeof fetch;clientType?:'browser'|'sdk' } = {}) {}
  private clientType(){return this.options.clientType??(typeof window==='undefined'?'sdk':'browser');}
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(this.baseUrl + path, { ...init, credentials: 'same-origin', headers: { 'Room-Protocol-Version': VERSION,'Room-Client-Type':this.clientType(), ...(init.body ? { 'content-type': 'application/json' } : {}), ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}), ...init.headers } });
    if (!response.ok) { const error = await response.json().catch(() => ({ message: `HTTP ${response.status}` })); throw Object.assign(new Error(error.message), { code: error.code, status: response.status }); }
    return response.json() as Promise<T>;
  }
  rooms() { return this.request<Room[]>('/api/rooms'); }
  snapshotWithTail(roomId:string,cursor?:number){return this.request<SnapshotEnvelope>(`/api/rooms/${encodeURIComponent(roomId)}/snapshot${cursor===undefined?'':`?cursor=${cursor}`}`);}
  snapshot(roomId: string) { return this.request<RoomSnapshot>(`/api/rooms/${encodeURIComponent(roomId)}`); }
  agents() { return this.request<AgentDescriptor[]>('/api/agents'); }
  operations(runId:string){return this.request<import('../../protocol/src/index.ts').ToolOperation[]>(`/api/runs/${encodeURIComponent(runId)}/operations`);}
  reconcileCodex(runId:string,cancel=false) {
    return this.request<{location:'queued'|'turn'|'missing'|'canceled';phase:string;run:import('../../protocol/src/index.ts').Run}>(`/api/runs/${encodeURIComponent(runId)}/codex/reconcile`,{method:'POST',body:JSON.stringify({cancel})});
  }
  capabilities(){return this.request<ServerCapabilities>('/api/capabilities');}
  events(roomId: string, after = 0) { return this.request<RoomEvent[]>(`/api/rooms/${encodeURIComponent(roomId)}/events?after=${after}`); }
  command(type: Command['type'], payload: Record<string, unknown>, roomId?: string, commandId = `cmd_${crypto.randomUUID().replaceAll('-', '')}`) {
    return this.request<Receipt>('/api/commands', { method: 'POST', body: JSON.stringify({ version: VERSION, commandId, roomId, type, payload }) });
  }
  configureRoom(roomId: string, input: {name: string; description: string; members: string[]; expectedRevision: number}, commandId?: string) {
    return this.command('room.configure', input, roomId, commandId);
  }
  deleteRoom(roomId: string, expectedRevision: number, commandId?: string) {
    return this.command('room.delete', {expectedRevision}, roomId, commandId);
  }
  subscribe(roomId: string, after: number, onEvent: (event: RoomEvent | StreamDelta | { type: string; [key: string]: unknown }) => void, onStatus?: (connected: boolean) => void): () => void {
    let stopped = false, socket: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined,pending=Promise.resolve(),bufferedBytes=0;
    const cursor=new RoomEventCursor(roomId,after,seq=>this.events(roomId,seq),event=>{if(!stopped)onEvent(event);});
    const connect = () => {
      const url = new URL(this.baseUrl + '/api/events', typeof location === 'undefined' ? undefined : location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const connection=socket = new WebSocket(url, this.options.token ? ['room.v0.1', `room-token.${this.options.token}`] : ['room.v0.1']);
      connection.onopen = () => { connection.send(JSON.stringify({ version: VERSION, roomId, after: cursor.seq,clientType:this.clientType() })); onStatus?.(true); };
      connection.onmessage = message => {
        if(stopped||socket!==connection)return;
        let frame:any;try{frame=JSON.parse(message.data);}catch{connection.close(1008,'Invalid JSON');return;}
        const bytes=String(message.data).length*2;
        if(bufferedBytes+bytes>8*1024*1024){if(frame.eventId)connection.close(1013,'Replay required');return;}
        if(!frame.eventId){
          if(frame.roomId&&frame.roomId!==roomId)return;
          if(frame.type==='message.delta')onEvent(frame);
          else pending=pending.then(()=>{if(!stopped)onEvent(frame);}).catch(()=>connection.close(1013,'Event handler failed'));
          return;
        }
        bufferedBytes+=bytes;
        pending=pending.then(async()=>{
          if(stopped)return;
          await cursor.accept(frame);
          if(frame.type==='room.deleted'){stopped=true;onStatus?.(false);connection.close(1000,'room_deleted');}
        }).catch(error=>{ if((error as any)?.code==='room_deleted'||(error as any)?.status===410){stopped=true;onStatus?.(false);connection.close(1000,'room_deleted');return;} connection.close(1013,'Event replay required'); }).finally(()=>{bufferedBytes-=bytes;});
      };
      connection.onclose = event => {
        if(socket!==connection)return;
        onStatus?.(false);
        const terminal = event.code === 1000 || event.code === 1008 ? /room_deleted|room_deleting/.test(event.reason) : false;
        if(terminal){stopped=true;return;}
        void pending.finally(()=>{if(!stopped)retry=setTimeout(connect,1000);});
      };
      connection.onerror = () => connection.close();
    }; connect();
    return () => { stopped = true; clearTimeout(retry); socket?.close(); };
  }
}

/** A room-bound external Agent client. Never pass the owner startup token here. */
export class RoomAgentClient {
  constructor(public baseUrl:string,public roomId:string,private token:string,public options:{fetch?:typeof fetch}={}){}
  prepare(name:AgentToolName,args:Record<string,unknown>={},commandId=`agent_${crypto.randomUUID()}`):AgentToolCall {
    return agentToolCallSchema.parse({commandId,roomId:this.roomId,name,arguments:args});
  }
  async send<T=unknown>(command:AgentToolCall):Promise<T>{
    const input=agentToolCallSchema.parse(command);
    if(input.roomId!==this.roomId)throw new Error('Agent command belongs to another room');
    try{
      const response=await(this.options.fetch??fetch)(this.baseUrl.replace(/\/+$/,'')+'/api/agent/tool',{method:'POST',headers:{'content-type':'application/json','Room-Protocol-Version':VERSION,authorization:`Bearer ${this.token}`},body:JSON.stringify(input)});
      const body=await response.json();
      if(!response.ok)throw Object.assign(new Error(body.message??`HTTP ${response.status}`),{code:body.code,status:response.status});
      return body.result as T;
    }catch(error){throw Object.assign(error instanceof Error?error:new Error(String(error)),{commandId:input.commandId});}
  }
  call<T=unknown>(name:AgentToolName,args:Record<string,unknown>={},commandId?:string):Promise<T>{return this.send<T>(this.prepare(name,args,commandId));}
  private imageSender():(commandId:string,name:string,args:Record<string,unknown>)=>Promise<any>{
    return (commandId,name,args)=>this.send<any>(this.prepare(name as AgentToolName,args,commandId));
  }
  uploadImage(bytes:Uint8Array,options:ImageUploadOptions):Promise<UploadedImage>{return uploadImage(this.imageSender(),bytes,options);}
  sendImage(bytes:Uint8Array,options:SendImageOptions):Promise<RoomSendImageResult&{artifactId:string}>{return sendImage(this.imageSender(),bytes,options);}
}
