import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { discussionSchema,discussionBallotSchema,commandSchema,eventSchema,agentSchema,actorSchema,sandboxProfileSchema,messageSchema,taskSchema,runSchema,artifactSchema,executionSettingsSchema,agentToolCallSchema,eventRegistry,eventRegistryManifest,runFenceSchema,toolOperationSchema,runPartialSchema,contextPolicySchema,contextDeltaSchema,taskContextSchema,nativeOperationSchema,nativeReconciliationSchema } from '../packages/protocol/src/index.ts';
await mkdir('packages/protocol/schema', { recursive: true });
for (const [name, schema] of Object.entries({ discussion:discussionSchema,'discussion-ballot':discussionBallotSchema,command:commandSchema,event:eventSchema,agent:agentSchema,actor:actorSchema,sandbox:sandboxProfileSchema,message:messageSchema,task:taskSchema,run:runSchema,artifact:artifactSchema,settings:executionSettingsSchema,'agent-tool-call':agentToolCallSchema,'run-fence':runFenceSchema,'tool-operation':toolOperationSchema,'run-partial':runPartialSchema,'context-policy':contextPolicySchema,'context-delta':contextDeltaSchema,'task-context':taskContextSchema,'native-operation':nativeOperationSchema,'native-reconciliation':nativeReconciliationSchema })) {
  await writeFile(`packages/protocol/schema/${name}.schema.json`, JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n');
}
await mkdir('packages/protocol/schema/events',{recursive:true});
await writeFile('packages/protocol/schema/event-registry.json',JSON.stringify(eventRegistryManifest,null,2)+'\n');
for(const [type,definition] of Object.entries(eventRegistry))await writeFile(`packages/protocol/schema/events/${type}.schema.json`,JSON.stringify(z.toJSONSchema(definition.payload),null,2)+'\n');
