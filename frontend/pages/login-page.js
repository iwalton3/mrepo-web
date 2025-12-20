/**
 * Login Page
 *
 * Handles user authentication and first-time setup.
 * - Shows setup wizard if no users exist (setupRequired)
 * - Shows login form for returning users
 */

import { defineComponent, html, when } from '../lib/framework.js';
import { auth } from '../offline/offline-api.js';
import '../componentlib/button/button.js';

export default defineComponent('login-page', {
    data() {
        const config = window.MREPO_CONFIG || {};
        return {
            setupRequired: config.setupRequired || false,
            username: '',
            password: '',
            confirmPassword: '',
            error: null,
            loading: false
        };
    },

    methods: {
        async handleSubmit(e) {
            e.preventDefault();
            this.state.error = null;
            this.state.loading = true;

            try {
                if (this.state.setupRequired) {
                    // Registration mode
                    if (this.state.password !== this.state.confirmPassword) {
                        throw new Error('Passwords do not match');
                    }
                    if (this.state.password.length < 8) {
                        throw new Error('Password must be at least 8 characters');
                    }
                    await auth.register(this.state.username, this.state.password);
                } else {
                    // Login mode
                    await auth.login(this.state.username, this.state.password);
                }

                // Success - redirect to home and reload to get fresh auth state
                window.location.hash = '/';
                window.location.reload();
            } catch (err) {
                this.state.error = err.message || 'Authentication failed';
                this.state.loading = false;
            }
        }
    },

    template() {
        const { setupRequired, username, password, confirmPassword, error, loading } = this.state;

        return html`
            <div class="login-container">
                <div class="login-card">
                    <div class="login-header">
                        <span class="login-icon">🎵</span>
                        <h1>${setupRequired ? 'Welcome to mrepo' : 'Sign In'}</h1>
                        ${when(setupRequired, html`
                            <p class="setup-subtitle">Create your admin account to get started</p>
                        `)}
                    </div>

                    ${when(error, html`
                        <div class="login-error">${error}</div>
                    `)}

                    <form on-submit-prevent="handleSubmit" class="login-form">
                        <div class="form-group">
                            <label for="username">Username</label>
                            <input
                                type="text"
                                id="username"
                                x-model="username"
                                autocomplete="username"
                                required
                                autofocus
                            />
                        </div>

                        <div class="form-group">
                            <label for="password">Password</label>
                            <input
                                type="password"
                                id="password"
                                x-model="password"
                                autocomplete="${setupRequired ? 'new-password' : 'current-password'}"
                                required
                            />
                        </div>

                        ${when(setupRequired, html`
                            <div class="form-group">
                                <label for="confirmPassword">Confirm Password</label>
                                <input
                                    type="password"
                                    id="confirmPassword"
                                    x-model="confirmPassword"
                                    autocomplete="new-password"
                                    required
                                />
                            </div>
                        `)}

                        <cl-button
                            type="submit"
                            variant="primary"
                            size="large"
                            ?disabled="${loading}"
                            style="width: 100%"
                        >
                            ${loading ? 'Please wait...' : (setupRequired ? 'Create Account' : 'Sign In')}
                        </cl-button>
                    </form>
                </div>
            </div>
        `;
    },

    styles: /*css*/`
        .login-container {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100%;
            padding: 1rem;
            background: var(--shell-bg, #0d0d0d);
        }

        .login-card {
            width: 100%;
            max-width: 400px;
            background: var(--card-bg, #1a1a1a);
            border-radius: 12px;
            padding: 2rem;
            box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
        }

        .login-header {
            text-align: center;
            margin-bottom: 2rem;
        }

        .login-icon {
            font-size: 3rem;
            display: block;
            margin-bottom: 1rem;
        }

        .login-header h1 {
            margin: 0;
            font-size: 1.5rem;
            color: var(--text-primary, #e0e0e0);
        }

        .setup-subtitle {
            margin: 0.5rem 0 0;
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.9rem;
        }

        .login-error {
            background: var(--danger-100, #450a0a);
            color: var(--danger-500, #ef4444);
            padding: 0.75rem 1rem;
            border-radius: 8px;
            margin-bottom: 1rem;
            font-size: 0.9rem;
        }

        .login-form {
            display: flex;
            flex-direction: column;
            gap: 1rem;
        }

        .form-group {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        .form-group label {
            font-size: 0.9rem;
            color: var(--text-secondary, #a0a0a0);
        }

        .form-group input {
            padding: 0.75rem 1rem;
            border: 1px solid var(--input-border, #404040);
            border-radius: 8px;
            background: var(--input-bg, #2d2d2d);
            color: var(--input-text, #e0e0e0);
            font-size: 1rem;
            transition: border-color 0.2s;
        }

        .form-group input:focus {
            outline: none;
            border-color: var(--primary-500, #2196f3);
        }

        cl-button {
            margin-top: 0.5rem;
        }
    `
});
