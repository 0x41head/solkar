// IndexedDB cache of fetched wallet history so re-runs only fetch new transactions.

const DB = 'solkar';
const STORE = 'wallets';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @returns {{events: object[], seen: string[]} | null} */
export async function loadWallet(address) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(address);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function saveWallet(address, data) {
  try {
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, address);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // private mode or storage blocked: just skip caching
  }
}

export async function clearAll() {
  try {
    const db = await open();
    db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
  } catch {
    // nothing cached
  }
}
