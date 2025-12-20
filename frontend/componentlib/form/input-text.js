/**
 * InputText - Text input with validation
 *
 * Accessibility features:
 * - Proper label association via id/for attributes
 * - aria-describedby for help text and error messages
 * - aria-invalid for error state
 * - aria-required for required fields
 */
import { defineComponent, html, when } from '../../lib/framework.js';

// Counter for unique IDs
let inputTextIdCounter = 0;

export default defineComponent('cl-input-text', {
    props: {
        value: '',
        placeholder: '',
        disabled: false,
        required: false,
        pattern: '',
        minlength: 0,
        maxlength: 0,
        error: '',
        label: '',
        helptext: ''
    },

    data() {
        return {
            internalError: '',
            internalValue: '', // Will be synced in mounted()
            inputId: `cl-input-text-${++inputTextIdCounter}`
        };
    },

    mounted() {
        // Initialize internal value from props
        this.state.internalValue = this.props.value || '';
    },

    propsChanged(prop, newValue, oldValue) {
        // Sync internal value when prop changes (controlled mode)
        if (prop === 'value' && newValue !== this.state.internalValue) {
            this.state.internalValue = newValue || '';
        }
    },

    methods: {
        handleInput(e) {
            if (!e.target) return;
            const value = e.target.value;
            this.state.internalValue = value;
            this.validateInput(value);
            // Emit both input and change events for flexibility
            this.emitInput(e, value);
            this.emitChange(e, value);
        },

        emitInput(e, value) {
            // Stop the native event from bubbling
            if (e && e.stopPropagation) {
                e.stopPropagation();
            }
            // Emit CustomEvent with detail for on-input handlers
            this.dispatchEvent(new CustomEvent('input', {
                bubbles: true,
                composed: true,
                detail: { value }
            }));
        },

        handleBlur(e) {
            if (!e.target) return;
            this.validateInput(e.target.value);
        },

        handleChange(e) {
            // Stop the native change event from bubbling up
            // This prevents x-model from receiving the native event (which lacks detail.value)
            // Instead, we emit our own CustomEvent with the proper format
            if (e && e.stopPropagation) {
                e.stopPropagation();
            }
            // Emit a proper change event with the current value
            this.emitChange(e, this.state.internalValue);
        },

        validateInput(value) {
            if (this.props.required && !value) {
                this.state.internalError = 'This field is required';
                return false;
            }

            if (this.props.pattern && value) {
                const regex = new RegExp(this.props.pattern);
                if (!regex.test(value)) {
                    this.state.internalError = 'Invalid format';
                    return false;
                }
            }

            if (this.props.minlength && value.length < this.props.minlength) {
                this.state.internalError = `Minimum length is ${this.props.minlength}`;
                return false;
            }

            if (this.props.maxlength && value.length > this.props.maxlength) {
                this.state.internalError = `Maximum length is ${this.props.maxlength}`;
                return false;
            }

            this.state.internalError = '';
            return true;
        }
    },

    template() {
        const error = this.props.error || this.state.internalError;
        const hasError = !!error;
        const inputId = this.state.inputId;
        const helpTextId = `${inputId}-help`;
        const errorId = `${inputId}-error`;

        // Build aria-describedby from available elements
        const describedByParts = [];
        if (this.props.helptext && !hasError) describedByParts.push(helpTextId);
        if (hasError) describedByParts.push(errorId);
        const ariaDescribedby = describedByParts.length > 0 ? describedByParts.join(' ') : undefined;

        return html`
            <div class="cl-input-wrapper">
                ${when(this.props.label, html`
                    <label class="cl-label" for="${inputId}">
                        ${this.props.label}
                        ${when(this.props.required, html`<span class="required" aria-hidden="true">*</span>`)}
                    </label>
                `)}
                <input
                    type="text"
                    id="${inputId}"
                    class="${hasError ? 'error' : ''}"
                    value="${this.state.internalValue}"
                    placeholder="${this.props.placeholder}"
                    disabled="${this.props.disabled}"
                    aria-required="${this.props.required ? 'true' : undefined}"
                    aria-invalid="${hasError ? 'true' : undefined}"
                    aria-describedby="${ariaDescribedby}"
                    on-input="handleInput"
                    on-change="handleChange"
                    on-blur="handleBlur">
                ${when(this.props.helptext && !hasError, html`
                    <small class="help-text" id="${helpTextId}">${this.props.helptext}</small>
                `)}
                ${when(hasError, html`
                    <small class="error-text" id="${errorId}" role="alert">${error}</small>
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

        .required {
            color: var(--error-color, #dc3545);
        }

        input {
            font-family: inherit;
            font-size: 14px;
            padding: 10px 12px;
            border: 1px solid var(--input-border, #ced4da);
            border-radius: 4px;
            background: var(--input-bg, #fff);
            color: var(--text-color, #333);
            transition: all 0.2s;
        }

        input:focus {
            outline: none;
            border-color: var(--primary-color, #007bff);
            box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.1);
        }

        input:disabled {
            background: var(--disabled-bg, #e9ecef);
            cursor: not-allowed;
            opacity: 0.6;
        }

        input.error {
            border-color: var(--error-color, #dc3545);
        }

        input.error:focus {
            box-shadow: 0 0 0 3px rgba(220, 53, 69, 0.1);
        }

        .help-text {
            font-size: 12px;
            color: var(--text-muted, #6c757d);
        }

        .error-text {
            font-size: 12px;
            color: var(--error-color, #dc3545);
        }
    `
});
