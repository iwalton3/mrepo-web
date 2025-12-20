/**
 * Checkbox - Checkbox input with label
 */
import { defineComponent, html, when } from '../../lib/framework.js';

export default defineComponent('cl-checkbox', {
    props: {
        checked: false,
        value: null,  // Used for x-model compatibility - null means "not set by x-model"
        disabled: false,
        label: '',
        binary: true,
        checkboxValue: ''  // Renamed from 'value' for non-binary mode
    },

    methods: {
        handleChange(e) {
            const checked = e.target.checked;
            if (this.props.binary) {
                this.emitChange(e, checked);
            } else {
                this.emitChange(e, checked ? this.props.checkboxValue : null);
            }
        },

        // Get the actual checked state (supports both 'checked' and 'value' props for x-model)
        getCheckedState() {
            // x-model sets 'value' prop, manual usage sets 'checked' prop
            // If value is a boolean, use it; otherwise use checked
            if (typeof this.props.value === 'boolean') {
                return this.props.value;
            }
            return this.props.checked;
        }
    },

    template() {
        const isChecked = this.getCheckedState();

        return html`
            <div class="cl-checkbox-wrapper">
                <label class="${this.props.disabled ? 'disabled' : ''}">
                    <input
                        type="checkbox"
                        checked="${isChecked}"
                        disabled="${this.props.disabled}"
                        on-change="handleChange">
                    <span class="checkmark"></span>
                    ${when(this.props.label, html`
                        <span class="label-text">${this.props.label}</span>
                    `)}
                </label>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: inline-block;
        }

        .cl-checkbox-wrapper {
            display: inline-flex;
        }

        label {
            display: inline-flex;
            align-items: center;
            position: relative;
            cursor: pointer;
            user-select: none;
            gap: 8px;
        }

        label.disabled {
            cursor: not-allowed;
            opacity: 0.6;
        }

        input[type="checkbox"] {
            position: absolute;
            opacity: 0;
            cursor: pointer;
            height: 0;
            width: 0;
        }

        .checkmark {
            position: relative;
            height: 18px;
            width: 18px;
            border: 2px solid var(--input-border, #ced4da);
            border-radius: 3px;
            background: var(--input-bg, #fff);
            transition: all 0.2s;
        }

        label:hover input:not(:disabled) ~ .checkmark {
            border-color: var(--primary-color, #007bff);
        }

        input:checked ~ .checkmark {
            background: var(--primary-color, #007bff);
            border-color: var(--primary-color, #007bff);
        }

        .checkmark:after {
            content: "";
            position: absolute;
            display: none;
            left: 4px;
            top: 1px;
            width: 4px;
            height: 8px;
            border: solid white;
            border-width: 0 2px 2px 0;
            transform: rotate(45deg);
        }

        input:checked ~ .checkmark:after {
            display: block;
        }

        input:focus ~ .checkmark {
            box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.1);
        }

        .label-text {
            font-size: 14px;
            color: var(--text-color, #333);
        }
    `
});
