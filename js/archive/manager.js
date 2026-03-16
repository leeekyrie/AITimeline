/**
 * Archive Export / Import Manager
 *
 * Archive tab now acts as an export workbench:
 * - list current site's conversations
 * - select/export sequentially
 * - update per-conversation status
 * - retry failed items
 *
 * Supported platforms:
 *   ChatGPT  — API-based (Bearer token + /backend-api/conversations)
 *   Doubao   — API+interceptor hybrid (/samantha/thread/detail), DOM fallback
 *   Kimi     — API-based (/api/chat/list, /api/chat/{id}/segment/scroll), DOM fallback
 *   Yuanbao  — API+interceptor hybrid (/api/user/agent/conversation/v1/detail), DOM fallback
 *
 * Anti-crawling strategy:
 *   NetworkInterceptor monkey-patches fetch/XHR to capture API responses the
 *   frontend already makes.  Direct API calls use credentials:'include' to share
 *   the page's cookies.  This avoids needing to replicate signatures (a_bogus)
 *   or tokens externally.  DomNavigationExporter remains as a last-resort fallback.
 *
 * External tool evaluation (2026-03):
 *   agent-browser — CLI for AI agents, no anti-detection, not suitable
 *   Patchright    — Playwright fork, bypasses Cloudflare/DataDome, best standalone option (Node.js)
 *   Camoufox      — Firefox-based engine-level stealth, Python only, best for max stealth
 *   Recommendation: browser extension approach is superior for authenticated export;
 *   Patchright is the recommended standalone backup tool if needed in the future.
 */

(function initArchiveManager(global) {
    const SUPPORTED_EXPORTERS = ['chatgpt', 'doubao', 'kimi', 'yuanbao'];
    const ARCHIVE_VERSION = '2.0';
    const PENDING_EXPORT_KEY = 'archivePendingDriveExport';

    const ArchiveUtils = {
        sanitizeFileName(input, fallback = 'untitled') {
            const clean = String(input || fallback)
                .replace(/[\\/:*?"<>|]/g, '_')
                .replace(/\s+/g, ' ')
                .trim();
            return clean.slice(0, 96) || fallback;
        },

        sanitizeMarkdownFileName(input, fallback = 'untitled') {
            const safe = this.sanitizeFileName(input, fallback).replace(/\s+/g, '_');
            return safe.endsWith('.md') ? safe : `${safe}.md`;
        },

        toIso(value) {
            if (!value) return '';
            if (typeof value === 'number') {
                const millis = value > 1e12 ? value : value * 1000;
                const date = new Date(millis);
                return Number.isNaN(date.getTime()) ? '' : date.toISOString();
            }
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? '' : date.toISOString();
        },

        absoluteUrl(url) {
            if (!url) return '';
            try {
                return new URL(url, location.href).toString();
            } catch {
                return url;
            }
        },

        createBatchId() {
            const date = new Date();
            return [
                date.getFullYear(),
                String(date.getMonth() + 1).padStart(2, '0'),
                String(date.getDate()).padStart(2, '0'),
                '-',
                String(date.getHours()).padStart(2, '0'),
                String(date.getMinutes()).padStart(2, '0'),
                String(date.getSeconds()).padStart(2, '0')
            ].join('');
        },

        simpleHash(input) {
            const text = typeof input === 'string' ? input : JSON.stringify(input);
            let hash = 2166136261;
            for (let i = 0; i < text.length; i++) {
                hash ^= text.charCodeAt(i);
                hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
            }
            return (hash >>> 0).toString(16);
        },

        sleep(ms) {
            return new Promise((resolve) => setTimeout(resolve, ms));
        },

        blobToDataUrl(blob) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = () => reject(new Error('Failed to read blob'));
                reader.readAsDataURL(blob);
            });
        },

        textToDataUrl(text, mimeType = 'text/plain;charset=utf-8') {
            return this.blobToDataUrl(new Blob([text || ''], { type: mimeType }));
        },

        dataUrlToUint8Array(dataUrl) {
            const parts = String(dataUrl || '').split(',');
            const base64 = parts[1] || '';
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index++) {
                bytes[index] = binary.charCodeAt(index);
            }
            return bytes;
        },

        async fetchAsDataUrl(url, options = {}) {
            const requestUrl = this.absoluteUrl(url);
            const shouldSkipCredentials = (() => {
                try {
                    const hostname = new URL(requestUrl).hostname;
                    return /(^|\.)p\d+-flow-imagex-sign\.byteimg\.com$/i.test(hostname)
                        || /(^|\.)kimi-web-img\.moonshot\.cn$/i.test(hostname)
                        || /(^|\.)lf-flow-web-cdn\.doubao\.com$/i.test(hostname)
                        || /(^|\.)cdn\.yuanbao\.tencent\.com$/i.test(hostname);
                } catch {
                    return false;
                }
            })();
            const runFetch = async (credentialsMode) => {
                const response = await fetch(requestUrl, {
                    credentials: credentialsMode,
                    ...options
                });
                if (!response.ok) {
                    return { success: false, error: `HTTP ${response.status}` };
                }
                const blob = await response.blob();
                return {
                    success: true,
                    dataUrl: await this.blobToDataUrl(blob),
                    mimeType: blob.type || response.headers.get('content-type') || 'application/octet-stream',
                    size: blob.size || 0
                };
            };

            try {
                if (!shouldSkipCredentials) {
                    return await runFetch('include');
                }
            } catch (error) {
                const message = error?.message || 'Fetch failed';
                console.warn('[ArchiveManager]', 'fetchAsDataUrl:retryWithoutCredentials', {
                    url: requestUrl,
                    error: message
                });
            }

            try {
                return await runFetch('omit');
            } catch (retryError) {
                const fallbackError = retryError?.message || 'Fetch failed';
                console.warn('[ArchiveManager]', 'fetchAsDataUrl:fallbackToBackground', {
                    url: requestUrl,
                    error: fallbackError
                });
                try {
                    const bgResponse = await chrome.runtime.sendMessage({
                        type: 'FETCH_IMAGE',
                        url: requestUrl
                    });
                    if (bgResponse?.success && bgResponse?.data) {
                        return {
                            success: true,
                            dataUrl: bgResponse.data,
                            mimeType: bgResponse.type || 'application/octet-stream',
                            size: 0
                        };
                    }
                    return {
                        success: false,
                        error: bgResponse?.error || fallbackError
                    };
                } catch (backgroundError) {
                    return {
                        success: false,
                        error: backgroundError.message || fallbackError
                    };
                }
            }
        },

        hasMeaningfulText(text) {
            return String(text || '').replace(/\s+/g, '').length > 0;
        },

        findContainerBySelectors(selectors = []) {
            for (const selector of selectors) {
                const node = document.querySelector(selector);
                if (node) return node;
            }
            return null;
        },

        findScrollableAncestor(node) {
            let current = node;
            while (current && current !== document.body) {
                const style = window.getComputedStyle(current);
                const overflowY = style?.overflowY || '';
                const looksScrollable = /(auto|scroll|overlay)/i.test(overflowY);
                const hasText = this.hasMeaningfulText(current.innerText || '');
                if (looksScrollable && hasText) {
                    return current;
                }
                current = current.parentElement;
            }
            return null;
        },

        findMainConversationFallback(platform) {
            const platformSelectors = {
                doubao: [
                    '[data-testid="message_text_content"]',
                    '[class*="message-text"]',
                    '[class*="chat-content"]',
                    '[class*="conversation"]',
                    'main'
                ],
                kimi: [
                    '.chat-content-item',
                    '.user-content',
                    '[class*="chat-content"]',
                    'main'
                ]
            };
            const seed = this.findContainerBySelectors(platformSelectors[platform] || ['main']);
            if (!seed) return null;
            return this.findScrollableAncestor(seed) || seed.closest('main, section, article, [class*="content"], [class*="conversation"]') || seed;
        },

        createSnapshotMessage(text, archiveId) {
            return {
                id: `${archiveId}-snapshot`,
                role: 'snapshot',
                createdAt: new Date().toISOString(),
                text,
                parts: []
            };
        },

        buildSnapshotConversation(base, text, html, assets) {
            return {
                ...base,
                messages: [this.createSnapshotMessage(text, base.archiveId)],
                assets,
                markdownDocuments: [],
                rawSnapshot: html
            };
        },

        buildContentMissingError(platform) {
            if (platform === 'doubao') {
                return new Error('未找到豆包会话内容，请等待页面消息加载完成后重试');
            }
            if (platform === 'kimi') {
                return new Error('未找到 Kimi 会话内容，请先打开该会话后重试');
            }
            return new Error('未找到当前会话内容，请先打开一个会话');
        },
    };
    
    Object.assign(ArchiveUtils, {
        getCurrentPlatformId() {
            try {
                const platform = getCurrentPlatform?.();
                return platform?.id || null;
            } catch {
                return null;
            }
        },

        buildFailure(stage, platform, conversationId, message, rawMessage = '') {
            return {
                stage,
                platform,
                conversationId,
                message,
                rawMessage: rawMessage || message
            };
        },

        summarizeFailures(failures) {
            if (!Array.isArray(failures) || failures.length === 0) return '';
            return failures.slice(0, 3).map((item) => item.message || item.rawMessage || '未知错误').join('；');
        }
    });

    const NetworkInterceptor = (() => {
        const capturedResponses = new Map();
        let listening = false;
        const matchers = [];
        const MSG_TYPE = '__ait_net_capture__';
        const FLUSH_TYPE = '__ait_net_flush__';

        function addMatcher(urlPattern, key) {
            matchers.push({ pattern: urlPattern, key });
        }

        function _onMessage(e) {
            if (!e.data || e.data.type !== MSG_TYPE) return;
            try {
                const { url, body, text } = e.data.payload || {};
                if (!url || !text || text.length < 3) return;
                for (const matcher of matchers) {
                    if (matcher.pattern.test(url)) {
                        const cacheKey = matcher.key(url, body || '');
                        capturedResponses.set(cacheKey, { text, url, time: Date.now() });
                        break;
                    }
                }
            } catch {}
        }

        function install() {
            if (listening) return;
            listening = true;
            window.addEventListener('message', _onMessage);
            try {
                window.postMessage({ type: FLUSH_TYPE }, '*');
            } catch {}
        }

        function get(key) {
            return capturedResponses.get(key) || null;
        }

        function getLatestByPrefix(prefix) {
            let best = null;
            for (const [k, v] of capturedResponses.entries()) {
                if (k.startsWith(prefix) && (!best || v.time > best.time)) {
                    best = v;
                }
            }
            return best;
        }

        function clear(key) {
            if (key) capturedResponses.delete(key);
            else capturedResponses.clear();
        }

        return { addMatcher, install, get, getLatestByPrefix, clear };
    })();

    class BaseArchiveExporter {
        constructor(platform, label) {
            this.platform = platform;
            this.label = label;
        }

        log(...args) {
            console.log('[ArchiveManager]', `${this.platform}:`, ...args);
        }

        _isThinkingMessage(msg) {
            const type = (msg.type || msg.content_type || msg.message_type || '').toLowerCase();
            const role = (msg.role || '').toLowerCase();
            const senderType = (msg.sender_type || '').toLowerCase();
            return /think|reason|reflect/i.test(type)
                || /think|reason|reflect/i.test(role)
                || /think|reason|reflect/i.test(senderType)
                || msg.is_thinking === true
                || msg.is_reasoning === true;
        }

        _isThinkingContentPart(part) {
            if (!part || typeof part !== 'object') return false;
            const type = (part.type || part.content_type || '').toLowerCase();
            return /think|reason|reflect/i.test(type);
        }

        createArchiveId(sourceConversationId) {
            return `${this.platform}-${sourceConversationId}`;
        }

        createAssetRelativePath(archiveId, fileName) {
            return `../assets/${encodeURIComponent(archiveId)}/${encodeURIComponent(fileName)}`;
        }

        createAssetBase(archiveId, messageId, kind, fileName, mimeType) {
            const safeFileName = ArchiveUtils.sanitizeFileName(fileName, `${kind}`);
            return {
                assetId: `${archiveId}:${safeFileName}:${Math.random().toString(16).slice(2, 8)}`,
                archiveId,
                messageId,
                kind,
                filename: safeFileName,
                mimeType: mimeType || 'application/octet-stream',
                relativePath: this.createAssetRelativePath(archiveId, safeFileName),
                dataUrl: '',
                textContent: '',
                sourceUrl: '',
                size: 0,
                downloadStatus: 'pending',
                errorReason: ''
            };
        }

        createMarkdownDocuments(conversation) {
            const visibleMessages = (conversation.messages || []).filter((message) => {
                return message.role === 'user' || message.role === 'assistant';
            });
            const segments = [];
            let currentSegment = null;

            visibleMessages.forEach((message) => {
                const role = message.role || 'unknown';
                if (role === 'user') {
                    if (currentSegment) segments.push(currentSegment);
                    currentSegment = [message];
                    return;
                }

                if (!currentSegment) currentSegment = [];
                currentSegment.push(message);
            });

            if (currentSegment && currentSegment.length > 0) {
                segments.push(currentSegment);
            }

            const shouldSplit = segments.length > 5;
            if (!shouldSplit) {
                return [{
                    fileName: ArchiveUtils.sanitizeMarkdownFileName(conversation.title, 'conversation'),
                    content: this.renderMarkdownDocument(conversation.title, conversation.sourceUrl, visibleMessages)
                }];
            }

            return segments.map((segment, index) => ({
                fileName: ArchiveUtils.sanitizeMarkdownFileName(`${conversation.title}_${String(index + 1).padStart(2, '0')}`, 'conversation'),
                content: this.renderMarkdownDocument(
                    `${conversation.title} · 第 ${index + 1} 轮`,
                    conversation.sourceUrl,
                    segment
                )
            }));
        }

        renderMarkdownDocument(title, sourceUrl, messages) {
            const lines = [`# ${title}`, ''];
            if (sourceUrl) {
                lines.push(`> 来源: ${sourceUrl}`, '');
            }

            messages
                .filter((message) => message.role === 'user' || message.role === 'assistant')
                .forEach((message) => {
                const roleTitle = message.role === 'user'
                    ? '用户'
                    : message.role === 'assistant'
                        ? this.label
                        : message.role;
                lines.push(`## ${roleTitle}`, '', message.text || '', '');
            });

            return lines.join('\n').trim() + '\n';
        }

        ensureUniqueAssetFilenames(conversation) {
            const assets = Array.isArray(conversation?.assets) ? conversation.assets : [];
            if (!assets.length) return conversation;

            const usedNames = new Set();
            const replacements = [];

            assets.forEach((asset) => {
                const originalName = asset.filename || `${asset.kind || 'asset'}`;
                const dotIndex = originalName.lastIndexOf('.');
                const baseName = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName;
                const extension = dotIndex > 0 ? originalName.slice(dotIndex) : '';
                let candidate = originalName;
                let suffix = 2;

                while (usedNames.has(candidate)) {
                    candidate = `${baseName}_${suffix}${extension}`;
                    suffix++;
                }

                usedNames.add(candidate);

                const previousRelativePath = asset.relativePath;
                asset.filename = candidate;
                asset.relativePath = this.createAssetRelativePath(conversation.archiveId, candidate);

                if (previousRelativePath && previousRelativePath !== asset.relativePath) {
                    replacements.push({
                        from: previousRelativePath,
                        to: asset.relativePath
                    });
                }
            });

            if (replacements.length > 0 && Array.isArray(conversation.messages)) {
                conversation.messages = conversation.messages.map((message) => {
                    if (!message?.text) return message;
                    let nextText = message.text;
                    replacements.forEach((replacement) => {
                        nextText = nextText.split(replacement.from).join(replacement.to);
                    });
                    return {
                        ...message,
                        text: nextText
                    };
                });
            }

            return conversation;
        }
    }

    class ChatGPTArchiveExporter extends BaseArchiveExporter {
        constructor() {
            super('chatgpt', 'ChatGPT');
            this.pageDelay = 240;
        }

        async getAccessToken() {
            const response = await fetch('/api/auth/session', { credentials: 'include' });
            const data = await response.json();
            if (!data?.accessToken) {
                throw new Error('未获取到 ChatGPT access token');
            }
            return data.accessToken;
        }

        async api(token, url) {
            const response = await fetch(url, {
                credentials: 'include',
                headers: {
                    Authorization: `Bearer ${token}`
                }
            });
            if (!response.ok) {
                throw new Error(`ChatGPT API ${response.status}`);
            }
            return response.json();
        }

        async listConversations() {
            const token = await this.getAccessToken();
            const items = [];
            let offset = 0;
            const limit = 28;

            for (let page = 0; page < 200; page++) {
                const data = await this.api(
                    token,
                    `/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated&is_archived=false`
                );
                const pageItems = Array.isArray(data?.items) ? data.items : [];
                items.push(...pageItems);
                if (pageItems.length < limit || items.length >= (data.total || Infinity)) break;
                offset += limit;
                await ArchiveUtils.sleep(this.pageDelay);
            }

            return items.map((item) => ({
                id: item.id,
                title: item.title || 'Untitled',
                url: `${location.origin}/c/${item.id}`,
                createdAt: ArchiveUtils.toIso(item.create_time),
                updatedAt: ArchiveUtils.toIso(item.update_time),
                sourceConversationId: item.id,
                platform: this.platform,
                isCurrent: location.href.includes(item.id)
            }));
        }

        collectFallbackAssetCandidates(value, path = 'message', results = []) {
            if (!value || typeof value !== 'object') {
                return results;
            }
            if (Array.isArray(value)) {
                value.forEach((item, index) => this.collectFallbackAssetCandidates(item, `${path}[${index}]`, results));
                return results;
            }

            const type = value.content_type || value.type || '';
            const candidate = {
                path,
                type,
                mimeType: value.mimeType || value.mime_type || '',
                assetPointer: value.asset_pointer || '',
                pageUrl: value.url || '',
                url: value.image_url || value.thumbnail_url || value.preview_url || value.asset_url || value.download_url || value.url || '',
                fileId: value.file_id || value.id || '',
                foveaId: value.fovea_id || '',
                canvasId: value.canvas_id || '',
                name: value.name || value.filename || value.title || ''
            };

            const looksLikeImageUrl = !!candidate.url && (
                /\.(png|jpe?g|gif|webp|bmp|svg)(?:[?#]|$)/i.test(candidate.url)
                || /[?&](format|fm|ext)=(png|jpe?g|gif|webp|bmp|svg)/i.test(candidate.url)
                || /\/(image|images|img|photo|picture|thumbnail|preview)\//i.test(candidate.url)
            );
            const looksLikeFileUrl = !!candidate.url && (
                /\.(pdf|docx?|xlsx?|csv|zip|txt|json|md)(?:[?#]|$)/i.test(candidate.url)
                || /\/download(?:[/?#]|$)/i.test(candidate.url)
            );
            const isReferencePath = /content_references|citations|search_result_groups/i.test(path);

            const looksUseful = candidate.assetPointer
                || candidate.fileId
                || candidate.foveaId
                || candidate.canvasId
                || looksLikeImageUrl
                || (!isReferencePath && looksLikeFileUrl)
                || /image|file|attachment|canvas|artifact/i.test(type);

            if (looksUseful) {
                results.push(candidate);
            }

            Object.entries(value).forEach(([key, child]) => {
                if (child && typeof child === 'object') {
                    this.collectFallbackAssetCandidates(child, `${path}.${key}`, results);
                }
            });
            return results;
        }

        appendAssetFromCandidate(candidate, archiveId, messageId, assets, textParts, assetIndex) {
            const type = candidate.type || '';
            const mimeType = candidate.mimeType || 'application/octet-stream';
            const looksLikeImageUrl = !!candidate.url && (
                /\.(png|jpe?g|gif|webp|bmp|svg)(?:[?#]|$)/i.test(candidate.url)
                || /[?&](format|fm|ext)=(png|jpe?g|gif|webp|bmp|svg)/i.test(candidate.url)
                || /\/(image|images|img|photo|picture|thumbnail|preview)\//i.test(candidate.url)
            );
            const looksLikeFileUrl = !!candidate.url && (
                /\.(pdf|docx?|xlsx?|csv|zip|txt|json|md)(?:[?#]|$)/i.test(candidate.url)
                || /\/download(?:[/?#]|$)/i.test(candidate.url)
            );
            const isReferencePath = /content_references|citations|search_result_groups/i.test(candidate.path || '');

            if (
                candidate.assetPointer
                || candidate.foveaId
                || /^image\//i.test(mimeType)
                || candidate.pageUrl && /content_references|citations|search_result_groups/i.test(candidate.path || '')
                || (candidate.url && (/image/i.test(type) || looksLikeImageUrl))
            ) {
                const safeMimeType = /^image\//i.test(mimeType) ? mimeType : 'image/png';
                const ext = safeMimeType.split('/')[1]?.split('+')[0] || 'png';
                const asset = this.createAssetBase(archiveId, messageId, 'image', `image_${assetIndex}.${ext}`, safeMimeType);
                if (candidate.assetPointer.startsWith('sediment://')) {
                    asset.sourceUrl = `sediment:${candidate.assetPointer.replace('sediment://', '')}`;
                } else if (candidate.assetPointer.startsWith('file-service://')) {
                    asset.sourceUrl = `/backend-api/files/${candidate.assetPointer.replace('file-service://', '')}/download`;
                } else if (candidate.foveaId) {
                    asset.sourceUrl = `sediment:${candidate.foveaId}`;
                } else if (candidate.url) {
                    asset.sourceUrl = candidate.url;
                } else if (candidate.pageUrl) {
                    asset.sourceUrl = `page-preview:${candidate.pageUrl}`;
                }
                if (asset.sourceUrl) {
                    assets.push(asset);
                    textParts.push(`![image](${asset.relativePath})`);
                    return true;
                }
            }

            if (candidate.canvasId || /canvas|artifact/i.test(type)) {
                const title = candidate.name || `canvas_${assetIndex}`;
                const asset = this.createAssetBase(
                    archiveId,
                    messageId,
                    'artifact',
                    `${ArchiveUtils.sanitizeFileName(title, 'canvas')}.html`,
                    'text/html;charset=utf-8'
                );
                asset.sourceUrl = `canvas:${candidate.canvasId || candidate.fileId || ''}`;
                assets.push(asset);
                textParts.push(`[Canvas: ${title}](${asset.relativePath})`);
                return true;
            }

            if (candidate.fileId || (!isReferencePath && candidate.url && ((/file|attachment/i.test(type)) || looksLikeFileUrl))) {
                const fileName = candidate.name || `file_${assetIndex}`;
                const asset = this.createAssetBase(
                    archiveId,
                    messageId,
                    'file',
                    fileName,
                    mimeType
                );
                asset.sourceUrl = candidate.fileId
                    ? `/backend-api/files/${candidate.fileId}/download`
                    : candidate.url;
                assets.push(asset);
                textParts.push(`[附件: ${fileName}](${asset.relativePath})`);
                return true;
            }

            return false;
        }

        extractParts(message, archiveId) {
            const parts = message?.content?.parts || [];
            const textParts = [];
            const assets = [];
            let assetIndex = 0;

            console.log('[ArchiveManager]', 'chatgpt:extractParts', {
                archiveId,
                messageId: String(message?.id || ''),
                role: message?.author?.role || '',
                parts: parts.map((part) => {
                    if (typeof part === 'string') {
                        return { type: 'string', length: part.length };
                    }
                    if (!part || typeof part !== 'object') {
                        return { type: typeof part };
                    }
                    return {
                        type: part.content_type || part.type || 'unknown',
                        keys: Object.keys(part).slice(0, 16),
                        mimeType: part.mimeType || part.mime_type || '',
                        hasAssetPointer: !!part.asset_pointer,
                        hasUrl: !!part.url,
                        hasFileId: !!part.file_id,
                        hasFoveaId: !!part.fovea_id,
                        hasCanvasId: !!part.canvas_id,
                        name: part.name || part.filename || ''
                    };
                })
            });

            const fallbackCandidates = this.collectFallbackAssetCandidates({
                content: message?.content || {},
                metadata: message?.metadata || {},
                attachments: message?.attachments || []
            });
            if (fallbackCandidates.length > 0) {
                console.log('[ArchiveManager]', 'chatgpt:fallbackCandidates', {
                    archiveId,
                    messageId: String(message?.id || ''),
                    role: message?.author?.role || '',
                    candidates: fallbackCandidates
                });
                fallbackCandidates.forEach((candidate) => {
                    if (this.appendAssetFromCandidate(candidate, archiveId, String(message.id || ''), assets, textParts, assetIndex)) {
                        assetIndex++;
                    }
                });
            }

            const pushText = (value) => {
                if (typeof value === 'string' && value.trim()) {
                    textParts.push(value.trim());
                }
            };

            for (const part of parts) {
                if (typeof part === 'string') {
                    pushText(part);
                    continue;
                }
                if (!part || typeof part !== 'object') continue;

                const type = part.content_type || part.type || '';

                if (type === 'image_asset_pointer' || type === 'image') {
                    const mimeType = part.mimeType || part.mime_type || 'image/png';
                    const ext = mimeType.split('/')[1]?.split('+')[0] || 'png';
                    const asset = this.createAssetBase(archiveId, String(message.id || ''), 'image', `image_${assetIndex}.${ext}`, mimeType);
                    const pointer = part.asset_pointer || '';

                    if (pointer.startsWith('sediment://')) {
                        asset.sourceUrl = `sediment:${pointer.replace('sediment://', '')}`;
                    } else if (pointer.startsWith('file-service://')) {
                        asset.sourceUrl = `/backend-api/files/${pointer.replace('file-service://', '')}/download`;
                    } else if (part.fovea_id) {
                        asset.sourceUrl = `sediment:${part.fovea_id}`;
                    } else if (part.url) {
                        asset.sourceUrl = part.url;
                    }

                    assets.push(asset);
                    pushText(`![image](${asset.relativePath})`);
                    assetIndex++;
                    continue;
                }

                if (type === 'file_attachment' || type === 'file_citation' || part.file_id) {
                    const fileName = part.name || part.filename || `file_${assetIndex}`;
                    const asset = this.createAssetBase(
                        archiveId,
                        String(message.id || ''),
                        'file',
                        fileName,
                        part.mimeType || part.mime_type || 'application/octet-stream'
                    );
                    const fileId = part.file_id || part.id || '';
                    if (fileId) {
                        asset.sourceUrl = `/backend-api/files/${fileId}/download`;
                    }
                    assets.push(asset);
                    pushText(`[附件: ${fileName}](${asset.relativePath})`);
                    assetIndex++;
                    continue;
                }

                if (type === 'canvas' || type === 'artifact' || part.canvas_id) {
                    const title = part.title || `canvas_${assetIndex}`;
                    const asset = this.createAssetBase(
                        archiveId,
                        String(message.id || ''),
                        'artifact',
                        `${ArchiveUtils.sanitizeFileName(title, 'canvas')}.html`,
                        'text/html;charset=utf-8'
                    );
                    asset.sourceUrl = `canvas:${part.canvas_id || part.id || ''}`;
                    assets.push(asset);
                    pushText(`[Canvas: ${title}](${asset.relativePath})`);
                    assetIndex++;
                    continue;
                }

                if (type === 'tether_quote' || type === 'code') {
                    continue;
                }

                if (type === 'tether_browsing_display' || type === 'browser_result') {
                    continue;
                }

                const appended = this.appendAssetFromCandidate(part, archiveId, String(message.id || ''), assets, textParts, assetIndex);
                if (appended) {
                    assetIndex++;
                    continue;
                }

                const nestedCandidates = this.collectFallbackAssetCandidates(part, `parts[${assetIndex}]`);
                if (nestedCandidates.length > 0) {
                    console.log('[ArchiveManager]', 'chatgpt:nestedPartCandidates', {
                        archiveId,
                        messageId: String(message?.id || ''),
                        role: message?.author?.role || '',
                        candidates: nestedCandidates
                    });
                    nestedCandidates.forEach((candidate) => {
                        if (this.appendAssetFromCandidate(candidate, archiveId, String(message.id || ''), assets, textParts, assetIndex)) {
                            assetIndex++;
                        }
                    });
                }
            }

            if (!assets.length && message?.author?.role === 'assistant') {
                console.log('[ArchiveManager]', 'chatgpt:messageShape', {
                    archiveId,
                    messageId: String(message?.id || ''),
                    contentType: message?.content?.content_type || '',
                    contentKeys: Object.keys(message?.content || {}).slice(0, 24),
                    metadataKeys: Object.keys(message?.metadata || {}).slice(0, 24),
                    attachmentCount: Array.isArray(message?.attachments) ? message.attachments.length : 0,
                    textPreview: typeof message?.content?.text === 'string'
                        ? message.content.text.slice(0, 200)
                        : ''
                });
            }

            return {
                text: textParts.join('\n\n').trim(),
                assets
            };
        }

        async fetchCanvasContent(token, canvasId) {
            try {
                const data = await this.api(token, `/backend-api/gizmos/canvas/${canvasId}`);
                return data.content || data.html || data.text || JSON.stringify(data, null, 2);
            } catch (error) {
                return `<!-- Canvas fetch failed: ${error.message} -->`;
            }
        }

        async fetchAsset(token, conversationId, asset) {
            try {
                if (asset.sourceUrl.startsWith('canvas:')) {
                    const content = await this.fetchCanvasContent(token, asset.sourceUrl.replace('canvas:', ''));
                    asset.textContent = content;
                    asset.dataUrl = await ArchiveUtils.textToDataUrl(content, asset.mimeType);
                    asset.size = content.length;
                    asset.downloadStatus = 'ready';
                    return null;
                }

                let targetUrl = asset.sourceUrl;
                if (targetUrl.startsWith('sediment:')) {
                    const fileId = targetUrl.replace('sediment:', '');
                    targetUrl = `/backend-api/files/download/${fileId}?conversation_id=${conversationId}&inline=false`;
                }
                if (targetUrl.startsWith('page-preview:')) {
                    const pageUrl = targetUrl.replace('page-preview:', '');
                    const previewResponse = await chrome.runtime.sendMessage({
                        type: 'FETCH_PAGE_PREVIEW_IMAGE',
                        url: pageUrl
                    });
                    if (!previewResponse?.success || !previewResponse?.data) {
                        throw new Error(previewResponse?.error || '页面封面图提取失败');
                    }
                    asset.dataUrl = previewResponse.data;
                    asset.mimeType = previewResponse.type || asset.mimeType;
                    asset.size = previewResponse.data.length || 0;
                    asset.downloadStatus = 'ready';
                    return null;
                }

                const response = await fetch(targetUrl, {
                    credentials: 'include',
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const contentType = response.headers.get('content-type') || '';
                if (contentType.includes('application/json')) {
                    const json = await response.json();
                    const redirectedUrl = json.download_url || json.url;
                    if (!redirectedUrl) throw new Error('Missing download URL');
                    const redirected = await ArchiveUtils.fetchAsDataUrl(redirectedUrl);
                    if (!redirected.success) throw new Error(redirected.error || '下载失败');
                    asset.dataUrl = redirected.dataUrl;
                    asset.mimeType = redirected.mimeType || asset.mimeType;
                    asset.size = redirected.size || 0;
                    asset.downloadStatus = 'ready';
                    return null;
                }

                const blob = await response.blob();
                asset.dataUrl = await ArchiveUtils.blobToDataUrl(blob);
                asset.mimeType = blob.type || contentType || asset.mimeType;
                asset.size = blob.size || 0;
                asset.downloadStatus = 'ready';
                return null;
            } catch (error) {
                asset.downloadStatus = 'failed';
                asset.errorReason = error.message || '下载失败';
                return ArchiveUtils.buildFailure(
                    'asset-download',
                    this.platform,
                    conversationId,
                    `资源下载失败：${asset.filename}`,
                    asset.errorReason
                );
            }
        }

        async exportConversation(item) {
            const token = await this.getAccessToken();
            const detail = await this.api(token, `/backend-api/conversation/${item.id}`);
            const mapping = detail?.mapping || {};
            const rootId = Object.keys(mapping).find((key) => !mapping[key]?.parent);
            const walked = [];
            const failures = [];

            const walk = (id) => {
                const node = mapping[id];
                if (!node) return;
                if (node.message?.author?.role && node.message.content) {
                    walked.push(node.message);
                }
                const children = Array.isArray(node.children) ? node.children : [];
                if (children[0]) walk(children[0]);
            };

            if (rootId) walk(rootId);

            const archiveId = this.createArchiveId(item.id);
            const messages = [];
            const assets = [];
            let lastAssistantMessage = null;

            walked.forEach((message, index) => {
                const role = message.author?.role || 'unknown';
                if (role === 'system') return;
                const extracted = this.extractParts(message, archiveId);
                assets.push(...extracted.assets);

                if (role === 'user' || role === 'assistant') {
                    const nextMessage = {
                        id: String(message.id || `${archiveId}-m-${index}`),
                        role,
                        createdAt: ArchiveUtils.toIso(message.create_time),
                        text: extracted.text || '',
                        parts: []
                    };
                    messages.push(nextMessage);
                    if (role === 'assistant') {
                        lastAssistantMessage = nextMessage;
                    }
                    return;
                }

                if (role === 'tool' && extracted.text) {
                    if (lastAssistantMessage) {
                        lastAssistantMessage.text = [lastAssistantMessage.text, extracted.text]
                            .filter(Boolean)
                            .join('\n\n')
                            .trim();
                    } else {
                        const syntheticAssistant = {
                            id: String(message.id || `${archiveId}-m-${index}`),
                            role: 'assistant',
                            createdAt: ArchiveUtils.toIso(message.create_time),
                            text: extracted.text,
                            parts: []
                        };
                        messages.push(syntheticAssistant);
                        lastAssistantMessage = syntheticAssistant;
                    }
                }
            });

            for (const asset of assets) {
                const failure = await this.fetchAsset(token, item.id, asset);
                if (failure) failures.push(failure);
            }

            const conversation = {
                archiveId,
                platform: this.platform,
                sourceConversationId: item.id,
                title: item.title || 'Untitled',
                sourceUrl: item.url,
                createdAt: item.createdAt || '',
                updatedAt: item.updatedAt || '',
                messages,
                assets,
                markdownDocuments: [],
                rawSnapshot: ''
            };
            this.ensureUniqueAssetFilenames(conversation);
            conversation.markdownDocuments = this.createMarkdownDocuments(conversation);

            return { conversation, failures };
        }
    }

    class DoubaoArchiveExporter extends BaseArchiveExporter {
        constructor() {
            super('doubao', '豆包');
            this.domFallback = null;
            this._setupInterceptor();
        }

        _setupInterceptor() {
            NetworkInterceptor.addMatcher(
                /\/samantha\/(thread|conversation)\/(detail|message|info|get)/i,
                (url) => `doubao:thread:${this._extractThreadIdFromUrl(url)}`
            );
            NetworkInterceptor.addMatcher(
                /\/samantha\/conversation\/list/i,
                () => 'doubao:conversation_list'
            );
            NetworkInterceptor.addMatcher(
                /\/alice\/message\/list/i,
                (url) => `doubao:thread:${this._extractThreadIdFromUrl(url)}`
            );
            NetworkInterceptor.install();
        }

        _extractThreadIdFromUrl(url) {
            try {
                const u = new URL(url, location.origin);
                return u.searchParams.get('thread_id')
                    || u.searchParams.get('conversation_id')
                    || u.searchParams.get('id')
                    || 'unknown';
            } catch {
                return 'unknown';
            }
        }

        _getDomFallback() {
            if (!this.domFallback) {
                this.domFallback = new DomNavigationExporter('doubao', '豆包');
            }
            return this.domFallback;
        }

        _extractConversationIdFromPath(pathname) {
            const match = (pathname || location.pathname).match(/\/chat\/(\d+)/);
            return match ? match[1] : null;
        }

        async listConversations() {
            const sidebarLinks = this._listFromSidebar();
            if (sidebarLinks.length > 0) return sidebarLinks;
            return this._getDomFallback().listConversations();
        }

        _listFromSidebar() {
            const pattern = /\/chat\/\d+(?:[/?#]|$)/i;
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            const dedup = new Map();

            anchors.forEach((anchor) => {
                const href = anchor.getAttribute('href') || '';
                if (!pattern.test(href)) return;
                const absoluteUrl = ArchiveUtils.absoluteUrl(href);
                const rawText = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
                const title = rawText || absoluteUrl.split('/').pop()?.split('?')[0] || '豆包会话';

                if (!dedup.has(absoluteUrl)) {
                    const convId = absoluteUrl.match(/\/chat\/(\d+)/)?.[1] || ArchiveUtils.simpleHash(absoluteUrl).slice(0, 12);
                    dedup.set(absoluteUrl, {
                        id: ArchiveUtils.simpleHash(absoluteUrl).slice(0, 12),
                        title,
                        url: absoluteUrl,
                        createdAt: '',
                        updatedAt: '',
                        sourceConversationId: convId,
                        platform: 'doubao',
                        isCurrent: location.href === absoluteUrl
                    });
                }
            });

            return Array.from(dedup.values());
        }

        async _fetchThreadDetail(threadId) {
            const cacheKey = `doubao:thread:${threadId}`;
            const cached = NetworkInterceptor.get(cacheKey);
            if (cached?.text) {
                try { return JSON.parse(cached.text); } catch {}
            }

            const latest = NetworkInterceptor.getLatestByPrefix('doubao:thread:');
            if (latest?.text) {
                try { return JSON.parse(latest.text); } catch {}
            }

            return null;
        }

        _parseThreadMessages(threadData, archiveId) {
            const messages = [];
            const messageList = threadData?.data?.messages
                || threadData?.messages
                || threadData?.data?.thread?.messages
                || [];

            if (!Array.isArray(messageList) || messageList.length === 0) return messages;

            messageList.forEach((msg, index) => {
                if (this._isThinkingMessage(msg)) return;

                const role = (msg.role === 'user' || msg.sender_type === 'user') ? 'user' : 'assistant';
                let text = '';

                if (typeof msg.content === 'string') {
                    text = msg.content;
                } else if (Array.isArray(msg.content)) {
                    text = msg.content
                        .filter((part) => {
                            if (this._isThinkingContentPart(part)) return false;
                            return typeof part === 'string' || part?.type === 'text';
                        })
                        .map((part) => typeof part === 'string' ? part : (part.text || ''))
                        .join('\n\n');
                } else if (msg.text) {
                    text = msg.text;
                }

                text = text.replace(/\n{3,}/g, '\n\n').trim();
                if (!text) return;

                messages.push({
                    id: String(msg.id || msg.message_id || `${archiveId}-m-${index}`),
                    role,
                    createdAt: ArchiveUtils.toIso(msg.create_time || msg.created_at || ''),
                    text,
                    parts: []
                });
            });

            return messages;
        }

        async exportConversation(item, options = {}) {
            const threadId = item.sourceConversationId || this._extractConversationIdFromPath(new URL(item.url, location.origin).pathname);
            const archiveId = this.createArchiveId(threadId || item.id);
            const failures = [];
            const needsNavigation = item.url && item.url !== location.href && !options.skipNavigation;

            if (needsNavigation) {
                await this._getDomFallback().navigateToConversation(item);
                await ArchiveUtils.sleep(1500);
            }

            if (threadId) {
                const threadData = await this._fetchThreadDetail(threadId);
                if (threadData) {
                    const messages = this._parseThreadMessages(threadData, archiveId);
                    if (messages.length > 0) {
                        const conversation = {
                            archiveId,
                            platform: this.platform,
                            sourceConversationId: threadId,
                            title: threadData?.data?.thread?.title || threadData?.data?.title || item.title || 'Untitled',
                            sourceUrl: item.url || location.href,
                            createdAt: ArchiveUtils.toIso(threadData?.data?.thread?.create_time || ''),
                            updatedAt: ArchiveUtils.toIso(threadData?.data?.thread?.update_time || '') || new Date().toISOString(),
                            messages,
                            assets: [],
                            markdownDocuments: [],
                            rawSnapshot: ''
                        };
                        this.ensureUniqueAssetFilenames(conversation);
                        conversation.markdownDocuments = this.createMarkdownDocuments(conversation);
                        return { conversation, failures };
                    }
                }
            }

            this.log('exportConversation:fallbackToDom', { threadId });
            return this._getDomFallback().exportConversation(item, { skipNavigation: true });
        }

        get usesPendingNavigationQueue() {
            return true;
        }
    }

    class KimiArchiveExporter extends BaseArchiveExporter {
        constructor() {
            super('kimi', 'Kimi');
            this.domFallback = null;
            this._setupInterceptor();
        }

        _setupInterceptor() {
            NetworkInterceptor.addMatcher(
                /\/api\/chat\/[a-z0-9]+$/i,
                (url) => {
                    const match = url.match(/\/api\/chat\/([a-z0-9]+)$/i);
                    return match ? `kimi:chat:${match[1]}` : 'kimi:chat:unknown';
                }
            );
            NetworkInterceptor.addMatcher(
                /\/api\/chat\/list/i,
                () => 'kimi:chat_list'
            );
            NetworkInterceptor.install();
        }

        _getDomFallback() {
            if (!this.domFallback) {
                this.domFallback = new DomNavigationExporter('kimi', 'Kimi');
            }
            return this.domFallback;
        }

        _getAuthToken() {
            try {
                const token = localStorage.getItem('access_token')
                    || localStorage.getItem('token')
                    || '';
                if (token) return token.replace(/^["']|["']$/g, '');
            } catch {}

            try {
                const cookies = document.cookie.split(';');
                for (const cookie of cookies) {
                    const [name, ...rest] = cookie.trim().split('=');
                    if (/access_token|token/i.test(name)) {
                        return decodeURIComponent(rest.join('='));
                    }
                }
            } catch {}

            return '';
        }

        async _apiRequest(url) {
            const headers = { 'Content-Type': 'application/json' };
            const token = this._getAuthToken();
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const response = await fetch(url, {
                credentials: 'include',
                headers
            });
            if (!response.ok) throw new Error(`Kimi API ${response.status}`);
            return response.json();
        }

        async listConversations() {
            try {
                const data = await this._apiRequest('/api/chat/list');
                const items = Array.isArray(data) ? data : (data?.items || data?.data || []);

                if (items.length > 0) {
                    return items.map((item) => ({
                        id: ArchiveUtils.simpleHash(item.id || item.chat_id || '').slice(0, 12),
                        title: item.name || item.title || 'Kimi 会话',
                        url: `${location.origin}/chat/${item.id || item.chat_id}`,
                        createdAt: ArchiveUtils.toIso(item.created_at || item.create_time || ''),
                        updatedAt: ArchiveUtils.toIso(item.updated_at || item.update_time || ''),
                        sourceConversationId: item.id || item.chat_id,
                        platform: 'kimi',
                        isCurrent: location.pathname.includes(item.id || item.chat_id || '__none__')
                    }));
                }
            } catch (err) {
                console.warn('[ArchiveManager]', 'kimi:listConversations:apiFailed', err.message);
            }

            return this._getDomFallback().listConversations();
        }

        async _fetchChatDetail(chatId) {
            const cacheKey = `kimi:chat:${chatId}`;
            const cached = NetworkInterceptor.get(cacheKey);
            if (cached?.text) {
                try { return JSON.parse(cached.text); } catch {}
            }

            try {
                return await this._apiRequest(`/api/chat/${chatId}`);
            } catch (err) {
                console.warn('[ArchiveManager]', 'kimi:fetchChatDetail:failed', err.message);
            }
            return null;
        }

        async _fetchSegments(chatId) {
            try {
                const data = await this._apiRequest(`/api/chat/${chatId}/segment/scroll?size=200`);
                return data?.items || data?.segments || (Array.isArray(data) ? data : []);
            } catch {
                return [];
            }
        }

        _parseMessages(chatDetail, segments, archiveId) {
            const messages = [];

            if (Array.isArray(segments) && segments.length > 0) {
                segments.forEach((seg, index) => {
                    if (this._isThinkingMessage(seg)) return;

                    const role = (seg.role === 'user' || seg.type === 'user') ? 'user' : 'assistant';
                    let text = '';
                    if (typeof seg.content === 'string') {
                        text = seg.content;
                    } else if (seg.text) {
                        text = seg.text;
                    } else if (Array.isArray(seg.parts)) {
                        text = seg.parts.filter((p) => {
                            if (this._isThinkingContentPart(p)) return false;
                            return typeof p === 'string' || p?.type === 'text';
                        })
                            .map((p) => typeof p === 'string' ? p : p.text || '')
                            .join('\n\n');
                    }

                    text = text.replace(/\n{3,}/g, '\n\n').trim();
                    if (!text) return;

                    messages.push({
                        id: String(seg.id || seg.segment_id || `${archiveId}-m-${index}`),
                        role,
                        createdAt: ArchiveUtils.toIso(seg.created_at || seg.create_time || ''),
                        text,
                        parts: []
                    });
                });
            }

            if (messages.length === 0 && chatDetail) {
                const msgList = chatDetail.messages || chatDetail.segments || [];
                msgList.forEach((msg, index) => {
                    if (this._isThinkingMessage(msg)) return;

                    const role = msg.role === 'user' ? 'user' : 'assistant';
                    const text = (typeof msg.content === 'string' ? msg.content : msg.text || '').replace(/\n{3,}/g, '\n\n').trim();
                    if (!text) return;
                    messages.push({
                        id: String(msg.id || `${archiveId}-m-${index}`),
                        role,
                        createdAt: ArchiveUtils.toIso(msg.created_at || ''),
                        text,
                        parts: []
                    });
                });
            }

            return messages;
        }

        async exportConversation(item, options = {}) {
            const chatId = item.sourceConversationId || location.pathname.match(/\/chat\/([^/]+)/)?.[1];
            const archiveId = this.createArchiveId(chatId || item.id);
            const failures = [];

            if (chatId) {
                const [chatDetail, segments] = await Promise.all([
                    this._fetchChatDetail(chatId),
                    this._fetchSegments(chatId)
                ]);

                const messages = this._parseMessages(chatDetail, segments, archiveId);

                if (messages.length > 0) {
                    const conversation = {
                        archiveId,
                        platform: this.platform,
                        sourceConversationId: chatId,
                        title: chatDetail?.name || chatDetail?.title || item.title || 'Untitled',
                        sourceUrl: item.url || location.href,
                        createdAt: ArchiveUtils.toIso(chatDetail?.created_at || chatDetail?.create_time || ''),
                        updatedAt: ArchiveUtils.toIso(chatDetail?.updated_at || chatDetail?.update_time || '') || new Date().toISOString(),
                        messages,
                        assets: [],
                        markdownDocuments: [],
                        rawSnapshot: ''
                    };
                    this.ensureUniqueAssetFilenames(conversation);
                    conversation.markdownDocuments = this.createMarkdownDocuments(conversation);
                    return { conversation, failures };
                }
            }

            this.log('exportConversation:fallbackToDom', { chatId });
            if (!options.skipNavigation && item.url && item.url !== location.href) {
                await this._getDomFallback().navigateToConversation(item);
                await ArchiveUtils.sleep(800);
            }
            return this._getDomFallback().exportConversation(item, { skipNavigation: true });
        }

        get usesPendingNavigationQueue() {
            return true;
        }
    }

    class YuanbaoArchiveExporter extends BaseArchiveExporter {
        constructor() {
            super('yuanbao', '元宝');
            this._setupInterceptor();
        }

        _setupInterceptor() {
            NetworkInterceptor.addMatcher(
                /\/api\/(?:user\/agent\/)?conversation\/(?:v?\d*\/?)?(detail)/i,
                (url, bodyStr) => {
                    let chatId = null;
                    try {
                        const u = new URL(url, location.origin);
                        chatId = u.searchParams.get('chatId')
                            || u.searchParams.get('id')
                            || u.searchParams.get('conversationId');
                    } catch {}
                    if (!chatId && bodyStr) {
                        try {
                            const body = typeof bodyStr === 'string' ? JSON.parse(bodyStr) : bodyStr;
                            chatId = body.chatId || body.id || body.conversationId;
                        } catch {}
                    }
                    if (!chatId) {
                        const pathMatch = location.pathname.match(/\/chat\/[^/]+\/([^/?#]+)/);
                        chatId = pathMatch?.[1];
                    }
                    return `yuanbao:detail:${chatId || 'latest'}`;
                }
            );
            NetworkInterceptor.addMatcher(
                /\/api\/(?:user\/agent\/)?conversation\/(?:v?\d*\/?)?(list|page|list_page|create)$/i,
                () => 'yuanbao:conversation_list'
            );
            NetworkInterceptor.install();
        }

        _extractConversationIdFromPath(pathname) {
            const segments = (pathname || location.pathname).split('/').filter(Boolean);
            if (segments.length >= 3 && segments[0] === 'chat') {
                return segments[segments.length - 1];
            }
            return null;
        }

        async listConversations() {
            const cachedItems = this._listFromInterceptorCache();
            if (cachedItems.length > 0) {
                this.log('listConversations:interceptorCache', { count: cachedItems.length });
                return cachedItems;
            }

            const apiItems = await this._listFromApi();
            if (apiItems.length > 0) {
                this.log('listConversations:api', { count: apiItems.length });
                return apiItems;
            }

            const convId = this._extractConversationIdFromPath();
            this.log('listConversations:currentOnly', { convId });
            return [{
                id: convId || ArchiveUtils.simpleHash(location.href).slice(0, 12),
                title: document.title || '元宝当前会话',
                url: location.href,
                createdAt: '',
                updatedAt: '',
                sourceConversationId: convId || location.href,
                platform: 'yuanbao',
                isCurrent: true
            }];
        }

        _normalizeApiItem(item) {
            const id = item.id || item.chatId || item.conversationId || '';
            if (!id) return null;
            const agentId = item.agentId || this._extractAgentIdFromPath() || 'naQivTmsDa';
            return {
                id: ArchiveUtils.simpleHash(id).slice(0, 12),
                title: item.sessionTitle || item.title || item.name || item.conversationTitle || item.summary || '元宝会话',
                url: `${location.origin}/chat/${agentId}/${id}`,
                createdAt: ArchiveUtils.toIso(item.createTime || item.firstRepliedAt || item.created_at || ''),
                updatedAt: ArchiveUtils.toIso(item.updateTime || item.lastRepliedAt || item.updated_at || ''),
                sourceConversationId: id,
                platform: 'yuanbao',
                isCurrent: location.href.includes(id)
            };
        }

        _extractAgentIdFromPath() {
            const segments = location.pathname.split('/').filter(Boolean);
            if (segments.length >= 3 && segments[0] === 'chat') return segments[1];
            return null;
        }

        _pickConversationArray(json) {
            if (!json || typeof json !== 'object') return [];
            for (const root of [json, json.data, json.result, json.response, json.payload]) {
                if (!root || typeof root !== 'object') continue;
                for (const key of ['conversations', 'items', 'result', 'data', 'list', 'records']) {
                    if (Array.isArray(root[key]) && root[key].length > 0) return root[key];
                }
                if (Array.isArray(root) && root.length > 0) return root;
            }
            return [];
        }

        _listFromInterceptorCache() {
            const cached = NetworkInterceptor.get('yuanbao:conversation_list');
            if (!cached?.text) return [];
            try {
                const data = JSON.parse(cached.text);
                const arr = this._pickConversationArray(data);
                return arr.map((item) => this._normalizeApiItem(item)).filter(Boolean);
            } catch {
                return [];
            }
        }

        async _listFromApi() {
            try {
                const response = await fetch('/api/user/agent/conversation/list', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ page: 1, pageSize: 200 }),
                    signal: AbortSignal.timeout(8000)
                });
                if (response.ok) {
                    const data = await response.json();
                    const arr = this._pickConversationArray(data);
                    const items = arr.map((item) => this._normalizeApiItem(item)).filter(Boolean);
                    if (items.length > 0) return items;
                }
            } catch (err) {
                this.log('listFromApi:failed', { error: err.message });
            }
            return [];
        }

        async _fetchConversationDetail(conversationId) {
            const cacheKey = `yuanbao:detail:${conversationId}`;

            const tryCache = () => {
                const exact = NetworkInterceptor.get(cacheKey);
                if (exact?.text) {
                    try {
                        const parsed = JSON.parse(exact.text);
                        if (this._hasConvs(parsed)) return parsed;
                    } catch {}
                }
                const latest = NetworkInterceptor.getLatestByPrefix('yuanbao:detail:');
                if (latest?.text) {
                    try {
                        const parsed = JSON.parse(latest.text);
                        if (this._hasConvs(parsed)) return parsed;
                    } catch {}
                }
                return null;
            };

            const immediate = tryCache();
            if (immediate) {
                this.log('fetchDetail:fromCache', { conversationId });
                return immediate;
            }

            const maxWait = 12000;
            const pollInterval = 600;
            const start = Date.now();
            while (Date.now() - start < maxWait) {
                await ArchiveUtils.sleep(pollInterval);
                const result = tryCache();
                if (result) {
                    this.log('fetchDetail:fromCacheAfterWait', {
                        conversationId,
                        waitMs: Date.now() - start
                    });
                    return result;
                }
            }

            this.log('fetchDetail:cacheTimeout', { conversationId, waitMs: maxWait });
            return null;
        }

        _hasConvs(data) {
            if (!data || typeof data !== 'object') return false;
            const convs = data.convs || data.data?.convs;
            return Array.isArray(convs) && convs.length > 0;
        }

        _parseConversation(jsonData, archiveId, item) {
            const convs = jsonData?.convs || jsonData?.data?.convs || [];
            if (!Array.isArray(convs) || convs.length === 0) return null;

            const sorted = [...convs].sort((a, b) => (a.index || 0) - (b.index || 0));
            const messages = [];
            const assets = [];
            let assetIndex = 0;

            sorted.forEach((turn, turnIndex) => {
                const role = turn.speaker === 'human' ? 'user' : 'assistant';
                const parts = [];

                if (turn.speechesV2 && Array.isArray(turn.speechesV2)) {
                    turn.speechesV2.forEach((speech) => {
                        if (!speech.content || !Array.isArray(speech.content)) return;
                        speech.content.forEach((block) => {
                            switch (block.type) {
                                case 'text':
                                    parts.push(block.msg || '');
                                    break;
                                case 'think':
                                case 'thinking':
                                case 'reasoning':
                                    break;
                                case 'searchGuid':
                                    if (block.docs && Array.isArray(block.docs)) {
                                        const refs = block.docs.map((doc, i) =>
                                            `[${i + 1}] [${doc.title || ''}](${doc.url || '#'})`
                                        ).join('\n');
                                        parts.push(`**${block.title || '搜索结果'}**\n${refs}`);
                                    }
                                    break;
                                case 'image':
                                case 'code':
                                case 'pdf': {
                                    const fileName = block.fileName || `file_${assetIndex}`;
                                    if (block.url) {
                                        const asset = this.createAssetBase(archiveId, `${archiveId}-m-${turnIndex}`, block.type === 'image' ? 'image' : 'file', fileName, 'application/octet-stream');
                                        asset.sourceUrl = block.url;
                                        assets.push(asset);
                                        parts.push(block.type === 'image'
                                            ? `![${fileName}](${asset.relativePath})`
                                            : `[附件: ${fileName}](${asset.relativePath})`);
                                        assetIndex++;
                                    } else {
                                        parts.push(`[${block.type}: ${fileName}]`);
                                    }
                                    break;
                                }
                            }
                        });
                    });
                } else if (turn.displayPrompt) {
                    parts.push(turn.displayPrompt);
                }

                const text = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
                if (!text) return;

                messages.push({
                    id: `${archiveId}-m-${turnIndex}`,
                    role,
                    createdAt: ArchiveUtils.toIso(turn.createTime || ''),
                    text,
                    parts: []
                });
            });

            if (messages.length === 0) return null;

            return {
                archiveId,
                platform: this.platform,
                sourceConversationId: item.sourceConversationId || item.id,
                title: jsonData.sessionTitle || jsonData.title || item.title || 'Untitled',
                sourceUrl: item.url || location.href,
                createdAt: ArchiveUtils.toIso(sorted[0]?.createTime || ''),
                updatedAt: ArchiveUtils.toIso(sorted[sorted.length - 1]?.createTime || '') || new Date().toISOString(),
                messages,
                assets,
                markdownDocuments: [],
                rawSnapshot: ''
            };
        }

        async exportConversation(item) {
            const convId = item.sourceConversationId || this._extractConversationIdFromPath();
            const archiveId = this.createArchiveId(convId || item.id);
            const failures = [];
            this.log('exportConversation:start', { convId, archiveId, itemUrl: item.url });

            if (convId) {
                const detail = await this._fetchConversationDetail(convId);
                this.log('exportConversation:detailResult', {
                    convId,
                    hasDetail: !!detail,
                    detailKeys: detail ? Object.keys(detail).slice(0, 10) : []
                });
                if (detail) {
                    const conversation = this._parseConversation(detail, archiveId, item);
                    this.log('exportConversation:parseResult', {
                        convId,
                        hasConversation: !!conversation,
                        messageCount: conversation?.messages?.length || 0
                    });
                    if (conversation) {
                        for (const asset of conversation.assets) {
                            try {
                                const result = await ArchiveUtils.fetchAsDataUrl(asset.sourceUrl);
                                if (result.success) {
                                    asset.dataUrl = result.dataUrl;
                                    asset.mimeType = result.mimeType || asset.mimeType;
                                    asset.size = result.size || 0;
                                    asset.downloadStatus = 'ready';
                                } else {
                                    asset.downloadStatus = 'failed';
                                    asset.errorReason = result.error || '下载失败';
                                    failures.push(ArchiveUtils.buildFailure('asset-download', this.platform, convId, `资源下载失败：${asset.filename}`, asset.errorReason));
                                }
                            } catch (err) {
                                asset.downloadStatus = 'failed';
                                asset.errorReason = err.message;
                            }
                        }
                        this.ensureUniqueAssetFilenames(conversation);
                        conversation.markdownDocuments = this.createMarkdownDocuments(conversation);
                        return { conversation, failures };
                    }
                }
            }

            console.warn('[ArchiveManager]', 'yuanbao:exportConversation:noApiData', { convId });
            return this._domSnapshotFallback(item, archiveId);
        }

        async _domSnapshotFallback(item, archiveId) {
            const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 50000);
            const conversation = {
                archiveId,
                platform: this.platform,
                sourceConversationId: item.sourceConversationId || item.id,
                title: item.title || document.title || 'Untitled',
                sourceUrl: item.url || location.href,
                createdAt: '',
                updatedAt: new Date().toISOString(),
                messages: [{
                    id: `${archiveId}-snapshot`,
                    role: 'snapshot',
                    createdAt: new Date().toISOString(),
                    text,
                    parts: []
                }],
                assets: [],
                markdownDocuments: [],
                rawSnapshot: ''
            };
            conversation.markdownDocuments = this.createMarkdownDocuments(conversation);
            return {
                conversation,
                failures: [{
                    stage: 'notice',
                    platform: this.platform,
                    conversationId: conversation.sourceConversationId,
                    message: '元宝当前版本通过页面快照导出，API 获取失败',
                    rawMessage: ''
                }]
            };
        }

        get usesPendingNavigationQueue() {
            return true;
        }
    }

    class DomNavigationExporter extends BaseArchiveExporter {
        constructor(platform, label) {
            super(platform, label);
        }

        _isDoubaoThinkingNode(node) {
            const thinkingSelectors = [
                '[data-testid*="thinking"]',
                '[data-testid*="reason"]',
                '[class*="thinking"]',
                '[class*="think-"]',
                '[class*="reasoning"]',
                '[class*="deep-think"]',
                '[class*="thought"]',
            ];
            for (const sel of thinkingSelectors) {
                if (node.closest(sel) || node.matches?.(sel)) return true;
            }
            const ancestor = node.closest('[data-testid="receive_message"]')
                || node.closest('[data-message-id]');
            if (ancestor) {
                const allTextContent = ancestor.querySelectorAll('[data-testid="message_text_content"]');
                if (allTextContent.length >= 2 && allTextContent[0] === node) {
                    const wrapper = node.parentElement;
                    if (wrapper) {
                        const style = window.getComputedStyle(wrapper);
                        const isCollapsible = wrapper.querySelector('details, [class*="collapse"], [class*="expand"], [class*="toggle"]');
                        const isSmaller = style.fontSize && parseFloat(style.fontSize) < 14;
                        const isGrayed = style.color && (style.color.includes('128') || style.color.includes('153') || style.color.includes('gray'));
                        if (isCollapsible || isSmaller || isGrayed) return true;
                    }
                }
            }
            return false;
        }

        _isKimiThinkingNode(node) {
            const thinkingSelectors = [
                '[class*="thinking"]',
                '[class*="search-process"]',
                '[class*="inner-thought"]',
                '[class*="think-"]',
                '[class*="reasoning"]',
                '[data-type="thinking"]',
                '[data-type="search"]',
            ];
            for (const sel of thinkingSelectors) {
                if (node.matches?.(sel)) return true;
            }
            if (!node.querySelector('.user-content')
                && !node.querySelector('.markdown, .segment-content, [class*="markdown"], [class*="message-content"]')) {
                const text = (node.textContent || '').trim();
                if (/^(正在搜索|正在思考|正在分析|Searching|Thinking|Analyzing)/i.test(text)) return true;
            }
            return false;
        }

        getConversationLinkPattern() {
            if (this.platform === 'doubao') return /\/chat\/\d+(?:[/?#]|$)/i;
            if (this.platform === 'kimi') return /\/(chat|share)\//i;
            return /\/chat\//i;
        }

        async expandConversationListIfNeeded() {
            if (this.platform !== 'kimi') return;

            const beforeCount = document.querySelectorAll('a[href]').length;
            const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
                .filter((element) => {
                    const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
                    if (!text || text.length > 32) return false;
                    return /^(查看全部|全部会话|查看所有|更多会话|更多历史|展开更多|历史会话)$/i.test(text);
                });

            const trigger = candidates.find((element) => {
                if (element.closest('.ait-panel-modal, .ait-panel-launcher')) return false;
                return typeof element.click === 'function';
            });

            if (!trigger) {
                return;
            }

            this.logExpandAttempt(trigger.textContent || '');
            trigger.click();

            const start = Date.now();
            while (Date.now() - start < 4000) {
                await ArchiveUtils.sleep(250);
                const afterCount = document.querySelectorAll('a[href]').length;
                if (afterCount > beforeCount) {
                    this.logExpandSuccess({ beforeCount, afterCount });
                    return;
                }
            }

            this.logExpandTimeout({ beforeCount, afterCount: document.querySelectorAll('a[href]').length });
        }

        logExpandAttempt(label) {
            console.log('[ArchiveManager]', 'kimi:expandConversationList:start', { label: (label || '').trim() });
        }

        logExpandSuccess(detail) {
            console.log('[ArchiveManager]', 'kimi:expandConversationList:success', detail);
        }

        logExpandTimeout(detail) {
            console.warn('[ArchiveManager]', 'kimi:expandConversationList:timeout', detail);
        }

        getConversationListScope() {
            if (this.platform === 'kimi' && /\/chat\/history\/?$/i.test(location.pathname)) {
                return document.querySelector('main')
                    || document.querySelector('[role="main"]')
                    || document.querySelector('.main-content')
                    || document.body;
            }
            return document;
        }

        extractConversationTitle(anchor, absoluteUrl) {
            const rawText = (anchor.textContent || '').trim();
            const fallbackTitle = absoluteUrl.split('/').pop()?.split('?')[0] || `${this.label} 会话`;

            if (!rawText) {
                return fallbackTitle;
            }

            if (this.platform === 'kimi' && /\/chat\/history\/?$/i.test(location.pathname)) {
                const titleNode = anchor.querySelector('.horizontal.header .title-wrapper > span.title')
                    || anchor.querySelector('.title-wrapper > span.title')
                    || anchor.querySelector('span.title');
                const titleText = (titleNode?.textContent || '').replace(/\s+/g, ' ').trim();
                if (titleText) {
                    return titleText;
                }
                const lines = rawText
                    .split('\n')
                    .map((line) => line.replace(/\s+/g, ' ').trim())
                    .filter(Boolean);
                return lines[0] || fallbackTitle;
            }

            return rawText.replace(/\s+/g, ' ').trim() || fallbackTitle;
        }

        listSidebarConversations() {
            const pattern = this.getConversationLinkPattern();
            const scope = this.getConversationListScope();
            const anchors = Array.from(scope.querySelectorAll('a[href]'));
            const dedup = new Map();

            anchors.forEach((anchor) => {
                const href = anchor.getAttribute('href') || '';
                if (!pattern.test(href)) return;
                if (this.platform === 'kimi' && /\/chat\/history\/?$/i.test(location.pathname)) {
                    if (anchor.closest('aside, nav, [role="navigation"], .ait-panel-modal, .ait-panel-launcher')) return;
                }
                const absoluteUrl = ArchiveUtils.absoluteUrl(href);
                const title = this.extractConversationTitle(anchor, absoluteUrl);

                if (!dedup.has(absoluteUrl)) {
                    dedup.set(absoluteUrl, {
                        id: ArchiveUtils.simpleHash(absoluteUrl).slice(0, 12),
                        title,
                        url: absoluteUrl,
                        createdAt: '',
                        updatedAt: '',
                        sourceConversationId: absoluteUrl.split('/').pop()?.split('?')[0] || absoluteUrl,
                        platform: this.platform,
                        isCurrent: location.href === absoluteUrl
                    });
                }
            });

            if (dedup.size === 0) {
                const currentTitle = document.title || `${this.label} 当前会话`;
                const currentId = location.pathname.split('/').filter(Boolean).pop() || ArchiveUtils.simpleHash(location.href).slice(0, 12);
                dedup.set(location.href, {
                    id: currentId,
                    title: currentTitle,
                    url: location.href,
                    createdAt: '',
                    updatedAt: '',
                    sourceConversationId: currentId,
                    platform: this.platform,
                    isCurrent: true
                });
            }

            return Array.from(dedup.values());
        }

        getConversationContainer() {
            const registry = new SiteAdapterRegistry();
            const adapter = registry.detectAdapter();
            const firstMessage = document.querySelector(adapter?.getUserMessageSelector?.() || '');
            if (adapter && firstMessage) {
                return adapter.findConversationContainer(firstMessage)
                    || ArchiveUtils.findScrollableAncestor(firstMessage)
                    || firstMessage.parentElement
                    || document.body;
            }

            const fallback = ArchiveUtils.findMainConversationFallback(this.platform);
            if (fallback) {
                return fallback;
            }

            throw ArchiveUtils.buildContentMissingError(this.platform);
        }

        async waitForConversationContainer(timeoutMs = 12000) {
            const start = Date.now();
            let lastError = null;

            while (Date.now() - start < timeoutMs) {
                try {
                    const container = this.getConversationContainer();
                    const text = (container?.innerText || '').replace(/\s+/g, '');
                    const html = container?.innerHTML || '';
                    if (text.length > 0 || html.length > 80) {
                        return container;
                    }
                } catch (error) {
                    lastError = error;
                }
                await ArchiveUtils.sleep(350);
            }

            throw lastError || ArchiveUtils.buildContentMissingError(this.platform);
        }

        extractMessagesFromContainer(container, archiveId) {
            if (!container) return [];

            if (this.platform === 'doubao') {
                const textNodes = Array.from(container.querySelectorAll('[data-testid="message_text_content"]'));
                return textNodes.map((node, index) => {
                    if (this._isDoubaoThinkingNode(node)) return null;
                    const text = (node.innerText || node.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
                    if (!text) return null;
                    const role = node.closest('[data-testid="send_message"]') ? 'user' : 'assistant';
                    const messageHost = node.closest('[data-message-id]') || node.closest('[data-testid="send_message"]') || node;
                    const messageId = messageHost?.getAttribute?.('data-message-id') || `${archiveId}-m-${index}`;
                    return {
                        id: String(messageId),
                        role,
                        createdAt: '',
                        text,
                        parts: []
                    };
                }).filter(Boolean);
            }

            if (this.platform === 'kimi') {
                const itemNodes = Array.from(container.querySelectorAll('.chat-content-item'));
                return itemNodes.map((node, index) => {
                    if (this._isKimiThinkingNode(node)) return null;
                    const userContent = node.querySelector('.user-content');
                    const role = userContent ? 'user' : 'assistant';

                    const thinkingEls = node.querySelectorAll(
                        '[class*="thinking"], [class*="search-process"], [class*="inner-thought"], '
                        + '[class*="think-"], [class*="reasoning"], details.think, [data-type="thinking"]'
                    );
                    thinkingEls.forEach((el) => el.setAttribute('data-ait-skip', '1'));

                    const textSource = userContent
                        || node.querySelector('.markdown, .segment-content, [class*="markdown"], [class*="message-content"]')
                        || node;

                    const clone = textSource.cloneNode(true);
                    clone.querySelectorAll('[data-ait-skip]').forEach((el) => el.remove());
                    const text = (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();

                    thinkingEls.forEach((el) => el.removeAttribute('data-ait-skip'));

                    if (!text) return null;
                    return {
                        id: String(node.getAttribute('data-id') || `${archiveId}-m-${index}`),
                        role,
                        createdAt: '',
                        text,
                        parts: []
                    };
                }).filter(Boolean);
            }

            return [];
        }

        async navigateToConversation(item) {
            if (!item?.url || item.url === location.href) {
                return;
            }

            const target = item.url;
            const matchingAnchor = Array.from(document.querySelectorAll('a[href]')).find((anchor) => {
                return ArchiveUtils.absoluteUrl(anchor.getAttribute('href')) === target;
            });

            const beforeUrl = location.href;
            const beforeTitle = document.title;

            if (matchingAnchor) {
                matchingAnchor.click();
            } else {
                console.warn('[ArchiveManager]', 'navigateToConversation:anchorMissingFallbackToLocation', {
                    platform: this.platform,
                    target
                });
                location.href = target;
            }

            const start = Date.now();
            while (Date.now() - start < 12000) {
                await ArchiveUtils.sleep(300);
                if (location.href === target || document.title !== beforeTitle || location.href !== beforeUrl) {
                    await ArchiveUtils.sleep(900);
                    return;
                }
            }

            throw new Error('切换会话超时，请打开该会话后重试');
        }

        async collectAssets(archiveId, container) {
            const assets = [];
            const failures = [];
            await this.primeLazyAssets(container);

            const roots = [container];
            if (document.body && container !== document.body && container !== document.documentElement) {
                roots.push(document.body);
            }

            const linkNodes = Array.from(new Set(
                roots.flatMap((root) => Array.from(root.querySelectorAll('a[href]')))
            ));
            const imageCandidates = new Map();
            let imageIndex = 0;
            let fileIndex = 0;

            const addImageCandidate = (url) => {
                const absoluteSrc = ArchiveUtils.absoluteUrl(url);
                if (!absoluteSrc) return;
                const isDecorativeIcon = /kimi-web-img\.moonshot\.cn\/prod-data\/icon-cache-img\//i.test(absoluteSrc)
                    || /\/favicon(?:\.\w+)?(?:[?#]|$)/i.test(absoluteSrc)
                    || /(^|[/?_-])icon([/?._-]|$)/i.test(absoluteSrc);
                if (isDecorativeIcon) {
                    return;
                }
                if (!imageCandidates.has(absoluteSrc)) {
                    imageCandidates.set(absoluteSrc, url);
                }
            };

            const collectImageAttributes = (element) => {
                [
                    'src',
                    'data-src',
                    'data-original',
                    'data-origin-src',
                    'data-origin',
                    'data-image',
                    'data-image-url',
                    'data-url',
                    'poster'
                ].forEach((attribute) => {
                    addImageCandidate(element.getAttribute(attribute) || '');
                });
            };

            roots.forEach((root) => {
                Array.from(root.querySelectorAll('img, video, source')).forEach((element) => {
                    collectImageAttributes(element);

                    const srcset = element.getAttribute('srcset') || element.getAttribute('data-srcset') || '';
                    if (srcset) {
                        srcset.split(',')
                            .map((part) => part.trim().split(/\s+/)[0])
                            .filter(Boolean)
                            .forEach(addImageCandidate);
                    }
                });

                Array.from(root.querySelectorAll('[style*="background-image"]')).forEach((node) => {
                    const style = node.getAttribute('style') || '';
                    const matches = style.match(/url\((['"]?)(.*?)\1\)/ig) || [];
                    matches.forEach((match) => {
                        const urlMatch = match.match(/url\((['"]?)(.*?)\1\)/i);
                        addImageCandidate(urlMatch?.[2] || '');
                    });
                });

                Array.from(root.querySelectorAll('[data-src],[data-url],[data-image],[data-image-url],[data-origin-src]')).forEach((node) => {
                    collectImageAttributes(node);
                });
            });

            linkNodes.forEach((link) => {
                const href = link.getAttribute('href') || '';
                const likelyImageHref = /\.(png|jpe?g|gif|webp|bmp|svg)(?:[?#]|$)/i.test(href)
                    || /image|img|photo|picture|gallery|tos-cn-|byteimg|moonshot/i.test(href);
                if (likelyImageHref) {
                    addImageCandidate(href);
                }
            });

            this.log('collectAssets:imageCandidates', {
                platform: this.platform,
                archiveId,
                candidateCount: imageCandidates.size
            });

            for (const [absoluteSrc, originalSrc] of imageCandidates.entries()) {
                const extensionMatch = absoluteSrc.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
                const extension = (extensionMatch?.[1] || 'png').slice(0, 5).toLowerCase();
                const asset = this.createAssetBase(archiveId, 'snapshot', 'image', `image_${imageIndex}.${extension}`, 'image/png');
                asset.sourceUrl = absoluteSrc;

                const result = absoluteSrc?.startsWith('data:')
                    ? { success: true, dataUrl: absoluteSrc, mimeType: 'image/png', size: absoluteSrc.length }
                    : await ArchiveUtils.fetchAsDataUrl(originalSrc || absoluteSrc);

                if (result.success) {
                    asset.dataUrl = result.dataUrl;
                    asset.mimeType = result.mimeType || asset.mimeType;
                    asset.size = result.size || 0;
                    asset.downloadStatus = 'ready';
                } else {
                    asset.downloadStatus = 'failed';
                    asset.errorReason = result.error || '图片下载失败';
                    failures.push(ArchiveUtils.buildFailure(
                        'asset-download',
                        this.platform,
                        archiveId,
                        `图片下载失败：${asset.filename}`,
                        asset.errorReason
                    ));
                }

                assets.push(asset);
                imageIndex++;
            }

            for (const link of linkNodes) {
                const href = link.getAttribute('href');
                const absolute = ArchiveUtils.absoluteUrl(href);
                const title = (link.textContent || '').trim();
                const looksLikeFile = /download|file|attachment|csv|xlsx|pdf|doc|docx|txt|json|md|zip|tar|png|jpg|jpeg|webp|gif|py|js|ts|jsx|tsx|html|css|java|cpp|c$/i.test(absolute);
                if (!looksLikeFile) continue;
                if (imageCandidates.has(absolute)) continue;

                const fileName = absolute.split('/').pop()?.split('?')[0] || `${this.platform}_file_${fileIndex}`;
                const asset = this.createAssetBase(archiveId, 'snapshot', 'file', fileName, 'application/octet-stream');
                asset.sourceUrl = absolute;

                const result = absolute.startsWith('data:')
                    ? { success: true, dataUrl: absolute, mimeType: 'application/octet-stream', size: absolute.length }
                    : await ArchiveUtils.fetchAsDataUrl(absolute);

                if (result.success) {
                    asset.dataUrl = result.dataUrl;
                    asset.mimeType = result.mimeType || asset.mimeType;
                    asset.size = result.size || 0;
                    asset.downloadStatus = 'ready';
                } else {
                    asset.downloadStatus = 'failed';
                    asset.errorReason = result.error || `附件下载失败：${title || fileName}`;
                    failures.push(ArchiveUtils.buildFailure(
                        'asset-download',
                        this.platform,
                        archiveId,
                        `附件下载失败：${fileName}`,
                        asset.errorReason
                    ));
                }

                assets.push(asset);
                fileIndex++;
            }

            this.log('collectAssets:done', {
                platform: this.platform,
                archiveId,
                totalAssets: assets.length,
                imageCount: assets.filter((asset) => asset.kind === 'image').length,
                readyCount: assets.filter((asset) => asset.downloadStatus === 'ready').length,
                failedCount: failures.length
            });

            return { assets, failures };
        }

        async primeLazyAssets(container) {
            if (!container) return;
            const previousScrollTop = container.scrollTop;
            const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
            const steps = Math.min(6, Math.max(1, Math.ceil(maxScroll / Math.max(container.clientHeight || 1, 600))));

            for (let step = 0; step <= steps; step++) {
                const ratio = steps === 0 ? 0 : step / steps;
                container.scrollTop = Math.round(maxScroll * ratio);
                await ArchiveUtils.sleep(180);
            }

            container.scrollTop = previousScrollTop;
            await ArchiveUtils.sleep(120);
        }

        async listConversations() {
            await this.expandConversationListIfNeeded();
            return this.listSidebarConversations();
        }

        async exportConversation(item, options = {}) {
            if (!options.skipNavigation) {
                await this.navigateToConversation(item);
            }
            await ArchiveUtils.sleep(this.platform === 'doubao' ? 1200 : 600);

            const container = await this.waitForConversationContainer(this.platform === 'doubao' ? 15000 : 12000);
            const archiveId = this.createArchiveId(item.sourceConversationId || item.id);
            const text = (container.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
            const html = container.innerHTML || '';

            const htmlAsset = this.createAssetBase(
                archiveId,
                'snapshot',
                'html',
                'conversation_snapshot.html',
                'text/html;charset=utf-8'
            );
            htmlAsset.textContent = html;
            htmlAsset.dataUrl = await ArchiveUtils.textToDataUrl(html, 'text/html;charset=utf-8');
            htmlAsset.size = html.length;
            htmlAsset.downloadStatus = 'ready';

            const { assets, failures } = await this.collectAssets(archiveId, container);
            const extractedMessages = this.extractMessagesFromContainer(container, archiveId);
            const conversation = {
                archiveId,
                platform: this.platform,
                sourceConversationId: item.sourceConversationId || item.id,
                title: item.title || document.title || 'Untitled',
                sourceUrl: item.url || location.href,
                createdAt: item.createdAt || '',
                updatedAt: new Date().toISOString(),
                messages: extractedMessages.length
                    ? extractedMessages
                    : [ArchiveUtils.createSnapshotMessage(text, archiveId)],
                assets: [htmlAsset, ...assets],
                markdownDocuments: [],
                rawSnapshot: html
            };
            this.ensureUniqueAssetFilenames(conversation);
            conversation.markdownDocuments = this.createMarkdownDocuments(conversation);

            return {
                conversation,
                failures: failures.concat([{
                    stage: 'notice',
                    platform: this.platform,
                    conversationId: conversation.sourceConversationId,
                    message: `${this.label} 当前版本通过页面快照导出，建议先打开目标会话后再导出以确保完整性`,
                    rawMessage: ''
                }])
            };
        }
    }

    class ArchiveManager {
        constructor() {
            this.exporters = {
                chatgpt: new ChatGPTArchiveExporter(),
                doubao: new DoubaoArchiveExporter(),
                kimi: new KimiArchiveExporter(),
                yuanbao: new YuanbaoArchiveExporter()
            };
            this.resumeStarted = false;
            setTimeout(() => {
                this.resumePendingExportIfNeeded().catch((error) => {
                    this.logError('resumePendingExportIfNeeded:error', error);
                });
            }, 1200);
        }

        log(...args) {
            console.log('[ArchiveManager]', ...args);
        }

        logError(...args) {
            console.error('[ArchiveManager]', ...args);
        }

        createUniqueMarkdownDocuments(markdownDocuments, usedNames) {
            return (markdownDocuments || []).map((document) => {
                const originalName = document.fileName || 'conversation.md';
                const dotIndex = originalName.lastIndexOf('.');
                const baseName = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName;
                const extension = dotIndex > 0 ? originalName.slice(dotIndex) : '.md';
                let candidate = originalName;
                let suffix = 2;

                while (usedNames.has(candidate)) {
                    candidate = `${baseName}_${suffix}${extension}`;
                    suffix++;
                }

                usedNames.add(candidate);
                return {
                    ...document,
                    fileName: candidate
                };
            });
        }

        getSupportedPlatformId() {
            const platformId = ArchiveUtils.getCurrentPlatformId();
            return SUPPORTED_EXPORTERS.includes(platformId) ? platformId : null;
        }

        getUnsupportedMessage() {
            return '当前页面暂不支持会话导出，仅支持 ChatGPT / 豆包 / Kimi / 元宝。';
        }

        async listCurrentPlatformConversations() {
            const platformId = this.getSupportedPlatformId();
            this.log('listCurrentPlatformConversations:start', { platformId });
            if (!platformId) {
                this.log('listCurrentPlatformConversations:unsupported');
                return {
                    supported: false,
                    platform: '',
                    items: [],
                    message: this.getUnsupportedMessage()
                };
            }

            const exporter = this.exporters[platformId];
            const items = await exporter.listConversations();
            this.log('listCurrentPlatformConversations:success', {
                platform: platformId,
                count: items.length
            });
            return {
                supported: true,
                platform: platformId,
                items
            };
        }

        async startBatch(platform, batchId = ArchiveUtils.createBatchId()) {
            this.log('startBatch', { platform, batchId });
            const response = await chrome.runtime.sendMessage({
                type: 'ARCHIVE_DRIVE_INIT_BATCH',
                payload: { platform, batchId }
            });

            if (!response?.success) {
                this.logError('startBatch:error', response);
                throw new Error(response?.error || '初始化归档批次失败');
            }

            return batchId;
        }

        async finalizeBatch(platform, batchId, exportedItems, allFailures) {
            this.log('finalizeBatch:start', {
                platform,
                batchId,
                conversationCount: exportedItems.length,
                failureCount: allFailures.length
            });
            const manifest = this.buildManifest(platform, batchId, exportedItems, allFailures);

            const response = await chrome.runtime.sendMessage({
                type: 'ARCHIVE_DRIVE_FINALIZE_BATCH',
                payload: { platform, batchId, manifest }
            });

            if (!response?.success) {
                this.logError('finalizeBatch:error', response);
                throw new Error(response?.error || '写入归档清单失败');
            }

            await global.ArchiveStorageManager.saveBatch({
                batchId,
                platform,
                conversations: exportedItems
            });
            this.log('finalizeBatch:success', { platform, batchId });
        }

        buildManifest(platform, batchId, exportedItems, allFailures) {
            return {
                version: ARCHIVE_VERSION,
                batchId,
                platform,
                exportedAt: new Date().toISOString(),
                extensionVersion: chrome.runtime.getManifest().version,
                conversationCount: exportedItems.length,
                assetCount: exportedItems.reduce((sum, item) => sum + (item.assets?.length || 0), 0),
                failedAssetCount: allFailures.filter((item) => item.stage === 'asset-download').length,
                conversations: exportedItems.map((item) => ({
                    archiveId: item.archiveId,
                    sourceConversationId: item.sourceConversationId,
                    title: item.title,
                    sourceUrl: item.sourceUrl,
                    createdAt: item.createdAt,
                    updatedAt: item.updatedAt,
                    markdownFiles: item.markdownDocuments.map((doc) => doc.fileName),
                    assetCount: item.assets.length
                })),
                failures: allFailures.filter((item) => item.stage !== 'notice')
            };
        }

        shouldFallbackToLocal(error) {
            const message = String(error?.message || error || '').toLowerCase();
            return message.includes('bad client id')
                || message.includes('oauth2 request failed')
                || message.includes('not authenticated');
        }

        async readPendingExport() {
            const result = await chrome.storage.local.get(PENDING_EXPORT_KEY);
            return result?.[PENDING_EXPORT_KEY] || null;
        }

        async writePendingExport(payload) {
            await chrome.storage.local.set({ [PENDING_EXPORT_KEY]: payload });
        }

        async clearPendingExport() {
            await chrome.storage.local.remove(PENDING_EXPORT_KEY);
        }

        async listDriveExports() {
            const response = await chrome.runtime.sendMessage({
                type: 'ARCHIVE_DRIVE_LIST_EXPORTS',
                platform: this.getSupportedPlatformId()
            });

            return {
                authenticated: !!response?.authenticated,
                files: Array.isArray(response?.files) ? response.files : []
            };
        }

        async resumePendingExportIfNeeded() {
            if (this.resumeStarted) return;
            this.resumeStarted = true;

            const pending = await this.readPendingExport();
            if (!pending?.active) return;
            const platformId = this.getSupportedPlatformId();
            if (!platformId || platformId !== pending.platformId) return;

            this.log('resumePendingExportIfNeeded:start', {
                platformId,
                currentIndex: pending.currentIndex,
                total: pending.items?.length || 0
            });

            await this.processPendingExportQueue(pending, () => {});
        }

        buildZip(fileEntries) {
            const encoder = new TextEncoder();
            const u16 = (value) => [value & 0xff, (value >> 8) & 0xff];
            const u32 = (value) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
            const crc32 = (buffer) => {
                let crc = 0xffffffff;
                const table = crc32.table || (crc32.table = (() => {
                    const result = new Uint32Array(256);
                    for (let i = 0; i < 256; i++) {
                        let value = i;
                        for (let j = 0; j < 8; j++) {
                            value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
                        }
                        result[i] = value;
                    }
                    return result;
                })());
                for (let i = 0; i < buffer.length; i++) {
                    crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
                }
                return (crc ^ 0xffffffff) >>> 0;
            };

            const now = new Date();
            const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
            const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

            const localHeaders = [];
            const dataBlocks = [];
            const centralDirectory = [];
            let offset = 0;

            for (const entry of fileEntries) {
                const nameBytes = encoder.encode(entry.path);
                const dataBytes = entry.bytes instanceof Uint8Array ? entry.bytes : encoder.encode(entry.bytes);
                const crc = crc32(dataBytes);

                const localHeader = new Uint8Array([
                    0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00,
                    ...u16(dosTime), ...u16(dosDate), ...u32(crc),
                    ...u32(dataBytes.length), ...u32(dataBytes.length),
                    ...u16(nameBytes.length), 0x00, 0x00, ...nameBytes
                ]);

                const cdHeader = new Uint8Array([
                    0x50, 0x4b, 0x01, 0x02, 0x14, 0x00, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00,
                    ...u16(dosTime), ...u16(dosDate), ...u32(crc),
                    ...u32(dataBytes.length), ...u32(dataBytes.length),
                    ...u16(nameBytes.length), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                    ...u32(offset), ...nameBytes
                ]);

                localHeaders.push(localHeader);
                dataBlocks.push(dataBytes);
                centralDirectory.push(cdHeader);
                offset += localHeader.length + dataBytes.length;
            }

            const cdSize = centralDirectory.reduce((sum, block) => sum + block.length, 0);
            const endOfCd = new Uint8Array([
                0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00,
                ...u16(localHeaders.length), ...u16(localHeaders.length),
                ...u32(cdSize), ...u32(offset), 0x00, 0x00
            ]);

            const blocks = [];
            for (let i = 0; i < localHeaders.length; i++) {
                blocks.push(localHeaders[i], dataBlocks[i]);
            }
            centralDirectory.forEach((block) => blocks.push(block));
            blocks.push(endOfCd);

            const totalLength = blocks.reduce((sum, block) => sum + block.length, 0);
            const output = new Uint8Array(totalLength);
            let cursor = 0;
            blocks.forEach((block) => {
                output.set(block, cursor);
                cursor += block.length;
            });

            return output;
        }

        async downloadLocalArchiveBatch(platform, batchId, exportedItems, allFailures) {
            const manifest = this.buildManifest(platform, batchId, exportedItems, allFailures);
            const fileEntries = [{
                path: 'manifest.json',
                bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2))
            }];

            exportedItems.forEach((conversation) => {
                (conversation.markdownDocuments || []).forEach((doc) => {
                    fileEntries.push({
                        path: `conversations/${doc.fileName}`,
                        bytes: new TextEncoder().encode(doc.content || '')
                    });
                });

                (conversation.assets || []).forEach((asset) => {
                    if (!asset.dataUrl) return;
                    fileEntries.push({
                        path: `assets/${conversation.archiveId}/${asset.filename}`,
                        bytes: ArchiveUtils.dataUrlToUint8Array(asset.dataUrl)
                    });
                });
            });

            const zipBytes = this.buildZip(fileEntries);
            const blob = new Blob([zipBytes], { type: 'application/zip' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `aitimeline_archive_${platform}_${batchId}.zip`;
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            URL.revokeObjectURL(url);
            this.log('downloadLocalArchiveBatch:done', {
                platform,
                batchId,
                fileCount: fileEntries.length
            });
        }

        async exportSelectedConversations(selectedItems, onUpdate = () => {}) {
            const platformId = this.getSupportedPlatformId();
            this.log('exportSelectedConversations:start', {
                platformId,
                selectedCount: selectedItems.length,
                ids: selectedItems.map((item) => item.id)
            });
            if (!platformId) {
                this.logError('exportSelectedConversations:unsupported');
                throw new Error(this.getUnsupportedMessage());
            }

            const exporter = this.exporters[platformId];
            const batchId = ArchiveUtils.createBatchId();
            const exportedItems = [];
            const allFailures = [];
            const usedMarkdownNames = new Set();
            let exportMode = 'drive';

            try {
                await this.startBatch(platformId, batchId);
            } catch (error) {
                if (!this.shouldFallbackToLocal(error)) {
                    throw error;
                }
                exportMode = 'local';
                this.log('exportSelectedConversations:fallbackToLocalZip', {
                    platformId,
                    batchId,
                    reason: error.message || String(error)
                });
            }

            const pendingState = {
                active: exporter instanceof DomNavigationExporter || !!exporter.usesPendingNavigationQueue,
                platformId,
                batchId,
                exportMode,
                currentIndex: 0,
                items: selectedItems,
                exportedItems: [],
                allFailures: [],
                usedMarkdownNames: []
            };

            if (pendingState.active) {
                await this.writePendingExport(pendingState);
                return this.processPendingExportQueue(pendingState, onUpdate);
            }

            for (let index = 0; index < selectedItems.length; index++) {
                const item = selectedItems[index];
                this.log('exportConversation:start', {
                    index: index + 1,
                    total: selectedItems.length,
                    id: item.id,
                    title: item.title
                });
                onUpdate(item.id, {
                    status: 'running',
                    error: '',
                    progressText: `导出中 ${index + 1}/${selectedItems.length}`
                });

                try {
                    const { conversation, failures } = await exporter.exportConversation(item);
                    conversation.markdownDocuments = this.createUniqueMarkdownDocuments(
                        conversation.markdownDocuments,
                        usedMarkdownNames
                    );
                    if (exportMode === 'drive') {
                        const response = await chrome.runtime.sendMessage({
                            type: 'ARCHIVE_DRIVE_UPLOAD_ITEM',
                            payload: {
                                platform: platformId,
                                batchId,
                                conversationMeta: {
                                    archiveId: conversation.archiveId,
                                    title: conversation.title,
                                    sourceConversationId: conversation.sourceConversationId,
                                    sourceUrl: conversation.sourceUrl,
                                    createdAt: conversation.createdAt,
                                    updatedAt: conversation.updatedAt
                                },
                                markdownDocuments: conversation.markdownDocuments,
                                assets: conversation.assets
                                    .filter((asset) => asset.dataUrl)
                                    .map((asset) => ({
                                        archiveId: conversation.archiveId,
                                        fileName: asset.filename,
                                        mimeType: asset.mimeType,
                                        dataUrl: asset.dataUrl
                                    }))
                            }
                        });

                        if (!response?.success) {
                            this.logError('exportConversation:uploadError', {
                                id: item.id,
                                response
                            });
                            throw new Error(response?.error || '上传到 Google Drive 失败');
                        }
                    }

                    exportedItems.push(conversation);
                    if (Array.isArray(failures) && failures.length > 0) {
                        allFailures.push(...failures);
                    }

                    const visibleFailures = (failures || []).filter((item) => item.stage !== 'notice');
                    onUpdate(item.id, {
                        status: visibleFailures.length ? 'partial' : 'success',
                        error: visibleFailures.length ? ArchiveUtils.summarizeFailures(visibleFailures) : '',
                        progressText: visibleFailures.length ? `完成，失败 ${visibleFailures.length} 项` : '导出成功'
                    });
                    this.log('exportConversation:success', {
                        id: item.id,
                        archiveId: conversation.archiveId,
                        markdownFiles: conversation.markdownDocuments.map((doc) => doc.fileName),
                        assetCount: conversation.assets.length,
                        failureCount: visibleFailures.length
                    });
                } catch (error) {
                    this.logError('exportConversation:error', {
                        id: item.id,
                        title: item.title,
                        error
                    });
                    const failure = ArchiveUtils.buildFailure(
                        'export',
                        platformId,
                        item.sourceConversationId || item.id,
                        `导出失败：${item.title}`,
                        error.message || 'Unknown error'
                    );
                    allFailures.push(failure);
                    onUpdate(item.id, {
                        status: 'failed',
                        error: failure.rawMessage,
                        progressText: '导出失败'
                    });
                }
            }

            if (exportMode === 'drive') {
                await this.finalizeBatch(platformId, batchId, exportedItems, allFailures);
            } else {
                await this.downloadLocalArchiveBatch(platformId, batchId, exportedItems, allFailures);
            }
            this.log('exportSelectedConversations:done', {
                batchId,
                exportMode,
                exportedCount: exportedItems.length,
                failureCount: allFailures.filter((item) => item.stage !== 'notice').length
            });

            return {
                batchId,
                platform: platformId,
                mode: exportMode,
                exportedCount: exportedItems.length,
                failureCount: allFailures.filter((item) => item.stage !== 'notice').length,
                failures: allFailures
            };
        }

        async processPendingExportQueue(pendingState, onUpdate = () => {}) {
            const exporter = this.exporters[pendingState.platformId];
            const exportedItems = Array.isArray(pendingState.exportedItems) ? pendingState.exportedItems : [];
            const allFailures = Array.isArray(pendingState.allFailures) ? pendingState.allFailures : [];
            const usedMarkdownNames = new Set(Array.isArray(pendingState.usedMarkdownNames) ? pendingState.usedMarkdownNames : []);
            const selectedItems = Array.isArray(pendingState.items) ? pendingState.items : [];
            const batchId = pendingState.batchId || ArchiveUtils.createBatchId();
            const exportMode = pendingState.exportMode || 'drive';

            for (let index = pendingState.currentIndex || 0; index < selectedItems.length; index++) {
                const item = selectedItems[index];
                const targetUrl = item?.url || '';

                if (targetUrl && targetUrl !== location.href) {
                    pendingState.currentIndex = index;
                    pendingState.exportedItems = exportedItems;
                    pendingState.allFailures = allFailures;
                    pendingState.usedMarkdownNames = Array.from(usedMarkdownNames);
                    await this.writePendingExport(pendingState);
                    this.log('processPendingExportQueue:navigate', {
                        index,
                        targetUrl
                    });
                    location.href = targetUrl;
                    return {
                        batchId,
                        platform: pendingState.platformId,
                        mode: exportMode,
                        exportedCount: exportedItems.length,
                        failureCount: allFailures.filter((entry) => entry.stage !== 'notice').length,
                        failures: allFailures,
                        resumed: true
                    };
                }

                this.log('exportConversation:start', {
                    index: index + 1,
                    total: selectedItems.length,
                    id: item.id,
                    title: item.title
                });
                onUpdate(item.id, {
                    status: 'running',
                    error: '',
                    progressText: `导出中 ${index + 1}/${selectedItems.length}`
                });

                try {
                    const { conversation, failures } = await exporter.exportConversation(item, { skipNavigation: true });
                    conversation.markdownDocuments = this.createUniqueMarkdownDocuments(
                        conversation.markdownDocuments,
                        usedMarkdownNames
                    );

                    if (exportMode === 'drive') {
                        const response = await chrome.runtime.sendMessage({
                            type: 'ARCHIVE_DRIVE_UPLOAD_ITEM',
                            payload: {
                                platform: pendingState.platformId,
                                batchId,
                                conversationMeta: {
                                    archiveId: conversation.archiveId,
                                    title: conversation.title,
                                    sourceConversationId: conversation.sourceConversationId,
                                    sourceUrl: conversation.sourceUrl,
                                    createdAt: conversation.createdAt,
                                    updatedAt: conversation.updatedAt
                                },
                                markdownDocuments: conversation.markdownDocuments,
                                assets: conversation.assets
                                    .filter((asset) => asset.dataUrl)
                                    .map((asset) => ({
                                        archiveId: conversation.archiveId,
                                        fileName: asset.filename,
                                        mimeType: asset.mimeType,
                                        dataUrl: asset.dataUrl
                                    }))
                            }
                        });

                        if (!response?.success) {
                            throw new Error(response?.error || '上传到 Google Drive 失败');
                        }
                    }

                    exportedItems.push(conversation);
                    if (Array.isArray(failures) && failures.length > 0) {
                        allFailures.push(...failures);
                    }
                    const visibleFailures = (failures || []).filter((entry) => entry.stage !== 'notice');
                    onUpdate(item.id, {
                        status: visibleFailures.length ? 'partial' : 'success',
                        error: visibleFailures.length ? ArchiveUtils.summarizeFailures(visibleFailures) : '',
                        progressText: visibleFailures.length ? `完成，失败 ${visibleFailures.length} 项` : '导出成功'
                    });
                } catch (error) {
                    this.logError('exportConversation:error', {
                        id: item.id,
                        title: item.title,
                        error
                    });
                    const failure = ArchiveUtils.buildFailure(
                        'export',
                        pendingState.platformId,
                        item.sourceConversationId || item.id,
                        `导出失败：${item.title}`,
                        error.message || 'Unknown error'
                    );
                    allFailures.push(failure);
                    onUpdate(item.id, {
                        status: 'failed',
                        error: failure.rawMessage,
                        progressText: '导出失败'
                    });
                }

                pendingState.currentIndex = index + 1;
                pendingState.exportedItems = exportedItems;
                pendingState.allFailures = allFailures;
                pendingState.usedMarkdownNames = Array.from(usedMarkdownNames);
                await this.writePendingExport(pendingState);
            }

            if (exportMode === 'drive') {
                await this.finalizeBatch(pendingState.platformId, batchId, exportedItems, allFailures);
            } else {
                await this.downloadLocalArchiveBatch(pendingState.platformId, batchId, exportedItems, allFailures);
            }

            await this.clearPendingExport();

            return {
                batchId,
                platform: pendingState.platformId,
                mode: exportMode,
                exportedCount: exportedItems.length,
                failureCount: allFailures.filter((entry) => entry.stage !== 'notice').length,
                failures: allFailures
            };
        }

        async retryConversation(item, onUpdate = () => {}) {
            this.log('retryConversation:start', { id: item?.id, title: item?.title });
            const result = await this.exportSelectedConversations([item], onUpdate);
            this.log('retryConversation:done', result);
            return result;
        }

        async importLatestFromDrive() {
            this.log('importLatestFromDrive:start');
            const response = await chrome.runtime.sendMessage({
                type: 'ARCHIVE_DRIVE_IMPORT_PULL',
                platform: null
            });

            if (!response?.success) {
                this.logError('importLatestFromDrive:error', response);
                throw new Error(response?.error || '从 Google Drive 导入失败');
            }

            const batches = Array.isArray(response.batches) ? response.batches : [];
            if (batches.length === 0) {
                this.log('importLatestFromDrive:empty');
                return {
                    success: true,
                    importedConversations: 0,
                    importedAssets: 0,
                    failures: [],
                    message: 'Google Drive 中暂无归档备份'
                };
            }

            let importedConversations = 0;
            let importedAssets = 0;
            const failures = [];

            for (const batch of batches) {
                this.log('importLatestFromDrive:batch', {
                    batchId: batch.batchId,
                    platform: batch.platform,
                    conversationCount: batch.conversations?.length || 0
                });
                const conversations = (batch.conversations || []).map((conversation) => ({
                    ...conversation,
                    messages: Array.isArray(conversation.messages) && conversation.messages.length
                        ? conversation.messages
                        : (conversation.markdownDocuments || []).map((doc, index) => ({
                            id: `${conversation.archiveId}-md-${index}`,
                            role: 'archive',
                            createdAt: conversation.updatedAt || conversation.createdAt || '',
                            text: doc.content || '',
                            parts: []
                        }))
                }));

                await global.ArchiveStorageManager.saveBatch({
                    batchId: batch.batchId,
                    platform: batch.platform,
                    conversations
                });

                importedConversations += conversations.length;
                importedAssets += conversations.reduce((sum, item) => sum + (item.assets?.length || 0), 0);
                if (Array.isArray(batch.manifest?.failures)) {
                    failures.push(...batch.manifest.failures);
                }
            }

            return {
                success: true,
                importedConversations,
                importedAssets,
                failures
            };
        }
    }

    global.ArchiveManager = new ArchiveManager();
})(window);
