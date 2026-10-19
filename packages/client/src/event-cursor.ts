import type {RoomEvent} from '../../protocol/src/index.ts';

/** A serialized durable cursor; out-of-order live frames are repaired via REST. */
export class RoomEventCursor {
  private seen=new Map<string,number>();
  constructor(readonly roomId:string,public seq:number,private load:(after:number)=>Promise<RoomEvent[]>,private deliver:(event:RoomEvent)=>void){
    if(!Number.isSafeInteger(seq)||seq<0)throw new Error('Invalid event cursor');
  }
  private verify(event:RoomEvent){
    if(event.roomId!==this.roomId||typeof event.eventId!=='string'||!event.eventId||!Number.isSafeInteger(event.seq)||event.seq<1)throw new Error('Invalid room event envelope');
  }
  private commit(event:RoomEvent){
    this.verify(event);
    if(event.seq<=this.seq)return;
    if(event.seq!==this.seq+1)throw new Error('Durable event sequence is not contiguous');
    const previous=this.seen.get(event.eventId);if(previous!==undefined&&previous!==event.seq)throw new Error('Event id was reused at another sequence');
    this.deliver(event);
    this.seq=event.seq;this.seen.set(event.eventId,event.seq);
    if(this.seen.size>8192)this.seen.delete(this.seen.keys().next().value!);
  }
  async accept(event:RoomEvent){
    this.verify(event);if(event.seq<=this.seq)return;
    while(this.seq<event.seq-1){
      const before=this.seq,page=await this.load(this.seq);
      for(const item of page){this.verify(item);if(item.seq>=event.seq)break;this.commit(item);}
      if(this.seq===before)throw new Error('REST replay did not repair the event gap');
    }
    this.commit(event);
  }
}
