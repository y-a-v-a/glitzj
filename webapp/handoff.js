'use strict';

// ── Hand-off ──────────────────────────────────────────────────────────────────
//
// Keeps the image you are working on while you move between the pages, so a
// result from one tool can be broken further by the next. The image is stored
// in this browser's IndexedDB and nowhere else. It belongs to the tab: a mark
// in sessionStorage ties the stored image to the tab that stored it, so a new
// tab starts empty and a second tab never picks up the image of the first.
//
// Everything here is a convenience. Where storage is unavailable (private
// windows, blocked site data) every call quietly does nothing.

const Handoff = (() => {
  const DB = 'glitzj', STORE = 'handoff', KEY = 'image', MARK = 'glitzj-handoff';

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
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
    }));
  }

  // Stores the image the page now works on. `blob` is the file as it was
  // opened, or a result that was fed back as the new source.
  async function save(blob, name) {
    try {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(MARK, id);
      await request('readwrite', store => store.put({ id, blob, name: name || 'image' }, KEY));
    } catch {}
  }

  // The image this tab stored last, as a File, or null.
  async function load() {
    try {
      const id = sessionStorage.getItem(MARK);
      if (!id) return null;
      const record = await request('readonly', store => store.get(KEY));
      if (!record || record.id !== id || !(record.blob instanceof Blob)) return null;
      return new File([record.blob], record.name, { type: record.blob.type });
    } catch {
      return null;
    }
  }

  return { save, load };
})();
