/**
 * InputPassword - Password input with visibility toggle and strength meter
 */
import { defineComponent, html, when } from '../../lib/framework.js';

export default defineComponent('cl-input-password', {
    props: {
        value: '',
        placeholder: '',
        disabled: false,
        required: false,
        minlength: 0,
        maxlength: 0,
        error: '',
        label: '',
        helptext: '',
        showStrength: false,    // Show password strength meter
        showToggle: true,       // Show visibility toggle button
        feedback: true          // Show feedback messages
    },

    data() {
        return {
            internalError: '',
            internalValue: '',
            passwordVisible: false,
            strength: 0,
            strengthLabel: ''
        };
    },

    mounted() {
        this.state.internalValue = this.props.value || '';
        if (this.props.showStrength) {
            this.calculateStrength(this.state.internalValue);
        }
    },

    propsChanged(prop, newValue, oldValue) {
        if (prop === 'value' && newValue !== this.state.internalValue) {
            this.state.internalValue = newValue || '';
            if (this.props.showStrength) {
                this.calculateStrength(this.state.internalValue);
            }
        }
    },

    methods: {
        handleInput(e) {
            if (!e.target) return;
            const value = e.target.value;
            this.state.internalValue = value;
            this.validateInput(value);

            if (this.props.showStrength) {
                this.calculateStrength(value);
            }

            this.emitInput(e, value);
            this.emitChange(e, value);
        },

        emitInput(e, value) {
            if (e && e.stopPropagation) {
                e.stopPropagation();
            }
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
            if (e && e.stopPropagation) {
                e.stopPropagation();
            }
            // Emit a proper change event with the current value
            this.emitChange(e, this.state.internalValue);
        },

        toggleVisibility() {
            this.state.passwordVisible = !this.state.passwordVisible;
        },

        validateInput(value) {
            if (this.props.required && !value) {
                this.state.internalError = 'This field is required';
                return false;
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
        },

        calculateStrength(password) {
            if (!password) {
                this.state.strength = 0;
                this.state.strengthLabel = '';
                return;
            }

            let score = 0;
            const checks = {
                length: password.length >= 8,
                lowercase: /[a-z]/.test(password),
                uppercase: /[A-Z]/.test(password),
                numbers: /[0-9]/.test(password),
                special: /[!@#$%^&*(),.?":{}|<>]/.test(password),
                longLength: password.length >= 12
            };

            if (checks.length) score += 1;
            if (checks.lowercase) score += 1;
            if (checks.uppercase) score += 1;
            if (checks.numbers) score += 1;
            if (checks.special) score += 1;
            if (checks.longLength) score += 1;

            // Normalize to 0-100
            this.state.strength = Math.min(100, (score / 6) * 100);

            // Set label
            if (score <= 2) {
                this.state.strengthLabel = 'Weak';
            } else if (score <= 4) {
                this.state.strengthLabel = 'Medium';
            } else {
                this.state.strengthLabel = 'Strong';
            }
        },

        getStrengthColor() {
            if (this.state.strength <= 33) return 'var(--error-color, #dc3545)';
            if (this.state.strength <= 66) return 'var(--warning-color, #ffc107)';
            return 'var(--success-color, #28a745)';
        },

        getStrengthClass() {
            if (this.state.strength <= 33) return 'weak';
            if (this.state.strength <= 66) return 'medium';
            return 'strong';
        },

        getFeedback() {
            if (!this.state.internalValue || !this.props.showStrength || !this.props.feedback) {
                return [];
            }

            const feedback = [];
            const password = this.state.internalValue;

            if (password.length < 8) {
                feedback.push('Use at least 8 characters');
            }
            if (!/[a-z]/.test(password)) {
                feedback.push('Add lowercase letters');
            }
            if (!/[A-Z]/.test(password)) {
                feedback.push('Add uppercase letters');
            }
            if (!/[0-9]/.test(password)) {
                feedback.push('Add numbers');
            }
            if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
                feedback.push('Add special characters');
            }

            return feedback.slice(0, 2); // Show max 2 suggestions
        }
    },

    template() {
        const error = this.props.error || this.state.internalError;
        const hasError = !!error;
        const feedback = this.getFeedback();

        return html`
            <div class="cl-input-wrapper">
                ${when(this.props.label, html`
                    <label class="cl-label">
                        ${this.props.label}
                        ${when(this.props.required, html`<span class="required">*</span>`)}
                    </label>
                `)}
                <div class="password-input-wrapper">
                    <input
                        type="${this.state.passwordVisible ? 'text' : 'password'}"
                        class="${hasError ? 'error' : ''}"
                        value="${this.state.internalValue}"
                        placeholder="${this.props.placeholder}"
                        disabled="${this.props.disabled}"
                        on-input="handleInput"
                        on-change="handleChange"
                        on-blur="handleBlur">
                    ${when(this.props.showToggle !== false && this.props.showToggle !== 'false', html`
                        <button
                            type="button"
                            class="toggle-btn"
                            tabindex="-1"
                            on-click="toggleVisibility"
                            title="${this.state.passwordVisible ? 'Hide password' : 'Show password'}">
                            ${this.state.passwordVisible
                                ? html`<svg class="eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
                                : html`<svg class="eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
                            }
                        </button>
                    `)}
                </div>
                ${when(this.props.showStrength && this.state.internalValue, html`
                    <div class="strength-meter">
                        <div class="strength-bar">
                            <div
                                class="strength-fill ${this.getStrengthClass()}"
                                style="width: ${this.state.strength}%;">
                            </div>
                        </div>
                        <span class="strength-label ${this.getStrengthClass()}">
                            ${this.state.strengthLabel}
                        </span>
                    </div>
                `)}
                ${when(feedback.length > 0 && !hasError, html`
                    <div class="feedback-list">
                        ${feedback.map(f => html`
                            <small class="feedback-item">${f}</small>
                        `)}
                    </div>
                `)}
                ${when(this.props.helptext && !hasError && feedback.length === 0, html`
                    <small class="help-text">${this.props.helptext}</small>
                `)}
                ${when(hasError, html`
                    <small class="error-text">${error}</small>
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

        .password-input-wrapper {
            position: relative;
            display: flex;
            align-items: stretch;
        }

        input {
            flex: 1;
            font-family: inherit;
            font-size: 14px;
            padding: 10px 12px;
            padding-right: 40px;
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

        .toggle-btn {
            position: absolute;
            right: 8px;
            top: 50%;
            transform: translateY(-50%);
            background: none;
            border: none;
            cursor: pointer;
            padding: 4px;
            opacity: 0.6;
            transition: opacity 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .toggle-btn:hover {
            opacity: 1;
        }

        .eye-icon {
            width: 18px;
            height: 18px;
            color: var(--text-muted, #6c757d);
        }

        .strength-meter {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 4px;
        }

        .strength-bar {
            flex: 1;
            height: 4px;
            background: var(--input-border, #e9ecef);
            border-radius: 2px;
            overflow: hidden;
        }

        .strength-fill {
            height: 100%;
            transition: width 0.3s, background-color 0.3s;
        }

        .strength-fill.weak {
            background-color: var(--error-color, #dc3545);
        }

        .strength-fill.medium {
            background-color: var(--warning-color, #ffc107);
        }

        .strength-fill.strong {
            background-color: var(--success-color, #28a745);
        }

        .strength-label {
            font-size: 11px;
            font-weight: 600;
            min-width: 50px;
        }

        .strength-label.weak {
            color: var(--error-color, #dc3545);
        }

        .strength-label.medium {
            color: var(--warning-color, #856404);
        }

        .strength-label.strong {
            color: var(--success-color, #28a745);
        }

        .feedback-list {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .feedback-item {
            font-size: 11px;
            color: var(--text-muted, #6c757d);
        }

        .feedback-item::before {
            content: "\\2022  ";
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
