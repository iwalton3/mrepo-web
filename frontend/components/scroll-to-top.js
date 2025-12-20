/**
 * Scroll To Top Button
 *
 * A floating button that appears when the user scrolls down,
 * allowing them to quickly return to the top of the page.
 */

import { defineComponent, html, when } from '../lib/framework.js';

export default defineComponent('scroll-to-top', {
    props: {
        threshold: 200  // How far to scroll before showing the button
    },

    data() {
        return {
            visible: false
        };
    },

    mounted() {
        this._scrollHandler = () => this._checkScroll();
        window.addEventListener('scroll', this._scrollHandler, true);
        // Initial check
        requestAnimationFrame(() => this._checkScroll());
    },

    unmounted() {
        if (this._scrollHandler) {
            window.removeEventListener('scroll', this._scrollHandler, true);
        }
    },

    methods: {
        _checkScroll() {
            // Get the main content container (shell's scrollable area)
            const mainContent = document.querySelector('div.router-wrapper');
            if (!mainContent) return;

            const scrollTop = mainContent.scrollTop;
            const shouldShow = scrollTop > this.props.threshold;

            if (shouldShow !== this.state.visible) {
                this.state.visible = shouldShow;
            }
        },

        scrollToTop() {
            const mainContent = document.querySelector('div.router-wrapper');
            if (mainContent) {
                mainContent.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }
    },

    template() {
        return html`
            ${when(this.state.visible, html`
                <button class="scroll-to-top-btn" on-click="scrollToTop" title="Scroll to top">
                    <svg viewBox="0 0 24 24" width="24" height="24">
                        <path fill="currentColor" d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/>
                    </svg>
                </button>
            `)}
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .scroll-to-top-btn {
            position: fixed;
            bottom: 24px;
            right: 24px;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background: var(--primary-500, #0066cc);
            color: white;
            border: none;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            transition: all 0.2s ease;
            z-index: 1000;
            animation: fadeIn 0.2s ease-out;
        }

        .scroll-to-top-btn:hover {
            background: var(--primary-400, #3399ff);
            transform: translateY(-2px);
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
        }

        .scroll-to-top-btn:active {
            transform: translateY(0);
        }

        @keyframes fadeIn {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        @media (max-width: 767px) {
            .scroll-to-top-btn {
                bottom: calc(16px + env(safe-area-inset-bottom, 0px));
                right: 12px;
                width: 40px;
                height: 40px;
            }

            .scroll-to-top-btn svg {
                width: 20px;
                height: 20px;
            }
        }
    `
});
