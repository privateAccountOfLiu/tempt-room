# Room Protocol 0.1

Shared types, Zod validators and JSON Schemas for Tempt Room. Node.js 24+.

Build from the checkout with `npm run build:sdk`, then use `npm pack
./packages/protocol --pack-destination <existing-output-directory>` and install
the resulting `tempt-room-protocol-0.1.0.tgz` in a consumer project.

```ts
import { VERSION, commandSchema, agentToolCallSchema } from '@tempt/room-protocol';
```

JSON Schemas are exported at `@tempt/room-protocol/schema/*.schema.json`.
The full protocol specification is in the checkout's `docs/PROTOCOL.md`.
Unknown protocol versions and forged authors are rejected by the service;
schemas do not themselves grant execution or room access.
