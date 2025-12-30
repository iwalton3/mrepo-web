/**
 * VirtualList - Efficiently renders large lists by only rendering visible items
 * Part of the VDX-UI component library
 *
 * Supports:
 * - Self-scrolling (default) - component has its own scrollbar
 * - Parent scrolling - tracks a parent scrollable container
 * - Window scrolling - tracks the window/document scroll
 */
import { defineComponent, html, memoEach, when, flushSync } from '../../lib/framework.js';
import { rafThrottle } from '../../lib/utils.js';

export default defineComponent('cl-virtual-list', {
    props: {
        items: [],
        itemHeight: 50,         // Height of each item in pixels
        bufferSize: 10,         // Number of extra items to render above/below viewport
        renderItem: null,       // Function to render each item (receives item, index)
        keyFn: null,            // Function to get unique key for memoization (receives item)
        height: '400px',        // Container height (only used when scrollContainer="self")
        emptyMessage: 'No items to display',
        loading: false,
        selectable: false,
        selectedIndex: -1,      // DEPRECATED: Use selectedKey for memoization compatibility
        selectedKey: null,      // Key of selected item (using keyFn) - preferred for virtual scroll
        scrollContainer: 'self' // 'self' | 'parent' | 'window' | CSS selector
    },

    data() {
        return {
            scrollTop: 0,
            containerHeight: 0,
            visibleStart: 0,
            visibleEnd: 0,
            internalSelectedKey: null  // Track selection by key for memoization compatibility
        };
    },

    mounted() {
        // Initialize selection - prefer selectedKey, fall back to selectedIndex
        this._initializeSelection();

        // Reflect scrollContainer prop to attribute for CSS styling
        this._updateScrollContainerAttribute();

        // Set up scroll tracking based on scrollContainer prop
        this._setupScrollTracking();

        // Set up resize observer
        this._resizeObserver = new ResizeObserver(() => {
            this._updateDimensions();
        });
        this._resizeObserver.observe(this);

        // Initial update
        this._updateDimensions();
        this._updateVisibleRange();
    },

    unmounted() {
        this._cleanupScrollTracking();
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
        }
    },

    propsChanged(prop, newValue, oldValue) {
        if (prop === 'items') {
            this._updateVisibleRange();
        }
        if (prop === 'selectedKey') {
            this.state.internalSelectedKey = newValue;
        }
        if (prop === 'selectedIndex' && newValue !== -1) {
            // Legacy support: convert index to key
            const keyFn = this.props.keyFn || this._defaultKeyFn;
            const items = this.props.items || [];
            if (newValue >= 0 && newValue < items.length) {
                this.state.internalSelectedKey = keyFn(items[newValue], newValue);
            }
        }
        if (prop === 'scrollContainer') {
            this._updateScrollContainerAttribute();
            this._cleanupScrollTracking();
            this._setupScrollTracking();
        }
    },

    methods: {
        _initializeSelection() {
            const keyFn = this.props.keyFn || this._defaultKeyFn;
            const items = this.props.items || [];

            // Prefer selectedKey if provided
            if (this.props.selectedKey !== null) {
                this.state.internalSelectedKey = this.props.selectedKey;
            } else if (this.props.selectedIndex >= 0 && this.props.selectedIndex < items.length) {
                // Legacy: convert selectedIndex to key
                this.state.internalSelectedKey = keyFn(items[this.props.selectedIndex], this.props.selectedIndex);
            }
        },

        _findIndexByKey(key) {
            if (key === null) return -1;
            const keyFn = this.props.keyFn || this._defaultKeyFn;
            const items = this.props.items || [];
            for (let i = 0; i < items.length; i++) {
                if (keyFn(items[i], i) === key) return i;
            }
            return -1;
        },

        _updateScrollContainerAttribute() {
            // Reflect prop to attribute for CSS styling
            const container = this.props.scrollContainer;
            this.setAttribute('scroll-container', container);

            // Set height CSS variable for self-scroll mode
            if (container === 'self') {
                this.style.setProperty('--virtual-list-height', this.props.height);
            }
        },

        _setupScrollTracking() {
            const container = this.props.scrollContainer;

            // Create throttled scroll handler
            this._scrollHandler = rafThrottle(() => this._handleScroll());

            if (container === 'self') {
                // Self-scrolling mode - listen on this element
                this.addEventListener('scroll', this._scrollHandler);
                this._scrollTarget = this;
            } else if (container === 'window') {
                // Window scroll mode
                window.addEventListener('scroll', this._scrollHandler, true);
                this._scrollTarget = window;
            } else if (container === 'parent') {
                // Find nearest scrollable parent
                this._scrollTarget = this._findScrollableParent();
                if (this._scrollTarget) {
                    this._scrollTarget.addEventListener('scroll', this._scrollHandler);
                } else {
                    // Fall back to window if no scrollable parent found
                    window.addEventListener('scroll', this._scrollHandler, true);
                    this._scrollTarget = window;
                }
            } else {
                // CSS selector
                this._scrollTarget = document.querySelector(container);
                if (this._scrollTarget) {
                    this._scrollTarget.addEventListener('scroll', this._scrollHandler);
                } else {
                    console.warn(`cl-virtual-list: scrollContainer "${container}" not found, falling back to self`);
                    this.addEventListener('scroll', this._scrollHandler);
                    this._scrollTarget = this;
                }
            }
        },

        _cleanupScrollTracking() {
            if (this._scrollHandler) {
                if (this._scrollTarget === window) {
                    window.removeEventListener('scroll', this._scrollHandler, true);
                } else if (this._scrollTarget) {
                    this._scrollTarget.removeEventListener('scroll', this._scrollHandler);
                }
                this._scrollHandler = null;
                this._scrollTarget = null;
            }
        },

        _findScrollableParent() {
            let parent = this.parentElement;
            while (parent) {
                const style = getComputedStyle(parent);
                const overflow = style.overflow + style.overflowY;
                if (overflow.includes('auto') || overflow.includes('scroll')) {
                    return parent;
                }
                parent = parent.parentElement;
            }
            return null;
        },

        _updateDimensions() {
            const container = this.props.scrollContainer;
            let newHeight;

            if (container === 'self') {
                newHeight = this.clientHeight || parseInt(this.props.height) || 400;
            } else if (container === 'window' || this._scrollTarget === window) {
                newHeight = window.innerHeight;
            } else if (this._scrollTarget) {
                newHeight = this._scrollTarget.clientHeight;
            } else {
                newHeight = window.innerHeight;
            }

            if (this.state.containerHeight !== newHeight) {
                this.state.containerHeight = newHeight;
                this._updateVisibleRange();
            }
        },

        _handleScroll() {
            const container = this.props.scrollContainer;

            if (container === 'self') {
                this.state.scrollTop = this.scrollTop;
            } else if (container === 'window' || this._scrollTarget === window) {
                // For window scroll, calculate position relative to this element
                const rect = this.getBoundingClientRect();
                this.state.scrollTop = Math.max(0, -rect.top);
            } else if (this._scrollTarget) {
                // For parent scroll, calculate position relative to this element within the parent
                const parentRect = this._scrollTarget.getBoundingClientRect();
                const thisRect = this.getBoundingClientRect();
                this.state.scrollTop = Math.max(0, parentRect.top - thisRect.top);
            }

            this._updateVisibleRange();
        },

        _updateVisibleRange() {
            const itemHeight = this.props.itemHeight;
            const bufferSize = this.props.bufferSize;
            const totalItems = this.props.items.length;

            const visibleStart = Math.floor(this.state.scrollTop / itemHeight);
            const visibleCount = Math.ceil(this.state.containerHeight / itemHeight);
            const visibleEnd = visibleStart + visibleCount;

            let newStart = Math.max(0, visibleStart - bufferSize);
            let newEnd = Math.min(totalItems, visibleEnd + bufferSize);

            // Bottom locking: ensure visibleStart doesn't cause content to extend past container
            const renderCount = newEnd - newStart;
            const maxVisibleStart = Math.max(0, totalItems - renderCount);
            newStart = Math.min(newStart, maxVisibleStart);

            if (this.state.visibleStart !== newStart || this.state.visibleEnd !== newEnd) {
                // Use flushSync to ensure translateY and item slice update atomically
                flushSync(() => {
                    this.state.visibleStart = newStart;
                    this.state.visibleEnd = newEnd;
                });
            }
        },

        scrollToIndex(index) {
            const itemHeight = this.props.itemHeight;
            const targetScroll = index * itemHeight;

            if (this.props.scrollContainer === 'self') {
                this.scrollTop = targetScroll;
            } else if (this._scrollTarget === window) {
                const rect = this.getBoundingClientRect();
                const currentScroll = window.scrollY;
                window.scrollTo({ top: currentScroll + rect.top + targetScroll, behavior: 'smooth' });
            } else if (this._scrollTarget) {
                const thisRect = this.getBoundingClientRect();
                const parentRect = this._scrollTarget.getBoundingClientRect();
                const offset = thisRect.top - parentRect.top + this._scrollTarget.scrollTop;
                this._scrollTarget.scrollTop = offset + targetScroll;
            }
        },

        scrollToTop() {
            this.scrollToIndex(0);
        },

        scrollToBottom() {
            const totalItems = this.props.items.length;
            this.scrollToIndex(Math.max(0, totalItems - 1));
        },

        handleItemClick(item, key) {
            // Find the index in the full items array
            const index = this._findIndexByKey(key);

            if (this.props.selectable) {
                this.state.internalSelectedKey = key;
                this.dispatchEvent(new CustomEvent('select', {
                    bubbles: true,
                    composed: true,
                    detail: { item, index, key }
                }));
            }

            this.dispatchEvent(new CustomEvent('item-click', {
                bubbles: true,
                composed: true,
                detail: { item, index, key }
            }));
        },

        handleKeyDown(e) {
            if (!this.props.selectable) return;

            const items = this.props.items;
            if (!items || items.length === 0) return;

            const keyFn = this.props.keyFn || this._defaultKeyFn;
            const currentIndex = this._findIndexByKey(this.state.internalSelectedKey);

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const newIndex = Math.min(currentIndex + 1, items.length - 1);
                const newKey = keyFn(items[newIndex], newIndex);
                this.state.internalSelectedKey = newKey;
                this.scrollToIndex(newIndex);
                this.dispatchEvent(new CustomEvent('select', {
                    bubbles: true,
                    composed: true,
                    detail: { item: items[newIndex], index: newIndex, key: newKey }
                }));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const newIndex = Math.max(currentIndex - 1, 0);
                const newKey = keyFn(items[newIndex], newIndex);
                this.state.internalSelectedKey = newKey;
                this.scrollToIndex(newIndex);
                this.dispatchEvent(new CustomEvent('select', {
                    bubbles: true,
                    composed: true,
                    detail: { item: items[newIndex], index: newIndex, key: newKey }
                }));
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (currentIndex >= 0 && currentIndex < items.length) {
                    const key = this.state.internalSelectedKey;
                    this.dispatchEvent(new CustomEvent('item-click', {
                        bubbles: true,
                        composed: true,
                        detail: { item: items[currentIndex], index: currentIndex, key }
                    }));
                }
            }
        },

        // Default key function for memoization
        _defaultKeyFn(item, index) {
            return item.id ?? item.uuid ?? item.key ?? index;
        }
    },

    template() {
        const items = this.props.items || [];
        const itemHeight = this.props.itemHeight;
        const totalHeight = items.length * itemHeight;
        const isSelfScroll = this.props.scrollContainer === 'self';

        const offsetY = this.state.visibleStart * itemHeight;

        // Use provided keyFn or default
        const keyFn = this.props.keyFn || this._defaultKeyFn;

        if (this.props.loading) {
            return html`
                <div class="virtual-list-loading">
                    <cl-spinner label="Loading..."></cl-spinner>
                </div>
            `;
        }

        if (items.length === 0) {
            return html`
                <div class="virtual-list-empty">
                    <span class="empty-icon">📭</span>
                    <span class="empty-message">${this.props.emptyMessage}</span>
                </div>
            `;
        }

        // Read selection state for dependency tracking and key generation
        const selectedKey = this.props.selectable ? this.state.internalSelectedKey : null;

        return html`
            <div
                class="virtual-list-container ${isSelfScroll ? '' : 'parent-scroll'}"
                tabindex="${this.props.selectable ? '0' : '-1'}"
                on-keydown="handleKeyDown">
                <div class="virtual-list-spacer" style="height: ${totalHeight}px;"></div>

                <div class="virtual-list-items" style="transform: translateY(${offsetY}px);">
                    ${memoEach(items.slice(this.state.visibleStart, this.state.visibleEnd), (item) => {
                        // Position is handled by parent's translateY.
                        // Selection is included in key so only affected items re-render.
                        const itemKey = keyFn(item);
                        const isSelected = this.props.selectable && itemKey === selectedKey;

                        if (this.props.renderItem && typeof this.props.renderItem === 'function') {
                            return html`
                                <div
                                    class="virtual-list-item ${isSelected ? 'selected' : ''}"
                                    style="height: ${itemHeight}px;"
                                    data-key="${itemKey}"
                                    on-click="${() => this.handleItemClick(item, itemKey)}">
                                    ${this.props.renderItem(item, itemKey)}
                                </div>
                            `;
                        }

                        const title = item.title || item.name || item.label || String(itemKey);
                        const subtitle = item.subtitle || item.description || '';

                        return html`
                            <div
                                class="virtual-list-item ${isSelected ? 'selected' : ''}"
                                style="height: ${itemHeight}px;"
                                data-key="${itemKey}"
                                on-click="${() => this.handleItemClick(item, itemKey)}">
                                <div class="item-content">
                                    <div class="item-title">${title}</div>
                                    ${when(subtitle, html`
                                        <div class="item-subtitle">${subtitle}</div>
                                    `)}
                                </div>
                            </div>
                        `;
                    }, (item) => {
                        // Include selection state in key so selected/deselected items re-render
                        const itemKey = keyFn(item);
                        const isSelected = this.props.selectable && itemKey === selectedKey;
                        return isSelected ? `${itemKey}-selected` : itemKey;
                    }, { trustKey: true })}
                </div>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
            position: relative;
        }

        /* Self-scroll mode - component has its own scrollbar */
        :host(:not([scroll-container])),
        :host([scroll-container="self"]) {
            overflow-y: auto;
            overflow-x: hidden;
            height: var(--virtual-list-height, 400px);
            border: 1px solid var(--input-border, #ddd);
            border-radius: 4px;
            background: var(--input-bg, #fff);
        }

        /* Parent/window scroll mode - no border, height determined by content */
        :host([scroll-container="parent"]),
        :host([scroll-container="window"]) {
            overflow: visible;
            height: auto;
            border: none;
            background: transparent;
        }

        .virtual-list-container {
            position: relative;
            width: 100%;
            outline: none;
        }

        .virtual-list-spacer {
            width: 100%;
            pointer-events: none;
        }

        .virtual-list-items {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            will-change: transform;
        }

        .virtual-list-item {
            display: flex;
            align-items: center;
            padding: 0 16px;
            border-bottom: 1px solid var(--border-color, #eee);
            transition: background-color 0.15s;
            box-sizing: border-box;
            width: 100%;
            cursor: pointer;
        }

        .virtual-list-item:hover {
            background-color: var(--hover-bg, #f5f5f5);
        }

        .virtual-list-item.selected {
            background-color: var(--primary-color, #007bff);
            color: white;
        }

        .virtual-list-item.selected .item-subtitle {
            color: rgba(255, 255, 255, 0.8);
        }

        .item-content {
            flex: 1;
            min-width: 0;
        }

        .item-title {
            font-weight: 500;
            font-size: 14px;
            color: var(--text-color, #333);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .virtual-list-item.selected .item-title {
            color: white;
        }

        .item-subtitle {
            font-size: 12px;
            color: var(--text-muted, #666);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-top: 2px;
        }

        .virtual-list-loading,
        .virtual-list-empty {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            min-height: 200px;
            color: var(--text-muted, #666);
        }

        .empty-icon {
            font-size: 48px;
            margin-bottom: 16px;
            opacity: 0.5;
        }

        .empty-message {
            font-size: 14px;
        }
    `
});
