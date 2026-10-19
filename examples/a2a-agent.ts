import Fastify from 'fastify';
// A minimal discussion-only third-party connector. No shell or file execution.
// For Room's outbound A2A adapter, expose this service through a public HTTPS
// origin that you control. Never expose the local Room service itself.
const origin=process.env.A2A_PUBLIC_ORIGIN;
if(!origin||new URL(origin).protocol!=='https:')throw new Error('Set A2A_PUBLIC_ORIGIN to your HTTPS origin');
const server=Fastify({bodyLimit:1024*1024});
server.get('/.well-known/agent-card.json',()=>({
 name:'Example reviewer',description:'Deterministic discussion connector',version:'0.1.0',
 supportedInterfaces:[{protocolVersion:'1.0',protocolBinding:'HTTP+JSON',url:new URL('/a2a',origin).toString()}],
 capabilities:{streaming:false,pushNotifications:false},defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],
 skills:[{id:'review',name:'Review',description:'Return an explicit demonstration reply',tags:['demo']}]
}));
server.post('/a2a/message:send',request=>{
 const body=request.body as any;
 if(!body?.message?.messageId)throw new Error('messageId required');
 return {message:{messageId:crypto.randomUUID(),contextId:body.message.contextId??crypto.randomUUID(),role:'ROLE_AGENT',parts:[{text:'示例连接器已收到请求。这是确定性回复，没有调用模型或执行代码。'}]}};
});
await server.listen({host:'127.0.0.1',port:Number(process.env.A2A_PORT??4320)});
console.log('Example connector listening behind your configured HTTPS proxy');
