/**
 * Shell - Responsive layout with top bar, sidebar, and hamburger menu
 */
import { defineComponent, html, when, each } from '../../lib/framework.js';

export default defineComponent('cl-shell', {
    props: {
        title: 'VDX',
        subtitle: '',
        logo: '',
        menuItems: [],      // [{label, icon, key, items?}] - items is for submenu
        activeItem: null,
        sidebarWidth: '280px'
    },

    data() {
        return {
            sidebarOpen: false,
            isMobile: false,
            expandedGroups: {}
        };
    },

    mounted() {
        this.checkMobile();
        this._resizeHandler = () => this.checkMobile();
        window.addEventListener('resize', this._resizeHandler);

        // Auto-expand group containing active item on initial load
        this.expandActiveItemGroup();
    },

    unmounted() {
        window.removeEventListener('resize', this._resizeHandler);
    },

    propsChanged(prop, newValue, oldValue) {
        // When activeItem changes (e.g., navigation), expand its parent group
        if (prop === 'activeItem' && newValue !== oldValue) {
            this.expandActiveItemGroup();
        }
    },

    methods: {
        checkMobile() {
            const wasMobile = this.state.isMobile;
            this.state.isMobile = window.innerWidth < 768;
            // Close sidebar when switching to desktop
            if (wasMobile && !this.state.isMobile) {
                this.state.sidebarOpen = false;
            }
        },

        toggleSidebar() {
            this.state.sidebarOpen = !this.state.sidebarOpen;
        },

        closeSidebar() {
            if (this.state.isMobile) {
                this.state.sidebarOpen = false;
            }
        },

        handleItemClick(item) {
            if (item.items && item.items.length > 0) {
                // Toggle group expansion
                const key = item.key || item.label;
                this.state.expandedGroups = {
                    ...this.state.expandedGroups,
                    [key]: !this.state.expandedGroups[key]
                };
            } else {
                // Emit change event
                this.emitChange(null, item.key || item.label, 'activeItem');
                this.closeSidebar();
            }
        },

        isItemActive(item) {
            return this.props.activeItem === (item.key || item.label);
        },

        isGroupExpanded(item) {
            const key = item.key || item.label;
            return this.state.expandedGroups[key] || false;
        },

        expandActiveItemGroup() {
            const activeItem = this.props.activeItem;
            if (!activeItem) return;

            // Find which group contains the active item
            for (const item of this.props.menuItems) {
                if (item.items && item.items.length > 0) {
                    // Check if any subitem matches the active item
                    const hasActiveChild = item.items.some(
                        subitem => (subitem.key || subitem.label) === activeItem
                    );
                    if (hasActiveChild) {
                        const groupKey = item.key || item.label;
                        if (!this.state.expandedGroups[groupKey]) {
                            this.state.expandedGroups = {
                                ...this.state.expandedGroups,
                                [groupKey]: true
                            };
                        }
                        break;
                    }
                }
            }
        }
    },

    template() {
        const sidebarClass = this.state.isMobile
            ? (this.state.sidebarOpen ? 'sidebar mobile open' : 'sidebar mobile')
            : 'sidebar desktop';

        return html`
            <div class="shell-container">
                <!-- Top Bar -->
                <header class="topbar">
                    <div class="topbar-left">
                        ${when(this.state.isMobile, html`
                            <button class="hamburger" on-click="toggleSidebar" aria-label="Toggle menu">
                                <span class="hamburger-line"></span>
                                <span class="hamburger-line"></span>
                                <span class="hamburger-line"></span>
                            </button>
                        `)}
                        ${when(this.props.logo, html`
                            <img class="logo" src="${this.props.logo}" alt="${this.props.title}">
                        `)}
                        <div class="title-group">
                            <h1 class="title">${this.props.title}</h1>
                            ${when(this.props.subtitle, html`
                                <span class="subtitle">${this.props.subtitle}</span>
                            `)}
                        </div>
                    </div>
                    <div class="topbar-right">
                        ${this.props.slots.topbar || ''}
                    </div>
                </header>

                <div class="shell-body">
                    <!-- Sidebar Overlay (mobile) -->
                    ${when(this.state.isMobile && this.state.sidebarOpen, html`
                        <div class="sidebar-overlay" on-click="closeSidebar"></div>
                    `)}

                    <!-- Sidebar -->
                    <aside class="${sidebarClass}" style="--sidebar-width: ${this.props.sidebarWidth}">
                        <nav class="sidebar-nav">
                            ${each(this.props.menuItems, item => html`
                                <div class="nav-group">
                                    <div
                                        class="nav-item ${this.isItemActive(item) ? 'active' : ''} ${item.items ? 'has-children' : ''}"
                                        on-click="${() => this.handleItemClick(item)}">
                                        ${when(item.icon, html`<span class="nav-icon">${item.icon}</span>`)}
                                        <span class="nav-label">${item.label}</span>
                                        ${when(item.items, html`
                                            <span class="nav-arrow ${this.isGroupExpanded(item) ? 'expanded' : ''}">
                                                <svg viewBox="0 0 24 24" width="16" height="16">
                                                    <path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                                                </svg>
                                            </span>
                                        `)}
                                    </div>
                                    ${when(item.items && this.isGroupExpanded(item), html`
                                        <div class="nav-subitems">
                                            ${each(item.items, subitem => html`
                                                <div
                                                    class="nav-item sub ${this.isItemActive(subitem) ? 'active' : ''}"
                                                    on-click="${() => this.handleItemClick(subitem)}">
                                                    ${when(subitem.icon, html`<span class="nav-icon">${subitem.icon}</span>`)}
                                                    <span class="nav-label">${subitem.label}</span>
                                                </div>
                                            `)}
                                        </div>
                                    `)}
                                </div>
                            `)}
                        </nav>
                        <div class="sidebar-footer">
                            ${this.props.slots.sidebarFooter || ''}
                        </div>
                    </aside>

                    <!-- Main Content -->
                    <main class="main-content">
                        ${this.props.children}
                    </main>
                </div>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
            height: 100dvh;  /* Dynamic viewport height - excludes mobile browser UI */
            height: 100vh;   /* Fallback for older browsers */
            overflow: hidden;
        }

        @supports (height: 100dvh) {
            :host {
                height: 100dvh;
            }
        }

        .shell-container {
            display: flex;
            flex-direction: column;
            height: 100%;
            background: var(--shell-bg, #f5f5f5);
        }

        /* Top Bar */
        .topbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            height: 56px;
            padding: 0 16px;
            background: var(--topbar-bg, var(--primary-color, #1976d2));
            color: var(--topbar-text, white);
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            z-index: 1001;
        }

        .topbar-left {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .topbar-right {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .hamburger {
            display: flex;
            flex-direction: column;
            justify-content: space-around;
            width: 24px;
            height: 24px;
            background: transparent;
            border: none;
            cursor: pointer;
            padding: 0;
            color: var(--topbar-text, white);
        }

        .hamburger-line {
            display: block;
            width: 100%;
            height: 2px;
            background: currentColor;
            border-radius: 1px;
            transition: all 0.3s;
        }

        .logo {
            height: 32px;
            width: auto;
        }

        .title-group {
            display: flex;
            flex-direction: column;
        }

        .title {
            margin: 0;
            font-size: 18px;
            font-weight: 600;
            line-height: 1.2;
        }

        .subtitle {
            font-size: 12px;
            opacity: 0.8;
        }

        /* Shell Body */
        .shell-body {
            display: flex;
            flex: 1;
            overflow: hidden;
            position: relative;
        }

        /* Sidebar Overlay */
        .sidebar-overlay {
            position: fixed;
            top: 56px;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.5);
            z-index: 999;
            animation: fadeIn 0.2s ease-out;
        }

        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        /* Sidebar */
        .sidebar {
            display: flex;
            flex-direction: column;
            width: var(--sidebar-width);
            background: var(--sidebar-bg, var(--card-bg, white));
            border-right: 1px solid var(--border-color, var(--input-border, #e0e0e0));
            overflow: hidden;
            transition: transform 0.3s ease;
        }

        .sidebar.desktop {
            position: relative;
        }

        .sidebar.mobile {
            position: fixed;
            top: 56px;
            left: 0;
            bottom: 0;
            z-index: 1000;
            transform: translateX(-100%);
            box-shadow: 2px 0 8px rgba(0,0,0,0.15);
        }

        .sidebar.mobile.open {
            transform: translateX(0);
        }

        .sidebar-nav {
            flex: 1;
            overflow-y: auto;
            padding: 8px 0;
        }

        .sidebar-footer {
            padding: 12px 16px;
            border-top: 1px solid var(--border-color, var(--input-border, #e0e0e0));
        }

        .sidebar-footer:empty {
            display: none;
        }

        /* Navigation Items */
        .nav-group {
            margin-bottom: 4px;
        }

        .nav-item {
            display: flex;
            align-items: center;
            padding: 10px 16px;
            color: var(--text-primary, var(--text-color, #333));
            cursor: pointer;
            transition: all 0.2s;
            gap: 12px;
        }

        .nav-item:hover {
            background: var(--hover-bg, #f8f9fa);
        }

        .nav-item.active {
            background: var(--selected-bg, #e3f2fd);
            color: var(--primary-color, #1976d2);
            font-weight: 500;
            border-right: 3px solid var(--primary-color, #1976d2);
        }

        .nav-item.sub {
            padding-left: 48px;
            font-size: 14px;
        }

        .nav-icon {
            font-size: 18px;
            width: 24px;
            text-align: center;
        }

        .nav-label {
            flex: 1;
        }

        .nav-arrow {
            transition: transform 0.2s;
        }

        .nav-arrow.expanded {
            transform: rotate(180deg);
        }

        .nav-subitems {
            animation: slideDown 0.2s ease-out;
        }

        @keyframes slideDown {
            from {
                opacity: 0;
                transform: translateY(-10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        /* Main Content */
        .main-content {
            flex: 1;
            overflow-y: auto;
            padding: var(--shell-content-padding, 24px);
            padding-bottom: calc(var(--shell-content-padding-bottom, 32px) + env(safe-area-inset-bottom, 0px));
        }

        /* Responsive */
        @media (max-width: 767px) {
            .topbar {
                padding: 0 12px;
            }

            .title {
                font-size: 16px;
            }

            .main-content {
                padding: var(--shell-content-padding, 16px);
                padding-bottom: calc(var(--shell-content-padding-bottom, 24px) + env(safe-area-inset-bottom, 0px));
            }
        }
    `
});
