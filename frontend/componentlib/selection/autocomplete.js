/**
 * AutoComplete - Text input with autocomplete suggestions
 *
 * Accessibility features:
 * - role="combobox" on input with aria-autocomplete
 * - role="listbox" on suggestions panel
 * - role="option" on each suggestion
 * - aria-expanded, aria-controls, aria-activedescendant
 * - Keyboard navigation: Arrow keys, Enter, Escape
 * - Proper label association
 */
import { defineComponent, html, when, each, boolProp, Component } from '../../lib/framework.js';
import { createAnchoredOverlay } from '../../lib/overlay.js';

// Counter for unique IDs
let autocompleteIdCounter = 0;

/**
 * @fires change - detail: { value }
 */
export class ClAutocomplete extends Component {
    static props = {
        value: '',
        suggestions: [],
        placeholder: '',
        disabled: false,
        label: '',
        minlength: 1,
        delay: 300
    }

    constructor(props) {
        super(props);

        this.state = {
            showSuggestions: false,
            filteredSuggestions: [],
            inputValue: '',
            timeout: null,
            activeIndex: -1,
            autocompleteId: `cl-autocomplete-${++autocompleteIdCounter}`
        };

        // Top-layer anchored overlay for the suggestions panel - escapes
        // ancestor overflow/transform clipping and dismisses on outside click.
        this._overlay = createAnchoredOverlay(this, {
            anchor: () => this.querySelector('input'),
            panel: () => this.querySelector('.suggestions-panel'),
            placement: 'bottom-start',
            offset: 4,
            matchAnchorWidth: true,
            onDismiss: () => this._hideSuggestions()
        });
    }

    mounted() {
        this.state.inputValue = this.props.value;
    }

    unmounted() {
        this._overlay.destroy();
        if (this.state.timeout) {
            clearTimeout(this.state.timeout);
        }
    }

    // The suggestions panel is conditionally rendered and driven by typing,
    // not a single toggle - route every show/hide through these so the overlay
    // (top-layer promotion + positioning) stays in sync with the branch.
    async _syncOverlay() {
        await this.nextRender();
        if (!this.state.showSuggestions) return;
        if (this._overlay.isOpen) this._overlay.reposition();
        else this._overlay.open();
    }

    _hideSuggestions() {
        this._overlay.close();  // hidePopover before the branch unmounts
        this.state.showSuggestions = false;
        this.state.activeIndex = -1;
    }

    handleInput(e) {
        const value = e.target.value;
        this.state.inputValue = value;

        // Clear existing timeout
        if (this.state.timeout) {
            clearTimeout(this.state.timeout);
        }

        // Delay filtering
        this.state.timeout = setTimeout(() => {
            this.filterSuggestions(value);
            this.emitChange(e, value);
        }, this.props.delay);
    }

    filterSuggestions(value) {
        if (!value || value.length < this.props.minlength) {
            this.state.filteredSuggestions = [];
            this._hideSuggestions();
            return;
        }

        const filter = value.toLowerCase();
        const filtered = (this.props.suggestions || []).filter(suggestion => {
            const text = typeof suggestion === 'object' ? suggestion.label : suggestion;
            return String(text).toLowerCase().includes(filter);
        });

        this.state.filteredSuggestions = filtered;
        if (filtered.length > 0) {
            this.state.showSuggestions = true;
            this.state.activeIndex = 0;
            this._syncOverlay();   // open (or reposition after the list changed)
        } else {
            this._hideSuggestions();
        }
    }

    selectSuggestion(suggestion) {
        const value = typeof suggestion === 'object' ? suggestion.value : suggestion;
        const displayValue = typeof suggestion === 'object' ? suggestion.label : suggestion;

        this.state.inputValue = displayValue;
        this._hideSuggestions();
        this.emitChange(null, value);
    }

    handleBlur() {
        // Delay hiding to allow click on a suggestion (which lives in the top
        // layer but is still inside this component, so the click lands first).
        setTimeout(() => this._hideSuggestions(), 200);
    }

    getSuggestionLabel(suggestion) {
        return typeof suggestion === 'object' ? suggestion.label : suggestion;
    }

    getOptionId(index) {
        return `${this.state.autocompleteId}-option-${index}`;
    }

    handleKeyDown(e) {
        const suggestions = this.state.filteredSuggestions;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                if (this.state.showSuggestions) {
                    this.state.activeIndex = Math.min(this.state.activeIndex + 1, suggestions.length - 1);
                    this._scrollActiveIntoView();
                }
                break;

            case 'ArrowUp':
                e.preventDefault();
                if (this.state.showSuggestions) {
                    this.state.activeIndex = Math.max(this.state.activeIndex - 1, 0);
                    this._scrollActiveIntoView();
                }
                break;

            case 'Enter':
                if (this.state.showSuggestions && this.state.activeIndex >= 0) {
                    e.preventDefault();
                    const suggestion = suggestions[this.state.activeIndex];
                    if (suggestion) this.selectSuggestion(suggestion);
                }
                break;

            case 'Escape':
                if (this.state.showSuggestions) {
                    e.preventDefault();
                    this._hideSuggestions();
                }
                break;
        }
    }

    _scrollActiveIntoView() {
        requestAnimationFrame(() => {
            const activeOption = this.querySelector('.suggestion.active');
            if (activeOption) {
                activeOption.scrollIntoView({ block: 'nearest' });
            }
        });
    }

    handleSuggestionMouseEnter(index) {
        this.state.activeIndex = index;
    }

    template() {
        const inputId = `${this.state.autocompleteId}-input`;
        const labelId = `${this.state.autocompleteId}-label`;
        const listboxId = `${this.state.autocompleteId}-listbox`;
        const activeDescendant = this.state.activeIndex >= 0 ? this.getOptionId(this.state.activeIndex) : undefined;

        return html`
            <div class="cl-autocomplete-wrapper">
                ${when(this.props.label, html`
                    <label class="cl-label" id="${labelId}" for="${inputId}">${this.props.label}</label>
                `)}
                <div class="autocomplete-container">
                    <input
                        type="text"
                        id="${inputId}"
                        role="combobox"
                        aria-autocomplete="list"
                        aria-expanded="${this.state.showSuggestions ? 'true' : 'false'}"
                        aria-controls="${listboxId}"
                        aria-activedescendant="${activeDescendant}"
                        aria-labelledby="${this.props.label ? labelId : undefined}"
                        value="${this.state.inputValue}"
                        placeholder="${this.props.placeholder}"
                        disabled="${boolProp(this.props.disabled)}"
                        on-input="handleInput"
                        on-keydown="handleKeyDown"
                        on-blur="handleBlur">
                    ${when(this.state.showSuggestions, html`
                        <div class="suggestions-panel"
                             popover="manual"
                             role="listbox"
                             id="${listboxId}"
                             aria-labelledby="${this.props.label ? labelId : undefined}">
                            ${each(this.state.filteredSuggestions, (suggestion, index) => html`
                                <div
                                    class="suggestion ${this.state.activeIndex === index ? 'active' : ''}"
                                    role="option"
                                    id="${this.getOptionId(index)}"
                                    aria-selected="${this.state.activeIndex === index ? 'true' : 'false'}"
                                    on-click="${() => this.selectSuggestion(suggestion)}"
                                    on-mouseenter="${() => this.handleSuggestionMouseEnter(index)}">
                                    ${this.getSuggestionLabel(suggestion)}
                                </div>
                            `)}
                        </div>
                    `)}
                </div>
            </div>
        `;
    }

    static styles = /*css*/`
        :host {
            display: block;
        }

        .cl-autocomplete-wrapper {
            position: relative;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .cl-label {
            font-size: 14px;
            font-weight: 500;
            color: var(--text-color, #333);
        }

        .autocomplete-container {
            position: relative;
        }

        input {
            width: 100%;
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

        .suggestions-panel {
            /* Positioned by createAnchoredOverlay (top layer). inset/margin reset
               the UA popover defaults; placement is written inline. */
            inset: auto;
            margin: 0;
            color: inherit;   /* UA [popover] forces color:CanvasText; keep theme (dark mode) */
            box-sizing: border-box;
            background: var(--card-bg, white);
            border: 1px solid var(--input-border, #ced4da);
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            max-height: 250px;
            overflow-y: auto;
        }

        .suggestion {
            padding: 10px 12px;
            cursor: pointer;
            transition: background 0.2s;
            font-size: 14px;
        }

        .suggestion:hover,
        .suggestion.active {
            background: var(--hover-bg, #f8f9fa);
        }
    `
}

export default defineComponent('cl-autocomplete', ClAutocomplete);
