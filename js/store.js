// The phone's copy of the account: every synced row in IndexedDB, an outbox of changes made
// here and not yet sent, and receipt files. Works offline; sync() catches up when it can.
// Same rules as the desktop's SyncEngine: last write wins per row, and a change made here
// that has not been sent yet is never overwritten by an incoming one.
import * as api from './api.js';

const DB_NAME = 'expense-tracker';
const PULL_OVERLAP_MS = 60_000;
const PULL_PAGE = 1000;
const PUSH_BATCH = 500;

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('rows', { keyPath: ['tbl', 'id'] });
      db.createObjectStore('outbox', { keyPath: ['tbl', 'id'] });
      db.createObjectStore('files', { keyPath: 'hash' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function tx(stores, mode, work) {
  const db = await openDb();
  const t = db.transaction(stores, mode);
  const result = await work(...stores.map((s) => t.objectStore(s)));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return result;
}

async function getMeta(key) {
  return (await tx(['meta'], 'readonly', (meta) => done(meta.get(key))))?.value ?? null;
}

async function setMeta(key, value) {
  await tx(['meta'], 'readwrite', (meta) => done(meta.put({ key, value })));
}

export async function deviceId() {
  let id = await getMeta('device');
  if (!id) {
    id = `phone-${crypto.randomUUID().slice(0, 12)}`;
    await setMeta('device', id);
  }
  return id;
}

/** Ties the copy to the signed-in account; another account starts from nothing. */
export async function useAccount(accountId) {
  if ((await getMeta('account')) === accountId) return;
  const device = await deviceId();
  await tx(['rows', 'outbox', 'files', 'meta'], 'readwrite', async (rows, outbox, files, meta) => {
    rows.clear(); outbox.clear(); files.clear(); meta.clear();
    meta.put({ key: 'device', value: device });
    meta.put({ key: 'account', value: accountId });
  });
}

/** Every row there is, including changes not sent yet. */
export async function allRows() {
  return tx(['rows'], 'readonly', (rows) => done(rows.getAll()));
}

export async function pendingCount() {
  return tx(['outbox'], 'readonly', (outbox) => done(outbox.count()));
}

export async function lastSync() {
  return getMeta('lastSync');
}

/**
 * Records changes made on the phone: [{ tbl, id, data }] to write, { tbl, id, data: null }
 * to delete. They show at once and go out with the next sync.
 */
export async function write(changes) {
  const device = await deviceId();
  const updatedAt = new Date().toISOString();
  await tx(['rows', 'outbox'], 'readwrite', (rows, outbox) => {
    for (const c of changes) {
      if (c.data) rows.put({ tbl: c.tbl, id: c.id, data: c.data });
      else rows.delete([c.tbl, c.id]);
      outbox.put({ tbl: c.tbl, id: c.id, data: c.data ?? null, deleted: !c.data, updated_at: updatedAt, device_id: device });
    }
  });
}

/** Keeps a receipt picked on the phone until it is uploaded, and as the local copy after. */
export async function addFile(hash, blob, mediaType) {
  await tx(['files'], 'readwrite', (files) => done(files.put({ hash, blob, mediaType, uploaded: false })));
}

/** A receipt as a Blob: from the phone if it has one, otherwise fetched and kept. */
export async function getFile(hash) {
  const local = await tx(['files'], 'readonly', (files) => done(files.get(hash)));
  if (local) return local.blob;
  const blob = await api.downloadFile(hash);
  if (blob) await tx(['files'], 'readwrite', (files) => done(files.put({ hash, blob, mediaType: blob.type, uploaded: true })));
  return blob;
}

let running = null;

/** One sync: take in what changed elsewhere, then send what changed here. Returns how many rows came in. */
export function sync() {
  running ??= run().finally(() => { running = null; });
  return running;
}

async function run() {
  if (!api.isSignedIn()) return 0;
  await useAccount(api.userId());
  await uploadFiles();
  const pulled = await pull();
  await push();
  await setMeta('lastSync', new Date().toISOString());
  return pulled;
}

async function pull() {
  const cursor = await getMeta('cursor');
  let since = cursor ? new Date(Date.parse(cursor) - PULL_OVERLAP_MS).toISOString() : '1970-01-01T00:00:00Z';
  let changed = 0;

  for (;;) {
    const page = await api.pullRows(since, PULL_PAGE);
    if (!page.length) break;

    changed += await tx(['rows', 'outbox', 'meta'], 'readwrite', async (rows, outbox, meta) => {
      let n = 0;
      for (const r of page) {
        // Changed here and not sent yet: this phone's version goes out next and wins.
        if (await done(outbox.get([r.tbl, r.id]))) continue;
        if (r.deleted || !r.data) rows.delete([r.tbl, r.id]);
        else rows.put({ tbl: r.tbl, id: r.id, data: r.data });
        n++;
      }
      const last = page[page.length - 1].synced_at;
      const stored = (await done(meta.get('cursor')))?.value;
      if (!stored || Date.parse(last) > Date.parse(stored)) meta.put({ key: 'cursor', value: last });
      return n;
    });

    const last = page[page.length - 1].synced_at;
    if (page.length < PULL_PAGE || Date.parse(last) <= Date.parse(since)) break;
    since = last;
  }

  return changed;
}

async function push() {
  const pending = await tx(['outbox'], 'readonly', (outbox) => done(outbox.getAll()));
  for (let i = 0; i < pending.length; i += PUSH_BATCH) {
    const batch = pending.slice(i, i + PUSH_BATCH);
    await api.pushRows(batch.map(({ tbl, id, data, deleted, updated_at, device_id }) =>
      ({ tbl, id, data, deleted, updated_at, device_id })));

    // Cleared only if not changed again while it was being sent.
    await tx(['outbox'], 'readwrite', async (outbox) => {
      for (const sent of batch) {
        const now = await done(outbox.get([sent.tbl, sent.id]));
        if (now && now.updated_at === sent.updated_at) outbox.delete([sent.tbl, sent.id]);
      }
    });
  }
}

/** Receipts go up before the rows that mention them, so the PC never sees a missing file. */
async function uploadFiles() {
  const files = await tx(['files'], 'readonly', (store) => done(store.getAll()));
  for (const f of files.filter((x) => !x.uploaded)) {
    await api.uploadFile(f.hash, f.blob, f.mediaType);
    await tx(['files'], 'readwrite', (store) => done(store.put({ ...f, uploaded: true })));
  }
}

export async function forgetEverything() {
  await tx(['rows', 'outbox', 'files', 'meta'], 'readwrite', async (rows, outbox, files, meta) => {
    rows.clear(); outbox.clear(); files.clear(); meta.clear();
  });
}
