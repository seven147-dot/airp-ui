// Browser-local recovery; server metadata remains the normal shared save.
// IndexedDB avoids the small localStorage quota when avatars/history grow.
let databasePromise;
async function database() {
    if (!globalThis.indexedDB) return null;
    if (!databasePromise) {
        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open("AIRPRecovery", 1);
            request.onupgradeneeded = () => request.result.createObjectStore("backups");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error("本机恢复数据库被其他页面占用"));
        }).catch(error => { databasePromise = null; throw error; });
    }
    return databasePromise;
}

async function transaction(mode, key, value) {
    const db = await database();
    if (!db) return null;
    return new Promise((resolve, reject) => {
        const tx = db.transaction("backups", mode);
        const store = tx.objectStore("backups");
        const request = mode === "readonly" ? store.get(key) : store.put(value, key);
        tx.oncomplete = () => resolve(mode === "readonly" ? request.result ?? null : true);
        tx.onerror = () => reject(tx.error || request.error);
        tx.onabort = () => reject(tx.error || new Error("本机恢复写入中断"));
    });
}

export async function readBackup(key) {
    let stored = null, fallback = null;
    try { stored = await transaction("readonly", key); } catch { /* Try the compatible backup. */ }
    try { fallback = JSON.parse(localStorage.getItem(key) || "null"); } catch { /* Browser may deny localStorage. */ }
    if (!stored) return fallback;
    if (!fallback) return stored;
    return String(fallback.savedAt ?? "") > String(stored.savedAt ?? "") ? fallback : stored;
}

export async function writeBackup(key, value) {
    try {
        if (await transaction("readwrite", key, value)) {
            try { localStorage.removeItem(key); } catch { /* Database copy is durable. */ }
            return;
        }
    } catch { /* Fall back when private browsing or browser permissions deny IDB. */ }
    localStorage.setItem(key, JSON.stringify(value));
}
