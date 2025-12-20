/**
 * InputNumber - Number input with increment/decrement buttons
 *
 * Accessibility features:
 * - Proper label association via id/for attributes
 * - aria-label on increment/decrement buttons
 * - aria-describedby for error messages
 * - aria-invalid for error state
 */
import { defineComponent, html, when } from '../../lib/framework.js';

// Counter for unique IDs
let inputNumberIdCounter = 0;

export default defineComponent('cl-input-number', {
    props: {
        value: 0,
        min: null,
        max: null,
        step: 1,
        disabled: false,
        label: '',
        showbuttons: true,
        error: ''
    },

    data() {
        return {
            inputId: `cl-input-number-${++inputNumberIdCounter}`
        };
    },

    methods: {
        handleInput(e) {
            const value = parseFloat(e.target.value) || 0;
            this.emitValue(value);
        },

        handleChange(e) {
            // Stop the native change event from bubbling up
            // This prevents x-model from receiving the native event (which lacks detail.value)
            if (e && e.stopPropagation) {
                e.stopPropagation();
            }
            // Emit a proper change event with the current value
            const value = parseFloat(e.target.value) || 0;
            this.emitChange(e, value);
        },

        increment() {
            if (this.props.disabled) return;
            let newValue = this.props.value + this.props.step;
            if (this.props.max !== null && newValue > this.props.max) {
                newValue = this.props.max;
            }
            this.emitChange(null, newValue);
        },

        decrement() {
            if (this.props.disabled) return;
            let newValue = this.props.value - this.props.step;
            if (this.props.min !== null && newValue < this.props.min) {
                newValue = this.props.min;
            }
            this.emitChange(null, newValue);
        },

        emitValue(value) {
            if (this.props.min !== null && value < this.props.min) value = this.props.min;
            if (this.props.max !== null && value > this.props.max) value = this.props.max;
            this.emitChange(null, value);
        }
    },

    template() {
        const canDecrement = this.props.min === null || this.props.value > this.props.min;
        const canIncrement = this.props.max === null || this.props.value < this.props.max;
        const inputId = this.state.inputId;
        const errorId = `${inputId}-error`;
        const hasError = !!this.props.error;

        return html`
            <div class="cl-input-wrapper">
                ${when(this.props.label, html`
                    <label class="cl-label" for="${inputId}">${this.props.label}</label>
                `)}
                <div class="input-number-container">
                    ${when(this.props.showbuttons, html`
                        <button
                            type="button"
                            class="btn-decrement"
                            disabled="${this.props.disabled || !canDecrement}"
                            aria-label="Decrease value"
                            on-click="decrement">−</button>
                    `)}
                    <input
                        type="number"
                        id="${inputId}"
                        value="${this.props.value}"
                        min="${this.props.min}"
                        max="${this.props.max}"
                        step="${this.props.step}"
                        disabled="${this.props.disabled}"
                        aria-invalid="${hasError ? 'true' : undefined}"
                        aria-describedby="${hasError ? errorId : undefined}"
                        on-input="handleInput"
                        on-change="handleChange">
                    ${when(this.props.showbuttons, html`
                        <button
                            type="button"
                            class="btn-increment"
                            disabled="${this.props.disabled || !canIncrement}"
                            aria-label="Increase value"
                            on-click="increment">+</button>
                    `)}
                </div>
                ${when(this.props.error, html`
                    <small class="error-text" id="${errorId}" role="alert">${this.props.error}</small>
                `)}
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .cl-input-wrapper {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .cl-label {
            font-size: 14px;
            font-weight: 500;
            color: var(--text-color, #333);
        }

        .input-number-container {
            display: flex;
            align-items: stretch;
        }

        input {
            font-family: inherit;
            font-size: 14px;
            padding: 10px 12px;
            border: 1px solid var(--input-border, #ced4da);
            background: var(--input-bg, #fff);
            color: var(--text-color, #333);
            flex: 1;
            text-align: center;
            border-left: none;
            border-right: none;
        }

        input:focus {
            outline: none;
            position: relative;
            z-index: 1;
        }

        input:disabled {
            background: var(--disabled-bg, #e9ecef);
            cursor: not-allowed;
            opacity: 0.6;
        }

        button {
            font-size: 16px;
            font-weight: bold;
            padding: 0 16px;
            border: 1px solid var(--input-border, #ced4da);
            background: var(--button-bg, #f8f9fa);
            color: var(--text-color, #333);
            cursor: pointer;
            transition: all 0.2s;
            user-select: none;
        }

        .btn-decrement {
            border-radius: 4px 0 0 4px;
        }

        .btn-increment {
            border-radius: 0 4px 4px 0;
        }

        button:hover:not(:disabled) {
            background: var(--button-hover-bg, #e9ecef);
        }

        button:active:not(:disabled) {
            background: var(--button-active-bg, #dee2e6);
        }

        button:disabled {
            cursor: not-allowed;
            opacity: 0.4;
        }

        .error-text {
            font-size: 12px;
            color: var(--error-color, #dc3545);
        }
    `
});
