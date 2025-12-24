/**
 * Player Store - Audio playback state management
 *
 * Manages:
 * - Current song and playback state
 * - Server-side queue management
 * - SCA (radio) mode integration
 * - Audio element control
 * - Media Session API for Android background playback
 */

import { createStore, untracked } from '../lib/framework.js';
import { getStreamUrl, history, queue as queueApi, playback, sca, radio, preferences, songs as songsApi, playlists as playlistsApi } from '../offline/offline-api.js';
import { getAudioUrl } from '../offline/offline-audio.js';
import offlineStore from '../offline/offline-store.js';
import * as offlineDb from '../offline/offline-db.js';
import { isSyncing } from '../offline/sync-manager.js';

/**
 * Convert decibels to linear gain multiplier.
 */
function dbToLinear(db) {
    return Math.pow(10, db / 20);
}

/**
 * Calculate effective volume with replay gain applied.
 */
function calculateReplayGainVolume(baseVolume, song, mode, preamp, fallback) {
    if (mode === 'off' || !song) return baseVolume;

    // Get gain value (prefer album if mode is album)
    let gainDb = mode === 'album' && song.replay_gain_album != null
        ? song.replay_gain_album
        : song.replay_gain_track;

    // Use fallback if no gain tag
    if (gainDb == null) gainDb = fallback;

    // Apply preamp
    gainDb += preamp;

    // Clamp to prevent extreme values (-24 to +12 dB)
    gainDb = Math.max(-24, Math.min(12, gainDb));

    // Convert to linear and apply to volume
    const linearGain = dbToLinear(gainDb);
    return Math.min(1.0, baseVolume * linearGain);
}

const LOCAL_STORAGE_KEY = 'music-player-local';
const LOCAL_STORAGE_EQ_KEY = 'music-player-eq';
const LOCAL_STORAGE_AUDIO_FX_KEY = 'music-player-audio-fx';
const LOCAL_STORAGE_SHUFFLE_HISTORY_KEY = 'music-player-shuffle-history';
const LOW_LATENCY_MODE_KEY = 'music-low-latency-always';
let currentLatencyMode = '';

/**
 * Load audio effects settings from localStorage.
 * Includes: crossfeed, gapless, crossfade, tempo
 */
function loadAudioFXSettings() {
    try {
        const saved = localStorage.getItem(LOCAL_STORAGE_AUDIO_FX_KEY);
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (e) {
        console.error('Failed to load audio FX settings:', e);
    }
    return null;
}

/**
 * Save audio effects settings to localStorage.
 */
function saveAudioFXSettings(settings) {
    try {
        localStorage.setItem(LOCAL_STORAGE_AUDIO_FX_KEY, JSON.stringify(settings));
    } catch (e) {
        console.error('Failed to save audio FX settings:', e);
    }
}

/**
 * Load shuffle history from localStorage.
 */
function loadShuffleHistory() {
    try {
        const saved = localStorage.getItem(LOCAL_STORAGE_SHUFFLE_HISTORY_KEY);
        if (saved) {
            const history = JSON.parse(saved);
            if (Array.isArray(history)) {
                return history;
            }
        }
    } catch (e) {
        console.error('Failed to load shuffle history:', e);
    }
    return [];
}

/**
 * Save shuffle history to localStorage.
 */
function saveShuffleHistory(history) {
    try {
        localStorage.setItem(LOCAL_STORAGE_SHUFFLE_HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
        console.error('Failed to save shuffle history:', e);
    }
}

/**
 * Clear shuffle history from localStorage.
 */
function clearShuffleHistory() {
    try {
        localStorage.removeItem(LOCAL_STORAGE_SHUFFLE_HISTORY_KEY);
    } catch (e) {
        console.error('Failed to clear shuffle history:', e);
    }
}

/**
 * Detect if we're on a mobile device.
 */
function isMobileDevice() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
           (navigator.maxTouchPoints > 0 && window.innerWidth < 768);
}

/**
 * Get the default low latency setting (true on desktop, false on mobile).
 */
function getDefaultLowLatency() {
    return !isMobileDevice();
}

/**
 * Load low latency setting from localStorage.
 */
function loadLowLatencySetting() {
    try {
        const stored = localStorage.getItem(LOW_LATENCY_MODE_KEY);
        return stored !== null ? stored === 'true' : getDefaultLowLatency();
    } catch (e) {
        return getDefaultLowLatency();
    }
}

// Standard 10-band EQ frequencies
export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/**
 * Load local-only state from localStorage (things that don't go to server).
 */
function loadLocalState() {
    try {
        const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (e) {
        console.error('Failed to load local player state:', e);
    }
    return null;
}

/**
 * Save local-only state to localStorage.
 * Note: queueIndex is stored server-side for cross-device sync.
 * currentSongUuid is saved locally only to validate currentTime on refresh.
 * volume is device-specific (different devices have different output levels).
 */
function saveLocalState(state) {
    try {
        const toSave = {
            currentSongUuid: state.currentSong?.uuid,
            currentTime: state.currentTime,
            muted: state.muted,
            volume: state.volume
        };
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(toSave));
    } catch (e) {
        console.error('Failed to save local player state:', e);
    }
}

/**
 * Load EQ settings from localStorage.
 */
function loadEQSettings() {
    try {
        const saved = localStorage.getItem(LOCAL_STORAGE_EQ_KEY);
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (e) {
        console.error('Failed to load EQ settings:', e);
    }
    return null;
}

/**
 * Save EQ settings to localStorage.
 */
function saveEQSettings(enabled, gains) {
    try {
        localStorage.setItem(LOCAL_STORAGE_EQ_KEY, JSON.stringify({
            enabled,
            gains
        }));
    } catch (e) {
        console.error('Failed to save EQ settings:', e);
    }
}

/**
 * Load parametric EQ state from localStorage.
 */
function loadParametricEQState() {
    try {
        const mode = localStorage.getItem('music-eq-advanced');
        if (mode !== 'true') return null;

        const saved = localStorage.getItem('music-player-eq-active');
        if (saved) {
            const state = JSON.parse(saved);
            // Bands are always cached locally (both presets and custom)
            const bands = state.bands || state.customBands;
            if (bands && bands.length > 0) {
                return bands;
            }
        }
    } catch (e) {
        console.error('Failed to load parametric EQ state:', e);
    }
    return null;
}

// Load any local state
const local = loadLocalState();
const eqSettings = loadEQSettings();
const parametricBands = loadParametricEQState();
const audioFXSettings = loadAudioFXSettings();

/**
 * Create the player store with initial state.
 */
export const playerStore = createStore({
    // Current track (set from server's queueIndex)
    currentSong: null,

    // Playback state
    isPlaying: false,
    isPaused: false,
    isLoading: false,
    currentTime: 0,  // Validated against server song after load
    duration: 0,
    buffered: 0,

    // Audio settings (device-specific, loaded from localStorage)
    volume: local?.volume ?? 1.0,
    muted: local?.muted || false,

    // Replay gain settings (loaded from server preferences)
    replayGainMode: 'off',      // 'off', 'track', 'album'
    replayGainPreamp: 0,        // dB adjustment (-12 to +12)
    replayGainFallback: -6,     // Default gain for untagged tracks (dB)

    // Queue (server-side) - marked untracked for performance with large playlists
    queue: untracked([]),
    queueIndex: 0,
    queueVersion: 0,  // Tracked counter to force re-renders when queue changes

    // Mode
    shuffle: false,
    repeatMode: 'none',  // 'none', 'all', 'one' - maps to server's play_mode
    scaEnabled: false,   // Server-side SCA radio mode
    tempQueueMode: false,  // Temp queue mode - local-only queue that doesn't sync

    // Error state
    error: null,

    // Server sync state
    serverLoaded: false,

    // EQ settings (device-specific, loaded from localStorage)
    eqEnabled: eqSettings?.enabled || false,
    eqGains: eqSettings?.gains || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],

    // Audio FX settings (device-specific, loaded from localStorage)
    // Crossfeed - mixes left/right channels to simulate speakers on headphones
    // Negative values widen stereo by subtracting opposite channel
    crossfeedEnabled: audioFXSettings?.crossfeedEnabled || false,
    crossfeedLevel: audioFXSettings?.crossfeedLevel ?? 0,  // -100 to +100, default 0 (off)
    crossfeedDelayMs: audioFXSettings?.crossfeedDelayMs ?? 0,  // 0-5ms delay on cross-channels
    crossfeedShadowHz: audioFXSettings?.crossfeedShadowHz ?? 0,  // 0=off, 500-3000Hz head shadow filter

    // Gapless playback
    gaplessEnabled: audioFXSettings?.gaplessEnabled ?? true,  // Default enabled

    // Crossfade between tracks
    crossfadeEnabled: audioFXSettings?.crossfadeEnabled || false,
    crossfadeDuration: audioFXSettings?.crossfadeDuration ?? 3,  // Seconds, default 3

    // Tempo adjustment
    tempoEnabled: audioFXSettings?.tempoEnabled || false,
    tempoRate: audioFXSettings?.tempoRate ?? 1.0,  // 0.5 to 2.0, default 1.0
    tempoPitchLock: audioFXSettings?.tempoPitchLock ?? true,  // Pitch compensation (requires SoundTouch)

    // Loudness compensation (psychoacoustic volume)
    // Boosts bass/treble at lower volumes to counteract Fletcher-Munson effect
    loudnessEnabled: audioFXSettings?.loudnessEnabled || false,
    loudnessReferenceSPL: audioFXSettings?.loudnessReferenceSPL ?? 80,  // 60-90 dB, what SPL does 100% volume produce?
    loudnessStrength: audioFXSettings?.loudnessStrength ?? 100,  // 0-150%, intensity multiplier

    // Sleep timer (Android background playback)
    sleepTimerMode: audioFXSettings?.sleepTimerMode ?? 'time',  // 'duration' or 'time'
    sleepTimerMinutes: audioFXSettings?.sleepTimerMinutes ?? 0,  // 0 = disabled (for duration mode)
    sleepTimerTargetTime: audioFXSettings?.sleepTimerTargetTime ?? '23:00',  // HH:MM (for time mode)
    sleepTimerMinimumMinutes: audioFXSettings?.sleepTimerMinimumMinutes ?? 0,  // Minimum playback after target time (0 = indefinite if past target)
    sleepTimerEndTime: null,  // Runtime: Date.now() + minutes when timer started

    // Comfort noise (fills silence with background noise)
    noiseEnabled: audioFXSettings?.noiseEnabled || false,
    noiseMode: audioFXSettings?.noiseMode ?? 'white',    // 'white' or 'grey'
    noiseTilt: audioFXSettings?.noiseTilt ?? 0,          // -100 (dark/bass) to +100 (bright/treble)
    noisePower: audioFXSettings?.noisePower ?? -24,      // -60 to 0 dB
    noiseThreshold: audioFXSettings?.noiseThreshold ?? -36,  // -60 to 0 dB (0 = always on)
    noiseAttack: audioFXSettings?.noiseAttack ?? 25      // 25 (instant) to 2000 ms, log scale
});

/**
 * Audio Controller Class
 *
 * Wraps HTML5 Audio element with Media Session API support.
 */
class AudioController {
    constructor(store) {
        this.store = store;

        // Dual-audio system for crossfade
        // Mode A (crossfade disabled): Only _audioElements[0] connected to pipeline, no mixer overhead
        // Mode B (crossfade enabled): Both elements with mixer for seamless crossfade
        // Note: Both audio elements always exist for gapless preloading
        this._audioElements = [new Audio(), new Audio()];  // Both always exist
        this._audioSources = [null, null];          // MediaElementSourceNodes (only used in dual mode)
        this._replayGainNodes = [null, null];       // GainNodes for per-source ReplayGain (dual mode only)
        this._fadeGains = [null, null];             // GainNodes for crossfade volume
        this._mixerGain = null;                     // Combines both sources (null when crossfade disabled)
        this._primaryIndex = 0;                     // Which element is "primary" (0 or 1)
        this._dualPipelineActive = false;           // true when crossfade enabled and dual pipeline built

        // Legacy aliases for compatibility
        this.audio = this._audioElements[0];
        this.preloadAudio = this._audioElements[1]; // Always available for gapless preloading

        this.preloadedSong = null;
        this.playStartTime = null;
        this._saveInterval = null;
        this._audioSourceVersion = 0;  // Incremented when primary audio source changes
        this._audioSourceCallbacks = [];  // Callbacks notified when source changes
        this._serverSyncPending = false;
        this._eqFilters = null;  // Web Audio API BiquadFilterNodes for EQ
        this._isExitingTempQueue = false;  // Guard against race conditions when exiting temp queue
        this._tempQueueExitTime = 0;  // Timestamp of last temp queue exit (cooldown for refresh)

        // Shuffle history for back button - stores song UUIDs, persisted to localStorage
        this._shuffleHistory = loadShuffleHistory();
        this._shuffleHistoryMaxSize = 50;

        // Crossfade state
        this._crossfadeInProgress = false;
        this._crossfadeSkipRamp = false;
        this._crossfadeSeekLockout = false;  // Prevents repeated seeks from triggering multiple crossfades

        // Loudness compensation state
        this._loudnessInitialized = false;
        this._loudnessInternalConnected = false;  // Track internal node connections
        this._userVolumeGain = null;      // GainNode for user volume (replaces HTML5 volume when loudness enabled)
        this._loudnessLowShelf = null;    // BiquadFilterNode (lowshelf, 100Hz)
        this._loudnessHighShelf = null;   // BiquadFilterNode (highshelf, 10kHz)

        // Comfort noise state
        this._noiseInitialized = false;
        this._noiseWorklet = null;        // AudioWorkletNode for noise generation + RMS detection
        this._noiseScriptProcessor = null; // Fallback ScriptProcessorNode
        this._noiseLowFilter = null;      // BiquadFilterNode lowshelf for bass control
        this._noiseHighFilter = null;     // BiquadFilterNode highshelf for treble control
        this._noiseMerger = null;         // GainNode to merge noise with music

        // Set up event listeners on BOTH audio elements once (not per-swap)
        // Guards in handlers ensure only active element updates state
        this._setupEventListeners(this._audioElements[0]);
        this._setupEventListeners(this._audioElements[1]);
        this._setupMediaSession();
        this._setupPersistence();

        // Load state from server
        this._loadFromServer();
    }

    async _loadFromServer() {
        // Check for temp queue state from previous session
        try {
            const { tempQueue, savedQueue } = await offlineDb.getTempQueueState();
            if (tempQueue && savedQueue) {
                // Restore temp queue mode
                this.store.state.tempQueueMode = true;
                this.store.state.queue = tempQueue.items || [];
                this.store.state.queueIndex = tempQueue.queueIndex || 0;
                this.store.state.shuffle = tempQueue.shuffle || false;
                this.store.state.repeatMode = tempQueue.repeatMode || 'none';
                this.store.state.queueVersion++;

                if (this.store.state.queue.length > 0) {
                    const song = this.store.state.queue[this.store.state.queueIndex];
                    if (song) {
                        this.store.state.currentSong = { ...song };
                        if (local?.currentSongUuid === song.uuid && local?.currentTime > 0) {
                            this.store.state.currentTime = local.currentTime;
                        }
                    }
                }

                // Still load preferences (replay gain, etc.)
                try {
                    const prefsResult = await preferences.get();
                    if (prefsResult && !prefsResult.error) {
                        this.store.state.replayGainMode = prefsResult.replay_gain_mode || 'off';
                        this.store.state.replayGainPreamp = prefsResult.replay_gain_preamp ?? 0;
                        this.store.state.replayGainFallback = prefsResult.replay_gain_fallback ?? -6;
                    }
                } catch (e) {
                    console.warn('Failed to load preferences:', e);
                }

                console.log('[TempQueue] Restored temp queue from previous session');
                this._applyReplayGain();
                this.store.state.serverLoaded = true;
                this._initAudioPipelineOnStartup();
                return;
            }
        } catch (e) {
            console.warn('Failed to check temp queue state:', e);
        }

        try {
            // Load queue and preferences in parallel
            // Both have .catch() so Promise.all won't reject if one fails
            const [queueResult, prefsResult] = await Promise.all([
                queueApi.list({ limit: 10000 }).catch(e => {
                    console.error('Failed to load queue:', e);
                    return { error: e.message || 'Failed to load queue' };
                }),
                preferences.get().catch(e => {
                    console.warn('Failed to load preferences:', e);
                    return {};
                })
            ]);

            if (!queueResult.error) {
                this.store.state.queue = queueResult.items || [];
                this.store.state.queueIndex = queueResult.queueIndex || 0;
                this.store.state.scaEnabled = queueResult.scaEnabled || false;
                this.store.state.queueVersion++;  // Trigger re-render

                // Map server play_mode to local shuffle and repeatMode
                const playMode = queueResult.playMode || 'sequential';
                if (playMode === 'repeat_one') {
                    this.store.state.shuffle = false;
                    this.store.state.repeatMode = 'one';
                } else if (playMode === 'repeat_all') {
                    this.store.state.shuffle = false;
                    this.store.state.repeatMode = 'all';
                } else if (playMode === 'shuffle') {
                    this.store.state.shuffle = true;
                    this.store.state.repeatMode = 'none';
                } else {
                    this.store.state.shuffle = false;
                    this.store.state.repeatMode = 'none';
                }

                // Always use server's queueIndex for currentSong
                if (this.store.state.queue.length > 0) {
                    const serverIndex = this.store.state.queueIndex;
                    const serverSong = this.store.state.queue[serverIndex];
                    if (serverSong) {
                        this.store.state.currentSong = { ...serverSong };
                        if (local?.currentSongUuid === serverSong.uuid && local?.currentTime > 0) {
                            this.store.state.currentTime = local.currentTime;
                        }
                    }
                } else {
                    this.store.state.currentSong = null;
                }
            } else {
                console.error('Failed to load queue from server:', queueResult.error);
            }

            // Load replay gain preferences
            if (prefsResult && !prefsResult.error) {
                this.store.state.replayGainMode = prefsResult.replay_gain_mode || 'off';
                this.store.state.replayGainPreamp = prefsResult.replay_gain_preamp ?? 0;
                this.store.state.replayGainFallback = prefsResult.replay_gain_fallback ?? -6;
            }

            this._applyReplayGain();
            this.store.state.serverLoaded = true;
        } catch (e) {
            console.error('Failed to load queue from server:', e);
        }

        // Initialize audio pipeline regardless of server load success (effects are local-only)
        this._initAudioPipelineOnStartup();
    }

    /**
     * Initialize audio pipeline on startup if any effects are enabled.
     * Called after server load attempt, but runs regardless of server success.
     * Checks: EQ, crossfade, crossfeed, loudness, noise
     */
    async _initAudioPipelineOnStartup() {
        // Check if ANY effect is enabled that requires the audio pipeline
        const needsPipeline =
            this.store.state.eqEnabled ||
            this.store.state.crossfadeEnabled ||
            this.store.state.crossfeedEnabled ||
            this.store.state.loudnessEnabled ||
            this.store.state.noiseEnabled;

        if (!needsPipeline) return;

        // If EQ is not enabled but other effects are, just build the pipeline
        if (!this.store.state.eqEnabled) {
            console.log('[Startup] Initializing pipeline for non-EQ effects');
            await this._ensureAudioPipeline();
            return;
        }

        // EQ is enabled - proceed with EQ-specific initialization

        // Check if PEQ mode is active
        const isPEQMode = localStorage.getItem('music-eq-advanced') === 'true';

        if (isPEQMode) {
            let bands = parametricBands;

            // If no cached bands but have preset UUID, try to fetch from API
            if ((!bands || bands.length === 0)) {
                try {
                    const saved = localStorage.getItem('music-player-eq-active');
                    if (saved) {
                        const state = JSON.parse(saved);
                        if (state.presetUuid && (!state.bands || state.bands.length === 0)) {
                            console.log('[EQ Startup] Fetching preset bands from API...');
                            const { eqPresets } = await import('../offline/offline-api.js');
                            const result = await eqPresets.list();
                            if (!result.error && result.presets) {
                                const preset = result.presets.find(p => p.uuid === state.presetUuid);
                                if (preset && preset.bands) {
                                    bands = preset.bands;
                                    // Cache for future startups
                                    localStorage.setItem('music-player-eq-active', JSON.stringify({
                                        presetUuid: state.presetUuid,
                                        bands: preset.bands
                                    }));
                                    console.log('[EQ Startup] Cached preset bands');
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error('[EQ Startup] Failed to fetch preset:', e);
                }
            }

            if (bands && bands.length > 0) {
                console.log('[EQ Startup] Applying PEQ with', bands.length, 'bands');
                await this.setParametricEQ(bands, this._calculatePEQPreamp(bands));
                return;
            }
        }

        // Fall back to GEQ - use unified pipeline builder
        console.log('[EQ Startup] Applying GEQ');
        await this._ensureAudioPipeline();
    }

    _setupPersistence() {
        // Save local state periodically during playback
        this._saveInterval = setInterval(() => {
            if (this.store.state.isPlaying) {
                saveLocalState(this.store.state);
            }
        }, 10000);  // Every 10 seconds

        // Check sleep timer every minute
        // This catches cases where setTimeout doesn't fire reliably on mobile
        this._sleepTimerCheckInterval = setInterval(() => {
            this._checkSleepTimerAndMaybeSleep();
        }, 60000);  // Every 60 seconds

        // Save on page unload
        window.addEventListener('beforeunload', () => {
            saveLocalState(this.store.state);
        });

        // Track when we lose focus to throttle refresh on regain
        this._lastActiveTime = Date.now();
        this._lastRefreshTime = 0;

        // Save on visibility change (e.g., switching tabs on mobile)
        // Also refresh queue when becoming visible again (cross-device sync)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                saveLocalState(this.store.state);
                // Auto-activate sleep timer in "time" mode when going to background
                this._maybeAutoStartSleepTimer();
            } else if (document.visibilityState === 'visible') {
                this._maybeRefreshQueue();
                // Cancel auto-started timer when returning to foreground (will recalculate on next hide)
                if (this.store.state.sleepTimerMode === 'time' && this.store.state.sleepTimerEndTime) {
                    this.cancelSleepTimer();
                }
            }
        });

        // Also refresh on window focus (desktop: switching between applications)
        window.addEventListener('focus', () => {
            this._maybeRefreshQueue();
        });

        // Track when we lose focus
        window.addEventListener('blur', () => {
            this._lastActiveTime = Date.now();
        });
    }

    /**
     * Refresh queue if enough time has passed since last activity/refresh.
     */
    _maybeRefreshQueue() {
        const now = Date.now();
        const minAwayTime = 5000;  // Must be away for 5+ seconds
        const minRefreshInterval = 5000;  // Don't refresh more than once per 5 seconds

        const awayLongEnough = (now - this._lastActiveTime) >= minAwayTime;
        const notRecentlyRefreshed = (now - this._lastRefreshTime) >= minRefreshInterval;

        if (awayLongEnough && notRecentlyRefreshed) {
            this._lastRefreshTime = now;
            this._refreshQueueOnFocus();
        }
        this._lastActiveTime = now;
    }

    /**
     * Refresh queue when regaining focus (cross-device sync).
     * Updates queue list and queueIndex from server.
     * Only updates currentSong if not currently playing.
     * Skipped when in temp queue mode.
     */
    async _refreshQueueOnFocus() {
        // Skip sync in temp queue mode or while exiting temp queue
        if (this.store.state.tempQueueMode || this._isExitingTempQueue) return;

        // Skip sync while offline sync is in progress
        if (isSyncing()) return;

        // Skip sync within 5 seconds of exiting temp queue to prevent race condition
        // where server state overwrites the just-restored local queue
        const timeSinceExit = Date.now() - this._tempQueueExitTime;
        if (timeSinceExit < 5000) {
            return;
        }

        // Skip sync within 5 seconds of queue sync completing to prevent race condition
        // where focus refresh overwrites the just-synced queue state
        const timeSinceSync = Date.now() - offlineStore.state.lastQueueSyncTime;
        if (timeSinceSync < 5000) {
            return;
        }

        try {
            const result = await queueApi.list({ limit: 10000 });
            if (result.error) return;

            const wasPlaying = this.store.state.isPlaying;
            const currentUuid = this.store.state.currentSong?.uuid;

            // Update queue items
            this.store.state.queue = result.items || [];
            this.store.state.scaEnabled = result.scaEnabled || false;
            this.store.state.queueVersion++;

            // Update queueIndex: if playing, preserve current song's position in queue
            // (prevents crossfade race condition where server returns stale index)
            if (wasPlaying && currentUuid) {
                const oldQueueIndex = this.store.state.queueIndex;
                const queue = this.store.state.queue;

                // First check if song at current position still matches - handles duplicates correctly
                if (queue[oldQueueIndex]?.uuid === currentUuid) {
                    // Position still valid, keep it
                    this.store.state.queueIndex = oldQueueIndex;
                } else {
                    // Song at current position changed - find nearest occurrence
                    let nearestIndex = -1;
                    let nearestDistance = Infinity;

                    for (let i = 0; i < queue.length; i++) {
                        if (queue[i].uuid === currentUuid) {
                            const distance = Math.abs(i - oldQueueIndex);
                            if (distance < nearestDistance) {
                                nearestDistance = distance;
                                nearestIndex = i;
                            }
                        }
                    }

                    if (nearestIndex >= 0) {
                        this.store.state.queueIndex = nearestIndex;
                    } else {
                        // Current song no longer in queue - queues are desynced
                        // Use server's index (server is authoritative after sync)
                        // Note: offline queue sync is handled by syncQueueState() which
                        // compares timestamps and pushes local if newer
                        this.store.state.queueIndex = result.queueIndex || 0;
                        this.store.state.currentSong = queue[this.store.state.queueIndex] || null;
                    }
                }
            } else {
                // Not playing - use server's index
                this.store.state.queueIndex = result.queueIndex || 0;
            }

            // Update play mode
            const playMode = result.playMode || 'sequential';
            if (playMode === 'repeat_one') {
                this.store.state.shuffle = false;
                this.store.state.repeatMode = 'one';
            } else if (playMode === 'repeat_all') {
                this.store.state.shuffle = false;
                this.store.state.repeatMode = 'all';
            } else if (playMode === 'shuffle') {
                this.store.state.shuffle = true;
                this.store.state.repeatMode = 'none';
            } else {
                this.store.state.shuffle = false;
                this.store.state.repeatMode = 'none';
            }

            // Only update currentSong if not currently playing
            // (don't interrupt active playback)
            if (!wasPlaying && this.store.state.queue.length > 0) {
                const serverSong = this.store.state.queue[this.store.state.queueIndex];
                if (serverSong && serverSong.uuid !== currentUuid) {
                    this.store.state.currentSong = { ...serverSong };
                    // Clear saved time since we're on a different song
                    this.store.state.currentTime = 0;
                    this._applyReplayGain();
                    this._updateMediaSessionMetadata(serverSong);
                }
            }
        } catch (e) {
            console.error('Failed to refresh queue on focus:', e);
        }
    }

    _setupEventListeners(audioElement = this.audio) {
        audioElement.addEventListener('timeupdate', () => {
            // Only update state if this is still the active audio element
            if (audioElement !== this.audio) return;
            this.store.state.currentTime = this.audio.currentTime;
            // If we're receiving timeupdate, audio is playing - ensure state reflects this
            // This guards against any state corruption from race conditions
            if (!this.audio.paused && !this.store.state.isPlaying) {
                this.store.state.isPlaying = true;
                this.store.state.isPaused = false;
            }
            this._updateMediaSessionPosition();
            this._checkCrossfade();
        });

        audioElement.addEventListener('loadedmetadata', () => {
            if (audioElement !== this.audio) return;
            this.store.state.duration = this.audio.duration;
            this.store.state.isLoading = false;
            this._updateMediaSessionPosition();
        });

        audioElement.addEventListener('durationchange', () => {
            if (audioElement !== this.audio) return;
            this.store.state.duration = this.audio.duration;
        });

        audioElement.addEventListener('progress', () => {
            if (audioElement !== this.audio) return;
            this._updateBuffered();
        });

        audioElement.addEventListener('play', () => {
            // Only update state if this is still the active audio element
            if (audioElement !== this.audio) return;
            this.store.state.isPlaying = true;
            this.store.state.isPaused = false;
            this.playStartTime = Date.now();
            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'playing';
            }
            this._updateMediaSessionPosition();
            // Notify noise worklet of playback state
            this._sendNoiseSettings({ isPlaying: true });
        });

        audioElement.addEventListener('pause', () => {
            // Only update state if this is still the active audio element
            if (audioElement !== this.audio) return;
            // Don't update state during crossfade - old element's pause event would corrupt state
            // Manual pause during crossfade is handled by pause() which cancels crossfade first
            if (this._crossfadeInProgress) return;
            this.store.state.isPlaying = false;
            this.store.state.isPaused = true;
            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'paused';
            }
            this._updateMediaSessionPosition();
            // Notify noise worklet of playback state
            this._sendNoiseSettings({ isPlaying: false });
        });

        audioElement.addEventListener('ended', () => {
            // Only handle if this is still the active audio element
            if (audioElement !== this.audio) return;
            this._handleTrackEnd();
        });

        audioElement.addEventListener('error', (e) => {
            // Only handle errors from the active audio element
            if (audioElement !== this.audio) return;
            this._handleError(e);
        });

        // Debounce loading state to prevent flashing on brief buffers
        audioElement.addEventListener('waiting', () => {
            if (audioElement !== this.audio) return;
            if (this._loadingTimeout) clearTimeout(this._loadingTimeout);
            this._loadingTimeout = setTimeout(() => {
                if (audioElement !== this.audio) return;
                this.store.state.isLoading = true;
            }, 300);  // Only show loading after 300ms of buffering
        });

        audioElement.addEventListener('canplay', () => {
            if (audioElement !== this.audio) return;
            if (this._loadingTimeout) {
                clearTimeout(this._loadingTimeout);
                this._loadingTimeout = null;
            }
            this.store.state.isLoading = false;
        });

        // Listen for queue restoration after coming back online (only once)
        if (audioElement === this.audio && !this._queueRestoredListenerSet) {
            this._queueRestoredListenerSet = true;
            window.addEventListener('queue-items-restored', (e) => {
                this._handleQueueRestored(e.detail);
            });
        }
    }

    /**
     * Handle queue items restored after coming back online.
     * Updates in-memory queue with full metadata while preserving playback state.
     */
    _handleQueueRestored(detail) {
        const { items, queueIndex } = detail;
        if (!items) return;

        // Don't overwrite temp queue when exiting offline mode
        if (this.store.state.tempQueueMode) {
            console.log('[Player] Ignoring queue restore - in temp queue mode');
            return;
        }

        // Update queue with restored items (full metadata)
        this.store.state.queue = items;
        this.store.state.queueVersion++;  // Trigger re-render

        // Update queueIndex if provided
        if (queueIndex !== undefined) {
            this.store.state.queueIndex = queueIndex;
        }

        // Update currentSong metadata if it was incomplete
        const currentSong = this.store.state.currentSong;
        if (currentSong && currentSong.uuid) {
            const restoredSong = items.find(s => s.uuid === currentSong.uuid);
            if (restoredSong && restoredSong.title && !currentSong.title) {
                // Preserve playback state while updating metadata
                this.store.state.currentSong = {
                    ...restoredSong,
                    uuid: currentSong.uuid
                };
                // Re-apply replay gain with new metadata
                this._applyReplayGain();
                // Update media session with new metadata
                this._updateMediaSessionMetadata(this.store.state.currentSong);
            }
        }
    }

    _setupMediaSession() {
        if (!('mediaSession' in navigator)) return;

        const actions = [
            ['play', () => this.resume()],
            ['pause', () => this.pause()],
            ['previoustrack', () => this.previous()],
            ['nexttrack', () => this.next()],
            ['seekbackward', (details) => {
                const offset = details.seekOffset || 10;
                this.seek(Math.max(0, this.audio.currentTime - offset));
            }],
            ['seekforward', (details) => {
                const offset = details.seekOffset || 10;
                this.seek(Math.min(this.audio.duration, this.audio.currentTime + offset));
            }],
            ['seekto', (details) => {
                if (this.store.state.currentSong?.seekable !== false) {
                    this.seek(details.seekTime);
                }
            }],
            ['stop', () => this.stop()]
        ];

        // Register each handler in try/catch - unsupported actions throw
        for (const [action, handler] of actions) {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch (e) {
                console.warn(`Media Session action '${action}' not supported:`, e.message);
            }
        }
    }

    _updateMediaSessionMetadata(song) {
        if (!('mediaSession' in navigator)) return;

        navigator.mediaSession.metadata = new MediaMetadata({
            title: song.title || 'Unknown Title',
            artist: song.artist || 'Unknown Artist',
            album: song.album || '',
            artwork: []  // No album art currently
        });
    }

    _updateMediaSessionPosition() {
        if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;

        const duration = this.audio.duration;
        const position = this.audio.currentTime;

        // Don't update if duration is invalid (NaN, Infinity, 0, or not yet loaded)
        if (!duration || !isFinite(duration) || duration <= 0) return;
        // Don't update if position is invalid or exceeds duration
        if (!isFinite(position) || position < 0 || position > duration) return;

        try {
            navigator.mediaSession.setPositionState({
                duration,
                playbackRate: this.audio.playbackRate || 1,
                position
            });
        } catch (e) {
            // Ignore position state errors
        }
    }

    _updateBuffered() {
        if (this.audio.buffered.length > 0) {
            this.store.state.buffered = this.audio.buffered.end(
                this.audio.buffered.length - 1
            );
        }
    }

    async _handleTrackEnd() {
        // If crossfade is in progress (loading next song), signal it to skip the ramp
        // This handles the case where user seeks close to end and song finishes before crossfade loads
        if (this._crossfadeInProgress) {
            this._crossfadeSkipRamp = true;
            return;
        }

        // Record play in history (fire-and-forget, don't block playback)
        if (this.store.state.currentSong) {
            const duration = this.playStartTime
                ? Math.floor((Date.now() - this.playStartTime) / 1000)
                : 0;
            history.record(
                this.store.state.currentSong.uuid,
                duration,
                false,
                this.store.state.scaEnabled ? 'radio' : 'browse'
            ).catch(e => console.error('Failed to record history:', e));
        }

        // Handle repeat mode
        if (this.store.state.repeatMode === 'one') {
            this.audio.currentTime = 0;
            await this.audio.play();
            return;
        }

        // Play next (not user-initiated, don't cancel crossfade)
        await this.next({ userInitiated: false });
    }

    _handleError(e) {
        console.error('Audio error:', e);
        this.store.state.isLoading = false;

        // Track consecutive errors to prevent infinite skip loops
        this._consecutiveErrors = (this._consecutiveErrors || 0) + 1;

        // If we've hit too many consecutive errors, stop trying
        const maxErrors = Math.min(5, this.store.state.queue.length);
        if (this._consecutiveErrors >= maxErrors) {
            console.error('Too many consecutive playback errors, stopping');
            this.store.state.error = 'Failed to play audio - too many errors';
            this.store.state.isPlaying = false;
            this._consecutiveErrors = 0;
            return;
        }

        // Try to skip to the next song
        console.log(`Playback error, skipping to next (error ${this._consecutiveErrors}/${maxErrors})`);
        this.next({ userInitiated: false }).catch(err => {
            console.error('Failed to skip after error:', err);
            this.store.state.error = 'Failed to play audio';
            this.store.state.isPlaying = false;
        });
    }

    /**
     * Play a song. If unavailable offline, automatically skips to next available song.
     * @param {Object} song - Song to play
     * @param {number} [skipCount=0] - Internal counter to prevent infinite skip loops
     */
    async play(song, skipCount = 0) {
        // Check sleep timer between songs - if expired, don't start next song
        if (this._checkSleepTimerAndMaybeSleep()) {
            return;
        }

        this.store.state.isLoading = true;
        this.store.state.error = null;
        this.store.state.currentSong = song;
        this.store.state.currentTime = 0;
        this.store.state.duration = song.duration_seconds || 0;

        // Check for offline audio first (in work-offline mode or when available)
        let audioUrl = null;
        if (offlineStore.state.workOfflineMode || !offlineStore.state.isOnline) {
            // In offline mode, only use cached audio
            audioUrl = await getAudioUrl(song.uuid);
            if (!audioUrl) {
                console.warn('Song not available offline, skipping:', song.uuid);

                // Try to skip to next available song (limit skips to prevent infinite loop)
                const queueLength = this.store.state.queue.length;
                if (skipCount < queueLength) {
                    this.store.state.isLoading = false;
                    // Advance to next and try again
                    const nextIndex = this.store.state.queueIndex + 1;
                    if (nextIndex < queueLength) {
                        this.store.state.queueIndex = nextIndex;
                        const nextSong = this.store.state.queue[nextIndex];
                        if (nextSong) {
                            return this.play(nextSong, skipCount + 1);
                        }
                    }
                }

                // No available songs found
                this.store.state.error = 'No songs available offline';
                this.store.state.isLoading = false;
                this.store.state.currentSong = null;
                return;
            }
        } else {
            // Online - try offline audio first, fall back to streaming
            audioUrl = await getAudioUrl(song.uuid);
            if (!audioUrl) {
                audioUrl = getStreamUrl(song.uuid, song.type);
            }
        }

        // Initialize audio pipeline if crossfade is enabled but not set up yet
        // Do this BEFORE setting the audio source to avoid glitches during playback
        if (this.store.state.crossfadeEnabled) {
            if (!this._dualPipelineActive) {
                console.log('[Play] Initializing dual pipeline for crossfade');
                await this._ensureAudioPipeline();
            }
            // Ensure the primary audio source is connected to the pipeline
            if (this._dualPipelineActive && !this._audioSources[this._primaryIndex]) {
                console.log('[Play] Connecting audio source to pipeline');
                this._ensureSourceConnected(this._primaryIndex);
            }
        }

        this.audio.src = audioUrl;

        // In dual mode, ensure gains are reset properly
        // (might be mid-fade if called during crossfade or after an aborted one)
        if (this._dualPipelineActive) {
            this._resetAllGains();
            // Cancel any in-progress crossfade since we're playing a new song directly
            this._crossfadeInProgress = false;
            this._crossfadeSeekLockout = false;
        }

        // Apply replay gain for the new song
        this._applyReplayGain();

        // Apply tempo settings
        this._applyTempo();

        this._updateMediaSessionMetadata(song);

        try {
            await this.audio.play();
            // Explicitly set state - don't rely solely on 'play' event
            this.store.state.isPlaying = true;
            this.store.state.isPaused = false;
            this.store.state.isLoading = false;
            this.playStartTime = Date.now();
            // Reset consecutive error counter on successful playback
            this._consecutiveErrors = 0;
        } catch (error) {
            console.error('Playback failed:', error);
            this.store.state.error = 'Playback failed';
            this.store.state.isPlaying = false;
            this.store.state.isPaused = true;
            this.store.state.isLoading = false;
        }

        // Save local state after song change
        saveLocalState(this.store.state);

        // Preload next song
        this._preloadNext();
    }

    /**
     * Pause playback.
     */
    pause() {
        this._cancelCrossfade();
        this.audio.pause();
    }

    /**
     * Resume playback.
     */
    async resume() {
        // If we have a currentSong but no audio source loaded (e.g., after page refresh),
        // we need to reload the source first
        let song = this.store.state.currentSong;
        const savedTime = this.store.state.currentTime;

        // If no current song but queue has songs, start playing the first one
        if (!song && this.store.state.queue.length > 0) {
            const index = this.store.state.queueIndex || 0;
            song = this.store.state.queue[index];
            if (song) {
                return this.play(song);
            }
        }

        if (song && !this.audio.src) {
            // Check for offline audio first
            let audioUrl = await getAudioUrl(song.uuid);
            if (!audioUrl) {
                // Check if we're offline
                if (offlineStore.state.workOfflineMode || !offlineStore.state.isOnline) {
                    console.warn('Song not available offline, trying next:', song.uuid);
                    // Try to play next available song (automatic, not user-initiated)
                    return this.next({ userInitiated: false });
                }
                audioUrl = getStreamUrl(song.uuid, song.type);
            }
            this.audio.src = audioUrl;
            this._updateMediaSessionMetadata(song);
            this._applyTempo();

            // Seek to saved position after metadata loads (requires range request support)
            if (savedTime > 0) {
                await new Promise(resolve => {
                    const onLoaded = () => {
                        this.audio.removeEventListener('loadedmetadata', onLoaded);
                        this.audio.currentTime = savedTime;
                        resolve();
                    };
                    this.audio.addEventListener('loadedmetadata', onLoaded);
                });
            }
        }

        try {
            await this.audio.play();
            // Explicitly set state - play() on already-playing audio doesn't fire 'play' event
            this.store.state.isPlaying = true;
            this.store.state.isPaused = false;
            this.playStartTime = Date.now();
        } catch (error) {
            // Autoplay blocked or other error - just stay paused
            console.warn('Resume failed (autoplay blocked?):', error.message);
            this.store.state.isPlaying = false;
            this.store.state.isPaused = true;
            this.store.state.isLoading = false;
        }
    }

    /**
     * Toggle play/pause.
     */
    async togglePlayPause() {
        if (this.store.state.isPlaying) {
            this.pause();
        } else {
            await this.resume();
        }
    }

    /**
     * Stop playback.
     */
    stop() {
        this.audio.pause();
        this.audio.currentTime = 0;
        this.store.state.isPlaying = false;
        this.store.state.isPaused = false;
        this.store.state.currentSong = null;
    }

    /**
     * Seek to position (in seconds).
     */
    seek(position) {
        const song = this.store.state.currentSong;
        if (!song) return;

        // Don't seek non-seekable tracks
        if (song.seekable === false || song.seekable === 0) {
            console.warn('Track is not seekable');
            return;
        }

        this.audio.currentTime = Math.max(0, Math.min(position, this.audio.duration));
    }

    /**
     * Calculate the ReplayGain linear multiplier for a song (without user volume).
     * @param {Object|null} song - Song object with replay_gain_track/album properties
     * @returns {number} Linear gain multiplier (typically 0.1 to 2.0)
     */
    _calculateReplayGainLinear(song) {
        const state = this.store.state;
        // Use baseVolume of 1.0 to get just the RG multiplier
        return calculateReplayGainVolume(
            1.0,
            song,
            state.replayGainMode,
            state.replayGainPreamp,
            state.replayGainFallback
        );
    }

    /**
     * Update a specific ReplayGain node's value (dual mode only).
     * Only sets the per-track normalization, not user volume.
     * @param {number} index - Audio element index (0 or 1)
     * @param {Object|null} song - Song object
     */
    _updateReplayGainNode(index, song) {
        if (!this._dualPipelineActive || !this._replayGainNodes[index]) return;

        const linearGain = this._calculateReplayGainLinear(song);
        try {
            this._replayGainNodes[index].gain.setValueAtTime(linearGain, this._audioContext.currentTime);
        } catch (e) {
            // Fallback to direct assignment
            this._replayGainNodes[index].gain.value = linearGain;
        }
    }

    /**
     * Apply replay gain to audio volume.
     * In simple mode: sets HTML5 audio volume directly (combines RG + user volume).
     * In dual mode: updates ReplayGain node for per-track normalization,
     *               HTML5 volume handles user volume separately.
     * When loudness enabled: HTML5 volume stays at 1.0, user volume controlled via Web Audio.
     * Called when song changes, volume changes, or replay gain settings change.
     */
    _applyReplayGain() {
        const state = this.store.state;

        // When loudness is enabled, user volume is controlled via _userVolumeGain in Web Audio
        // HTML5 volume stays at 1.0 to provide headroom for loudness boost
        if (state.loudnessEnabled && this._loudnessInitialized) {
            if (this._dualPipelineActive) {
                // Dual mode: ReplayGain nodes handle per-track normalization
                this._updateReplayGainNode(this._primaryIndex, state.currentSong);
            }
            // HTML5 volume at full (headroom for loudness boost)
            this._audioElements[0].volume = 1.0;
            this._audioElements[1].volume = 1.0;
            // User volume controlled via loudness gain node
            this._updateLoudnessGains();
            return;
        }

        // Loudness disabled - use standard volume control
        if (this._dualPipelineActive) {
            // Dual mode: ReplayGain nodes handle per-track normalization
            this._updateReplayGainNode(this._primaryIndex, state.currentSong);
            // HTML5 volume handles user volume (both elements)
            const vol = state.muted ? 0 : state.volume;
            this._audioElements[0].volume = vol;
            this._audioElements[1].volume = vol;
        } else {
            // Simple mode: HTML5 volume combines RG + user volume
            if (state.muted) {
                this.audio.volume = 0;
            } else {
                this.audio.volume = calculateReplayGainVolume(
                    state.volume,
                    state.currentSong,
                    state.replayGainMode,
                    state.replayGainPreamp,
                    state.replayGainFallback
                );
            }
        }

        // When loudness disabled, ensure loudness nodes are in passthrough mode
        if (this._loudnessInitialized) {
            this._updateLoudnessGains();
        }
    }

    /**
     * Set volume (0-1). Device-specific, saved to localStorage only.
     */
    setVolume(volume) {
        volume = Math.max(0, Math.min(1, volume));
        this.store.state.volume = volume;
        this.store.state.muted = volume === 0;

        // Apply volume with replay gain
        this._applyReplayGain();
        saveLocalState(this.store.state);
    }

    /**
     * Toggle mute.
     */
    toggleMute() {
        if (this.store.state.muted) {
            this.store.state.muted = false;
        } else {
            this.store.state.muted = true;
        }
        this._applyReplayGain();
        saveLocalState(this.store.state);
    }

    /**
     * Set replay gain mode and sync to server.
     */
    async setReplayGainMode(mode) {
        if (!['off', 'track', 'album'].includes(mode)) {
            console.warn('Invalid replay gain mode:', mode);
            return;
        }

        this.store.state.replayGainMode = mode;
        this._applyReplayGain();

        try {
            await preferences.set({ replayGainMode: mode });
        } catch (e) {
            console.error('Failed to sync replay gain mode:', e);
        }
    }

    /**
     * Set replay gain preamp and sync to server.
     */
    async setReplayGainPreamp(preamp) {
        // Clamp to -12 to +12 dB
        preamp = Math.max(-12, Math.min(12, preamp));
        this.store.state.replayGainPreamp = preamp;
        this._applyReplayGain();

        try {
            await preferences.set({ replayGainPreamp: preamp });
        } catch (e) {
            console.error('Failed to sync replay gain preamp:', e);
        }
    }

    /**
     * Set replay gain fallback and sync to server.
     */
    async setReplayGainFallback(fallback) {
        // Clamp to -24 to 0 dB
        fallback = Math.max(-24, Math.min(0, fallback));
        this.store.state.replayGainFallback = fallback;
        this._applyReplayGain();

        try {
            await preferences.set({ replayGainFallback: fallback });
        } catch (e) {
            console.error('Failed to sync replay gain fallback:', e);
        }
    }

    /**
     * Initialize EQ filters in the Web Audio graph.
     * Called by visualizer-page when it creates the audio context.
     * @param {AudioContext} audioContext - The Web Audio context
     * @param {AudioNode} sourceNode - The source node to connect from
     * @param {AudioNode} [outputNode] - Optional output node (for dynamic EQ reconfiguration)
     * @returns {AudioNode} The last node in the EQ chain (or sourceNode if EQ disabled)
     */
    initEQ(audioContext, sourceNode, outputNode = null) {
        // Store references for dynamic parametric EQ
        this._audioContext = audioContext;
        this._eqSourceNode = sourceNode;
        if (outputNode) {
            this._eqOutputNode = outputNode;
        }

        if (this._eqFilters) {
            // Already initialized - return last filter
            return this._eqFilters[this._eqFilters.length - 1];
        }

        // Create BiquadFilter nodes for each band
        this._eqFilters = EQ_BANDS.map((freq, i) => {
            const filter = audioContext.createBiquadFilter();
            // First band is lowshelf, last is highshelf, rest are peaking
            const isShelf = i === 0 || i === 9;
            filter.type = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking';
            filter.frequency.value = freq;
            // Only set Q for peaking filters (shelf filters use default slope)
            if (!isShelf) {
                filter.Q.value = 1.4;  // Standard Q for 10-band EQ
            }
            // Apply gain (or 0 if EQ disabled)
            filter.gain.value = this.store.state.eqEnabled ? this.store.state.eqGains[i] : 0;
            return filter;
        });

        // Chain filters: source → filter1 → filter2 → ... → filter10
        let lastNode = sourceNode;
        for (const filter of this._eqFilters) {
            lastNode.connect(filter);
            lastNode = filter;
        }

        return lastNode;
    }

    /**
     * Set EQ band gain (-12 to +12 dB).
     */
    setEQBand(index, gain) {
        if (index < 0 || index >= EQ_BANDS.length) return;

        // Clamp gain to -12 to +12 dB
        gain = Math.max(-12, Math.min(12, gain));
        this.store.state.eqGains[index] = gain;

        // Apply to filter if initialized and EQ enabled
        if (this._eqFilters && this._eqFilters[index] && this.store.state.eqEnabled) {
            this._eqFilters[index].gain.value = gain;
        }

        saveEQSettings(this.store.state.eqEnabled, this.store.state.eqGains);
    }

    /**
     * Set graphic EQ preamp (for headroom).
     * @param {number} preamp - Preamp in dB (typically negative)
     */
    setGraphicPreamp(preamp) {
        this._graphicPreamp = preamp;

        if (this._eqPreampGain && !this._isParametricMode) {
            const effectivePreamp = this.store.state.eqEnabled ? preamp : 0;
            const linearGain = Math.pow(10, effectivePreamp / 20);
            this._eqPreampGain.gain.value = linearGain;
        }
    }

    /**
     * Enable or disable EQ.
     */
    setEQEnabled(enabled) {
        this.store.state.eqEnabled = enabled;

        // Handle parametric mode
        if (this._isParametricMode && this._parametricBands) {
            // Apply to parametric filters
            if (this._eqFilters) {
                this._eqFilters.forEach((filter, i) => {
                    const band = this._parametricBands[i];
                    if (band) {
                        filter.gain.value = enabled ? band.gain : 0;
                    }
                });
            }
            // Apply to preamp
            if (this._eqPreampGain) {
                const effectivePreamp = enabled ? (this._parametricPreamp || 0) : 0;
                const linearGain = Math.pow(10, effectivePreamp / 20);
                this._eqPreampGain.gain.value = linearGain;
            }
        } else {
            // Apply to graphic EQ filters
            if (this._eqFilters) {
                this._eqFilters.forEach((filter, i) => {
                    filter.gain.value = enabled ? this.store.state.eqGains[i] : 0;
                });
            }
            // Also handle preamp for graphic EQ if it exists
            if (this._eqPreampGain) {
                const effectivePreamp = enabled ? (this._graphicPreamp || 0) : 0;
                const linearGain = Math.pow(10, effectivePreamp / 20);
                this._eqPreampGain.gain.value = linearGain;
            }
        }

        saveEQSettings(enabled, this.store.state.eqGains);
    }

    /**
     * Reset all EQ bands to 0 dB.
     */
    resetEQ() {
        this.store.state.eqGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

        if (this._eqFilters && this.store.state.eqEnabled) {
            this._eqFilters.forEach(filter => {
                filter.gain.value = 0;
            });
        }

        saveEQSettings(this.store.state.eqEnabled, this.store.state.eqGains);
    }

    /**
     * Restore 10-band graphic EQ from parametric mode.
     * Reconfigures the filter chain back to standard graphic EQ.
     * @param {number} [preamp=0] - Preamp in dB to prevent clipping
     */
    restoreGraphicEQ(preamp = 0) {
        // Clear parametric mode
        this._isParametricMode = false;
        this._graphicPreamp = preamp;

        if (!this._audioContext || !this._eqSourceNode) {
            return; // Not initialized
        }

        // Disconnect existing chain
        try {
            this._eqSourceNode.disconnect();
        } catch (e) {}

        // Disconnect existing filters
        if (this._eqFilters) {
            this._eqFilters.forEach(filter => {
                try { filter.disconnect(); } catch (e) {}
            });
        }

        // Disconnect preamp if exists
        if (this._eqPreampGain) {
            try { this._eqPreampGain.disconnect(); } catch (e) {}
        }

        // Create preamp gain node if needed
        if (!this._eqPreampGain) {
            this._eqPreampGain = this._audioContext.createGain();
        }

        // Set preamp gain (convert dB to linear) - only apply if EQ is enabled
        const effectivePreamp = this.store.state.eqEnabled ? preamp : 0;
        const linearGain = Math.pow(10, effectivePreamp / 20);
        this._eqPreampGain.gain.value = linearGain;

        // Create standard 10-band graphic EQ filters
        this._eqFilters = EQ_BANDS.map((freq, i) => {
            const filter = this._audioContext.createBiquadFilter();
            filter.type = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking';
            filter.frequency.value = freq;
            if (i > 0 && i < 9) {
                filter.Q.value = 1.4;
            }
            filter.gain.value = this.store.state.eqEnabled ? this.store.state.eqGains[i] : 0;
            return filter;
        });

        // Chain: source -> filters -> preamp -> crossfeed -> noise -> output
        let lastNode = this._eqSourceNode;
        for (const filter of this._eqFilters) {
            lastNode.connect(filter);
            lastNode = filter;
        }
        lastNode.connect(this._eqPreampGain);
        // Insert crossfeed into chain
        lastNode = this._connectCrossfeed(this._eqPreampGain) || this._eqPreampGain;
        // Insert noise into chain
        lastNode = this._connectNoise(lastNode);
        lastNode.connect(this._eqOutputNode);
    }

    /**
     * Set parametric EQ configuration.
     * Dynamically reconfigures the filter chain with the given bands.
     * Auto-initializes audio context if needed.
     * @param {Object[]} bands - Array of band configurations
     * @param {number} [autoPreamp=0] - Auto-preamp in dB to prevent clipping
     */
    async setParametricEQ(bands, autoPreamp = 0) {
        // Store for later restore when EQ is re-enabled
        this._parametricBands = bands;
        this._parametricPreamp = autoPreamp;
        this._isParametricMode = true;

        // Auto-initialize if not already done - use unified pipeline builder
        if (!this._audioContext || !this._eqSourceNode) {
            await this._ensureAudioPipeline();
        }

        if (!this._audioContext) {
            console.warn('Could not initialize EQ audio context');
            return;
        }

        // Get the chain input node (mixer in dual mode, source in simple mode)
        const chainInputNode = this._getChainInputNode();
        if (!chainInputNode) {
            console.warn('Could not get chain input node');
            return;
        }

        // Disconnect existing chain from the input node
        try {
            chainInputNode.disconnect();
        } catch (e) {
            // May already be disconnected
        }

        // Disconnect existing filters
        if (this._eqFilters) {
            this._eqFilters.forEach(filter => {
                try { filter.disconnect(); } catch (e) {}
            });
        }

        // Disconnect existing preamp gain node
        if (this._eqPreampGain) {
            try { this._eqPreampGain.disconnect(); } catch (e) {}
        }

        // Create preamp gain node if needed
        if (!this._eqPreampGain) {
            this._eqPreampGain = this._audioContext.createGain();
        }

        // Set preamp gain (convert dB to linear) - only apply if EQ is enabled
        const effectivePreamp = this.store.state.eqEnabled ? autoPreamp : 0;
        const linearGain = Math.pow(10, effectivePreamp / 20);
        this._eqPreampGain.gain.value = linearGain;

        // Create new filters
        if (!bands || bands.length === 0) {
            // No filters - connect chainInput -> loudness -> preamp -> crossfeed -> noise -> output
            this._eqFilters = [];
            const loudnessOut = this._connectLoudness(chainInputNode);
            loudnessOut.connect(this._eqPreampGain);
            const crossfeedOut = this._connectCrossfeed(this._eqPreampGain) || this._eqPreampGain;
            // Insert noise into chain
            const noiseOut = this._connectNoise(crossfeedOut);
            noiseOut.connect(this._eqOutputNode);
            return;
        }

        this._eqFilters = bands.map(band => {
            const filter = this._audioContext.createBiquadFilter();
            filter.type = band.type;
            filter.frequency.value = band.frequency;
            filter.gain.value = this.store.state.eqEnabled ? band.gain : 0;
            // Q is only relevant for certain filter types
            if (['peaking', 'notch', 'bandpass', 'allpass', 'lowpass', 'highpass'].includes(band.type)) {
                filter.Q.value = band.q || 1.0;
            }
            return filter;
        });

        // Chain: chainInput -> loudness -> filter1 -> filter2 -> ... -> preamp -> crossfeed -> noise -> output
        let lastNode = this._connectLoudness(chainInputNode);
        for (const filter of this._eqFilters) {
            lastNode.connect(filter);
            lastNode = filter;
        }
        lastNode.connect(this._eqPreampGain);
        // Insert crossfeed into chain
        const crossfeedOut = this._connectCrossfeed(this._eqPreampGain) || this._eqPreampGain;
        // Insert noise into chain
        const noiseOut = this._connectNoise(crossfeedOut);
        noiseOut.connect(this._eqOutputNode);
    }

    /**
     * Get the current EQ filters for frequency response calculation.
     * @returns {BiquadFilterNode[]|null} Array of BiquadFilterNodes or null
     */
    getEQFilters() {
        return this._eqFilters;
    }

    /**
     * Get the audio context for frequency response calculation.
     * @returns {AudioContext|null} AudioContext or null
     */
    getAudioContext() {
        return this._audioContext || null;
    }

    /**
     * Connect an external audio element to the audio pipeline (EQ, etc.)
     * Used by loopsong page and other standalone players.
     * @param {HTMLAudioElement} audioElement - Audio element to connect
     * @returns {Promise<{source: MediaElementAudioSourceNode, disconnect: Function}>}
     */
    async connectExternalAudio(audioElement) {
        // Ensure audio pipeline exists
        await this._ensureAudioPipeline();

        if (!this._audioContext) {
            throw new Error('Failed to create audio context');
        }

        // Create source node for the external audio
        const source = this._audioContext.createMediaElementSource(audioElement);

        // Connect to EQ chain if available, otherwise to destination
        if (this._eqFilters && this._eqFilters.length > 0) {
            source.connect(this._eqFilters[0]);
        } else {
            source.connect(this._eqOutputNode || this._audioContext.destination);
        }

        // Return source and cleanup function
        return {
            source,
            disconnect: () => {
                try { source.disconnect(); } catch (e) {}
            }
        };
    }

    /**
     * Insert an analyser node into the existing audio chain.
     * Called by visualizer when it needs to add analyser to EQ-initialized chain.
     * Reconnects: chain end → analyser → destination
     * @param {AnalyserNode} analyser - The analyser node to insert
     */
    insertAnalyser(analyser) {
        if (!this._audioContext) return;

        // Find the actual last node in the chain (crossfeed merger if active, otherwise preamp/filter/source)
        const lastNode = this._getChainEndNode();

        // Disconnect last node from current destination
        try {
            lastNode.disconnect(this._eqOutputNode);
        } catch (e) {
            // May not be connected
        }

        // Reconnect: last node → analyser → destination
        lastNode.connect(analyser);
        analyser.connect(this._audioContext.destination);

        // Update output node for future EQ changes
        this._eqOutputNode = analyser;
        this.audio._visualizerAnalyser = analyser;
    }

    /**
     * Remove the analyser node from the audio chain.
     * Called when visualizer closes to stop FFT computation and save resources.
     * Reconnects: chain end → destination (bypassing analyser)
     */
    removeAnalyser() {
        if (!this._audioContext || !this.audio._visualizerAnalyser) return;

        const analyser = this.audio._visualizerAnalyser;

        // Find the actual last node in the chain
        const lastNode = this._getChainEndNode();

        // Disconnect current chain
        try {
            lastNode.disconnect(analyser);
            analyser.disconnect(this._audioContext.destination);
        } catch (e) {
            // May not be connected
        }

        // Reconnect directly to destination
        lastNode.connect(this._audioContext.destination);

        // Update output node and clear analyser reference
        this._eqOutputNode = this._audioContext.destination;
        this.audio._visualizerAnalyser = null;
    }

    /**
     * Get the actual end node of the audio processing chain.
     * This accounts for crossfeed/stereo image processing if active.
     */
    _getChainEndNode() {
        // Noise merger is at the end of the chain (after crossfeed)
        if (this._noiseInitialized && this._noiseMerger) {
            return this._noiseMerger;
        }
        // If crossfeed is initialized and connected, the merger is the end
        if (this._crossfeedInitialized && this._crossfeedMerger) {
            return this._crossfeedMerger;
        }
        // Otherwise fall back to preamp, last filter, or source
        return this._eqPreampGain ||
               (this._eqFilters && this._eqFilters[this._eqFilters.length - 1]) ||
               this._eqSourceNode;
    }

    /**
     * Switch the AudioContext latency mode by recreating the audio pipeline.
     * This causes a brief audio interruption but allows changing latencyHint.
     * @param {'interactive'|'playback'} latencyHint - Desired latency mode
     * @returns {Promise<AudioNode|null>} The analyser node if interactive mode, null otherwise
     */
    async switchLatencyMode(latencyHint, forceRebuild = false) {
        if (latencyHint === currentLatencyMode && this._audioContext && !forceRebuild) {
            // Already in desired mode
            if (latencyHint === 'interactive') {
                // Return existing analyser, or create one if needed
                if (this.audio._visualizerAnalyser) {
                    return this.audio._visualizerAnalyser;
                }
                // Create analyser for interactive mode (e.g., EQ init ran before visualizer)
                const analyser = this._audioContext.createAnalyser();
                analyser.fftSize = 4096;
                analyser.smoothingTimeConstant = 0.85;
                this.insertAnalyser(analyser);
                return analyser;
            }
            return null;
        }

        currentLatencyMode = latencyHint;

        // Save current playback state
        const wasPlaying = this.store.state.isPlaying;
        const currentTime = this.audio.currentTime;
        const currentSrc = this.audio.src;
        const currentVolume = this.audio.volume;
        const currentMuted = this.audio.muted;

        // Save EQ state before cleanup
        const wasParametricMode = this._isParametricMode;
        const savedParametricBands = this._parametricBands;
        const savedParametricPreamp = this._parametricPreamp;

        // Save dual pipeline state
        const savedPrimaryIndex = this._primaryIndex;
        const wasDualPipelineActive = this._dualPipelineActive;

        // Pause current playback
        this.audio.pause();

        // Clean up old audio context and nodes
        if (this._eqFilters) {
            this._eqFilters.forEach(filter => {
                try { filter.disconnect(); } catch (e) {}
            });
            this._eqFilters = null;
        }
        if (this._eqPreampGain) {
            try { this._eqPreampGain.disconnect(); } catch (e) {}
            this._eqPreampGain = null;
        }

        // Clean up dual pipeline nodes
        if (this._audioSources[0]) {
            try { this._audioSources[0].disconnect(); } catch (e) {}
        }
        if (this._audioSources[1]) {
            try { this._audioSources[1].disconnect(); } catch (e) {}
        }
        this._audioSources = [null, null];

        if (this._replayGainNodes[0]) {
            try { this._replayGainNodes[0].disconnect(); } catch (e) {}
        }
        if (this._replayGainNodes[1]) {
            try { this._replayGainNodes[1].disconnect(); } catch (e) {}
        }
        this._replayGainNodes = [null, null];

        if (this._fadeGains[0]) {
            try { this._fadeGains[0].disconnect(); } catch (e) {}
        }
        if (this._fadeGains[1]) {
            try { this._fadeGains[1].disconnect(); } catch (e) {}
        }
        this._fadeGains = [null, null];

        if (this._mixerGain) {
            try { this._mixerGain.disconnect(); } catch (e) {}
            this._mixerGain = null;
        }

        if (this._eqSourceNode) {
            try { this._eqSourceNode.disconnect(); } catch (e) {}
            this._eqSourceNode = null;
        }

        if (this._audioContext) {
            try { await this._audioContext.close(); } catch (e) {}
            this._audioContext = null;
        }

        // Reset crossfeed, loudness, and noise state (nodes are invalid after context close)
        this._crossfeedInitialized = false;
        this._crossfeedInternalConnected = false;
        this._loudnessInitialized = false;
        this._loudnessInternalConnected = false;
        this._noiseInitialized = false;
        this._noiseWorklet = null;
        this._noiseScriptProcessor = null;
        this._noiseLowFilter = null;
        this._noiseHighFilter = null;
        this._noiseMerger = null;
        this._dualPipelineActive = false;

        // Create fresh audio elements for both slots
        this._audioElements[0] = new Audio();
        this._audioElements[0].volume = currentVolume;
        this._audioElements[0].muted = currentMuted;
        this._audioElements[1] = new Audio();
        this._audioElements[1].volume = currentVolume;
        this._audioElements[1].muted = currentMuted;

        this.audio = this._audioElements[savedPrimaryIndex];
        this.preloadAudio = this._audioElements[1 - savedPrimaryIndex];

        // Set up event listeners on both new elements
        this._setupEventListeners(this._audioElements[0]);
        this._setupEventListeners(this._audioElements[1]);

        // Create new AudioContext with desired latency
        this._audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint });
        this._eqOutputNode = this._audioContext.destination;

        // Determine chain input based on crossfade mode
        let chainInputNode;

        if (this.store.state.crossfadeEnabled) {
            // Dual mode: set up mixer pipeline
            this._initDualAudioPipeline();
            this._ensureSourceConnected(savedPrimaryIndex);
            chainInputNode = this._mixerGain;

            // Store primary source for backward compatibility
            this._eqSourceNode = this._audioSources[savedPrimaryIndex];
        } else {
            // Simple mode: direct source connection
            this._eqSourceNode = this._audioContext.createMediaElementSource(this.audio);
            chainInputNode = this._eqSourceNode;

            // Store on audio element for visualizer reuse
            this.audio._visualizerContext = this._audioContext;
            this.audio._visualizerSource = this._eqSourceNode;
        }

        // Initialize noise if enabled (must happen before EQ chain build)
        if (this.store.state.noiseEnabled) {
            await this._initNoise();
        }

        // Restore EQ state - either parametric or graphic
        if (wasParametricMode && savedParametricBands && savedParametricBands.length > 0) {
            // Restore parametric EQ
            this.setParametricEQ(savedParametricBands, savedParametricPreamp || 0);
        } else {
            // Restore graphic EQ
            this._eqFilters = EQ_BANDS.map((freq, i) => {
                const filter = this._audioContext.createBiquadFilter();
                const isShelf = i === 0 || i === 9;
                filter.type = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking';
                filter.frequency.value = freq;
                if (!isShelf) {
                    filter.Q.value = 1.4;
                }
                filter.gain.value = this.store.state.eqEnabled ? this.store.state.eqGains[i] : 0;
                return filter;
            });

            // Chain: chainInput -> loudness -> filters -> crossfeed -> noise -> destination
            let lastNode = this._connectLoudness(chainInputNode);
            for (const filter of this._eqFilters) {
                lastNode.connect(filter);
                lastNode = filter;
            }
            // Insert crossfeed into chain
            lastNode = this._connectCrossfeed(lastNode) || lastNode;
            // Insert noise into chain
            lastNode = this._connectNoise(lastNode);
            lastNode.connect(this._eqOutputNode);
        }

        // Resume context if suspended
        if (this._audioContext.state === 'suspended') {
            await this._audioContext.resume();
        }

        // Restore playback
        if (currentSrc) {
            this.audio.src = currentSrc;
            this.audio.currentTime = currentTime;
            if (wasPlaying) {
                await this.audio.play();
            }
        }

        // Notify visualizers that the pipeline has been rebuilt
        this._notifyAudioSourceChange();

        // If interactive mode, create and return analyser for visualizer
        if (latencyHint === 'interactive') {
            const analyser = this._audioContext.createAnalyser();
            analyser.fftSize = 4096;
            analyser.smoothingTimeConstant = 0.85;
            this.insertAnalyser(analyser);
            return analyser;
        }

        return null;
    }

    /**
     * Set the low latency always setting and apply it.
     * @param {boolean} enabled - Whether to always use low latency mode
     */
    async setLowLatencyAlways(enabled) {
        // Save to localStorage
        try {
            localStorage.setItem(LOW_LATENCY_MODE_KEY, enabled);
        } catch (e) {}

        // If audio context exists and setting changed, recreate it with new latency
        if (this._audioContext) {
            const currentLatencyHint = this._audioContext.baseLatency < 0.02 ? 'interactive' : 'playback';
            const newLatencyHint = enabled ? 'interactive' : 'playback';

            // Only recreate if different (and not currently in visualizer mode)
            if (currentLatencyHint !== newLatencyHint && !this.audio._visualizerAnalyser) {
                await this.switchLatencyMode(newLatencyHint);
            }
        }
    }

    /**
     * Ensure the audio pipeline is initialized.
     * Uses switchLatencyMode as the single code path for pipeline creation.
     * This handles all features: crossfade, loudness, crossfeed, noise, EQ.
     */
    async _ensureAudioPipeline() {
        if (this._audioContext) return;

        // Use switchLatencyMode as the single unified pipeline builder
        const lowLatencyEnabled = loadLowLatencySetting();
        const latencyHint = lowLatencyEnabled ? 'interactive' : 'playback';
        await this.switchLatencyMode(latencyHint, true);
    }

    /**
     * @deprecated Use _ensureAudioPipeline() instead.
     * Kept for compatibility - just calls the async version fire-and-forget.
     */
    _autoInitEQ() {
        if (this._audioContext) return;
        this._ensureAudioPipeline().catch(e => console.error('Failed to initialize audio pipeline:', e));
    }

    /**
     * Calculate preamp for parametric EQ bands based on combined frequency response peak.
     * Creates a temporary AudioContext if needed.
     */
    _calculatePEQPreamp(bands) {
        if (!bands || bands.length === 0) return 0;

        // Create temporary AudioContext for calculation
        let tempContext = this._audioContext;
        let createdTemp = false;
        if (!tempContext) {
            try {
                tempContext = new (window.AudioContext || window.webkitAudioContext)();
                createdTemp = true;
            } catch (e) {
                // Fallback to simple max gain if no AudioContext
                const maxGain = bands.reduce((max, band) => {
                    if (['peaking', 'lowshelf', 'highshelf'].includes(band.type) && band.gain > 0) {
                        return Math.max(max, band.gain);
                    }
                    return max;
                }, 0);
                return maxGain > 0 ? -maxGain : 0;
            }
        }

        // Calculate combined frequency response
        const numPoints = 256;
        const minFreq = 20;
        const maxFreq = 20000;
        const logMin = Math.log10(minFreq);
        const logMax = Math.log10(maxFreq);

        // Generate log-spaced frequencies
        const frequencies = new Float32Array(numPoints);
        for (let i = 0; i < numPoints; i++) {
            const logFreq = logMin + (i / (numPoints - 1)) * (logMax - logMin);
            frequencies[i] = Math.pow(10, logFreq);
        }

        // Combined magnitude in dB
        const combinedMag = new Float32Array(numPoints).fill(0);

        for (const band of bands) {
            const filter = tempContext.createBiquadFilter();
            filter.type = band.type;
            filter.frequency.value = band.frequency;
            filter.gain.value = band.gain;
            if (['peaking', 'notch', 'bandpass', 'allpass', 'lowpass', 'highpass'].includes(band.type)) {
                filter.Q.value = band.q || 1.0;
            }

            const magResponse = new Float32Array(numPoints);
            const phaseResponse = new Float32Array(numPoints);
            filter.getFrequencyResponse(frequencies, magResponse, phaseResponse);

            for (let i = 0; i < numPoints; i++) {
                combinedMag[i] += 20 * Math.log10(magResponse[i]);
            }
        }

        // Clean up temporary context
        if (createdTemp) {
            tempContext.close().catch(() => {});
        }

        // Find peak of combined response
        let peakDb = 0;
        for (let i = 0; i < numPoints; i++) {
            if (combinedMag[i] > peakDb) {
                peakDb = combinedMag[i];
            }
        }

        // Round to 0.1 dB precision
        return peakDb > 0 ? -Math.ceil(peakDb * 10) / 10 : 0;
    }

    // ==================== AUDIO FX METHODS ====================

    /**
     * Save current audio FX settings to localStorage.
     */
    _saveAudioFXSettings() {
        saveAudioFXSettings({
            crossfeedEnabled: this.store.state.crossfeedEnabled,
            crossfeedLevel: this.store.state.crossfeedLevel,
            crossfeedDelayMs: this.store.state.crossfeedDelayMs,
            crossfeedShadowHz: this.store.state.crossfeedShadowHz,
            gaplessEnabled: this.store.state.gaplessEnabled,
            crossfadeEnabled: this.store.state.crossfadeEnabled,
            crossfadeDuration: this.store.state.crossfadeDuration,
            tempoEnabled: this.store.state.tempoEnabled,
            tempoRate: this.store.state.tempoRate,
            tempoPitchLock: this.store.state.tempoPitchLock,
            loudnessEnabled: this.store.state.loudnessEnabled,
            loudnessReferenceSPL: this.store.state.loudnessReferenceSPL,
            loudnessStrength: this.store.state.loudnessStrength,
            sleepTimerMode: this.store.state.sleepTimerMode,
            sleepTimerMinutes: this.store.state.sleepTimerMinutes,
            sleepTimerTargetTime: this.store.state.sleepTimerTargetTime,
            sleepTimerMinimumMinutes: this.store.state.sleepTimerMinimumMinutes,
            noiseEnabled: this.store.state.noiseEnabled,
            noiseMode: this.store.state.noiseMode,
            noiseTilt: this.store.state.noiseTilt,
            noisePower: this.store.state.noisePower,
            noiseThreshold: this.store.state.noiseThreshold,
            noiseAttack: this.store.state.noiseAttack
        });
    }

    // ==================== DUAL-AUDIO PIPELINE METHODS ====================

    /**
     * Initialize the dual-audio pipeline for crossfade support.
     * Creates: fade gain nodes, mixer gain node.
     * Audio elements already exist (created in constructor for gapless preloading).
     * Called when crossfade is enabled.
     */
    _initDualAudioPipeline() {
        if (this._dualPipelineActive) return;
        if (!this._audioContext) return;

        // HTML5 volume handles user volume (same on both elements)
        const vol = this.store.state.muted ? 0 : this.store.state.volume;
        this._audioElements[0].volume = vol;
        this._audioElements[1].volume = vol;

        // Update preloadAudio alias to point to non-primary element
        this.preloadAudio = this._audioElements[1 - this._primaryIndex];

        // Create mixer gain node that combines both sources
        this._mixerGain = this._audioContext.createGain();
        this._mixerGain.gain.value = 1.0;

        // Create ReplayGain nodes for per-source volume normalization
        // Chain: source → replayGainNode → fadeGain → mixer
        this._replayGainNodes[0] = this._audioContext.createGain();
        this._replayGainNodes[1] = this._audioContext.createGain();

        // Set initial ReplayGain values (per-track normalization only, not user volume)
        const primaryRgLinear = this._calculateReplayGainLinear(this.store.state.currentSong);
        this._replayGainNodes[this._primaryIndex].gain.value = primaryRgLinear;
        this._replayGainNodes[1 - this._primaryIndex].gain.value = 1.0;  // Secondary starts silent anyway

        // Create fade gain nodes for both audio sources
        this._fadeGains[0] = this._audioContext.createGain();
        this._fadeGains[1] = this._audioContext.createGain();

        // Initial state: primary at full volume, secondary silent
        this._fadeGains[this._primaryIndex].gain.value = 1.0;
        this._fadeGains[1 - this._primaryIndex].gain.value = 0.0;

        // Connect: replayGainNodes → fadeGains → mixer
        this._replayGainNodes[0].connect(this._fadeGains[0]);
        this._replayGainNodes[1].connect(this._fadeGains[1]);
        this._fadeGains[0].connect(this._mixerGain);
        this._fadeGains[1].connect(this._mixerGain);

        this._dualPipelineActive = true;
    }

    /**
     * Safely reset a gain node's value, handling active curves.
     * The Web Audio API's setValueCurveAtTime creates a "hold" on the parameter
     * that prevents other events from being added. This method works around that
     * by disconnecting and reconnecting the gain node if needed.
     * @param {GainNode} gainNode - The gain node to reset
     * @param {number} targetValue - Target gain value (0 or 1)
     */
    _safeResetGain(gainNode, targetValue) {
        if (!gainNode || !this._audioContext) return;

        try {
            // Cancel all scheduled events
            gainNode.gain.cancelScheduledValues(0);
            // Try setValueAtTime first (fastest)
            gainNode.gain.setValueAtTime(targetValue, this._audioContext.currentTime);
        } catch (e1) {
            // If that fails, try setTargetAtTime (can sometimes work during curves)
            try {
                gainNode.gain.setTargetAtTime(targetValue, this._audioContext.currentTime, 0.001);
            } catch (e2) {
                // Last resort: directly set the value property
                // This works but may cause a click/pop
                try {
                    gainNode.gain.value = targetValue;
                } catch (e3) {
                    // If even that fails, recreate the gain node connection
                    console.warn('_safeResetGain: all methods failed, recreating gain node');
                    this._recreateGainNode(gainNode, targetValue);
                }
            }
        }
    }

    /**
     * Recreate a gain node's connections to reset it completely.
     * Used as a last resort when gain automation is stuck.
     */
    _recreateGainNode(oldGainNode, targetValue) {
        if (!this._audioContext || !this._dualPipelineActive) return;

        // Find which index this gain node is
        const index = this._fadeGains.indexOf(oldGainNode);
        if (index === -1) return;

        this._forceRecreateGainAtIndex(index, targetValue);
    }

    /**
     * Force-recreate a gain node at the specified index.
     * This bypasses all AudioParam manipulation and creates a fresh node.
     * Use when an active setValueCurveAtTime has locked the AudioParam.
     */
    _forceRecreateGainAtIndex(index, targetValue) {
        if (!this._audioContext || !this._dualPipelineActive) return;
        if (index < 0 || index >= this._fadeGains.length) return;

        const oldGainNode = this._fadeGains[index];

        try {
            // Create new gain node with the desired value
            const newGain = this._audioContext.createGain();
            newGain.gain.value = targetValue;

            // Disconnect old gain node (don't let errors stop us)
            try {
                oldGainNode.disconnect();
            } catch (e) {
                // Ignore disconnect errors
            }

            // Reconnect audio source to new gain
            if (this._audioSources[index]) {
                try {
                    this._audioSources[index].disconnect();
                } catch (e) {
                    // Ignore disconnect errors
                }
                this._audioSources[index].connect(newGain);
            }

            // Connect new gain to mixer
            if (this._mixerGain) {
                newGain.connect(this._mixerGain);
            }

            // Replace in array
            this._fadeGains[index] = newGain;
        } catch (e) {
            console.error('_forceRecreateGainAtIndex failed:', e);
        }
    }

    /**
     * Reset both gain nodes to default state (primary=1, secondary=0).
     * Uses force recreation if a crossfade is in progress (gains may be locked).
     */
    _resetAllGains() {
        if (!this._dualPipelineActive) return;

        if (this._crossfadeInProgress) {
            // During active crossfade, gains are locked by setValueCurveAtTime.
            // Must force-recreate to escape the lock.
            this._forceRecreateGainAtIndex(this._primaryIndex, 1.0);
            this._forceRecreateGainAtIndex(1 - this._primaryIndex, 0);
        } else {
            // No active crossfade - safe methods should work
            this._safeResetGain(this._fadeGains[this._primaryIndex], 1.0);
            this._safeResetGain(this._fadeGains[1 - this._primaryIndex], 0);
        }
    }

    /**
     * Ensure a MediaElementSourceNode is connected for the specified audio element.
     * Creates the source node lazily if needed.
     * @param {number} index - Audio element index (0 or 1)
     * @returns {boolean} True if source is connected, false on failure
     */
    _ensureSourceConnected(index) {
        if (!this._audioContext || !this._dualPipelineActive) return false;
        if (!this._audioElements[index]) return false;

        // Already connected?
        if (this._audioSources[index]) return true;

        try {
            const audioEl = this._audioElements[index];
            this._audioSources[index] = this._audioContext.createMediaElementSource(audioEl);
            // Connect: source → replayGainNode (replayGainNode → fadeGain already connected)
            this._audioSources[index].connect(this._replayGainNodes[index]);

            // Store reference for visualizer compatibility if this is the primary
            if (index === this._primaryIndex) {
                audioEl._visualizerContext = this._audioContext;
                audioEl._visualizerSource = this._audioSources[index];
            }
            return true;
        } catch (e) {
            console.error(`Failed to create source for audio element ${index}:`, e);
            return false;
        }
    }

    /**
     * Perform crossfade using equal-power curve for constant perceived loudness.
     * Uses setValueCurveAtTime with pre-computed cos/sin values.
     * This ensures primary² + secondary² ≈ 1 throughout the crossfade.
     * @param {number} duration - Crossfade duration in seconds
     * @returns {Promise<void>} Resolves when crossfade is complete
     */
    async _performCrossfadeWithRamp(duration, fadeOutIndex, fadeInIndex) {
        if (!this._dualPipelineActive || !this._audioContext) {
            throw new Error('Dual pipeline not active');
        }

        // Generate equal-power crossfade curves
        // Fade out: cos(0 to π/2) = 1.0 to 0.0
        // Fade in: sin(0 to π/2) = 0.0 to 1.0
        const steps = Math.max(100, Math.floor(duration * 50)); // ~50 steps per second
        const fadeOutCurve = new Float32Array(steps);
        const fadeInCurve = new Float32Array(steps);

        for (let i = 0; i < steps; i++) {
            const t = i / (steps - 1); // 0 to 1
            const angle = t * Math.PI / 2; // 0 to π/2
            fadeOutCurve[i] = Math.cos(angle);
            fadeInCurve[i] = Math.sin(angle);
        }

        // Try to set up the crossfade. If gain nodes are locked from a previous
        // interrupted crossfade, recreate them and try again.
        let attempts = 0;
        while (attempts < 2) {
            attempts++;
            const fadeOutGain = this._fadeGains[fadeOutIndex];
            const fadeInGain = this._fadeGains[fadeInIndex];
            const currentTime = this._audioContext.currentTime;

            try {
                // Cancel any scheduled changes
                fadeOutGain.gain.cancelScheduledValues(0);
                fadeInGain.gain.cancelScheduledValues(0);

                // Set initial values and apply curves (use small offset to avoid timing conflicts)
                const startTime = currentTime + 0.005;
                fadeOutGain.gain.setValueAtTime(1.0, currentTime);
                fadeInGain.gain.setValueAtTime(0.0, currentTime);
                fadeOutGain.gain.setValueCurveAtTime(fadeOutCurve, startTime, duration);
                fadeInGain.gain.setValueCurveAtTime(fadeInCurve, startTime, duration);
                break; // Success
            } catch (e) {
                if (attempts < 2) {
                    // Gain nodes are locked - recreate them and retry
                    console.log('Crossfade setup failed, recreating gain nodes:', e.message);
                    this._forceRecreateGainAtIndex(fadeOutIndex, 1.0);
                    this._forceRecreateGainAtIndex(fadeInIndex, 0);
                } else {
                    throw e; // Rethrow on second failure
                }
            }
        }

        // Wait for crossfade to complete
        return new Promise(resolve => {
            setTimeout(() => {
                // Clamp final values using safe method to handle any edge cases.
                // Use indices to get fresh references in case gains were recreated.
                this._safeResetGain(this._fadeGains[fadeOutIndex], 0);
                this._safeResetGain(this._fadeGains[fadeInIndex], 1.0);
                resolve();
            }, duration * 1000 + 50);  // Small buffer for timing accuracy
        });
    }

    /**
     * Swap which audio element is considered primary.
     * Called after crossfade completes.
     */
    _swapPrimaryAudio() {
        const oldPrimaryIndex = this._primaryIndex;
        const newPrimaryIndex = 1 - this._primaryIndex;

        // Update primary index and aliases BEFORE stopping old element
        // This ensures event listeners from old element are ignored
        this._primaryIndex = newPrimaryIndex;
        this.audio = this._audioElements[newPrimaryIndex];
        this.preloadAudio = this._audioElements[oldPrimaryIndex];

        // Now stop and clear old primary (its events will be ignored)
        this._audioElements[oldPrimaryIndex].pause();
        this._audioElements[oldPrimaryIndex].src = '';

        // Update visualizer references to point to new primary
        if (this._audioSources[newPrimaryIndex]) {
            this.audio._visualizerContext = this._audioContext;
            this.audio._visualizerSource = this._audioSources[newPrimaryIndex];
        }

        // Event listeners already set up on both elements in constructor
        // Guards ensure only active element's events update state

        // Notify audio source listeners (e.g., visualizers that need to reconnect)
        this._notifyAudioSourceChange();
    }

    /**
     * Increment source version and notify all registered callbacks.
     * Called when primary audio source changes (e.g., after crossfade).
     */
    _notifyAudioSourceChange() {
        this._audioSourceVersion++;
        const source = this.audio._visualizerSource;
        const context = this.audio._visualizerContext;
        for (const callback of this._audioSourceCallbacks) {
            try {
                callback(source, context);
            } catch (e) {
                console.error('Audio source callback error:', e);
            }
        }
    }

    /**
     * Subscribe to audio source changes.
     * Callback receives (source, context) when primary audio source changes.
     * @param {Function} callback - Called when source changes
     * @returns {Function} Unsubscribe function
     */
    onAudioSourceChange(callback) {
        this._audioSourceCallbacks.push(callback);
        return () => {
            const index = this._audioSourceCallbacks.indexOf(callback);
            if (index !== -1) {
                this._audioSourceCallbacks.splice(index, 1);
            }
        };
    }

    /**
     * Get current audio source version (to detect changes).
     * @returns {number} Current source version
     */
    getAudioSourceVersion() {
        return this._audioSourceVersion;
    }

    /**
     * Get the audio node that visualizers should connect to.
     * Returns the combined pipeline input (mixer when crossfade enabled, source otherwise).
     * This is the node BEFORE EQ/crossfeed processing - visualizers see raw mixed audio.
     * @returns {AudioNode|null} The audio node for visualizer connection
     */
    getVisualizerInputNode() {
        if (!this._audioContext) return null;

        // When dual pipeline is active, use the mixer output (combined from both elements)
        if (this._dualPipelineActive && this._mixerGain) {
            return this._mixerGain;
        }

        // Simple mode - use the source node
        return this._eqSourceNode || null;
    }

    /**
     * Tear down the dual pipeline and return to simple mode.
     * Called when crossfade is disabled.
     */
    _teardownDualPipeline() {
        if (!this._dualPipelineActive) return;

        // Disconnect and clear secondary source
        const secondaryIndex = 1 - this._primaryIndex;
        if (this._audioSources[secondaryIndex]) {
            try { this._audioSources[secondaryIndex].disconnect(); } catch (e) {}
            this._audioSources[secondaryIndex] = null;
        }

        // Stop and clear secondary audio element
        if (this._audioElements[secondaryIndex]) {
            this._audioElements[secondaryIndex].pause();
            this._audioElements[secondaryIndex].src = '';
        }

        // Disconnect ReplayGain nodes, fade gains and mixer
        if (this._replayGainNodes[0]) {
            try { this._replayGainNodes[0].disconnect(); } catch (e) {}
        }
        if (this._replayGainNodes[1]) {
            try { this._replayGainNodes[1].disconnect(); } catch (e) {}
        }
        if (this._fadeGains[0]) {
            try { this._fadeGains[0].disconnect(); } catch (e) {}
        }
        if (this._fadeGains[1]) {
            try { this._fadeGains[1].disconnect(); } catch (e) {}
        }
        if (this._mixerGain) {
            try { this._mixerGain.disconnect(); } catch (e) {}
        }

        // Clear references
        this._replayGainNodes = [null, null];
        this._fadeGains = [null, null];
        this._mixerGain = null;
        this._dualPipelineActive = false;

        // Restore HTML5 volume control (simple mode uses audio.volume)
        this._applyReplayGain();

        // Ensure primary source is disconnected from old fade gain
        if (this._audioSources[this._primaryIndex]) {
            try { this._audioSources[this._primaryIndex].disconnect(); } catch (e) {}
        }
    }

    /**
     * Get the input node for the EQ chain.
     * Returns mixer if dual pipeline active, otherwise the primary source.
     * @returns {AudioNode|null} The node to connect to EQ filters
     */
    _getChainInputNode() {
        if (this._dualPipelineActive && this._mixerGain) {
            return this._mixerGain;
        }
        return this._eqSourceNode;
    }

    /**
     * Initialize stereo image audio nodes using mid-side processing.
     * Based on: https://iwalton.com/stereo-img-test/
     * Level -100 = mono, 0 = normal, +100 = wide stereo
     */
    _initCrossfeed() {
        if (!this._audioContext || this._crossfeedInitialized) return;

        // Create splitter and merger for stereo processing
        this._crossfeedSplitter = this._audioContext.createChannelSplitter(2);
        this._crossfeedMerger = this._audioContext.createChannelMerger(2);

        // Create 4 gain nodes for the matrix mixing:
        // L_out = L*gainLL + R*gainRL
        // R_out = L*gainLR + R*gainRR
        this._crossfeedLL = this._audioContext.createGain();  // L to L
        this._crossfeedRL = this._audioContext.createGain();  // R to L
        this._crossfeedLR = this._audioContext.createGain();  // L to R
        this._crossfeedRR = this._audioContext.createGain();  // R to R

        // Delay nodes for cross-channel paths (ITD simulation)
        this._crossfeedDelayLR = this._audioContext.createDelay(0.01);  // max 10ms
        this._crossfeedDelayRL = this._audioContext.createDelay(0.01);

        // Head shadow filters - low-pass to simulate high-frequency attenuation around head
        this._crossfeedShadowLR = this._audioContext.createBiquadFilter();
        this._crossfeedShadowLR.type = 'lowpass';
        this._crossfeedShadowLR.Q.value = 0.707;  // Butterworth response
        this._crossfeedShadowRL = this._audioContext.createBiquadFilter();
        this._crossfeedShadowRL.type = 'lowpass';
        this._crossfeedShadowRL.Q.value = 0.707;

        this._crossfeedInitialized = true;
        this._updateCrossfeedDelay();
        this._updateCrossfeedShadow();
        this._updateCrossfeedGains();
    }

    /**
     * Update stereo image gains based on current level using mid-side processing.
     * Formula from reference: mix_apb = (0.5 - stimg*0.5) * 0.6, mix_amb = (0.5 + stimg*0.5) * 0.6
     * Level -100 = mono (all mid), 0 = normal, +100 = wide (all side)
     */
    _updateCrossfeedGains() {
        if (!this._crossfeedInitialized) return;

        const enabled = this.store.state.crossfeedEnabled;
        // Convert -100 to +100 → -1 to +1
        const stimg = this.store.state.crossfeedLevel / 100;

        if (!enabled) {
            // Bypass: unity gain, no mixing
            this._crossfeedLL.gain.value = 1.0;
            this._crossfeedRR.gain.value = 1.0;
            this._crossfeedRL.gain.value = 0;
            this._crossfeedLR.gain.value = 0;
            return;
        }

        // Mid-side mixing formula from reference
        // mix_apb = mid gain, mix_amb = side gain
        const mix_apb = (0.5 - stimg * 0.5) * 0.6;
        const mix_amb = (0.5 + stimg * 0.5) * 0.6;

        // Matrix coefficients derived from mid-side expansion:
        // L_out = (L+R)*mix_apb + (L-R)*mix_amb = L*(mix_apb+mix_amb) + R*(mix_apb-mix_amb)
        // R_out = (L+R)*mix_apb - (L-R)*mix_amb = L*(mix_apb-mix_amb) + R*(mix_apb+mix_amb)
        const directGain = mix_apb + mix_amb;  // Same channel (L->L, R->R)
        const crossGain = mix_apb - mix_amb;   // Cross channel (R->L, L->R)

        this._crossfeedLL.gain.value = directGain;
        this._crossfeedRR.gain.value = directGain;
        this._crossfeedRL.gain.value = crossGain;
        this._crossfeedLR.gain.value = crossGain;
    }

    /**
     * Connect crossfeed nodes into the audio chain.
     * Call after EQ is initialized.
     * @param {AudioNode} inputNode - Node to connect from (e.g., EQ output)
     * @returns {AudioNode} Output node to connect to destination
     */
    _connectCrossfeed(inputNode) {
        if (!this._crossfeedInitialized) {
            this._initCrossfeed();
        }

        if (!this._crossfeedInitialized) {
            return inputNode;  // Fallback if init failed
        }

        // Static connections only need to be done once
        if (!this._crossfeedInternalConnected) {
            // L channel (index 0) -> LL and LR gains
            this._crossfeedSplitter.connect(this._crossfeedLL, 0);  // L -> L path
            this._crossfeedSplitter.connect(this._crossfeedLR, 0);  // L -> R path

            // R channel (index 1) -> RL and RR gains
            this._crossfeedSplitter.connect(this._crossfeedRL, 1);  // R -> L path
            this._crossfeedSplitter.connect(this._crossfeedRR, 1);  // R -> R path

            // Direct paths (no processing) - these never change
            this._crossfeedLL.connect(this._crossfeedMerger, 0, 0);  // LL -> L output
            this._crossfeedRR.connect(this._crossfeedMerger, 0, 1);  // RR -> R output

            this._crossfeedInternalConnected = true;
        }

        // Connect cross-channel paths (dynamic based on delay/shadow settings)
        this._reconnectCrossfeedCrossChannels();

        // Connect input to splitter (this can change when EQ chain is rebuilt)
        inputNode.connect(this._crossfeedSplitter);

        return this._crossfeedMerger;
    }

    /**
     * Reconnect cross-channel paths based on current delay/shadow settings.
     * Bypasses delay nodes when delay=0, bypasses shadow filters when shadow=0.
     * Chain: gain -> [delay] -> [shadow] -> merger
     */
    _reconnectCrossfeedCrossChannels() {
        if (!this._crossfeedInitialized) return;

        const useDelay = this.store.state.crossfeedDelayMs > 0;
        const useShadow = this.store.state.crossfeedShadowHz > 0;

        // Disconnect all cross-channel paths first
        try {
            this._crossfeedRL.disconnect();
            this._crossfeedLR.disconnect();
            this._crossfeedDelayRL.disconnect();
            this._crossfeedDelayLR.disconnect();
            this._crossfeedShadowRL.disconnect();
            this._crossfeedShadowLR.disconnect();
        } catch (e) {
            // Nodes may not be connected yet
        }

        // Reconnect based on current settings
        // RL path (R -> L output)
        if (useDelay && useShadow) {
            // gain -> delay -> shadow -> merger
            this._crossfeedRL.connect(this._crossfeedDelayRL);
            this._crossfeedDelayRL.connect(this._crossfeedShadowRL);
            this._crossfeedShadowRL.connect(this._crossfeedMerger, 0, 0);
        } else if (useDelay) {
            // gain -> delay -> merger
            this._crossfeedRL.connect(this._crossfeedDelayRL);
            this._crossfeedDelayRL.connect(this._crossfeedMerger, 0, 0);
        } else if (useShadow) {
            // gain -> shadow -> merger
            this._crossfeedRL.connect(this._crossfeedShadowRL);
            this._crossfeedShadowRL.connect(this._crossfeedMerger, 0, 0);
        } else {
            // gain -> merger (bypass all)
            this._crossfeedRL.connect(this._crossfeedMerger, 0, 0);
        }

        // LR path (L -> R output)
        if (useDelay && useShadow) {
            this._crossfeedLR.connect(this._crossfeedDelayLR);
            this._crossfeedDelayLR.connect(this._crossfeedShadowLR);
            this._crossfeedShadowLR.connect(this._crossfeedMerger, 0, 1);
        } else if (useDelay) {
            this._crossfeedLR.connect(this._crossfeedDelayLR);
            this._crossfeedDelayLR.connect(this._crossfeedMerger, 0, 1);
        } else if (useShadow) {
            this._crossfeedLR.connect(this._crossfeedShadowLR);
            this._crossfeedShadowLR.connect(this._crossfeedMerger, 0, 1);
        } else {
            this._crossfeedLR.connect(this._crossfeedMerger, 0, 1);
        }
    }

    /**
     * Set crossfeed enabled state.
     */
    async setCrossfeedEnabled(enabled) {
        this.store.state.crossfeedEnabled = enabled;

        // Initialize pipeline if needed (crossfeed needs the audio graph)
        if (enabled && !this._audioContext) {
            // Use unified pipeline builder and wait for completion
            await this._ensureAudioPipeline();
        }

        this._updateCrossfeedGains();
        this._saveAudioFXSettings();
    }

    /**
     * Set crossfeed level (-100 to +100).
     * Positive: crossfeed (narrows stereo)
     * Negative: stereo widening (enhances separation)
     */
    setCrossfeedLevel(level) {
        this.store.state.crossfeedLevel = Math.max(-100, Math.min(100, level));
        this._updateCrossfeedGains();
        this._saveAudioFXSettings();
    }

    /**
     * Update crossfeed delay nodes with current delay setting.
     */
    _updateCrossfeedDelay() {
        if (!this._crossfeedDelayLR || !this._crossfeedDelayRL) return;
        const delaySec = this.store.state.crossfeedDelayMs / 1000;
        this._crossfeedDelayLR.delayTime.value = delaySec;
        this._crossfeedDelayRL.delayTime.value = delaySec;
    }

    /**
     * Update crossfeed shadow filter frequency.
     */
    _updateCrossfeedShadow() {
        if (!this._crossfeedShadowLR || !this._crossfeedShadowRL) return;
        const hz = this.store.state.crossfeedShadowHz;
        // When enabled, set the cutoff frequency
        // When disabled (0), we bypass entirely via reconnection
        if (hz > 0) {
            this._crossfeedShadowLR.frequency.value = hz;
            this._crossfeedShadowRL.frequency.value = hz;
        }
    }

    /**
     * Set crossfeed delay in milliseconds (0-5ms).
     * Simulates inter-aural time difference (ITD) for speaker simulation.
     */
    setCrossfeedDelay(ms) {
        const wasZero = this.store.state.crossfeedDelayMs === 0;
        const newValue = Math.max(0, Math.min(5, ms));
        const isZero = newValue === 0;
        this.store.state.crossfeedDelayMs = newValue;
        this._updateCrossfeedDelay();
        // Reconnect if crossing zero boundary (for performance bypass)
        if (wasZero !== isZero) {
            this._reconnectCrossfeedCrossChannels();
        }
        this._saveAudioFXSettings();
    }

    /**
     * Set crossfeed head shadow filter frequency (0=off, 500-3000Hz).
     * Simulates high-frequency attenuation as sound travels around the head.
     */
    setCrossfeedShadow(hz) {
        const wasZero = this.store.state.crossfeedShadowHz === 0;
        const newValue = hz <= 0 ? 0 : Math.max(500, Math.min(3000, hz));
        const isZero = newValue === 0;
        this.store.state.crossfeedShadowHz = newValue;
        this._updateCrossfeedShadow();
        // Reconnect if crossing zero boundary (for performance bypass)
        if (wasZero !== isZero) {
            this._reconnectCrossfeedCrossChannels();
        }
        this._saveAudioFXSettings();
    }

    /**
     * Apply a crossfeed preset with typical speaker simulation values.
     * Crossfeed mixes opposite channels (L→R, R→L) to simulate speaker listening.
     * Negative level = more crossfeed (more mid/blended), matching traditional crossfeed.
     * Presets based on speaker ANGLE, not room size - wider angle = more delay/shadow.
     * @param {string} preset - 'narrow', 'medium', 'wide', or 'off'
     */
    setCrossfeedPreset(preset) {
        const presets = {
            off: { level: 0, delay: 0, shadow: 0 },
            narrow: { level: -25, delay: 0.25, shadow: 2500 },     // ~30° angle
            medium: { level: -35, delay: 0.4, shadow: 1500 },      // ~60° angle
            wide: { level: -45, delay: 0.65, shadow: 1000 }        // ~90° angle
        };
        const p = presets[preset];
        if (!p) return;

        // Apply all settings
        this.store.state.crossfeedLevel = p.level;
        this.store.state.crossfeedDelayMs = p.delay;
        this.store.state.crossfeedShadowHz = p.shadow;

        // Update audio nodes
        this._updateCrossfeedGains();
        this._updateCrossfeedDelay();
        this._updateCrossfeedShadow();
        this._reconnectCrossfeedCrossChannels();
        this._saveAudioFXSettings();
    }

    // ==================== LOUDNESS COMPENSATION METHODS ====================

    /**
     * Initialize loudness compensation audio nodes.
     * Creates: user volume gain node, low shelf filter, high shelf filter.
     */
    _initLoudness() {
        if (!this._audioContext || this._loudnessInitialized) return;

        // User volume gain - replaces HTML5 audio.volume when loudness enabled
        this._userVolumeGain = this._audioContext.createGain();
        this._userVolumeGain.gain.value = 1.0;

        // Low shelf filter at 100Hz for bass boost
        this._loudnessLowShelf = this._audioContext.createBiquadFilter();
        this._loudnessLowShelf.type = 'lowshelf';
        this._loudnessLowShelf.frequency.value = 100;
        this._loudnessLowShelf.gain.value = 0;

        // High shelf filter at 10kHz for treble boost
        this._loudnessHighShelf = this._audioContext.createBiquadFilter();
        this._loudnessHighShelf.type = 'highshelf';
        this._loudnessHighShelf.frequency.value = 10000;
        this._loudnessHighShelf.gain.value = 0;

        this._loudnessInitialized = true;
        this._updateLoudnessGains();
    }

    /**
     * Update loudness compensation filter gains based on current volume.
     * Uses ISO 226 equal-loudness contour approximation.
     */
    _updateLoudnessGains() {
        if (!this._loudnessInitialized) return;

        const state = this.store.state;

        // If loudness disabled or muted, set filters to passthrough
        if (!state.loudnessEnabled || state.muted || state.volume === 0) {
            this._loudnessLowShelf.gain.value = 0;
            this._loudnessHighShelf.gain.value = 0;
            // When disabled, user volume gain should be 1.0 (HTML5 volume controls)
            if (!state.loudnessEnabled) {
                this._userVolumeGain.gain.value = 1.0;
            } else {
                // Muted with loudness enabled
                this._userVolumeGain.gain.value = 0;
            }
            return;
        }

        // Apply user volume via the gain node (provides headroom for loudness boost)
        this._userVolumeGain.gain.value = state.volume;

        // Ensure HTML5 volume is at full scale (headroom for loudness boost)
        this._audioElements[0].volume = 1.0;
        this._audioElements[1].volume = 1.0;

        // Calculate volume in dB
        const volumeDb = 20 * Math.log10(state.volume);  // 0dB at 100%, -6dB at 50%, -12dB at 25%

        // Calculate effective SPL at current volume
        const effectiveSPL = state.loudnessReferenceSPL + volumeDb;

        // ISO 226-inspired compensation (simplified)
        // At 80 phon: 0dB compensation
        // At 40 phon: +12dB bass, +6dB treble
        // Linear interpolation between
        const phon = Math.max(20, effectiveSPL);
        const compensationFactor = Math.max(0, (80 - phon) / 40);  // 0 at 80 phon, 1 at 40 phon

        // Apply strength multiplier
        const strength = state.loudnessStrength / 100;
        const bassBoost = compensationFactor * 12 * strength;    // Up to +12dB
        const trebleBoost = compensationFactor * 6 * strength;   // Up to +6dB

        this._loudnessLowShelf.gain.value = bassBoost;
        this._loudnessHighShelf.gain.value = trebleBoost;
    }

    /**
     * Connect loudness compensation nodes into the audio chain.
     * Chain: input → userVolumeGain → lowShelf → highShelf → output
     * @param {AudioNode} inputNode - Node to connect from (e.g., mixer or source)
     * @returns {AudioNode} Output node to connect to next stage (e.g., EQ)
     */
    _connectLoudness(inputNode) {
        if (!this._loudnessInitialized) {
            this._initLoudness();
        }

        if (!this._loudnessInitialized) {
            return inputNode;  // Fallback if init failed
        }

        // Internal connections only need to be done once
        if (!this._loudnessInternalConnected) {
            this._userVolumeGain.connect(this._loudnessLowShelf);
            this._loudnessLowShelf.connect(this._loudnessHighShelf);
            this._loudnessInternalConnected = true;
        }

        // Connect input to volume gain (this can change when chain is rebuilt)
        inputNode.connect(this._userVolumeGain);

        return this._loudnessHighShelf;
    }

    /**
     * Set loudness compensation enabled state.
     * Triggers audio chain rebuild to add/remove loudness nodes.
     */
    async setLoudnessEnabled(enabled) {
        const wasEnabled = this.store.state.loudnessEnabled;
        this.store.state.loudnessEnabled = enabled;

        // Initialize or rebuild pipeline
        if (wasEnabled !== enabled) {
            if (this._audioContext) {
                // Rebuild pipeline - this creates/connects the loudness nodes
                await this.switchLatencyMode(currentLatencyMode, true);
            } else if (enabled) {
                // No context yet - use unified pipeline builder
                await this._ensureAudioPipeline();
            }
        }

        // Now that loudness nodes exist, update gains and HTML5 volume
        this._updateLoudnessGains();
        this._applyReplayGain();

        this._saveAudioFXSettings();
    }

    /**
     * Set loudness reference SPL (60-90 dB).
     * What SPL does 100% volume produce on user's device?
     * Lower = headphones/quiet, Higher = speakers/loud
     */
    setLoudnessReferenceSPL(spl) {
        this.store.state.loudnessReferenceSPL = Math.max(60, Math.min(90, spl));
        this._updateLoudnessGains();
        this._saveAudioFXSettings();
    }

    /**
     * Set loudness strength (0-150%).
     * Intensity multiplier for the compensation effect.
     */
    setLoudnessStrength(strength) {
        this.store.state.loudnessStrength = Math.max(0, Math.min(150, strength));
        this._updateLoudnessGains();
        this._saveAudioFXSettings();
    }

    // ==================== COMFORT NOISE METHODS ====================

    /**
     * Initialize the comfort noise audio nodes.
     * Creates: noise generator (AudioWorklet or ScriptProcessor) with RMS detection, color filters.
     * The worklet/processor analyzes music input and generates noise when audio is quiet.
     */
    async _initNoise() {
        if (!this._audioContext || this._noiseInitialized) return;

        // Try AudioWorklet first (runs on audio thread, works when page is backgrounded)
        try {
            await this._audioContext.audioWorklet.addModule('./noise-processor.js');
            // numberOfInputs: 1 for receiving music to analyze
            // numberOfOutputs: 1 for noise output
            this._noiseWorklet = new AudioWorkletNode(this._audioContext, 'noise-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2]
            });
        } catch (e) {
            console.warn('AudioWorklet not supported for noise, using ScriptProcessor fallback:', e);
            // Fallback to ScriptProcessorNode (deprecated but widely supported)
            // 2 input channels (stereo music), 2 output channels (stereo noise)
            this._noiseScriptProcessor = this._audioContext.createScriptProcessor(4096, 2, 2);

            // ScriptProcessor state
            let currentNoiseLevel = 0;
            let thresholdLinear = Math.pow(10, this.store.state.noiseThreshold / 20);
            let powerLinear = Math.pow(10, this.store.state.noisePower / 20);
            let attackMs = this.store.state.noiseAttack;
            let enabled = this.store.state.noiseEnabled;
            let isPlaying = this.store.state.isPlaying;

            // Store reference for settings updates
            this._noiseScriptProcessor._updateSettings = (settings) => {
                if (settings.threshold !== undefined) {
                    thresholdLinear = Math.pow(10, settings.threshold / 20);
                }
                if (settings.power !== undefined) {
                    powerLinear = Math.pow(10, settings.power / 20);
                }
                if (settings.attack !== undefined) {
                    attackMs = settings.attack;
                }
                if (settings.enabled !== undefined) {
                    enabled = settings.enabled;
                }
                if (settings.isPlaying !== undefined) {
                    isPlaying = settings.isPlaying;
                }
            };

            this._noiseScriptProcessor.onaudioprocess = (e) => {
                const inputL = e.inputBuffer.getChannelData(0);
                const inputR = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : inputL;
                const outputL = e.outputBuffer.getChannelData(0);
                const outputR = e.outputBuffer.numberOfChannels > 1 ? e.outputBuffer.getChannelData(1) : outputL;

                // If disabled or not playing, fade out
                if (!enabled || !isPlaying) {
                    for (let i = 0; i < outputL.length; i++) {
                        currentNoiseLevel *= 0.999;
                        outputL[i] = (Math.random() * 2 - 1) * currentNoiseLevel;
                        outputR[i] = (Math.random() * 2 - 1) * currentNoiseLevel;
                    }
                    return;
                }

                // Calculate RMS from input
                let sum = 0;
                for (let i = 0; i < inputL.length; i++) {
                    sum += inputL[i] * inputL[i] + inputR[i] * inputR[i];
                }
                const rms = Math.sqrt(sum / (inputL.length * 2));

                // Determine target noise level
                let targetNoiseLevel = 0;
                if (thresholdLinear >= 1.0) {
                    targetNoiseLevel = powerLinear;
                } else if (rms < thresholdLinear) {
                    const fadeRange = thresholdLinear * 0.5;
                    const fadeAmount = Math.min(1, (thresholdLinear - rms) / fadeRange);
                    targetNoiseLevel = fadeAmount * powerLinear;
                }

                // Smooth transition based on attack time
                // Block time = 4096 / 48000 ≈ 0.0853 seconds
                const blockTime = 4096 / 48000;
                const smoothing = 1 - Math.exp(-blockTime / (attackMs / 1000));
                currentNoiseLevel += (targetNoiseLevel - currentNoiseLevel) * smoothing;

                // Generate noise
                for (let i = 0; i < outputL.length; i++) {
                    outputL[i] = (Math.random() * 2 - 1) * currentNoiseLevel;
                    outputR[i] = (Math.random() * 2 - 1) * currentNoiseLevel;
                }
            };
        }

        // Low frequency filter - controls bass/brown noise character
        this._noiseLowFilter = this._audioContext.createBiquadFilter();
        this._noiseLowFilter.type = 'lowshelf';
        this._noiseLowFilter.frequency.value = 100;
        this._noiseLowFilter.gain.value = 0;

        // High frequency filter - controls treble/blue noise character
        this._noiseHighFilter = this._audioContext.createBiquadFilter();
        this._noiseHighFilter.type = 'highshelf';
        this._noiseHighFilter.frequency.value = 3000;
        this._noiseHighFilter.gain.value = 0;

        // Merger node to combine music + filtered noise
        this._noiseMerger = this._audioContext.createGain();
        this._noiseMerger.gain.value = 1.0;

        // Connect noise chain: generator -> lowFilter -> highFilter -> merger
        const noiseSource = this._noiseWorklet || this._noiseScriptProcessor;
        if (noiseSource) {
            noiseSource.connect(this._noiseLowFilter);
            this._noiseLowFilter.connect(this._noiseHighFilter);
            this._noiseHighFilter.connect(this._noiseMerger);
        }

        this._noiseInitialized = true;
        this._updateNoiseFilters();

        // Send initial settings to worklet
        this._sendNoiseSettings({
            threshold: this.store.state.noiseThreshold,
            power: this.store.state.noisePower,
            attack: this.store.state.noiseAttack,
            enabled: this.store.state.noiseEnabled,
            isPlaying: this.store.state.isPlaying
        });
    }

    /**
     * Connect noise to the audio output chain.
     * Sends music to worklet/processor for RMS analysis, merges noise with music.
     * @param {AudioNode} musicEndNode - The final node of the music chain
     * @returns {AudioNode} The merger node (new chain end), or musicEndNode if noise disabled
     */
    _connectNoise(musicEndNode) {
        if (!this._noiseInitialized || !this._noiseMerger) {
            return musicEndNode;
        }

        const noiseSource = this._noiseWorklet || this._noiseScriptProcessor;

        // Connect music to merger (passthrough) and to noise processor (for RMS analysis)
        musicEndNode.connect(this._noiseMerger);
        if (noiseSource) {
            musicEndNode.connect(noiseSource);
        }

        return this._noiseMerger;
    }

    /**
     * Update noise filters based on noiseMode and noiseTilt.
     *
     * White mode: Flat spectrum at tilt=0, brown-ish at -100, blue-ish at +100
     * Grey mode: Perceptually flat (inverse A-weighted) at tilt=0, then tilts from there
     *
     * Tilt maps to low/high shelf gains:
     * - Negative tilt: boost bass, cut treble (darker/warmer)
     * - Positive tilt: cut bass, boost treble (brighter/airier)
     */
    _updateNoiseFilters() {
        if (!this._noiseLowFilter || !this._noiseHighFilter) return;

        const tilt = this.store.state.noiseTilt;  // -100 to +100
        const mode = this.store.state.noiseMode;  // 'white' or 'grey'

        // Calculate base gains from tilt
        // Brown noise (-6dB/octave) needs significant low boost and high cut
        // At tilt -100: low=+24, high=-18 (deep brown)
        // At tilt 0: low=0, high=0 (flat white)
        // At tilt +100: low=-18, high=+18 (bright blue/violet)
        let lowGain = -tilt * 0.24;   // -100 -> +24, 0 -> 0, +100 -> -24
        let highGain = tilt * 0.18;   // -100 -> -18, 0 -> 0, +100 -> +18

        // Grey mode applies INVERSE A-weighting to compensate for human hearing
        // Based on equal-loudness contours, grey noise needs:
        // - Strong bass boost (~+15-20dB at 100Hz relative to 1kHz)
        // - Reduction in the 2-4kHz range where ears are most sensitive
        // - Slight rolloff at very high frequencies
        if (mode === 'grey') {
            lowGain += 18;   // Strong bass boost for perceptual flatness
            highGain -= 10;  // Cut highs/mids where ears are sensitive
        }

        // Clamp to filter range (extended to ±24 for deeper coloring)
        lowGain = Math.max(-24, Math.min(24, lowGain));
        highGain = Math.max(-24, Math.min(24, highGain));

        this._noiseLowFilter.gain.value = lowGain;
        this._noiseHighFilter.gain.value = highGain;
    }

    /**
     * Set noise mode ('white' or 'grey').
     * White: Flat spectrum at tilt=0
     * Grey: Perceptually flat (A-weighted) at tilt=0
     * Changing mode resets tilt to center.
     */
    async setNoiseMode(mode) {
        if (mode !== 'white' && mode !== 'grey') return;
        this.store.state.noiseMode = mode;
        this.store.state.noiseTilt = 0;  // Reset tilt when changing mode
        await this._ensureNoiseInitialized();
        this._updateNoiseFilters();
        this._saveAudioFXSettings();
    }

    /**
     * Send settings to the noise worklet/processor.
     * Used to update threshold, power, enabled, and isPlaying state.
     * @param {Object} settings - Settings to send
     */
    _sendNoiseSettings(settings) {
        if (this._noiseWorklet) {
            this._noiseWorklet.port.postMessage(settings);
        } else if (this._noiseScriptProcessor && this._noiseScriptProcessor._updateSettings) {
            this._noiseScriptProcessor._updateSettings(settings);
        }
    }

    /**
     * Set noise enabled state.
     * Triggers audio chain rebuild to add/remove noise nodes.
     */
    async setNoiseEnabled(enabled) {
        this.store.state.noiseEnabled = enabled;

        if (enabled) {
            if (!this._audioContext) {
                // No context yet - use unified pipeline builder (handles noise init)
                await this._ensureAudioPipeline();
            } else if (!this._noiseInitialized) {
                // Rebuild pipeline - switchLatencyMode will init noise with correct context
                await this.switchLatencyMode(currentLatencyMode, true);
            }
        }

        // Notify worklet of enabled state change
        this._sendNoiseSettings({ enabled });

        this._saveAudioFXSettings();
    }

    /**
     * Ensure noise is initialized if it's supposed to be enabled.
     * This handles cases where the audio context was recreated but noise state is still true.
     */
    async _ensureNoiseInitialized() {
        if (this.store.state.noiseEnabled && !this._noiseInitialized) {
            if (!this._audioContext) {
                await this._ensureAudioPipeline();
            } else {
                // Rebuild pipeline to properly connect noise nodes
                await this.switchLatencyMode(currentLatencyMode, true);
            }
        }
    }

    /**
     * Set noise tilt (-100 to +100).
     * Negative = darker/warmer (more bass), Positive = brighter/airier (more treble)
     */
    async setNoiseTilt(tilt) {
        this.store.state.noiseTilt = Math.max(-100, Math.min(100, tilt));
        await this._ensureNoiseInitialized();
        this._updateNoiseFilters();
        this._saveAudioFXSettings();
    }

    /**
     * Set noise power level (-60 to 0 dB).
     */
    async setNoisePower(power) {
        const clampedPower = Math.max(-60, Math.min(0, power));
        this.store.state.noisePower = clampedPower;
        await this._ensureNoiseInitialized();
        this._sendNoiseSettings({ power: clampedPower });
        this._saveAudioFXSettings();
    }

    /**
     * Set noise threshold (-60 to 0 dB).
     * When music RMS drops below this level, noise fades in.
     * 0 = always on (constant noise mixing).
     */
    async setNoiseThreshold(threshold) {
        const clampedThreshold = Math.max(-60, Math.min(0, threshold));
        this.store.state.noiseThreshold = clampedThreshold;
        await this._ensureNoiseInitialized();
        this._sendNoiseSettings({ threshold: clampedThreshold });
        this._saveAudioFXSettings();
    }

    /**
     * Set noise attack time (25 to 2000 ms, log scale).
     * Controls how quickly noise fades in/out.
     * 25ms = instant (original behavior), 2000ms = 2 second fade.
     */
    async setNoiseAttack(attack) {
        const clampedAttack = Math.max(25, Math.min(2000, attack));
        this.store.state.noiseAttack = clampedAttack;
        await this._ensureNoiseInitialized();
        this._sendNoiseSettings({ attack: clampedAttack });
        this._saveAudioFXSettings();
    }

    // ==================== TEMPO METHODS ====================

    /**
     * Set tempo enabled state.
     */
    setTempoEnabled(enabled) {
        this.store.state.tempoEnabled = enabled;
        this._applyTempo();
        this._saveAudioFXSettings();
    }

    /**
     * Set tempo rate (0.5 to 2.0).
     */
    setTempoRate(rate) {
        this.store.state.tempoRate = Math.max(0.5, Math.min(2.0, rate));
        this._applyTempo();
        this._saveAudioFXSettings();
    }

    /**
     * Set pitch lock mode (when enabled, uses playbackRate; note: true pitch lock requires SoundTouch).
     */
    setTempoPitchLock(enabled) {
        this.store.state.tempoPitchLock = enabled;
        this._applyTempo();
        this._saveAudioFXSettings();
    }

    /**
     * Apply current tempo settings to audio element.
     * Note: playbackRate changes both tempo and pitch together.
     * True pitch-preserving tempo change requires SoundTouch library.
     */
    _applyTempo() {
        if (!this.audio) return;

        if (this.store.state.tempoEnabled) {
            this.audio.playbackRate = this.store.state.tempoRate;
            // preservesPitch is the web standard (only affects playbackRate)
            // When true: browser attempts to preserve pitch (limited quality)
            // When false: pitch changes with tempo (like vinyl)
            this.audio.preservesPitch = this.store.state.tempoPitchLock;
        } else {
            this.audio.playbackRate = 1.0;
            this.audio.preservesPitch = true;
        }

        // Update media session position state with new playback rate
        this._updateMediaSessionPosition();
    }

    // ==================== GAPLESS/CROSSFADE METHODS ====================

    /**
     * Set gapless playback enabled.
     */
    setGaplessEnabled(enabled) {
        this.store.state.gaplessEnabled = enabled;
        this._saveAudioFXSettings();
    }

    /**
     * Set crossfade enabled.
     * This triggers a pipeline rebuild to add/remove the mixer node.
     */
    async setCrossfadeEnabled(enabled) {
        const wasEnabled = this.store.state.crossfadeEnabled;
        this.store.state.crossfadeEnabled = enabled;

        // Crossfade overrides gapless
        if (enabled) {
            this.store.state.gaplessEnabled = false;
        }

        // Initialize or rebuild pipeline
        if (wasEnabled !== enabled) {
            if (this._audioContext) {
                // Use full teardown/rebuild via switchLatencyMode for reliability
                await this.switchLatencyMode(currentLatencyMode, true);
            } else if (enabled) {
                // No context yet - use unified pipeline builder
                await this._ensureAudioPipeline();
            }
        }

        this._saveAudioFXSettings();
    }

    /**
     * Set crossfade duration in seconds.
     */
    setCrossfadeDuration(duration) {
        this.store.state.crossfadeDuration = Math.max(1, Math.min(12, duration));
        this._saveAudioFXSettings();
    }

    /**
     * Check if crossfade should start based on current playback position.
     */
    _checkCrossfade() {
        // Don't trigger crossfade if disabled, already in progress, or seek lockout is active
        // Seek lockout prevents repeated triggers when user drags seek slider through crossfade zone
        if (!this.store.state.crossfadeEnabled || this._crossfadeInProgress || this._crossfadeSeekLockout) return;

        const duration = this.audio.duration;
        const currentTime = this.audio.currentTime;
        const crossfadeDuration = this.store.state.crossfadeDuration;

        // Don't crossfade if duration unknown or track too short
        if (!duration || isNaN(duration) || duration < crossfadeDuration * 2) return;

        // Check if we're within crossfade range of the end
        const timeRemaining = duration - currentTime;
        // Need at least 1 second to load next track, otherwise let normal track-end handling take over
        const minTimeForCrossfade = 1.0;
        if (timeRemaining <= crossfadeDuration && timeRemaining >= minTimeForCrossfade) {
            // Set lockout to prevent repeated triggers from seek slider dragging
            this._crossfadeSeekLockout = true;
            this._startCrossfade();
        }
    }

    /**
     * Start crossfade transition to next track.
     * Uses the dual-audio pipeline for smooth crossfade through the Web Audio API.
     */
    async _startCrossfade() {
        if (this._crossfadeInProgress) return;

        // Set flag immediately to prevent concurrent calls from rapid timeupdate events
        // (e.g., when user drags seek slider through crossfade zone)
        this._crossfadeInProgress = true;

        // Helper to reset state on early return
        const resetAndReturn = () => {
            this._crossfadeInProgress = false;
            this._crossfadeSeekLockout = false;
        };

        // Check sleep timer - if expired, don't crossfade to next song
        // Let current song finish and _handleTrackEnd will check again
        if (this._checkSleepTimerAndMaybeSleep()) {
            resetAndReturn();
            return;
        }

        // Ensure dual pipeline is active - initialize if needed
        if (!this._dualPipelineActive) {
            if (!this._audioContext) {
                // No context yet - build the full pipeline
                console.log('Crossfade: initializing audio pipeline');
                await this._ensureAudioPipeline();
            } else if (this.store.state.crossfadeEnabled && !this._dualPipelineActive) {
                // Context exists but dual pipeline not set up - need to rebuild
                console.log('Crossfade: rebuilding pipeline for dual mode');
                await this.switchLatencyMode(currentLatencyMode, true);
            }

            // Check again after initialization
            if (!this._dualPipelineActive) {
                console.warn('Crossfade requested but dual pipeline not active after init attempt');
                resetAndReturn();
                return;
            }
        }

        // Get next track
        const { queue, queueIndex, repeatMode, shuffle } = this.store.state;
        let nextIndex;

        // Handle repeat-one mode - crossfade to same track
        if (repeatMode === 'one') {
            nextIndex = queueIndex;
        } else if (shuffle && queue.length > 1) {
            // Handle shuffle mode (must pick next before saving history)
            // Pick a random index different from current
            const availableIndices = [];
            for (let i = 0; i < queue.length; i++) {
                if (i !== queueIndex) {
                    availableIndices.push(i);
                }
            }
            nextIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
        } else {
            // Normal sequential mode
            nextIndex = queueIndex + 1;

            if (nextIndex >= queue.length) {
                if (repeatMode === 'all') {
                    nextIndex = 0;
                } else {
                    resetAndReturn();
                    return; // No next track to crossfade to
                }
            }
        }

        // Record current song to play history (fire-and-forget)
        const currentSong = queue[queueIndex];
        if (currentSong?.uuid) {
            const duration = this.playStartTime
                ? Math.floor((Date.now() - this.playStartTime) / 1000)
                : 0;
            history.record(
                currentSong.uuid,
                duration,
                false,
                this.store.state.scaEnabled ? 'radio' : 'browse'
            ).catch(e => console.error('Failed to record history:', e));
        }

        // In shuffle mode, save current song UUID to shuffle history for back button
        if (shuffle && currentSong?.uuid) {
            this._shuffleHistory.push(currentSong.uuid);
            if (this._shuffleHistory.length > this._shuffleHistoryMaxSize) {
                this._shuffleHistory.shift();
            }
            saveShuffleHistory(this._shuffleHistory);
        }

        const nextSong = queue[nextIndex];
        if (!nextSong) {
            resetAndReturn();
            return;
        }

        this._crossfadeSkipRamp = false;  // Reset flag - may be set by _handleTrackEnd if song ends during load
        const secondaryIndex = 1 - this._primaryIndex;
        const secondaryAudio = this._audioElements[secondaryIndex];

        try {
            // Get URL for next track
            let audioUrl = await getAudioUrl(nextSong.uuid);
            if (!audioUrl && offlineStore.state.isOnline && !offlineStore.state.workOfflineMode) {
                audioUrl = getStreamUrl(nextSong.uuid, nextSong.type);
            }
            if (!audioUrl) {
                const trackEndedDuringCrossfade = this._crossfadeSkipRamp;
                this._crossfadeInProgress = false;
                this._crossfadeSkipRamp = false;
                this._crossfadeSeekLockout = false;
                // If track ended during crossfade, try to continue with next song
                if (trackEndedDuringCrossfade) {
                    this.next({ userInitiated: false });
                }
                return;
            }

            // Set up secondary audio for crossfade
            secondaryAudio.src = audioUrl;
            // Set HTML5 volume appropriately based on loudness mode
            // When loudness is enabled, user volume is controlled via _userVolumeGain
            // and HTML5 volume should stay at 1.0 to provide headroom for loudness boost
            if (this.store.state.loudnessEnabled && this._loudnessInitialized) {
                secondaryAudio.volume = 1.0;
            } else {
                secondaryAudio.volume = this.store.state.muted ? 0 : this.store.state.volume;
            }

            // Apply tempo settings to secondary audio
            if (this.store.state.tempoEnabled) {
                secondaryAudio.playbackRate = this.store.state.tempoRate;
                secondaryAudio.preservesPitch = this.store.state.tempoPitchLock;
            }

            // Wait for secondary audio to be ready
            await new Promise((resolve, reject) => {
                const onCanPlay = () => {
                    secondaryAudio.removeEventListener('canplay', onCanPlay);
                    secondaryAudio.removeEventListener('error', onError);
                    resolve();
                };
                const onError = (e) => {
                    secondaryAudio.removeEventListener('canplay', onCanPlay);
                    secondaryAudio.removeEventListener('error', onError);
                    reject(e);
                };
                secondaryAudio.addEventListener('canplay', onCanPlay);
                secondaryAudio.addEventListener('error', onError);
                secondaryAudio.load();
            });

            // Ensure secondary source is connected to the pipeline
            if (!this._ensureSourceConnected(secondaryIndex)) {
                console.error('Failed to connect secondary audio source');
                const trackEndedDuringCrossfade = this._crossfadeSkipRamp;
                this._crossfadeInProgress = false;
                this._crossfadeSkipRamp = false;
                this._crossfadeSeekLockout = false;
                // If track ended during crossfade, try to continue with next song
                if (trackEndedDuringCrossfade) {
                    this.next({ userInitiated: false });
                }
                return;
            }

            // Apply ReplayGain to the secondary audio's gain node BEFORE playing
            // This ensures the next song fades in with correct volume normalization
            this._updateReplayGainNode(secondaryIndex, nextSong);

            // Start playing the next track (audio goes through fade gain which is at 0)
            await secondaryAudio.play();

            // IMMEDIATELY switch audio reference so event guards work correctly
            // This prevents old element's pause/ended events from corrupting state
            const oldPrimaryIndex = this._primaryIndex;
            this._primaryIndex = secondaryIndex;
            this.audio = this._audioElements[secondaryIndex];
            this.preloadAudio = this._audioElements[oldPrimaryIndex];

            // Update state to reflect new song (UI updates during crossfade)
            this.store.state.currentSong = nextSong;
            this.store.state.queueIndex = nextIndex;
            this.store.state.currentTime = 0;
            this.store.state.duration = nextSong.duration_seconds || secondaryAudio.duration || 0;
            this.store.state.isPlaying = true;
            this.store.state.isPaused = false;
            this.playStartTime = Date.now();

            // Update media session immediately so lock screen shows correct song
            this._updateMediaSessionMetadata(nextSong);

            // Update visualizer references
            if (this._audioSources[secondaryIndex]) {
                this.audio._visualizerContext = this._audioContext;
                this.audio._visualizerSource = this._audioSources[secondaryIndex];
            }

            // Check if old song ended during loading - skip ramp if so
            if (this._crossfadeSkipRamp) {
                // Old song already ended - immediately set new song to full volume.
                // Force-recreate gains in case there's a lingering curve from a previous crossfade.
                this._forceRecreateGainAtIndex(secondaryIndex, 1.0);
                this._forceRecreateGainAtIndex(oldPrimaryIndex, 0);
                this._completeCrossfade(nextSong, nextIndex);
                return;
            }

            // Perform equal-power crossfade using Web Audio gain nodes
            // Pass indices explicitly: old element fades out, new element fades in
            const crossfadeDuration = this.store.state.crossfadeDuration;
            await this._performCrossfadeWithRamp(crossfadeDuration, oldPrimaryIndex, secondaryIndex);

            // Check if crossfade was cancelled during the ramp
            if (!this._crossfadeInProgress) {
                // Don't cleanup secondaryAudio here - after early swap it's this.audio
                // and may already be playing a different song (from next()/previous()).
                // _cancelCrossfade() already handled proper cleanup.
                return;
            }

            // Crossfade complete - swap audio elements
            this._completeCrossfade(nextSong, nextIndex);

        } catch (e) {
            console.error('Crossfade failed:', e);
            const trackEndedDuringCrossfade = this._crossfadeSkipRamp;
            this._crossfadeInProgress = false;
            this._crossfadeSkipRamp = false;
            this._crossfadeSeekLockout = false;

            // Force-recreate gain nodes on error - they may be locked by a partially
            // executed curve that we can't cancel via normal AudioParam methods
            this._forceRecreateGainAtIndex(this._primaryIndex, 1.0);
            this._forceRecreateGainAtIndex(secondaryIndex, 0);

            // If track ended during crossfade load, _handleTrackEnd returned early
            // trusting crossfade to handle transition. Since it failed, play next song.
            if (trackEndedDuringCrossfade) {
                console.log('Crossfade failed after track ended, playing next');
                this.next({ userInitiated: false });
            }
        }
    }

    /**
     * Complete the crossfade transition.
     * Reference swap already happened at crossfade start - just clean up old element.
     */
    _completeCrossfade(nextSong, nextIndex) {
        // Stop and clear the old element (now preloadAudio after early swap)
        this.preloadAudio.pause();
        this.preloadAudio.src = '';

        // Notify visualizer of source change
        this._notifyAudioSourceChange();

        // Apply replay gain for new track
        this._applyReplayGain();

        // Sync index to server (fire-and-forget, skip in temp queue mode)
        if (this.store.state.tempQueueMode) {
            this._saveTempQueueState().catch(e => console.error('Failed to save temp queue state:', e));
        } else {
            queueApi.setIndex(nextIndex).catch(e => console.error('Failed to sync queue index:', e));
        }

        // Preload the next track
        this._preloadNext();

        this._crossfadeInProgress = false;
        this._crossfadeSeekLockout = false;
    }

    /**
     * Reconnect the audio pipeline to the current audio element.
     * Used after crossfade swaps audio elements.
     */
    _reconnectAudioSource() {
        if (!this._audioContext) return;

        try {
            // Disconnect old source
            if (this._eqSourceNode) {
                try { this._eqSourceNode.disconnect(); } catch (e) {}
            }

            // Create new source from current audio element
            this._eqSourceNode = this._audioContext.createMediaElementSource(this.audio);

            // Store on audio element for visualizer reuse
            this.audio._visualizerContext = this._audioContext;
            this.audio._visualizerSource = this._eqSourceNode;

            // Reset crossfeed internal connections (will be rebuilt on next connect)
            this._crossfeedInternalConnected = false;

            // Rebuild the chain based on current EQ mode
            if (this._isParametricMode && this._parametricBands) {
                // Parametric EQ mode - rebuild with stored bands
                this.setParametricEQ(this._parametricBands, this._parametricPreamp || 0);
            } else if (this._eqFilters && this._eqFilters.length > 0) {
                // Graphic EQ mode - reconnect with loudness before filters
                let lastNode = this._connectLoudness(this._eqSourceNode);
                for (const filter of this._eqFilters) {
                    lastNode.connect(filter);
                    lastNode = filter;
                }
                // Insert crossfeed and connect to output
                if (this._eqPreampGain) {
                    lastNode.connect(this._eqPreampGain);
                    lastNode = this._connectCrossfeed(this._eqPreampGain) || this._eqPreampGain;
                } else {
                    lastNode = this._connectCrossfeed(lastNode) || lastNode;
                }
                // Insert noise into chain
                lastNode = this._connectNoise(lastNode);
                lastNode.connect(this._eqOutputNode);
            } else {
                // No EQ - connect source through loudness, crossfeed, and noise
                const loudnessOut = this._connectLoudness(this._eqSourceNode);
                const crossfeedOut = this._connectCrossfeed(loudnessOut) || loudnessOut;
                const noiseOut = this._connectNoise(crossfeedOut);
                noiseOut.connect(this._eqOutputNode);
            }
        } catch (e) {
            console.error('Failed to reconnect audio source:', e);
        }
    }

    /**
     * Cancel any in-progress crossfade.
     * Stops the inactive audio element and resets gains based on which element
     * this.audio currently points to (handles both pre and post early-swap states).
     */
    _cancelCrossfade() {
        if (this._crossfadeInProgress) {
            this._crossfadeInProgress = false;
            this._crossfadeSeekLockout = false;

            // Find which index corresponds to this.audio (may have changed due to early swap)
            const activeIndex = this._audioElements.indexOf(this.audio);
            if (activeIndex === -1) {
                console.error('_cancelCrossfade: this.audio not found in _audioElements');
                return;
            }
            const inactiveIndex = 1 - activeIndex;

            // Stop and clear the inactive audio element
            const inactiveAudio = this._audioElements[inactiveIndex];
            if (inactiveAudio) {
                inactiveAudio.pause();
                inactiveAudio.src = '';
            }

            // Sync _primaryIndex to match the active audio element
            this._primaryIndex = activeIndex;

            // Force-recreate gain nodes to escape setValueCurveAtTime lock.
            // During an active crossfade, the gains are locked by curves and
            // cannot be reset via any AudioParam method - only recreation works.
            this._forceRecreateGainAtIndex(activeIndex, 1.0);
            this._forceRecreateGainAtIndex(inactiveIndex, 0);
        }
    }

    // ==================== SLEEP TIMER METHODS ====================

    /**
     * Set sleep timer mode ('duration' or 'time').
     */
    setSleepTimerMode(mode) {
        this.store.state.sleepTimerMode = mode;
        this._saveAudioFXSettings();
    }

    /**
     * Set sleep timer duration in minutes (0 = disabled).
     */
    setSleepTimerMinutes(minutes) {
        this.store.state.sleepTimerMinutes = Math.max(0, Math.min(180, minutes));
        this._saveAudioFXSettings();
    }

    /**
     * Set sleep timer target time (HH:MM format).
     */
    setSleepTimerTargetTime(time) {
        this.store.state.sleepTimerTargetTime = time;
        this._saveAudioFXSettings();
    }

    /**
     * Set sleep timer minimum minutes (guaranteed playback after target time).
     */
    setSleepTimerMinimumMinutes(minutes) {
        this.store.state.sleepTimerMinimumMinutes = Math.max(0, Math.min(180, minutes));
        this._saveAudioFXSettings();
    }

    /**
     * Calculate the end time for the sleep timer in "time" mode.
     *
     * Logic: stopTime = max(target, now + minimum)
     * - Ensures at least minimum playback time
     * - But stops at target if you've already played longer than minimum
     *
     * The "6-hour rule": If target time passed less than 6 hours ago, we're still
     * in the "sleep window" for tonight. If more than 6 hours passed, assume
     * the user is setting up for tomorrow night.
     *
     * Examples with 0:00 target, 45min minimum:
     * - 8pm start → stop at 0:00 (already exceeds 45min by midnight)
     * - 11:30pm start → stop at 0:15am (11:30 + 45min)
     * - 0:00 start → stop at 0:45am (0:00 + 45min)
     * - 0:05am start → stop at 0:50am (still in sleep window, 0:05 + 45min)
     * - 10am start → stop at tomorrow 0:00 (outside sleep window)
     *
     * @returns {Date|null} The end time, or null for indefinite playback
     */
    _calculateTargetEndTime() {
        const targetTimeStr = this.store.state.sleepTimerTargetTime;
        const minimumMinutes = this.store.state.sleepTimerMinimumMinutes;

        if (!targetTimeStr) return null;

        const now = new Date();
        const [hours, mins] = targetTimeStr.split(':').map(Number);

        // Create target time for today
        let target = new Date();
        target.setHours(hours, mins, 0, 0);

        // If target already passed today, check if we're still in the "sleep window"
        // (within 6 hours of target) or if this is for tomorrow
        if (target <= now) {
            const hoursSinceTarget = (now - target) / (1000 * 60 * 60);
            if (hoursSinceTarget >= 6) {
                // More than 6 hours since target - use tomorrow's target
                // (User is setting up for tomorrow night)
                target.setDate(target.getDate() + 1);
            }
            // If < 6 hours, keep target as-is (in the past)
            // This allows the max() logic below to work correctly
        }

        // If no minimum set
        if (minimumMinutes <= 0) {
            // If target is in the past (within sleep window), allow indefinite playback
            if (target <= now) {
                return null;
            }
            return target;
        }

        // Calculate now + minimum
        const minimumEnd = new Date(now.getTime() + minimumMinutes * 60 * 1000);

        // Return max(target, now + minimum)
        // This ensures at least minimum playback, but stops at target if we've exceeded minimum
        return minimumEnd > target ? minimumEnd : target;
    }

    /**
     * Calculate minutes until target time (simple version for backward compatibility).
     * Returns the number of minutes until the target time, accounting for next day if needed.
     */
    _calculateMinutesToTargetTime() {
        const endTime = this._calculateTargetEndTime();
        if (!endTime) return 0;  // Indefinite

        const now = new Date();
        return Math.max(0, Math.floor((endTime - now) / (60 * 1000)));
    }

    /**
     * Start the sleep timer. Only active when app is in background.
     * @returns {boolean} True if timer was started, false if indefinite playback (no timer)
     */
    startSleepTimer() {
        if (this.store.state.sleepTimerMode === 'time') {
            const endTime = this._calculateTargetEndTime();
            if (!endTime) {
                // Indefinite playback - no timer needed
                this.store.state.sleepTimerEndTime = null;
                return false;
            }
            this.store.state.sleepTimerEndTime = endTime.getTime();
        } else {
            const minutes = this.store.state.sleepTimerMinutes;
            if (minutes <= 0) return false;
            this.store.state.sleepTimerEndTime = Date.now() + (minutes * 60 * 1000);
        }

        this._setupSleepTimerCheck();
        return true;
    }

    /**
     * Cancel the active sleep timer.
     */
    cancelSleepTimer() {
        this.store.state.sleepTimerEndTime = null;
        if (this._sleepTimerTimeout) {
            clearTimeout(this._sleepTimerTimeout);
            this._sleepTimerTimeout = null;
        }
    }

    /**
     * Auto-start sleep timer in "time" mode if configured and playing.
     * Called when app goes to background.
     */
    _maybeAutoStartSleepTimer() {
        // Only auto-start in "time" mode
        if (this.store.state.sleepTimerMode !== 'time') return;
        // Only if a target time is configured
        if (!this.store.state.sleepTimerTargetTime) return;
        // Only if currently playing
        if (!this.store.state.isPlaying) return;
        // Don't restart if already active
        if (this.store.state.sleepTimerEndTime) return;

        this.startSleepTimer();
    }

    /**
     * Setup sleep timer with setTimeout for exact timing.
     * Uses setTimeout instead of setInterval because mobile browsers
     * suspend intervals when the screen is off, but setTimeout fires
     * when the browser wakes up if the time has passed.
     */
    _setupSleepTimerCheck() {
        if (this._sleepTimerTimeout) {
            clearTimeout(this._sleepTimerTimeout);
            this._sleepTimerTimeout = null;
        }

        const endTime = this.store.state.sleepTimerEndTime;
        if (!endTime) return;

        const delay = Math.max(0, endTime - Date.now());

        this._sleepTimerTimeout = setTimeout(() => {
            this._sleepTimerTimeout = null;

            // Verify timer is still active (wasn't cancelled)
            if (!this.store.state.sleepTimerEndTime) return;

            // Only trigger if in background
            if (document.visibilityState === 'hidden') {
                this.pause();
                this.store.state.sleepTimerEndTime = null;
            } else {
                // If in foreground when timer fires, check again in 1 second
                // (user might go back to background soon)
                this._sleepTimerTimeout = setTimeout(() => {
                    if (this.store.state.sleepTimerEndTime && document.visibilityState === 'hidden') {
                        this.pause();
                        this.store.state.sleepTimerEndTime = null;
                    }
                }, 1000);
            }
        }, delay);
    }

    /**
     * Get remaining sleep timer time in seconds, or null if not active.
     */
    getSleepTimerRemaining() {
        const endTime = this.store.state.sleepTimerEndTime;
        if (!endTime) return null;
        const remaining = Math.max(0, endTime - Date.now());
        return Math.floor(remaining / 1000);
    }

    /**
     * Check if sleep timer has expired and pause if so.
     * Called periodically (every minute) and between songs.
     * @returns {boolean} True if playback was stopped due to timer
     */
    _checkSleepTimerAndMaybeSleep() {
        const endTime = this.store.state.sleepTimerEndTime;
        if (!endTime) return false;

        // Check if timer has expired
        if (Date.now() >= endTime) {
            // Only trigger if in background
            if (document.visibilityState === 'hidden') {
                console.log('[Sleep Timer] Timer expired while in background, pausing playback');
                this.pause();
                this.store.state.sleepTimerEndTime = null;
                return true;
            }
        }
        return false;
    }

    // ==================== END AUDIO FX METHODS ====================

    /**
     * Play next song in queue.
     * @param {Object} [options] - Options
     * @param {boolean} [options.userInitiated=true] - Whether this is a user-initiated skip
     */
    async next({ userInitiated = true } = {}) {
        // Only cancel crossfade for user-initiated skips, not automatic track transitions
        if (userInitiated) {
            this._cancelCrossfade();
        }

        const { queue, queueIndex, repeatMode, scaEnabled, shuffle } = this.store.state;

        // In shuffle mode, save current song UUID to history for back button
        const currentSong = queue[queueIndex];
        if (shuffle && currentSong?.uuid) {
            this._shuffleHistory.push(currentSong.uuid);
            // Trim history if it exceeds max size
            if (this._shuffleHistory.length > this._shuffleHistoryMaxSize) {
                this._shuffleHistory.shift();
            }
            saveShuffleHistory(this._shuffleHistory);
        }

        let nextIndex;

        // Handle shuffle mode
        if (shuffle && queue.length > 1) {
            // Pick a random index different from current
            const availableIndices = [];
            for (let i = 0; i < queue.length; i++) {
                if (i !== queueIndex) {
                    availableIndices.push(i);
                }
            }
            nextIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
        } else {
            // Normal sequential mode
            nextIndex = queueIndex + 1;
        }

        if (nextIndex >= queue.length) {
            // If SCA is enabled, populate more songs
            if (scaEnabled) {
                try {
                    const result = await sca.populateQueue(10);
                    if (result.songs && result.songs.length > 0) {
                        this.store.state.queue = [...queue, ...result.songs];
                        this.store.state.queueVersion++;
                        nextIndex = queue.length;  // First of newly added songs
                    } else {
                        // Pool exhausted
                        this.store.state.isPlaying = false;
                        return;
                    }
                } catch (e) {
                    console.error('Failed to populate SCA queue:', e);
                    this.store.state.isPlaying = false;
                    return;
                }
            } else if (repeatMode === 'all') {
                nextIndex = 0;
            } else {
                // End of queue
                this.store.state.isPlaying = false;
                return;
            }
        }

        this.store.state.queueIndex = nextIndex;

        // In work offline mode, skip songs that aren't cached
        if (offlineStore.state.workOfflineMode || !offlineStore.state.isOnline) {
            const nextSong = this.store.state.queue[nextIndex];
            if (nextSong && !offlineStore.state.offlineSongUuids.has(nextSong.uuid)) {
                // Song not cached, skip to next
                console.log('[Player] Skipping uncached song in offline mode:', nextSong.title);
                return this.next({ userInitiated: false });
            }
        }

        // Sync index to server (skip in temp queue mode)
        if (this.store.state.tempQueueMode) {
            await this._saveTempQueueState();
        } else {
            try {
                await queueApi.setIndex(nextIndex);
            } catch (e) {
                console.error('Failed to sync queue index:', e);
            }
        }

        await this.play(this.store.state.queue[nextIndex]);

        // If SCA enabled and queue running low, preemptively populate more
        if (scaEnabled) {
            const remaining = this.store.state.queue.length - nextIndex - 1;
            if (remaining < 5) {
                try {
                    const result = await sca.populateQueue(10);
                    if (result.songs && result.songs.length > 0) {
                        this.store.state.queue = [...this.store.state.queue, ...result.songs];
                        this.store.state.queueVersion++;
                    }
                } catch (e) {
                    console.error('Failed to pre-populate SCA queue:', e);
                }
            }
        }
    }

    /**
     * Play previous song in queue.
     */
    async previous() {
        // Cancel any in-progress crossfade
        this._cancelCrossfade();

        const { queue, queueIndex, repeatMode, shuffle } = this.store.state;

        // If in the last 90% of the song, restart instead of going to previous
        const duration = this.audio.duration || 0;
        if (duration > 0 && this.audio.currentTime / duration > 0.9) {
            this.audio.currentTime = 0;
            return;
        }

        let prevIndex = -1;

        // In shuffle mode, use history if available (stores UUIDs)
        if (shuffle && this._shuffleHistory.length > 0) {
            // Pop UUIDs until we find one still in the queue, or exhaust history
            while (this._shuffleHistory.length > 0 && prevIndex === -1) {
                const uuid = this._shuffleHistory.pop();
                prevIndex = queue.findIndex(song => song.uuid === uuid);
            }
            // Save updated history (we may have popped multiple items)
            saveShuffleHistory(this._shuffleHistory);
        }

        // If no valid history entry found, fall back to sequential
        if (prevIndex === -1) {
            prevIndex = queueIndex - 1;

            if (prevIndex < 0) {
                if (repeatMode === 'all') {
                    prevIndex = queue.length - 1;
                } else {
                    // Start of queue, just restart
                    this.audio.currentTime = 0;
                    return;
                }
            }
        }

        // In work offline mode, skip songs that aren't cached
        if (offlineStore.state.workOfflineMode || !offlineStore.state.isOnline) {
            const prevSong = queue[prevIndex];
            if (prevSong && !offlineStore.state.offlineSongUuids.has(prevSong.uuid)) {
                console.log('[Player] Skipping uncached song in offline mode:', prevSong.title);
                // Update index and recurse to find previous cached song
                this.store.state.queueIndex = prevIndex;
                return this.previous();
            }
        }

        this.store.state.queueIndex = prevIndex;

        // Sync index to server (skip in temp queue mode)
        if (this.store.state.tempQueueMode) {
            await this._saveTempQueueState();
        } else {
            try {
                await queueApi.setIndex(prevIndex);
            } catch (e) {
                console.error('Failed to sync queue index:', e);
            }
        }

        await this.play(queue[prevIndex]);
    }

    /**
     * Skip current song (records skip event).
     */
    async skip() {
        const { currentSong, scaEnabled } = this.store.state;

        // Record skip in history (fire-and-forget, don't block playback)
        if (scaEnabled && currentSong) {
            history.record(
                currentSong.uuid,
                Math.floor(this.audio.currentTime),
                true,
                'radio'
            ).catch(e => console.error('Failed to record skip:', e));
        }

        await this.next();
    }

    /**
     * Add songs to queue.
     */
    async addToQueue(songs, playNow = false) {
        const songsArray = Array.isArray(songs) ? songs : [songs];
        const songUuids = songsArray.map(s => s.uuid);

        if (songUuids.some(u => !u)) {
            console.error('addToQueue: Some songs missing uuid:', songsArray);
            return;
        }

        // Temp queue mode: add locally without server sync
        if (this.store.state.tempQueueMode) {
            const newIndex = this.store.state.queue.length;
            this.store.state.queue = [...this.store.state.queue, ...songsArray];
            this.store.state.queueVersion++;

            if (playNow && songsArray.length > 0) {
                this.store.state.queueIndex = newIndex;
                await this.play(songsArray[0]);
            }

            // Persist to IndexedDB
            await this._saveTempQueueState();
            return;
        }

        try {
            // Add to server
            const result = await queueApi.add(songUuids);

            if (result.error) {
                console.error('Failed to add to queue:', result.error);
                return;
            }

            // Reload queue from server to get correct positions
            const queueResult = await queueApi.list({ limit: 10000 });

            if (queueResult.error) {
                console.error('Failed to reload queue:', queueResult.error);
                return;
            }

            this.store.state.queue = queueResult.items || [];
            this.store.state.queueVersion++;

            if (playNow) {
                // Find the first added song's position and play it
                // Use findLastIndex to handle duplicates - newly added songs are at the end
                const newIndex = this.store.state.queue.findLastIndex(s => s.uuid === songUuids[0]);
                if (newIndex >= 0) {
                    this.store.state.queueIndex = newIndex;
                    await queueApi.setIndex(newIndex);
                    await this.play(this.store.state.queue[newIndex]);
                } else {
                    console.error('addToQueue: Could not find added song in queue. UUID:', songUuids[0], 'Queue:', this.store.state.queue);
                }
            }
        } catch (e) {
            console.error('Failed to add to queue:', e);
        }
    }

    /**
     * Add songs from a VFS path to queue.
     * Appends to existing queue. Autoplays only if queue was empty before adding.
     */
    async addByPath(path) {
        // Temp queue mode: fetch songs directly and add locally
        if (this.store.state.tempQueueMode) {
            try {
                const songs = await this._fetchAllSongsByPath(path);
                if (songs.length === 0) return;

                const wasEmpty = this.store.state.queue.length === 0;
                this.store.state.queue = [...this.store.state.queue, ...songs];
                this.store.state.queueVersion++;

                await this._saveTempQueueState();

                // Only autoplay if queue was empty before adding
                if (wasEmpty) {
                    await this._autoplayQueue();
                }
            } catch (e) {
                console.error('Failed to add by path (temp queue):', e);
            }
            return;
        }

        try {
            // Track if queue was empty before adding
            const wasEmpty = this.store.state.queue.length === 0;

            const result = await queueApi.addByPath(path);

            if (result.error) {
                console.error('Failed to add by path:', result.error);
                return;
            }

            // Reload queue from server
            const queueResult = await queueApi.list({ limit: 10000 });
            this.store.state.queue = queueResult.items || [];
            this.store.state.queueVersion++;

            // Only autoplay if queue was empty before adding
            if (wasEmpty && this.store.state.queue.length > 0) {
                await this._autoplayQueue();
            }
        } catch (e) {
            console.error('Failed to add by path:', e);
        }
    }

    /**
     * Fetch all songs under a path (for temp queue mode).
     */
    async _fetchAllSongsByPath(path) {
        const allSongs = [];
        let cursor = null;

        do {
            const result = await songsApi.byPath(path, { cursor, limit: 500 });
            if (result.error) break;
            const songs = result.songs || result.items || [];
            if (songs.length > 0) allSongs.push(...songs);
            cursor = result.nextCursor || null;
        } while (cursor);

        return allSongs;
    }

    /**
     * Add songs by filter to queue.
     * Appends to existing queue. Autoplays only if queue was empty before adding.
     */
    async addByFilter(filters) {
        // Temp queue mode: fetch songs directly and add locally
        if (this.store.state.tempQueueMode) {
            try {
                const songs = await this._fetchAllSongsByFilter(filters);
                if (songs.length === 0) return;

                const wasEmpty = this.store.state.queue.length === 0;
                this.store.state.queue = [...this.store.state.queue, ...songs];
                this.store.state.queueVersion++;

                await this._saveTempQueueState();

                // Only autoplay if queue was empty before adding
                if (wasEmpty) {
                    await this._autoplayQueue();
                }
            } catch (e) {
                console.error('Failed to add by filter (temp queue):', e);
            }
            return;
        }

        try {
            // Track if queue was empty before adding
            const wasEmpty = this.store.state.queue.length === 0;

            const result = await queueApi.addByFilter(filters);

            if (result.error) {
                console.error('Failed to add by filter:', result.error);
                return;
            }

            // Reload queue from server
            const queueResult = await queueApi.list({ limit: 10000 });
            this.store.state.queue = queueResult.items || [];
            this.store.state.queueVersion++;

            // Only autoplay if queue was empty before adding
            if (wasEmpty && this.store.state.queue.length > 0) {
                await this._autoplayQueue();
            }
        } catch (e) {
            console.error('Failed to add by filter:', e);
        }
    }

    /**
     * Fetch all songs matching filters (for temp queue mode).
     */
    async _fetchAllSongsByFilter(filters) {
        const allSongs = [];
        let cursor = null;

        do {
            const result = await songsApi.byFilter({ ...filters, cursor, limit: 500 });
            if (result.error) break;
            const songs = result.songs || result.items || [];
            if (songs.length > 0) allSongs.push(...songs);
            cursor = result.nextCursor || null;
        } while (cursor);

        return allSongs;
    }

    /**
     * Add songs from a playlist to queue.
     * Appends to existing queue. Autoplays only if queue was empty before adding.
     */
    async addByPlaylist(playlistId, shuffle = false) {
        // Temp queue mode: fetch songs directly and add locally
        if (this.store.state.tempQueueMode) {
            try {
                let songs = await this._fetchAllPlaylistSongs(playlistId);
                if (songs.length === 0) return;

                // Shuffle if requested
                if (shuffle) {
                    songs = this._shuffleArray([...songs]);
                }

                const wasEmpty = this.store.state.queue.length === 0;
                this.store.state.queue = [...this.store.state.queue, ...songs];
                this.store.state.queueVersion++;

                await this._saveTempQueueState();

                // Only autoplay if queue was empty before adding
                if (wasEmpty) {
                    await this._autoplayQueue();
                }
            } catch (e) {
                console.error('Failed to add by playlist (temp queue):', e);
            }
            return;
        }

        try {
            // Track if queue was empty before adding
            const wasEmpty = this.store.state.queue.length === 0;

            const result = await queueApi.addByPlaylist(playlistId, null, shuffle);

            if (result.error) {
                console.error('Failed to add by playlist:', result.error);
                return;
            }

            // Reload queue from server
            const queueResult = await queueApi.list({ limit: 10000 });
            this.store.state.queue = queueResult.items || [];
            this.store.state.queueVersion++;

            // Only autoplay if queue was empty before adding
            if (wasEmpty && this.store.state.queue.length > 0) {
                await this._autoplayQueue();
            }
        } catch (e) {
            console.error('Failed to add by playlist:', e);
        }
    }

    /**
     * Fetch all songs from a playlist (for temp queue mode).
     */
    async _fetchAllPlaylistSongs(playlistId) {
        const allSongs = [];
        let cursor = null;

        do {
            const result = await playlistsApi.getSongs(playlistId, { cursor, limit: 500 });
            if (result.error) break;
            // Handle both 'items' (offline-api) and 'songs' (direct api) response formats
            const songs = result.items || result.songs || [];
            if (songs.length > 0) allSongs.push(...songs);
            cursor = result.nextCursor || null;
        } while (cursor);

        return allSongs;
    }

    /**
     * Fisher-Yates shuffle for local shuffling.
     */
    _shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    /**
     * Attempt to autoplay from current queue position.
     * On failure, set up paused state so user can manually play.
     * Skips unavailable offline songs automatically.
     */
    async _autoplayQueue() {
        const song = this.store.state.queue[this.store.state.queueIndex];
        if (!song) return;

        try {
            this.store.state.queueIndex = 0;

            // Only sync to server if not in temp queue mode
            // (temp queue state is already saved by the caller before _autoplayQueue)
            if (!this.store.state.tempQueueMode) {
                await queueApi.setIndex(0);
            }

            // Use play() which handles offline skipping
            await this.play(song);
            return;
        } catch (e) {
            console.error('Autoplay failed:', e);
            this.store.state.isLoading = false;
        }
    }

    /**
     * Clear the queue.
     */
    async clearQueue() {
        // Clear shuffle history when queue is cleared
        this._shuffleHistory = [];
        clearShuffleHistory();

        // Temp queue mode: clear locally only
        if (this.store.state.tempQueueMode) {
            this.store.state.queue = [];
            this.store.state.queueIndex = 0;
            this.store.state.queueVersion++;
            this.stop();
            await this._saveTempQueueState();
            return;
        }

        try {
            await queueApi.clear();
            this.store.state.queue = [];
            this.store.state.queueIndex = 0;
            this.store.state.queueVersion++;
            this.stop();
        } catch (e) {
            console.error('Failed to clear queue:', e);
        }
    }

    /**
     * Refresh queue from server (after server-side sort, etc.)
     */
    async refreshQueue() {
        try {
            const result = await queueApi.list({ limit: 10000 });
            if (!result.error) {
                const currentUuid = this.store.state.currentSong?.uuid;
                const serverIndex = result.queueIndex || 0;

                this.store.state.queue = result.items || [];
                this.store.state.queueVersion++;  // Trigger re-render

                // Validate server's index against current song UUID
                if (currentUuid) {
                    if (this.store.state.queue[serverIndex]?.uuid === currentUuid) {
                        // Server index is valid - use it
                        this.store.state.queueIndex = serverIndex;
                    } else {
                        // Server index doesn't match our song - find nearest occurrence
                        const queue = this.store.state.queue;
                        let nearestIndex = -1;
                        let nearestDistance = Infinity;

                        for (let i = 0; i < queue.length; i++) {
                            if (queue[i].uuid === currentUuid) {
                                const distance = Math.abs(i - serverIndex);
                                if (distance < nearestDistance) {
                                    nearestDistance = distance;
                                    nearestIndex = i;
                                }
                            }
                        }

                        if (nearestIndex >= 0) {
                            this.store.state.queueIndex = nearestIndex;
                        } else {
                            // Song not in queue - use server's index
                            // (syncQueueState handles offline/online sync conflicts)
                            this.store.state.queueIndex = serverIndex;
                            this.store.state.currentSong = this.store.state.queue[serverIndex] || null;
                        }
                    }
                } else {
                    this.store.state.queueIndex = serverIndex;
                }
            }
        } catch (e) {
            console.error('Failed to refresh queue:', e);
        }
    }

    /**
     * Play a specific index in the queue.
     */
    async playAtIndex(index) {
        const { queue } = this.store.state;

        if (index < 0 || index >= queue.length) return;

        this.store.state.queueIndex = index;

        // Temp queue mode: update locally only
        if (this.store.state.tempQueueMode) {
            await this._saveTempQueueState();
        } else {
            // Sync index to server
            try {
                await queueApi.setIndex(index);
            } catch (e) {
                console.error('Failed to sync queue index:', e);
            }
        }

        await this.play(queue[index]);
    }

    /**
     * Remove song from queue.
     */
    async removeFromQueue(index) {
        const { queue, queueIndex } = this.store.state;

        if (index < 0 || index >= queue.length) return;

        // Temp queue mode: remove locally only
        if (this.store.state.tempQueueMode) {
            const newQueue = [...queue];
            newQueue.splice(index, 1);
            this.store.state.queue = newQueue;

            // Adjust queueIndex if needed
            if (index < queueIndex) {
                this.store.state.queueIndex = queueIndex - 1;
            } else if (index === queueIndex && queueIndex >= newQueue.length) {
                this.store.state.queueIndex = Math.max(0, newQueue.length - 1);
            }

            this.store.state.queueVersion++;
            await this._saveTempQueueState();
            return;
        }

        // Get the position from the song (server uses position, not index)
        const song = queue[index];
        const position = song.position ?? index;

        try {
            await queueApi.remove([position]);

            // Reload queue from server
            const result = await queueApi.list({ limit: 10000 });
            this.store.state.queue = result.items || [];
            this.store.state.queueIndex = result.queueIndex || 0;
            this.store.state.queueVersion++;
        } catch (e) {
            console.error('Failed to remove from queue:', e);
        }
    }

    /**
     * Remove multiple songs from queue (batch delete).
     * @param {number[]} indices - Array of indices to remove
     */
    async removeFromQueueBatch(indices) {
        if (!indices || indices.length === 0) return;

        const { queue, queueIndex } = this.store.state;

        // Validate indices
        const validIndices = indices.filter(i => i >= 0 && i < queue.length);
        if (validIndices.length === 0) return;

        // Sort descending so we remove from end first (maintains indices)
        const sortedIndices = [...validIndices].sort((a, b) => b - a);

        // Temp queue mode: remove locally only
        if (this.store.state.tempQueueMode) {
            const newQueue = [...queue];
            for (const idx of sortedIndices) {
                newQueue.splice(idx, 1);
            }
            this.store.state.queue = newQueue;

            // Adjust queueIndex - count how many removed items were before current
            const removedBefore = validIndices.filter(i => i < queueIndex).length;
            const currentRemoved = validIndices.includes(queueIndex);

            if (currentRemoved) {
                // Current song was removed, stay at same index or end
                this.store.state.queueIndex = Math.min(queueIndex - removedBefore, Math.max(0, newQueue.length - 1));
            } else {
                this.store.state.queueIndex = queueIndex - removedBefore;
            }

            this.store.state.queueVersion++;
            await this._saveTempQueueState();
            return;
        }

        // Server mode: get positions and call API
        const positions = validIndices.map(i => queue[i].position ?? i);

        try {
            await queueApi.remove(positions);

            // Reload queue from server
            const result = await queueApi.list({ limit: 10000 });
            this.store.state.queue = result.items || [];
            this.store.state.queueIndex = result.queueIndex || 0;
            this.store.state.queueVersion++;
        } catch (e) {
            console.error('Failed to batch remove from queue:', e);
        }
    }

    /**
     * Reorder queue - move item from one index to another.
     */
    async reorderQueue(fromIndex, toIndex) {
        const { queue, queueIndex } = this.store.state;

        if (fromIndex < 0 || fromIndex >= queue.length) return;
        if (toIndex < 0 || toIndex >= queue.length) return;
        if (fromIndex === toIndex) return;

        // Temp queue mode: reorder locally only
        if (this.store.state.tempQueueMode) {
            const newQueue = [...queue];
            const [moved] = newQueue.splice(fromIndex, 1);
            newQueue.splice(toIndex, 0, moved);
            this.store.state.queue = newQueue;

            // Adjust queueIndex if the currently playing song moved
            if (fromIndex === queueIndex) {
                this.store.state.queueIndex = toIndex;
            } else if (fromIndex < queueIndex && toIndex >= queueIndex) {
                this.store.state.queueIndex = queueIndex - 1;
            } else if (fromIndex > queueIndex && toIndex <= queueIndex) {
                this.store.state.queueIndex = queueIndex + 1;
            }

            this.store.state.queueVersion++;
            await this._saveTempQueueState();
            return;
        }

        // Get positions (server uses position field, not array index)
        const fromPos = queue[fromIndex].position ?? fromIndex;
        // When moving down, adjust target position for the index shift after removal
        const targetIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
        const toPos = queue[targetIndex]?.position ?? targetIndex;

        try {
            await queueApi.reorder(fromPos, toPos);

            // Reload queue from server to get updated positions
            const result = await queueApi.list({ limit: 10000 });
            this.store.state.queue = result.items || [];
            this.store.state.queueIndex = result.queueIndex ?? queueIndex;
            this.store.state.queueVersion++;
        } catch (e) {
            console.error('Failed to reorder queue:', e);
        }
    }

    /**
     * Reorder queue - move multiple items to a target position (batch reorder).
     * Maintains relative order of moved items.
     * @param {number[]} fromIndices - Array of indices to move
     * @param {number} toIndex - Target index to move items to
     */
    async reorderQueueBatch(fromIndices, toIndex) {
        if (!fromIndices || fromIndices.length === 0) return;

        const { queue, queueIndex } = this.store.state;

        // Validate indices
        const validIndices = fromIndices.filter(i => i >= 0 && i < queue.length);
        if (validIndices.length === 0) return;
        if (toIndex < 0 || toIndex >= queue.length) return;

        // Sort ascending to maintain relative order
        const sortedIndices = [...validIndices].sort((a, b) => a - b);

        // Extract items to move (in order)
        const itemsToMove = sortedIndices.map(i => queue[i]);

        // Create new queue without the moved items
        const newQueue = queue.filter((_, i) => !validIndices.includes(i));

        // Calculate adjusted target position
        // Count how many items we're removing before the target
        let adjustedTarget = toIndex;
        for (const idx of sortedIndices) {
            if (idx < toIndex) adjustedTarget--;
        }
        adjustedTarget = Math.max(0, Math.min(adjustedTarget, newQueue.length));

        // Insert items at target position
        newQueue.splice(adjustedTarget, 0, ...itemsToMove);

        // Update state
        this.store.state.queue = newQueue;

        // Adjust queueIndex
        const wasPlaying = validIndices.includes(queueIndex);
        if (wasPlaying) {
            // Find where the currently playing song ended up
            const playingOffset = sortedIndices.indexOf(queueIndex);
            this.store.state.queueIndex = adjustedTarget + playingOffset;
        } else {
            // Count how queue index shifts
            const movedBeforeOld = sortedIndices.filter(i => i < queueIndex).length;
            const movedBeforeNew = itemsToMove.length > 0 && adjustedTarget <= queueIndex - movedBeforeOld
                ? itemsToMove.length : 0;
            this.store.state.queueIndex = queueIndex - movedBeforeOld + movedBeforeNew;
        }

        this.store.state.queueVersion++;

        // Temp queue mode: save locally
        if (this.store.state.tempQueueMode) {
            await this._saveTempQueueState();
            return;
        }

        // Server mode: use batch reorder API
        try {
            await queueApi.reorderBatch(sortedIndices, toIndex);
        } catch (e) {
            console.error('Failed to batch reorder queue:', e);
            // Reload from server on error to resync state
            await this.reloadQueue();
        }
    }

    /**
     * Sort the queue by a field.
     * Handles both temp queue mode (local sort) and normal mode (server sort).
     */
    async sortQueue(sortBy = 'artist', order = 'asc') {
        const queue = this.store.state.queue;
        if (!queue || queue.length === 0) return;

        // Create sorted copy
        const sorted = [...queue];
        const direction = order === 'desc' ? -1 : 1;

        if (sortBy === 'random') {
            // Fisher-Yates shuffle
            for (let i = sorted.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
            }
        } else {
            sorted.sort((a, b) => {
                let aVal, bVal;
                switch (sortBy) {
                    case 'artist':
                        aVal = (a.artist || '').toLowerCase();
                        bVal = (b.artist || '').toLowerCase();
                        break;
                    case 'album':
                        aVal = (a.album || '').toLowerCase();
                        bVal = (b.album || '').toLowerCase();
                        break;
                    case 'track':
                        aVal = (a.disc_number || 1) * 1000 + (a.track_number || 0);
                        bVal = (b.disc_number || 1) * 1000 + (b.track_number || 0);
                        break;
                    case 'title':
                        aVal = (a.title || '').toLowerCase();
                        bVal = (b.title || '').toLowerCase();
                        break;
                    case 'year':
                        aVal = a.year || 0;
                        bVal = b.year || 0;
                        break;
                    case 'duration':
                        aVal = a.duration_seconds || 0;
                        bVal = b.duration_seconds || 0;
                        break;
                    default:
                        aVal = (a.title || '').toLowerCase();
                        bVal = (b.title || '').toLowerCase();
                }
                if (aVal < bVal) return -direction;
                if (aVal > bVal) return direction;
                return 0;
            });
        }

        // Update queue and reset to start
        this.store.state.queue = sorted;
        this.store.state.queueIndex = 0;
        this.store.state.queueVersion++;

        // Temp queue mode: save locally
        if (this.store.state.tempQueueMode) {
            await this._saveTempQueueState();
            return;
        }

        // Server mode: sort via API and reload
        try {
            await queueApi.sort(sortBy, order);
            // Reload to sync with server state
            await this.reloadQueue();
        } catch (e) {
            console.error('Failed to sort queue on server:', e);
        }
    }

    /**
     * Save current queue as playlist.
     */
    async saveQueueAsPlaylist(name, description = '', isPublic = false) {
        try {
            const result = await queueApi.saveAsPlaylist(name, description, isPublic);
            if (result.error) {
                throw new Error(result.error);
            }
            return result;
        } catch (e) {
            console.error('Failed to save queue as playlist:', e);
            throw e;
        }
    }

    /**
     * Start SCA mode from current queue.
     */
    async startScaFromQueue() {
        // Block in work-offline mode (requires network)
        if (offlineStore.state.workOfflineMode) {
            this.store.state.error = 'Radio requires network connection';
            return;
        }

        try {
            this.store.state.isLoading = true;
            const result = await sca.startFromQueue();

            if (result.error) {
                throw new Error(result.error);
            }

            this.store.state.scaEnabled = true;
            this.store.state.queue = result.queue || [];
            this.store.state.queueIndex = 0;
            this.store.state.queueVersion++;

            if (result.queue && result.queue.length > 0) {
                await queueApi.setIndex(0);
                await this.play(result.queue[0]);
            }
        } catch (e) {
            console.error('Failed to start SCA from queue:', e);
            this.store.state.error = 'Failed to start radio';
        } finally {
            this.store.state.isLoading = false;
        }
    }

    /**
     * Start SCA mode from playlist.
     */
    async startScaFromPlaylist(playlistId) {
        // Block in work-offline mode (requires network)
        if (offlineStore.state.workOfflineMode) {
            this.store.state.error = 'Radio requires network connection';
            return;
        }

        try {
            this.store.state.isLoading = true;
            const result = await sca.startFromPlaylist(playlistId);

            if (result.error) {
                throw new Error(result.error);
            }

            this.store.state.scaEnabled = true;
            this.store.state.queue = result.queue || [];
            this.store.state.queueIndex = 0;
            this.store.state.queueVersion++;

            if (result.queue && result.queue.length > 0) {
                await queueApi.setIndex(0);
                await this.play(result.queue[0]);
            }
        } catch (e) {
            console.error('Failed to start SCA from playlist:', e);
            this.store.state.error = 'Failed to start radio';
        } finally {
            this.store.state.isLoading = false;
        }
    }

    /**
     * Stop SCA mode.
     */
    async stopSca() {
        try {
            await sca.stop();
            this.store.state.scaEnabled = false;
        } catch (e) {
            console.error('Failed to stop SCA:', e);
        }
    }

    /**
     * Start radio with optional seed song and filter query.
     */
    async startRadio(seedUuid = null, filterQuery = null) {
        // Block in work-offline mode (requires network)
        if (offlineStore.state.workOfflineMode) {
            this.store.state.error = 'Radio requires network connection';
            return;
        }

        try {
            this.store.state.isLoading = true;
            const result = await radio.start(seedUuid, filterQuery);

            if (result.error) {
                throw new Error(result.error);
            }

            // Store session ID for subsequent radio operations
            this._radioSessionId = result.session_id;
            this.store.state.scaEnabled = true;

            // Build full queue: seed song first, then radio queue
            // Backend now syncs this to user_queue table, so we match that here
            const fullQueue = result.seed ? [result.seed, ...result.queue] : result.queue;

            if (fullQueue && fullQueue.length > 0) {
                this.store.state.queue = fullQueue;
                this.store.state.queueIndex = 0;
                this.store.state.queueVersion++;
                // No need to call queueApi.setIndex - backend already set it
                await this.play(fullQueue[0]);
            }
        } catch (e) {
            console.error('Failed to start radio:', e);
            this.store.state.error = 'Failed to start radio';
        } finally {
            this.store.state.isLoading = false;
        }
    }

    /**
     * Toggle shuffle mode.
     * Shuffle and repeat are mutually exclusive.
     */
    async toggleShuffle() {
        this.store.state.shuffle = !this.store.state.shuffle;

        let playMode;
        if (this.store.state.shuffle) {
            // Enabling shuffle - disable repeat mode
            this.store.state.repeatMode = 'none';
            playMode = 'shuffle';
        } else {
            // Disabling shuffle - go to sequential, clear history
            this._shuffleHistory = [];
            clearShuffleHistory();
            playMode = 'sequential';
        }

        try {
            await playback.setState({ playMode });
        } catch (e) {
            console.error('Failed to sync shuffle to server:', e);
        }
    }

    /**
     * Cycle repeat mode: none -> all -> one -> none
     * Shuffle and repeat are mutually exclusive.
     */
    async cycleRepeatMode() {
        const modes = ['none', 'all', 'one'];
        const currentIndex = modes.indexOf(this.store.state.repeatMode);
        const newMode = modes[(currentIndex + 1) % modes.length];
        await this.setRepeatMode(newMode);
    }

    /**
     * Set shuffle mode directly.
     */
    async setShuffle(enabled) {
        if (this.store.state.shuffle === enabled) return;

        this.store.state.shuffle = enabled;

        // Clear shuffle history when disabling shuffle
        if (!enabled) {
            this._shuffleHistory = [];
            clearShuffleHistory();
        }

        let playMode;
        if (enabled) {
            // Enabling shuffle - disable repeat mode
            this.store.state.repeatMode = 'none';
            playMode = 'shuffle';
        } else {
            // Disabling shuffle - go to sequential (unless repeat is active)
            if (this.store.state.repeatMode === 'all') {
                playMode = 'repeat_all';
            } else if (this.store.state.repeatMode === 'one') {
                playMode = 'repeat_one';
            } else {
                playMode = 'sequential';
            }
        }

        try {
            await playback.setState({ playMode });
        } catch (e) {
            console.error('Failed to sync shuffle to server:', e);
        }
    }

    /**
     * Set repeat mode directly.
     */
    async setRepeatMode(mode) {
        if (this.store.state.repeatMode === mode) return;

        this.store.state.repeatMode = mode;

        // Map to server play_mode
        let playMode = 'sequential';
        if (mode === 'all') {
            // Enabling repeat - disable shuffle
            this.store.state.shuffle = false;
            playMode = 'repeat_all';
        } else if (mode === 'one') {
            // Enabling repeat - disable shuffle
            this.store.state.shuffle = false;
            playMode = 'repeat_one';
        } else if (this.store.state.shuffle) {
            // If mode is 'none' but shuffle is on, use shuffle
            playMode = 'shuffle';
        }

        try {
            await playback.setState({ playMode });
        } catch (e) {
            console.error('Failed to sync repeat mode to server:', e);
        }
    }

    // =========================================================================
    // Temp Queue Mode
    // =========================================================================

    /**
     * Enter temp queue mode.
     * Saves current queue to IndexedDB and starts with an empty local-only queue.
     */
    async enterTempQueueMode() {
        if (this.store.state.tempQueueMode) return;

        try {
            // Deep copy all state to avoid Proxy objects in IndexedDB
            const savedQueue = JSON.parse(JSON.stringify({
                items: this.store.state.queue,
                queueIndex: this.store.state.queueIndex,
                scaEnabled: this.store.state.scaEnabled,
                playMode: this._getCurrentPlayMode()
            }));

            const tempQueue = JSON.parse(JSON.stringify({
                items: [],
                queueIndex: 0,
                shuffle: this.store.state.shuffle,
                repeatMode: this.store.state.repeatMode
            }));

            // Clear queue and enter temp mode
            this.store.state.tempQueueMode = true;
            this.store.state.queue = [];
            this.store.state.queueIndex = 0;
            this.store.state.queueVersion++;
            this.store.state.scaEnabled = false;
            this.stop();

            // Save to IndexedDB for persistence
            await offlineDb.saveTempQueueState(tempQueue, savedQueue);

            console.log('[TempQueue] Entered temp queue mode');
        } catch (e) {
            console.error('Failed to enter temp queue mode:', e);
            this.store.state.tempQueueMode = false;
        }
    }

    /**
     * Exit temp queue mode.
     * Restores the original synced queue from IndexedDB.
     */
    async exitTempQueueMode() {
        if (!this.store.state.tempQueueMode) return;

        // Set guard flag to prevent race conditions with queue refresh
        this._isExitingTempQueue = true;

        try {
            // Stop any current playback first
            this.audio.pause();
            this.audio.src = '';

            // Get saved queue from IndexedDB
            const { savedQueue } = await offlineDb.getTempQueueState();

            if (savedQueue) {
                // Restore original queue
                this.store.state.queue = savedQueue.items || [];
                this.store.state.queueIndex = savedQueue.queueIndex || 0;
                this.store.state.scaEnabled = savedQueue.scaEnabled || false;
                this.store.state.queueVersion++;

                // Restore play mode
                const playMode = savedQueue.playMode || 'sequential';
                if (playMode === 'shuffle') {
                    this.store.state.shuffle = true;
                    this.store.state.repeatMode = 'none';
                } else if (playMode === 'repeat_all') {
                    this.store.state.shuffle = false;
                    this.store.state.repeatMode = 'all';
                } else if (playMode === 'repeat_one') {
                    this.store.state.shuffle = false;
                    this.store.state.repeatMode = 'one';
                } else {
                    this.store.state.shuffle = false;
                    this.store.state.repeatMode = 'none';
                }

                // Restore current song from queue position and set audio URL
                if (this.store.state.queue.length > 0) {
                    const song = this.store.state.queue[this.store.state.queueIndex];
                    if (song) {
                        this.store.state.currentSong = { ...song };
                        this.store.state.duration = song.duration_seconds || 0;
                        this._applyReplayGain();
                        this._updateMediaSessionMetadata(song);

                        // Set up audio source so it's ready to play
                        let audioUrl = await getAudioUrl(song.uuid);
                        if (!audioUrl && offlineStore.state.isOnline && !offlineStore.state.workOfflineMode) {
                            audioUrl = getStreamUrl(song.uuid, song.type);
                        }
                        if (audioUrl) {
                            this.audio.src = audioUrl;
                        }
                    }
                } else {
                    this.store.state.currentSong = null;
                    this.store.state.duration = 0;
                }
            }

            // Reset playback state
            this.store.state.tempQueueMode = false;
            this.store.state.isPlaying = false;
            this.store.state.isPaused = false;
            this.store.state.isLoading = false;
            this.store.state.currentTime = 0;

            // Sync restored position to server BEFORE clearing guard flag
            // This prevents race with _refreshQueueOnFocus overwriting the restored position
            if (savedQueue && savedQueue.queueIndex !== undefined) {
                try {
                    await queueApi.setIndex(savedQueue.queueIndex);
                } catch (e) {
                    console.warn('[TempQueue] Failed to sync restored position to server:', e);
                }
            }

            // Clear temp queue from IndexedDB
            await offlineDb.clearTempQueueState();

            // Dispatch event so UI can scroll to current song
            window.dispatchEvent(new CustomEvent('temp-queue-exited'));

            console.log('[TempQueue] Exited temp queue mode, restored queue');
        } catch (e) {
            console.error('Failed to exit temp queue mode:', e);
            this.store.state.tempQueueMode = false;
        } finally {
            // Clear guard flag and record exit time for cooldown
            this._isExitingTempQueue = false;
            this._tempQueueExitTime = Date.now();
        }
    }

    /**
     * Toggle temp queue mode.
     */
    async toggleTempQueueMode() {
        if (this.store.state.tempQueueMode) {
            await this.exitTempQueueMode();
        } else {
            await this.enterTempQueueMode();
        }
    }

    /**
     * Helper to get current play mode string for server.
     */
    _getCurrentPlayMode() {
        if (this.store.state.shuffle) return 'shuffle';
        if (this.store.state.repeatMode === 'all') return 'repeat_all';
        if (this.store.state.repeatMode === 'one') return 'repeat_one';
        return 'sequential';
    }

    /**
     * Save current temp queue state to IndexedDB for persistence.
     */
    async _saveTempQueueState() {
        if (!this.store.state.tempQueueMode) return;

        try {
            // Deep copy entire object to avoid Proxy objects in IndexedDB
            const tempQueue = JSON.parse(JSON.stringify({
                items: this.store.state.queue,
                queueIndex: this.store.state.queueIndex,
                shuffle: this.store.state.shuffle,
                repeatMode: this.store.state.repeatMode
            }));
            await offlineDb.saveTempQueueState(tempQueue);
        } catch (e) {
            console.error('Failed to save temp queue state:', e);
        }
    }

    /**
     * Preload next song for gapless playback.
     */
    async _preloadNext() {
        // Only preload if gapless or crossfade is enabled
        if (!this.store.state.gaplessEnabled && !this.store.state.crossfadeEnabled) return;

        const { queue, queueIndex, repeatMode } = this.store.state;
        let nextIndex = queueIndex + 1;

        // Handle wrap-around for repeat all
        if (nextIndex >= queue.length) {
            if (repeatMode === 'all') {
                nextIndex = 0;
            } else {
                return;
            }
        }

        const nextSong = queue[nextIndex];
        if (!nextSong || this.preloadedSong?.uuid === nextSong.uuid) return;

        this.preloadedSong = nextSong;

        // Try offline audio first
        let audioUrl = await getAudioUrl(nextSong.uuid);
        if (!audioUrl && offlineStore.state.isOnline && !offlineStore.state.workOfflineMode) {
            audioUrl = getStreamUrl(nextSong.uuid, nextSong.type);
        }

        if (audioUrl) {
            this.preloadAudio.src = audioUrl;
            this.preloadAudio.load();
        }
    }

    /**
     * Reload queue from server.
     * In temp queue mode, this is a no-op to avoid overwriting local queue.
     */
    async reloadQueue() {
        // Don't reload from server in temp queue mode
        if (this.store.state.tempQueueMode) {
            return;
        }

        try {
            const result = await queueApi.list({ limit: 10000 });
            let items = result.items || [];

            // Filter queue to only cached songs when in work offline mode
            if (offlineStore.state.workOfflineMode || !offlineStore.state.isOnline) {
                const offlineUuids = offlineStore.state.offlineSongUuids;
                items = items.filter(item => offlineUuids.has(item.uuid));
            }

            this.store.state.queue = items;
            this.store.state.queueIndex = Math.min(result.queueIndex || 0, Math.max(0, items.length - 1));
            this.store.state.scaEnabled = result.scaEnabled || false;
            this.store.state.queueVersion++;  // Trigger re-render
        } catch (e) {
            console.error('Failed to reload queue:', e);
        }
    }
}

// Create and export the audio controller instance
export const audioController = new AudioController(playerStore);

// Convenience methods bound to store
export const player = {
    get state() {
        return playerStore.state;
    },

    subscribe(callback) {
        return playerStore.subscribe(callback);
    },

    play: (song) => audioController.play(song),
    pause: () => audioController.pause(),
    resume: () => audioController.resume(),
    togglePlayPause: () => audioController.togglePlayPause(),
    stop: () => audioController.stop(),
    seek: (pos) => audioController.seek(pos),
    next: () => audioController.next(),
    previous: () => audioController.previous(),
    skip: () => audioController.skip(),
    setVolume: (v) => audioController.setVolume(v),
    toggleMute: () => audioController.toggleMute(),
    addToQueue: (songs, playNow) => audioController.addToQueue(songs, playNow),
    addByPath: (path) => audioController.addByPath(path),
    addByFilter: (filters) => audioController.addByFilter(filters),
    addByPlaylist: (id, shuffle) => audioController.addByPlaylist(id, shuffle),
    clearQueue: () => audioController.clearQueue(),
    playAtIndex: (i) => audioController.playAtIndex(i),
    removeFromQueue: (i) => audioController.removeFromQueue(i),
    removeFromQueueBatch: (indices) => audioController.removeFromQueueBatch(indices),
    reorderQueue: (from, to) => audioController.reorderQueue(from, to),
    reorderQueueBatch: (indices, to) => audioController.reorderQueueBatch(indices, to),
    toggleShuffle: () => audioController.toggleShuffle(),
    cycleRepeatMode: () => audioController.cycleRepeatMode(),
    setShuffle: (enabled) => audioController.setShuffle(enabled),
    setRepeatMode: (mode) => audioController.setRepeatMode(mode),
    reloadQueue: () => audioController.reloadQueue(),

    // SCA methods
    startScaFromQueue: () => audioController.startScaFromQueue(),
    startScaFromPlaylist: (id) => audioController.startScaFromPlaylist(id),
    startRadio: (seed, filter) => audioController.startRadio(seed, filter),
    stopSca: () => audioController.stopSca(),
    stopRadio: () => audioController.stopSca(),  // Alias for stopSca

    // Queue management
    saveQueueAsPlaylist: (name, desc, pub) => audioController.saveQueueAsPlaylist(name, desc, pub),
    sortQueue: (sortBy, order) => audioController.sortQueue(sortBy, order),

    // Temp queue mode
    toggleTempQueueMode: () => audioController.toggleTempQueueMode(),
    enterTempQueueMode: () => audioController.enterTempQueueMode(),
    exitTempQueueMode: () => audioController.exitTempQueueMode(),

    // Replay gain
    setReplayGainMode: (mode) => audioController.setReplayGainMode(mode),
    setReplayGainPreamp: (preamp) => audioController.setReplayGainPreamp(preamp),
    setReplayGainFallback: (fallback) => audioController.setReplayGainFallback(fallback),

    // EQ
    initEQ: (ctx, src, out) => audioController.initEQ(ctx, src, out),
    setEQBand: (index, gain) => audioController.setEQBand(index, gain),
    setEQEnabled: (enabled) => audioController.setEQEnabled(enabled),
    setGraphicPreamp: (preamp) => audioController.setGraphicPreamp(preamp),
    resetEQ: () => audioController.resetEQ(),
    restoreGraphicEQ: (preamp) => audioController.restoreGraphicEQ(preamp),
    setParametricEQ: (bands, autoPreamp) => audioController.setParametricEQ(bands, autoPreamp),
    getEQFilters: () => audioController.getEQFilters(),
    getAudioContext: () => audioController.getAudioContext(),
    connectExternalAudio: (el) => audioController.connectExternalAudio(el),
    insertAnalyser: (analyser) => audioController.insertAnalyser(analyser),
    removeAnalyser: () => audioController.removeAnalyser(),
    switchLatencyMode: (hint) => audioController.switchLatencyMode(hint),
    setLowLatencyAlways: (enabled) => audioController.setLowLatencyAlways(enabled),

    // Audio FX - Crossfeed
    setCrossfeedEnabled: (enabled) => audioController.setCrossfeedEnabled(enabled),
    setCrossfeedLevel: (level) => audioController.setCrossfeedLevel(level),
    setCrossfeedDelay: (ms) => audioController.setCrossfeedDelay(ms),
    setCrossfeedShadow: (hz) => audioController.setCrossfeedShadow(hz),
    setCrossfeedPreset: (preset) => audioController.setCrossfeedPreset(preset),

    // Audio FX - Tempo
    setTempoEnabled: (enabled) => audioController.setTempoEnabled(enabled),
    setTempoRate: (rate) => audioController.setTempoRate(rate),
    setTempoPitchLock: (enabled) => audioController.setTempoPitchLock(enabled),

    // Audio FX - Gapless/Crossfade
    setGaplessEnabled: (enabled) => audioController.setGaplessEnabled(enabled),
    setCrossfadeEnabled: (enabled) => audioController.setCrossfadeEnabled(enabled),
    setCrossfadeDuration: (duration) => audioController.setCrossfadeDuration(duration),

    // Audio FX - Loudness Compensation
    setLoudnessEnabled: (enabled) => audioController.setLoudnessEnabled(enabled),
    setLoudnessReferenceSPL: (spl) => audioController.setLoudnessReferenceSPL(spl),
    setLoudnessStrength: (strength) => audioController.setLoudnessStrength(strength),

    // Audio FX - Comfort Noise
    setNoiseEnabled: (enabled) => audioController.setNoiseEnabled(enabled),
    setNoiseMode: (mode) => audioController.setNoiseMode(mode),
    setNoiseTilt: (tilt) => audioController.setNoiseTilt(tilt),
    setNoisePower: (power) => audioController.setNoisePower(power),
    setNoiseThreshold: (threshold) => audioController.setNoiseThreshold(threshold),
    setNoiseAttack: (attack) => audioController.setNoiseAttack(attack),

    // Audio FX - Sleep Timer
    setSleepTimerMode: (mode) => audioController.setSleepTimerMode(mode),
    setSleepTimerMinutes: (minutes) => audioController.setSleepTimerMinutes(minutes),
    setSleepTimerTargetTime: (time) => audioController.setSleepTimerTargetTime(time),
    setSleepTimerMinimumMinutes: (minutes) => audioController.setSleepTimerMinimumMinutes(minutes),
    startSleepTimer: () => audioController.startSleepTimer(),
    cancelSleepTimer: () => audioController.cancelSleepTimer(),
    getSleepTimerRemaining: () => audioController.getSleepTimerRemaining(),

    // Audio source change notification (for visualizers)
    onAudioSourceChange: (callback) => audioController.onAudioSourceChange(callback),
    getAudioSourceVersion: () => audioController.getAudioSourceVersion(),
    getVisualizerInputNode: () => audioController.getVisualizerInputNode()
};

export default player;
