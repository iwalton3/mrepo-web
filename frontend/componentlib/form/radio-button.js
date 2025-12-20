/**
 * RadioButton - Radio button input
 */
import { defineComponent, html, when } from '../../lib/framework.js';

export default defineComponent('cl-radio-button', {
    props: {
        value: '',
        modelvalue: '',
        name: '',
        disabled: false,
        label: ''
    },

    methods: {
        handleChange(e) {
            if (e.target.checked) {
                this.emitChange(e, this.props.value);
            }
        }
    },

    template() {
        const isChecked = this.props.value === this.props.modelvalue;

        return html`
            <div class="cl-radio-wrapper">
                <label class="${this.props.disabled ? 'disabled' : ''}">
                    <input
                        type="radio"
                        name="${this.props.name}"
                        value="${this.props.value}"
                        checked="${isChecked}"
                        disabled="${this.props.disabled}"
                        on-change="handleChange">
                    <span class="radiomark"></span>
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

        .cl-radio-wrapper {
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

        input[type="radio"] {
            position: absolute;
            opacity: 0;
            cursor: pointer;
            height: 0;
            width: 0;
        }

        .radiomark {
            position: relative;
            height: 18px;
            width: 18px;
            border: 2px solid var(--input-border, #ced4da);
            border-radius: 50%;
            background: var(--input-bg, #fff);
            transition: all 0.2s;
        }

        label:hover input:not(:disabled) ~ .radiomark {
            border-color: var(--primary-color, #007bff);
        }

        input:checked ~ .radiomark {
            border-color: var(--primary-color, #007bff);
        }

        .radiomark:after {
            content: "";
            position: absolute;
            display: none;
            top: 3px;
            left: 3px;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--primary-color, #007bff);
        }

        input:checked ~ .radiomark:after {
            display: block;
        }

        input:focus ~ .radiomark {
            box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.1);
        }

        .label-text {
            font-size: 14px;
            color: var(--text-color, #333);
        }
    `
});
