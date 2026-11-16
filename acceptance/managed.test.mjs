    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { readFile, mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { createSource } from '../simulator/source.mjs';
    import { collect } from '../src/collector.mjs';
    import { Repository } from '../src/repository.mjs';
    const fixture = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));

    async function session(run) {
      const directory = await mkdtemp(join(tmpdir(), 'structured-intake-'));
      const source = await createSource({ scenario: 'feature' });
      try { await run(source, await new Repository(directory).open(), directory); }
      finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
    }

    async function sessionIn(scenario, run) {
      const directory = await mkdtemp(join(tmpdir(), 'structured-intake-'));
      const source = await createSource({ scenario });
      try { await run(source, await new Repository(directory).open(), directory); }
      finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
    }

    test('source records retain the product relationships rather than a file preview', async () => {
      await session(async (source, repository) => {
        await collect({ base: source.base, repository, mode: 'managed' });
        const records = repository.records();
        assert.deepEqual(records.map(record => record.id).sort(), [...fixture.expectedIds].sort());
assert.ok(records.every(record => record.itemId === 'item-a')); assert.ok(records.every(record => record.responses.RESPONSE.correct[0] === 'A')); assert.ok(records.every(record => record.stimulusId === 'stimulus-a'));
      });
    });

    test('repeated delivery after reopen preserves business identities and original evidence', async () => {
      await session(async (source, repository, directory) => {
        await collect({ base: source.base, repository, mode: 'managed' });
        const evidence = Object.keys(repository.snapshot().evidence);
        const reopened = await new Repository(directory).open();
        await collect({ base: source.base, repository: reopened, mode: 'managed' });
        assert.deepEqual(reopened.records().map(record => record.id).sort(), [...fixture.expectedIds].sort());
        assert.ok(evidence.every(digest => reopened.snapshot().evidence[digest]));
      });
    });

    test('missing material keeps references pending and locatable until supplemented', async () => {
      await sessionIn('feature', async (source, repository) => {
        source.state.missingDoc = 'stimulus';
        const first = await collect({ base: source.base, repository, mode: 'managed' });
        assert.equal(first.complete, false);
        const records = repository.records();
        assert.deepEqual(records.map(record => record.id).sort(), [...fixture.expectedIds].sort());
        assert.ok(records.every(record => record.itemId === 'item-a'));
        assert.ok(records.every(record => record.stimulusId === null));
        assert.ok(records.every(record => record.pending.some(pending => pending.location === 'stimulus.xml')));
        assert.ok(records.every(record => record.responses.RESPONSE.correct[0] === 'A'));
        const note = repository.snapshot().notes.find(value => value.type === 'missing-document' && value.path === 'stimulus.xml');
        assert.equal(note.status, 'open');
        assert.deepEqual([...note.affected].sort(), [...fixture.expectedIds].sort());

        source.state.missingDoc = null;
        const second = await collect({ base: source.base, repository, mode: 'managed' });
        assert.equal(second.complete, true);
        assert.deepEqual(second.interpreted, ['stimulus.xml']);
        assert.ok(repository.records().every(record => record.stimulusId === 'stimulus-a' && record.pending.length === 0));
        assert.equal(repository.snapshot().notes.find(value => value.type === 'missing-document' && value.path === 'stimulus.xml').status, 'resolved');
      });
    });

    test('missing item never fabricates response variables', async () => {
      await sessionIn('feature', async (source, repository) => {
        source.state.missingDoc = 'item';
        const result = await collect({ base: source.base, repository, mode: 'managed' });
        assert.equal(result.complete, false);
        const records = repository.records();
        assert.deepEqual(records.map(record => record.id).sort(), [...fixture.expectedIds].sort());
        assert.ok(records.every(record => record.itemId === null));
        assert.ok(records.every(record => Object.keys(record.responses).length === 0));
        assert.ok(records.every(record => record.pending.some(pending => pending.location === 'items/item.xml')));

        source.state.missingDoc = null;
        const restored = await collect({ base: source.base, repository, mode: 'managed' });
        assert.ok(restored.complete);
        assert.ok(repository.records().every(record => record.responses.RESPONSE.correct[0] === 'A'));
      });
    });

    test('choice identifiers and response variables stay scoped to their own item', async () => {
      await sessionIn('extended', async (source, repository) => {
        await collect({ base: source.base, repository, mode: 'managed' });
        const records = Object.fromEntries(repository.records().map(record => [record.id, record]));
        assert.equal(records['test-x:r-1'].responses.RESPONSE.correct[0], 'A');
        assert.equal(records['test-x:r-2'].responses.RESPONSE.correct[0], 'B');
        assert.equal(records['test-x:r-2'].itemId, 'item-b');
        const shared = Object.values(repository.entities()).filter(entity => entity.kind === 'item' && entity.id === 'item-a');
        assert.equal(shared.length, 1);
        for (const id of ['test-x:r-1', 'test-x:r-3', 'test-y:s-1']) assert.equal(records[id].itemId, 'item-a');
        assert.equal(records['test-x:r-1'].position.section, 'sec-a');
        assert.equal(records['test-x:r-3'].position.section, 'sec-b');
        assert.equal(records['test-y:s-1'].testId, 'test-y');
        const section = repository.entities()['section:test-x/sec-b'];
        assert.equal(section.refs[1].path, 'items/custom.xml');
        assert.equal(repository.entities()['test:test-y'].parts[0].sections[0].refs[0].path, 'items/item-a.xml');
      });
    });

    test('unsupported interactions are retained raw and never treated as plain choice', async () => {
      await sessionIn('extended', async (source, repository) => {
        await collect({ base: source.base, repository, mode: 'managed' });
        const record = Object.fromEntries(repository.records().map(value => [value.id, value]))['test-x:r-4'];
        assert.equal(record.itemId, 'item-c');
        assert.equal(record.responses.RESPONSE.interaction, null);
        assert.equal(record.responses.RESPONSE.cardinality, 'single');
        const names = record.unparsed.map(value => value.name);
        assert.ok(names.includes('qti-custom-interaction'));
        assert.ok(names.includes('qti-response-processing'));
        const custom = record.unparsed.find(value => value.name === 'qti-custom-interaction');
        assert.ok(custom.xml.includes('<acme:pad rows="3"/>'));
        assert.ok(repository.entities()['item:item-c'].unparsed.length >= 2);
      });
    });

    test('external material is reported pending with its location instead of being fetched or invented', async () => {
      await sessionIn('extended', async (source, repository) => {
        const result = await collect({ base: source.base, repository, mode: 'managed' });
        assert.equal(result.complete, false);
        const record = Object.fromEntries(repository.records().map(value => [value.id, value]))['test-x:r-2'];
        assert.equal(record.stimulusId, null);
        assert.ok(record.pending.some(pending => pending.external && pending.location === 'https://example.invalid/shared.xml'));
        const note = repository.snapshot().notes.find(value => value.type === 'external-material');
        assert.deepEqual(note.affected, ['test-x:r-2']);
        assert.ok(source.requests.every(value => !value.path.includes('example.invalid')));
      });
    });

    test('revision keeps reference identity and traces both interpretations', async () => {
      await sessionIn('feature', async (source, repository) => {
        await collect({ base: source.base, repository, mode: 'managed' });
        const before = repository.entities()['item:item-a'];
        assert.equal(before.revisions.length, 1);
        assert.equal(before.interactions[0].choices[0].text, 'Choice A');
        source.state.round = 2;
        const second = await collect({ base: source.base, repository, mode: 'managed' });
        assert.deepEqual(second.interpreted, ['items/item.xml']);
        assert.deepEqual(repository.records().map(record => record.id).sort(), [...fixture.expectedIds].sort());
        const after = repository.entities()['item:item-a'];
        assert.equal(after.revisions.length, 2);
        assert.equal(after.interactions[0].choices[0].text, 'Choice A revised');
        assert.ok(repository.records().every(record => record.responses.RESPONSE.interaction.choices[0].text === 'Choice A revised'));
        for (const { digest } of after.revisions) assert.ok(repository.snapshot().evidence[digest]);
        assert.equal(repository.entities()['stimulus:stimulus-a'].revisions.length, 1);
      });
    });

    test('interpretation failures and empty documents are isolated with notes', async () => {
      await sessionIn('boundary', async (source, repository) => {
        const result = await collect({ base: source.base, repository, mode: 'managed' });
        assert.equal(result.complete, false);
        assert.deepEqual(repository.records().map(record => record.id), ['test-b:r-1']);
        assert.equal(repository.records()[0].itemId, 'item-z');
        const notes = repository.snapshot().notes;
        assert.ok(notes.some(note => note.type === 'interpretation-failed' && note.path === 'broken.xml' && note.status === 'open'));
        assert.ok(notes.some(note => note.type === 'interpretation-failed' && note.path === 'empty.xml' && note.status === 'open'));
        assert.equal(Object.keys(repository.snapshot().evidence).length, 4);
        const again = await collect({ base: source.base, repository, mode: 'managed' });
        assert.equal(again.fetched.length, 0);
        assert.deepEqual(repository.records().map(record => record.id), ['test-b:r-1']);
      });
    });

    test('interrupted collection resumes from retained evidence after reopen', async () => {
      await sessionIn('feature', async (source, repository, directory) => {
        await assert.rejects(
          collect({
            base: source.base, repository, mode: 'managed',
            hooks: { afterRetain: async ({ path }) => { if (path === 'items/item.xml') throw new Error('process killed'); } }
          }),
          /process killed/);
        assert.equal(repository.records().length, 0);
        assert.equal(Object.keys(repository.snapshot().evidence).length, 2);
        const reopened = await new Repository(directory).open();
        const recovered = await collect({ base: source.base, repository: reopened, mode: 'managed' });
        assert.ok(recovered.complete);
        assert.deepEqual(reopened.records().map(record => record.id).sort(), [...fixture.expectedIds].sort());
        assert.ok(reopened.records().every(record => record.stimulusId === 'stimulus-a'));
        assert.equal(Object.keys(reopened.snapshot().evidence).length, 3);
      });
    });

    test('documents withdrawn from the package are flagged with affected references', async () => {
      await sessionIn('feature', async (source, repository) => {
        await collect({ base: source.base, repository, mode: 'managed' });
        source.state.dropDoc = 'stimulus';
        const second = await collect({ base: source.base, repository, mode: 'managed' });
        assert.equal(second.complete, false);
        const note = repository.snapshot().notes.find(value => value.type === 'not-in-package' && value.path === 'stimulus.xml');
        assert.equal(note.status, 'open');
        assert.deepEqual([...note.affected].sort(), [...fixture.expectedIds].sort());
        assert.ok(repository.records().every(record => record.stimulusId === 'stimulus-a'));
        source.state.dropDoc = null;
        const third = await collect({ base: source.base, repository, mode: 'managed' });
        assert.ok(third.complete);
        assert.equal(repository.snapshot().notes.find(value => value.type === 'not-in-package').status, 'resolved');
      });
    });
