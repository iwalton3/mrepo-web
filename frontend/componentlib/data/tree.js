/**
 * Tree - Hierarchical tree view component
 */
import { defineComponent, html, when, each } from '../../lib/framework.js';

export default defineComponent('cl-tree', {
    props: {
        value: [],
        selectionmode: 'none', // 'none', 'single', 'multiple'
        selection: null
    },

    data() {
        return {
            expandedKeys: new Set(),
            selectedKeys: new Set()
        };
    },

    mounted() {
        if (this.props.selection) {
            const keys = Array.isArray(this.props.selection)
                ? this.props.selection
                : [this.props.selection];
            this.state.selectedKeys = new Set(keys);
        }
    },

    methods: {
        toggleNode(node) {
            const newExpanded = new Set(this.state.expandedKeys);
            if (newExpanded.has(node.key)) {
                newExpanded.delete(node.key);
            } else {
                newExpanded.add(node.key);
            }
            this.state.expandedKeys = newExpanded;
        },

        selectNode(node, event) {
            event.stopPropagation();

            if (this.props.selectionmode === 'none') return;

            const newSelected = new Set(this.state.selectedKeys);

            if (this.props.selectionmode === 'single') {
                newSelected.clear();
                newSelected.add(node.key);
            } else if (this.props.selectionmode === 'multiple') {
                if (newSelected.has(node.key)) {
                    newSelected.delete(node.key);
                } else {
                    newSelected.add(node.key);
                }
            }

            this.state.selectedKeys = newSelected;

            const selectedValues = this.props.selectionmode === 'single'
                ? node.key
                : Array.from(newSelected);

            this.emitChange(null, selectedValues);
        },

        isExpanded(node) {
            return this.state.expandedKeys.has(node.key);
        },

        isSelected(node) {
            return this.state.selectedKeys.has(node.key);
        },

        hasChildren(node) {
            return node.children && node.children.length > 0;
        },

        renderNode(node, level = 0) {
            const hasChildren = this.hasChildren(node);
            const isExpanded = this.isExpanded(node);
            const isSelected = this.isSelected(node);

            return html`
                <div class="tree-node" style="padding-left: ${level * 20}px">
                    <div
                        class="node-content ${isSelected ? 'selected' : ''}"
                        on-click="${(e) => this.selectNode(node, e)}">
                        ${when(hasChildren, html`
                            <span
                                class="node-toggle"
                                on-click="${(e) => {
                                    e.stopPropagation();
                                    this.toggleNode(node);
                                }}">
                                ${isExpanded ? '▼' : '▶'}
                            </span>
                        `, html`
                            <span class="node-toggle-placeholder"></span>
                        `)}
                        ${when(node.icon, html`
                            <span class="node-icon">${node.icon}</span>
                        `)}
                        <span class="node-label">${node.label}</span>
                    </div>
                    ${when(hasChildren && isExpanded, html`
                        <div class="node-children">
                            ${each(node.children, child => this.renderNode(child, level + 1))}
                        </div>
                    `)}
                </div>
            `;
        }
    },

    template() {
        const nodes = this.props.value || [];

        return html`
            <div class="cl-tree">
                ${when(nodes.length === 0, html`
                    <div class="empty-message">No items</div>
                `)}
                ${each(nodes, node => this.renderNode(node))}
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .cl-tree {
            border: 1px solid var(--input-border, #dee2e6);
            border-radius: 4px;
            background: var(--card-bg, white);
            overflow: auto;
        }

        .tree-node {
            user-select: none;
        }

        .node-content {
            display: flex;
            align-items: center;
            padding: 8px 12px;
            cursor: pointer;
            transition: background 0.2s;
        }

        .node-content:hover {
            background: var(--hover-bg, #f8f9fa);
        }

        .node-content.selected {
            background: var(--selected-bg, #e7f3ff);
        }

        .node-toggle {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 20px;
            font-size: 10px;
            margin-right: 4px;
            cursor: pointer;
            color: var(--text-muted, #6c757d);
        }

        .node-toggle-placeholder {
            display: inline-block;
            width: 20px;
            margin-right: 4px;
        }

        .node-icon {
            margin-right: 8px;
        }

        .node-label {
            font-size: 14px;
            color: var(--text-color, #333);
        }

        .node-children {
            /* Children are indented via inline padding */
        }

        .empty-message {
            padding: 20px;
            text-align: center;
            color: var(--text-muted, #6c757d);
        }
    `
});
