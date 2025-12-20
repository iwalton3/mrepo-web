/**
 * InputSearch - Search input with clear button and optional suggestions
 */
import { defineComponent, html, when, each } from '../../lib/framework.js';

export default defineComponent('cl-input-search', {
    props: {
        value: '',
        placeholder: 'Search...',
        disabled: false,
        label: '',
        suggestions: [],         // Array of suggestion strings or objects
        minChars: 1,            // Minimum characters before showing suggestions
        debounce: 300,          // Debounce delay in ms for search event
        loading: false,
        showClear: true
    },

    data() {
        return {
            internalValue: '',
            showSuggestions: false,
            highlightedIndex: -1
        };
    },

    mounted() {
        this.state.internalValue = this.props.value || '';

        this._clickOutside = (e) => {
            if (!this.contains(e.target)) {
                this.state.showSuggestions = false;
            }
        };
        document.addEventListener('click', this._clickOutside);
    },

    unmounted() {
        if (this._clickOutside) {
            document.removeEventListener('click', this._clickOutside);
        }
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }
    },

    propsChanged(prop, newValue, oldValue) {
        if (prop === 'value' && newValue !== this.state.internalValue) {
            this.state.internalValue = newValue || '';
        }
    },

    methods: {
        handleInput(e) {
            if (!e.target) return;
            const value = e.target.value;
            this.state.internalValue = value;
            this.state.highlightedIndex = -1;

            // Show suggestions if we have enough characters
            if (value.length >= this.props.minChars && this.props.suggestions.length > 0) {
                this.state.showSuggestions = true;
            } else {
                this.state.showSuggestions = false;
            }

            // Emit input event immediately
            this.dispatchEvent(new CustomEvent('input', {
                bubbles: true,
                composed: true,
                detail: { value }
            }));

            // Emit change event for x-model compatibility
            this.emitChange(e, value);

            // Debounce search event
            if (this._debounceTimer) {
                clearTimeout(this._debounceTimer);
            }
            this._debounceTimer = setTimeout(() => {
                this.dispatchEvent(new CustomEvent('search', {
                    bubbles: true,
                    composed: true,
                    detail: { value }
                }));
            }, this.props.debounce);
        },

        handleKeyDown(e) {
            const suggestions = this.getFilteredSuggestions();

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (!this.state.showSuggestions && suggestions.length > 0) {
                    this.state.showSuggestions = true;
                }
                this.state.highlightedIndex = Math.min(
                    this.state.highlightedIndex + 1,
                    suggestions.length - 1
                );
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.state.highlightedIndex = Math.max(
                    this.state.highlightedIndex - 1,
                    0
                );
            } else if (e.key === 'Enter') {
                if (this.state.highlightedIndex >= 0 && this.state.highlightedIndex < suggestions.length) {
                    e.preventDefault();
                    this.selectSuggestion(suggestions[this.state.highlightedIndex]);
                } else {
                    // Submit search
                    this.dispatchEvent(new CustomEvent('submit', {
                        bubbles: true,
                        composed: true,
                        detail: { value: this.state.internalValue }
                    }));
                }
            } else if (e.key === 'Escape') {
                this.state.showSuggestions = false;
                this.state.highlightedIndex = -1;
            }
        },

        handleFocus() {
            if (this.state.internalValue.length >= this.props.minChars &&
                this.getFilteredSuggestions().length > 0) {
                this.state.showSuggestions = true;
            }
        },

        clearSearch() {
            this.state.internalValue = '';
            this.state.showSuggestions = false;
            this.state.highlightedIndex = -1;

            this.dispatchEvent(new CustomEvent('input', {
                bubbles: true,
                composed: true,
                detail: { value: '' }
            }));

            this.dispatchEvent(new CustomEvent('clear', {
                bubbles: true,
                composed: true
            }));

            // Focus the input after clearing
            const input = this.querySelector('input');
            if (input) input.focus();
        },

        selectSuggestion(suggestion) {
            const value = typeof suggestion === 'object' ? suggestion.label || suggestion.value : suggestion;
            this.state.internalValue = value;
            this.state.showSuggestions = false;
            this.state.highlightedIndex = -1;

            this.dispatchEvent(new CustomEvent('input', {
                bubbles: true,
                composed: true,
                detail: { value }
            }));

            this.dispatchEvent(new CustomEvent('select', {
                bubbles: true,
                composed: true,
                detail: { value, suggestion }
            }));
        },

        getFilteredSuggestions() {
            if (!this.props.suggestions || !this.state.internalValue) {
                return this.props.suggestions || [];
            }

            const query = this.state.internalValue.toLowerCase();
            return this.props.suggestions.filter(s => {
                const text = typeof s === 'object' ? (s.label || s.value || '') : s;
                return text.toLowerCase().includes(query);
            });
        },

        getSuggestionText(suggestion) {
            return typeof suggestion === 'object' ? suggestion.label || suggestion.value : suggestion;
        }
    },

    template() {
        const suggestions = this.getFilteredSuggestions();
        const hasValue = this.state.internalValue && this.state.internalValue.length > 0;

        return html`
            <div class="cl-search-wrapper">
                ${when(this.props.label, html`
                    <label class="cl-label">${this.props.label}</label>
                `)}
                <div class="search-input-wrapper">
                    <span class="search-icon">🔍</span>
                    <input
                        type="text"
                        class="search-input"
                        value="${this.state.internalValue}"
                        placeholder="${this.props.placeholder}"
                        disabled="${this.props.disabled}"
                        on-input="handleInput"
                        on-keydown="handleKeyDown"
                        on-focus="handleFocus">
                    ${when(this.props.loading, html`
                        <span class="loading-icon">
                            <cl-spinner size="small"></cl-spinner>
                        </span>
                    `)}
                    ${when(hasValue && this.props.showClear && !this.props.loading, html`
                        <button
                            type="button"
                            class="clear-btn"
                            tabindex="-1"
                            on-click="clearSearch"
                            title="Clear search">
                            ×
                        </button>
                    `)}
                </div>
                ${when(this.state.showSuggestions && suggestions.length > 0, html`
                    <div class="suggestions-dropdown">
                        ${each(suggestions, (suggestion, idx) => {
                            const text = this.getSuggestionText(suggestion);
                            const isHighlighted = idx === this.state.highlightedIndex;
                            return html`
                                <div
                                    class="suggestion-item ${isHighlighted ? 'highlighted' : ''}"
                                    on-click="${() => this.selectSuggestion(suggestion)}"
                                    on-mouseenter="${() => this.state.highlightedIndex = idx}">
                                    ${text}
                                </div>
                            `;
                        })}
                    </div>
                `)}
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .cl-search-wrapper {
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

        .search-input-wrapper {
            position: relative;
            display: flex;
            align-items: center;
        }

        .search-icon {
            position: absolute;
            left: 12px;
            font-size: 14px;
            opacity: 0.5;
            pointer-events: none;
        }

        .search-input {
            flex: 1;
            font-family: inherit;
            font-size: 14px;
            padding: 10px 40px 10px 36px;
            border: 1px solid var(--input-border, #ced4da);
            border-radius: 20px;
            background: var(--input-bg, #fff);
            color: var(--text-color, #333);
            transition: all 0.2s;
        }

        .search-input:focus {
            outline: none;
            border-color: var(--primary-color, #007bff);
            box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.1);
        }

        .search-input:disabled {
            background: var(--disabled-bg, #e9ecef);
            cursor: not-allowed;
            opacity: 0.6;
        }

        .search-input::placeholder {
            color: var(--text-muted, #999);
        }

        .loading-icon {
            position: absolute;
            right: 12px;
        }

        .clear-btn {
            position: absolute;
            right: 10px;
            background: var(--text-muted, #999);
            border: none;
            cursor: pointer;
            font-size: 14px;
            color: white;
            width: 20px;
            height: 20px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
            line-height: 1;
        }

        .clear-btn:hover {
            background: var(--text-color, #666);
        }

        .suggestions-dropdown {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            margin-top: 4px;
            background: var(--input-bg, white);
            border: 1px solid var(--input-border, #ced4da);
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            z-index: 1000;
            max-height: 200px;
            overflow-y: auto;
        }

        .suggestion-item {
            padding: 10px 16px;
            cursor: pointer;
            font-size: 14px;
            color: var(--text-color, #333);
            transition: background-color 0.15s;
        }

        .suggestion-item:hover,
        .suggestion-item.highlighted {
            background: var(--hover-bg, #f5f5f5);
        }

        .suggestion-item:first-child {
            border-radius: 8px 8px 0 0;
        }

        .suggestion-item:last-child {
            border-radius: 0 0 8px 8px;
        }
    `
});
