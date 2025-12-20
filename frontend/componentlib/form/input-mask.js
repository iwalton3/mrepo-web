/**
 * InputMask - Masked input component for formatted data entry
 * Supports phone numbers, SSN, dates, credit cards, and custom masks
 *
 * Mask characters:
 *   9 = digit (0-9)
 *   a = letter (a-z, A-Z)
 *   * = alphanumeric
 */
import { defineComponent, html, when } from '../../lib/framework.js';

export default defineComponent('cl-input-mask', {
    props: {
        value: '',
        mask: '',           // e.g., '(999) 999-9999' for phone, '999-99-9999' for SSN
        placeholder: '',
        slotChar: '_',      // Character shown in unfilled positions
        disabled: false,
        required: false,
        error: '',
        label: '',
        helptext: '',
        autoClear: false,   // Clear incomplete values on blur
        unmask: false,      // If true, emits raw value without mask characters
        hideError: false    // If true, don't show internal validation errors (for parent-controlled validation)
    },

    data() {
        return {
            internalError: '',
            buffer: [],         // Array of entered characters (only user input, no literals)
            focused: false
        };
    },

    mounted() {
        this.initBuffer();
        if (this.props.value) {
            this.setValueFromProp(this.props.value);
        }
    },

    propsChanged(prop, newValue, oldValue) {
        if (prop === 'value' && newValue !== oldValue) {
            this.setValueFromProp(newValue);
            // Clear internal error if receiving a complete value from parent
            // (e.g., calendar selection after incomplete manual entry)
            const filledCount = this.state.buffer.filter(c => c).length;
            const totalCount = this.state.buffer.length;
            if (filledCount === totalCount || filledCount === 0) {
                this.state.internalError = '';
            }
        }
        if (prop === 'mask' && newValue !== oldValue) {
            this.initBuffer();
            // Re-parse current value with new mask
            if (this.props.value) {
                this.setValueFromProp(this.props.value);
            }
        }
    },

    methods: {

        // Mask character definitions
        getMaskDef(char) {
            const defs = {
                '9': /\d/,
                'a': /[a-zA-Z]/,
                '*': /[a-zA-Z0-9]/
            };
            return defs[char];
        },

        isMaskChar(char) {
            return ['9', 'a', '*'].includes(char);
        },

        // Get array of placeholder positions in the mask
        getPlaceholderPositions() {
            const positions = [];
            const mask = this.props.mask || '';
            for (let i = 0; i < mask.length; i++) {
                if (this.isMaskChar(mask[i])) {
                    positions.push(i);
                }
            }
            return positions;
        },

        initBuffer() {
            const positions = this.getPlaceholderPositions();
            this.state.buffer = new Array(positions.length).fill('');
        },

        setValueFromProp(value) {
            if (!value && value !== 0) {
                this.initBuffer();
                return;
            }

            // Ensure value is a string (x-model may convert numeric strings to numbers)
            value = String(value);

            // Extract only the raw characters from the value
            const mask = this.props.mask || '';
            const positions = this.getPlaceholderPositions();
            const buffer = [];

            let valueIdx = 0;
            for (let i = 0; i < mask.length && valueIdx < value.length; i++) {
                if (this.isMaskChar(mask[i])) {
                    // This is a placeholder position
                    const char = value[valueIdx];
                    const def = this.getMaskDef(mask[i]);
                    if (def && def.test(char)) {
                        buffer.push(char);
                    }
                    valueIdx++;
                } else {
                    // This is a literal - skip if it matches
                    if (value[valueIdx] === mask[i]) {
                        valueIdx++;
                    }
                }
            }

            // Pad buffer to correct length
            while (buffer.length < positions.length) {
                buffer.push('');
            }

            this.state.buffer = buffer;
        },

        // Build display string from buffer
        getDisplayValue() {
            const mask = this.props.mask || '';
            const slotChar = this.props.slotChar;
            let result = '';
            let bufferIdx = 0;

            for (let i = 0; i < mask.length; i++) {
                if (this.isMaskChar(mask[i])) {
                    const char = this.state.buffer[bufferIdx] || '';
                    result += char || (this.state.focused ? slotChar : '');
                    bufferIdx++;
                } else {
                    // Only show literal if we have content before it or we're focused
                    const hasContentBefore = this.state.buffer.slice(0, bufferIdx).some(c => c);
                    const hasContentAfter = this.state.buffer.slice(bufferIdx).some(c => c);
                    if (this.state.focused || hasContentBefore || hasContentAfter) {
                        result += mask[i];
                    }
                }
            }

            return result;
        },

        // Get raw value (just the user-entered characters)
        getRawValue() {
            return this.state.buffer.filter(c => c).join('');
        },

        // Get masked value
        getMaskedValue() {
            const mask = this.props.mask || '';
            let result = '';
            let bufferIdx = 0;

            for (let i = 0; i < mask.length; i++) {
                if (this.isMaskChar(mask[i])) {
                    const char = this.state.buffer[bufferIdx] || '';
                    if (char) {
                        result += char;
                    } else {
                        break; // Stop at first empty position
                    }
                    bufferIdx++;
                } else {
                    result += mask[i];
                }
            }

            return result;
        },

        // Convert buffer index to display position
        bufferIdxToDisplayPos(bufferIdx) {
            const mask = this.props.mask || '';
            let pos = 0;
            let bIdx = 0;

            for (let i = 0; i < mask.length; i++) {
                if (bIdx >= bufferIdx) {
                    return pos;
                }
                if (this.isMaskChar(mask[i])) {
                    bIdx++;
                }
                pos++;
            }

            return pos;
        },

        // Convert display position to buffer index
        displayPosToBufferIdx(displayPos) {
            const mask = this.props.mask || '';
            let bufferIdx = 0;

            for (let i = 0; i < displayPos && i < mask.length; i++) {
                if (this.isMaskChar(mask[i])) {
                    bufferIdx++;
                }
            }

            return bufferIdx;
        },

        // Find next empty buffer position
        getNextEmptyBufferIdx() {
            for (let i = 0; i < this.state.buffer.length; i++) {
                if (!this.state.buffer[i]) {
                    return i;
                }
            }
            return this.state.buffer.length;
        },

        handleInput(e) {
            // We handle everything through keydown, prevent default input behavior
            e.preventDefault();
        },

        handleKeyDown(e) {
            const input = e.target;
            const cursorPos = input.selectionStart;
            const mask = this.props.mask || '';

            // Convert cursor position to buffer index
            let bufferIdx = this.displayPosToBufferIdx(cursorPos);

            if (e.key === 'Backspace') {
                e.preventDefault();

                if (bufferIdx > 0) {
                    // Delete previous character in buffer
                    const newBuffer = [...this.state.buffer];
                    newBuffer[bufferIdx - 1] = '';
                    this.state.buffer = newBuffer;

                    // Move cursor back
                    const newPos = this.bufferIdxToDisplayPos(bufferIdx - 1);
                    this.updateInputAndCursor(input, newPos);
                    this.emitInput();
                }
            } else if (e.key === 'Delete') {
                e.preventDefault();

                if (bufferIdx < this.state.buffer.length) {
                    const newBuffer = [...this.state.buffer];
                    newBuffer[bufferIdx] = '';
                    this.state.buffer = newBuffer;

                    this.updateInputAndCursor(input, cursorPos);
                    this.emitInput();
                }
            } else if (e.key === 'ArrowLeft') {
                // Allow default behavior
            } else if (e.key === 'ArrowRight') {
                // Allow default behavior
            } else if (e.key === 'Tab') {
                // Allow default behavior
            } else if (e.key === 'Home' || e.key === 'End') {
                // Allow default behavior
            } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();

                // Find the buffer position to insert at
                // If cursor is at a filled position, find next empty
                let insertIdx = bufferIdx;
                if (insertIdx >= this.state.buffer.length) {
                    insertIdx = this.getNextEmptyBufferIdx();
                }

                if (insertIdx < this.state.buffer.length) {
                    // Find the mask character for this position
                    const positions = this.getPlaceholderPositions();
                    const maskPos = positions[insertIdx];
                    const maskChar = mask[maskPos];
                    const def = this.getMaskDef(maskChar);

                    if (def && def.test(e.key)) {
                        const newBuffer = [...this.state.buffer];
                        newBuffer[insertIdx] = e.key;
                        this.state.buffer = newBuffer;

                        // Move cursor to next position
                        const nextPos = this.bufferIdxToDisplayPos(insertIdx + 1);
                        this.updateInputAndCursor(input, nextPos);
                        this.emitInput();
                    }
                }
            }
        },

        updateInputAndCursor(input, cursorPos) {
            // Don't set input.value directly - let Preact handle it via the template
            // Just set cursor position after the render completes
            setTimeout(() => {
                input.setSelectionRange(cursorPos, cursorPos);
            }, 0);
        },

        handleFocus(e) {
            this.state.focused = true;

            // Position cursor at first empty slot after render
            setTimeout(() => {
                const input = e.target;
                // Don't set input.value - let Preact handle it via the template
                const nextEmpty = this.getNextEmptyBufferIdx();
                const cursorPos = this.bufferIdxToDisplayPos(nextEmpty);
                input.setSelectionRange(cursorPos, cursorPos);
            }, 0);
        },

        handleBlur(e) {
            this.state.focused = false;

            // Skip internal validation if hideError is true (parent handles validation)
            if (!this.props.hideError) {
                this.validateInput();
            }

            // Clear incomplete value if autoClear is enabled
            if (this.props.autoClear) {
                const filledCount = this.state.buffer.filter(c => c).length;
                if (filledCount > 0 && filledCount < this.state.buffer.length) {
                    this.initBuffer();
                }
            }

            // Always emit change on blur (emitChange only fires if value is complete)
            this.emitChange();
        },

        validateInput() {
            const filledCount = this.state.buffer.filter(c => c).length;
            const totalCount = this.state.buffer.length;

            if (this.props.required && filledCount === 0) {
                this.state.internalError = 'This field is required';
                return false;
            }

            if (filledCount > 0 && filledCount < totalCount) {
                this.state.internalError = 'Please complete the field';
                return false;
            }

            this.state.internalError = '';
            return true;
        },

        /**
         * Emit input event - fires on every keystroke for live updates
         */
        emitInput() {
            const value = this.props.unmask ? this.getRawValue() : this.getMaskedValue();

            this.dispatchEvent(new CustomEvent('input', {
                bubbles: true,
                composed: true,
                detail: { value }
            }));
        },

        /**
         * Emit change event - only fires when value is complete
         */
        emitChange() {
            const filledCount = this.state.buffer.filter(c => c).length;
            const totalCount = this.state.buffer.length;

            // Only emit change for complete values (all filled or all empty)
            if (filledCount === totalCount || filledCount === 0) {
                const value = this.props.unmask ? this.getRawValue() : this.getMaskedValue();

                this.dispatchEvent(new CustomEvent('change', {
                    bubbles: true,
                    composed: true,
                    detail: { value }
                }));
            }
        },

        getPlaceholder() {
            if (this.props.placeholder) return this.props.placeholder;
            // Show mask with slot chars as placeholder
            const mask = this.props.mask || '';
            let result = '';
            for (let i = 0; i < mask.length; i++) {
                if (this.isMaskChar(mask[i])) {
                    result += this.props.slotChar;
                } else {
                    result += mask[i];
                }
            }
            return result;
        }
    },

    template() {
        // When hideError is true, only use parent-provided error (not internal)
        const error = this.props.hideError ? this.props.error : (this.props.error || this.state.internalError);
        const hasError = !!error;
        const displayValue = this.getDisplayValue();

        return html`
            <div class="cl-input-wrapper">
                ${when(this.props.label, html`
                    <label class="cl-label">
                        ${this.props.label}
                        ${when(this.props.required, html`<span class="required">*</span>`)}
                    </label>
                `)}
                <input
                    type="text"
                    part="input"
                    class="${hasError ? 'error' : ''}"
                    value="${displayValue}"
                    placeholder="${this.getPlaceholder()}"
                    disabled="${this.props.disabled}"
                    on-input="handleInput"
                    on-keydown="handleKeyDown"
                    on-focus="handleFocus"
                    on-blur="handleBlur">
                ${when(this.props.helptext && !hasError, html`
                    <small class="help-text">${this.props.helptext}</small>
                `)}
                ${when(hasError && !this.props.hideError, html`
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

        input {
            font-family: inherit;
            font-size: 14px;
            padding: 10px 12px;
            border: 1px solid var(--input-border, #ced4da);
            border-radius: 4px;
            background: var(--input-bg, #fff);
            color: var(--text-color, #333);
            transition: all 0.2s;
            letter-spacing: 1px;
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
