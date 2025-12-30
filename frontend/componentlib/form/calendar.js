/**
 * Calendar - Date picker component with typeable input and month/year picker
 */
import { defineComponent, html, when, each } from '../../lib/framework.js';

export default defineComponent('cl-calendar', {
    props: {
        value: '',
        disabled: false,
        label: '',
        min: '',
        max: '',
        inline: false,
        dateFormat: 'MM/DD/YYYY',  // Display format
        placeholder: ''
    },

    data() {
        return {
            showPicker: false,
            viewDate: Date.now(),
            selectedDate: null,
            viewMode: 'days',      // 'days', 'months', 'years'
            yearRangeStart: 0,
            inputValue: '',
            inputError: ''
        };
    },

    mounted() {
        this.syncValueToState();
        this.state.yearRangeStart = Math.floor(new Date().getFullYear() / 12) * 12;

        if (this.props.inline) {
            this.state.showPicker = true;
        }
    },

    propsChanged(prop, newValue, oldValue) {
        if (prop === 'value' && newValue !== oldValue) {
            this.syncValueToState();
        }
    },

    methods: {
        closePicker() {
            if (!this.props.inline) {
                this.state.showPicker = false;
            }
        },

        syncValueToState() {
            if (this.props.value && this.props.value !== '') {
                // date in local timezone from ISO date e.g. 2023-08-15
                const utcDate = new Date(this.props.value);
                const date = new Date(utcDate.getTime() + utcDate.getTimezoneOffset() * 60000);
                if (!isNaN(date.getTime())) {
                    this.state.selectedDate = date.getTime();
                    this.state.viewDate = date.getTime();
                    this.state.inputValue = this.formatDisplayDate(date);
                }
            } else {
                this.state.selectedDate = null;
                this.state.inputValue = '';
            }
        },

        togglePicker(e) {
            if (e) e.stopPropagation();
            if (!this.props.disabled && !this.props.inline) {
                this.state.showPicker = !this.state.showPicker;
                this.state.viewMode = 'days';
                if (this.state.showPicker && this.state.selectedDate) {
                    this.state.viewDate = this.state.selectedDate;
                }
            }
        },

        selectDate(date) {
            this.state.selectedDate = date.getTime();
            this.state.viewDate = date.getTime();
            this.state.inputValue = this.formatDisplayDate(date);
            this.state.inputError = '';
            const dateStr = this.toISODate(date);
            this.emitChange(null, dateStr);

            if (!this.props.inline) {
                this.state.showPicker = false;
            }
        },

        toISODate(date) {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        },

        previousMonth() {
            const current = new Date(this.state.viewDate);
            current.setMonth(current.getMonth() - 1);
            this.state.viewDate = current.getTime();
        },

        nextMonth() {
            const current = new Date(this.state.viewDate);
            current.setMonth(current.getMonth() + 1);
            this.state.viewDate = current.getTime();
        },

        previousYear() {
            const current = new Date(this.state.viewDate);
            current.setFullYear(current.getFullYear() - 1);
            this.state.viewDate = current.getTime();
        },

        nextYear() {
            const current = new Date(this.state.viewDate);
            current.setFullYear(current.getFullYear() + 1);
            this.state.viewDate = current.getTime();
        },

        previousYearRange() {
            this.state.yearRangeStart -= 12;
        },

        nextYearRange() {
            this.state.yearRangeStart += 12;
        },

        selectMonth(month) {
            const current = new Date(this.state.viewDate);
            current.setMonth(month);
            this.state.viewDate = current.getTime();
            this.state.viewMode = 'days';
        },

        selectYear(year) {
            const current = new Date(this.state.viewDate);
            current.setFullYear(year);
            this.state.viewDate = current.getTime();
            this.state.viewMode = 'months';
        },

        switchToMonthView() {
            this.state.viewMode = 'months';
        },

        switchToYearView() {
            const current = new Date(this.state.viewDate);
            this.state.yearRangeStart = Math.floor(current.getFullYear() / 12) * 12;
            this.state.viewMode = 'years';
        },

        getDaysInMonth() {
            const viewDate = new Date(this.state.viewDate);
            const year = viewDate.getFullYear();
            const month = viewDate.getMonth();
            const firstDay = new Date(year, month, 1);
            const lastDay = new Date(year, month + 1, 0);
            const daysInMonth = lastDay.getDate();
            const startingDayOfWeek = firstDay.getDay();

            const days = [];

            for (let i = 0; i < startingDayOfWeek; i++) {
                days.push(null);
            }

            for (let day = 1; day <= daysInMonth; day++) {
                days.push(new Date(year, month, day));
            }

            return days;
        },

        getMonths() {
            return [
                'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
            ];
        },

        getYears() {
            const years = [];
            for (let i = 0; i < 12; i++) {
                years.push(this.state.yearRangeStart + i);
            }
            return years;
        },

        isSelectedDate(date) {
            if (!date || !this.state.selectedDate) return false;
            const selected = new Date(this.state.selectedDate);
            return date.toDateString() === selected.toDateString();
        },

        isToday(date) {
            if (!date) return false;
            const today = new Date();
            return date.toDateString() === today.toDateString();
        },

        isCurrentMonth(month) {
            const viewDate = new Date(this.state.viewDate);
            return viewDate.getMonth() === month;
        },

        isCurrentYear(year) {
            const viewDate = new Date(this.state.viewDate);
            return viewDate.getFullYear() === year;
        },

        isDateDisabled(date) {
            if (!date) return false;

            if (this.props.min) {
                const minDate = new Date(this.props.min);
                if (date < minDate) return true;
            }

            if (this.props.max) {
                const maxDate = new Date(this.props.max);
                if (date > maxDate) return true;
            }

            return false;
        },

        formatDisplayDate(date) {
            if (!date) return '';
            const d = date instanceof Date ? date : new Date(date);
            if (isNaN(d.getTime())) return '';

            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            const year = d.getFullYear();

            // Apply format
            const format = this.props.dateFormat || 'MM/DD/YYYY';
            return format
                .replace('YYYY', year)
                .replace('MM', month)
                .replace('DD', day);
        },

        parseInputDate(value) {
            if (!value) return null;

            // Try various common formats
            const formats = [
                // MM/DD/YYYY
                /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
                // DD/MM/YYYY
                /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
                // YYYY-MM-DD (ISO)
                /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
                // M/D/YY
                /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/
            ];

            for (const format of formats) {
                const match = value.match(format);
                if (match) {
                    let year, month, day;

                    if (format === formats[2]) {
                        // YYYY-MM-DD
                        [, year, month, day] = match;
                    } else if (format === formats[3]) {
                        // M/D/YY - assume 2000s
                        [, month, day, year] = match;
                        year = parseInt(year) + 2000;
                    } else {
                        // MM/DD/YYYY or DD-MM-YYYY
                        [, month, day, year] = match;
                    }

                    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
                    if (!isNaN(date.getTime())) {
                        // Validate the date is real (e.g., not Feb 31)
                        if (date.getMonth() === parseInt(month) - 1 && date.getDate() === parseInt(day)) {
                            return date;
                        }
                    }
                }
            }

            // Try native Date parsing as fallback
            const date = new Date(value);
            if (!isNaN(date.getTime())) {
                return date;
            }

            return null;
        },

        getDateMask() {
            // Convert date format to mask format
            // MM/DD/YYYY -> 99/99/9999
            const format = this.props.dateFormat || 'MM/DD/YYYY';
            return format
                .replace(/M/g, '9')
                .replace(/D/g, '9')
                .replace(/Y/g, '9');
        },

        handleMaskInput(e) {
            // Stop the input event from bubbling to prevent x-model interference
            if (e && e.stopPropagation) {
                e.stopPropagation();
            }

            // Get value from custom event detail - only update display, don't sync to parent
            const value = e.detail ? e.detail.value : (e.target.value || '');
            this.state.inputValue = value;

            // Clear error while typing
            this.state.inputError = '';
        },

        handleMaskChange(e) {
            // Stop the change event from bubbling to prevent x-model interference
            if (e && e.stopPropagation) {
                e.stopPropagation();
            }

            // InputMask only emits change when value is complete (or empty)
            const value = e.detail ? e.detail.value : '';

            if (!value) {
                // Empty - clear selection
                this.state.selectedDate = null;
                this.state.inputError = '';
                this.emitChange(null, '');
                return;
            }

            const date = this.parseInputDate(value);
            if (date) {
                if (this.isDateDisabled(date)) {
                    this.state.inputError = 'Date is outside allowed range';
                } else {
                    this.state.selectedDate = date.getTime();
                    this.state.viewDate = date.getTime();
                    this.state.inputError = '';
                    this.state.inputValue = this.formatDisplayDate(date);
                    this.emitChange(null, this.toISODate(date));
                }
            } else {
                this.state.inputError = 'Invalid date format';
            }
        },

        handleInputKeydown(e) {
            if (e.key === 'Enter') {
                // Trigger validation by blurring the input
                e.target.blur();
                this.state.showPicker = false;
            } else if (e.key === 'Escape') {
                this.state.showPicker = false;
            } else if (e.key === 'ArrowDown' && !this.state.showPicker) {
                e.preventDefault();
                this.togglePicker();
            }
        },

        handleCalendarClick(e) {
            // Prevent closing when clicking inside calendar
            e.stopPropagation();
        },

        goToToday() {
            const today = new Date();
            this.selectDate(today);
        },

        clearDate() {
            this.state.selectedDate = null;
            this.state.inputValue = '';
            this.state.inputError = '';
            this.emitChange(null, '');
        },

        getMonthYear() {
            const viewDate = new Date(this.state.viewDate);
            return viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        },

        getYear() {
            const viewDate = new Date(this.state.viewDate);
            return viewDate.getFullYear();
        },

        getYearRangeLabel() {
            return `${this.state.yearRangeStart} - ${this.state.yearRangeStart + 11}`;
        }
    },

    template() {
        const days = this.getDaysInMonth();
        const weekDays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
        const months = this.getMonths();
        const years = this.getYears();
        return html`
            <div class="cl-calendar-wrapper">
                ${when(this.props.label, html`
                    <label class="cl-label">${this.props.label}</label>
                `)}
                ${when(!this.props.inline, html`
                    <div class="calendar-input-wrapper">
                        <cl-input-mask
                            class="calendar-mask-input"
                            value="${this.state.inputValue}"
                            mask="${this.getDateMask()}"
                            placeholder="${this.props.placeholder || this.props.dateFormat}"
                            disabled="${this.props.disabled}"
                            hideError="${true}"
                            error="${this.state.inputError}"
                            on-input="handleMaskInput"
                            on-change="handleMaskChange"
                            on-keydown="handleInputKeydown">
                        </cl-input-mask>
                        <button
                            class="calendar-toggle ${this.state.inputError ? 'error' : ''}"
                            type="button"
                            disabled="${this.props.disabled}"
                            on-click="togglePicker">
                            <svg class="calendar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                <line x1="16" y1="2" x2="16" y2="6"></line>
                                <line x1="8" y1="2" x2="8" y2="6"></line>
                                <line x1="3" y1="10" x2="21" y2="10"></line>
                            </svg>
                        </button>
                    </div>
                    ${when(this.state.inputError, html`
                        <small class="error-text">${this.state.inputError}</small>
                    `)}
                `)}
                ${when(this.state.showPicker && !this.props.inline, html`
                    <div class="calendar-backdrop" on-click="closePicker"></div>
                `)}
                ${when(this.state.showPicker, html`
                    <div class="calendar-picker ${this.props.inline ? 'inline' : ''}" on-click="handleCalendarClick">
                        ${when(this.state.viewMode === 'days', html`
                            <div class="calendar-header">
                                <button class="nav-btn" on-click="previousMonth" title="Previous month">‹</button>
                                <div class="header-selectors">
                                    <button class="month-year-btn" on-click="switchToMonthView" title="Select month">
                                        ${new Date(this.state.viewDate).toLocaleDateString('en-US', { month: 'long' })}
                                    </button>
                                    <button class="month-year-btn" on-click="switchToYearView" title="Select year">
                                        ${this.getYear()}
                                    </button>
                                </div>
                                <button class="nav-btn" on-click="nextMonth" title="Next month">›</button>
                            </div>
                            <div class="calendar-grid">
                                ${each(weekDays, day => html`
                                    <div class="weekday">${day}</div>
                                `)}
                                ${each(days, date => {
                                    if (!date) {
                                        return html`<div class="day empty"></div>`;
                                    }
                                    const disabled = this.isDateDisabled(date);
                                    const classes = [
                                        'day',
                                        this.isSelectedDate(date) ? 'selected' : '',
                                        this.isToday(date) ? 'today' : '',
                                        disabled ? 'disabled' : ''
                                    ].filter(Boolean).join(' ');

                                    return html`
                                        <div
                                            class="${classes}"
                                            on-click="${disabled ? null : () => this.selectDate(date)}">
                                            ${date.getDate()}
                                        </div>
                                    `;
                                })}
                            </div>
                            <div class="calendar-footer">
                                <button class="footer-btn" on-click="goToToday">Today</button>
                                ${when(this.state.selectedDate, html`
                                    <button class="footer-btn clear-btn" on-click="clearDate">Clear</button>
                                `)}
                            </div>
                        `)}

                        ${when(this.state.viewMode === 'months', html`
                            <div class="calendar-header">
                                <button class="nav-btn" on-click="previousYear" title="Previous year">‹</button>
                                <button class="month-year-btn" on-click="switchToYearView" title="Select year">
                                    ${this.getYear()}
                                </button>
                                <button class="nav-btn" on-click="nextYear" title="Next year">›</button>
                            </div>
                            <div class="month-grid">
                                ${each(months, (month, idx) => {
                                    const classes = [
                                        'month-cell',
                                        this.isCurrentMonth(idx) ? 'current' : ''
                                    ].filter(Boolean).join(' ');
                                    return html`
                                        <div class="${classes}" on-click="${() => this.selectMonth(idx)}">
                                            ${month}
                                        </div>
                                    `;
                                })}
                            </div>
                        `)}

                        ${when(this.state.viewMode === 'years', html`
                            <div class="calendar-header">
                                <button class="nav-btn" on-click="previousYearRange" title="Previous years">‹</button>
                                <span class="year-range">${this.getYearRangeLabel()}</span>
                                <button class="nav-btn" on-click="nextYearRange" title="Next years">›</button>
                            </div>
                            <div class="year-grid">
                                ${each(years, year => {
                                    const classes = [
                                        'year-cell',
                                        this.isCurrentYear(year) ? 'current' : ''
                                    ].filter(Boolean).join(' ');
                                    return html`
                                        <div class="${classes}" on-click="${() => this.selectYear(year)}">
                                            ${year}
                                        </div>
                                    `;
                                })}
                            </div>
                        `)}
                    </div>
                `)}
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .cl-calendar-wrapper {
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

        .calendar-input-wrapper {
            display: flex;
            align-items: stretch;
        }

        .calendar-mask-input {
            flex: 1;
        }

        /* Style the input inside cl-input-mask */
        .calendar-mask-input::part(input),
        .calendar-input-wrapper cl-input-mask input {
            border-right: none;
            border-radius: 4px 0 0 4px;
        }

        .calendar-toggle {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0 12px;
            border: 1px solid var(--input-border, #ced4da);
            border-radius: 0 4px 4px 0;
            background: var(--input-bg, #fff);
            cursor: pointer;
            transition: all 0.2s;
        }

        .calendar-toggle:hover:not(:disabled) {
            background: var(--hover-bg, #f0f0f0);
        }

        .calendar-toggle:disabled {
            cursor: not-allowed;
            opacity: 0.6;
        }

        .calendar-toggle.error {
            border-color: var(--error-color, #dc3545);
        }

        .calendar-icon {
            width: 18px;
            height: 18px;
            color: var(--text-muted, #6c757d);
        }

        .error-text {
            font-size: 12px;
            color: var(--error-color, #dc3545);
        }

        .calendar-backdrop {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 999;
        }

        .calendar-picker {
            position: absolute;
            top: 100%;
            left: 0;
            margin-top: 4px;
            background: var(--input-bg, white);
            border: 1px solid var(--input-border, #ced4da);
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            padding: 12px;
            z-index: 1000;
            min-width: 280px;
        }

        .calendar-picker.inline {
            position: static;
            margin-top: 0;
            box-shadow: none;
            z-index: auto;
        }

        .calendar-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 12px;
            gap: 8px;
        }

        .header-selectors {
            display: flex;
            gap: 4px;
        }

        .month-year-btn {
            background: none;
            border: none;
            font-size: 14px;
            font-weight: 600;
            color: var(--text-color, #333);
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 4px;
            transition: all 0.2s;
        }

        .month-year-btn:hover {
            background: var(--hover-bg, #f0f0f0);
        }

        .year-range {
            font-weight: 600;
            font-size: 14px;
            color: var(--text-color, #333);
        }

        .nav-btn {
            background: none;
            border: none;
            font-size: 20px;
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 4px;
            color: var(--text-color, #333);
            transition: all 0.2s;
        }

        .nav-btn:hover {
            background: var(--hover-bg, #f0f0f0);
        }

        .calendar-grid {
            display: grid;
            grid-template-columns: repeat(7, 1fr);
            gap: 2px;
        }

        .weekday {
            text-align: center;
            font-size: 11px;
            font-weight: 600;
            color: var(--text-muted, #6c757d);
            padding: 4px;
        }

        .day {
            text-align: center;
            padding: 8px 4px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            transition: all 0.2s;
            color: var(--text-color, #333);
        }

        .day:not(.empty):not(.disabled):hover {
            background: var(--hover-bg, #f0f0f0);
        }

        .day.today {
            border: 1px solid var(--primary-color, #007bff);
        }

        .day.selected {
            background: var(--primary-color, #007bff);
            color: white;
        }

        .day.disabled {
            color: var(--text-muted, #ccc);
            cursor: not-allowed;
        }

        .day.empty {
            cursor: default;
        }

        .month-grid,
        .year-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 8px;
        }

        .year-grid {
            grid-template-columns: repeat(4, 1fr);
        }

        .month-cell,
        .year-cell {
            text-align: center;
            padding: 12px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            transition: all 0.2s;
            color: var(--text-color, #333);
        }

        .month-cell:hover,
        .year-cell:hover {
            background: var(--hover-bg, #f0f0f0);
        }

        .month-cell.current,
        .year-cell.current {
            background: var(--primary-color, #007bff);
            color: white;
        }

        .calendar-footer {
            display: flex;
            justify-content: space-between;
            margin-top: 12px;
            padding-top: 8px;
            border-top: 1px solid var(--input-border, #eee);
        }

        .footer-btn {
            background: none;
            border: none;
            color: var(--primary-color, #007bff);
            cursor: pointer;
            font-size: 13px;
            padding: 4px 8px;
            border-radius: 4px;
            transition: all 0.2s;
        }

        .footer-btn:hover {
            background: var(--hover-bg, #f0f0f0);
        }

        .clear-btn {
            color: var(--error-color, #dc3545);
        }
    `
});
