/**
 * Timeline Settings Tab - 时间轴设置
 * 
 * 功能：
 * - 提供开关控制上下键跳转对话节点功能
 * - 按↑↓方向键快速浏览对话历史
 * - 控制各平台的箭头键导航功能
 */

class TimelineSettingsTab extends BaseTab {
    constructor() {
        super();
        this.id = 'timeline';
        this.name = typeof getMessageSafe === 'function'
            ? getMessageSafe('pxkmvz', '时间轴设置')
            : '时间轴设置';
        this.icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="9"/>
        </svg>`;
    }
    
    /**
     * 渲染设置内容
     */
    render() {
        const container = document.createElement('div');
        container.className = 'timeline-settings';
        
        // 第一部分：平台列表
        const timelinePlatforms = getPlatformsByFeature('timeline');
        const platformListTitle = `
            <div class="platform-list-title">${chrome.i18n.getMessage('mkvzpx')}</div>
            <div class="platform-list-hint">${chrome.i18n.getMessage('mzkvxp')}</div>
        `;
        
        // 生成平台列表项
        const platformItems = timelinePlatforms.map(platform => {
            const logoHtml = platform.logoPath 
                ? `<img src="${chrome.runtime.getURL(platform.logoPath)}" class="platform-logo" alt="${platform.name}">`
                : `<span class="platform-logo-placeholder">${platform.name.charAt(0)}</span>`;
            
            return `
                <div class="platform-item">
                    <div class="platform-info-left">
                        ${logoHtml}
                        <span class="platform-name">${platform.name}</span>
                    </div>
                    <label class="ait-toggle-switch">
                        <input type="checkbox" class="platform-toggle" data-platform-id="${platform.id}">
                        <span class="ait-toggle-slider"></span>
                    </label>
                </div>
            `;
        }).join('');
        
        // 将所有平台项包裹在统一的背景框中
        const platformSection = `
            <div class="platform-list">
                ${platformListTitle}
                <div class="platform-list-container">
                    ${platformItems}
                </div>
            </div>
        `;
        
        // 分隔线
        const divider = `<div class="divider"></div>`;
        
        // 显示对话时间开关
        const chatTimeLabelSection = `
            <div class="setting-section">
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-label">${chrome.i18n.getMessage('chatTimeLabelTitle')}</div>
                        <div class="setting-hint">
                            ${chrome.i18n.getMessage('chatTimeLabelHint')}
                        </div>
                    </div>
                    <label class="ait-toggle-switch">
                        <input type="checkbox" id="chat-time-label-toggle">
                        <span class="ait-toggle-slider"></span>
                    </label>
                </div>
            </div>
        `;
        
        // 第一部分：长按标记重点对话开关
        const longPressMarkSection = `
            <div class="setting-section">
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-label">${chrome.i18n.getMessage('pxmzkv')}</div>
                        <div class="setting-hint">
                            ${chrome.i18n.getMessage('kzxvpm')}
                        </div>
                    </div>
                    <label class="ait-toggle-switch">
                        <input type="checkbox" id="long-press-mark-toggle">
                        <span class="ait-toggle-slider"></span>
                    </label>
                </div>
            </div>
        `;
        
        // 闪记开关
        const notepadSection = `
            <div class="setting-section">
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-label">${chrome.i18n.getMessage('notepadTitle')}</div>
                        <div class="setting-hint">
                            ${chrome.i18n.getMessage('notepadToggleHint')}
                        </div>
                    </div>
                    <label class="ait-toggle-switch">
                        <input type="checkbox" id="notepad-toggle">
                        <span class="ait-toggle-slider"></span>
                    </label>
                </div>
            </div>
        `;
        
        // 第二部分：箭头键导航开关
        const arrowKeysSection = `
            <div class="setting-section">
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-label">${chrome.i18n.getMessage('vkpmzx')}</div>
                        <div class="setting-hint">
                            ${chrome.i18n.getMessage('xpvmkz')}
                        </div>
                    </div>
                    <label class="ait-toggle-switch">
                        <input type="checkbox" id="arrow-keys-nav-toggle">
                        <span class="ait-toggle-slider"></span>
                    </label>
                </div>
            </div>
        `;
        
        container.innerHTML = chatTimeLabelSection + divider + longPressMarkSection + divider + notepadSection + divider + arrowKeysSection + divider + platformSection;
        
        return container;
    }
    
    /**
     * Tab 激活时加载状态
     */
    async mounted() {
        super.mounted();
        
        // 0. 处理显示对话时间开关（默认开启）
        const chatTimeLabelCheckbox = document.getElementById('chat-time-label-toggle');
        if (chatTimeLabelCheckbox) {
            // 读取当前状态（默认开启）
            try {
                const result = await chrome.storage.local.get('chatTimeLabelEnabled');
                // 默认值为 true（开启）
                chatTimeLabelCheckbox.checked = result.chatTimeLabelEnabled !== false;
            } catch (e) {
                console.error('[TimelineSettingsTab] Failed to load chat time label state:', e);
                chatTimeLabelCheckbox.checked = true;
            }
            
            // 监听开关变化
            this.addEventListener(chatTimeLabelCheckbox, 'change', async (e) => {
                try {
                    const enabled = e.target.checked;
                    
                    // 保存到 Storage
                    await chrome.storage.local.set({ chatTimeLabelEnabled: enabled });
                    
                    // 立即更新当前页面的时间标签显示
                    if (window.chatTimeRecorder) {
                        window.chatTimeRecorder.updateLabelVisibility(enabled);
                    }
                } catch (e) {
                    console.error('[TimelineSettingsTab] Failed to save chat time label state:', e);
                    chatTimeLabelCheckbox.checked = !chatTimeLabelCheckbox.checked;
                }
            });
        }
        
        // 1. 处理闪记开关（默认开启）
        const notepadCheckbox = document.getElementById('notepad-toggle');
        if (notepadCheckbox) {
            try {
                const result = await chrome.storage.local.get('aitNotepadEnabled');
                notepadCheckbox.checked = result.aitNotepadEnabled !== false;
            } catch (e) {
                notepadCheckbox.checked = true;
            }
            
            this.addEventListener(notepadCheckbox, 'change', async (e) => {
                try {
                    const enabled = e.target.checked;
                    await chrome.storage.local.set({ aitNotepadEnabled: enabled });
                    
                    // 立即更新时间轴上闪记按钮的显隐
                    const notepadBtn = document.querySelector('.ait-notepad-btn');
                    if (notepadBtn) {
                        notepadBtn.style.display = enabled ? 'flex' : 'none';
                    }
                    // 关闭时同时收起面板
                    if (!enabled && window.notepadManager && window.notepadManager.isOpen) {
                        window.notepadManager.close();
                    }
                } catch (e) {
                    notepadCheckbox.checked = !notepadCheckbox.checked;
                }
            });
        }
        
        // 2. 处理长按标记重点对话开关（默认开启，无法关闭）
        const longPressCheckbox = document.getElementById('long-press-mark-toggle');
        if (longPressCheckbox) {
            // 设置为默认开启
            longPressCheckbox.checked = true;
            
            // 监听点击事件，阻止关闭并显示提示
            this.addEventListener(longPressCheckbox, 'change', (e) => {
                // 阻止关闭，保持开启状态
                e.target.checked = true;
                
                // 显示 toast 提示
                if (window.globalToastManager) {
                    const message = chrome.i18n.getMessage('qoytxz');
                    window.globalToastManager.info(message, e.target, {
                        duration: 2200,
                        icon: '',  // 不显示图标
                        color: {
                            light: {
                                backgroundColor: '#0d0d0d',  // 浅色模式：黑色背景
                                textColor: '#ffffff',        // 浅色模式：白色文字
                                borderColor: '#0d0d0d'       // 浅色模式：黑色边框
                            },
                            dark: {
                                backgroundColor: '#ffffff',  // 深色模式：白色背景
                                textColor: '#1f2937',        // 深色模式：深灰色文字
                                borderColor: '#e5e7eb'       // 深色模式：浅灰色边框
                            }
                        }
                    });
                }
            });
        }
        
        // 2. 处理全局箭头键导航开关
        const checkbox = document.getElementById('arrow-keys-nav-toggle');
        if (checkbox) {
            // 读取当前状态（默认开启）
            try {
                const result = await chrome.storage.local.get('arrowKeysNavigationEnabled');
                // 默认值为 true（开启）
                checkbox.checked = result.arrowKeysNavigationEnabled !== false;
            } catch (e) {
                console.error('[TimelineSettingsTab] Failed to load state:', e);
                // 读取失败，默认开启
                checkbox.checked = true;
            }
            
            // 监听开关变化
            this.addEventListener(checkbox, 'change', async (e) => {
                try {
                    const enabled = e.target.checked;
                    
                    // 保存到 Storage
                    await chrome.storage.local.set({ arrowKeysNavigationEnabled: enabled });
                } catch (e) {
                    console.error('[TimelineSettingsTab] Failed to save state:', e);
                    
                    // 保存失败，恢复checkbox状态
                    checkbox.checked = !checkbox.checked;
                }
            });
        }
        
        // 3. 处理平台开关
        await this.loadPlatformSettings();
    }
    
    /**
     * 加载并初始化平台设置
     */
    async loadPlatformSettings() {
        try {
            // 从 Storage 读取平台设置
            const result = await chrome.storage.local.get('timelinePlatformSettings');
            const platformSettings = result.timelinePlatformSettings || {};
            
            // 为每个平台开关设置状态和事件
            const platformToggles = document.querySelectorAll('.platform-toggle');
            platformToggles.forEach(toggle => {
                const platformId = toggle.getAttribute('data-platform-id');
                
                // 设置初始状态（默认开启）
                toggle.checked = platformSettings[platformId] !== false;
                
                // 监听开关变化
                this.addEventListener(toggle, 'change', async (e) => {
                    try {
                        const enabled = e.target.checked;
                        
                        // 读取当前所有设置
                        const result = await chrome.storage.local.get('timelinePlatformSettings');
                        const settings = result.timelinePlatformSettings || {};
                        
                        // 更新当前平台
                        settings[platformId] = enabled;
                        
                        // 保存到 Storage
                        await chrome.storage.local.set({ timelinePlatformSettings: settings });
                        
                        // ✅ 特殊处理：Grok 平台关闭时恢复原生时间轴
                        if (platformId === 'grok' && !enabled) {
                            try {
                                const nativeTimeline = document.querySelector('.group\\/timeline');
                                if (nativeTimeline) {
                                    nativeTimeline.style.display = '';
                                }
                            } catch {}
                        }
                    } catch (e) {
                        console.error('[TimelineSettingsTab] Failed to save platform setting:', e);
                        
                        // 保存失败，恢复开关状态
                        toggle.checked = !toggle.checked;
                    }
                });
            });
        } catch (e) {
            console.error('[TimelineSettingsTab] Failed to load platform settings:', e);
        }
    }
    
    /**
     * Tab 卸载时清理
     */
    unmounted() {
        super.unmounted();
    }
}
