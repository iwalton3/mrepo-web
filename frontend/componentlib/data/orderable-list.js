/**
 * OrderableList - Drag and drop reorderable list
 */
import { defineComponent, html, when, each } from '../../lib/framework.js';

export default defineComponent('cl-orderable-list', {
    props: {
        value: [],
        itemlabel: 'label',
        header: 'List Items'
    },

    data() {
        return {
            dragIndex: null
        };
    },

    methods: {
        isTouchDevice() {
            return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        },

        // Desktop drag handlers
        handleDragStart(index, event) {
            this.state.dragIndex = index;
            event.dataTransfer.effectAllowed = 'move';
            event.target.classList.add('dragging');
        },

        handleDragEnd(event) {
            event.target.classList.remove('dragging');
            this.querySelectorAll('.drop-target, .drop-target-after').forEach(el => {
                el.classList.remove('drop-target', 'drop-target-after');
            });
            this.state.dragIndex = null;
            this._dropPosition = null;
        },

        handleDragOver(index, event) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (this.state.dragIndex !== null && this.state.dragIndex !== index) {
                const item = event.currentTarget;

                // Determine if we're in the top or bottom half of the item
                const rect = item.getBoundingClientRect();
                const midpoint = rect.top + rect.height / 2;
                const isBottomHalf = event.clientY > midpoint;

                // Clear previous indicators
                this.querySelectorAll('.drop-target, .drop-target-after').forEach(el => {
                    el.classList.remove('drop-target', 'drop-target-after');
                });

                if (isBottomHalf) {
                    item.classList.add('drop-target-after');
                    this._dropPosition = index + 1;
                } else {
                    item.classList.add('drop-target');
                    this._dropPosition = index;
                }
            }
        },

        handleDragLeave(event) {
            const relatedTarget = event.relatedTarget;
            if (!relatedTarget || !event.currentTarget.contains(relatedTarget)) {
                event.currentTarget.classList.remove('drop-target', 'drop-target-after');
            }
        },

        handleDrop(index, event) {
            event.preventDefault();
            this.querySelectorAll('.drop-target, .drop-target-after').forEach(el => {
                el.classList.remove('drop-target', 'drop-target-after');
            });

            const dragIndex = this.state.dragIndex;
            if (dragIndex === null || this._dropPosition === null || this._dropPosition === undefined) {
                return;
            }

            if (dragIndex !== this._dropPosition && dragIndex !== this._dropPosition - 1) {
                this._reorderItemsToPosition(dragIndex, this._dropPosition);
            }
            this.state.dragIndex = null;
            this._dropPosition = null;
        },

        // Touch drag handlers for mobile
        handleHandleTouchStart(index, e) {
            e.stopPropagation();
            e.preventDefault();
            this._touchDragIndex = index;

            const sourceItem = this.querySelectorAll('.list-item')[index];
            if (sourceItem) {
                sourceItem.classList.add('dragging');
            }
        },

        handleHandleTouchMove(e) {
            if (this._touchDragIndex === null || this._touchDragIndex === undefined) return;
            e.stopPropagation();
            e.preventDefault();

            const touch = e.touches[0];

            // Clear previous drop-target classes
            this.querySelectorAll('.drop-target, .drop-target-after').forEach(el => {
                el.classList.remove('drop-target', 'drop-target-after');
            });

            // Reset drop index
            this._touchDropIndex = null;

            // Find which item we're over
            const elemUnder = document.elementFromPoint(touch.clientX, touch.clientY);
            if (elemUnder) {
                const listItem = elemUnder.closest('.list-item');
                if (listItem && !listItem.classList.contains('dragging')) {
                    const items = Array.from(this.querySelectorAll('.list-item'));
                    const itemIndex = items.indexOf(listItem);
                    if (itemIndex !== -1 && itemIndex !== this._touchDragIndex) {
                        // Determine if we're in the top or bottom half of the item
                        const rect = listItem.getBoundingClientRect();
                        const midpoint = rect.top + rect.height / 2;
                        const isBottomHalf = touch.clientY > midpoint;

                        if (isBottomHalf) {
                            // Drop after this item
                            listItem.classList.add('drop-target-after');
                            this._touchDropIndex = itemIndex + 1;
                        } else {
                            // Drop before this item
                            listItem.classList.add('drop-target');
                            this._touchDropIndex = itemIndex;
                        }
                    }
                }
            }
        },

        handleHandleTouchEnd(e) {
            e.stopPropagation();
            e.preventDefault();

            // Clear all drag classes
            this.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
            this.querySelectorAll('.drop-target, .drop-target-after').forEach(el => {
                el.classList.remove('drop-target', 'drop-target-after');
            });

            // Perform the reorder if we have valid indices
            if (this._touchDragIndex !== null && this._touchDragIndex !== undefined &&
                this._touchDropIndex !== null && this._touchDropIndex !== undefined &&
                this._touchDragIndex !== this._touchDropIndex) {
                this._reorderItemsToPosition(this._touchDragIndex, this._touchDropIndex);
            }

            this._touchDragIndex = null;
            this._touchDropIndex = null;
        },

        _reorderItems(fromIndex, toIndex) {
            const items = [...(this.props.value || [])];
            const [moved] = items.splice(fromIndex, 1);

            // When moving down, adjust for the index shift after removal
            const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
            items.splice(insertIndex, 0, moved);

            this.emitChange(null, items);
        },

        // For touch drag - toPosition is the target position in the list, not an item index
        _reorderItemsToPosition(fromIndex, toPosition) {
            const items = [...(this.props.value || [])];
            const [moved] = items.splice(fromIndex, 1);

            // Adjust position if we removed an item before the target
            const insertIndex = fromIndex < toPosition ? toPosition - 1 : toPosition;
            items.splice(insertIndex, 0, moved);

            this.emitChange(null, items);
        },

        getItemLabel(item) {
            return typeof item === 'object' ? item[this.props.itemlabel] : item;
        }
    },

    template() {
        const items = this.props.value || [];
        const isTouchDevice = this.isTouchDevice();

        return html`
            <div class="cl-orderable-list">
                ${when(this.props.header, html`
                    <div class="list-header">${this.props.header}</div>
                `)}
                <div class="list-container">
                    ${when(items.length === 0, html`
                        <div class="empty-message">No items</div>
                    `)}
                    ${each(items, (item, index) => html`
                        <div
                            class="list-item"
                            draggable="${!isTouchDevice}"
                            on-dragstart="${(e) => { if (!isTouchDevice) this.handleDragStart(index, e); }}"
                            on-dragend="handleDragEnd"
                            on-dragover="${(e) => this.handleDragOver(index, e)}"
                            on-dragleave="handleDragLeave"
                            on-drop="${(e) => this.handleDrop(index, e)}">
                            <span class="drag-handle"
                                  on-touchstart="${(e) => this.handleHandleTouchStart(index, e)}"
                                  on-touchmove="${(e) => this.handleHandleTouchMove(e)}"
                                  on-touchend="${(e) => this.handleHandleTouchEnd(e)}">⋮⋮</span>
                            <span class="item-label">${this.getItemLabel(item)}</span>
                        </div>
                    `)}
                </div>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .cl-orderable-list {
            border: 1px solid var(--input-border, #dee2e6);
            border-radius: 4px;
            overflow: hidden;
            background: var(--card-bg, white);
        }

        .list-header {
            padding: 12px;
            background: var(--table-header-bg, #f8f9fa);
            border-bottom: 1px solid var(--input-border, #dee2e6);
            font-weight: 600;
            font-size: 14px;
        }

        .list-container {
            max-height: 400px;
            overflow-y: auto;
        }

        .list-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px;
            border-bottom: 1px solid var(--input-border, #dee2e6);
            cursor: move;
            transition: background 0.15s;
            background: var(--card-bg, white);
            user-select: none;
            -webkit-user-select: none;
        }

        .list-item:last-child {
            border-bottom: none;
        }

        .list-item:hover {
            background: var(--hover-bg, #f8f9fa);
        }

        .list-item.dragging {
            opacity: 0.5;
            background: var(--hover-bg, #f8f9fa);
        }

        .list-item.drop-target {
            box-shadow: inset 0 2px 0 0 var(--primary-color, #007bff);
        }

        .list-item.drop-target-after {
            box-shadow: inset 0 -2px 0 0 var(--primary-color, #007bff);
        }

        .drag-handle {
            color: var(--text-color, #333);
            font-size: 16px;
            cursor: grab;
            user-select: none;
            padding: 4px;
            touch-action: none;
        }

        .drag-handle:active {
            cursor: grabbing;
        }

        .item-label {
            flex: 1;
            font-size: 14px;
            color: var(--text-color, #333);
        }

        .empty-message {
            padding: 20px;
            text-align: center;
            color: var(--text-muted, #6c757d);
        }

        /* Mobile */
        @media (max-width: 767px) {
            .drag-handle {
                padding: 0.75rem 0.5rem;
            }
        }
    `
});
