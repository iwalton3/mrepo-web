/**
 * Toast - Toast notification component
 */
import { defineComponent, html, when, each, Component } from '../../lib/framework.js';

export class ClToast extends Component {
    static props = {
        position: 'top-right', // 'top-right', 'top-left', 'bottom-right', 'bottom-left', 'top-center', 'bottom-center'
        life: 3000
    }

    constructor(props) {
        super(props);

        this.state = {
            messages: []
        };
    }

    show(message) {
        const id = Date.now() + Math.random();
        const toast = {
            id,
            severity: message.severity || 'info',
            summary: message.summary || '',
            detail: message.detail || '',
            life: message.life || this.props.life
        };

        this.state.messages = [...this.state.messages, toast];

        if (toast.life > 0) {
            setTimeout(() => {
                this.remove(id);
            }, toast.life);
        }
    }

    remove(id) {
        const msg = this.state.messages.find(m => m.id === id);
        // Guard against double-remove (auto-dismiss timer + manual close both
        // firing) so we don't restart the exit animation.
        if (!msg || msg.leaving) return;

        // Flag the toast as leaving so it plays the collapse/fade exit; the
        // remaining toasts slide up as this one's row height animates to 0.
        // Keep every other toast's identity/DOM node stable (keyed by id) so
        // none of them re-run the slide-in animation.
        this.state.messages = this.state.messages.map(m =>
            m.id === id ? { ...m, leaving: true } : m
        );

        setTimeout(() => {
            this.state.messages = this.state.messages.filter(m => m.id !== id);
        }, 300); // must match the exit transition duration below
    }

    getSeverityIcon(severity) {
        const icons = {
            success: '✓',
            info: 'ℹ',
            warn: '⚠',
            error: '✕'
        };
        return icons[severity] || icons.info;
    }

    template() {
        const positionClass = this.props.position;

        return html`
            <div class="cl-toast-container ${positionClass}">
                ${each(this.state.messages, message => html`
                    <div class="toast-message ${message.severity} ${message.leaving ? 'leaving' : ''}">
                        <div class="toast-inner">
                            <div class="toast-icon">
                                ${this.getSeverityIcon(message.severity)}
                            </div>
                            <div class="toast-content">
                                ${when(message.summary, html`
                                    <div class="toast-summary">${message.summary}</div>
                                `)}
                                ${when(message.detail, html`
                                    <div class="toast-detail">${message.detail}</div>
                                `)}
                            </div>
                            <button class="toast-close" on-click="${() => this.remove(message.id)}">×</button>
                        </div>
                    </div>
                `, message => message.id)}
            </div>
        `;
    }

    static styles = /*css*/`
        :host {
            display: contents;
        }

        .cl-toast-container {
            position: fixed;
            z-index: 1200;
            display: flex;
            flex-direction: column;
            pointer-events: none;
        }

        .cl-toast-container.top-right {
            top: 20px;
            right: 20px;
        }

        .cl-toast-container.top-left {
            top: 20px;
            left: 20px;
        }

        .cl-toast-container.bottom-right {
            bottom: 20px;
            right: 20px;
        }

        .cl-toast-container.bottom-left {
            bottom: 20px;
            left: 20px;
        }

        .cl-toast-container.top-center {
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
        }

        .cl-toast-container.bottom-center {
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
        }

        /* Wrapper: owns the entry animation and the exit collapse. Using a
           grid row (1fr -> 0fr) lets the toast collapse to nothing regardless
           of its content height, so the toasts below slide up smoothly. */
        .toast-message {
            display: grid;
            grid-template-rows: 1fr;
            margin-bottom: 12px;
            pointer-events: auto;
            animation: slideIn 0.3s ease-out;
            transition: grid-template-rows 0.3s ease,
                        opacity 0.3s ease,
                        margin-bottom 0.3s ease;
        }

        .toast-message.leaving {
            grid-template-rows: 0fr;
            opacity: 0;
            margin-bottom: 0;
        }

        /* Visible card. overflow:hidden + min-height:0 make the grid collapse clip. */
        .toast-inner {
            overflow: hidden;
            min-height: 0;
            display: flex;
            align-items: flex-start;
            gap: 12px;
            padding: 16px;
            background: var(--card-bg, white);
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            min-width: 300px;
            max-width: 400px;
            border-left: 4px solid;
        }

        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateX(100px);
            }
            to {
                opacity: 1;
                transform: translateX(0);
            }
        }

        .toast-message.success .toast-inner {
            border-left-color: #28a745;
        }

        .toast-message.info .toast-inner {
            border-left-color: #17a2b8;
        }

        .toast-message.warn .toast-inner {
            border-left-color: #ffc107;
        }

        .toast-message.error .toast-inner {
            border-left-color: #dc3545;
        }

        .toast-icon {
            font-size: 20px;
            font-weight: bold;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }

        .success .toast-icon {
            color: #28a745;
        }

        .info .toast-icon {
            color: #17a2b8;
        }

        .warn .toast-icon {
            color: #ffc107;
        }

        .error .toast-icon {
            color: #dc3545;
        }

        .toast-content {
            flex: 1;
        }

        .toast-summary {
            font-weight: 600;
            font-size: 14px;
            color: var(--text-color, #333);
            margin-bottom: 4px;
        }

        .toast-detail {
            font-size: 13px;
            color: var(--text-muted, #6c757d);
            line-height: 1.4;
        }

        .toast-close {
            background: none;
            border: none;
            font-size: 20px;
            line-height: 1;
            cursor: pointer;
            color: var(--text-muted, #6c757d);
            padding: 0;
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 4px;
            transition: all 0.2s;
            flex-shrink: 0;
        }

        .toast-close:hover {
            background: var(--hover-bg, #f8f9fa);
            color: var(--text-color, #333);
        }
    `
}

export default defineComponent('cl-toast', ClToast);
