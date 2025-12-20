/**
 * Dropdown - Advanced single select dropdown with search
 *
 * Accessibility features:
 * - role="combobox" on trigger with aria-expanded
 * - role="listbox" on options container
 * - role="option" with aria-selected on each option
 * - aria-activedescendant for focus tracking
 * - Keyboard navigation: Arrow keys, Enter, Escape, Home, End
 * - Type-ahead search when focused
 */
import { defineComponent, html, when, each } from '../../lib/framework.js';

// Counter for unique IDs
let dropdownIdCounter = 0;

export default defineComponent('cl-dropdown', {
    props: {
        options: [],
        value: null,
        placeholder: 'Select an option',
        disabled: false,
        filter: false,
        label: '',
        optionlabel: 'label',
        optionvalue: 'value'
    },

    data() {
        return {
            showPanel: false,
            filterValue: '',
            activeIndex: -1,
            dropdownId: `cl-dropdown-${++dropdownIdCounter}`,
            typeaheadBuffer: '',
            typeaheadTimeout: null
        };
    },

    mounted() {
        // Global keydown for escape
        this._handleGlobalKeyDown = (e) => {
            if (e.key === 'Escape' && this.state.showPanel) {
                this.closePanel();
                this._focusTrigger();
            }
        };
        document.addEventListener('keydown', this._handleGlobalKeyDown);
    },

    unmounted() {
        if (this._handleGlobalKeyDown) {
            document.removeEventListener('keydown', this._handleGlobalKeyDown);
        }
        if (this.state.typeaheadTimeout) {
            clearTimeout(this.state.typeaheadTimeout);
        }
    },

    methods: {
        closePanel() {
            this.state.showPanel = false;
            this.state.activeIndex = -1;
            this.state.filterValue = '';
        },

        togglePanel() {
            if (!this.props.disabled) {
                if (this.state.showPanel) {
                    this.closePanel();
                } else {
                    this.openPanel();
                }
            }
        },

        openPanel() {
            this.state.showPanel = true;
            this.state.filterValue = '';
            // Set active index to currently selected option
            const options = this.getFilteredOptions();
            const selectedIndex = options.findIndex(opt => this.isSelected(opt));
            this.state.activeIndex = selectedIndex >= 0 ? selectedIndex : 0;

            // Focus filter input if present, otherwise focus listbox
            requestAnimationFrame(() => {
                if (this.props.filter) {
                    const filterInput = this.querySelector('.filter-input');
                    if (filterInput) filterInput.focus();
                }
            });
        },

        selectOption(option) {
            const value = typeof option === 'object' ? option[this.props.optionvalue] : option;
            this.emitChange(null, value);
            this.closePanel();
            this._focusTrigger();
        },

        handleFilterInput(e) {
            this.state.filterValue = e.target.value;
            this.state.activeIndex = 0; // Reset to first option when filtering
        },

        getFilteredOptions() {
            if (!this.props.filter || !this.state.filterValue) {
                return this.props.options || [];
            }

            const filter = this.state.filterValue.toLowerCase();
            return (this.props.options || []).filter(option => {
                const label = typeof option === 'object' ? option[this.props.optionlabel] : option;
                return String(label).toLowerCase().includes(filter);
            });
        },

        getSelectedLabel() {
            if (this.props.value == null) {
                return this.props.placeholder;
            }

            const option = (this.props.options || []).find(opt => {
                const value = typeof opt === 'object' ? opt[this.props.optionvalue] : opt;
                return value === this.props.value;
            });

            if (!option) return this.props.placeholder;
            return typeof option === 'object' ? option[this.props.optionlabel] : option;
        },

        getOptionLabel(option) {
            return typeof option === 'object' ? option[this.props.optionlabel] : option;
        },

        getOptionValue(option) {
            return typeof option === 'object' ? option[this.props.optionvalue] : option;
        },

        isSelected(option) {
            const value = this.getOptionValue(option);
            return value === this.props.value;
        },

        getOptionId(index) {
            return `${this.state.dropdownId}-option-${index}`;
        },

        _focusTrigger() {
            const trigger = this.querySelector('.dropdown-trigger');
            if (trigger) trigger.focus();
        },

        /**
         * Handle keyboard navigation
         */
        handleKeyDown(e) {
            const options = this.getFilteredOptions();

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    if (!this.state.showPanel) {
                        this.openPanel();
                    } else {
                        this.state.activeIndex = Math.min(this.state.activeIndex + 1, options.length - 1);
                        this._scrollActiveIntoView();
                    }
                    break;

                case 'ArrowUp':
                    e.preventDefault();
                    if (this.state.showPanel) {
                        this.state.activeIndex = Math.max(this.state.activeIndex - 1, 0);
                        this._scrollActiveIntoView();
                    }
                    break;

                case 'Home':
                    if (this.state.showPanel) {
                        e.preventDefault();
                        this.state.activeIndex = 0;
                        this._scrollActiveIntoView();
                    }
                    break;

                case 'End':
                    if (this.state.showPanel) {
                        e.preventDefault();
                        this.state.activeIndex = options.length - 1;
                        this._scrollActiveIntoView();
                    }
                    break;

                case 'Enter':
                case ' ':
                    if (this.state.showPanel && this.state.activeIndex >= 0) {
                        e.preventDefault();
                        const option = options[this.state.activeIndex];
                        if (option) this.selectOption(option);
                    } else if (!this.state.showPanel && e.key === ' ') {
                        e.preventDefault();
                        this.openPanel();
                    }
                    break;

                case 'Tab':
                    if (this.state.showPanel) {
                        this.closePanel();
                    }
                    break;

                default:
                    // Type-ahead search (when not using filter input)
                    if (!this.props.filter && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
                        this._handleTypeahead(e.key);
                    }
            }
        },

        /**
         * Handle type-ahead search
         */
        _handleTypeahead(char) {
            // Clear previous timeout
            if (this.state.typeaheadTimeout) {
                clearTimeout(this.state.typeaheadTimeout);
            }

            // Add character to buffer
            this.state.typeaheadBuffer += char.toLowerCase();

            // Find matching option
            const options = this.getFilteredOptions();
            const matchIndex = options.findIndex(opt => {
                const label = this.getOptionLabel(opt);
                return String(label).toLowerCase().startsWith(this.state.typeaheadBuffer);
            });

            if (matchIndex >= 0) {
                this.state.activeIndex = matchIndex;
                if (!this.state.showPanel) {
                    this.openPanel();
                }
                this._scrollActiveIntoView();
            }

            // Clear buffer after 500ms of no typing
            this.state.typeaheadTimeout = setTimeout(() => {
                this.state.typeaheadBuffer = '';
            }, 500);
        },

        _scrollActiveIntoView() {
            requestAnimationFrame(() => {
                const activeOption = this.querySelector('.option.active');
                if (activeOption) {
                    activeOption.scrollIntoView({ block: 'nearest' });
                }
            });
        },

        handleOptionMouseEnter(index) {
            this.state.activeIndex = index;
        }
    },

    template() {
        const filteredOptions = this.getFilteredOptions();
        const selectedLabel = this.getSelectedLabel();
        const hasValue = this.props.value != null;
        const listboxId = `${this.state.dropdownId}-listbox`;
        const labelId = `${this.state.dropdownId}-label`;
        const activeDescendant = this.state.activeIndex >= 0 ? this.getOptionId(this.state.activeIndex) : undefined;

        return html`
            <div class="cl-dropdown-wrapper">
                ${when(this.props.label, html`
                    <label class="cl-label" id="${labelId}">${this.props.label}</label>
                `)}
                ${when(this.state.showPanel, html`
                    <div class="dropdown-backdrop" on-click="closePanel"></div>
                `)}
                <div class="dropdown-container">
                    <div class="dropdown-trigger ${this.props.disabled ? 'disabled' : ''}"
                         role="combobox"
                         aria-haspopup="listbox"
                         aria-expanded="${this.state.showPanel ? 'true' : 'false'}"
                         aria-controls="${listboxId}"
                         aria-activedescendant="${activeDescendant}"
                         aria-labelledby="${this.props.label ? labelId : undefined}"
                         aria-disabled="${this.props.disabled ? 'true' : undefined}"
                         tabindex="${this.props.disabled ? -1 : 0}"
                         on-click="togglePanel"
                         on-keydown="handleKeyDown">
                        <span class="${hasValue ? '' : 'placeholder'}">${selectedLabel}</span>
                        <span class="dropdown-icon" aria-hidden="true">${this.state.showPanel ? '▲' : '▼'}</span>
                    </div>
                    ${when(this.state.showPanel, html`
                        <div class="dropdown-panel">
                            ${when(this.props.filter, html`
                                <div class="filter-container">
                                    <input
                                        type="text"
                                        class="filter-input"
                                        placeholder="Search..."
                                        value="${this.state.filterValue}"
                                        on-input="handleFilterInput"
                                        on-keydown="handleKeyDown"
                                        aria-label="Filter options">
                                </div>
                            `)}
                            <div class="options-list"
                                 role="listbox"
                                 id="${listboxId}"
                                 aria-labelledby="${this.props.label ? labelId : undefined}">
                                ${when(filteredOptions.length === 0, html`
                                    <div class="no-results" role="status">No results found</div>
                                `)}
                                ${each(filteredOptions, (option, index) => html`
                                    <div
                                        class="option ${this.isSelected(option) ? 'selected' : ''} ${this.state.activeIndex === index ? 'active' : ''}"
                                        role="option"
                                        id="${this.getOptionId(index)}"
                                        aria-selected="${this.isSelected(option) ? 'true' : 'false'}"
                                        on-click="${() => this.selectOption(option)}"
                                        on-mouseenter="${() => this.handleOptionMouseEnter(index)}">
                                        ${this.getOptionLabel(option)}
                                    </div>
                                `)}
                            </div>
                        </div>
                    `)}
                </div>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .cl-dropdown-wrapper {
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

        .dropdown-container {
            position: relative;
        }

        .dropdown-trigger {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 12px;
            border: 1px solid var(--input-border, #ced4da);
            border-radius: 4px;
            background: var(--input-bg, #fff);
            cursor: pointer;
            transition: all 0.2s;
        }

        .dropdown-trigger:hover:not(.disabled) {
            border-color: var(--primary-color, #007bff);
        }

        .dropdown-trigger:focus {
            outline: none;
            border-color: var(--primary-color, #007bff);
            box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.25);
        }

        .dropdown-trigger.disabled {
            background: var(--disabled-bg, #e9ecef);
            cursor: not-allowed;
            opacity: 0.6;
        }

        .placeholder {
            color: var(--text-muted, #6c757d);
        }

        .dropdown-icon {
            font-size: 10px;
            color: var(--text-muted, #6c757d);
        }

        .dropdown-backdrop {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 999;
        }

        .dropdown-panel {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            margin-top: 4px;
            background: var(--card-bg, white);
            border: 1px solid var(--input-border, #ced4da);
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 1000;
            max-height: 300px;
            display: flex;
            flex-direction: column;
        }

        .filter-container {
            padding: 8px;
            border-bottom: 1px solid var(--input-border, #ced4da);
        }

        .filter-input {
            width: 100%;
            padding: 8px;
            border: 1px solid var(--input-border, #ced4da);
            border-radius: 4px;
            font-family: inherit;
            font-size: 14px;
            background: var(--input-bg, #fff);
            color: var(--text-color, #333);
            box-sizing: border-box;
        }

        .filter-input:focus {
            outline: none;
            border-color: var(--primary-color, #007bff);
            box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.25);
        }

        .options-list {
            overflow-y: auto;
            max-height: 250px;
        }

        .option {
            padding: 10px 12px;
            cursor: pointer;
            transition: background 0.2s;
            font-size: 14px;
        }

        .option:hover,
        .option.active {
            background: var(--hover-bg, #f8f9fa);
        }

        .option.selected {
            background: var(--primary-color, #007bff);
            color: white;
        }

        .option.selected.active {
            background: var(--primary-dark, #0056b3);
        }

        .no-results {
            padding: 20px;
            text-align: center;
            color: var(--text-muted, #6c757d);
            font-size: 14px;
        }
    `
});
