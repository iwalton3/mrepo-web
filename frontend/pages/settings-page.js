/**
 * Settings Page
 *
 * User preferences:
 * - Default volume
 * - Dark mode
 * - Radio EOPP mode
 */

import { defineComponent, html, when } from '../lib/framework.js';
import { preferences, auth } from '../offline/offline-api.js';
import player from '../stores/player-store.js';
import offlineStore, { forceReloadWithUpdate, requestCacheStatus } from '../offline/offline-store.js';
import '../componentlib/button/button.js';
import '../components/offline-settings.js';

// Low latency mode localStorage key
const LOW_LATENCY_MODE_KEY = 'music-low-latency-always';

// Detect if we're on a mobile device
function isMobileDevice() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
           (navigator.maxTouchPoints > 0 && window.innerWidth < 768);
}

// Detect if we're on Android specifically
function isAndroid() {
    return /Android/i.test(navigator.userAgent);
}

// Get the default low latency setting (true on desktop, false on mobile)
function getDefaultLowLatency() {
    return !isMobileDevice();
}

export default defineComponent('settings-page', {
    stores: { offline: offlineStore },

    data() {
        // Load low latency setting from localStorage or use default
        let lowLatencyAlways;
        try {
            const stored = localStorage.getItem(LOW_LATENCY_MODE_KEY);
            lowLatencyAlways = stored !== null ? stored === 'true' : getDefaultLowLatency();
        } catch (e) {
            lowLatencyAlways = getDefaultLowLatency();
        }

        return {
            isAuthenticated: false,
            user: null,
            prefs: {
                shuffle: false,
                repeatMode: 'none',
                radioEopp: true,
                replayGainMode: 'off',
                replayGainPreamp: 0,
                replayGainFallback: -6
            },
            // EQ enabled state (for display only)
            eqEnabled: player.state.eqEnabled,
            // Low latency mode (device-specific)
            lowLatencyAlways: lowLatencyAlways,

            // Audio FX settings
            gaplessEnabled: player.state.gaplessEnabled,
            crossfadeEnabled: player.state.crossfadeEnabled,
            crossfadeDuration: player.state.crossfadeDuration,
            tempoEnabled: player.state.tempoEnabled,
            tempoRate: player.state.tempoRate,
            tempoPitchLock: player.state.tempoPitchLock,
            sleepTimerMode: player.state.sleepTimerMode,
            sleepTimerMinutes: player.state.sleepTimerMinutes,
            sleepTimerTargetTime: player.state.sleepTimerTargetTime,
            sleepTimerMinimumMinutes: player.state.sleepTimerMinimumMinutes,
            sleepTimerActive: player.state.sleepTimerEndTime !== null,

            // Platform detection
            isAndroid: isAndroid(),

            isLoading: false,
            saveStatus: ''
        };
    },

    async mounted() {
        // Check for app updates
        requestCacheStatus();

        // Check auth
        try {
            const result = await auth.checkUser();
            this.state.isAuthenticated = result.authenticated;
            this.state.user = result.user;
        } catch (e) {
            console.error('Auth check failed:', e);
        }

        // Load preferences
        await this.loadPreferences();
    },

    methods: {
        async loadPreferences() {
            if (!this.state.isAuthenticated) return;

            this.state.isLoading = true;
            try {
                const result = await preferences.get();
                if (!result.error) {
                    this.state.prefs = {
                        shuffle: result.shuffle || false,
                        repeatMode: result.repeat_mode || 'none',
                        radioEopp: result.radio_eopp !== false,
                        replayGainMode: result.replay_gain_mode || 'off',
                        replayGainPreamp: result.replay_gain_preamp ?? 0,
                        replayGainFallback: result.replay_gain_fallback ?? -6
                    };
                }
            } catch (e) {
                console.error('Failed to load preferences:', e);
            } finally {
                this.state.isLoading = false;
            }
        },

        async savePreferences() {
            if (!this.state.isAuthenticated) return;

            this.state.isLoading = true;
            this.state.saveStatus = '';

            try {
                await preferences.set({
                    shuffle: this.state.prefs.shuffle,
                    repeatMode: this.state.prefs.repeatMode,
                    radioEopp: this.state.prefs.radioEopp,
                    replayGainMode: this.state.prefs.replayGainMode,
                    replayGainPreamp: this.state.prefs.replayGainPreamp,
                    replayGainFallback: this.state.prefs.replayGainFallback
                });
                this.state.saveStatus = 'Saved!';
                setTimeout(() => this.state.saveStatus = '', 2000);
            } catch (e) {
                console.error('Failed to save preferences:', e);
                this.state.saveStatus = 'Failed to save';
            } finally {
                this.state.isLoading = false;
            }
        },

        handleShuffleChange(e) {
            this.state.prefs.shuffle = e.target.checked;
        },

        handleRepeatChange(e) {
            this.state.prefs.repeatMode = e.target.value;
        },

        handleEoppChange(e) {
            this.state.prefs.radioEopp = e.target.checked;
        },

        handleReplayGainModeChange(e) {
            this.state.prefs.replayGainMode = e.target.value;
            // Apply immediately for real-time feedback
            player.setReplayGainMode(e.target.value);
        },

        handleReplayGainPreampChange(e) {
            const value = parseFloat(e.target.value);
            this.state.prefs.replayGainPreamp = value;
            // Apply immediately for real-time feedback
            player.setReplayGainPreamp(value);
        },

        handleReplayGainFallbackChange(e) {
            const value = parseFloat(e.target.value);
            this.state.prefs.replayGainFallback = value;
            // Apply immediately for real-time feedback
            player.setReplayGainFallback(value);
        },

        handleLowLatencyChange(e) {
            const enabled = e.target.checked;
            this.state.lowLatencyAlways = enabled;

            // Save to localStorage
            try {
                localStorage.setItem(LOW_LATENCY_MODE_KEY, enabled);
            } catch (err) {}

            // Apply immediately - switch latency mode
            player.setLowLatencyAlways(enabled);
        },

        // Gapless/Crossfade handlers
        handleGaplessChange(e) {
            this.state.gaplessEnabled = e.target.checked;
            // If enabling gapless, disable crossfade
            if (e.target.checked) {
                this.state.crossfadeEnabled = false;
                player.setCrossfadeEnabled(false);
            }
            player.setGaplessEnabled(e.target.checked);
        },

        handleCrossfadeChange(e) {
            this.state.crossfadeEnabled = e.target.checked;
            // If enabling crossfade, disable gapless
            if (e.target.checked) {
                this.state.gaplessEnabled = false;
            }
            player.setCrossfadeEnabled(e.target.checked);
        },

        handleCrossfadeDurationChange(e) {
            const value = parseInt(e.target.value, 10);
            this.state.crossfadeDuration = value;
            player.setCrossfadeDuration(value);
        },

        // Tempo handlers
        handleTempoToggle(e) {
            this.state.tempoEnabled = e.target.checked;
            player.setTempoEnabled(e.target.checked);
        },

        handleTempoRateChange(e) {
            const value = parseFloat(e.target.value);
            this.state.tempoRate = value;
            player.setTempoRate(value);
        },

        handlePitchLockChange(e) {
            this.state.tempoPitchLock = e.target.checked;
            player.setTempoPitchLock(e.target.checked);
        },

        formatTempo(rate) {
            return rate.toFixed(2) + 'x';
        },

        // Sleep timer handlers
        handleSleepTimerModeChange(e) {
            const mode = e.target.value;
            this.state.sleepTimerMode = mode;
            player.setSleepTimerMode(mode);
        },

        handleSleepTimerChange(e) {
            const value = parseInt(e.target.value, 10);
            this.state.sleepTimerMinutes = value;
            player.setSleepTimerMinutes(value);
        },

        handleSleepTimerTimeChange(e) {
            const time = e.target.value;
            this.state.sleepTimerTargetTime = time;
            player.setSleepTimerTargetTime(time);
        },

        handleSleepTimerMinimumChange(e) {
            const value = parseInt(e.target.value, 10);
            this.state.sleepTimerMinimumMinutes = value;
            player.setSleepTimerMinimumMinutes(value);
        },

        startSleepTimer() {
            player.startSleepTimer();
            this.state.sleepTimerActive = true;
        },

        cancelSleepTimer() {
            player.cancelSleepTimer();
            this.state.sleepTimerActive = false;
        },

        formatSleepTime(minutes) {
            if (minutes === 0) return 'Off';
            if (minutes < 60) return `${minutes} min`;
            const hours = Math.floor(minutes / 60);
            const mins = minutes % 60;
            return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
        },

        navigateToEQ() {
            window.location.hash = '/eq/';
        },

        handleForceReload() {
            forceReloadWithUpdate();
        }
    },

    template() {
        const {
            isAuthenticated, user, prefs, isLoading, saveStatus, eqEnabled,
            gaplessEnabled, crossfadeEnabled, crossfadeDuration,
            tempoEnabled, tempoRate, tempoPitchLock,
            sleepTimerMode, sleepTimerMinutes, sleepTimerTargetTime,
            sleepTimerMinimumMinutes, sleepTimerActive, isAndroid
        } = this.state;

        const { updateAvailable, pendingVersion, cacheVersion } = this.stores.offline;

        return html`
            <div class="settings-page">
                <h1>Settings</h1>

                <!-- Update Available Banner -->
                ${when(updateAvailable, html`
                    <div class="update-available">
                        <div class="update-info">
                            <span class="update-icon">⬆</span>
                            <span class="update-text">
                                Update available: v${cacheVersion || '?'} → v${pendingVersion}
                            </span>
                        </div>
                        <button class="update-btn" on-click="handleForceReload">
                            Reload to Update
                        </button>
                    </div>
                `)}

                ${when(!isAuthenticated, html`
                    <div class="auth-prompt">
                        <p>Please <router-link to="/login/">log in</router-link> to save your preferences</p>
                    </div>
                `, html`
                    <div class="user-info">
                        <span>Logged in as: <strong>${user}</strong></span>
                    </div>

                    <div class="settings-section">
                        <h2>Playback</h2>

                        <div class="setting-row">
                            <label>Default Shuffle</label>
                            <div class="setting-control">
                                <label class="toggle">
                                    <input type="checkbox" checked="${prefs.shuffle}"
                                           on-change="handleShuffleChange">
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                        </div>

                        <div class="setting-row">
                            <label>Default Repeat Mode</label>
                            <div class="setting-control">
                                <select value="${prefs.repeatMode}" on-change="handleRepeatChange">
                                    <option value="none">Off</option>
                                    <option value="all">Repeat All</option>
                                    <option value="one">Repeat One</option>
                                </select>
                            </div>
                        </div>

                        <div class="setting-row">
                            <label>Low Latency Everywhere</label>
                            <div class="setting-control">
                                <label class="toggle">
                                    <input type="checkbox" checked="${this.state.lowLatencyAlways}"
                                           on-change="handleLowLatencyChange">
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                            <p class="setting-help">
                                Use low latency mode for normal playback instead of just for visualizer.
                                Turn this off if you hear crackling or audio glitches during playback.
                            </p>
                        </div>
                    </div>

                    <div class="settings-section">
                        <h2>Tempo Adjustment</h2>
                        <p class="section-help">
                            Change playback speed while optionally preserving pitch.
                        </p>

                        <div class="setting-row">
                            <label>Enable Tempo Control</label>
                            <div class="setting-control">
                                <label class="toggle">
                                    <input type="checkbox" checked="${tempoEnabled}"
                                           on-change="handleTempoToggle">
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                        </div>

                        ${when(tempoEnabled, html`
                            <div class="setting-row">
                                <label>Speed</label>
                                <div class="setting-control">
                                    <input type="range" min="0.5" max="2.0" step="0.05"
                                           value="${tempoRate}"
                                           on-input="handleTempoRateChange">
                                    <span class="db-value">${this.formatTempo(tempoRate)}</span>
                                </div>
                            </div>

                            <div class="setting-row">
                                <label>Preserve Pitch</label>
                                <div class="setting-control">
                                    <label class="toggle">
                                        <input type="checkbox" checked="${tempoPitchLock}"
                                               on-change="handlePitchLockChange">
                                        <span class="toggle-slider"></span>
                                    </label>
                                </div>
                                <p class="setting-help">
                                    When enabled, the browser attempts to maintain pitch. Quality varies by browser.
                                    When disabled, pitch changes proportionally with speed (like vinyl).
                                </p>
                            </div>
                        `)}
                    </div>

                    ${when(isAndroid, html`
                        <div class="settings-section">
                            <h2>Sleep Timer</h2>
                            <p class="section-help">
                                Automatically pause when in background. Set a target bedtime and the
                                timer activates when you lock your phone. Great for falling asleep to music.
                            </p>

                            <div class="setting-row">
                                <label>Timer Mode</label>
                                <div class="setting-control">
                                    <select value="${sleepTimerMode}" on-change="handleSleepTimerModeChange">
                                        <option value="time">At specific time</option>
                                        <option value="duration">After duration</option>
                                    </select>
                                </div>
                            </div>

                            ${when(sleepTimerMode === 'time', html`
                                <div class="setting-row">
                                    <label>Stop At</label>
                                    <div class="setting-control">
                                        <input type="time" value="${sleepTimerTargetTime}"
                                               on-change="handleSleepTimerTimeChange">
                                    </div>
                                </div>

                                <div class="setting-row">
                                    <label>Minimum Playback</label>
                                    <div class="setting-control">
                                        <select value="${sleepTimerMinimumMinutes}" on-change="handleSleepTimerMinimumChange">
                                            <option value="0">None</option>
                                            <option value="15">15 minutes</option>
                                            <option value="30">30 minutes</option>
                                            <option value="45">45 minutes</option>
                                            <option value="60">1 hour</option>
                                            <option value="90">1.5 hours</option>
                                            <option value="120">2 hours</option>
                                            <option value="180">3 hours</option>
                                        </select>
                                    </div>
                                    <p class="setting-help">
                                        Guarantees at least this much playback if you start after the target time.
                                    </p>
                                </div>
                            `)}

                            ${when(sleepTimerMode === 'duration', html`
                                <div class="setting-row">
                                    <label>Duration</label>
                                    <div class="setting-control">
                                        <select value="${sleepTimerMinutes}" on-change="handleSleepTimerChange">
                                            <option value="0">Off</option>
                                            <option value="15">15 minutes</option>
                                            <option value="30">30 minutes</option>
                                            <option value="45">45 minutes</option>
                                            <option value="60">1 hour</option>
                                            <option value="90">1.5 hours</option>
                                            <option value="120">2 hours</option>
                                        </select>
                                    </div>
                                </div>

                                ${when(sleepTimerMinutes > 0, html`
                                    <div class="timer-actions">
                                        ${when(!sleepTimerActive,
                                            html`<cl-button severity="primary" on-click="startSleepTimer">Start Timer</cl-button>`,
                                            html`<cl-button severity="danger" on-click="cancelSleepTimer">Cancel Timer</cl-button>`
                                        )}
                                    </div>
                                `)}
                            `)}
                        </div>
                    `)}

                    <div class="settings-section">
                        <h2>Replay Gain</h2>
                        <p class="section-help">
                            Normalize volume levels across tracks. Works with native playback (MP3, FLAC).
                            Transcoded streams (tracker formats) have gain applied server-side.
                        </p>

                        <div class="setting-row">
                            <label>Mode</label>
                            <div class="setting-control">
                                <select value="${prefs.replayGainMode}" on-change="handleReplayGainModeChange">
                                    <option value="off">Off</option>
                                    <option value="track">Track</option>
                                    <option value="album">Album</option>
                                </select>
                            </div>
                            <p class="setting-help">
                                Track mode normalizes each song individually. Album mode preserves
                                dynamic range within albums (use for classical/live albums).
                            </p>
                        </div>

                        <div class="setting-row">
                            <label>Pre-amp</label>
                            <div class="setting-control">
                                <input type="range" min="-12" max="12" step="1"
                                       value="${prefs.replayGainPreamp}"
                                       on-input="handleReplayGainPreampChange">
                                <span class="db-value">${prefs.replayGainPreamp > 0 ? '+' : ''}${prefs.replayGainPreamp} dB</span>
                            </div>
                            <p class="setting-help">
                                Adjust overall output level after replay gain is applied.
                            </p>
                        </div>

                        <div class="setting-row">
                            <label>Fallback Gain</label>
                            <div class="setting-control">
                                <input type="range" min="-24" max="0" step="1"
                                       value="${prefs.replayGainFallback}"
                                       on-input="handleReplayGainFallbackChange">
                                <span class="db-value">${prefs.replayGainFallback} dB</span>
                            </div>
                            <p class="setting-help">
                                Applied to tracks without replay gain tags. -6 dB is a safe default.
                            </p>
                        </div>
                    </div>

                    <div class="settings-section">
                        <h2>Equalizer</h2>
                        <p class="section-help">
                            Audio equalizer with 10-band graphic mode or full parametric mode.
                        </p>

                        <div class="eq-link-row">
                            <div class="eq-status">
                                <span class="eq-indicator ${eqEnabled ? 'active' : ''}"></span>
                                <span>EQ is ${eqEnabled ? 'enabled' : 'disabled'}</span>
                            </div>
                            <cl-button severity="secondary" on-click="navigateToEQ">
                                Open Equalizer
                            </cl-button>
                        </div>
                    </div>

                    <div class="settings-section">
                        <h2>Radio</h2>

                        <div class="setting-row">
                            <label>EOPP Mode</label>
                            <div class="setting-control">
                                <label class="toggle">
                                    <input type="checkbox" checked="${prefs.radioEopp}"
                                           on-change="handleEoppChange">
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                            <p class="setting-help">
                                Equal Opportunity Per Person mode diversifies artist selection
                                in radio mode by occasionally picking a random artist first.
                            </p>
                        </div>
                    </div>

                    <div class="settings-section">
                        <h2>Gapless Playback</h2>
                        <p class="section-help">
                            Seamless transitions between tracks without silence gaps.
                        </p>

                        <div class="setting-row">
                            <label>Gapless Playback</label>
                            <div class="setting-control">
                                <label class="toggle">
                                    <input type="checkbox" checked="${gaplessEnabled}"
                                           on-change="handleGaplessChange">
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                            <p class="setting-help">
                                Preload next track for seamless transitions. Best for live albums and DJ mixes.
                            </p>
                        </div>

                        <div class="setting-row">
                            <label>Crossfade</label>
                            <div class="setting-control">
                                <label class="toggle">
                                    <input type="checkbox" checked="${crossfadeEnabled}"
                                           on-change="handleCrossfadeChange">
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                            <p class="setting-help">
                                Smoothly fade between tracks. Overrides gapless when enabled.
                            </p>
                        </div>

                        ${when(crossfadeEnabled, html`
                            <div class="setting-row">
                                <label>Crossfade Duration</label>
                                <div class="setting-control">
                                    <input type="range" min="1" max="12" step="1"
                                           value="${crossfadeDuration}"
                                           on-input="handleCrossfadeDurationChange">
                                    <span class="db-value">${crossfadeDuration}s</span>
                                </div>
                            </div>
                        `)}
                    </div>

                `)}

                <div class="settings-section">
                    <h2>Offline</h2>
                    <p class="section-help">
                        Save playlists for offline playback and manage cached data.
                    </p>
                    <offline-settings></offline-settings>
                </div>

                <div class="settings-section info-section">
                    <h2>About</h2>
                    <p>Music Player v1.0</p>
                    <p>Built with VDX-Web framework</p>
                    <p>Using Song Continuity Algorithm (SCA) for intelligent radio</p>
                </div>

                ${when(isAuthenticated, html`
                    <div class="save-section">
                        <cl-button severity="primary" on-click="savePreferences" loading="${isLoading}">
                            Save Preferences
                        </cl-button>
                        ${when(saveStatus, html`
                            <span class="save-status">${saveStatus}</span>
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

        .settings-page {
            padding: 1rem;
            max-width: 800px;
            margin: 0 auto;
        }

        h1 {
            margin: 0 0 1.5rem;
            color: var(--text-primary, #e0e0e0);
        }

        /* Update Available Banner */
        .update-available {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1rem;
            padding: 0.75rem 1rem;
            margin-bottom: 1.5rem;
            background: var(--success-100, #1b4332);
            border: 1px solid var(--success-500, #22c55e);
            border-radius: 8px;
            flex-wrap: wrap;
        }

        .update-info {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .update-icon {
            font-size: 1.25rem;
        }

        .update-text {
            font-size: 0.875rem;
            color: var(--success-500, #22c55e);
            font-weight: 500;
        }

        .update-btn {
            padding: 0.5rem 1rem;
            border: none;
            border-radius: 4px;
            background: var(--success-500, #22c55e);
            color: white;
            cursor: pointer;
            font-size: 0.8125rem;
            font-weight: 500;
            white-space: nowrap;
        }

        .update-btn:hover {
            background: var(--success-600, #16a34a);
        }

        /* Auth Prompt */
        .auth-prompt {
            text-align: center;
            padding: 2rem;
            background: var(--surface-100, #242424);
            border-radius: 8px;
            margin-bottom: 1.5rem;
            color: var(--text-secondary, #a0a0a0);
        }

        .auth-prompt a {
            color: var(--primary-400, #42a5f5);
        }

        /* User Info */
        .user-info {
            padding: 0.75rem 1rem;
            background: var(--surface-100, #242424);
            border-radius: 8px;
            margin-bottom: 1.5rem;
            font-size: 0.875rem;
            color: var(--text-primary, #e0e0e0);
        }

        /* Settings Section */
        .settings-section {
            margin-bottom: 2rem;
        }

        .settings-section h2 {
            font-size: 1rem;
            color: var(--text-secondary, #a0a0a0);
            margin: 0 0 1rem;
            padding-bottom: 0.5rem;
            border-bottom: 1px solid var(--surface-200, #2d2d2d);
        }

        /* Setting Row */
        .setting-row {
            margin-bottom: 1.25rem;
        }

        .setting-row > label {
            display: block;
            font-weight: 500;
            margin-bottom: 0.5rem;
            color: var(--text-primary, #e0e0e0);
        }

        .setting-control {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .setting-control input[type="range"] {
            flex: 1;
            max-width: 200px;
        }

        .setting-control select {
            padding: 0.5rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-primary, #e0e0e0);
        }

        .setting-control input[type="time"] {
            padding: 0.5rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-primary, #e0e0e0);
            font-size: 1rem;
        }

        .setting-help {
            margin: 0.5rem 0 0;
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
        }

        .section-help {
            margin: 0 0 1rem;
            font-size: 0.8125rem;
            color: var(--text-secondary, #a0a0a0);
        }

        .db-value {
            min-width: 4rem;
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
            font-family: monospace;
        }

        /* Toggle Switch */
        .toggle {
            position: relative;
            display: inline-block;
            width: 48px;
            height: 24px;
            cursor: pointer;
        }

        .toggle input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .toggle-slider {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: var(--surface-300, #404040);
            border-radius: 24px;
            transition: background 0.2s;
        }

        .toggle-slider::before {
            content: '';
            position: absolute;
            width: 18px;
            height: 18px;
            left: 3px;
            bottom: 3px;
            background: var(--text-primary, #e0e0e0);
            border-radius: 50%;
            transition: transform 0.2s;
        }

        .toggle input:checked + .toggle-slider {
            background: var(--primary-500, #2196f3);
        }

        .toggle input:checked + .toggle-slider::before {
            transform: translateX(24px);
        }

        /* Save Section */
        .save-section {
            display: flex;
            align-items: center;
            gap: 1rem;
            padding-top: 1rem;
            border-top: 1px solid var(--surface-200, #2d2d2d);
        }

        .save-status {
            font-size: 0.875rem;
            color: var(--success-500, #22c55e);
        }

        /* Info Section */
        .info-section {
            margin-top: 3rem;
        }

        .info-section p {
            margin: 0.25rem 0;
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
        }

        /* EQ Link Row */
        .eq-link-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 1rem;
            background: var(--surface-100, #242424);
            border-radius: 8px;
            gap: 1rem;
        }

        .eq-status {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            color: var(--text-primary, #e0e0e0);
        }

        .eq-indicator {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: var(--surface-400, #505050);
        }

        .eq-indicator.active {
            background: var(--success-500, #22c55e);
        }

        /* Timer Actions */
        .timer-actions {
            margin-top: 1rem;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        .timer-actions .setting-help {
            margin: 0;
        }

        /* Mobile */
        @media (max-width: 767px) {
            .settings-page {
                padding: 0.5rem;
            }

            .eq-link-row {
                flex-direction: column;
                align-items: stretch;
                gap: 0.75rem;
            }
        }
    `
});
