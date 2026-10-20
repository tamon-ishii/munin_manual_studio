import assert from 'node:assert/strict';
import { DocumentPersistence, type DocumentSaveContext } from '../apps/manual-studio/src/documentPersistence';
import type { Document } from '../apps/manual-studio/src/types';

function fixture() {
  let active: DocumentSaveContext = { document: { page: 'index.md', content: 'before', revision: '1' }, root: '/project', content: 'first', version: 1 };
  const writes: { context: DocumentSaveContext; resolve: (value: Document) => void; reject: (error: Error) => void }[] = [];
  let refreshes = 0;
  const notices: string[] = [];
  const saver = new DocumentPersistence({
    context: () => active,
    write: context => new Promise((resolve, reject) => writes.push({ context, resolve, reject })),
    stateChanged: () => {},
    apply: (saved, submitted) => { active = { ...active, document: saved, content: active.content === submitted.content ? saved.content : active.content }; },
    refresh: async () => { refreshes++; },
    saved: page => notices.push(page),
  });
  return { saver, writes, notices, get active() { return active; }, set active(value: DocumentSaveContext) { active = value; }, get refreshes() { return refreshes; } };
}

// Simultaneous callers must serialize; the next write uses the revision returned by the first.
{
  const f = fixture();
  const first = f.saver.save(false);
  f.active = { ...f.active, content: 'second' };
  const second = f.saver.save();
  assert.equal(f.writes.length, 1);
  f.writes[0].resolve({ page: 'index.md', content: 'first', revision: '2' });
  await first;
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[1].context.document.revision, '2');
  assert.equal(f.writes[1].context.content, 'second');
  f.writes[1].resolve({ page: 'index.md', content: 'second', revision: '3' });
  await second;
  assert.equal(f.active.content, 'second');
  assert.equal(f.refreshes, 1);
  assert.equal(f.saver.state, null);
}

// Late success or failure must not update a different project, page, or read generation.
for (const change of ['root', 'document', 'version'] as const) {
  for (const fail of [false, true]) {
    const f = fixture();
    const pending = f.saver.save();
    const checked = fail ? assert.rejects(pending, /conflict/) : pending;
    f.active = { ...f.active, [change]: change === 'root' ? '/other' : change === 'version' ? 2 : { ...f.active.document, page: 'other.md' } };
    const active = f.active;
    f.saver.state = null;
    if (fail) f.writes[0].reject(new Error('revision conflict'));
    else f.writes[0].resolve({ page: 'index.md', content: 'first', revision: '2' });
    await checked;
    assert.equal(f.active, active);
    assert.equal(f.saver.state, null);
    assert.equal(f.refreshes, 0);
    assert.deepEqual(f.notices, []);
  }
}

// A failed save retains the draft and supports a new attempt after the rejection.
{
  const f = fixture();
  const pending = f.saver.save();
  const checked = assert.rejects(pending, /conflict/);
  f.writes[0].reject(new Error('revision conflict'));
  await checked;
  assert.equal(f.active.content, 'first');
  assert.equal(f.saver.state?.state, 'error');
  const retry = f.saver.save(false);
  assert.equal(f.writes.length, 2);
  f.writes[1].resolve({ page: 'index.md', content: 'normalized', revision: '2' });
  await retry;
  assert.equal(f.active.content, 'normalized');
  assert.equal(f.saver.state, null);
}
console.log('Document persistence: serialization, draft retention, stale responses and retry passed.');
