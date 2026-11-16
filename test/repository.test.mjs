import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../src/repository.mjs';

test('records, evidence and cursors survive a reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-test-'));
  try {
    const repository = await new Repository(directory).open();
    await repository.put({ id: 'sample', value: 7 });
    const digest = await repository.retain('/source', 'local sample');
    await repository.cursor('legacy', 'position-1');
    const reopened = await new Repository(directory).open();
    assert.equal(reopened.records()[0].value, 7);
    assert.equal(reopened.snapshot().cursors.legacy, 'position-1');
    assert.equal(reopened.snapshot().evidence[digest].size, 12);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('record ids are required', async () => {
  const repository = new Repository('/unused');
  await assert.rejects(repository.put({ value: 1 }), /id required/);
});

test('file index, entities and derived records survive a reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-test-'));
  try {
    const repository = await new Repository(directory).open();
    const digest = await repository.retain('a.xml', '<a/>');
    await repository.putFile('a.xml', { id: 'a', status: 'fetched', digest, interpretedDigest: digest });
    await repository.derive({
      records: [{ id: 't:r', kind: 'item-reference', itemId: 'i' }],
      entities: { 'item:i': { kind: 'item', id: 'i', revisions: [{ digest, revision: 1 }] } }
    });
    const reopened = await new Repository(directory).open();
    assert.equal(reopened.file('a.xml').digest, digest);
    assert.equal(reopened.files().length, 1);
    assert.equal(reopened.entities()['item:i'].revisions.length, 1);
    assert.equal(reopened.records()[0].itemId, 'i');
    assert.equal((await reopened.raw(digest)).toString(), '<a/>');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('derive replaces managed records but keeps other records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-test-'));
  try {
    const repository = await new Repository(directory).open();
    await repository.put({ id: 'legacy-preview', root: 'xml' });
    await repository.derive({ records: [{ id: 't:r1', kind: 'item-reference' }], entities: {} });
    await repository.derive({ records: [{ id: 't:r2', kind: 'item-reference' }], entities: {} });
    const ids = repository.records().map(record => record.id).sort();
    assert.deepEqual(ids, ['legacy-preview', 't:r2']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reconcile opens, updates and resolves managed notes without duplicates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-test-'));
  try {
    const repository = await new Repository(directory).open();
    const types = ['missing-document'];
    await repository.reconcile([{ type: 'missing-document', path: 's.xml', reason: 'source status 404', affected: ['t:r'] }], types);
    await repository.reconcile([{ type: 'missing-document', path: 's.xml', reason: 'source status 404', affected: ['t:r'] }], types);
    let notes = repository.snapshot().notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].status, 'open');
    assert.equal(notes[0].count, 1);
    await repository.reconcile([], types);
    notes = repository.snapshot().notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].status, 'resolved');
    const reopened = await new Repository(directory).open();
    assert.equal(reopened.snapshot().notes[0].status, 'resolved');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
