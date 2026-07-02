/* keystrokes idb — IndexedDB session storage for the public site.
 * Same journal schema as the hub's JSONL files; the shelf reads either.
 * Everything stays in the visitor's browser.
 */

const DB_NAME = 'keystrokes';
const DB_VER = 1;

export function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'sid' });
      }
      if (!db.objectStoreNames.contains('batches')) {
        const st = db.createObjectStore('batches', { autoIncrement: true });
        st.createIndex('sid', 'sid');
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const done = tx => new Promise((res, rej) => {
  tx.oncomplete = res;
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error);
});

export async function idbPutBatch(db, sid, header, events) {
  const tx = db.transaction(['sessions', 'batches'], 'readwrite');
  const sess = tx.objectStore('sessions');
  const meta = await new Promise(res => {
    const g = sess.get(sid);
    g.onsuccess = () => res(g.result);
    g.onerror = () => res(null);
  });
  let lastT = meta ? meta.lastT : 0;
  for (const ev of events) if (typeof ev.t === 'number' && ev.t > lastT) lastT = ev.t;
  sess.put({
    sid,
    header: meta ? meta.header : header,
    startedWall: meta ? meta.startedWall : (header && header.startedWall) || Date.now(),
    events: (meta ? meta.events : 0) + events.length,
    lastT,
  });
  tx.objectStore('batches').add({ sid, events });
  await done(tx);
}

export async function idbSessions(db) {
  const tx = db.transaction('sessions');
  return new Promise((res, rej) => {
    const g = tx.objectStore('sessions').getAll();
    g.onsuccess = () => res((g.result || []).sort((a, b) => (a.sid < b.sid ? 1 : -1)));
    g.onerror = () => rej(g.error);
  });
}

export async function idbSessionEvents(db, sid) {
  const tx = db.transaction('batches');
  return new Promise((res, rej) => {
    // autoIncrement keys preserve insertion order, so events come back in time order
    const g = tx.objectStore('batches').index('sid').getAll(sid);
    g.onsuccess = () => res((g.result || []).flatMap(b => b.events));
    g.onerror = () => rej(g.error);
  });
}

export async function idbDelete(db, sid) {
  const tx = db.transaction(['sessions', 'batches'], 'readwrite');
  tx.objectStore('sessions').delete(sid);
  const idx = tx.objectStore('batches').index('sid');
  await new Promise((res, rej) => {
    const cur = idx.openCursor(sid);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return res();
      c.delete(); c.continue();
    };
    cur.onerror = () => rej(cur.error);
  });
  await done(tx);
}

/* keep total stored events under a cap; drop oldest sessions first */
export async function idbPrune(db, maxEvents = 700000) {
  const sessions = await idbSessions(db);
  let total = sessions.reduce((s, m) => s + (m.events || 0), 0);
  const oldestFirst = [...sessions].reverse();
  for (const m of oldestFirst) {
    if (total <= maxEvents) break;
    if (oldestFirst.length < 2) break;      // never prune the only session
    await idbDelete(db, m.sid);
    total -= m.events || 0;
  }
}
