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
import { defineComponent, html, when, each, boolProp, Component } from '../../lib/framework.js';
import { createAnchoredOverlay } from '../../lib/overlay.js';

// Counter for unique IDs
let dropdownIdCounter = 0;

/**
 * @fires change - detail: { value }
 */
export class ClDropdown extends Component {
    static props = {
        options: [],
        value: null,
        placeholder: 'Select an option',
        disabled: false,
        filter: false,
        label: '',
        optionlabel: 'label',
        optionvalue: 'value'
    }

    constructor(props) {
        super(props);

        this.state = {
            showPanel: false,
            filterValue: '',
            activeIndex: -1,
            dropdownId: `cl-dropdown-${++dropdownIdCounter}`,
            typeaheadBuffer: '',
            typeaheadTimeout: null
        };

        // Anchored overlay: promotes the options panel to the top layer so it
        // escapes ancestor overflow/transform clipping (e.g. inside cl-dialog).
        // Owns outside-click + Escape dismissal, replacing the old backdrop div
        // and global Escape listener.
        this._overlay = createAnchoredOverlay(this, {
            anchor: () => this.querySelector('.dropdown-trigger'),
            panel: () => this.querySelector('.dropdown-panel'),
            placement: 'bottom-start',
            offset: 4,
            matchAnchorWidth: true,
            onDismiss: (reason) => {
                this.closePanel();
                if (reason === 'escape') this._focusTrigger();
            }
        });
    }

    unmounted() {
        this._overlay.destroy();
        if (this.state.typeaheadTimeout) {
            clearTimeout(this.state.typeaheadTimeout);
        }
    }

    closePanel() {
        // hidePopover on the still-present node BEFORE the branch unmounts.
        this._overlay.close();
        this.state.showPanel = false;
        this.state.activeIndex = -1;
        this.state.filterValue = '';
    }

    togglePanel() {
        if (!boolProp(this.props.disabled)) {
            if (this.state.showPanel) {
                this.closePanel();
            } else {
                this.openPanel();
            }
        }
    }

    async openPanel() {
        this.state.showPanel = true;
        this.state.filterValue = '';
        // Set active index to currently selected option
        const options = this.filteredOptions;
        const selectedIndex = options.findIndex(opt => this.isSelected(opt));
        this.state.activeIndex = selectedIndex >= 0 ? selectedIndex : 0;

        // The panel is conditionally rendered - wait for its branch to mount
        // before promoting it to the top layer and positioning it.
        await this.nextRender();
        if (!this.state.showPanel) return;  // re-closed before the render committed
        this._overlay.open();

        // Focus filter input if present
        if (boolProp(this.props.filter)) {
            const filterInput = this.querySelector('.filter-input');
            if (filterInput) filterInput.focus();
        }
    }

    selectOption(option) {
        const value = typeof option === 'object' ? option[this.props.optionvalue] : option;
        this.emitChange(null, value);
        this.closePanel();
        this._focusTrigger();
    }

    handleFilterInput(e) {
        this.state.filterValue = e.target.value;
        this.state.activeIndex = 0; // Reset to first option when filtering
    }

    getOptionLabel(option) {
        return typeof option === 'object' ? option[this.props.optionlabel] : option;
    }

    getOptionValue(option) {
        return typeof option === 'object' ? option[this.props.optionvalue] : option;
    }

    isSelected(option) {
        const value = this.getOptionValue(option);
        return value === this.props.value;
    }

    getOptionId(index) {
        return `${this.state.dropdownId}-option-${index}`;
    }

    _focusTrigger() {
        const trigger = this.querySelector('.dropdown-trigger');
        if (trigger) trigger.focus();
    }

    /**
     * Handle keyboard navigation
     */
    handleKeyDown(e) {
        const options = this.filteredOptions;

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
                if (!boolProp(this.props.filter) && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
                    this._handleTypeahead(e.key);
                }
        }
    }

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
        const options = this.filteredOptions;
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
    }

    _scrollActiveIntoView() {
        requestAnimationFrame(() => {
            const activeOption = this.querySelector('.option.active');
            if (activeOption) {
                activeOption.scrollIntoView({ block: 'nearest' });
            }
        });
    }

    handleOptionMouseEnter(index) {
        this.state.activeIndex = index;
    }

    get filteredOptions() {
        if (!boolProp(this.props.filter) || !this.state.filterValue) {
            return this.props.options || [];
        }

        const filter = this.state.filterValue.toLowerCase();
        return (this.props.options || []).filter(option => {
            const label = typeof option === 'object' ? option[this.props.optionlabel] : option;
            return String(label).toLowerCase().includes(filter);
        });
    }

    get selectedLabel() {
        if (this.props.value == null) {
            return this.props.placeholder;
        }

        const option = (this.props.options || []).find(opt => {
            const value = typeof opt === 'object' ? opt[this.props.optionvalue] : opt;
            return value === this.props.value;
        });

        if (!option) return this.props.placeholder;
        return typeof option === 'object' ? option[this.props.optionlabel] : option;
    }

    template() {
        const filteredOptions = this.filteredOptions;
        const selectedLabel = this.selectedLabel;
        const hasValue = this.props.value != null;
        const listboxId = `${this.state.dropdownId}-listbox`;
        const labelId = `${this.state.dropdownId}-label`;
        const activeDescendant = this.state.activeIndex >= 0 ? this.getOptionId(this.state.activeIndex) : undefined;

        return html`
            <div class="cl-dropdown-wrapper">
                ${when(this.props.label, html`
                    <label class="cl-label" id="${labelId}">${this.props.label}</label>
                `)}
                <div class="dropdown-container">
                    <div class="dropdown-trigger ${boolProp(this.props.disabled) ? 'disabled' : ''}"
                         role="combobox"
                         aria-haspopup="listbox"
                         aria-expanded="${this.state.showPanel ? 'true' : 'false'}"
                         aria-controls="${listboxId}"
                         aria-activedescendant="${activeDescendant}"
                         aria-labelledby="${this.props.label ? labelId : undefined}"
                         aria-disabled="${boolProp(this.props.disabled) ? 'true' : undefined}"
                         tabindex="${boolProp(this.props.disabled) ? -1 : 0}"
                         on-click="togglePanel"
                         on-keydown="handleKeyDown">
                        <span class="dropdown-value ${hasValue ? '' : 'placeholder'}">${selectedLabel}</span>
                        <span class="dropdown-icon" aria-hidden="true">${this.state.showPanel ? '▲' : '▼'}</span>
                    </div>
                    ${when(this.state.showPanel, html`
                        <div class="dropdown-panel" popover="manual">
                            ${when(boolProp(this.props.filter), html`
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
    }

    static styles = /*css*/`
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
            gap: 8px;
            box-sizing: border-box;
            /* Match the height of a standard text input by default. */
            height: var(--cl-control-height, 38px);
            padding: 0 12px;
            border: 1px solid var(--input-border, #ced4da);
            border-radius: 4px;
            background: var(--input-bg, #fff);
            cursor: pointer;
            transition: all 0.2s;
        }

        .dropdown-value {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
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

        .dropdown-panel {
            /* Positioned by createAnchoredOverlay: position/top/left/width/
               max-height are written inline. inset/margin here reset the UA
               popover defaults (inset:0; margin:auto) so the panel doesn't
               center itself before/without the top layer. */
            inset: auto;
            margin: 0;
            /* Re-establish inherited color: the UA [popover] rule forces
               color:CanvasText, which breaks dark mode (black text). */
            color: inherit;
            box-sizing: border-box;
            background: var(--card-bg, white);
            border: 1px solid var(--input-border, #ced4da);
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            max-height: 300px;
            overflow: hidden;
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
            /* flex:1 + min-height:0 lets the list shrink and scroll internally
               when the overlay caps the panel height (e.g. flipped near a
               viewport edge); max-height still bounds it on a roomy page. */
            flex: 1 1 auto;
            min-height: 0;
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
}

export default defineComponent('cl-dropdown', ClDropdown);
