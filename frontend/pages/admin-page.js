/**
 * Admin page for user and system management.
 */
import { defineComponent, html, when, each } from '../lib/framework.js';
import { admin, aiAdmin } from '../api/music-api.js';

export default defineComponent('admin-page', {
    props: {
        params: {},
        query: {}
    },

    data() {
        return {
            users: [],
            loading: true,
            error: null,

            // User form
            showUserForm: false,
            editingUser: null,
            formUsername: '',
            formPassword: '',
            formCapabilities: 'user',
            formError: null,
            formSaving: false,

            // Library scan
            scanStatus: null,
            scanning: false,

            // Path relocation
            oldPrefix: '',
            newPrefix: '',
            relocatePreview: null,
            relocating: false,

            // Missing files
            missingFiles: null,
            findingMissing: false,
            removingMissing: false,

            // AI Features
            aiStatus: null,
            aiAnalyzing: false,
            aiClearing: false
        };
    },

    async mounted() {
        this._pollTimer = null;
        this._aiPollTimer = null;
        await this.loadUsers();
        await this.loadScanStatus();
        await this.loadAiStatus();

        // Resume polling if a scan is running
        if (this.state.scanStatus?.status === 'running') {
            this.state.scanning = true;
            this.pollScanStatus();
        }

        // Resume AI polling if analysis is running
        if (this.state.aiStatus?.currentJob?.status === 'running') {
            this.state.aiAnalyzing = true;
            this.pollAiStatus();
        }
    },

    unmounted() {
        // Clean up polling timers
        if (this._pollTimer) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }
        if (this._aiPollTimer) {
            clearTimeout(this._aiPollTimer);
            this._aiPollTimer = null;
        }
    },

    methods: {
        async loadUsers() {
            this.state.loading = true;
            this.state.error = null;
            try {
                const result = await admin.listUsers();
                this.state.users = result.users || result || [];
            } catch (err) {
                this.state.error = err.message;
            } finally {
                this.state.loading = false;
            }
        },

        async loadScanStatus() {
            try {
                this.state.scanStatus = await admin.getScanStatus();
            } catch (err) {
                // Scan status not critical
                console.warn('Failed to load scan status:', err);
            }
        },

        showCreateUser() {
            this.state.editingUser = null;
            this.state.formUsername = '';
            this.state.formPassword = '';
            this.state.formCapabilities = 'user';
            this.state.formError = null;
            this.state.showUserForm = true;
        },

        showEditUser(user) {
            this.state.editingUser = user;
            this.state.formUsername = user.username;
            this.state.formPassword = '';
            this.state.formCapabilities = user.capabilities || 'user';
            this.state.formError = null;
            this.state.showUserForm = true;
        },

        cancelUserForm() {
            this.state.showUserForm = false;
            this.state.editingUser = null;
            this.state.formError = null;
        },

        async saveUser() {
            this.state.formError = null;
            this.state.formSaving = true;

            try {
                if (this.state.editingUser) {
                    // Update existing user
                    const updates = {
                        username: this.state.formUsername,
                        capabilities: this.state.formCapabilities
                    };
                    if (this.state.formPassword) {
                        updates.password = this.state.formPassword;
                    }
                    await admin.updateUser(this.state.editingUser.id, updates);
                } else {
                    // Create new user
                    if (!this.state.formUsername || !this.state.formPassword) {
                        throw new Error('Username and password are required');
                    }
                    await admin.createUser(
                        this.state.formUsername,
                        this.state.formPassword,
                        this.state.formCapabilities
                    );
                }

                this.state.showUserForm = false;
                await this.loadUsers();
            } catch (err) {
                this.state.formError = err.message;
            } finally {
                this.state.formSaving = false;
            }
        },

        async deleteUser(user) {
            if (!confirm(`Delete user "${user.username}"? This cannot be undone.`)) {
                return;
            }

            try {
                await admin.deleteUser(user.id);
                await this.loadUsers();
            } catch (err) {
                alert('Failed to delete user: ' + err.message);
            }
        },

        async startScan(force = false) {
            this.state.scanning = true;
            try {
                await admin.startScan(null, force);
                // Poll for status
                this.pollScanStatus();
            } catch (err) {
                // If a scan is already running, offer to force-start
                if (err.message && err.message.includes('already running') && !force) {
                    if (confirm('A previous scan may be stale. Cancel it and start a new scan?')) {
                        this.startScan(true);
                        return;
                    }
                } else {
                    alert('Failed to start scan: ' + err.message);
                }
                this.state.scanning = false;
            }
        },

        async cancelScan() {
            try {
                await admin.cancelScan();
                this.state.scanning = false;
                await this.loadScanStatus();
            } catch (err) {
                alert('Failed to cancel scan: ' + err.message);
            }
        },

        async pollScanStatus() {
            // Clear any existing timer
            if (this._pollTimer) {
                clearTimeout(this._pollTimer);
                this._pollTimer = null;
            }

            const poll = async () => {
                try {
                    const status = await admin.getScanStatus();
                    this.state.scanStatus = status;

                    if (status && status.status === 'running') {
                        this._pollTimer = setTimeout(poll, 5000);
                    } else {
                        this._pollTimer = null;
                        this.state.scanning = false;
                    }
                } catch (err) {
                    this._pollTimer = null;
                    this.state.scanning = false;
                }
            };
            poll();
        },

        formatDate(dateStr) {
            if (!dateStr) return 'Never';
            const date = new Date(dateStr);
            return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
        },

        async previewRelocate() {
            if (!this.state.oldPrefix || !this.state.newPrefix) {
                alert('Please enter both old and new path prefixes');
                return;
            }
            this.state.relocating = true;
            try {
                const result = await admin.relocatePaths(
                    this.state.oldPrefix,
                    this.state.newPrefix,
                    true // dry run
                );
                this.state.relocatePreview = result;
            } catch (err) {
                alert('Failed to preview: ' + err.message);
            } finally {
                this.state.relocating = false;
            }
        },

        async applyRelocate() {
            if (!this.state.relocatePreview || this.state.relocatePreview.affected === 0) {
                return;
            }
            if (!confirm(`Update ${this.state.relocatePreview.affected} file paths?`)) {
                return;
            }
            this.state.relocating = true;
            try {
                const result = await admin.relocatePaths(
                    this.state.oldPrefix,
                    this.state.newPrefix,
                    false // apply
                );
                alert(`Updated ${result.updated} file paths`);
                this.state.relocatePreview = null;
                this.state.oldPrefix = '';
                this.state.newPrefix = '';
            } catch (err) {
                alert('Failed to relocate: ' + err.message);
            } finally {
                this.state.relocating = false;
            }
        },

        async findMissing() {
            this.state.findingMissing = true;
            try {
                const result = await admin.findMissing(100);
                this.state.missingFiles = result;
            } catch (err) {
                alert('Failed to find missing files: ' + err.message);
            } finally {
                this.state.findingMissing = false;
            }
        },

        async removeMissing() {
            if (!this.state.missingFiles || this.state.missingFiles.count === 0) {
                return;
            }
            if (!confirm(`Remove ${this.state.missingFiles.count} songs with missing files from the database?`)) {
                return;
            }
            this.state.removingMissing = true;
            try {
                const result = await admin.removeMissing();
                alert(`Removed ${result.removed} songs`);
                this.state.missingFiles = null;
            } catch (err) {
                alert('Failed to remove missing: ' + err.message);
            } finally {
                this.state.removingMissing = false;
            }
        },

        // AI Methods
        async loadAiStatus() {
            try {
                this.state.aiStatus = await aiAdmin.status();
            } catch (err) {
                // AI status not critical - may not be enabled
                console.warn('Failed to load AI status:', err);
                this.state.aiStatus = null;
            }
        },

        async startAiAnalysis(force = false) {
            this.state.aiAnalyzing = true;
            try {
                await aiAdmin.startAnalysis(force);
                this.pollAiStatus();
            } catch (err) {
                if (err.message && err.message.includes('already running') && !force) {
                    if (confirm('An AI analysis job is already running. Cancel it and start a new one?')) {
                        this.startAiAnalysis(true);
                        return;
                    }
                } else {
                    alert('Failed to start AI analysis: ' + err.message);
                }
                this.state.aiAnalyzing = false;
            }
        },

        async cancelAiAnalysis() {
            try {
                await aiAdmin.cancelAnalysis();
                this.state.aiAnalyzing = false;
                await this.loadAiStatus();
            } catch (err) {
                alert('Failed to cancel AI analysis: ' + err.message);
            }
        },

        async pollAiStatus() {
            if (this._aiPollTimer) {
                clearTimeout(this._aiPollTimer);
                this._aiPollTimer = null;
            }

            const poll = async () => {
                try {
                    const status = await aiAdmin.status();
                    this.state.aiStatus = status;

                    if (status?.currentJob?.status === 'running') {
                        this._aiPollTimer = setTimeout(poll, 3000);
                    } else {
                        this._aiPollTimer = null;
                        this.state.aiAnalyzing = false;
                    }
                } catch (err) {
                    this._aiPollTimer = null;
                    this.state.aiAnalyzing = false;
                }
            };
            poll();
        },

        async clearAiEmbeddings() {
            if (!confirm('Clear all AI embeddings? This will require re-analyzing all songs.')) {
                return;
            }
            this.state.aiClearing = true;
            try {
                const result = await aiAdmin.clearEmbeddings();
                alert(`Cleared ${result.cleared} embeddings`);
                await this.loadAiStatus();
            } catch (err) {
                alert('Failed to clear embeddings: ' + err.message);
            } finally {
                this.state.aiClearing = false;
            }
        },

        getAiProgressPercent() {
            const job = this.state.aiStatus?.currentJob;
            if (!job || !job.total_songs) return 0;
            return Math.round((job.processed_songs / job.total_songs) * 100);
        }
    },

    template() {
        return html`
            <div class="admin-page">
                <h1>Administration</h1>

                ${when(this.state.error, html`
                    <div class="error-banner">${this.state.error}</div>
                `)}

                <!-- User Management Section -->
                <section class="admin-section">
                    <div class="section-header">
                        <h2>User Management</h2>
                        <button class="btn-primary" on-click="showCreateUser">
                            Add User
                        </button>
                    </div>

                    ${when(this.state.loading, html`
                        <div class="loading">Loading users...</div>
                    `)}

                    ${when(!this.state.loading && this.state.users.length === 0, html`
                        <p class="empty-state">No users found.</p>
                    `)}

                    ${when(!this.state.loading && this.state.users.length > 0, html`
                        <table class="users-table">
                            <thead>
                                <tr>
                                    <th>Username</th>
                                    <th>Role</th>
                                    <th>Created</th>
                                    <th>Last Login</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${each(this.state.users, user => html`
                                    <tr>
                                        <td>${user.username}</td>
                                        <td>
                                            <span class="role-badge ${user.capabilities === 'admin' ? 'admin' : 'user'}">
                                                ${user.capabilities || 'user'}
                                            </span>
                                        </td>
                                        <td>${this.formatDate(user.created_at)}</td>
                                        <td>${this.formatDate(user.last_login)}</td>
                                        <td class="actions">
                                            <button class="btn-small" on-click="${() => this.showEditUser(user)}">
                                                Edit
                                            </button>
                                            <button class="btn-small btn-danger" on-click="${() => this.deleteUser(user)}">
                                                Delete
                                            </button>
                                        </td>
                                    </tr>
                                `)}
                            </tbody>
                        </table>
                    `)}
                </section>

                <!-- Library Scan Section -->
                <section class="admin-section">
                    <div class="section-header">
                        <h2>Library Scan</h2>
                        <div class="button-row">
                            ${when(this.state.scanStatus?.status === 'running', html`
                                <button class="btn-danger" on-click="cancelScan">
                                    Cancel Scan
                                </button>
                            `)}
                            <button
                                class="btn-primary"
                                on-click="startScan"
                                disabled="${this.state.scanning}">
                                ${this.state.scanning ? 'Scanning...' : 'Start Scan'}
                            </button>
                        </div>
                    </div>

                    ${when(this.state.scanStatus, () => html`
                        <div class="scan-status">
                            <div class="status-row">
                                <span class="label">Status:</span>
                                <span class="value ${this.state.scanStatus.status}">
                                    ${this.state.scanStatus.status || 'idle'}
                                </span>
                            </div>
                            ${when(this.state.scanStatus.total_files > 0, () => html`
                                <div class="status-row">
                                    <span class="label">Progress:</span>
                                    <span class="value">
                                        ${this.state.scanStatus.processed_files} / ${this.state.scanStatus.total_files}
                                    </span>
                                </div>
                                <div class="progress-bar">
                                    <div class="progress-fill" style="width: ${Math.round(this.state.scanStatus.processed_files / this.state.scanStatus.total_files * 100)}%"></div>
                                </div>
                            `)}
                            ${when(this.state.scanStatus.new_songs > 0, () => html`
                                <div class="status-row">
                                    <span class="label">New songs:</span>
                                    <span class="value">${this.state.scanStatus.new_songs}</span>
                                </div>
                            `)}
                            ${when(this.state.scanStatus.updated_songs > 0, () => html`
                                <div class="status-row">
                                    <span class="label">Updated:</span>
                                    <span class="value">${this.state.scanStatus.updated_songs}</span>
                                </div>
                            `)}
                        </div>
                    `)}
                </section>

                <!-- Path Relocation Section -->
                <section class="admin-section">
                    <h2>Relocate File Paths</h2>
                    <p class="section-desc">Update file paths in bulk when music is moved to a new location.</p>

                    <div class="relocate-form">
                        <div class="form-row">
                            <div class="form-group">
                                <label>Old Path Prefix</label>
                                <input type="text" x-model="oldPrefix" placeholder="/old/music/path/">
                            </div>
                            <div class="form-group">
                                <label>New Path Prefix</label>
                                <input type="text" x-model="newPrefix" placeholder="/new/music/path/">
                            </div>
                        </div>
                        <div class="button-row">
                            <button class="btn-secondary" on-click="previewRelocate" disabled="${this.state.relocating}">
                                Preview
                            </button>
                            ${when(this.state.relocatePreview && this.state.relocatePreview.affected > 0, () => html`
                                <button class="btn-primary" on-click="applyRelocate" disabled="${this.state.relocating}">
                                    Update ${this.state.relocatePreview.affected} Files
                                </button>
                            `)}
                        </div>
                        ${when(this.state.relocatePreview, () => html`
                            <div class="preview-result">
                                ${this.state.relocatePreview.affected === 0
                                    ? 'No files match the old prefix.'
                                    : `${this.state.relocatePreview.affected} files would be updated.`}
                            </div>
                        `)}
                    </div>
                </section>

                <!-- Missing Files Section -->
                <section class="admin-section">
                    <h2>Missing Files</h2>
                    <p class="section-desc">Find and remove songs whose files no longer exist on disk.</p>

                    <div class="button-row">
                        <button class="btn-secondary" on-click="findMissing" disabled="${this.state.findingMissing}">
                            ${this.state.findingMissing ? 'Scanning...' : 'Find Missing Files'}
                        </button>
                        ${when(this.state.missingFiles && this.state.missingFiles.count > 0, () => html`
                            <button class="btn-danger" on-click="removeMissing" disabled="${this.state.removingMissing}">
                                Remove ${this.state.missingFiles.count} Missing
                            </button>
                        `)}
                    </div>

                    ${when(this.state.missingFiles, () => html`
                        <div class="missing-results">
                            ${this.state.missingFiles.count === 0
                                ? html`<p class="success-msg">No missing files found.</p>`
                                : html`
                                    <p class="warning-msg">
                                        Found ${this.state.missingFiles.count} missing files
                                        ${this.state.missingFiles.truncated ? ' (showing first 100)' : ''}:
                                    </p>
                                    <ul class="missing-list">
                                        ${each(this.state.missingFiles.missing.slice(0, 20), item => html`
                                            <li>
                                                <strong>${item.title || 'Unknown'}</strong>
                                                ${item.artist ? ` - ${item.artist}` : ''}
                                                <span class="file-path">${item.file}</span>
                                            </li>
                                        `)}
                                        ${when(this.state.missingFiles.count > 20, html`
                                            <li class="more-items">...and ${this.state.missingFiles.count - 20} more</li>
                                        `)}
                                    </ul>
                                `}
                        </div>
                    `)}
                </section>

                <!-- AI Features Section -->
                ${when(this.state.aiStatus, () => html`
                    <section class="admin-section ai-section">
                        <div class="section-header">
                            <h2>AI Features</h2>
                            <div class="ai-status-badge ${this.state.aiStatus.serviceOnline ? 'online' : 'offline'}">
                                ${this.state.aiStatus.serviceOnline ? 'Service Online' : 'Service Offline'}
                            </div>
                        </div>

                        ${when(!this.state.aiStatus.enabled, html`
                            <p class="section-desc">AI features are not enabled. Enable them in config.yaml.</p>
                        `)}

                        ${when(this.state.aiStatus.enabled, () => html`
                            <div class="ai-stats">
                                <div class="stat-card">
                                    <div class="stat-value">${this.state.aiStatus.indexedSongs}</div>
                                    <div class="stat-label">Analyzed Songs</div>
                                </div>
                                <div class="stat-card">
                                    <div class="stat-value">${this.state.aiStatus.totalSongs}</div>
                                    <div class="stat-label">Total Songs</div>
                                </div>
                                <div class="stat-card">
                                    <div class="stat-value">${this.state.aiStatus.pendingAnalysis}</div>
                                    <div class="stat-label">Pending</div>
                                </div>
                            </div>

                            ${when(this.state.aiStatus.currentJob?.status === 'running', () => html`
                                <div class="ai-job-status">
                                    <div class="status-row">
                                        <span class="label">Analysis Status:</span>
                                        <span class="value running">Running</span>
                                    </div>
                                    <div class="status-row">
                                        <span class="label">Progress:</span>
                                        <span class="value">
                                            ${this.state.aiStatus.currentJob.processed_songs} / ${this.state.aiStatus.currentJob.total_songs}
                                            (${this.getAiProgressPercent()}%)
                                        </span>
                                    </div>
                                    <div class="progress-bar">
                                        <div class="progress-fill ai-progress" style="width: ${this.getAiProgressPercent()}%"></div>
                                    </div>
                                </div>
                            `)}

                            ${when(this.state.aiStatus.currentJob && this.state.aiStatus.currentJob.status !== 'running', () => html`
                                <div class="ai-job-status">
                                    <div class="status-row">
                                        <span class="label">Last Job:</span>
                                        <span class="value ${this.state.aiStatus.currentJob.status}">
                                            ${this.state.aiStatus.currentJob.status}
                                        </span>
                                    </div>
                                    ${when(this.state.aiStatus.currentJob.processed_songs, () => html`
                                        <div class="status-row">
                                            <span class="label">Processed:</span>
                                            <span class="value">${this.state.aiStatus.currentJob.processed_songs} songs</span>
                                        </div>
                                    `)}
                                </div>
                            `)}

                            <div class="button-row ai-actions">
                                ${when(this.state.aiStatus.currentJob?.status === 'running', html`
                                    <button class="btn-danger" on-click="cancelAiAnalysis">
                                        Cancel Analysis
                                    </button>
                                `)}
                                <button
                                    class="btn-primary"
                                    on-click="startAiAnalysis"
                                    disabled="${this.state.aiAnalyzing || !this.state.aiStatus.serviceOnline}">
                                    ${this.state.aiAnalyzing ? 'Analyzing...' : 'Start Analysis'}
                                </button>
                                <button
                                    class="btn-secondary"
                                    on-click="clearAiEmbeddings"
                                    disabled="${this.state.aiClearing || this.state.aiAnalyzing}">
                                    Clear Embeddings
                                </button>
                            </div>

                            ${when(!this.state.aiStatus.serviceOnline && this.state.aiStatus.serviceUrl, html`
                                <p class="warning-msg">
                                    Cannot connect to AI service at ${this.state.aiStatus.serviceUrl}.
                                    Make sure the AI service container is running.
                                </p>
                            `)}
                        `)}
                    </section>
                `)}

                <!-- User Form Dialog -->
                ${when(this.state.showUserForm, html`
                    <div class="dialog-overlay" on-click="cancelUserForm">
                        <div class="dialog" on-click="${e => e.stopPropagation()}">
                            <h3>${this.state.editingUser ? 'Edit User' : 'Create User'}</h3>

                            ${when(this.state.formError, html`
                                <div class="form-error">${this.state.formError}</div>
                            `)}

                            <form on-submit-prevent="saveUser">
                                <div class="form-group">
                                    <label for="username">Username</label>
                                    <input
                                        type="text"
                                        id="username"
                                        x-model="formUsername"
                                        autocomplete="off"
                                        required>
                                </div>

                                <div class="form-group">
                                    <label for="password">
                                        Password
                                        ${when(this.state.editingUser, html`
                                            <span class="hint">(leave blank to keep current)</span>
                                        `)}
                                    </label>
                                    <input
                                        type="password"
                                        id="password"
                                        x-model="formPassword"
                                        autocomplete="new-password"
                                        required="${!this.state.editingUser}">
                                </div>

                                <div class="form-group">
                                    <label for="capabilities">Role</label>
                                    <select id="capabilities" x-model="formCapabilities">
                                        <option value="user">User</option>
                                        <option value="admin">Admin</option>
                                    </select>
                                </div>

                                <div class="form-actions">
                                    <button type="button" class="btn-secondary" on-click="cancelUserForm">
                                        Cancel
                                    </button>
                                    <button type="submit" class="btn-primary" disabled="${this.state.formSaving}">
                                        ${this.state.formSaving ? 'Saving...' : 'Save'}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                `)}
            </div>
        `;
    },

    styles: /*css*/`
        .admin-page {
            max-width: 900px;
            margin: 0 auto;
            padding: 1rem;
        }

        h1 {
            margin-bottom: 1.5rem;
        }

        .error-banner {
            background: var(--danger-900, #450a0a);
            color: var(--danger-400, #f87171);
            padding: 0.75rem 1rem;
            border-radius: 4px;
            margin-bottom: 1rem;
        }

        .admin-section {
            background: var(--surface-100, #1a1a1a);
            border-radius: 8px;
            padding: 1.5rem;
            margin-bottom: 1.5rem;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }

        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1rem;
        }

        .section-header h2 {
            margin: 0;
            font-size: 1.25rem;
        }

        .users-table {
            width: 100%;
            border-collapse: collapse;
        }

        .users-table th,
        .users-table td {
            padding: 0.75rem;
            text-align: left;
            border-bottom: 1px solid var(--surface-300, #404040);
        }

        .users-table th {
            font-weight: 600;
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
        }

        .role-badge {
            display: inline-block;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
        }

        .role-badge.admin {
            background: var(--success-900, #14532d);
            color: var(--success-400, #4ade80);
        }

        .role-badge.user {
            background: var(--primary-900, #1e3a5f);
            color: var(--primary-400, #60a5fa);
        }

        .actions {
            display: flex;
            gap: 0.5rem;
        }

        .btn-primary {
            background: var(--primary-color, #007bff);
            color: white;
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.875rem;
        }

        .btn-primary:hover:not(:disabled) {
            background: var(--primary-hover, #0056b3);
        }

        .btn-primary:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }

        .btn-secondary {
            background: var(--surface-400, #505050);
            color: var(--text-primary, #e0e0e0);
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.875rem;
        }

        .btn-secondary:hover {
            background: var(--surface-500, #606060);
        }

        .btn-small {
            padding: 0.25rem 0.5rem;
            font-size: 0.75rem;
            background: var(--surface-300, #404040);
            border: 1px solid var(--border-color, #555);
            border-radius: 4px;
            cursor: pointer;
            color: var(--text-primary, #e0e0e0);
        }

        .btn-small:hover {
            background: var(--surface-400, #505050);
        }

        .btn-danger {
            background: var(--danger-900, #450a0a);
            color: var(--danger-400, #f87171);
            border: 1px solid var(--danger-700, #7f1d1d);
            padding: 0.5rem 1rem;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.875rem;
        }

        .btn-danger:hover {
            background: var(--danger-800, #5c1515);
            border-color: var(--danger-400, #f87171);
        }

        .btn-small.btn-danger {
            padding: 0.25rem 0.5rem;
            font-size: 0.75rem;
        }

        .loading, .empty-state {
            text-align: center;
            padding: 2rem;
            color: var(--text-secondary, #666);
        }

        /* Scan Status */
        .scan-status {
            margin-top: 1rem;
        }

        .status-row {
            display: flex;
            gap: 0.5rem;
            margin-bottom: 0.5rem;
        }

        .status-row .label {
            color: var(--text-secondary, #666);
            min-width: 100px;
        }

        .status-row .value {
            font-weight: 500;
        }

        .status-row .value.running {
            color: var(--primary-color, #007bff);
        }

        .status-row .value.completed {
            color: var(--success-color, #2e7d32);
        }

        .progress-bar {
            height: 8px;
            background: var(--progress-bg, #e0e0e0);
            border-radius: 4px;
            overflow: hidden;
            margin-top: 0.5rem;
        }

        .progress-fill {
            height: 100%;
            background: var(--primary-color, #007bff);
            transition: width 0.3s ease;
        }

        /* Dialog */
        .dialog-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }

        .dialog {
            background: var(--surface-100, #1e1e1e);
            border-radius: 8px;
            padding: 1.5rem;
            width: 100%;
            max-width: 400px;
            margin: 1rem;
        }

        .dialog h3 {
            margin: 0 0 1rem 0;
            color: var(--text-primary, #e0e0e0);
        }

        .form-error {
            background: var(--danger-900, #450a0a);
            color: var(--danger-400, #f87171);
            padding: 0.5rem;
            border-radius: 4px;
            margin-bottom: 1rem;
            font-size: 0.875rem;
        }

        .form-group {
            margin-bottom: 1rem;
        }

        .form-group label {
            display: block;
            margin-bottom: 0.25rem;
            font-weight: 500;
            color: var(--text-secondary, #a0a0a0);
        }

        .form-group .hint {
            font-weight: normal;
            color: var(--text-tertiary, #707070);
            font-size: 0.75rem;
        }

        .form-group input,
        .form-group select {
            width: 100%;
            padding: 0.5rem;
            border: 1px solid var(--surface-400, #505050);
            border-radius: 4px;
            font-size: 1rem;
            box-sizing: border-box;
            background: var(--surface-200, #2d2d2d);
            color: var(--text-primary, #e0e0e0);
        }

        .form-group input:focus,
        .form-group select:focus {
            outline: none;
            border-color: var(--primary-500, #2196f3);
        }

        .form-actions {
            display: flex;
            justify-content: flex-end;
            gap: 0.5rem;
            margin-top: 1.5rem;
        }

        /* Section description */
        .section-desc {
            color: var(--text-secondary, #a0a0a0);
            margin: 0 0 1rem 0;
            font-size: 0.875rem;
        }

        /* Relocate form */
        .relocate-form {
            margin-top: 1rem;
        }

        .form-row {
            display: flex;
            gap: 1rem;
            margin-bottom: 1rem;
        }

        .form-row .form-group {
            flex: 1;
            margin-bottom: 0;
        }

        .form-row input {
            width: 100%;
            padding: 0.5rem;
            border: 1px solid var(--surface-400, #505050);
            border-radius: 4px;
            font-size: 0.875rem;
            box-sizing: border-box;
            background: var(--surface-200, #2d2d2d);
            color: var(--text-primary, #e0e0e0);
        }

        .form-row input:focus {
            outline: none;
            border-color: var(--primary-500, #2196f3);
        }

        .form-row label {
            display: block;
            margin-bottom: 0.25rem;
            font-weight: 500;
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
        }

        .button-row {
            display: flex;
            gap: 0.75rem;
            margin-bottom: 1rem;
        }

        .preview-result {
            background: var(--surface-200, #2d2d2d);
            border-radius: 4px;
            padding: 0.75rem 1rem;
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
        }

        /* Missing files results */
        .missing-results {
            margin-top: 1rem;
        }

        .success-msg {
            color: var(--success-400, #4ade80);
            font-size: 0.875rem;
        }

        .warning-msg {
            color: var(--warning-400, #fbbf24);
            font-size: 0.875rem;
            margin-bottom: 0.5rem;
        }

        .missing-list {
            list-style: none;
            margin: 0;
            padding: 0;
            max-height: 300px;
            overflow-y: auto;
        }

        .missing-list li {
            padding: 0.5rem 0;
            border-bottom: 1px solid var(--surface-300, #404040);
            font-size: 0.875rem;
        }

        .missing-list li:last-child {
            border-bottom: none;
        }

        .missing-list .file-path {
            display: block;
            color: var(--text-tertiary, #707070);
            font-size: 0.75rem;
            font-family: monospace;
            word-break: break-all;
            margin-top: 0.25rem;
        }

        .missing-list .more-items {
            color: var(--text-secondary, #a0a0a0);
            font-style: italic;
        }

        /* AI Section */
        .ai-section .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .ai-status-badge {
            padding: 0.25rem 0.75rem;
            border-radius: 12px;
            font-size: 0.75rem;
            font-weight: 600;
        }

        .ai-status-badge.online {
            background: var(--success-900, #14532d);
            color: var(--success-400, #4ade80);
        }

        .ai-status-badge.offline {
            background: var(--danger-900, #450a0a);
            color: var(--danger-400, #f87171);
        }

        .ai-stats {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 1rem;
            margin-bottom: 1.5rem;
        }

        .stat-card {
            background: var(--surface-200, #2d2d2d);
            border-radius: 8px;
            padding: 1rem;
            text-align: center;
        }

        .stat-value {
            font-size: 1.5rem;
            font-weight: 700;
            color: var(--primary-400, #60a5fa);
        }

        .stat-label {
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
            margin-top: 0.25rem;
        }

        .ai-job-status {
            background: var(--surface-200, #2d2d2d);
            border-radius: 8px;
            padding: 1rem;
            margin-bottom: 1rem;
        }

        .ai-actions {
            margin-top: 1rem;
        }

        .progress-fill.ai-progress {
            background: linear-gradient(90deg, var(--primary-600, #2563eb), var(--primary-400, #60a5fa));
        }

        /* Responsive */
        @media (max-width: 600px) {
            .form-row {
                flex-direction: column;
            }

            .ai-stats {
                grid-template-columns: repeat(2, 1fr);
            }
        }
    `
});
