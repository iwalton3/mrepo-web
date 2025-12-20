/**
 * Button - Styled button component
 */
import { defineComponent, html, when } from '../../lib/framework.js';

export default defineComponent('cl-button', {
    props: {
        label: '',
        icon: '',
        iconpos: 'left', // 'left' or 'right'
        severity: 'primary', // 'primary', 'secondary', 'success', 'danger', 'warning', 'info'
        outlined: false,
        text: false,
        disabled: false,
        loading: false
    },

    methods: {
        handleClick(e) {
            // Stop the native event from bubbling to prevent double firing
            e.stopPropagation();

            if (!this.props.disabled && !this.props.loading) {
                this.emitEvent('click', e);
            }
        },

        emitEvent(name, detail) {
            this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
        }
    },

    template() {
        const classes = [
            'cl-button',
            this.props.severity,
            this.props.outlined ? 'outlined' : '',
            this.props.text ? 'text' : '',
            this.props.loading ? 'loading' : ''
        ].filter(Boolean).join(' ');

        return html`
            <button
                class="${classes}"
                disabled="${this.props.disabled || this.props.loading}"
                on-click="handleClick">
                ${when(this.props.loading, html`
                    <span class="spinner"></span>
                `)}
                ${when(this.props.icon && this.props.iconpos === 'left' && !this.props.loading, html`
                    <span class="button-icon">${this.props.icon}</span>
                `)}
                ${when(this.props.label, html`
                    <span class="button-label">${this.props.label}</span>
                `)}
                ${when(!this.props.label && this.props.children.length > 0, html`
                    ${this.props.children}
                `)}
                ${when(this.props.icon && this.props.iconpos === 'right' && !this.props.loading, html`
                    <span class="button-icon">${this.props.icon}</span>
                `)}
            </button>
        `;
    },

    styles: /*css*/`
        :host {
            display: inline-block;
        }

        .cl-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            padding: 10px 20px;
            min-height: 38px;
            box-sizing: border-box;
            font-family: inherit;
            font-size: 14px;
            font-weight: 500;
            border: 1px solid;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s;
            user-select: none;
        }

        .cl-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        /* Primary */
        .cl-button.primary {
            background: var(--primary-color, #007bff);
            border-color: var(--primary-color, #007bff);
            color: white;
        }

        .cl-button.primary:hover:not(:disabled) {
            background: #0056b3;
            border-color: #0056b3;
        }

        /* Secondary */
        .cl-button.secondary {
            background: #6c757d;
            border-color: #6c757d;
            color: white;
        }

        .cl-button.secondary:hover:not(:disabled) {
            background: #545b62;
            border-color: #545b62;
        }

        /* Success */
        .cl-button.success {
            background: #28a745;
            border-color: #28a745;
            color: white;
        }

        .cl-button.success:hover:not(:disabled) {
            background: #218838;
            border-color: #218838;
        }

        /* Danger */
        .cl-button.danger {
            background: #dc3545;
            border-color: #dc3545;
            color: white;
        }

        .cl-button.danger:hover:not(:disabled) {
            background: #c82333;
            border-color: #c82333;
        }

        /* Warning */
        .cl-button.warning {
            background: #ffc107;
            border-color: #ffc107;
            color: #212529;
        }

        .cl-button.warning:hover:not(:disabled) {
            background: #e0a800;
            border-color: #e0a800;
        }

        /* Info */
        .cl-button.info {
            background: #17a2b8;
            border-color: #17a2b8;
            color: white;
        }

        .cl-button.info:hover:not(:disabled) {
            background: #138496;
            border-color: #138496;
        }

        /* Outlined variant */
        .cl-button.outlined {
            background: transparent;
        }

        .cl-button.outlined.primary {
            color: var(--primary-color, #007bff);
        }

        .cl-button.outlined.primary:hover:not(:disabled) {
            background: rgba(0, 123, 255, 0.1);
        }

        .cl-button.outlined.secondary {
            color: #6c757d;
        }

        .cl-button.outlined.secondary:hover:not(:disabled) {
            background: rgba(108, 117, 125, 0.1);
        }

        .cl-button.outlined.success {
            color: #28a745;
        }

        .cl-button.outlined.success:hover:not(:disabled) {
            background: rgba(40, 167, 69, 0.1);
        }

        .cl-button.outlined.danger {
            color: #dc3545;
        }

        .cl-button.outlined.danger:hover:not(:disabled) {
            background: rgba(220, 53, 69, 0.1);
        }

        /* Text variant */
        .cl-button.text {
            background: transparent;
            border-color: transparent;
        }

        .cl-button.text.primary {
            color: var(--primary-color, #007bff);
        }

        .cl-button.text.secondary {
            color: #6c757d;
        }

        .cl-button.text.success {
            color: #28a745;
        }

        .cl-button.text.danger {
            color: #dc3545;
        }

        .cl-button.text.warning {
            color: #856404;
        }

        .cl-button.text.info {
            color: #17a2b8;
        }

        .cl-button.text:hover:not(:disabled) {
            background: rgba(0, 0, 0, 0.05);
        }

        /* Loading spinner - sized to match typical icon/text height */
        .spinner {
            width: 1em;
            height: 1em;
            border: 2px solid currentColor;
            border-right-color: transparent;
            border-radius: 50%;
            animation: spin 0.6s linear infinite;
            flex-shrink: 0;
            box-sizing: border-box;
        }

        .button-icon {
            line-height: 1;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    `
});
