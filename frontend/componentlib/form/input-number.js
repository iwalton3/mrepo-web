/**
 * InputNumber - Number input with increment/decrement buttons
 *
 * Accessibility features:
 * - Proper label association via id/for attributes
 * - aria-label on increment/decrement buttons
 * - aria-describedby for error messages
 * - aria-invalid for error state
 *
 * Props:
 * - value: current value (number, or string decimal when mode="string")
 * - min / max: bounds (null = unbounded)
 * - step: increment amount (supports decimals, e.g. 0.01)
 * - disabled, label, error: as usual
 * - showbuttons: render the +/- buttons (default true)
 * - orientation: 'auto' (default) | 'horizontal' | 'vertical'
 *     'auto' lays out horizontally but collapses to vertical (stacked)
 *     buttons via a container query when the control gets too narrow to
 *     fit the horizontal buttons, so it never overlaps neighbours.
 * - mode: 'number' (default) | 'string'
 *     'string' keeps the value as an exact decimal string and steps it
 *     with integer/BigInt math, avoiding float error and the string
 *     concatenation bug (e.g. "100" + step 0.01 -> "1000.01").
 */
import { defineComponent, html, when, Component } from '../../lib/framework.js';

// Counter for unique IDs
let inputNumberIdCounter = 0;

// --- Exact decimal helpers (string in, string out) ---------------------------

const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function isNumericString(str) {
    return NUMERIC_RE.test(String(str).trim());
}

function decimalPlaces(str) {
    const s = String(str);
    const dot = s.indexOf('.');
    return dot === -1 ? 0 : s.length - dot - 1;
}

// Scale a decimal string to a BigInt holding `places` fractional digits.
// Non-numeric / partial input (e.g. "", "-", ".") is treated as 0.
function scaleToBigInt(str, places) {
    let s = String(str).trim();
    if (!isNumericString(s)) s = '0';
    const neg = s[0] === '-';
    s = s.replace(/^[+-]/, '');
    let [int = '0', frac = ''] = s.split('.');
    if (int === '') int = '0';
    frac = (frac + '0'.repeat(places)).slice(0, places);
    const digits = (int + frac).replace(/\D/g, '') || '0';
    const big = BigInt(digits);
    return neg ? -big : big;
}

function formatFromBigInt(big, places) {
    const neg = big < 0n;
    let s = (neg ? -big : big).toString();
    if (places === 0) return (neg ? '-' : '') + s;
    s = s.padStart(places + 1, '0');
    const int = s.slice(0, s.length - places);
    const frac = s.slice(s.length - places);
    return (neg ? '-' : '') + int + '.' + frac;
}

// value +/- step, exact. Result keeps as many decimals as the most precise
// of value/step so a 0.01 step never loses precision.
function decimalStep(valueStr, stepStr, dir) {
    const places = Math.max(decimalPlaces(valueStr), decimalPlaces(stepStr));
    const v = scaleToBigInt(valueStr, places);
    const s = scaleToBigInt(stepStr, places);
    return formatFromBigInt(v + BigInt(dir) * s, places);
}

// Compare two decimal strings: -1 (a<b), 0 (a==b), 1 (a>b)
function compareDecimal(a, b) {
    const places = Math.max(decimalPlaces(a), decimalPlaces(b));
    const av = scaleToBigInt(a, places);
    const bv = scaleToBigInt(b, places);
    return av < bv ? -1 : av > bv ? 1 : 0;
}

function isBounded(bound) {
    return bound !== null && bound !== undefined && bound !== '';
}

/**
 * @fires change - detail: { value }
 */
export class ClInputNumber extends Component {
    static props = {
        value: 0,
        min: null,
        max: null,
        step: 1,
        disabled: false,
        label: '',
        showbuttons: true,
        orientation: 'auto',
        mode: 'number',
        error: ''
    }

    constructor(props) {
        super(props);

        this.state = {
            inputId: `cl-input-number-${++inputNumberIdCounter}`
        };
    }

    isStringMode() {
        return this.props.mode === 'string';
    }

    // Current value as a decimal string (works for both modes)
    valueString() {
        const v = this.props.value;
        return (v === null || v === undefined) ? '' : String(v);
    }

    // Clamp a decimal string to min/max; returns a decimal string.
    // Partial / non-numeric input passes through untouched so users can
    // still type "-" or "1." mid-entry.
    clampString(str) {
        if (!isNumericString(str)) return str;
        if (isBounded(this.props.min) && compareDecimal(str, this.props.min) < 0) {
            return String(this.props.min);
        }
        if (isBounded(this.props.max) && compareDecimal(str, this.props.max) > 0) {
            return String(this.props.max);
        }
        return str;
    }

    // Convert an outgoing decimal string to the type the parent expects.
    coerceOut(str) {
        if (this.isStringMode()) return str;
        const n = parseFloat(str);
        return Number.isNaN(n) ? 0 : n;
    }

    handleInput(e) {
        if (this.isStringMode()) {
            // Keep the raw string so trailing zeros / partial entry survive;
            // final clamping happens on change (blur/enter).
            this.emitChange(null, e.target.value);
            return;
        }
        const value = parseFloat(e.target.value) || 0;
        this.emitValue(value);
    }

    handleChange(e) {
        // Stop the native change event from bubbling up so x-model only
        // sees our CustomEvent (which carries detail.value).
        if (e && e.stopPropagation) {
            e.stopPropagation();
        }
        if (this.isStringMode()) {
            this.emitChange(e, this.clampString(e.target.value));
            return;
        }
        const value = parseFloat(e.target.value) || 0;
        this.emitChange(e, value);
    }

    increment() {
        this.stepBy(1);
    }

    decrement() {
        this.stepBy(-1);
    }

    stepBy(dir) {
        if (this.props.disabled) return;
        const next = decimalStep(this.valueString() || '0', String(this.props.step), dir);
        const clamped = this.clampString(next);
        this.emitChange(null, this.coerceOut(clamped));
    }

    emitValue(value) {
        if (isBounded(this.props.min) && value < parseFloat(this.props.min)) value = parseFloat(this.props.min);
        if (isBounded(this.props.max) && value > parseFloat(this.props.max)) value = parseFloat(this.props.max);
        this.emitChange(null, value);
    }

    template() {
        const valStr = this.valueString();
        const canDecrement = !isBounded(this.props.min) || compareDecimal(valStr || '0', this.props.min) > 0;
        const canIncrement = !isBounded(this.props.max) || compareDecimal(valStr || '0', this.props.max) < 0;
        const inputId = this.state.inputId;
        const errorId = `${inputId}-error`;
        const hasError = !!this.props.error;
        const stringMode = this.isStringMode();

        const orientation = this.props.orientation || 'auto';
        const layoutClass = orientation === 'vertical' ? 'layout-vertical'
            : orientation === 'horizontal' ? 'layout-horizontal'
            : 'layout-auto';
        const containerClass = `input-number-container ${layoutClass}`
            + (this.props.showbuttons ? ' has-buttons' : '');

        return html`
            <div class="cl-input-wrapper">
                ${when(this.props.label, html`
                    <label class="cl-label" for="${inputId}">${this.props.label}</label>
                `)}
                <div class="${containerClass}">
                    ${when(this.props.showbuttons, html`
                        <button
                            type="button"
                            class="btn-decrement"
                            disabled="${this.props.disabled || !canDecrement}"
                            aria-label="Decrease value"
                            on-click="decrement">−</button>
                    `)}
                    <input
                        type="${stringMode ? 'text' : 'number'}"
                        inputmode="${stringMode ? 'decimal' : undefined}"
                        id="${inputId}"
                        value="${this.props.value}"
                        min="${stringMode ? undefined : this.props.min}"
                        max="${stringMode ? undefined : this.props.max}"
                        step="${stringMode ? undefined : this.props.step}"
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
    }

    static styles = /*css*/`
        :host {
            display: block;
            /* Establish a query container so the control can react to its own
               width and collapse to a vertical layout when cramped. */
            container-type: inline-size;
            max-width: 100%;
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
            box-sizing: border-box;
            max-width: 100%;
        }

        input {
            font-family: inherit;
            font-size: 14px;
            padding: 10px 12px;
            border: 1px solid var(--input-border, #ced4da);
            border-radius: 4px;
            background: var(--input-bg, #fff);
            color: var(--text-color, #333);
            flex: 1;
            min-width: 0;
            box-sizing: border-box;
            text-align: center;
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
            transition: background 0.2s;
            user-select: none;
            box-sizing: border-box;
            white-space: nowrap;
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

        /* Hide the native spinner arrows only when our own buttons are shown
           (Firefox shows them by default; WebKit needs the pseudo-element). */
        .has-buttons input[type=number] {
            -moz-appearance: textfield;
            appearance: textfield;
        }
        .has-buttons input::-webkit-outer-spin-button,
        .has-buttons input::-webkit-inner-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }

        /* --- Horizontal layout: [-][input][+] ------------------------------ */
        .has-buttons.layout-horizontal input,
        .has-buttons.layout-auto input {
            border-radius: 0;
            border-left: none;
            border-right: none;
        }
        .has-buttons.layout-horizontal .btn-decrement,
        .has-buttons.layout-auto .btn-decrement {
            border-radius: 4px 0 0 4px;
        }
        .has-buttons.layout-horizontal .btn-increment,
        .has-buttons.layout-auto .btn-increment {
            border-radius: 0 4px 4px 0;
        }

        /* --- Vertical layout: input on the left, stacked +/- on the right ---
           Same DOM order [-][input][+] is re-flowed with grid so we never
           duplicate markup. */
        .has-buttons.layout-vertical {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            grid-template-rows: 1fr 1fr;
        }
        .has-buttons.layout-vertical input {
            grid-column: 1;
            grid-row: 1 / 3;
            border-radius: 4px 0 0 4px;
            border-right: none;
        }
        /* line-height:1 keeps the two stacked buttons shorter than the input's
           intrinsic height, so the input governs the control height and it
           matches the standard text input (no taller "vertical" variant). */
        .has-buttons.layout-vertical .btn-increment {
            grid-column: 2;
            grid-row: 1;
            padding: 0 12px;
            line-height: 1;
            border-radius: 0 4px 0 0;
            border-bottom: none;
        }
        .has-buttons.layout-vertical .btn-decrement {
            grid-column: 2;
            grid-row: 2;
            padding: 0 12px;
            line-height: 1;
            border-radius: 0 0 4px 0;
        }

        /* Auto: collapse to the vertical grid when the control is too narrow
           to comfortably fit the horizontal buttons. */
        @container (max-width: 150px) {
            .has-buttons.layout-auto {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                grid-template-rows: 1fr 1fr;
            }
            .has-buttons.layout-auto input {
                grid-column: 1;
                grid-row: 1 / 3;
                border: 1px solid var(--input-border, #ced4da);
                border-right: none;
                border-radius: 4px 0 0 4px;
            }
            .has-buttons.layout-auto .btn-increment {
                grid-column: 2;
                grid-row: 1;
                padding: 0 12px;
                line-height: 1;
                border-radius: 0 4px 0 0;
                border-bottom: none;
            }
            .has-buttons.layout-auto .btn-decrement {
                grid-column: 2;
                grid-row: 2;
                padding: 0 12px;
                line-height: 1;
                border-radius: 0 0 4px 0;
            }
        }

        .error-text {
            font-size: 12px;
            color: var(--error-color, #dc3545);
        }
    `
}

export default defineComponent('cl-input-number', ClInputNumber);
