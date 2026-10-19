import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { captureContext } from '../apps/server/src/context.ts';
import { defaultExecutionSettings } from '../packages/protocol/src/index.ts';

test('context capture honors the configured recent-message window without dropping decisions', t => {
  assert.equal(defaultExecutionSettings.maxContextMessages, 40);
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'context-window-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const command = (type: string, payload: unknown) => service.execute({ version: '0.1', commandId: uid(), roomId, type, payload });
  command('settings.update', { ...store.settings(), maxContextMessages: 3 });
  for (let index = 0; index < 5; index++) command('message.send', { text: `window-${index}`, mentions: [] });
  const context = captureContext(store, roomId, store.room(roomId)!.seq);
  assert.equal(context.messages.length, 3);
  assert.deepEqual(context.messages.map(message => message.text), ['window-2', 'window-3', 'window-4']);
  assert.ok(context.fromSeq > 0);
});
