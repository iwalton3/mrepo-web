/**
 * DataTable - Advanced data table with sorting, filtering, and selection
 *
 * Accessibility features:
 * - Semantic table structure (table, thead, tbody, th, td)
 * - scope="col" on column headers
 * - aria-sort for sortable columns (ascending, descending, none)
 * - aria-selected for selectable rows
 * - role="grid" when selection is enabled (interactive table)
 * - role="columnheader" on th elements
 * - aria-label on checkboxes for row selection
 * - Keyboard navigation for selection (Enter/Space on rows)
 */
import { defineComponent, html, when, each } from '../../lib/framework.js';

// Counter for unique IDs
let datatableIdCounter = 0;

export default defineComponent('cl-datatable', {
    props: {
        value: [],
        columns: [],
        selectionmode: 'none', // 'none', 'single', 'multiple'
        selection: null,
        sortfield: '',
        sortorder: 1, // 1 for asc, -1 for desc
        paginator: false,
        rows: 10,
        currentpage: 0,
        arialabel: '' // Optional aria-label for the table
    },

    data() {
        return {
            sortBy: '',
            sortDirection: 1,
            datatableId: `cl-datatable-${++datatableIdCounter}`
        };
    },

    mounted() {
        this.state.sortBy = this.props.sortfield;
        this.state.sortDirection = this.props.sortorder;
    },

    methods: {
        getSelectedRows() {
            const selection = this.props.selection;
            if (!selection) return [];
            return Array.isArray(selection) ? selection : [selection];
        },

        handleSort(column) {
            if (!column.sortable) return;

            if (this.state.sortBy === column.field) {
                this.state.sortDirection = this.state.sortDirection * -1;
            } else {
                this.state.sortBy = column.field;
                this.state.sortDirection = 1;
            }

            this.emitEvent('sort', {
                field: this.state.sortBy,
                order: this.state.sortDirection
            });
        },

        handleRowClick(row, index) {
            if (this.props.selectionmode === 'single') {
                this.emitEvent('row-select', { data: row, index });
                this.emitChange(null, row);
            } else if (this.props.selectionmode === 'multiple') {
                const selectedRows = this.getSelectedRows();
                const idx = selectedRows.indexOf(row);
                let newSelection;
                if (idx >= 0) {
                    newSelection = selectedRows.filter((_, i) => i !== idx);
                    this.emitEvent('row-unselect', { data: row, index });
                } else {
                    newSelection = [...selectedRows, row];
                    this.emitEvent('row-select', { data: row, index });
                }
                this.emitChange(null, newSelection);
            }
        },

        isRowSelected(row) {
            const selected = this.getSelectedRows();
            // Use both reference and value equality for robustness with reactive proxies
            if (selected.includes(row)) return true;

            // If row has an id property, compare by id
            if (row && typeof row === 'object' && 'id' in row) {
                return selected.some(s => s && typeof s === 'object' && s.id === row.id);
            }

            // Deep equality check as fallback
            return selected.some(s => JSON.stringify(s) === JSON.stringify(row));
        },

        getSortedData() {
            const value = this.props.value;
            let data = Array.isArray(value) ? [...value] : [];

            if (this.state.sortBy) {
                data.sort((a, b) => {
                    const aVal = a[this.state.sortBy];
                    const bVal = b[this.state.sortBy];

                    if (aVal < bVal) return -1 * this.state.sortDirection;
                    if (aVal > bVal) return 1 * this.state.sortDirection;
                    return 0;
                });
            }

            return data;
        },

        getPaginatedData() {
            const data = this.getSortedData();

            if (!this.props.paginator) {
                return data;
            }

            const start = this.props.currentpage * this.props.rows;
            const end = start + this.props.rows;
            return data.slice(start, end);
        },

        getCellValue(row, column) {
            if (column.body) {
                return column.body(row);
            }
            return row[column.field];
        },

        getSortIcon(column) {
            if (!column.sortable) return '';
            if (this.state.sortBy !== column.field) return '⇅';
            return this.state.sortDirection === 1 ? '↑' : '↓';
        },

        emitEvent(name, detail) {
            this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
        },

        /**
         * Get aria-sort value for a column
         */
        getAriaSort(column) {
            if (!column.sortable) return undefined;
            if (this.state.sortBy !== column.field) return 'none';
            return this.state.sortDirection === 1 ? 'ascending' : 'descending';
        },

        /**
         * Handle keyboard navigation for row selection
         */
        handleRowKeyDown(e, row, index) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.handleRowClick(row, index);
            }
        },

        /**
         * Get a label for a row for screen readers
         */
        getRowLabel(row, index) {
            // Try to get a meaningful label from the first column
            const columns = this.props.columns || [];
            if (columns.length > 0) {
                const firstValue = this.getCellValue(row, columns[0]);
                return `Row ${index + 1}: ${firstValue}`;
            }
            return `Row ${index + 1}`;
        }
    },

    template() {
        const data = this.getPaginatedData();
        const columns = this.props.columns || [];
        const hasSelection = this.props.selectionmode !== 'none';
        // Use role="grid" for interactive tables with selection
        const tableRole = hasSelection ? 'grid' : undefined;

        return html`
            <div class="cl-datatable">
                <div class="datatable-wrapper">
                    <table role="${tableRole}"
                           aria-label="${this.props.arialabel || undefined}">
                        <thead>
                            <tr>
                                ${when(hasSelection && this.props.selectionmode === 'multiple', html`
                                    <th class="selection-col" scope="col">
                                        <span class="visually-hidden">Selection</span>
                                    </th>
                                `)}
                                ${each(columns, column => html`
                                    <th
                                        scope="col"
                                        role="columnheader"
                                        class="${column.sortable ? 'sortable' : ''}"
                                        aria-sort="${this.getAriaSort(column)}"
                                        on-click="${() => this.handleSort(column)}">
                                        <div class="header-content">
                                            <span>${column.header}</span>
                                            ${when(column.sortable, html`
                                                <span class="sort-icon" aria-hidden="true">${this.getSortIcon(column)}</span>
                                            `)}
                                        </div>
                                    </th>
                                `)}
                            </tr>
                        </thead>
                        <tbody>
                            ${when(data.length === 0, html`
                                <tr>
                                    <td colspan="${columns.length + (hasSelection ? 1 : 0)}" class="empty-message">
                                        No data available
                                    </td>
                                </tr>
                            `)}
                            ${each(data, (row, index) => html`
                                <tr
                                    class="${this.isRowSelected(row) ? 'selected' : ''} ${hasSelection ? 'selectable' : ''}"
                                    tabindex="${hasSelection ? '0' : undefined}"
                                    aria-selected="${hasSelection ? (this.isRowSelected(row) ? 'true' : 'false') : undefined}"
                                    on-click="${() => this.handleRowClick(row, index)}"
                                    on-keydown="${(e) => this.handleRowKeyDown(e, row, index)}">
                                    ${when(hasSelection && this.props.selectionmode === 'multiple', html`
                                        <td class="selection-col">
                                            <input type="checkbox"
                                                   checked="${this.isRowSelected(row)}"
                                                   readonly
                                                   tabindex="-1"
                                                   aria-label="${this.getRowLabel(row, index)}">
                                        </td>
                                    `)}
                                    ${each(columns, column => html`
                                        <td>${this.getCellValue(row, column)}</td>
                                    `)}
                                </tr>
                            `)}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .cl-datatable {
            border: 1px solid var(--input-border, #dee2e6);
            border-radius: 4px;
            overflow: hidden;
        }

        .datatable-wrapper {
            overflow-x: auto;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 14px;
        }

        thead {
            background: var(--table-header-bg, #f8f9fa);
        }

        th {
            padding: 12px;
            text-align: left;
            font-weight: 600;
            color: var(--text-color, #333);
            border-bottom: 2px solid var(--input-border, #dee2e6);
            user-select: none;
        }

        th.sortable {
            cursor: pointer;
        }

        th.sortable:hover {
            background: var(--hover-bg, #e9ecef);
        }

        .header-content {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }

        .sort-icon {
            font-size: 12px;
            color: var(--text-muted, #6c757d);
        }

        tbody tr {
            border-bottom: 1px solid var(--input-border, #dee2e6);
        }

        tbody tr:last-child {
            border-bottom: none;
        }

        tbody tr.selectable {
            cursor: pointer;
        }

        tbody tr.selectable:hover {
            background: var(--hover-bg, #f8f9fa);
        }

        tbody tr.selected {
            background: var(--selected-bg, #e7f3ff);
        }

        td {
            padding: 12px;
            color: var(--text-color, #333);
        }

        .selection-col {
            width: 40px;
            text-align: center;
        }

        .selection-col input[type="checkbox"] {
            pointer-events: none;
        }

        .empty-message {
            text-align: center;
            padding: 40px 20px;
            color: var(--text-muted, #6c757d);
        }

        /* Visually hidden but accessible to screen readers */
        .visually-hidden {
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border: 0;
        }

        /* Focus styles for keyboard navigation */
        tbody tr:focus {
            outline: 2px solid var(--primary-color, #007bff);
            outline-offset: -2px;
        }
    `
});
