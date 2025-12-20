/**
 * Toggle - Modern toggle/switch component
 *
 * Supports both `checked` and `value` props for x-model compatibility:
 * - Use `checked` for manual boolean binding
 * - Use `value` with x-model for automatic two-way binding
 */
import { defineComponent, html, when } from '../../lib/framework.js';

export default defineComponent('cl-toggle', {
    props: {
        checked: false,
        value: null,             // Used for x-model compatibility - null means "not set by x-model"
        disabled: false,
        label: '',
        labelPosition: 'right',  // 'left' or 'right'
        size: 'medium',          // 'small', 'medium', 'large'
        checkedLabel: '',        // Text shown when on
        uncheckedLabel: ''       // Text shown when off
    },

    data() {
        return {
            internalChecked: false
        };
    },

    mounted() {
        this.state.internalChecked = this._getCheckedState();
    },

    propsChanged(prop, newValue, oldValue) {
        if (prop === 'checked' || prop === 'value') {
            this.state.internalChecked = this._getCheckedState();
        }
    },

    methods: {
        _getCheckedState() {
            // x-model sets 'value' prop, manual usage sets 'checked' prop
            // If value is a boolean, use it; otherwise use checked
            if (typeof this.props.value === 'boolean') {
                return this.props.value;
            }
            return this.props.checked === true || this.props.checked === 'true';
        },

        toggle() {
            if (this.props.disabled) return;

            this.state.internalChecked = !this.state.internalChecked;

            // x-model for custom elements listens to 'change' and expects detail.value
            this.dispatchEvent(new CustomEvent('change', {
                bubbles: true,
                composed: true,
                detail: { value: this.state.internalChecked, checked: this.state.internalChecked }
            }));

            // Also emit 'input' for additional compatibility
            this.dispatchEvent(new CustomEvent('input', {
                bubbles: true,
                composed: true,
                detail: { value: this.state.internalChecked }
            }));
        },

        handleKeyDown(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.toggle();
            }
        }
    },

    template() {
        const sizeClass = `size-${this.props.size}`;
        const positionClass = `label-${this.props.labelPosition}`;
        const statusLabel = this.state.internalChecked ? this.props.checkedLabel : this.props.uncheckedLabel;

        return html`
            <div
                class="cl-toggle-wrapper ${positionClass}"
                on-click="toggle"
                on-keydown="handleKeyDown"
                tabindex="${this.props.disabled ? '-1' : '0'}"
                role="switch"
                aria-checked="${this.state.internalChecked}">
                ${when(this.props.label && this.props.labelPosition === 'left', html`
                    <span class="toggle-label">${this.props.label}</span>
                `)}
                <div class="toggle-track ${sizeClass} ${this.state.internalChecked ? 'checked' : ''} ${this.props.disabled ? 'disabled' : ''}">
                    <div class="toggle-thumb"></div>
                    ${when(this.props.checkedLabel || this.props.uncheckedLabel, html`
                        <span class="toggle-status">${statusLabel}</span>
                    `)}
                </div>
                ${when(this.props.label && this.props.labelPosition === 'right', html`
                    <span class="toggle-label">${this.props.label}</span>
                `)}
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: inline-block;
        }

        .cl-toggle-wrapper {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            cursor: pointer;
            user-select: none;
            outline: none;
        }

        .cl-toggle-wrapper:focus .toggle-track {
            box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.2);
        }

        .toggle-label {
            font-size: 14px;
            color: var(--text-color, #333);
        }

        .toggle-track {
            position: relative;
            background: var(--input-border, #ccc);
            border-radius: 100px;
            transition: all 0.2s;
            display: flex;
            align-items: center;
        }

        .toggle-track.size-small {
            width: 36px;
            height: 20px;
        }

        .toggle-track.size-medium {
            width: 48px;
            height: 26px;
        }

        .toggle-track.size-large {
            width: 60px;
            height: 32px;
        }

        .toggle-track.checked {
            background: var(--primary-color, #007bff);
        }

        .toggle-track.disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .toggle-thumb {
            position: absolute;
            background: var(--input-bg, white);
            border-radius: 50%;
            transition: all 0.2s;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
        }

        .toggle-track.size-small .toggle-thumb {
            width: 16px;
            height: 16px;
            left: 2px;
        }

        .toggle-track.size-medium .toggle-thumb {
            width: 22px;
            height: 22px;
            left: 2px;
        }

        .toggle-track.size-large .toggle-thumb {
            width: 28px;
            height: 28px;
            left: 2px;
        }

        .toggle-track.checked.size-small .toggle-thumb {
            left: 18px;
        }

        .toggle-track.checked.size-medium .toggle-thumb {
            left: 24px;
        }

        .toggle-track.checked.size-large .toggle-thumb {
            left: 30px;
        }

        .toggle-status {
            font-size: 10px;
            font-weight: 600;
            color: white;
            text-transform: uppercase;
            position: absolute;
            opacity: 0;
            transition: opacity 0.2s;
        }

        .toggle-track.checked .toggle-status {
            left: 6px;
            opacity: 1;
        }

        .toggle-track:not(.checked) .toggle-status {
            right: 6px;
            color: var(--text-muted, #666);
            opacity: 1;
        }
    `
});
