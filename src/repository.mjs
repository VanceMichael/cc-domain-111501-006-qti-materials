import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const MANAGED_RECORD_KIND = 'item-reference';

export class Repository {
  constructor(directory) {
    this.directory = directory;
    this.state = { records: {}, cursors: {}, evidence: {}, notes: [], files: {}, entities: {} };
  }

  async open() {
    await mkdir(join(this.directory, 'raw'), { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
      this.state = { ...this.state, ...loaded };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  async save() {
    const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(this.state, null, 2));
    await rename(temporary, join(this.directory, 'state.json'));
  }

  async put(record) {
    if (!record.id) throw new Error('record id required');
    this.state.records[record.id] = structuredClone(record);
    await this.save();
  }

  async retain(origin, body, metadata = {}) {
    const bytes = Buffer.from(body);
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(this.directory, 'raw', digest), bytes);
    this.state.evidence[digest] = { origin, ...metadata, size: bytes.length };
    await this.save();
    return digest;
  }

  async raw(digest) {
    return readFile(join(this.directory, 'raw', digest));
  }

  async cursor(name, value) {
    this.state.cursors[name] = structuredClone(value);
    await this.save();
  }

  async note(value) {
    this.state.notes.push(structuredClone(value));
    await this.save();
  }

  // Fetched file index: one entry per source path, carrying revision, etag,
  // digest of retained bytes and the interpretation derived from them.
  file(path) {
    const entry = this.state.files[path];
    return entry ? structuredClone(entry) : undefined;
  }

  files() {
    return Object.values(structuredClone(this.state.files));
  }

  async putFile(path, entry) {
    this.state.files[path] = structuredClone({ ...entry, path });
    await this.save();
  }

  entities() {
    return structuredClone(this.state.entities);
  }

  // Atomically commits the derived view: managed reference records are
  // replaced as a set (other records, e.g. legacy previews, are left alone)
  // and the deduplicated bank entities are swapped for the merged view.
  async derive({ records, entities }) {
    for (const [id, record] of Object.entries(this.state.records)) {
      if (record && record.kind === MANAGED_RECORD_KIND) delete this.state.records[id];
    }
    for (const record of records) {
      this.state.records[record.id] = structuredClone(record);
    }
    this.state.entities = structuredClone(entities);
    await this.save();
  }

  // Reconciles machine-readable diagnostics: issues still present stay open
  // (updated only when reason or affected references change), cleared issues
  // are marked resolved, new ones are appended. Notes of other shapes are
  // left untouched.
  async reconcile(issues, types) {
    const managed = new Set(types);
    const current = new Map(issues.map(issue => [`${issue.type}:${issue.path}`, issue]));
    const now = new Date().toISOString();
    let changed = false;
    for (const note of this.state.notes) {
      if (!managed.has(note.type) || note.status !== 'open') continue;
      const key = `${note.type}:${note.path}`;
      const fresh = current.get(key);
      if (!fresh) {
        note.status = 'resolved';
        note.resolved = now;
        changed = true;
        continue;
      }
      const affectedShifted = JSON.stringify(note.affected ?? []) !== JSON.stringify(fresh.affected ?? []);
      if (note.reason !== fresh.reason || affectedShifted) {
        note.reason = fresh.reason;
        note.affected = fresh.affected ?? [];
        note.count = (note.count ?? 1) + 1;
        note.last = now;
        changed = true;
      }
      current.delete(key);
    }
    for (const issue of current.values()) {
      this.state.notes.push({
        type: issue.type, path: issue.path, reason: issue.reason,
        affected: issue.affected ?? [], status: 'open', count: 1, first: now, last: now
      });
      changed = true;
    }
    if (changed) await this.save();
  }

  records() {
    return Object.values(structuredClone(this.state.records));
  }

  snapshot() {
    return structuredClone(this.state);
  }
}
