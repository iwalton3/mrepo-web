/**
 * Paginator - Pagination controls
 */
import { defineComponent, html, when, each } from '../../lib/framework.js';

export default defineComponent('cl-paginator', {
    props: {
        totalrecords: 0,
        rows: 10,
        first: 0,
        pagerlinksize: 5
    },

    methods: {
        totalPages() {
            return Math.ceil(this.props.totalrecords / this.props.rows);
        },

        currentPage() {
            return Math.floor(this.props.first / this.props.rows);
        },

        changePage(page) {
            if (page < 0 || page >= this.totalPages()) return;

            const first = page * this.props.rows;
            this.emitChange(null, {
                first,
                page,
                rows: this.props.rows
            });
        },

        goToFirstPage() {
            this.changePage(0);
        },

        goToLastPage() {
            this.changePage(this.totalPages() - 1);
        },

        goToPreviousPage() {
            this.changePage(this.currentPage() - 1);
        },

        goToNextPage() {
            this.changePage(this.currentPage() + 1);
        },

        getPageNumbers() {
            const current = this.currentPage();
            const total = this.totalPages();
            const linkSize = this.props.pagerlinksize;

            let start = Math.max(0, current - Math.floor(linkSize / 2));
            let end = Math.min(total, start + linkSize);

            // Adjust start if we're near the end
            if (end - start < linkSize) {
                start = Math.max(0, end - linkSize);
            }

            const pages = [];
            for (let i = start; i < end; i++) {
                pages.push(i);
            }

            return pages;
        }
    },

    template() {
        const pages = this.getPageNumbers();
        const current = this.currentPage();
        const total = this.totalPages();
        const start = this.props.first + 1;
        const end = Math.min(this.props.first + this.props.rows, this.props.totalrecords);

        return html`
            <div class="cl-paginator">
                <div class="paginator-info">
                    Showing ${start} to ${end} of ${this.props.totalrecords} entries
                </div>
                <div class="paginator-controls">
                    <button
                        class="page-btn"
                        disabled="${current === 0}"
                        on-click="goToFirstPage"
                        title="First Page">«</button>
                    <button
                        class="page-btn"
                        disabled="${current === 0}"
                        on-click="goToPreviousPage"
                        title="Previous Page">‹</button>

                    ${each(pages, page => html`
                        <button
                            class="page-btn ${page === current ? 'active' : ''}"
                            on-click="${() => this.changePage(page)}">
                            ${page + 1}
                        </button>
                    `)}

                    <button
                        class="page-btn"
                        disabled="${current >= total - 1}"
                        on-click="goToNextPage"
                        title="Next Page">›</button>
                    <button
                        class="page-btn"
                        disabled="${current >= total - 1}"
                        on-click="goToLastPage"
                        title="Last Page">»</button>
                </div>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .cl-paginator {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px;
            border-top: 1px solid var(--input-border, #dee2e6);
            flex-wrap: wrap;
            gap: 12px;
        }

        .paginator-info {
            font-size: 14px;
            color: var(--text-muted, #6c757d);
        }

        .paginator-controls {
            display: flex;
            gap: 4px;
        }

        .page-btn {
            min-width: 36px;
            height: 36px;
            padding: 0 8px;
            border: 1px solid var(--input-border, #dee2e6);
            background: var(--card-bg, white);
            color: var(--text-color, #333);
            font-size: 14px;
            cursor: pointer;
            border-radius: 4px;
            transition: all 0.2s;
        }

        .page-btn:hover:not(:disabled) {
            background: var(--hover-bg, #f8f9fa);
            border-color: var(--primary-color, #007bff);
        }

        .page-btn:disabled {
            cursor: not-allowed;
            opacity: 0.5;
        }

        .page-btn.active {
            background: var(--primary-color, #007bff);
            color: white;
            border-color: var(--primary-color, #007bff);
        }
    `
});
