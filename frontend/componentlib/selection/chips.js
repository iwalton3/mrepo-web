/**
 * Chips - Tag input component
 */
import { defineComponent, html, when, each } from '../../lib/framework.js';

export default defineComponent('cl-chips', {
    props: {
        value: [],
        placeholder: 'Add item...',
        disabled: false,
        label: '',
        max: 0,
        allowduplicates: false,
        separator: ','
    },

    data() {
        return {
            inputValue: '',
            internalValue: [] // Will be synced in mounted()
        };
    },

    mounted() {
        // Initialize internal value from props
        this.state.internalValue = Array.isArray(this.props.value) ? this.props.value : [];
    },

    propsChanged(prop, newValue, oldValue) {
        // Sync internal value when prop changes (controlled mode)
        if (prop === 'value' && Array.isArray(newValue)) {
            this.state.internalValue = newValue;
        } else if (prop === 'value' && !newValue) {
            this.state.internalValue = [];
        }
    },

    methods: {
        handleKeyDown(e) {
            if (e.key === 'Enter' || e.key === this.props.separator) {
                e.preventDefault();
                this.addChip();
            } else if (e.key === 'Backspace' && !this.state.inputValue) {
                this.removeLastChip();
            }
        },

        handleInput(e) {
            let value = e.target.value;

            // Check for separator
            if (value.includes(this.props.separator)) {
                const parts = value.split(this.props.separator);
                value = parts.pop() || '';

                // Add all parts as chips
                parts.forEach(part => {
                    const trimmed = part.trim();
                    if (trimmed) {
                        this.addChipValue(trimmed);
                    }
                });
            }

            this.state.inputValue = value;
        },

        handleBlur() {
            if (this.state.inputValue.trim()) {
                this.addChip();
            }
        },

        handleChange(e) {
            // Stop the native change event from bubbling up
            // This prevents x-model from receiving the native event (which lacks detail.value)
            if (e && e.stopPropagation) {
                e.stopPropagation();
            }
            // Emit proper change event with current chips value
            this.emitChange(e, this.state.internalValue);
        },

        addChip() {
            const value = this.state.inputValue.trim();
            if (value) {
                this.addChipValue(value);
                this.state.inputValue = '';
            }
        },

        addChipValue(value) {
            const currentValue = this.state.internalValue;

            // Check duplicates
            if (!this.props.allowduplicates && currentValue.includes(value)) {
                return;
            }

            // Check max
            if (this.props.max > 0 && currentValue.length >= this.props.max) {
                return;
            }

            const newValue = [...currentValue, value];
            this.state.internalValue = newValue;
            this.emitChange(null, newValue);
        },

        removeChip(index) {
            const currentValue = this.state.internalValue;
            const newValue = currentValue.filter((_, i) => i !== index);
            this.state.internalValue = newValue;
            this.emitChange(null, newValue);
        },

        removeLastChip() {
            const currentValue = this.state.internalValue;
            if (currentValue.length > 0) {
                const newValue = currentValue.slice(0, -1);
                this.state.internalValue = newValue;
                this.emitChange(null, newValue);
            }
        }
    },

    template() {
        const chips = this.state.internalValue;

        return html`
            <div class="cl-chips-wrapper">
                ${when(this.props.label, html`
                    <label class="cl-label">${this.props.label}</label>
                `)}
                <div class="chips-container ${this.props.disabled ? 'disabled' : ''}">
                    ${each(chips, (chip, index) => html`
                        <span class="chip">
                            ${chip}
                            <span class="chip-remove" on-click="${() => this.removeChip(index)}">×</span>
                        </span>
                    `)}
                    <input
                        type="text"
                        class="chip-input"
                        value="${this.state.inputValue}"
                        placeholder="${chips.length === 0 ? this.props.placeholder : ''}"
                        disabled="${this.props.disabled}"
                        on-input="handleInput"
                        on-keydown="handleKeyDown"
                        on-change="handleChange"
                        on-blur="handleBlur">
                </div>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .cl-chips-wrapper {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .cl-label {
            font-size: 14px;
            font-weight: 500;
            color: var(--text-color, #333);
        }

        .chips-container {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border: 1px solid var(--input-border, #ced4da);
            border-radius: 4px;
            background: var(--input-bg, #fff);
            min-height: 42px;
            cursor: text;
            transition: all 0.2s;
        }

        .chips-container:focus-within {
            border-color: var(--primary-color, #007bff);
            box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.1);
        }

        .chips-container.disabled {
            background: var(--disabled-bg, #e9ecef);
            cursor: not-allowed;
            opacity: 0.6;
        }

        .chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 4px 8px;
            background: var(--primary-color, #007bff);
            color: white;
            border-radius: 12px;
            font-size: 13px;
        }

        .chip-remove {
            cursor: pointer;
            font-size: 16px;
            line-height: 1;
            font-weight: bold;
        }

        .chip-remove:hover {
            opacity: 0.8;
        }

        .chip-input {
            flex: 1;
            border: none;
            outline: none;
            background: transparent;
            font-family: inherit;
            font-size: 14px;
            min-width: 120px;
            color: var(--text-color, #333);
        }

        .chip-input:disabled {
            cursor: not-allowed;
        }
    `
});
