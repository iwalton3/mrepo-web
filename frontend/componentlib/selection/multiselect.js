/**
 * MultiSelect - Multi-select dropdown with chips
 *
 * Accessibility features:
 * - role="listbox" with aria-multiselectable on options container
 * - role="option" with aria-selected on each option
 * - aria-expanded on trigger
 * - aria-activedescendant for focus tracking
 * - Keyboard navigation: Arrow keys, Enter, Space, Escape, Home, End
 * - aria-label on chip remove buttons
 */
import { defineComponent, html, when, each } from '../../lib/framework.js';

// Counter for unique IDs
let multiselectIdCounter = 0;

export default defineComponent('cl-multiselect', {
    props: {
        options: [],
        value: [],
        placeholder: 'Select options',
        disabled: false,
        filter: false,
        label: '',
        optionlabel: 'label',
        optionvalue: 'value',
        maxselected: 0
    },

    data() {
        return {
            showPanel: false,
            filterValue: '',
            activeIndex: -1,
            multiselectId: `cl-multiselect-${++multiselectIdCounter}`
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
            this.state.activeIndex = 0;

            // Focus filter input if present
            requestAnimationFrame(() => {
                if (this.props.filter) {
                    const filterInput = this.querySelector('.filter-input');
                    if (filterInput) filterInput.focus();
                }
            });
        },

        _focusTrigger() {
            const trigger = this.querySelector('.multiselect-trigger');
            if (trigger) trigger.focus();
        },

        getOptionId(index) {
            return `${this.state.multiselectId}-option-${index}`;
        },

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
                        if (option) this.toggleOption(option);
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
            }
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
        },

        toggleOption(option) {
            const value = this.getOptionValue(option);
            const currentValue = this.props.value || [];
            const index = currentValue.indexOf(value);

            let newValue;
            if (index >= 0) {
                newValue = currentValue.filter((_, i) => i !== index);
            } else {
                if (this.props.maxselected > 0 && currentValue.length >= this.props.maxselected) {
                    return; // Max selection reached
                }
                newValue = [...currentValue, value];
            }

            this.emitChange(null, newValue);
        },

        removeValue(value) {
            const currentValue = this.props.value || [];
            const newValue = currentValue.filter(v => v !== value);
            this.emitChange(null, newValue);
        },

        handleFilterInput(e) {
            this.state.filterValue = e.target.value;
        },

        getFilteredOptions() {
            if (!this.props.filter || !this.state.filterValue) {
                return this.props.options || [];
            }

            const filter = this.state.filterValue.toLowerCase();
            return (this.props.options || []).filter(option => {
                const label = this.getOptionLabel(option);
                return String(label).toLowerCase().includes(filter);
            });
        },

        getOptionLabel(option) {
            return typeof option === 'object' ? option[this.props.optionlabel] : option;
        },

        getOptionValue(option) {
            return typeof option === 'object' ? option[this.props.optionvalue] : option;
        },

        isSelected(option) {
            const value = this.getOptionValue(option);
            const currentValue = this.props.value || [];
            return currentValue.includes(value);
        },

        getSelectedOptions() {
            const currentValue = this.props.value || [];
            return currentValue.map(val => {
                const option = (this.props.options || []).find(opt => {
                    return this.getOptionValue(opt) === val;
                });
                return option || val;
            });
        }
    },

    template() {
        const filteredOptions = this.getFilteredOptions();
        const selectedOptions = this.getSelectedOptions();
        const hasSelection = selectedOptions.length > 0;
        const listboxId = `${this.state.multiselectId}-listbox`;
        const labelId = `${this.state.multiselectId}-label`;
        const activeDescendant = this.state.activeIndex >= 0 ? this.getOptionId(this.state.activeIndex) : undefined;

        return html`
            <div class="cl-multiselect-wrapper">
                ${when(this.props.label, html`
                    <label class="cl-label" id="${labelId}">${this.props.label}</label>
                `)}
                ${when(this.state.showPanel, html`
                    <div class="multiselect-backdrop" on-click="closePanel"></div>
                `)}
                <div class="multiselect-container">
                    <div class="multiselect-trigger ${this.props.disabled ? 'disabled' : ''}"
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
                        <div class="selected-items">
                            ${when(!hasSelection, html`
                                <span class="placeholder">${this.props.placeholder}</span>
                            `)}
                            ${each(selectedOptions, option => html`
                                <span class="chip">
                                    ${this.getOptionLabel(option)}
                                    <button type="button"
                                            class="chip-remove"
                                            aria-label="Remove ${this.getOptionLabel(option)}"
                                            on-click="${(e) => {
                                                e.stopPropagation();
                                                this.removeValue(this.getOptionValue(option));
                                            }}">×</button>
                                </span>
                            `)}
                        </div>
                        <span class="dropdown-icon" aria-hidden="true">${this.state.showPanel ? '▲' : '▼'}</span>
                    </div>
                    ${when(this.state.showPanel, html`
                        <div class="multiselect-panel">
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
                                 aria-multiselectable="true"
                                 aria-labelledby="${this.props.label ? labelId : undefined}">
                                ${when(filteredOptions.length === 0, html`
                                    <div class="no-results" role="status">No results found</div>
                                `)}
                                ${each(filteredOptions, (option, index) => {
                                    const isSelected = this.isSelected(option);
                                    return html`
                                        <div
                                            class="option ${isSelected ? 'selected' : ''} ${this.state.activeIndex === index ? 'active' : ''}"
                                            role="option"
                                            id="${this.getOptionId(index)}"
                                            aria-selected="${isSelected ? 'true' : 'false'}"
                                            on-click="${() => this.toggleOption(option)}"
                                            on-mouseenter="${() => this.handleOptionMouseEnter(index)}">
                                            <input type="checkbox"
                                                   checked="${isSelected}"
                                                   readonly
                                                   tabindex="-1"
                                                   aria-hidden="true">
                                            <span>${this.getOptionLabel(option)}</span>
                                        </div>
                                    `;
                                })}
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

        .cl-multiselect-wrapper {
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

        .multiselect-container {
            position: relative;
        }

        .multiselect-trigger {
            display: flex;
            align-items: center;
            justify-content: space-between;
            min-height: 42px;
            padding: 6px 12px;
            border: 1px solid var(--input-border, #ced4da);
            border-radius: 4px;
            background: var(--input-bg, #fff);
            cursor: pointer;
            transition: all 0.2s;
        }

        .multiselect-trigger:hover:not(.disabled) {
            border-color: var(--primary-color, #007bff);
        }

        .multiselect-trigger.disabled {
            background: var(--disabled-bg, #e9ecef);
            cursor: not-allowed;
            opacity: 0.6;
        }

        .selected-items {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            flex: 1;
        }

        .placeholder {
            color: var(--text-muted, #6c757d);
            line-height: 30px;
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
            background: none;
            border: none;
            padding: 0;
            color: inherit;
            cursor: pointer;
            font-size: 16px;
            line-height: 1;
            font-weight: bold;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        .chip-remove:hover {
            opacity: 0.8;
        }

        .dropdown-icon {
            font-size: 10px;
            color: var(--text-muted, #6c757d);
            margin-left: 8px;
        }

        .multiselect-backdrop {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 999;
        }

        .multiselect-panel {
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
        }

        .filter-input:focus {
            outline: none;
            border-color: var(--primary-color, #007bff);
        }

        .options-list {
            overflow-y: auto;
            max-height: 250px;
        }

        .option {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 10px 12px;
            cursor: pointer;
            transition: background 0.2s;
            font-size: 14px;
        }

        .option:hover,
        .option.active {
            background: var(--hover-bg, #f8f9fa);
        }

        .option input[type="checkbox"] {
            pointer-events: none;
        }

        .multiselect-trigger:focus {
            outline: none;
            border-color: var(--primary-color, #007bff);
            box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.25);
        }

        .no-results {
            padding: 20px;
            text-align: center;
            color: var(--text-muted, #6c757d);
            font-size: 14px;
        }
    `
});
