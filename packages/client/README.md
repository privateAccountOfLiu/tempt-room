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
