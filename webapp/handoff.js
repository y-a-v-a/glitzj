'use strict';

// ── Hand-off ──────────────────────────────────────────────────────────────────
//
// Keeps the image you are working on while you move between the pages, so a
// result from one tool can be broken further by the next. The image is stored
// in this browser's IndexedDB and nowhere else. It belongs to the tab: every
// tab stores its image under a name of its own, kept in sessionStorage, so a
// new tab starts empty and two tabs never see each other's image.
//
// Everything here is a convenience. Where storage is unavailable (private
// windows, blocked site data) every call quietly does nothing.

const Handoff = (() => {
  const DB = 'glitzj', STORE = 'handoff', MARK = 'glitzj-handoff';
  const KEEP_MS = 24 * 60 * 60 * 1000;

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function request(mode, run) {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(req && req.result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
    }));
  }

  // The name this tab stores its image under, made up once per tab.
  function tabId(create) {
    let id = sessionStorage.getItem(MARK);
    if (!id && create) {
      id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(MARK, id);
    }
    return id;
  }

  // Stores the image the page now works on, in place of this tab's previous
  // one. `blob` is the file as it was opened, or a result that was fed back
  // as the new source; `view` is how it is turned, mirrored and zoomed (see
  // source.js), as text. A closed tab cannot clean up after itself, so images
  // that other tabs left behind more than a day ago are removed here.
  async function save(blob, name, view = '') {
    try {
      const id = tabId(true);
      const now = Date.now();
      await request('readwrite', store => {
        const all = store.openCursor();
        all.onsuccess = () => {
          const cursor = all.result;
          if (!cursor) return;
          if (cursor.key !== id && !(now - cursor.value.time < KEEP_MS)) cursor.delete();
          cursor.continue();
        };
        return store.put({ blob, name: name || 'image', view, time: now }, id);
      });
    } catch {}
  }

  // The image this tab stored last, as a File with its view in `sourceView`,
  // or null.
  async function load() {
    try {
      const id = tabId(false);
      if (!id) return null;
      const record = await request('readonly', store => store.get(id));
      if (!record || !(record.blob instanceof Blob)) return null;
      const file = new File([record.blob], record.name, { type: record.blob.type });
      file.sourceView = typeof record.view === 'string' ? record.view : '';
      return file;
    } catch {
      return null;
    }
  }

  return { save, load };
})();
