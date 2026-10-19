// A current external session can use the SDK without changing global CLI config.
// Tokens are loaded from the local connector file and never echoed.
import {readFileSync} from 'node:fs';
import {RoomAgentClient} from '../packages/client/src/index.ts';
import {agentToolNameSchema} from '../packages/protocol/src/index.ts';
const [file,name='room_read',json='{}',commandId]=process.argv.slice(2);
if(!file)throw new Error('Usage: tsx scripts/room-session.ts <session.json> <tool> [arguments-json] [commandId]');
const session=JSON.parse(readFileSync(file,'utf8'));
const client=new RoomAgentClient(session.url,session.roomId,session.token);
console.log(JSON.stringify(await client.call(agentToolNameSchema.parse(name),JSON.parse(json),commandId),null,2));
