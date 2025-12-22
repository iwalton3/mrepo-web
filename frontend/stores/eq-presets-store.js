/**
 * EQ Presets Store
 *
 * Manages:
 * - Loading/saving EQ presets from/to API
 * - Active preset tracking (localStorage)
 * - Conversion between graphic and parametric EQ formats
 */

import { createStore, untracked } from '../lib/framework.js';
import { eqPresets as api } from '../offline/offline-api.js';
import { EQ_BANDS } from './player-store.js';

const LOCAL_STORAGE_KEY = 'music-player-eq-active';

/**
 * EQ filter types supported by Web Audio API
 */
export const FILTER_TYPES = [
    { value: 'peaking', label: 'Peaking' },
    { value: 'lowshelf', label: 'Low Shelf' },
    { value: 'highshelf', label: 'High Shelf' },
    { value: 'lowpass', label: 'Low Pass' },
    { value: 'highpass', label: 'High Pass' },
    { value: 'notch', label: 'Notch' },
    { value: 'bandpass', label: 'Band Pass' },
    { value: 'allpass', label: 'All Pass' }
];

/**
 * Default band configuration
 */
export function createDefaultBand() {
    return {
        type: 'peaking',
        frequency: 1000,
        gain: 0,
        q: 1.4,
        enabled: true
    };
}

/**
 * Convert 10-band graphic EQ gains to parametric format.
 * @param {number[]} gains - Array of 10 gain values (-12 to +12 dB)
 * @returns {Object[]} Array of band configurations
 */
export function graphicToParametric(gains) {
    return EQ_BANDS.map((freq, i) => ({
        type: i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking',
        frequency: freq,
        gain: gains[i],
        q: 1.4
    }));
}

/**
 * Convert parametric EQ bands to 10-band graphic EQ format.
 * Maps parametric bands to nearest graphic EQ frequency.
 * @param {Object[]} bands - Array of band configurations
 * @returns {number[]} Array of 10 gain values
 */
export function parametricToGraphic(bands) {
    // Start with flat response
    const gains = new Array(10).fill(0);

    // For each parametric band, find the nearest graphic band
    for (const band of bands) {
        // Only use peaking/shelf filters that affect gain
        if (!['peaking', 'lowshelf', 'highshelf'].includes(band.type)) continue;

        // Find nearest EQ band by frequency
        let nearestIndex = 0;
        let minDiff = Math.abs(Math.log(band.frequency) - Math.log(EQ_BANDS[0]));

        for (let i = 1; i < EQ_BANDS.length; i++) {
            const diff = Math.abs(Math.log(band.frequency) - Math.log(EQ_BANDS[i]));
            if (diff < minDiff) {
                minDiff = diff;
                nearestIndex = i;
            }
        }

        // Add the gain (clamped to -12 to +12)
        gains[nearestIndex] += band.gain;
        gains[nearestIndex] = Math.max(-12, Math.min(12, gains[nearestIndex]));
    }

    return gains;
}

/**
 * Load active EQ state from localStorage.
 */
function loadActiveState() {
    try {
        const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (saved) {
            const state = JSON.parse(saved);
            // Handle both old format (customBands) and new format (bands)
            return {
                presetUuid: state.presetUuid,
                customBands: state.bands || state.customBands || []
            };
        }
    } catch (e) {
        console.error('Failed to load active EQ state:', e);
    }
    return { presetUuid: null, customBands: [] };
}

/**
 * Save active EQ state to localStorage.
 * Always caches bands locally so no API call is needed on startup.
 */
function saveActiveState(presetUuid, bands) {
    try {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
            presetUuid,
            bands  // Always cache bands (whether from preset or custom)
        }));
    } catch (e) {
        console.error('Failed to save active EQ state:', e);
    }
}

// Load initial state
const activeState = loadActiveState();

/**
 * Create the EQ presets store.
 */
export const eqPresetsStore = createStore({
    // All presets from API
    presets: untracked([]),

    // Currently active preset UUID (null for custom)
    activePresetUuid: activeState.presetUuid,

    // Custom bands when not using a preset
    customBands: untracked(activeState.customBands || []),

    // Loading state
    isLoading: false,

    // Error message
    error: null
});

/**
 * Store controller with methods.
 */
const controller = {
    /**
     * Load all presets from API.
     */
    async loadPresets() {
        eqPresetsStore.state.isLoading = true;
        eqPresetsStore.state.error = null;

        try {
            const result = await api.list();
            if (result.error) {
                eqPresetsStore.state.error = result.error;
                eqPresetsStore.state.presets = [];
            } else {
                eqPresetsStore.state.presets = result.presets || [];

                // Migrate: if active preset has no cached bands, cache them now
                this._ensureBandsCached();
            }
        } catch (e) {
            console.error('Failed to load EQ presets:', e);
            eqPresetsStore.state.error = 'Failed to load presets';
            eqPresetsStore.state.presets = [];
        } finally {
            eqPresetsStore.state.isLoading = false;
        }
    },

    /**
     * Ensure active preset bands are cached in localStorage.
     * Handles migration from old format where preset bands weren't cached.
     */
    _ensureBandsCached() {
        const { activePresetUuid, presets, customBands } = eqPresetsStore.state;
        if (!activePresetUuid) return;

        // Check if bands are already cached
        try {
            const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
            if (saved) {
                const state = JSON.parse(saved);
                if (state.bands && state.bands.length > 0) {
                    return; // Already cached
                }
            }
        } catch (e) {}

        // Find preset and cache its bands
        const preset = presets.find(p => p.uuid === activePresetUuid);
        if (preset && preset.bands) {
            console.log('[EQ] Migrating preset bands to localStorage cache');
            saveActiveState(activePresetUuid, preset.bands);
            eqPresetsStore.state.customBands = preset.bands;
        }
    },

    /**
     * Save a preset (create or update).
     * @param {Object} preset - Preset data
     * @param {string} [preset.uuid] - UUID if updating
     * @param {string} preset.name - Preset name
     * @param {Object[]} preset.bands - Band configurations
     */
    async savePreset({ uuid, name, bands }) {
        eqPresetsStore.state.isLoading = true;
        eqPresetsStore.state.error = null;

        try {
            const result = await api.save({ uuid, name, bands });
            if (result.error) {
                eqPresetsStore.state.error = result.error;
                return null;
            }

            // Reload presets to get updated list
            await this.loadPresets();

            return result.uuid;
        } catch (e) {
            console.error('Failed to save EQ preset:', e);
            eqPresetsStore.state.error = 'Failed to save preset';
            return null;
        } finally {
            eqPresetsStore.state.isLoading = false;
        }
    },

    /**
     * Delete a preset.
     * @param {string} uuid - Preset UUID to delete
     */
    async deletePreset(uuid) {
        eqPresetsStore.state.isLoading = true;
        eqPresetsStore.state.error = null;

        try {
            const result = await api.delete(uuid);
            if (result.error) {
                eqPresetsStore.state.error = result.error;
                return false;
            }

            // If deleted preset was active, clear active state
            if (eqPresetsStore.state.activePresetUuid === uuid) {
                this.setActivePreset(null);
            }

            // Reload presets
            await this.loadPresets();

            return true;
        } catch (e) {
            console.error('Failed to delete EQ preset:', e);
            eqPresetsStore.state.error = 'Failed to delete preset';
            return false;
        } finally {
            eqPresetsStore.state.isLoading = false;
        }
    },

    /**
     * Set the active preset.
     * @param {string|null} uuid - Preset UUID or null for custom
     * @param {Object[]} [customBands] - Custom bands if uuid is null
     */
    setActivePreset(uuid, customBands = []) {
        eqPresetsStore.state.activePresetUuid = uuid;

        let bandsToCache;
        if (uuid) {
            // Get preset bands to cache locally
            const preset = eqPresetsStore.state.presets.find(p => p.uuid === uuid);
            bandsToCache = preset ? preset.bands : [];
        } else if (customBands.length > 0) {
            eqPresetsStore.state.customBands = customBands;
            bandsToCache = customBands;
        } else {
            const { bands } = loadActiveState();
            eqPresetsStore.state.customBands = bands;
            bandsToCache = bands;
        }

        // Always cache bands locally for startup
        saveActiveState(uuid, bandsToCache);
    },

    /**
     * Update custom bands (when not using a preset).
     * @param {Object[]} bands - Band configurations
     */
    setCustomBands(bands) {
        eqPresetsStore.state.customBands = bands;
        if (!eqPresetsStore.state.activePresetUuid) {
            saveActiveState(null, bands);
        }
    },

    /**
     * Get the currently active bands.
     * @returns {Object[]} Band configurations
     */
    getActiveBands() {
        const { activePresetUuid, presets, customBands } = eqPresetsStore.state;

        if (activePresetUuid) {
            const preset = presets.find(p => p.uuid === activePresetUuid);
            return preset ? preset.bands : [];
        }

        return customBands;
    },

    /**
     * Get preset by UUID.
     * @param {string} uuid - Preset UUID
     * @returns {Object|null} Preset or null
     */
    getPreset(uuid) {
        return eqPresetsStore.state.presets.find(p => p.uuid === uuid) || null;
    }
};

// Listen for storage changes from other tabs to prevent race conditions
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
        if (event.key === LOCAL_STORAGE_KEY && event.newValue) {
            try {
                const newState = JSON.parse(event.newValue);
                // Reload state from the other tab's update
                eqPresetsStore.state.activePresetUuid = newState.presetUuid;
                eqPresetsStore.state.customBands = newState.bands || [];
                console.log('[EQ] Synced state from another tab');
            } catch (e) {
                console.error('[EQ] Failed to sync state from other tab:', e);
            }
        }
    });
}

// Export store with state and methods
export default {
    state: eqPresetsStore.state,
    subscribe: eqPresetsStore.subscribe.bind(eqPresetsStore),
    ...controller
};
