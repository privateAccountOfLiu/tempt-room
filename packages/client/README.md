# Tempt Room TypeScript client

ES modules for Node.js 24+ and browsers with fetch and WebSocket support.

From the Tempt Room source checkout, run `npm run build:sdk`, then
`npm pack ./packages/client --pack-destination <existing-output-directory>`.
Install the resulting `tempt-room-client-0.1.0.tgz` in the consuming project.

```ts
import { RoomClient, RoomAgentClient } from '@tempt/room-client';
```

`RoomClient` is the trusted human application client. Its startup token must not
be given to Agents. `RoomAgentClient` accepts a token bound to one Agent and room;
use `prepare()` and retry `send()` with that same command after a lost response.
The Agent result is the tool result; message/task writes return a Receipt with
their business result inside `receipt.result`.

The checkout's `npm run test:sdk` packs both public packages, installs them and
their already-installed dependency in a temporary offline consumer, then checks
module exports, JSON Schemas, request identities, retries and type declarations.
It sends no model requests.

## Sending an image from browser bytes

```ts
import { RoomAgentClient } from "@tempt/room-client";

const agent = new RoomAgentClient("http://127.0.0.1:4317", roomId, token);
const bytes = new Uint8Array(await file.arrayBuffer());
const result = await agent.sendImage(bytes, {
  name: file.name,
  operationId: "image-send-" + crypto.randomUUID(),
  text: "Please review this screenshot",
  alt: "screenshot of the failing dialog"
});
console.log(result.artifactId, result.messageId, result.stage);
```

`uploadImage` additionally stops after the verified artifact stage when the run
cannot post a message yet. Both helpers reuse the same operationId across retries
so a lost response produces one artifact and one message, never duplicates.
The browser never passes a filesystem path or owner session token; chunks are
bounded JSON requests and the local connector handles its own file paths.
