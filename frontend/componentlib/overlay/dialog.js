/**
 * Dialog - Modal dialog component
 *
 * Accessibility features:
 * - role="dialog" for screen readers
 * - aria-modal for modal dialogs
 * - aria-labelledby for dialog title
 * - Escape key to close
 * - Close button has aria-label
 * - Focus trap when modal (Tab cycles within dialog)
 * - Auto-focus first focusable element on open
 * - Returns focus to trigger element on close
 */
import { defineComponent, html, when } from '../../lib/framework.js';

// Counter for generating unique IDs for dialog titles
let dialogIdCounter = 0;

// Selector for focusable elements
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export default defineComponent('cl-dialog', {
    props: {
        visible: false,
        header: '',
        footer: '',
        modal: true,
        closable: true,
        dismissablemask: true,
        style: ''
    },

    data() {
        return {
            dialogId: `cl-dialog-${++dialogIdCounter}`
        };
    },

    mounted() {
        // Add global escape key listener
        this._handleKeyDown = (e) => {
            if (e.key === 'Escape' && this.props.visible && this.props.closable) {
                this.close();
            }
        };
        document.addEventListener('keydown', this._handleKeyDown);
    },

    unmounted() {
        // Clean up escape key listener
        if (this._handleKeyDown) {
            document.removeEventListener('keydown', this._handleKeyDown);
        }
        // Restore body scroll if we were preventing it
        document.body.style.overflow = '';
    },

    propsChanged(prop, newValue, oldValue) {
        if (prop === 'visible') {
            if (newValue && !oldValue) {
                // Dialog opening - store the element that had focus
                this._previousFocus = document.activeElement;

                // Prevent body scroll when modal
                if (this.props.modal) {
                    document.body.style.overflow = 'hidden';
                }

                // Focus first focusable element after render
                requestAnimationFrame(() => {
                    this._focusFirstElement();
                });
            } else if (!newValue && oldValue) {
                // Dialog closing - restore focus
                document.body.style.overflow = '';
                if (this._previousFocus && typeof this._previousFocus.focus === 'function') {
                    this._previousFocus.focus();
                }
            }
        }
    },

    methods: {
        close() {
            this.emitChange(null, false, 'visible');
        },

        handleMaskClick() {
            if (this.props.dismissablemask) {
                this.close();
            }
        },

        handleDialogClick(e) {
            e.stopPropagation();
        },

        /**
         * Prevent change events from form elements bubbling up and
         * triggering the dialog's on-change handler
         */
        handleDialogChange(e) {
            // Only stop propagation for events from form elements inside the dialog
            // (not our own change event from close())
            if (e.target !== this) {
                e.stopPropagation();
            }
        },

        /**
         * Focus the first focusable element in the dialog
         */
        _focusFirstElement() {
            const dialog = this.querySelector('.cl-dialog');
            if (!dialog) return;

            const focusable = dialog.querySelectorAll(FOCUSABLE_SELECTOR);
            if (focusable.length > 0) {
                focusable[0].focus();
            }
        },

        /**
         * Handle Tab key for focus trapping
         */
        handleFocusTrap(e) {
            if (e.key !== 'Tab' || !this.props.modal) return;

            const dialog = this.querySelector('.cl-dialog');
            if (!dialog) return;

            const focusable = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR))
                .filter(el => el.offsetParent !== null); // Filter out hidden elements

            if (focusable.length === 0) return;

            const firstFocusable = focusable[0];
            const lastFocusable = focusable[focusable.length - 1];

            if (e.shiftKey) {
                // Shift+Tab: if on first element, go to last
                if (document.activeElement === firstFocusable) {
                    e.preventDefault();
                    lastFocusable.focus();
                }
            } else {
                // Tab: if on last element, go to first
                if (document.activeElement === lastFocusable) {
                    e.preventDefault();
                    firstFocusable.focus();
                }
            }
        }
    },

    template() {
        // children is always an array, slots has named slots
        const footerSlot = this.props.slots.footer || [];
        const hasFooter = this.props.footer || footerSlot.length > 0;
        const titleId = `${this.state.dialogId}-title`;

        // Determine aria-labelledby based on whether we have a header
        const ariaLabelledby = this.props.header ? titleId : undefined;

        return html`
            ${when(this.props.visible, html`
                <div class="cl-dialog-mask ${this.props.modal ? 'modal' : ''}"
                     on-click="handleMaskClick"
                     aria-hidden="true">
                    <div class="cl-dialog"
                         style="${this.props.style}"
                         role="dialog"
                         aria-modal="${this.props.modal ? 'true' : undefined}"
                         aria-labelledby="${ariaLabelledby}"
                         on-click="handleDialogClick"
                         on-change="handleDialogChange"
                         on-keydown="handleFocusTrap">
                        ${when(this.props.header || this.props.closable, html`
                            <div class="dialog-header">
                                <span class="dialog-title" id="${titleId}">${this.props.header}</span>
                                ${when(this.props.closable, html`
                                    <button class="close-btn"
                                            on-click="close"
                                            aria-label="Close dialog"
                                            type="button">×</button>
                                `)}
                            </div>
                        `)}
                        <div class="dialog-content">
                            ${this.props.children}
                        </div>
                        ${when(hasFooter, html`
                            <div class="dialog-footer">
                                ${footerSlot}
                            </div>
                        `)}
                    </div>
                </div>
            `)}
        `;
    },

    styles: /*css*/`
        :host {
            display: contents;
        }

        .cl-dialog-mask {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1100;
        }

        .cl-dialog-mask.hidden {
            display: none;
        }

        .cl-dialog-mask.modal {
            background: rgba(0, 0, 0, 0.5);
        }

        .cl-dialog {
            background: var(--card-bg, white);
            border-radius: 6px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            max-width: 90vw;
            max-height: 90vh;
            display: flex;
            flex-direction: column;
            animation: dialogShow 0.2s ease-out;
        }

        @keyframes dialogShow {
            from {
                opacity: 0;
                transform: scale(0.9);
            }
            to {
                opacity: 1;
                transform: scale(1);
            }
        }

        .dialog-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 20px;
            border-bottom: 1px solid var(--input-border, #dee2e6);
        }

        .dialog-title {
            font-size: 18px;
            font-weight: 600;
            color: var(--text-primary, var(--text-color, #333));
        }

        .close-btn {
            background: none;
            border: none;
            font-size: 28px;
            line-height: 1;
            cursor: pointer;
            color: var(--text-muted, #6c757d);
            padding: 0;
            width: 28px;
            height: 28px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 4px;
            transition: all 0.2s;
        }

        .close-btn:hover {
            background: var(--hover-bg, #f8f9fa);
            color: var(--text-color, #333);
        }

        .dialog-content {
            padding: 20px;
            overflow: auto;
            flex: 1;
        }

        .dialog-footer {
            padding: 12px 20px;
            border-top: 1px solid var(--input-border, #dee2e6);
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }

        /* Handle slot wrapper divs */
        .dialog-footer > div {
            display: flex;
            gap: 8px;
        }
    `
});
