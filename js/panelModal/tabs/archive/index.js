/**
 * Archive Tab - export workbench
 */

class ArchiveTab extends BaseTab {
    constructor() {
        super();
        this.id = 'archive';
        this.name = '会话归档';
        this.sessionVersion = 0;
        this.pageSize = 20;
        this.driveStatusTtlMs = 60 * 1000;
        this.cacheKey = 'archiveConversationListCache';
        this.exportHistoryKey = 'archiveExportHistory';
        this.driveStatusIndex = new Map();
        this.driveStatusNameIndex = new Map();
        this.driveStatusFetchedAt = 0;
        this.icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 8v13H3V8"/>
            <path d="M1 3h22v5H1z"/>
            <path d="M10 12h4"/>
        </svg>`;
    }

    log(...args) {
        console.log('[ArchiveTab]', ...args);
    }

    logError(...args) {
        console.error('[ArchiveTab]', ...args);
    }

    getInitialState() {
        return {
            transient: {
                supported: true,
                platform: '',
                items: [],
                statuses: {},
                searchQuery: '',
                loading: false,
                driveStatusLoading: false,
                loadingMessage: '正在加载会话列表...',
                showingCachedData: false,
                loadRequestId: 0,
                currentPage: 1
            },
            persistent: {
                viewState: null
            }
        };
    }

    render() {
        const container = document.createElement('div');
        container.className = 'archive-tab';
        container.innerHTML = `
            <div class="archive-header">
                <div>
                    <div class="archive-title">当前站点会话归档</div>
                    <div class="archive-subtitle" id="archive-subtitle">正在加载会话列表...</div>
                </div>
                <div class="archive-header-actions">
                    <button class="archive-secondary-btn" id="archive-refresh-btn">刷新列表与状态</button>
                    <button class="archive-primary-btn" id="archive-export-selected-btn">导出选中会话</button>
                </div>
            </div>
            <div class="archive-toolbar">
                <input
                    type="text"
                    class="archive-search-input"
                    id="archive-search-input"
                    placeholder="搜索会话标题"
                    autocomplete="off"
                />
                <label class="archive-select-all">
                    <input type="checkbox" id="archive-select-all-checkbox" />
                    <span>全选本页</span>
                </label>
                <div class="archive-toolbar-note" id="archive-toolbar-note"></div>
            </div>
            <div class="archive-list" id="archive-list"></div>
            <div class="archive-pagination" id="archive-pagination"></div>
        `;
        return container;
    }

    async mounted() {
        super.mounted();
        this.sessionVersion += 1;
        this.log('mounted');

        const refreshBtn = document.getElementById('archive-refresh-btn');
        const exportBtn = document.getElementById('archive-export-selected-btn');
        const selectAll = document.getElementById('archive-select-all-checkbox');
        const searchInput = document.getElementById('archive-search-input');

        if (refreshBtn) {
            this.addEventListener(refreshBtn, 'click', () => this.loadConversations());
        }
        if (exportBtn) {
            this.addEventListener(exportBtn, 'click', () => this.exportSelected());
        }
        if (selectAll) {
            this.addEventListener(selectAll, 'change', (event) => this.toggleSelectAll(event.target.checked));
        }
        if (searchInput) {
            searchInput.value = this.getState('searchQuery') || '';
            this.addEventListener(searchInput, 'input', (event) => this.updateSearchQuery(event.target.value));
            this.addEventListener(searchInput, 'keydown', (event) => {
                if (event.key === 'Escape') {
                    event.target.value = '';
                    this.updateSearchQuery('');
                }
            });
        }

        if (this.restoreViewState()) {
            const needsRefresh = this.getDriveCacheRemainingMs() <= 0;
            this.renderList();
            this.renderToolbarState(needsRefresh ? '状态缓存已过期，正在刷新最新列表...' : '');
            if (needsRefresh) {
                await this.loadConversations();
            }
            return;
        }

        await this.hydrateFromCache();
        await this.loadConversations();
    }

    unmounted() {
        this.sessionVersion += 1;
        this.setState('loading', false);
        this.setState('driveStatusLoading', false);
        this.persistViewState();
        super.unmounted();
    }

    isSessionActive(sessionVersion) {
        return this.sessionVersion === sessionVersion;
    }

    persistViewState() {
        const items = this.getState('items') || [];
        const statuses = this.getState('statuses') || {};
        if (!items.length) {
            this.setPersistentState('viewState', null);
            return;
        }
        this.setPersistentState('viewState', {
            supported: this.getState('supported'),
            platform: this.getState('platform') || '',
            items,
            statuses,
            searchQuery: this.getState('searchQuery') || '',
            currentPage: this.getState('currentPage') || 1,
            showingCachedData: !!this.getState('showingCachedData'),
            loadingMessage: this.getState('loadingMessage') || '正在加载会话列表...'
        });
        this.log('persistViewState', {
            platform: this.getState('platform') || '',
            count: items.length,
            currentPage: this.getState('currentPage') || 1
        });
    }

    restoreViewState() {
        const viewState = this.getPersistentState('viewState');
        if (!viewState || !Array.isArray(viewState.items) || viewState.items.length === 0) {
            this.log('restoreViewState:miss');
            return false;
        }

        this.setState('supported', viewState.supported !== false);
        this.setState('platform', viewState.platform || '');
        this.setState('items', viewState.items || []);
        this.setState('statuses', viewState.statuses || {});
        this.setState('searchQuery', viewState.searchQuery || '');
        this.setState('currentPage', this.clampPage(viewState.currentPage || 1, viewState.items || []));
        this.setState('showingCachedData', !!viewState.showingCachedData);
        this.setState('loading', false);
        this.setState('driveStatusLoading', false);
        this.setState('loadingMessage', viewState.loadingMessage || '正在加载会话列表...');
        const searchInput = document.getElementById('archive-search-input');
        if (searchInput) {
            searchInput.value = viewState.searchQuery || '';
        }
        this.log('restoreViewState:hit', {
            platform: viewState.platform || '',
            count: viewState.items.length,
            currentPage: viewState.currentPage || 1,
            cacheRemainingMs: this.getDriveCacheRemainingMs()
        });
        return true;
    }

    async hydrateFromCache() {
        this.log('hydrateFromCache:start');
        const cached = await this.readCache();
        if (!cached || !Array.isArray(cached.items) || cached.items.length === 0) {
            this.log('hydrateFromCache:miss');
            this.renderList('正在加载会话列表...');
            return;
        }

        const items = await this.applyExportHistory(cached.items || []);
        const statuses = {};
        items.forEach((item) => {
            statuses[item.id] = {
                status: 'idle',
                error: '',
                progressText: ''
            };
        });

        this.setState('supported', cached.supported !== false);
        this.setState('platform', cached.platform || '');
        this.setState('items', items);
        this.setState('statuses', statuses);
        this.setState('showingCachedData', true);
        this.setState('driveStatusLoading', true);
        this.setState('loadingMessage', '已显示缓存列表，正在刷新最新会话...');
        this.log('hydrateFromCache:hit', {
            platform: cached.platform || '',
            count: items.length,
            updatedAt: cached.updatedAt || null
        });
        this.renderList();
        this.renderToolbarState();
    }

    async loadConversations() {
        const sessionVersion = this.sessionVersion;
        const requestId = (this.getState('loadRequestId') || 0) + 1;
        this.setState('loadRequestId', requestId);
        this.log('loadConversations:start', {
            hasExistingItems: !!this.getState('items')?.length,
            requestId
        });
        this.setState('loading', true);
        this.setState('driveStatusLoading', true);
        this.setState('loadingMessage', this.getState('items')?.length
            ? '正在刷新最新会话列表...'
            : '正在加载会话列表...');
        this.renderToolbarState();
        if (!this.getState('items')?.length) {
            this.renderList(this.getState('loadingMessage'));
        }

        try {
            const result = await window.ArchiveManager.listCurrentPlatformConversations();
            if (!this.isSessionActive(sessionVersion)) {
                this.log('loadConversations:sessionInvalidated', { requestId, sessionVersion });
                return;
            }
            if ((this.getState('loadRequestId') || 0) !== requestId) {
                this.log('loadConversations:staleResultIgnored', { requestId });
                return;
            }
            this.log('loadConversations:success', {
                supported: result.supported,
                platform: result.platform || '',
                count: (result.items || []).length
            });
            this.setState('supported', result.supported);
            this.setState('platform', result.platform || '');
            this.setState('showingCachedData', false);
            const items = this.mergeItemsWithCurrentState(await this.applyExportHistory(result.items || [], { skipDrive: true }));
            this.setState('currentPage', this.clampPage(this.getState('currentPage') || 1, items));
            this.setState('items', items);
            this.setState('statuses', this.mergeStatuses(items));
            await this.writeCache({
                supported: result.supported,
                platform: result.platform || '',
                items: result.items || [],
                updatedAt: Date.now()
            });
            this.renderList();
            this.renderToolbarState('正在同步 Google Drive 备份状态...');
            this.syncDriveStatesForCurrentPage(requestId, result.items || []).catch((error) => {
                this.logError('syncDriveStates:error', error);
            });
        } catch (error) {
            if (!this.isSessionActive(sessionVersion)) {
                this.log('loadConversations:sessionInvalidatedError', { requestId, sessionVersion });
                return;
            }
            if ((this.getState('loadRequestId') || 0) !== requestId) {
                this.log('loadConversations:staleErrorIgnored', { requestId });
                return;
            }
            this.logError('loadConversations:error', error);
            this.setState('supported', false);
            this.setState('items', []);
            this.setState('showingCachedData', false);
            this.setState('driveStatusLoading', false);
            this.renderList(error.message || '加载会话列表失败');
            this.renderToolbarState(error.message || '加载会话列表失败');
        } finally {
            if (!this.isSessionActive(sessionVersion)) {
                return;
            }
            if ((this.getState('loadRequestId') || 0) !== requestId) {
                return;
            }
            this.setState('loading', false);
            this.log('loadConversations:done');
            this.renderList();
            this.renderToolbarState();
        }
    }

    async syncDriveStatesForCurrentPage(requestId, rawItems) {
        const sessionVersion = this.sessionVersion;
        await this.refreshDriveStatusIndex();
        if (!this.isSessionActive(sessionVersion)) {
            this.log('syncDriveStatesForCurrentPage:sessionInvalidated', { requestId, sessionVersion });
            return;
        }
        if ((this.getState('loadRequestId') || 0) !== requestId) {
            this.log('syncDriveStatesForCurrentPage:staleIgnored', { requestId });
            return;
        }
        const items = this.mergeItemsWithCurrentState(await this.applyExportHistory(rawItems || []));
        this.setState('items', items);
        this.setState('statuses', this.mergeStatuses(items));
        this.setState('driveStatusLoading', false);
        this.renderList();
        this.renderToolbarState();
    }

    mergeItemsWithCurrentState(nextItems) {
        const previousItems = this.getState('items') || [];
        const previousMap = new Map(previousItems.map((item) => [item.id, item]));
        return (nextItems || []).map((item) => {
            const previous = previousMap.get(item.id);
            return {
                ...item,
                selected: previous ? !!previous.selected : !!item.selected
            };
        });
    }

    mergeStatuses(items) {
        const previousStatuses = this.getState('statuses') || {};
        const merged = {};
        (items || []).forEach((item) => {
            merged[item.id] = previousStatuses[item.id]
                ? { ...previousStatuses[item.id] }
                : {
                    status: 'idle',
                    error: '',
                    progressText: ''
                };
        });
        return merged;
    }

    renderToolbarState(message = '') {
        const subtitle = document.getElementById('archive-subtitle');
        const note = document.getElementById('archive-toolbar-note');
        const selectAll = document.getElementById('archive-select-all-checkbox');
        const refreshBtn = document.getElementById('archive-refresh-btn');
        const exportBtn = document.getElementById('archive-export-selected-btn');
        const items = this.getState('items') || [];
        const filteredItems = this.getFilteredItems(items);
        const pagedItems = this.getPagedItems(filteredItems);
        const selectedCount = items.filter((item) => item.selected).length;
        const supported = this.getState('supported');
        const loading = this.getState('loading');
        const driveStatusLoading = this.getState('driveStatusLoading');
        const showingCachedData = this.getState('showingCachedData');
        const loadingMessage = this.getState('loadingMessage') || '正在加载会话列表...';
        const cacheRemainingMs = this.getDriveCacheRemainingMs();
        const cacheStatusText = this.getDriveCacheStatusText(cacheRemainingMs);
        const searchQuery = this.getState('searchQuery') || '';

        if (subtitle) {
            if (!supported) {
                subtitle.textContent = message || '当前页面暂不支持导出';
            } else if (loading && items.length === 0) {
                subtitle.textContent = loadingMessage;
            } else if (showingCachedData) {
                subtitle.textContent = `当前平台：${this.getState('platform') || 'unknown'}，缓存 ${items.length} 个会话，正在刷新`;
            } else if (driveStatusLoading) {
                subtitle.textContent = `当前平台：${this.getState('platform') || 'unknown'}，共 ${items.length} 个会话，正在同步备份状态`;
            } else {
                subtitle.textContent = `当前平台：${this.getState('platform') || 'unknown'}，共 ${items.length} 个会话`;
            }
        }

        if (note) {
            if (!supported) {
                note.textContent = message || window.ArchiveManager.getUnsupportedMessage();
            } else if (loading && items.length === 0) {
                note.textContent = '首次加载可能需要 1-2 秒，请稍候';
            } else if (showingCachedData) {
                note.textContent = `已选 ${selectedCount} 个会话，当前先展示缓存数据，刷新完成后会自动替换`;
            } else if (driveStatusLoading) {
                note.textContent = '正在同步当前页的 Google Drive 备份状态，期间暂不允许操作，避免状态错乱';
            } else {
                const filterText = searchQuery ? `当前搜索命中 ${filteredItems.length} 个会话。` : '';
                note.textContent = `${filterText}当前第 ${this.getState('currentPage') || 1} 页，已选 ${selectedCount} 个会话，导出时将按顺序执行并实时更新状态。${cacheStatusText}`;
            }
        }

        if (selectAll) {
            selectAll.disabled = !supported || pagedItems.length === 0 || loading || driveStatusLoading;
            selectAll.checked = pagedItems.length > 0
                && pagedItems.every((item) => item.selected);
        }

        if (refreshBtn) {
            refreshBtn.disabled = !supported || loading || driveStatusLoading;
            refreshBtn.textContent = (loading || driveStatusLoading) ? '刷新中...' : '刷新列表与状态';
        }

        if (exportBtn) {
            exportBtn.disabled = !supported || selectedCount === 0 || loading || driveStatusLoading;
        }
    }

    renderList(message = '') {
        const listEl = document.getElementById('archive-list');
        const paginationEl = document.getElementById('archive-pagination');
        if (!listEl) return;

        const supported = this.getState('supported');
        const items = this.getState('items') || [];
        const filteredItems = this.getFilteredItems(items);
        const pagedItems = this.getPagedItems(filteredItems);
        const statuses = this.getState('statuses') || {};
        const loading = this.getState('loading');
        const driveStatusLoading = this.getState('driveStatusLoading');
        const searchQuery = this.getState('searchQuery') || '';

        if (!supported) {
            listEl.innerHTML = `<div class="archive-empty">${this.escapeHtml(message || window.ArchiveManager.getUnsupportedMessage())}</div>`;
            if (paginationEl) paginationEl.innerHTML = '';
            return;
        }

        if (!items.length) {
            listEl.innerHTML = `
                <div class="archive-loading-card">
                    <div class="archive-loading-spinner"></div>
                    <div class="archive-loading-title">${this.escapeHtml(loading ? (message || '正在加载会话列表...') : '未找到会话列表')}</div>
                    <div class="archive-loading-desc">${loading ? '首次读取历史会话时，站点侧边栏数据可能会延迟出现。' : '请先展开站点侧边栏后刷新。'}</div>
                </div>
            `;
            if (paginationEl) paginationEl.innerHTML = '';
            return;
        }

        if (!filteredItems.length) {
            listEl.innerHTML = `
                <div class="archive-loading-card">
                    <div class="archive-loading-title">未找到匹配会话</div>
                    <div class="archive-loading-desc">当前仅按标题搜索，关键词：${this.escapeHtml(searchQuery || '')}</div>
                </div>
            `;
            if (paginationEl) paginationEl.innerHTML = '';
            return;
        }

        listEl.innerHTML = `
            ${loading ? `
                <div class="archive-inline-loading">
                    <div class="archive-loading-spinner small"></div>
                    <span>${this.escapeHtml(message || this.getState('loadingMessage') || '正在刷新最新会话列表...')}</span>
                </div>
            ` : ''}
            ${(!loading && driveStatusLoading) ? `
                <div class="archive-inline-loading">
                    <div class="archive-loading-spinner small"></div>
                    <span>正在同步 Google Drive 备份状态，请稍候...</span>
                </div>
            ` : ''}
            ${pagedItems.map((item) => {
            const status = statuses[item.id] || { status: 'idle', error: '', progressText: '' };
            const badgeClass = `status-${status.status}`;
            const showRetry = status.status === 'failed';
            const showStatusBadge = status.status !== 'idle';
            const exportState = item.exportState || 'never';
            const exportBadgeClass = `export-${exportState}`;
            const exportLabel = this.getExportStateLabel(exportState);
            const showReExport = exportState === 'exported' || exportState === 'updated';

            return `
                <div class="archive-row" data-id="${item.id}">
                    <label class="archive-row-main">
                        <input type="checkbox" class="archive-item-checkbox" data-id="${item.id}" ${item.selected ? 'checked' : ''} ${driveStatusLoading ? 'disabled' : ''} />
                        <div class="archive-row-body">
                            <div class="archive-row-top">
                                <span class="archive-row-title">${this.escapeHtml(item.title || 'Untitled')}</span>
                                <div class="archive-row-badges">
                                    <span class="archive-export-badge ${exportBadgeClass}">${this.escapeHtml(exportLabel)}</span>
                                    ${showStatusBadge ? `<span class="archive-status ${badgeClass}">${this.getStatusLabel(status.status)}</span>` : ''}
                                </div>
                            </div>
                            <div class="archive-row-meta">${this.escapeHtml(item.url || '')}</div>
                            ${item.lastExportedAt ? `<div class="archive-row-export-meta">上次导出：${this.escapeHtml(this.formatDateTime(item.lastExportedAt))}</div>` : ''}
                            <div class="archive-row-progress">${this.escapeHtml(status.progressText || '')}</div>
                            ${status.error ? `<div class="archive-row-error">${this.escapeHtml(status.error)}</div>` : ''}
                        </div>
                    </label>
                    <div class="archive-row-actions">
                        ${showReExport ? `<button class="archive-row-action-btn archive-reexport-btn" data-id="${item.id}" ${driveStatusLoading ? 'disabled' : ''}>${exportState === 'updated' ? '导出更新' : '重复导出'}</button>` : ''}
                        ${showRetry ? `<button class="archive-row-action-btn archive-retry-btn" data-id="${item.id}" ${driveStatusLoading ? 'disabled' : ''}>重试</button>` : ''}
                    </div>
                </div>
            `;
        }).join('')}
        `;

        Array.from(listEl.querySelectorAll('.archive-item-checkbox')).forEach((checkbox) => {
            this.addEventListener(checkbox, 'change', (event) => {
                this.toggleItem(checkbox.dataset.id, event.target.checked);
            });
        });

        Array.from(listEl.querySelectorAll('.archive-retry-btn')).forEach((button) => {
            this.addEventListener(button, 'click', () => this.retryItem(button.dataset.id));
        });

        Array.from(listEl.querySelectorAll('.archive-reexport-btn')).forEach((button) => {
            this.addEventListener(button, 'click', () => this.reExportItem(button.dataset.id));
        });

        this.renderPagination();
    }

    renderPagination() {
        const paginationEl = document.getElementById('archive-pagination');
        if (!paginationEl) return;
        const filteredItems = this.getFilteredItems(this.getState('items') || []);
        const totalPages = this.getTotalPages(filteredItems);
        const currentPage = this.clampPage(this.getState('currentPage') || 1, filteredItems);
        if (totalPages <= 1) {
            paginationEl.innerHTML = '';
            return;
        }

        const pageNumbers = this.getPaginationNumbers(currentPage, totalPages);
        paginationEl.innerHTML = `
            <button class="archive-page-btn" data-page-action="prev" ${currentPage <= 1 ? 'disabled' : ''}>上一页</button>
            <div class="archive-page-numbers">
                ${pageNumbers.map((page) => {
                    if (page === 'ellipsis') {
                        return `<span class="archive-page-ellipsis">...</span>`;
                    }
                    return `<button class="archive-page-btn archive-page-number-btn ${page === currentPage ? 'active' : ''}" data-page-number="${page}">${page}</button>`;
                }).join('')}
            </div>
            <span class="archive-page-info">第 ${currentPage} / ${totalPages} 页</span>
            <button class="archive-page-btn" data-page-action="next" ${currentPage >= totalPages ? 'disabled' : ''}>下一页</button>
        `;

        Array.from(paginationEl.querySelectorAll('.archive-page-btn')).forEach((button) => {
            this.addEventListener(button, 'click', () => {
                if (button.dataset.pageNumber) {
                    this.jumpToPage(Number(button.dataset.pageNumber));
                    return;
                }
                const delta = button.dataset.pageAction === 'prev' ? -1 : 1;
                this.changePage(delta);
            });
        });
    }

    getPaginationNumbers(currentPage, totalPages) {
        if (totalPages <= 7) {
            return Array.from({ length: totalPages }, (_, index) => index + 1);
        }
        const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
        if (currentPage <= 3) {
            pages.add(2);
            pages.add(3);
            pages.add(4);
        }
        if (currentPage >= totalPages - 2) {
            pages.add(totalPages - 1);
            pages.add(totalPages - 2);
            pages.add(totalPages - 3);
        }
        const ordered = Array.from(pages)
            .filter((page) => page >= 1 && page <= totalPages)
            .sort((a, b) => a - b);
        const output = [];
        ordered.forEach((page, index) => {
            const previous = ordered[index - 1];
            if (typeof previous === 'number' && page - previous > 1) {
                output.push('ellipsis');
            }
            output.push(page);
        });
        return output;
    }

    getDriveCacheRemainingMs() {
        if (!this.driveStatusFetchedAt) return 0;
        return Math.max(0, this.driveStatusTtlMs - (Date.now() - this.driveStatusFetchedAt));
    }

    getDriveCacheStatusText(cacheRemainingMs) {
        if (!this.driveStatusFetchedAt) {
            return '当前状态尚未缓存。';
        }
        if (cacheRemainingMs <= 0) {
            return '缓存已过期，可刷新列表与状态。';
        }
        const seconds = Math.ceil(cacheRemainingMs / 1000);
        return `状态缓存剩余约 ${seconds} 秒。`;
    }

    getTotalPages(items) {
        const count = Array.isArray(items) ? items.length : 0;
        return Math.max(1, Math.ceil(count / this.pageSize));
    }

    clampPage(page, items) {
        const totalPages = this.getTotalPages(items);
        return Math.min(Math.max(1, page || 1), totalPages);
    }

    getPagedItems(items) {
        const currentPage = this.clampPage(this.getState('currentPage') || 1, items);
        const start = (currentPage - 1) * this.pageSize;
        return (items || []).slice(start, start + this.pageSize);
    }

    getFilteredItems(items) {
        const searchQuery = (this.getState('searchQuery') || '').trim().toLowerCase();
        if (!searchQuery) {
            return items || [];
        }
        return (items || []).filter((item) => String(item.title || '').toLowerCase().includes(searchQuery));
    }

    updateSearchQuery(value) {
        const searchQuery = String(value || '').trim().toLowerCase();
        this.log('updateSearchQuery', { searchQuery });
        this.setState('searchQuery', searchQuery);
        this.setState('currentPage', 1);
        this.renderList();
        this.renderToolbarState();
    }

    async changePage(delta) {
        const items = this.getState('items') || [];
        const filteredItems = this.getFilteredItems(items);
        const nextPage = this.clampPage((this.getState('currentPage') || 1) + delta, filteredItems);
        if (nextPage === (this.getState('currentPage') || 1)) return;
        const requestId = (this.getState('loadRequestId') || 0) + 1;
        this.setState('loadRequestId', requestId);
        this.setState('currentPage', nextPage);
        this.setState('driveStatusLoading', true);
        this.renderList();
        this.renderToolbarState('正在同步 Google Drive 备份状态...');
        this.log('changePage', { nextPage, requestId });
        await this.syncDriveStatesForCurrentPage(requestId, items);
    }

    async jumpToPage(pageNumber) {
        const items = this.getState('items') || [];
        const filteredItems = this.getFilteredItems(items);
        const nextPage = this.clampPage(pageNumber, filteredItems);
        if (nextPage === (this.getState('currentPage') || 1)) return;
        const requestId = (this.getState('loadRequestId') || 0) + 1;
        this.setState('loadRequestId', requestId);
        this.setState('currentPage', nextPage);
        this.setState('driveStatusLoading', true);
        this.renderList();
        this.renderToolbarState('正在同步 Google Drive 备份状态...');
        this.log('jumpToPage', { nextPage, requestId });
        await this.syncDriveStatesForCurrentPage(requestId, items);
    }

    toggleItem(id, checked) {
        this.log('toggleItem', { id, checked });
        const items = (this.getState('items') || []).map((item) => {
            return item.id === id ? { ...item, selected: checked } : item;
        });
        this.setState('items', items);
        this.renderToolbarState();
    }

    toggleSelectAll(checked) {
        this.log('toggleSelectAll', { checked });
        const filteredItems = this.getFilteredItems(this.getState('items') || []);
        const pageIds = new Set(this.getPagedItems(filteredItems).map((item) => item.id));
        const items = (this.getState('items') || []).map((item) => {
            if (!pageIds.has(item.id)) {
                return item;
            }
            return { ...item, selected: checked };
        });
        this.setState('items', items);
        this.renderList();
        this.renderToolbarState();
    }

    applyStatusUpdate(id, patch) {
        this.log('applyStatusUpdate', { id, patch });
        const statuses = {
            ...(this.getState('statuses') || {}),
            [id]: {
                ...(this.getState('statuses') || {})[id],
                ...patch
            }
        };
        this.setState('statuses', statuses);
        this.renderList();
        this.renderToolbarState();
    }

    async exportSelected() {
        const items = (this.getState('items') || []).filter((item) => item.selected);
        this.log('exportSelected:start', {
            selectedCount: items.length,
            ids: items.map((item) => item.id)
        });
        if (!items.length) return;

        const duplicateItems = items.filter((item) => item.exportState === 'exported' || item.exportState === 'updated');
        if (duplicateItems.length > 0) {
            const confirmed = window.confirm(
                `当前选中了 ${duplicateItems.length} 个已导出或有更新的会话，继续后会重复导出这些会话。是否继续？`
            );
            this.log('exportSelected:duplicateConfirm', {
                duplicateCount: duplicateItems.length,
                confirmed
            });
            if (!confirmed) {
                return;
            }
        }

        items.forEach((item) => {
            this.applyStatusUpdate(item.id, { status: 'queued', error: '', progressText: '等待导出' });
        });

        try {
            const result = await window.ArchiveManager.exportSelectedConversations(items, (id, patch) => {
                this.applyStatusUpdate(id, patch);
            });
            this.log('exportSelected:success', result);
            await this.markItemsAsExported(items, result);

            if (window.globalToastManager) {
                const summary = `导出完成：成功 ${result.exportedCount}，失败 ${result.failureCount}`;
                if (result.failureCount > 0) {
                    const detail = result.mode === 'local'
                        ? `已降级为本地 ZIP 下载。${this.formatFailureSummary(result.failures)}`
                        : this.formatFailureSummary(result.failures);
                    window.globalToastManager.warning(`${summary}。${detail}`);
                } else {
                    const successMessage = result.mode === 'local'
                        ? `${summary}。已下载本地 ZIP 归档`
                        : summary;
                    window.globalToastManager.success(successMessage);
                }
            }
        } catch (error) {
            this.logError('exportSelected:error', error);
            if (window.globalToastManager) {
                window.globalToastManager.error(`导出失败：${error.message || '未知错误'}`);
            }
        }
    }

    async retryItem(id) {
        const item = (this.getState('items') || []).find((candidate) => candidate.id === id);
        this.log('retryItem:start', { id, title: item?.title || '' });
        if (!item) return;

        try {
            const result = await window.ArchiveManager.retryConversation(item, (itemId, patch) => {
                this.applyStatusUpdate(itemId, patch);
            });
            await this.markItemsAsExported([item], result);
            this.log('retryItem:success', { id, title: item.title });
            if (window.globalToastManager) {
                window.globalToastManager.success(`重试完成：${item.title}`);
            }
        } catch (error) {
            this.logError('retryItem:error', { id, error });
            this.applyStatusUpdate(id, {
                status: 'failed',
                error: error.message || '重试失败',
                progressText: '重试失败'
            });
            if (window.globalToastManager) {
                window.globalToastManager.error(`重试失败：${error.message || '未知错误'}`);
            }
        }
    }

    async reExportItem(id) {
        const item = (this.getState('items') || []).find((candidate) => candidate.id === id);
        if (!item) return;

        this.log('reExportItem:start', { id, title: item.title, exportState: item.exportState });
        item.selected = true;
        this.setState('items', [...(this.getState('items') || [])]);
        this.renderList();
        this.renderToolbarState();
        await this.retryItem(id);
    }

    getStatusLabel(status) {
        switch (status) {
            case 'queued': return '排队中';
            case 'running': return '导出中';
            case 'success': return '成功';
            case 'partial': return '部分成功';
            case 'failed': return '失败';
            default: return '未导出';
        }
    }

    getExportStateLabel(state) {
        switch (state) {
            case 'exported': return '已导出';
            case 'updated': return '有更新';
            default: return '未导出';
        }
    }

    formatFailureSummary(failures) {
        if (!Array.isArray(failures) || failures.length === 0) return '';
        return failures.slice(0, 3).map((item) => item.rawMessage || item.message || '未知错误').join('；');
    }

    async readCache() {
        try {
            const result = await chrome.storage.local.get(this.cacheKey);
            this.log('readCache', {
                hasCache: !!result?.[this.cacheKey],
                cacheKey: this.cacheKey
            });
            return result?.[this.cacheKey] || null;
        } catch {
            this.logError('readCache:error');
            return null;
        }
    }

    async writeCache(cache) {
        try {
            await chrome.storage.local.set({
                [this.cacheKey]: cache
            });
            this.log('writeCache', {
                cacheKey: this.cacheKey,
                platform: cache?.platform || '',
                count: cache?.items?.length || 0
            });
        } catch {}
    }

    async readExportHistory() {
        try {
            const result = await chrome.storage.local.get(this.exportHistoryKey);
            const history = result?.[this.exportHistoryKey] || {};
            this.log('readExportHistory', {
                count: Object.keys(history).length
            });
            return history;
        } catch (error) {
            this.logError('readExportHistory:error', error);
            return {};
        }
    }

    async writeExportHistory(history) {
        try {
            await chrome.storage.local.set({
                [this.exportHistoryKey]: history
            });
            this.log('writeExportHistory', {
                count: Object.keys(history || {}).length
            });
        } catch (error) {
            this.logError('writeExportHistory:error', error);
        }
    }

    getHistoryKey(item) {
        return `${item.platform || this.getState('platform') || 'unknown'}:${item.sourceConversationId || item.id}`;
    }

    async applyExportHistory(rawItems, options = {}) {
        const history = await this.readExportHistory();
        return (rawItems || []).map((item) => {
            const driveEntry = options.skipDrive ? null : this.getDriveEntryForItem(item);
            const entry = driveEntry || history[this.getHistoryKey(item)];
            const exportState = this.getExportState(item, entry);
            return {
                ...item,
                selected: item.isCurrent || false,
                exportState,
                lastExportedAt: entry?.lastExportedAt || entry?.modifiedTime || ''
            };
        });
    }

    async refreshDriveStatusIndex(options = {}) {
        try {
            const force = !!options.force;
            const now = Date.now();
            if (!force && this.driveStatusFetchedAt && (now - this.driveStatusFetchedAt) < this.driveStatusTtlMs) {
                this.log('refreshDriveStatusIndex:cacheHit', {
                    ageMs: now - this.driveStatusFetchedAt,
                    count: this.driveStatusIndex.size
                });
                return;
            }
            const response = await window.ArchiveManager.listDriveExports();
            const nextIndex = new Map();
            const nextNameIndex = new Map();
            if (response?.authenticated) {
                (response.files || []).forEach((file) => {
                    const sourceConversationId = String(file.sourceConversationId || '').trim();
                    if (sourceConversationId) {
                        const existingById = nextIndex.get(sourceConversationId);
                        if (!existingById || new Date(file.modifiedTime || 0).getTime() > new Date(existingById.modifiedTime || 0).getTime()) {
                            nextIndex.set(sourceConversationId, file);
                        }
                    }

                    const key = this.normalizeDriveName(file.name || '');
                    if (key) {
                        const existingByName = nextNameIndex.get(key);
                        if (!existingByName || new Date(file.modifiedTime || 0).getTime() > new Date(existingByName.modifiedTime || 0).getTime()) {
                            nextNameIndex.set(key, file);
                        }
                    }
                });
            }
            this.driveStatusIndex = nextIndex;
            this.driveStatusNameIndex = nextNameIndex;
            this.driveStatusFetchedAt = now;
            this.log('refreshDriveStatusIndex', {
                authenticated: !!response?.authenticated,
                idCount: nextIndex.size,
                nameCount: nextNameIndex.size
            });
        } catch (error) {
            this.logError('refreshDriveStatusIndex:error', error);
            this.driveStatusIndex = new Map();
            this.driveStatusNameIndex = new Map();
            this.driveStatusFetchedAt = 0;
        }
    }

    normalizeDriveName(name) {
        return String(name || '').replace(/\.md$/i, '').replace(/_\d+$/, '').toLowerCase();
    }

    getDriveEntryForItem(item) {
        const sourceConversationId = String(item.sourceConversationId || item.id || '').trim();
        if (sourceConversationId && this.driveStatusIndex.has(sourceConversationId)) {
            return this.driveStatusIndex.get(sourceConversationId) || null;
        }
        const baseName = this.normalizeDriveName(this.sanitizeMarkdownFileName(item.title || 'conversation'));
        return this.driveStatusNameIndex.get(baseName) || null;
    }

    sanitizeMarkdownFileName(input) {
        const clean = String(input || 'conversation')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, '_')
            .trim();
        const fileName = clean || 'conversation';
        return fileName.endsWith('.md') ? fileName : `${fileName}.md`;
    }

    getExportState(item, entry) {
        if (!entry) return 'never';
        const sourceUpdatedAt = item.updatedAt || '';
        const driveUpdatedAt = entry.sourceUpdatedAt || entry.modifiedTime || '';
        if (sourceUpdatedAt && driveUpdatedAt) {
            const sourceTime = new Date(sourceUpdatedAt).getTime();
            const driveTime = new Date(driveUpdatedAt).getTime();
            if (!Number.isNaN(sourceTime) && !Number.isNaN(driveTime) && sourceTime > driveTime) {
                return 'updated';
            }
        }
        if (item.updatedAt && entry.sourceUpdatedAt && item.updatedAt !== entry.sourceUpdatedAt) {
            return 'updated';
        }
        if (item.title && entry.title && item.title !== entry.title) {
            return 'updated';
        }
        return 'exported';
    }

    async markItemsAsExported(items, result) {
        if (!items?.length) return;
        const history = await this.readExportHistory();
        const batchId = result?.batchId || '';
        const now = new Date().toISOString();
        const failedIds = new Set();

        (result?.failures || []).forEach((failure) => {
            if (failure?.conversationId) failedIds.add(String(failure.conversationId));
        });

        items.forEach((item) => {
            if (failedIds.has(String(item.sourceConversationId || item.id))) return;
            history[this.getHistoryKey(item)] = {
                lastExportedAt: now,
                sourceUpdatedAt: item.updatedAt || '',
                title: item.title || '',
                batchId,
                mode: result?.mode || 'drive'
            };
        });

        await this.writeExportHistory(history);
        const refreshedItems = await this.applyExportHistory(this.getState('items') || []);
        this.setState('items', refreshedItems);
        this.renderList();
        this.renderToolbarState();
    }

    formatDateTime(value) {
        if (!value) return '未知时间';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '未知时间' : date.toLocaleString();
    }

    escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}
