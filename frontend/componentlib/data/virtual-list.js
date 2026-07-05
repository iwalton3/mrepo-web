/**
 * VirtualList - Efficiently renders large lists by only rendering visible items
 * Part of the VDX-UI component library
 *
 * Supports:
 * - Self-scrolling (default) - component has its own scrollbar
 * - Parent scrolling - tracks a parent scrollable container
 * - Window scrolling - tracks the window/document scroll
 */
import { defineComponent, html, memoEach, when } from '../../lib/framework.js';
import { createWindowing } from '../../lib/windowing.js';
import { createRowGestures, gapToRemoveInsertIndex } from '../../lib/gestures.js';

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
        scrollContainer: 'self', // 'self' | 'parent' | 'window' | CSS selector
        reorderable: false      // Enable drag-to-reorder (desktop DnD + touch drag handle)
    },

    data() {
        // Windowing controller owns the visible-range state and scroll/resize
        // plumbing. Created in data() so its state exists for the first render;
        // the scroll mode is applied in mounted() once props are parsed.
        this._win = createWindowing(this, {
            itemHeight: () => Number(this.props.itemHeight) || 50,
            buffer: () => Number(this.props.bufferSize) || 10,
            count: () => (this.props.items || []).length,
            fallbackHeight: () => parseInt(this.props.height) || 400
        });

        // Reorder gestures controller, created here alongside windowing so the
        // template can bind its handlers on the very first render (props aren't
        // parsed yet in data(), so we can't branch on `reorderable` here). Unlike
        // windowing this is unconditional-but-cheap: createRowGestures only builds
        // closures and owns NO listeners/observers/timers of its own - handlers are
        // wired via the template's on-* bindings, which the template only emits
        // when `reorderable` is truthy. So a non-reorderable list pays nothing but
        // a few closures, and there is no attach() to call in mounted().
        //
        // Single-item drags only: the component's selection is single-key
        // (internalSelectedKey), so there is no multi-select set to move as a
        // group - we deliberately omit the `selection` adapter. Consumers who need
        // group drag should compose createWindowing + createRowGestures directly.
        this._gestures = createRowGestures(this, {
            itemHeight: () => Number(this.props.itemHeight) || 50,
            windowing: this._win,
            count: () => (this.props.items || []).length,
            onReorder: (fromIndices, gap) => {
                // Give consumers BOTH the raw insertion gap (for gap-semantic
                // APIs) and the remove-then-insert index (for splice APIs). The
                // component never mutates props.items - the consumer applies the
                // reorder and passes new items back down.
                const from = fromIndices[0];
                const to = gapToRemoveInsertIndex(from, gap);
                this.dispatchEvent(new CustomEvent('reorder', {
                    bubbles: true,
                    composed: true,
                    detail: { fromIndices, gap, from, to }
                }));
            }
        });

        return {
            internalSelectedKey: null  // Track selection by key for memoization compatibility
        };
    },

    mounted() {
        // Initialize selection - prefer selectedKey, fall back to selectedIndex
        this._initializeSelection();

        // Reflect scrollContainer prop to attribute for CSS styling
        this._updateScrollContainerAttribute();

        // (Re-)attach listeners/observers and apply the scroll mode from props
        this._win.attach();
        this._win.setScrollContainer(this.props.scrollContainer);
    },

    unmounted() {
        // Keep the controllers (and their state) for potential reconnection;
        // just drop listeners/observers and abort any in-flight gesture. We
        // cancel() rather than destroy() the gestures controller to mirror
        // _win.detach(): destroy() would permanently no-op it and break
        // reconnection (both controllers are created once in data()).
        this._win.detach();
        this._gestures.cancel();
    },

    propsChanged(prop, newValue, oldValue) {
        if (prop === 'items' || prop === 'itemHeight' || prop === 'bufferSize') {
            this._win.refresh();
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
            this._win.setScrollContainer(newValue);
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

        scrollToIndex(index) {
            this._win.scrollToIndex(index);
        },

        scrollToTop() {
            this._win.scrollToTop();
        },

        scrollToBottom() {
            this._win.scrollToBottom();
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
        },

        // Render a single row. When `reorderable`, the row carries the full
        // gesture suite: whole-row HTML5 DnD on non-touch (draggable + drag
        // handlers) plus a rendered drag handle whose touch handlers drive the
        // touch-drag path. `absIndex` is the item's absolute index in the full
        // items array (visibleStart + local index) - the gesture controller does
        // all gap math in absolute-index space and looks rows up by data-index.
        _renderRow(item, itemKey, isSelected, absIndex) {
            const itemHeight = Number(this.props.itemHeight) || 50;
            const g = this._gestures;

            // Inner content: custom renderItem, or the default title/subtitle.
            let content;
            if (this.props.renderItem && typeof this.props.renderItem === 'function') {
                content = this.props.renderItem(item, itemKey);
            } else {
                const title = item.title || item.name || item.label || String(itemKey);
                const subtitle = item.subtitle || item.description || '';
                content = html`
                    <div class="item-content">
                        <div class="item-title">${title}</div>
                        ${when(subtitle, html`
                            <div class="item-subtitle">${subtitle}</div>
                        `)}
                    </div>
                `;
            }

            if (this.props.reorderable) {
                // Per the gestures passive-safety table: DnD handlers preventDefault
                // and are bound non-passive (on-dragstart/over/leave/drop/end); the
                // handle's touch handlers also preventDefault to suppress scrolling
                // and are bound non-passive (plain on-touchstart/move/end). No
                // tap/long-press handlers are wired here - reorder only.
                return html`
                    <div
                        class="virtual-list-item ${isSelected ? 'selected' : ''}"
                        style="height: ${itemHeight}px;"
                        data-key="${itemKey}"
                        data-index="${absIndex}"
                        draggable="${!g.isTouchDevice()}"
                        on-click="${() => this.handleItemClick(item, itemKey)}"
                        on-dragstart="${(e) => g.dragStart(absIndex, e)}"
                        on-dragover="${(e) => g.dragOver(absIndex, e)}"
                        on-dragleave="${(e) => g.dragLeave(e)}"
                        on-drop="${(e) => g.drop(absIndex, e)}"
                        on-dragend="${(e) => g.dragEnd(e)}">
                        <span
                            class="drag-handle"
                            aria-hidden="true"
                            on-touchstart="${(e) => g.handleTouchStart(absIndex, e)}"
                            on-touchmove="${(e) => g.handleTouchMove(e)}"
                            on-touchend="${(e) => g.handleTouchEnd(e)}">⣿</span>
                        ${content}
                    </div>
                `;
            }

            return html`
                <div
                    class="virtual-list-item ${isSelected ? 'selected' : ''}"
                    style="height: ${itemHeight}px;"
                    data-key="${itemKey}"
                    on-click="${() => this.handleItemClick(item, itemKey)}">
                    ${content}
                </div>
            `;
        }
    },

    template() {
        const items = this.props.items || [];
        const totalHeight = this._win.totalHeight;
        const isSelfScroll = this.props.scrollContainer === 'self';

        const offsetY = this._win.offsetY;

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
                    ${memoEach(items.slice(this._win.visibleStart, this._win.visibleEnd), (item, i) => {
                        // Position is handled by parent's translateY.
                        // Selection is included in key so only affected items re-render.
                        const itemKey = keyFn(item);
                        const isSelected = this.props.selectable && itemKey === selectedKey;
                        const absIndex = this._win.visibleStart + i;
                        return this._renderRow(item, itemKey, isSelected, absIndex);
                    }, (item, i) => {
                        // Include selection state in key so selected/deselected items re-render.
                        const itemKey = keyFn(item);
                        const isSelected = this.props.selectable && itemKey === selectedKey;
                        const base = isSelected ? `${itemKey}-selected` : itemKey;
                        // When reorderable, fold the absolute index into the key.
                        // It is invariant under pure scrolling (visibleStart shifts
                        // cancel the local-index shift), so scroll memoization is
                        // unaffected; but after a consumer applies a reorder the
                        // moved rows get new indices, busting their cache so their
                        // data-index / bound handler indices refresh correctly.
                        return this.props.reorderable ? `${base}-i${this._win.visibleStart + i}` : base;
                    }, { trustKey: true })}
                </div>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
            position: relative;
            /* Windowed rows are replaced as the view scrolls/re-keys; browser
               scroll anchoring must not compensate for that churn (it walks
               the scroll position - worst on Android Chrome). The windowing
               controller also sets this on its scroll target; this covers the
               component's own subtree for any ancestor scroller. */
            overflow-anchor: none;
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

        /* Reorder: the row being dragged */
        .virtual-list-item.dragging {
            opacity: 0.5;
        }

        /* Reorder: insertion-edge indicators. .drag-over marks the top edge
           (insert before), .drag-over-below the bottom edge (insert after). */
        .virtual-list-item.drag-over {
            box-shadow: inset 0 2px 0 0 var(--primary-color, #007bff);
        }

        .virtual-list-item.drag-over-below {
            box-shadow: inset 0 -2px 0 0 var(--primary-color, #007bff);
        }

        /* Reorder: touch drag handle (only rendered when reorderable). Sized as a
           touch-friendly hit target with a grab cursor. */
        .drag-handle {
            flex: 0 0 auto;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 32px;
            min-height: 32px;
            margin-right: 8px;
            margin-left: -8px;
            color: var(--text-muted, #999);
            font-size: 16px;
            line-height: 1;
            cursor: grab;
            touch-action: none;
            user-select: none;
            -webkit-user-select: none;
        }

        .drag-handle:active {
            cursor: grabbing;
        }

        .virtual-list-item.selected .drag-handle {
            color: rgba(255, 255, 255, 0.85);
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
