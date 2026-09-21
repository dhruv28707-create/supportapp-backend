/**
 * In-memory Firestore for tests: the tiny subset of the admin SDK surface
 * this backend uses — doc get/set/delete, where/limit/== queries with
 * startAfter cursors, batches, listCollections — plus FieldValue.increment
 * semantics (increments resolve against the pre-write value on merge writes).
 *
 * Docs are stored keyed by their full path ("users/u1", "users/u1/messages/m1").
 * Deliberately minimal; anything unused throws loudly so tests fail fast if
 * the code starts depending on behavior the mock does not model.
 */

export class IncrementValue {
  constructor(public readonly delta: number) {}
}

export const FieldValue = {
  increment(n: number): IncrementValue {
    return new IncrementValue(n);
  },
};

export class MockFirestore {
  private store = new Map<string, Record<string, unknown>>();

  reset(): void {
    this.store.clear();
  }

  /** Direct store access for assertions. */
  get(path: string): Record<string, unknown> | undefined {
    return this.store.get(path);
  }

  /** All stored paths (test debugging). */
  paths(): string[] {
    return [...this.store.keys()];
  }

  /** Raw write primitive used by refs and batches. */
  set(path: string, data: Record<string, unknown>, merge: boolean): void {
    const existing = this.store.get(path);
    if (!merge || !existing) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data)) {
        out[k] = v instanceof IncrementValue ? v.delta : v;
      }
      this.store.set(path, out);
      return;
    }
    const out = { ...existing };
    for (const [k, v] of Object.entries(data)) {
      if (v instanceof IncrementValue) {
        const current = typeof out[k] === 'number' ? (out[k] as number) : 0;
        out[k] = current + v.delta;
      } else {
        out[k] = v;
      }
    }
    this.store.set(path, out);
  }

  delete(path: string): void {
    this.store.delete(path);
  }

  collection(name: string): MockCollectionRef {
    return new MockCollectionRef(this, name);
  }

  /** Direct children docs of a top-level collection. */
  docsIn(collection: string): Array<{ id: string; path: string; data: Record<string, unknown> }> {
    const prefix = `${collection}/`;
    return [...this.store.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, data]) => ({ id: path.slice(prefix.length), path, data }));
  }

  /** Subcollection ids directly under a doc path. */
  subcollectionsOf(docPath: string): string[] {
    const prefix = `${docPath}/`;
    const ids = new Set<string>();
    for (const path of this.store.keys()) {
      if (path.startsWith(prefix)) {
        const sub = path.slice(prefix.length).split('/')[0];
        if (sub) ids.add(sub);
      }
    }
    return [...ids];
  }

  /** Entries iterator for query execution. */
  entries(): Array<[string, Record<string, unknown>]> {
    return [...this.store.entries()];
  }
}

export class MockDocRef {
  constructor(
    private readonly fs: MockFirestore,
    public readonly path: string
  ) {}

  get id(): string {
    return this.path.split('/').pop() || '';
  }

  collection(name: string): MockCollectionRef {
    return new MockCollectionRef(this.fs, `${this.path}/${name}`);
  }

  async get(): Promise<MockDocSnapshot> {
    return new MockDocSnapshot(this, this.fs);
  }

  async set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void> {
    this.fs.set(this.path, data, opts?.merge ?? false);
  }

  async delete(): Promise<void> {
    this.fs.delete(this.path);
  }

  async listCollections(): Promise<MockCollectionRef[]> {
    return this.fs
      .subcollectionsOf(this.path)
      .map((sub) => new MockCollectionRef(this.fs, `${this.path}/${sub}`));
  }
}

export class MockDocSnapshot {
  constructor(
    public readonly ref: MockDocRef,
    private readonly fs: MockFirestore
  ) {}

  get exists(): boolean {
    return this.fs.get(this.ref.path) !== undefined;
  }

  get id(): string {
    return this.ref.id;
  }

  data(): Record<string, unknown> {
    return this.fs.get(this.ref.path) || {};
  }
}

export class MockCollectionRef {
  constructor(
    private readonly fs: MockFirestore,
    public readonly path: string
  ) {}

  get id(): string {
    return this.path.split('/').pop() || '';
  }

  doc(docId: string): MockDocRef {
    return new MockDocRef(this.fs, `${this.path}/${docId}`);
  }

  where(field: string, op: string, value: unknown): MockQuery {
    if (op !== '==') throw new Error(`MockFirestore: unsupported where op '${op}'`);
    return new MockQuery(this.fs, this.path, [{ field, value }]);
  }
}

interface Filter {
  field: string;
  value: unknown;
}

export class MockQuery {
  constructor(
    private readonly fs: MockFirestore,
    private readonly collectionPath: string,
    private readonly filters: Filter[],
    private readonly limitCount: number | null = null,
    private readonly startAfterId: string | null = null
  ) {}

  where(field: string, op: string, value: unknown): MockQuery {
    if (op !== '==') throw new Error(`MockFirestore: unsupported where op '${op}'`);
    return new MockQuery(this.fs, this.collectionPath, [...this.filters, { field, value }], this.limitCount, this.startAfterId);
  }

  limit(n: number): MockQuery {
    return new MockQuery(this.fs, this.collectionPath, this.filters, n, this.startAfterId);
  }

  startAfter(docId: string): MockQuery {
    return new MockQuery(this.fs, this.collectionPath, this.filters, this.limitCount, docId);
  }

  async get(): Promise<MockQuerySnapshot> {
    const prefix = `${this.collectionPath}/`;
    let entries = this.fs.entries().filter(([path]) => {
      if (!path.startsWith(prefix)) return false;
      const rest = path.slice(prefix.length);
      if (rest.includes('/')) return false; // direct children only
      if (this.startAfterId !== null && rest <= this.startAfterId) return false;
      const data = this.fs.get(path) || {};
      return this.filters.every((f) => data[f.field] === f.value);
    });

    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (this.limitCount !== null) entries = entries.slice(0, this.limitCount);

    const docs = entries.map(([path]) => new MockDocSnapshot(new MockDocRef(this.fs, path), this.fs));
    return new MockQuerySnapshot(docs);
  }
}

export class MockQuerySnapshot {
  constructor(public readonly docs: MockDocSnapshot[]) {}

  get empty(): boolean {
    return this.docs.length === 0;
  }

  get size(): number {
    return this.docs.length;
  }
}

export class MockWriteBatch {
  private ops: Array<() => void> = [];

  constructor(private readonly fs: MockFirestore) {}

  set(ref: MockDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): this {
    this.ops.push(() => ref.set(data, opts));
    return this;
  }

  delete(ref: MockDocRef): this {
    this.ops.push(() => ref.delete());
    return this;
  }

  async commit(): Promise<void> {
    for (const op of this.ops) op();
    this.ops = [];
  }
}
