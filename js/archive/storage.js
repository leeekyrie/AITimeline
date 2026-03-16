/**
 * Archive Storage Manager
 *
 * Stores imported/exported conversation archives in IndexedDB so large
 * conversations and binary assets do not inflate chrome.storage.local.
 */

(function initArchiveStorage(global) {
    const DB_NAME = 'aitimeline-archives';
    const DB_VERSION = 1;
    const CONVERSATIONS_STORE = 'conversations';
    const ASSETS_STORE = 'assets';

    class ArchiveStorageManager {
        constructor() {
            this._dbPromise = null;
        }

        async _openDb() {
            if (this._dbPromise) return this._dbPromise;

            this._dbPromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);

                request.onupgradeneeded = () => {
                    const db = request.result;

                    if (!db.objectStoreNames.contains(CONVERSATIONS_STORE)) {
                        const store = db.createObjectStore(CONVERSATIONS_STORE, { keyPath: 'archiveId' });
                        store.createIndex('updatedAt', 'updatedAt', { unique: false });
                        store.createIndex('platform', 'platform', { unique: false });
                    }

                    if (!db.objectStoreNames.contains(ASSETS_STORE)) {
                        const store = db.createObjectStore(ASSETS_STORE, { keyPath: 'assetId' });
                        store.createIndex('archiveId', 'archiveId', { unique: false });
                    }
                };

                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error || new Error('Failed to open archive DB'));
            });

            return this._dbPromise;
        }

        async _withStore(storeName, mode, fn) {
            const db = await this._openDb();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, mode);
                const store = tx.objectStore(storeName);
                let settled = false;

                tx.oncomplete = () => {
                    if (!settled) resolve(undefined);
                };
                tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
                tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));

                Promise.resolve(fn(store, tx))
                    .then((result) => {
                        settled = true;
                        resolve(result);
                    })
                    .catch(reject);
            });
        }

        async saveBatch(batch) {
            if (!batch || !Array.isArray(batch.conversations) || batch.conversations.length === 0) {
                return { savedConversations: 0, savedAssets: 0 };
            }

            const db = await this._openDb();

            return new Promise((resolve, reject) => {
                const tx = db.transaction([CONVERSATIONS_STORE, ASSETS_STORE], 'readwrite');
                const conversationStore = tx.objectStore(CONVERSATIONS_STORE);
                const assetStore = tx.objectStore(ASSETS_STORE);
                const assetIndex = assetStore.index('archiveId');
                const now = Date.now();

                let savedConversations = 0;
                let savedAssets = 0;
                let pendingDeletes = 0;

                const finishDelete = () => {
                    pendingDeletes = Math.max(0, pendingDeletes - 1);
                };

                const queueAssetDelete = (archiveId) => {
                    pendingDeletes++;
                    const req = assetIndex.getAllKeys(archiveId);
                    req.onsuccess = () => {
                        const keys = Array.isArray(req.result) ? req.result : [];
                        keys.forEach((key) => assetStore.delete(key));
                        finishDelete();
                    };
                    req.onerror = () => finishDelete();
                };

                batch.conversations.forEach((conversation) => {
                    const archiveId = conversation.archiveId;
                    if (!archiveId) return;

                    queueAssetDelete(archiveId);

                    const assets = Array.isArray(conversation.assets) ? conversation.assets : [];
                    const previewText = (Array.isArray(conversation.messages) ? conversation.messages : [])
                        .map((message) => message?.text || '')
                        .join(' ')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .slice(0, 240);

                    const storedConversation = {
                        archiveId,
                        batchId: batch.batchId || conversation.batchId || '',
                        importedAt: now,
                        platform: conversation.platform || batch.platform || 'unknown',
                        sourceConversationId: conversation.sourceConversationId || archiveId,
                        title: conversation.title || 'Untitled',
                        sourceUrl: conversation.sourceUrl || '',
                        createdAt: conversation.createdAt || '',
                        updatedAt: conversation.updatedAt || conversation.createdAt || '',
                        messageCount: Array.isArray(conversation.messages) ? conversation.messages.length : 0,
                        assetCount: assets.length,
                        previewText,
                        messages: Array.isArray(conversation.messages) ? conversation.messages : [],
                        markdownDocuments: Array.isArray(conversation.markdownDocuments) ? conversation.markdownDocuments : [],
                        rawSnapshot: conversation.rawSnapshot || '',
                        assets: assets.map((asset) => ({
                            assetId: asset.assetId,
                            archiveId,
                            messageId: asset.messageId || '',
                            kind: asset.kind || 'file',
                            filename: asset.filename || 'asset',
                            mimeType: asset.mimeType || 'application/octet-stream',
                            relativePath: asset.relativePath || '',
                            sourceUrl: asset.sourceUrl || '',
                            size: asset.size || 0,
                            downloadStatus: asset.downloadStatus || 'ready',
                            errorReason: asset.errorReason || ''
                        }))
                    };

                    conversationStore.put(storedConversation);
                    savedConversations++;

                    assets.forEach((asset) => {
                        assetStore.put({
                            assetId: asset.assetId,
                            archiveId,
                            filename: asset.filename || 'asset',
                            mimeType: asset.mimeType || 'application/octet-stream',
                            kind: asset.kind || 'file',
                            relativePath: asset.relativePath || '',
                            dataUrl: asset.dataUrl || '',
                            textContent: asset.textContent || '',
                            sourceUrl: asset.sourceUrl || '',
                            downloadStatus: asset.downloadStatus || 'ready',
                            errorReason: asset.errorReason || ''
                        });
                        savedAssets++;
                    });
                });

                tx.oncomplete = () => {
                    if (pendingDeletes > 0) return;
                    resolve({ savedConversations, savedAssets });
                };
                tx.onerror = () => reject(tx.error || new Error('Failed to save archive batch'));
                tx.onabort = () => reject(tx.error || new Error('Archive batch transaction aborted'));
            });
        }

        async listConversations(filters = {}) {
            const db = await this._openDb();
            return new Promise((resolve) => {
                const tx = db.transaction(CONVERSATIONS_STORE, 'readonly');
                const store = tx.objectStore(CONVERSATIONS_STORE);
                const request = store.getAll();

                request.onsuccess = () => {
                    let items = Array.isArray(request.result) ? request.result : [];

                    if (filters.platform) {
                        items = items.filter((item) => item.platform === filters.platform);
                    }

                    if (filters.query) {
                        const query = String(filters.query).toLowerCase();
                        items = items.filter((item) => {
                            return (item.title || '').toLowerCase().includes(query)
                                || (item.previewText || '').toLowerCase().includes(query);
                        });
                    }

                    items.sort((a, b) => {
                        const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
                        const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
                        return tb - ta;
                    });

                    resolve(items);
                };

                request.onerror = () => resolve([]);
            });
        }

        async getConversation(archiveId) {
            if (!archiveId) return null;
            const db = await this._openDb();

            return new Promise((resolve) => {
                const tx = db.transaction([CONVERSATIONS_STORE, ASSETS_STORE], 'readonly');
                const conversationStore = tx.objectStore(CONVERSATIONS_STORE);
                const assetStore = tx.objectStore(ASSETS_STORE);
                const assetIndex = assetStore.index('archiveId');
                const conversationRequest = conversationStore.get(archiveId);
                const assetRequest = assetIndex.getAll(archiveId);

                tx.oncomplete = () => {
                    const conversation = conversationRequest.result;
                    if (!conversation) {
                        resolve(null);
                        return;
                    }

                    const assets = Array.isArray(assetRequest.result) ? assetRequest.result : [];
                    resolve({
                        ...conversation,
                        assets: (conversation.assets || []).map((assetMeta) => {
                            const asset = assets.find((candidate) => candidate.assetId === assetMeta.assetId);
                            return asset ? { ...assetMeta, ...asset } : assetMeta;
                        })
                    });
                };

                tx.onerror = () => resolve(null);
            });
        }

        async getStats() {
            const items = await this.listConversations();
            return {
                conversations: items.length,
                assets: items.reduce((sum, item) => sum + (item.assetCount || 0), 0),
                lastUpdatedAt: items[0]?.updatedAt || ''
            };
        }
    }

    global.ArchiveStorageManager = new ArchiveStorageManager();
})(window);
