/**
 * VFS Folder Manager Component
 *
 * Private-feature UI for managing the backend's Virtual File System (VFS)
 * path mappings: moving/renaming folders virtually and reviewing/removing the
 * resulting mappings. The actual API surface is supplied by the deployment
 * through `profile.vfs` (an adapter with listMappings/moveFolder/removeMapping);
 * on deployments whose backend has no VFS support `profile.vfs` is null and this
 * component is never rendered (browse-page gates its mount and trigger buttons
 * on `profile.vfs`).
 *
 * This file is byte-identical across the public and private copies - the
 * capability difference lives entirely in profile.js.
 *
 * Public API (called by browse-page via document.querySelector):
 *   - openMove(item, currentPath): open the "move folder" dialog for a folder
 *   - openMappings(): open the mappings list dialog
 * Emits:
 *   - 'vfs-changed' (bubbles) after a successful move or mapping removal, so
 *     the host page can reload the current view.
 */

import { defineComponent, html, when, each, Component } from 'vdx/framework.js';
import { profile } from '#profile';

export class VfsFolderManager extends Component {
    constructor(props) {
        super(props);

        this.state = {
            showMoveDialog: false,
            moveSourcePath: '',
            moveDestPath: '',
            vfsMappings: [],
            showMappingsDialog: false,
            isLoading: false,
            pendingRemoveMapping: null
        };
    }

    // --- Public API (invoked by the host page) -------------------------
    openMove(item, currentPath) {
        if (!item) return;
        const base = currentPath || '/';
        const sourcePath = base === '/'
            ? item.name
            : base.replace(/^\//, '') + '/' + item.name;
        this.state.moveSourcePath = sourcePath;
        this.state.moveDestPath = sourcePath;
        this.state.showMoveDialog = true;
    }

    async openMappings() {
        this.state.showMappingsDialog = true;
        await this.loadMappings();
    }

    // --- Move dialog ---------------------------------------------------
    closeMoveDialog() {
        this.state.showMoveDialog = false;
    }

    async handleMoveFolder() {
        const { moveSourcePath, moveDestPath } = this.state;
        if (!moveSourcePath || !moveDestPath) return;
        if (moveSourcePath === moveDestPath) {
            this.closeMoveDialog();
            return;
        }

        this.state.isLoading = true;
        try {
            const result = await profile.vfs.moveFolder(moveSourcePath, moveDestPath);
            if (result && result.success) {
                this.closeMoveDialog();
                this._notifyChanged();
            } else {
                const toast = document.querySelector('cl-toast');
                if (toast) toast.show({ severity: 'error', summary: 'Error', detail: (result && result.error) || 'Failed to move folder' });
            }
        } catch (e) {
            console.error('Failed to move folder:', e);
            const toast = document.querySelector('cl-toast');
            if (toast) toast.show({ severity: 'error', summary: 'Error', detail: 'Failed to move folder' });
        } finally {
            this.state.isLoading = false;
        }
    }

    // --- Mappings dialog ----------------------------------------------
    closeMappingsDialog() {
        this.state.showMappingsDialog = false;
    }

    async loadMappings() {
        try {
            const result = await profile.vfs.listMappings();
            this.state.vfsMappings = (result && result.items) || [];
        } catch (e) {
            console.error('Failed to load mappings:', e);
        }
    }

    handleRemoveMapping(mapping) {
        this.state.pendingRemoveMapping = mapping;
    }

    cancelRemoveMapping() {
        this.state.pendingRemoveMapping = null;
    }

    async doRemoveMapping() {
        const mapping = this.state.pendingRemoveMapping;
        if (!mapping) return;
        try {
            await profile.vfs.removeMapping(mapping.id);
            await this.loadMappings();
            this._notifyChanged();
        } catch (e) {
            console.error('Failed to remove mapping:', e);
        }
        this.state.pendingRemoveMapping = null;
    }

    // --- Internal ------------------------------------------------------
    _notifyChanged() {
        this.dispatchEvent(new CustomEvent('vfs-changed', { bubbles: true, composed: true }));
    }

    template() {
        const { showMoveDialog, showMappingsDialog, isLoading, vfsMappings, pendingRemoveMapping } = this.state;

        return html`
            <!-- Move Folder Dialog -->
            ${when(showMoveDialog, () => html`
                <cl-dialog visible="true" header="Move Folder"
                    on-change="${(e, val) => { if (!val) this.closeMoveDialog(); }}">
                    <div class="move-dialog-content">
                        <div class="form-row">
                            <label>Original Path</label>
                            <input type="text" readonly value="${this.state.moveSourcePath}"
                                   on-change-stop="${() => {}}">
                        </div>
                        <div class="form-row">
                            <label>New Path</label>
                            <input type="text"
                                   x-model="moveDestPath"
                                   on-change-stop="${() => {}}">
                        </div>
                        <p class="help-text">
                            This creates a virtual mapping. The original files are not moved.
                        </p>
                    </div>
                    <div slot="footer">
                        <cl-button severity="secondary" on-click="closeMoveDialog">Cancel</cl-button>
                        <cl-button severity="primary" on-click="handleMoveFolder" loading="${isLoading}">
                            Move
                        </cl-button>
                    </div>
                </cl-dialog>
            `)}

            <!-- Mappings Dialog -->
            ${when(showMappingsDialog, () => html`
                <cl-dialog visible="true" header="VFS Path Mappings"
                    on-change="${(e, val) => { if (!val) this.closeMappingsDialog(); }}">
                    <div class="mappings-content">
                        ${when(vfsMappings.length === 0, html`
                            <p class="empty-mappings">No path mappings configured.</p>
                        `, () => html`
                            <div class="mappings-list">
                                ${each(vfsMappings, mapping => html`
                                    <div class="mapping-item">
                                        <div class="mapping-paths">
                                            <div class="mapping-original">${mapping.original_prefix}</div>
                                            <div class="mapping-arrow">→</div>
                                            <div class="mapping-virtual">${mapping.virtual_prefix}</div>
                                        </div>
                                        <button class="remove-mapping-btn"
                                                on-click="${() => this.handleRemoveMapping(mapping)}"
                                                title="Remove">
                                            ✕
                                        </button>
                                    </div>
                                `)}
                            </div>
                        `)}
                        <p class="help-text">
                            Mappings transform file paths virtually without moving actual files.
                            Click ✏️ on any folder to create a new mapping.
                            After changes, run <code>rebuild_vfs_cache.py</code> to update the cache.
                        </p>
                    </div>
                    <div slot="footer">
                        <cl-button severity="primary" on-click="closeMappingsDialog">Close</cl-button>
                    </div>
                </cl-dialog>
            `)}

            <!-- Remove Mapping Confirm -->
            ${when(pendingRemoveMapping, () => html`
                <cl-dialog visible="true" header="Remove Mapping" on-close="cancelRemoveMapping">
                    <p>Remove mapping "${pendingRemoveMapping.original_prefix}" → "${pendingRemoveMapping.virtual_prefix}"?</p>
                    <div slot="footer" style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                        <cl-button severity="secondary" on-click="cancelRemoveMapping">Cancel</cl-button>
                        <cl-button severity="danger" on-click="doRemoveMapping">Remove</cl-button>
                    </div>
                </cl-dialog>
            `)}
        `;
    }

    static styles = /*css*/`
        .move-dialog-content,
        .mappings-content {
            padding: 0.5rem 0;
        }

        .form-row {
            margin-bottom: 1rem;
        }

        .form-row label {
            display: block;
            font-weight: 500;
            margin-bottom: 0.25rem;
            font-size: 0.875rem;
            color: var(--text-primary, #e0e0e0);
        }

        .form-row input {
            width: 100%;
            padding: 0.5rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-primary, #e0e0e0);
        }

        .form-row input[readonly] {
            background: var(--surface-200, #2d2d2d);
            color: var(--text-secondary, #a0a0a0);
        }

        .help-text {
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
            margin-top: 0.5rem;
        }

        .empty-mappings {
            text-align: center;
            color: var(--text-secondary, #a0a0a0);
            padding: 1rem;
        }

        .mappings-list {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        .mapping-item {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.5rem;
            background: var(--surface-100, #242424);
            border-radius: 4px;
        }

        .mapping-paths {
            flex: 1;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            overflow: hidden;
        }

        .mapping-original,
        .mapping-virtual {
            font-size: 0.875rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .mapping-original {
            color: var(--text-secondary, #a0a0a0);
        }

        .mapping-arrow {
            color: var(--text-muted, #707070);
            flex-shrink: 0;
        }

        .remove-mapping-btn {
            background: none;
            border: none;
            cursor: pointer;
            color: var(--text-muted, #707070);
            padding: 0.25rem;
        }

        .remove-mapping-btn:hover {
            color: var(--danger-500, #dc3545);
        }
    `
}

export default defineComponent('vfs-folder-manager', VfsFolderManager);
