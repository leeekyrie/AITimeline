/**
 * Background Service Worker
 * 
 * 职责：
 * 1. Google Drive 云同步（OAuth2 认证 + 文件读写）
 * 2. 处理需要绕过 CORS 限制的请求（图片获取等）
 */

// ============================================
// Google Drive 同步服务
// ============================================

const GDRIVE_FOLDER_NAME = 'AI Chat Backup';
const GDRIVE_DATA_FILE = 'ait-backup.json';
const GDRIVE_API = 'https://www.googleapis.com';
const ARCHIVE_ROOT_SEGMENTS = [];
const ARCHIVE_PLATFORMS = ['chatgpt', 'doubao', 'kimi'];
const ARCHIVE_INDEX_FILE = 'archive-index.json';

function archiveDriveLog(...args) {
    console.log('[ArchiveDrive]', ...args);
}

function archiveDriveError(...args) {
    console.error('[ArchiveDrive]', ...args);
}

/**
 * 获取 OAuth2 Access Token
 * 使用 chrome.identity.getAuthToken（需要扩展已发布到 Chrome Web Store）
 * Chrome 自动管理 token 的缓存和刷新
 */
async function getAuthToken(interactive = true) {
    const result = await chrome.identity.getAuthToken({ interactive });
    if (!result.token) {
        throw new Error('Not authenticated');
    }
    return result.token;
}

/**
 * 撤销 Token 并登出
 */
async function revokeToken() {
    try {
        const result = await chrome.identity.getAuthToken({ interactive: false });
        if (result.token) {
            // 从 Google 服务端撤销
            await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${result.token}`);
            // 从 Chrome 本地缓存中移除
            await chrome.identity.removeCachedAuthToken({ token: result.token });
        }
    } catch {}
}

/**
 * 查找 Google Drive 中的文件/文件夹
 * @param {string} token - Access Token
 * @param {string} name - 文件名
 * @param {string} mimeType - MIME 类型（可选，用于区分文件和文件夹）
 * @param {string} parentId - 父文件夹 ID（可选）
 * @returns {string|null} 文件 ID
 */
async function findFile(token, name, mimeType = null, parentId = null) {
    let query = `name='${name}' and trashed=false`;
    if (mimeType) query += ` and mimeType='${mimeType}'`;
    if (parentId) query += ` and '${parentId}' in parents`;
    
    const url = `${GDRIVE_API}/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`;
    const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!resp.ok) throw new Error(`Find file failed: ${resp.status}`);
    
    const data = await resp.json();
    return data.files?.[0]?.id || null;
}

async function listFiles(token, parentId, mimeType = null) {
    let query = `'${parentId}' in parents and trashed=false`;
    if (mimeType) query += ` and mimeType='${mimeType}'`;

    const url = `${GDRIVE_API}/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,createdTime,modifiedTime)`;
    const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
    });

    if (!resp.ok) throw new Error(`List files failed: ${resp.status}`);
    const data = await resp.json();
    return Array.isArray(data.files) ? data.files : [];
}

/**
 * 确保备份文件夹存在
 * @returns {string} 文件夹 ID
 */
async function ensureFolder(token) {
    // 先查找
    const folderId = await findFile(token, GDRIVE_FOLDER_NAME, 'application/vnd.google-apps.folder');
    if (folderId) return folderId;
    
    // 不存在，创建
    const resp = await fetch(`${GDRIVE_API}/drive/v3/files`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            name: GDRIVE_FOLDER_NAME,
            mimeType: 'application/vnd.google-apps.folder'
        })
    });
    
    if (!resp.ok) throw new Error(`Create folder failed: ${resp.status}`);
    
    const folder = await resp.json();
    return folder.id;
}

async function ensureChildFolder(token, parentId, name) {
    const existingId = await findFile(token, name, 'application/vnd.google-apps.folder', parentId);
    if (existingId) return existingId;

    const resp = await fetch(`${GDRIVE_API}/drive/v3/files`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId]
        })
    });

    if (!resp.ok) throw new Error(`Create child folder failed: ${resp.status}`);
    const folder = await resp.json();
    return folder.id;
}

async function ensureFolderPath(token, segments) {
    let currentId = await ensureFolder(token);
    for (const segment of segments) {
        currentId = await ensureChildFolder(token, currentId, segment);
    }
    return currentId;
}

function buildMultipartBody(metadata, content, contentType) {
    const boundary = `ait_boundary_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const delimiter = `--${boundary}`;
    const closeDelimiter = `--${boundary}--`;
    const bodyParts = [
        delimiter,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify(metadata),
        delimiter,
        `Content-Type: ${contentType}`,
        '',
        content,
        closeDelimiter
    ];

    return {
        boundary,
        body: bodyParts.join('\r\n')
    };
}

/**
 * 上传数据到 Google Drive
 * 使用 multipart upload（元数据 + 内容一起上传）
 */
async function uploadToDrive(token, data) {
    const folderId = await ensureFolder(token);
    const fileId = await findFile(token, GDRIVE_DATA_FILE, null, folderId);
    
    // 构建 multipart body
    const boundary = 'ait_boundary_' + Date.now();
    const metadata = {
        name: GDRIVE_DATA_FILE,
        mimeType: 'application/json',
        ...(!fileId && { parents: [folderId] }) // 新建时指定父文件夹
    };
    
    const body = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify(metadata),
        `--${boundary}`,
        'Content-Type: application/json',
        '',
        JSON.stringify(data),
        `--${boundary}--`
    ].join('\r\n');
    
    // 更新已有文件 or 创建新文件
    const url = fileId
        ? `${GDRIVE_API}/upload/drive/v3/files/${fileId}?uploadType=multipart`
        : `${GDRIVE_API}/upload/drive/v3/files?uploadType=multipart`;
    
    const resp = await fetch(url, {
        method: fileId ? 'PATCH' : 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: body
    });
    
    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Upload failed: ${resp.status} ${errText}`);
    }
    
    return await resp.json();
}

async function uploadJsonToFolder(token, parentId, fileName, data) {
    const existingId = await findFile(token, fileName, null, parentId);
    const metadata = {
        name: fileName,
        mimeType: 'application/json',
        ...(!existingId && { parents: [parentId] })
    };
    const { boundary, body } = buildMultipartBody(metadata, JSON.stringify(data), 'application/json');
    const url = existingId
        ? `${GDRIVE_API}/upload/drive/v3/files/${existingId}?uploadType=multipart`
        : `${GDRIVE_API}/upload/drive/v3/files?uploadType=multipart`;

    const resp = await fetch(url, {
        method: existingId ? 'PATCH' : 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body
    });

    if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`Upload JSON failed: ${resp.status} ${errorText}`);
    }

    return resp.json();
}

async function uploadTextToFolder(token, parentId, fileName, content, mimeType = 'text/markdown;charset=utf-8') {
    const existingId = await findFile(token, fileName, null, parentId);
    const metadata = {
        name: fileName,
        mimeType,
        ...(!existingId && { parents: [parentId] })
    };
    const { boundary, body } = buildMultipartBody(metadata, content, mimeType);
    const url = existingId
        ? `${GDRIVE_API}/upload/drive/v3/files/${existingId}?uploadType=multipart`
        : `${GDRIVE_API}/upload/drive/v3/files?uploadType=multipart`;

    const resp = await fetch(url, {
        method: existingId ? 'PATCH' : 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body
    });

    if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`Upload text failed: ${resp.status} ${errorText}`);
    }

    return resp.json();
}

async function dataUrlToBlob(dataUrl) {
    const response = await fetch(dataUrl);
    return response.blob();
}

async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read blob'));
        reader.readAsDataURL(blob);
    });
}

async function uploadDataUrlToFolder(token, parentId, fileName, mimeType, dataUrl) {
    const existingId = await findFile(token, fileName, null, parentId);
    const metadata = {
        name: fileName,
        mimeType: mimeType || 'application/octet-stream',
        ...(!existingId && { parents: [parentId] })
    };
    const blob = await dataUrlToBlob(dataUrl);
    const boundary = `ait_binary_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const body = new Blob([
        `--${boundary}\r\n`,
        'Content-Type: application/json; charset=UTF-8\r\n\r\n',
        JSON.stringify(metadata),
        `\r\n--${boundary}\r\n`,
        `Content-Type: ${mimeType || blob.type || 'application/octet-stream'}\r\n\r\n`,
        blob,
        `\r\n--${boundary}--`
    ]);

    const url = existingId
        ? `${GDRIVE_API}/upload/drive/v3/files/${existingId}?uploadType=multipart`
        : `${GDRIVE_API}/upload/drive/v3/files?uploadType=multipart`;

    const resp = await fetch(url, {
        method: existingId ? 'PATCH' : 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body
    });

    if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`Upload asset failed: ${resp.status} ${errorText}`);
    }

    return resp.json();
}

/**
 * 从 Google Drive 下载数据
 */
async function downloadFromDrive(token) {
    const folderId = await findFile(token, GDRIVE_FOLDER_NAME, 'application/vnd.google-apps.folder');
    if (!folderId) return null; // 文件夹不存在，说明从未上传过
    
    const fileId = await findFile(token, GDRIVE_DATA_FILE, null, folderId);
    if (!fileId) return null; // 文件不存在
    
    const resp = await fetch(`${GDRIVE_API}/drive/v3/files/${fileId}?alt=media`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    
    return await resp.json();
}

async function downloadJsonFile(token, fileId) {
    const resp = await fetch(`${GDRIVE_API}/drive/v3/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` }
    });

    if (!resp.ok) {
        throw new Error(`Download JSON failed: ${resp.status}`);
    }

    return resp.json();
}

async function downloadTextFile(token, fileId) {
    const resp = await fetch(`${GDRIVE_API}/drive/v3/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` }
    });

    if (!resp.ok) {
        throw new Error(`Download text failed: ${resp.status}`);
    }

    return resp.text();
}

async function downloadAssetAsDataUrl(token, fileId) {
    const resp = await fetch(`${GDRIVE_API}/drive/v3/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` }
    });

    if (!resp.ok) {
        throw new Error(`Download asset failed: ${resp.status}`);
    }

    const blob = await resp.blob();
    return blobToDataUrl(blob);
}

async function uploadArchiveBatch(token, payload) {
    archiveDriveLog('uploadArchiveBatch:start', {
        platform: payload.platform,
        batchId: payload.batchId,
        conversations: payload.conversations?.length || 0,
        assets: payload.assets?.length || 0
    });
    const platformId = payload.platform;
    const batchId = payload.batchId;
    const batchFolderId = await ensureFolderPath(token, [...ARCHIVE_FOLDER_SEGMENTS, platformId, batchId]);
    const conversationsFolderId = await ensureChildFolder(token, batchFolderId, 'conversations');
    const assetsFolderId = await ensureChildFolder(token, batchFolderId, 'assets');

    for (const conversation of payload.conversations || []) {
        await uploadJsonToFolder(token, conversationsFolderId, conversation.fileName, conversation.data);
    }

    for (const asset of payload.assets || []) {
        const archiveFolderId = await ensureChildFolder(token, assetsFolderId, asset.archiveId);
        await uploadDataUrlToFolder(token, archiveFolderId, asset.fileName, asset.mimeType, asset.dataUrl);
    }

    await uploadJsonToFolder(token, batchFolderId, 'manifest.json', payload.manifest);
    archiveDriveLog('uploadArchiveBatch:done', {
        platform: payload.platform,
        batchId: payload.batchId
    });
}

async function initArchiveBatch(token, payload) {
    archiveDriveLog('initArchiveBatch', payload);
    const rootFolderId = await ensureFolderPath(token, ARCHIVE_ROOT_SEGMENTS);
    const platformFolderId = await ensureChildFolder(token, rootFolderId, payload.platform);
    await ensureChildFolder(token, platformFolderId, 'conversations');
    await ensureChildFolder(token, platformFolderId, 'assets');
    return { rootFolderId: platformFolderId };
}

async function uploadArchiveItem(token, payload) {
    archiveDriveLog('uploadArchiveItem:start', {
        platform: payload.platform,
        batchId: payload.batchId,
        archiveId: payload.conversationMeta?.archiveId,
        markdownDocuments: payload.markdownDocuments?.length || 0,
        assets: payload.assets?.length || 0
    });
    const rootFolderId = await ensureFolderPath(token, ARCHIVE_ROOT_SEGMENTS);
    const platformFolderId = await ensureChildFolder(token, rootFolderId, payload.platform);
    const conversationsFolderId = await ensureChildFolder(token, platformFolderId, 'conversations');
    const assetsFolderId = await ensureChildFolder(token, platformFolderId, 'assets');

    for (const doc of payload.markdownDocuments || []) {
        await uploadTextToFolder(token, conversationsFolderId, doc.fileName, doc.content, 'text/markdown;charset=utf-8');
    }

    for (const asset of payload.assets || []) {
        const archiveFolderId = await ensureChildFolder(token, assetsFolderId, asset.archiveId);
        await uploadDataUrlToFolder(token, archiveFolderId, asset.fileName, asset.mimeType, asset.dataUrl);
    }

    const existingIndexId = await findFile(token, ARCHIVE_INDEX_FILE, null, platformFolderId);
    let indexPayload = { items: [] };
    if (existingIndexId) {
        try {
            indexPayload = await downloadJsonFile(token, existingIndexId);
        } catch (error) {
            archiveDriveError('uploadArchiveItem:indexReadFailed', error);
        }
    }
    const items = Array.isArray(indexPayload.items) ? indexPayload.items : [];
    const nextItem = {
        archiveId: payload.conversationMeta?.archiveId || '',
        sourceConversationId: payload.conversationMeta?.sourceConversationId || '',
        title: payload.conversationMeta?.title || '',
        platform: payload.platform || '',
        updatedAt: payload.conversationMeta?.updatedAt || '',
        markdownFiles: (payload.markdownDocuments || []).map((doc) => doc.fileName),
        modifiedAt: new Date().toISOString()
    };
    const filteredItems = items.filter((item) => item.archiveId !== nextItem.archiveId);
    filteredItems.push(nextItem);
    await uploadJsonToFolder(token, platformFolderId, ARCHIVE_INDEX_FILE, { items: filteredItems });
    archiveDriveLog('uploadArchiveItem:done', {
        archiveId: payload.conversationMeta?.archiveId
    });
}

async function finalizeArchiveBatch(token, payload) {
    archiveDriveLog('finalizeArchiveBatch:start', {
        platform: payload.platform,
        batchId: payload.batchId,
        conversations: payload.manifest?.conversationCount || 0
    });
    const rootFolderId = await ensureFolderPath(token, ARCHIVE_ROOT_SEGMENTS);
    const platformFolderId = await ensureChildFolder(token, rootFolderId, payload.platform);
    await uploadJsonToFolder(token, platformFolderId, 'last-export-manifest.json', payload.manifest);
    archiveDriveLog('finalizeArchiveBatch:done', {
        platform: payload.platform,
        batchId: payload.batchId
    });
}

async function listArchiveExports(token, platform = null) {
    const rootFolderId = await ensureFolderPath(token, ARCHIVE_ROOT_SEGMENTS);
    const targetFolderId = platform
        ? await ensureChildFolder(token, rootFolderId, platform)
        : rootFolderId;

    const indexFileId = await findFile(token, ARCHIVE_INDEX_FILE, null, targetFolderId);
    if (indexFileId) {
        try {
            const indexPayload = await downloadJsonFile(token, indexFileId);
            return (Array.isArray(indexPayload?.items) ? indexPayload.items : []).map((item) => ({
                id: item.archiveId || item.sourceConversationId || item.title || '',
                archiveId: item.archiveId || '',
                sourceConversationId: item.sourceConversationId || '',
                title: item.title || '',
                name: Array.isArray(item.markdownFiles) && item.markdownFiles.length ? item.markdownFiles[0] : '',
                markdownFiles: Array.isArray(item.markdownFiles) ? item.markdownFiles : [],
                sourceUpdatedAt: item.updatedAt || '',
                modifiedTime: item.modifiedAt || ''
            }));
        } catch (error) {
            archiveDriveError('listArchiveExports:indexReadFailed', error);
        }
    }

    const conversationsFolderId = await ensureChildFolder(token, targetFolderId, 'conversations');
    const files = await listFiles(token, conversationsFolderId);
    return files
        .filter((file) => file.mimeType !== 'application/vnd.google-apps.folder')
        .map((file) => ({
            id: file.id,
            archiveId: '',
            sourceConversationId: '',
            title: '',
            name: file.name,
            markdownFiles: [file.name],
            sourceUpdatedAt: '',
            modifiedTime: file.modifiedTime || file.createdTime || ''
        }));
}

async function getLatestBatchFolders(token, preferredPlatform = null) {
    archiveDriveLog('getLatestBatchFolders:start', { preferredPlatform });
    const rootId = await ensureFolderPath(token, ARCHIVE_ROOT_SEGMENTS);
    const platformIds = preferredPlatform ? [preferredPlatform] : ARCHIVE_PLATFORMS;
    const results = [];

    for (const platformId of platformIds) {
        const platformFolderId = await findFile(token, platformId, 'application/vnd.google-apps.folder', rootId);
        if (!platformFolderId) continue;
        const folders = await listFiles(token, platformFolderId, 'application/vnd.google-apps.folder');
        if (!folders.length) continue;
        folders.sort((a, b) => new Date(b.createdTime).getTime() - new Date(a.createdTime).getTime());
        results.push({ platformId, folder: folders[0] });
    }

    return results;
}

async function downloadArchiveBatch(token, platformId, batchFolder) {
    archiveDriveLog('downloadArchiveBatch:start', {
        platformId,
        batchFolder: batchFolder?.name
    });
    const batchFolderId = batchFolder.id;
    const manifestId = await findFile(token, 'manifest.json', null, batchFolderId);
    if (!manifestId) {
        throw new Error(`Missing manifest for ${platformId}/${batchFolder.name}`);
    }

    const manifest = await downloadJsonFile(token, manifestId);
    const conversationsFolderId = await findFile(token, 'conversations', 'application/vnd.google-apps.folder', batchFolderId);
    const assetsFolderId = await findFile(token, 'assets', 'application/vnd.google-apps.folder', batchFolderId);

    if (!conversationsFolderId) {
        throw new Error(`Missing conversations folder for ${platformId}/${batchFolder.name}`);
    }

    const conversations = [];
    for (const meta of manifest.conversations || []) {
        const markdownDocuments = [];
        for (const fileName of meta.markdownFiles || []) {
            const documentFileId = await findFile(token, fileName, null, conversationsFolderId);
            if (!documentFileId) continue;
            markdownDocuments.push({
                fileName,
                content: await downloadTextFile(token, documentFileId)
            });
        }

        const conversation = {
            archiveId: meta.archiveId,
            platform: platformId,
            sourceConversationId: meta.sourceConversationId,
            title: meta.title,
            sourceUrl: meta.sourceUrl || '',
            createdAt: meta.createdAt || '',
            updatedAt: meta.updatedAt || '',
            messages: [],
            markdownDocuments,
            assets: []
        };

        if (assetsFolderId) {
            const archiveAssetsFolderId = await findFile(token, conversation.archiveId, 'application/vnd.google-apps.folder', assetsFolderId);
            if (archiveAssetsFolderId) {
                const assetFiles = await listFiles(token, archiveAssetsFolderId);
                for (const assetFile of assetFiles) {
                    if (assetFile.mimeType === 'application/vnd.google-apps.folder') continue;
                    const asset = {
                        assetId: `${meta.archiveId}:${assetFile.name}`,
                        archiveId: meta.archiveId,
                        filename: assetFile.name,
                        kind: 'file',
                        mimeType: assetFile.mimeType || 'application/octet-stream',
                        relativePath: `../assets/${meta.archiveId}/${assetFile.name}`,
                        downloadStatus: 'ready',
                        errorReason: ''
                    };
                    try {
                        asset.dataUrl = await downloadAssetAsDataUrl(token, assetFile.id);
                    } catch (error) {
                        asset.downloadStatus = 'failed';
                        asset.errorReason = error.message || '下载资源失败';
                    }
                    conversation.assets.push(asset);
                }
            }
        }

        conversations.push(conversation);
    }

    return {
        batchId: manifest.batchId || batchFolder.name,
        platform: platformId,
        manifest,
        conversations
    };
}

// ============================================
// 消息处理
// ============================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    
    // --- Google Drive 同步 ---
    
    // 上传到 Google Drive（未登录时自动触发登录）
    if (request.type === 'GDRIVE_UPLOAD') {
        (async () => {
            try {
                const token = await getAuthToken(true);
                await uploadToDrive(token, request.data);
                sendResponse({ success: true });
            } catch (e) {
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }
    
    // 从 Google Drive 下载（未登录时自动触发登录）
    if (request.type === 'GDRIVE_DOWNLOAD') {
        (async () => {
            try {
                const token = await getAuthToken(true);
                const data = await downloadFromDrive(token);
                sendResponse({ success: true, data });
            } catch (e) {
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }

    if (request.type === 'ARCHIVE_DRIVE_EXPORT_START') {
        (async () => {
            try {
                archiveDriveLog('message:ARCHIVE_DRIVE_EXPORT_START');
                const token = await getAuthToken(true);
                await uploadArchiveBatch(token, request.payload);
                sendResponse({ success: true });
            } catch (e) {
                archiveDriveError('message:ARCHIVE_DRIVE_EXPORT_START:error', e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }

    if (request.type === 'ARCHIVE_DRIVE_INIT_BATCH') {
        (async () => {
            try {
                archiveDriveLog('message:ARCHIVE_DRIVE_INIT_BATCH', request.payload);
                const token = await getAuthToken(true);
                await initArchiveBatch(token, request.payload);
                sendResponse({ success: true });
            } catch (e) {
                archiveDriveError('message:ARCHIVE_DRIVE_INIT_BATCH:error', e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }

    if (request.type === 'ARCHIVE_DRIVE_UPLOAD_ITEM') {
        (async () => {
            try {
                archiveDriveLog('message:ARCHIVE_DRIVE_UPLOAD_ITEM', {
                    archiveId: request.payload?.conversationMeta?.archiveId,
                    batchId: request.payload?.batchId
                });
                const token = await getAuthToken(true);
                await uploadArchiveItem(token, request.payload);
                sendResponse({ success: true });
            } catch (e) {
                archiveDriveError('message:ARCHIVE_DRIVE_UPLOAD_ITEM:error', e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }

    if (request.type === 'ARCHIVE_DRIVE_FINALIZE_BATCH') {
        (async () => {
            try {
                archiveDriveLog('message:ARCHIVE_DRIVE_FINALIZE_BATCH', {
                    batchId: request.payload?.batchId,
                    platform: request.payload?.platform
                });
                const token = await getAuthToken(true);
                await finalizeArchiveBatch(token, request.payload);
                sendResponse({ success: true });
            } catch (e) {
                archiveDriveError('message:ARCHIVE_DRIVE_FINALIZE_BATCH:error', e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }

    if (request.type === 'ARCHIVE_DRIVE_LIST_EXPORTS') {
        (async () => {
            try {
                archiveDriveLog('message:ARCHIVE_DRIVE_LIST_EXPORTS', {
                    platform: request.platform || null
                });
                const token = await getAuthToken(false);
                const files = await listArchiveExports(token, request.platform || null);
                sendResponse({ success: true, authenticated: true, files });
            } catch (e) {
                archiveDriveError('message:ARCHIVE_DRIVE_LIST_EXPORTS:error', e);
                sendResponse({ success: true, authenticated: false, files: [], error: e.message });
            }
        })();
        return true;
    }

    if (request.type === 'ARCHIVE_DRIVE_IMPORT_PULL') {
        (async () => {
            try {
                archiveDriveLog('message:ARCHIVE_DRIVE_IMPORT_PULL', {
                    platform: request.platform || null
                });
                const token = await getAuthToken(true);
                const latestFolders = await getLatestBatchFolders(token, request.platform || null);
                const batches = [];

                for (const item of latestFolders) {
                    batches.push(await downloadArchiveBatch(token, item.platformId, item.folder));
                }

                sendResponse({ success: true, batches });
            } catch (e) {
                archiveDriveError('message:ARCHIVE_DRIVE_IMPORT_PULL:error', e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }
    
    // --- 旧功能：图片获取（CORS 绕过）---
    
    if (request.type === 'FETCH_IMAGE') {
        fetchImageAsBase64(request.url)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (request.type === 'FETCH_PAGE_PREVIEW_IMAGE') {
        fetchPagePreviewImageAsBase64(request.url)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }
});

/**
 * 获取图片并转换为 base64
 */
async function fetchImageAsBase64(url) {
    try {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const blob = await response.blob();
        
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                resolve({
                    success: true,
                    data: reader.result,
                    type: blob.type
                });
            };
            reader.onerror = () => reject(new Error('Failed to read blob'));
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[AI Chat Timeline Background] Fetch failed:', error);
        return { success: false, error: error.message };
    }
}

async function fetchPagePreviewImageAsBase64(url) {
    try {
        const response = await fetch(url, {
            credentials: 'omit',
            redirect: 'follow'
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const html = await response.text();
        const patterns = [
            /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
            /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i,
            /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
            /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["'][^>]*>/i,
            /<meta[^>]+name=["']twitter:image:src["'][^>]+content=["']([^"']+)["'][^>]*>/i,
            /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image:src["'][^>]*>/i
        ];

        let imageUrl = '';
        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match?.[1]) {
                imageUrl = match[1];
                break;
            }
        }

        if (!imageUrl) {
            throw new Error('No preview image found in page metadata');
        }

        const absoluteImageUrl = new URL(imageUrl, response.url || url).toString();
        return await fetchImageAsBase64(absoluteImageUrl);
    } catch (error) {
        console.error('[AI Chat Timeline Background] Fetch page preview failed:', error);
        return { success: false, error: error.message };
    }
}
