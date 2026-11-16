import { json, request } from './http.mjs';
import { interpret, resolvePath } from './qti.mjs';

const REFERENCE_KIND = 'item-reference';
const ISSUE_TYPES = [
  'missing-document', 'fetch-failed', 'interpretation-failed', 'unknown-document',
  'external-material', 'unresolved-reference', 'not-in-package', 'identifier-conflict'
];

// Structured intake for the managed mode. The run is split into durable
// stages — fetch, interpret, resolve, commit — so a process stopped between
// retaining raw bytes and committing relations can resume from the file
// index on the next run instead of starting over.
export async function collectManaged({ base, repository, entry, hooks = {} }) {
  const catalog = await json(base, entry);
  const documents = catalog.documents ?? [];
  const fetched = [];
  const interpreted = [];

  // Stage 1: fetch every catalog document with entity-tag caching. Failures
  // are recorded per file; confirmed content from earlier runs is kept.
  for (const document of documents) {
    const prior = repository.file(document.path) ?? { path: document.path };
    const headers = prior.etag ? { 'if-none-match': prior.etag } : {};
    let response;
    try {
      response = await request(base, document.href, { headers });
    } catch (error) {
      await repository.putFile(document.path, {
        ...prior, id: document.id, format: document.format, revision: document.revision,
        status: 'failed', error: error.message
      });
      continue;
    }
    if (response.status === 304) {
      await repository.putFile(document.path, {
        ...prior, id: document.id, format: document.format, revision: document.revision,
        status: prior.digest ? 'fetched' : prior.status ?? 'missing'
      });
      continue;
    }
    if (!response.ok) {
      await repository.putFile(document.path, {
        ...prior, id: document.id, format: document.format, revision: document.revision,
        status: response.status === 404 ? 'missing' : 'failed',
        error: `source status ${response.status}`
      });
      continue;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const etag = response.headers.get('etag');
    const digest = await repository.retain(document.path, bytes, {
      etag, revision: document.revision, document: document.id
    });
    const unchanged = prior.digest === digest;
    await repository.putFile(document.path, {
      id: document.id, path: document.path, format: document.format,
      revision: document.revision, etag, digest, status: 'fetched', error: null,
      interpretation: unchanged ? prior.interpretation ?? null : null,
      interpretedDigest: unchanged ? prior.interpretedDigest ?? null : null,
      interpretationError: unchanged ? prior.interpretationError ?? null : null
    });
    fetched.push(document.path);
    await hooks.afterRetain?.({ path: document.path, digest, document });
  }

  // Stage 2: interpret only files whose retained bytes are not yet
  // interpreted. Unchanged files keep their cached interpretation, so a
  // supplemented document re-interprets nothing else.
  for (const file of repository.files()) {
    if (file.status !== 'fetched' || !file.digest) continue;
    if (file.interpretedDigest === file.digest && (file.interpretation || file.interpretationError)) continue;
    let interpretation = null;
    let interpretationError = null;
    if (file.format !== 'xml') {
      interpretation = { kind: 'unknown', root: `format:${file.format}` };
    } else {
      try {
        const raw = await repository.raw(file.digest);
        interpretation = interpret(file.path, raw.toString('utf8'));
      } catch (error) {
        interpretationError = error.message;
      }
    }
    await repository.putFile(file.path, { ...file, interpretation, interpretedDigest: file.digest, interpretationError });
    interpreted.push(file.path);
    await hooks.afterInterpret?.({ path: file.path });
  }

  const files = Object.fromEntries(repository.files().map(file => [file.path, file]));
  const priorEntities = repository.entities();
  const entities = {};
  const records = [];
  const issueMap = new Map();
  const addIssue = issue => {
    const key = `${issue.type}:${issue.path}`;
    if (!issueMap.has(key)) issueMap.set(key, issue);
  };

  for (const file of Object.values(files)) {
    if (file.status === 'missing') addIssue({ type: 'missing-document', path: file.path, reason: file.error ?? 'missing at source' });
    if (file.status === 'failed') addIssue({ type: 'fetch-failed', path: file.path, reason: file.error ?? 'fetch failed' });
    if (file.interpretationError) addIssue({ type: 'interpretation-failed', path: file.path, reason: file.interpretationError });
  }

  // Stage 3: build the deduplicated bank view. Content objects (tests,
  // sections, items, stimuli) are keyed by identity; revision history is
  // merged with what earlier runs confirmed so interpretation versions stay
  // traceable. References are resolved afterwards against this view.
  const sourceOf = file => ({ path: file.path, digest: file.digest, revision: file.revision ?? null });
  const register = (key, entity, file) => {
    const existing = entities[key];
    if (existing && existing.source.digest !== entity.source.digest) {
      addIssue({
        type: 'identifier-conflict', path: file.path,
        reason: `${key} declared by both ${existing.source.path} and ${file.path}`
      });
    }
    const revisions = [...(priorEntities[key]?.revisions ?? [])];
    for (const source of [existing?.source, entity.source]) {
      if (source?.digest && !revisions.some(entry => entry.digest === source.digest)) {
        revisions.push({ digest: source.digest, revision: source.revision });
      }
    }
    entities[key] = { ...(existing ?? entity), revisions };
  };

  for (const file of Object.values(files)) {
    const view = file.interpretation;
    if (!view) continue;
    if (view.kind === 'unknown') {
      addIssue({ type: 'unknown-document', path: file.path, reason: `unrecognized document root ${view.root}` });
      continue;
    }
    if (view.kind === 'test') {
      register(`test:${view.identifier}`, {
        kind: 'test', id: view.identifier, identifier: view.identifier, title: view.title,
        parts: view.parts.map(part => ({
          identifier: part.identifier,
          sections: part.sections.map(section => ({
            identifier: section.identifier, title: section.title, visible: section.visible,
            refs: section.refs.map(ref => ({ identifier: ref.identifier, href: ref.href, ...resolvePath(file.path, ref.href) }))
          }))
        })),
        source: sourceOf(file)
      }, file);
      for (const part of view.parts) {
        for (const section of part.sections) {
          register(`section:${view.identifier}/${section.identifier}`, {
            kind: 'section', id: `${view.identifier}/${section.identifier}`,
            testId: view.identifier, part: part.identifier,
            identifier: section.identifier, title: section.title, visible: section.visible,
            refs: section.refs.map(ref => ({ identifier: ref.identifier, href: ref.href, ...resolvePath(file.path, ref.href) })),
            source: sourceOf(file)
          }, file);
        }
      }
    } else if (view.kind === 'item') {
      register(`item:${view.identifier}`, {
        kind: 'item', id: view.identifier, identifier: view.identifier, title: view.title,
        declarations: view.declarations, outcomes: view.outcomes,
        interactions: view.interactions, unparsed: view.unparsed,
        stimulusRefs: view.stimulusRefs.map(ref => ({ ...ref, ...resolvePath(file.path, ref.href) })),
        source: sourceOf(file)
      }, file);
    } else if (view.kind === 'stimulus') {
      register(`stimulus:${view.identifier}`, {
        kind: 'stimulus', id: view.identifier, identifier: view.identifier,
        title: view.title, body: view.body, source: sourceOf(file)
      }, file);
    }
  }

  // Stage 4: resolve every reference instance. Each reference keeps its
  // position inside the test; response variables and choice identifiers are
  // interpreted in the scope of the referenced item only. Anything
  // undelivered, failed or external becomes an explicit pending entry.
  const describe = location => {
    const file = files[location];
    if (!file) return 'referenced path not delivered by source';
    if (file.status === 'missing') return `material missing at source (${file.error})`;
    if (file.status === 'failed') return `material fetch failed (${file.error})`;
    if (file.interpretationError) return `material not interpreted (${file.interpretationError})`;
    if (!file.interpretation) return 'material pending interpretation';
    return null;
  };

  let sequence = 0;
  for (const file of Object.values(files)) {
    const test = file.interpretation;
    if (!test || test.kind !== 'test') continue;
    for (const part of test.parts) {
      for (const section of part.sections) {
        for (const [order, ref] of section.refs.entries()) {
          const record = {
            id: `${test.identifier}:${ref.identifier}`, kind: REFERENCE_KIND,
            testId: test.identifier, refId: ref.identifier,
            position: { part: part.identifier, section: section.identifier, order, sequence: sequence++ },
            itemId: null, itemPath: null, responses: {}, unparsed: [],
            stimulusId: null, stimulusPath: null, materials: [],
            pending: [], source: { test: sourceOf(file) }
          };
          const target = resolvePath(file.path, ref.href);
          if (target.external) {
            record.pending.push({ location: target.external, reason: 'external reference not collected', external: true });
          } else if (target.missing || !target.path) {
            record.pending.push({ location: ref.href ?? record.id, reason: 'reference without resolvable href' });
          } else {
            record.itemPath = target.path;
            const itemFile = files[target.path];
            const item = itemFile?.interpretation;
            const problem = describe(target.path);
            if (problem) record.pending.push({ location: target.path, reason: problem });
            else if (item.kind !== 'item') record.pending.push({ location: target.path, reason: `referenced document is ${item.kind}, not an item` });
            else {
              record.itemId = item.identifier;
              record.source.item = sourceOf(itemFile);
              record.responses = scopeResponses(item);
              record.unparsed = item.unparsed;
              for (const stimulusRef of item.stimulusRefs) {
                const resolved = resolvePath(itemFile.path, stimulusRef.href);
                const material = { href: stimulusRef.href };
                if (resolved.external) {
                  material.external = resolved.external;
                  record.pending.push({ location: resolved.external, reason: 'external material not collected', external: true });
                } else if (resolved.missing || !resolved.path) {
                  record.pending.push({ location: stimulusRef.href ?? target.path, reason: 'material reference without href' });
                } else {
                  material.path = resolved.path;
                  const materialFile = files[resolved.path];
                  const materialProblem = describe(resolved.path);
                  if (materialProblem) record.pending.push({ location: resolved.path, reason: materialProblem });
                  else if (materialFile.interpretation.kind !== 'stimulus') {
                    record.pending.push({ location: resolved.path, reason: 'referenced document is not a stimulus' });
                  } else {
                    material.stimulusId = materialFile.interpretation.identifier;
                    material.digest = materialFile.digest;
                  }
                }
                record.materials.push(material);
              }
              const firstMaterial = record.materials[0];
              record.stimulusId = firstMaterial?.stimulusId ?? null;
              record.stimulusPath = firstMaterial?.path ?? null;
            }
          }
          records.push(record);
        }
      }
    }
  }

  for (const record of records) {
    for (const pending of record.pending) {
      if (pending.external) addIssue({ type: 'external-material', path: pending.location, reason: pending.reason });
      else if (!files[pending.location]) addIssue({ type: 'unresolved-reference', path: pending.location, reason: pending.reason });
    }
  }

  // Documents the source no longer lists (e.g. a vendor moved a path) keep
  // their confirmed content, but staff must be able to locate the affected
  // references and supplement the file.
  const catalogPaths = new Set(documents.map(document => document.path));
  for (const file of Object.values(files)) {
    if (!catalogPaths.has(file.path)) {
      addIssue({ type: 'not-in-package', path: file.path, reason: 'no longer listed by source catalog' });
    }
  }

  const sourcePaths = record => [
    record.source?.test?.path, record.source?.item?.path,
    ...(record.materials ?? []).map(material => material.path)
  ].filter(Boolean);
  for (const issue of issueMap.values()) {
    issue.affected = records
      .filter(record => record.pending.some(pending => pending.location === issue.path) || sourcePaths(record).includes(issue.path))
      .map(record => record.id)
      .sort();
  }

  await hooks.beforeDerive?.({ records, entities });
  await repository.derive({ records, entities });
  await repository.reconcile([...issueMap.values()], ISSUE_TYPES);
  const complete = issueMap.size === 0;
  await repository.cursor('managed', {
    revision: catalog.revision ?? null, references: records.length, complete
  });
  return {
    mode: 'managed', imported: records.length, complete, fetched, interpreted,
    pending: records.filter(record => record.pending.length).map(record => record.id),
    issues: issueMap.size
  };
}

// Response declarations and choice interactions stay inside the owning
// item's scope; identifiers like RESPONSE or A/B are never promoted to
// bank-wide keys.
function scopeResponses(item) {
  const scoped = {};
  for (const [identifier, declaration] of Object.entries(item.declarations)) {
    scoped[identifier] = {
      cardinality: declaration.cardinality,
      baseType: declaration.baseType,
      correct: [...declaration.correct],
      interaction: item.interactions.find(interaction => interaction.responseIdentifier === identifier) ?? null
    };
  }
  return scoped;
}
