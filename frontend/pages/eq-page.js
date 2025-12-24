/**
 * EQ Page
 *
 * Dedicated equalizer page with:
 * - Graphic and parametric EQ modes
 * - Undo/redo functionality
 * - Easy navigation back to settings
 */

import { defineComponent, html, when, each } from '../lib/framework.js';
import player, { EQ_BANDS } from '../stores/player-store.js';
import eqPresetsStore from '../stores/eq-presets-store.js';
import '../components/parametric-eq-editor.js';
import '../componentlib/button/button.js';

// Number of points for frequency response calculation
const RESPONSE_POINTS = 256;
const MIN_FREQ = 20;
const MAX_FREQ = 20000;

// Max undo history size
const MAX_UNDO_HISTORY = 50;

export default defineComponent('eq-page', {
    data() {
        // Capture initial state immediately from player store
        const initialGains = [...player.state.eqGains];
        const isParametric = localStorage.getItem('music-eq-advanced') === 'true';

        return {
            // EQ settings (from player store, device-specific)
            eqEnabled: player.state.eqEnabled,
            eqGains: initialGains,
            showParametricEQ: isParametric,

            // Crossfeed settings
            crossfeedEnabled: player.state.crossfeedEnabled,
            crossfeedLevel: player.state.crossfeedLevel,
            crossfeedDelayMs: player.state.crossfeedDelayMs,
            crossfeedShadowHz: player.state.crossfeedShadowHz,

            // Loudness compensation settings
            loudnessEnabled: player.state.loudnessEnabled,
            loudnessReferenceSPL: player.state.loudnessReferenceSPL,
            loudnessStrength: player.state.loudnessStrength,

            // Comfort noise settings
            noiseEnabled: player.state.noiseEnabled,
            noiseMode: player.state.noiseMode,
            noiseTilt: player.state.noiseTilt,
            noisePower: player.state.noisePower,
            noiseThreshold: player.state.noiseThreshold,
            noiseAttack: player.state.noiseAttack,

            // Undo/redo history - initialize with current state
            // For parametric mode, this will be updated once editor is ready
            undoHistory: [],
            redoHistory: [],
            lastSavedState: {
                mode: 'graphic',
                gains: initialGains
            }
        };
    },

    mounted() {
        // For parametric mode, wait for editor to be ready then capture initial state
        if (this.state.showParametricEQ && this.state.eqEnabled) {
            this._waitForParametricEditor();
        }
    },

    methods: {
        _waitForParametricEditor() {
            // Poll for editor to have bands loaded (max 2 seconds)
            let attempts = 0;
            const maxAttempts = 40;
            const checkEditor = () => {
                const editor = this.querySelector('parametric-eq-editor');
                if (editor && editor.state && editor.state.bands) {
                    // Editor is ready - capture its current state
                    const bands = editor.state.bands;
                    if (bands.length > 0 || attempts >= maxAttempts) {
                        this.state.lastSavedState = {
                            mode: 'parametric',
                            bands: JSON.parse(JSON.stringify(bands))
                        };
                        return;
                    }
                }
                attempts++;
                if (attempts < maxAttempts) {
                    setTimeout(checkEditor, 50);
                }
            };
            checkEditor();
        },

        _getCurrentState() {
            if (this.state.showParametricEQ) {
                // Get bands from parametric editor
                const editor = this.querySelector('parametric-eq-editor');
                if (editor && editor.state) {
                    return {
                        mode: 'parametric',
                        bands: JSON.parse(JSON.stringify(editor.state.bands))
                    };
                }
            }
            return {
                mode: 'graphic',
                gains: [...this.state.eqGains]
            };
        },

        _pushUndoState() {
            const currentState = this._getCurrentState();

            // Don't push if state hasn't changed
            if (this.state.lastSavedState &&
                JSON.stringify(currentState) === JSON.stringify(this.state.lastSavedState)) {
                return;
            }

            // Push previous state to undo stack
            if (this.state.lastSavedState) {
                this.state.undoHistory = [
                    ...this.state.undoHistory.slice(-MAX_UNDO_HISTORY + 1),
                    this.state.lastSavedState
                ];
            }

            // Clear redo stack on new change
            this.state.redoHistory = [];
            this.state.lastSavedState = currentState;
        },

        handleUndo() {
            if (this.state.undoHistory.length === 0) return;

            const undoHistory = [...this.state.undoHistory];
            const previousState = undoHistory.pop();

            // Save current state to redo
            const currentState = this._getCurrentState();
            this.state.redoHistory = [...this.state.redoHistory, currentState];

            // Apply previous state
            this._applyState(previousState);
            this.state.undoHistory = undoHistory;
            this.state.lastSavedState = previousState;
        },

        handleRedo() {
            if (this.state.redoHistory.length === 0) return;

            const redoHistory = [...this.state.redoHistory];
            const nextState = redoHistory.pop();

            // Save current state to undo
            const currentState = this._getCurrentState();
            this.state.undoHistory = [...this.state.undoHistory, currentState];

            // Apply next state
            this._applyState(nextState);
            this.state.redoHistory = redoHistory;
            this.state.lastSavedState = nextState;
        },

        _applyState(state) {
            if (state.mode === 'parametric') {
                // Switch to parametric mode if needed
                if (!this.state.showParametricEQ) {
                    this.state.showParametricEQ = true;
                    localStorage.setItem('music-eq-advanced', 'true');
                }

                // Apply bands to parametric editor
                const editor = this.querySelector('parametric-eq-editor');
                if (editor) {
                    editor.setBands(state.bands);
                }
            } else {
                // Switch to graphic mode if needed
                if (this.state.showParametricEQ) {
                    this.state.showParametricEQ = false;
                    localStorage.setItem('music-eq-advanced', 'false');
                }

                // Apply gains to graphic EQ
                this.state.eqGains = [...state.gains];
                state.gains.forEach((gain, i) => {
                    player.setEQBand(i, gain);
                });
                this._applyGraphicPreamp();
            }
        },

        handleEQToggle(e) {
            this.state.eqEnabled = e.target.checked;
            player.setEQEnabled(e.target.checked);
        },

        // Called continuously during slider drag - updates audio but doesn't push undo
        handleEQInput(index, e) {
            const value = parseInt(e.target.value, 10);
            this.state.eqGains[index] = value;
            player.setEQBand(index, value);
            this._applyGraphicPreamp();
        },

        // Called on blur/change end - pushes undo state
        handleEQChange(index, e) {
            this._pushUndoState();
        },

        handleResetEQ() {
            this._pushUndoState();
            this.state.eqGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
            player.resetEQ();
            player.setGraphicPreamp(0);
        },

        setEQMode(mode) {
            const isParametric = mode === 'parametric';
            if (isParametric === this.state.showParametricEQ) return;

            this._pushUndoState();
            this.state.showParametricEQ = isParametric;
            localStorage.setItem('music-eq-advanced', isParametric);

            // When switching to graphic EQ, restore the 10-band filter chain with preamp
            if (!isParametric) {
                const preamp = this._calculateGraphicPreamp();
                player.restoreGraphicEQ(preamp);
            }
        },

        // Called by parametric-eq-editor when bands change
        handleParametricChange() {
            this._pushUndoState();
        },

        formatFreq(freq) {
            if (freq >= 1000) {
                return (freq / 1000) + 'k';
            }
            return freq.toString();
        },

        /**
         * Calculate headroom for graphic EQ based on combined frequency response peak.
         */
        _calculateGraphicPreamp() {
            const gains = this.state.eqGains;
            if (!gains || gains.every(g => g === 0)) return 0;

            // Create temporary AudioContext if needed
            if (!this._tempAudioContext) {
                try {
                    this._tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
                } catch (e) {
                    // Fallback to simple max gain
                    const maxGain = Math.max(...gains.filter(g => g > 0), 0);
                    return maxGain > 0 ? -maxGain : 0;
                }
            }

            const logMin = Math.log10(MIN_FREQ);
            const logMax = Math.log10(MAX_FREQ);

            // Generate log-spaced frequencies
            const frequencies = new Float32Array(RESPONSE_POINTS);
            for (let i = 0; i < RESPONSE_POINTS; i++) {
                const logFreq = logMin + (i / (RESPONSE_POINTS - 1)) * (logMax - logMin);
                frequencies[i] = Math.pow(10, logFreq);
            }

            // Combined magnitude in dB
            const combinedMag = new Float32Array(RESPONSE_POINTS).fill(0);

            // Create filters for each band
            EQ_BANDS.forEach((freq, i) => {
                const filter = this._tempAudioContext.createBiquadFilter();
                filter.type = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking';
                filter.frequency.value = freq;
                filter.gain.value = gains[i];
                if (i > 0 && i < 9) {
                    filter.Q.value = 1.4;
                }

                const magResponse = new Float32Array(RESPONSE_POINTS);
                const phaseResponse = new Float32Array(RESPONSE_POINTS);
                filter.getFrequencyResponse(frequencies, magResponse, phaseResponse);

                for (let j = 0; j < RESPONSE_POINTS; j++) {
                    combinedMag[j] += 20 * Math.log10(magResponse[j]);
                }
            });

            // Find peak
            let peakDb = 0;
            for (let i = 0; i < RESPONSE_POINTS; i++) {
                if (combinedMag[i] > peakDb) {
                    peakDb = combinedMag[i];
                }
            }

            // Round to 0.1 dB precision
            return peakDb > 0 ? -Math.ceil(peakDb * 10) / 10 : 0;
        },

        /**
         * Apply the current graphic EQ preamp.
         */
        _applyGraphicPreamp() {
            const preamp = this._calculateGraphicPreamp();
            player.setGraphicPreamp(preamp);
        },

        // Crossfeed handlers
        handleCrossfeedToggle(e) {
            this.state.crossfeedEnabled = e.target.checked;
            player.setCrossfeedEnabled(e.target.checked);
        },

        handleCrossfeedLevelChange(e) {
            const value = parseInt(e.target.value, 10);
            this.state.crossfeedLevel = value;
            player.setCrossfeedLevel(value);
        },

        // Logarithmic conversion: slider 0-100 → delay 0-5ms
        // Using base=50 gives excellent resolution at low values (0.1-0.5ms range)
        // slider 30 ≈ 0.2ms, slider 40 ≈ 0.3ms, slider 50 ≈ 0.5ms, slider 70 ≈ 1.2ms
        sliderToDelay(slider) {
            if (slider <= 0) return 0;
            const maxMs = 5;
            const base = 50;
            return maxMs * (Math.pow(base, slider / 100) - 1) / (base - 1);
        },

        delayToSlider(ms) {
            if (ms <= 0) return 0;
            const maxMs = 5;
            const base = 50;
            return 100 * Math.log(ms * (base - 1) / maxMs + 1) / Math.log(base);
        },

        handleCrossfeedDelayChange(e) {
            const ms = this.sliderToDelay(parseInt(e.target.value, 10));
            this.state.crossfeedDelayMs = ms;
            player.setCrossfeedDelay(ms);
        },

        // Shadow filter conversion: slider 0-100 → 0 (off) or 500-3000Hz
        // Inverted scale: higher slider = lower frequency (more filtering)
        sliderToShadow(slider) {
            if (slider <= 0) return 0;
            // Linear scale from 3000Hz (slider=1) down to 500Hz (slider=100)
            return Math.round(3000 - (slider / 100) * 2500);
        },

        shadowToSlider(hz) {
            if (hz <= 0) return 0;
            return Math.round((3000 - hz) / 2500 * 100);
        },

        handleCrossfeedShadowChange(e) {
            const hz = this.sliderToShadow(parseInt(e.target.value, 10));
            this.state.crossfeedShadowHz = hz;
            player.setCrossfeedShadow(hz);
        },

        handleCrossfeedPreset(preset) {
            player.setCrossfeedPreset(preset);
            // Sync local state with store
            this.state.crossfeedLevel = player.state.crossfeedLevel;
            this.state.crossfeedDelayMs = player.state.crossfeedDelayMs;
            this.state.crossfeedShadowHz = player.state.crossfeedShadowHz;
        },

        // Loudness compensation handlers
        handleLoudnessToggle(e) {
            this.state.loudnessEnabled = e.target.checked;
            player.setLoudnessEnabled(e.target.checked);
        },

        handleReferenceSPLChange(e) {
            const value = parseInt(e.target.value, 10);
            this.state.loudnessReferenceSPL = value;
            player.setLoudnessReferenceSPL(value);
        },

        handleLoudnessStrengthChange(e) {
            const value = parseInt(e.target.value, 10);
            this.state.loudnessStrength = value;
            player.setLoudnessStrength(value);
        },

        // Comfort noise handlers
        handleNoiseToggle(e) {
            this.state.noiseEnabled = e.target.checked;
            player.setNoiseEnabled(e.target.checked);
        },

        handleNoiseModeChange(mode) {
            this.state.noiseMode = mode;
            this.state.noiseTilt = 0;  // Reset tilt when changing mode (matches store behavior)
            player.setNoiseMode(mode);
        },

        handleNoiseTiltChange(e) {
            const value = parseInt(e.target.value, 10);
            this.state.noiseTilt = value;
            player.setNoiseTilt(value);
        },

        handleNoisePowerChange(e) {
            const value = parseInt(e.target.value, 10);
            this.state.noisePower = value;
            player.setNoisePower(value);
        },

        handleNoiseThresholdChange(e) {
            const value = parseInt(e.target.value, 10);
            this.state.noiseThreshold = value;
            player.setNoiseThreshold(value);
        },

        handleNoiseAttackChange(e) {
            // Log scale: slider 0-100 maps to 25-2000ms
            // ms = 25 * 80^(slider/100)
            const sliderValue = parseInt(e.target.value, 10);
            const ms = Math.round(25 * Math.pow(80, sliderValue / 100));
            this.state.noiseAttack = ms;
            player.setNoiseAttack(ms);
        },

        // Convert ms to slider position (log scale)
        attackMsToSlider(ms) {
            // slider = 100 * log(ms/25) / log(80)
            return Math.round(100 * Math.log(ms / 25) / Math.log(80));
        }
    },

    template() {
        const { eqEnabled, eqGains, showParametricEQ, undoHistory, redoHistory, crossfeedEnabled, crossfeedLevel, crossfeedDelayMs, crossfeedShadowHz, loudnessEnabled, loudnessReferenceSPL, loudnessStrength, noiseEnabled, noiseMode, noiseTilt, noisePower, noiseThreshold, noiseAttack } = this.state;
        const canUndo = undoHistory.length > 0;
        const canRedo = redoHistory.length > 0;

        return html`
            <div class="eq-page">
                <div class="eq-header">
                    <h1>Equalizer</h1>
                    <div class="eq-actions">
                        <button class="undo-btn ${canUndo ? '' : 'disabled'}"
                                on-click="handleUndo"
                                title="Undo (${undoHistory.length})"
                                disabled="${!canUndo}">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M3 10h10a5 5 0 0 1 0 10H9"/>
                                <path d="M7 6l-4 4 4 4"/>
                            </svg>
                        </button>
                        <button class="redo-btn ${canRedo ? '' : 'disabled'}"
                                on-click="handleRedo"
                                title="Redo (${redoHistory.length})"
                                disabled="${!canRedo}">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 10H11a5 5 0 0 0 0 10h4"/>
                                <path d="M17 6l4 4-4 4"/>
                            </svg>
                        </button>
                    </div>
                </div>

                <div class="stereo-image-section">
                    <div class="stereo-image-row">
                        <label>Stereo Image Adj</label>
                        <label class="toggle">
                            <input type="checkbox" checked="${crossfeedEnabled}"
                                   on-change="handleCrossfeedToggle">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    ${when(crossfeedEnabled, html`
                        <div class="crossfeed-presets">
                            <button class="preset-btn" on-click="${() => this.handleCrossfeedPreset('narrow')}">Narrow</button>
                            <button class="preset-btn" on-click="${() => this.handleCrossfeedPreset('medium')}">Medium</button>
                            <button class="preset-btn" on-click="${() => this.handleCrossfeedPreset('wide')}">Wide</button>
                            <button class="preset-btn" on-click="${() => this.handleCrossfeedPreset('off')}">Off</button>
                        </div>
                        <div class="stereo-slider-row">
                            <span class="range-label-inline">Mono</span>
                            <input type="range" min="-100" max="100" step="1"
                                   class="stereo-slider"
                                   value="${crossfeedLevel}"
                                   on-input="handleCrossfeedLevelChange">
                            <span class="range-label-inline">Wide</span>
                            <span class="stereo-value">${crossfeedLevel}</span>
                        </div>
                        <div class="stereo-slider-row">
                            <span class="range-label-inline">Delay</span>
                            <input type="range" min="0" max="100" step="1"
                                   class="stereo-slider"
                                   value="${this.delayToSlider(crossfeedDelayMs)}"
                                   on-input="handleCrossfeedDelayChange">
                            <span class="stereo-value">${crossfeedDelayMs < 1 ? crossfeedDelayMs.toFixed(2) : crossfeedDelayMs.toFixed(1)}ms</span>
                        </div>
                        <div class="stereo-slider-row">
                            <span class="range-label-inline">Shadow</span>
                            <input type="range" min="0" max="100" step="1"
                                   class="stereo-slider"
                                   value="${this.shadowToSlider(crossfeedShadowHz)}"
                                   on-input="handleCrossfeedShadowChange">
                            <span class="stereo-value">${crossfeedShadowHz === 0 ? 'Off' : crossfeedShadowHz + 'Hz'}</span>
                        </div>
                    `)}
                </div>

                <div class="eq-enable-row">
                    <label>Enable EQ</label>
                    <label class="toggle">
                        <input type="checkbox" checked="${eqEnabled}"
                               on-change="handleEQToggle">
                        <span class="toggle-slider"></span>
                    </label>
                </div>

                ${when(eqEnabled, html`
                    <div class="eq-mode-tabs">
                        <button class="eq-tab ${!showParametricEQ ? 'active' : ''}"
                                on-click="${() => this.setEQMode('graphic')}">
                            Graphic
                        </button>
                        <button class="eq-tab ${showParametricEQ ? 'active' : ''}"
                                on-click="${() => this.setEQMode('parametric')}">
                            Parametric
                        </button>
                    </div>

                    ${when(!showParametricEQ, html`
                        <div class="eq-container">
                            <div class="eq-sliders">
                                ${each(EQ_BANDS, (freq, i) => html`
                                    <div class="eq-band">
                                        <span class="eq-value">${eqGains[i] > 0 ? '+' : ''}${eqGains[i]}</span>
                                        <input type="range"
                                               min="-12" max="12" step="1"
                                               value="${eqGains[i]}"
                                               on-input="${(e) => this.handleEQInput(i, e)}"
                                               on-change="${(e) => this.handleEQChange(i, e)}"
                                               class="eq-slider">
                                        <span class="eq-label">${this.formatFreq(freq)}</span>
                                    </div>
                                `)}
                            </div>
                            <div class="eq-footer">
                                <button class="eq-reset" on-click="handleResetEQ">Reset (Flat)</button>
                                <span class="preamp-display">Pre-amp: ${this._calculateGraphicPreamp().toFixed(1)} dB</span>
                            </div>
                        </div>
                    `)}

                    ${when(showParametricEQ, html`
                        <parametric-eq-editor
                            visible="${true}"
                            on-bands-changed="handleParametricChange">
                        </parametric-eq-editor>
                    `)}
                `)}

                <div class="loudness-section">
                    <div class="loudness-row">
                        <label>Loudness Compensation</label>
                        <label class="toggle">
                            <input type="checkbox" checked="${loudnessEnabled}"
                                   on-change="handleLoudnessToggle">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <p class="loudness-explainer">
                        Boosts bass and treble at low volumes to compensate for how human hearing
                        perceives quieter sounds. Set Reference SPL based on how loud your device is
                        at full volume.
                    </p>
                    ${when(loudnessEnabled, html`
                        <div class="loudness-slider-row">
                            <span class="range-label-inline">Reference SPL</span>
                            <input type="range" min="60" max="90" step="1"
                                   class="loudness-slider"
                                   value="${loudnessReferenceSPL}"
                                   on-input="handleReferenceSPLChange">
                            <span class="loudness-value">${loudnessReferenceSPL} dB</span>
                        </div>
                        <div class="loudness-labels">
                            <span>Headphones</span>
                            <span>Speakers</span>
                        </div>
                        <div class="loudness-slider-row">
                            <span class="range-label-inline">Strength</span>
                            <input type="range" min="0" max="150" step="5"
                                   class="loudness-slider"
                                   value="${loudnessStrength}"
                                   on-input="handleLoudnessStrengthChange">
                            <span class="loudness-value">${loudnessStrength}%</span>
                        </div>
                    `)}
                </div>

                <div class="noise-section">
                    <div class="noise-row">
                        <label>Comfort Noise</label>
                        <label class="toggle">
                            <input type="checkbox" checked="${noiseEnabled}"
                                   on-change="handleNoiseToggle">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <p class="noise-explainer">
                        Adds subtle background noise during quiet passages to mask silence.
                        Useful for sleep, focus, or anxiety relief.
                    </p>
                    ${when(noiseEnabled, html`
                        <div class="noise-mode-row">
                            <button class="noise-mode-btn ${noiseMode === 'white' ? 'active' : ''}"
                                    on-click="${() => this.handleNoiseModeChange('white')}">White</button>
                            <button class="noise-mode-btn ${noiseMode === 'grey' ? 'active' : ''}"
                                    on-click="${() => this.handleNoiseModeChange('grey')}">Grey</button>
                        </div>
                        <p class="noise-mode-hint">
                            ${noiseMode === 'white' ? 'Flat spectrum - technically accurate' : 'Inverse A-weighted - perceptually flat to human hearing'}
                        </p>
                        <div class="noise-slider-row">
                            <span class="range-label-inline">Dark</span>
                            <input type="range" min="-100" max="100" step="1"
                                   class="noise-slider"
                                   value="${noiseTilt}"
                                   on-input="handleNoiseTiltChange">
                            <span class="range-label-inline">Bright</span>
                        </div>
                        <div class="noise-slider-row">
                            <span class="range-label-inline">Level</span>
                            <input type="range" min="-60" max="0" step="1"
                                   class="noise-slider"
                                   value="${noisePower}"
                                   on-input="handleNoisePowerChange">
                            <span class="noise-value">${noisePower} dB</span>
                        </div>
                        <div class="noise-slider-row">
                            <span class="range-label-inline">Threshold</span>
                            <input type="range" min="-60" max="0" step="1"
                                   class="noise-slider"
                                   value="${noiseThreshold}"
                                   on-input="handleNoiseThresholdChange">
                            <span class="noise-value">${noiseThreshold === 0 ? 'Always' : noiseThreshold + ' dB'}</span>
                        </div>
                        <div class="noise-labels">
                            <span>Quiet</span>
                            <span>Always On</span>
                        </div>
                        <div class="noise-slider-row">
                            <span class="range-label-inline">Attack</span>
                            <input type="range" min="0" max="100" step="1"
                                   class="noise-slider"
                                   value="${this.attackMsToSlider(noiseAttack)}"
                                   on-input="handleNoiseAttackChange">
                            <span class="noise-value">${noiseAttack <= 25 ? 'Instant' : noiseAttack >= 1000 ? (noiseAttack / 1000).toFixed(1) + 's' : noiseAttack + 'ms'}</span>
                        </div>
                    `)}
                </div>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .eq-page {
            padding: 1rem;
            max-width: 800px;
            margin: 0 auto;
        }

        .eq-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.5rem;
        }

        .eq-header h1 {
            margin: 0;
            color: var(--text-primary, #e0e0e0);
        }

        .eq-actions {
            display: flex;
            gap: 0.5rem;
        }

        .undo-btn,
        .redo-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 40px;
            height: 40px;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 8px;
            background: var(--surface-100, #242424);
            color: var(--text-primary, #e0e0e0);
            cursor: pointer;
            transition: background 0.15s, color 0.15s;
        }

        .undo-btn:hover:not(.disabled),
        .redo-btn:hover:not(.disabled) {
            background: var(--surface-200, #2d2d2d);
            color: var(--primary-400, #60a5fa);
        }

        .undo-btn.disabled,
        .redo-btn.disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }

        .eq-enable-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 1rem;
            background: var(--surface-100, #242424);
            border-radius: 8px;
            margin-bottom: 1rem;
        }

        .eq-enable-row label:first-child {
            font-weight: 500;
            color: var(--text-primary, #e0e0e0);
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

        /* EQ Mode Tabs */
        .eq-mode-tabs {
            display: flex;
            gap: 0;
            margin-bottom: 1rem;
            background: var(--surface-100, #242424);
            border-radius: 6px;
            padding: 4px;
        }

        .eq-tab {
            flex: 1;
            padding: 0.5rem 1rem;
            border: none;
            border-radius: 4px;
            background: transparent;
            color: var(--text-secondary, #a0a0a0);
            cursor: pointer;
            font-size: 0.875rem;
            transition: background 0.15s, color 0.15s;
        }

        .eq-tab:hover {
            color: var(--text-primary, #e0e0e0);
        }

        .eq-tab.active {
            background: var(--primary-600, #2563eb);
            color: white;
        }

        /* EQ Container */
        .eq-container {
            max-width: 100%;
            overflow: hidden;
        }

        .eq-sliders {
            display: flex;
            justify-content: space-between;
            gap: 2px;
            background: var(--surface-100, #242424);
            border-radius: 8px;
            padding: 1rem 0.25rem;
        }

        .eq-band {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
            flex: 1 1 0;
            min-width: 0;
        }

        .eq-slider {
            -webkit-appearance: none;
            appearance: none;
            writing-mode: vertical-lr;
            direction: rtl;
            height: 120px;
            width: 24px;
            cursor: pointer;
            margin: 0;
            padding: 0;
            background: transparent;
            touch-action: none;
        }

        .eq-slider::-webkit-slider-runnable-track {
            width: 6px;
            height: 100%;
            background: var(--surface-300, #404040);
            border-radius: 3px;
        }

        .eq-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 14px;
            height: 14px;
            background: var(--primary-500, #2196f3);
            border: none;
            border-radius: 50%;
            margin-left: -4px;
        }

        .eq-slider::-moz-range-track {
            width: 6px;
            background: var(--surface-300, #404040);
            border-radius: 3px;
        }

        .eq-slider::-moz-range-thumb {
            width: 14px;
            height: 14px;
            background: var(--primary-500, #2196f3);
            border: none;
            border-radius: 50%;
        }

        .eq-label {
            font-size: 9px;
            color: var(--text-muted, #707070);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 100%;
        }

        .eq-value {
            font-size: 9px;
            font-family: monospace;
            color: var(--text-secondary, #a0a0a0);
            text-align: center;
        }

        .eq-footer {
            margin-top: 0.75rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 0.5rem;
        }

        .eq-reset {
            padding: 0.375rem 1rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-secondary, #a0a0a0);
            cursor: pointer;
            font-size: 0.8125rem;
        }

        .eq-reset:hover {
            background: var(--surface-200, #2d2d2d);
            color: var(--text-primary, #e0e0e0);
        }

        .preamp-display {
            font-size: 0.875rem;
            color: var(--text-muted, #707070);
            font-family: monospace;
        }

        /* Stereo Image Section */
        .stereo-image-section {
            background: var(--surface-100, #242424);
            border-radius: 8px;
            margin-bottom: 1rem;
            padding: 1rem;
        }

        .stereo-image-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .stereo-image-row > label:first-child {
            font-weight: 500;
            color: var(--text-primary, #e0e0e0);
        }

        .stereo-slider-row {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            margin-top: 0.75rem;
        }

        .stereo-slider {
            flex: 1;
            min-width: 80px;
        }

        .range-label-inline {
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
            white-space: nowrap;
        }

        .stereo-value {
            font-family: monospace;
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
            min-width: 3.5rem;
            text-align: right;
        }

        .crossfeed-presets {
            display: flex;
            gap: 0.5rem;
            margin: 0.75rem 0;
            flex-wrap: wrap;
        }

        .preset-btn {
            padding: 0.35rem 0.6rem;
            font-size: 0.75rem;
            background: var(--surface-200, #2a2a2a);
            border: 1px solid var(--border-color, #444);
            border-radius: 4px;
            color: var(--text-secondary, #a0a0a0);
            cursor: pointer;
            transition: all 0.15s ease;
        }

        .preset-btn:hover {
            background: var(--surface-300, #333);
            color: var(--text-primary, #e0e0e0);
            border-color: var(--accent-color, #007bff);
        }

        .preset-btn:active {
            transform: scale(0.97);
        }

        /* Loudness Section */
        .loudness-section {
            background: var(--surface-100, #242424);
            border-radius: 8px;
            margin-top: 1rem;
            margin-bottom: 1rem;
            padding: 1rem;
        }

        .loudness-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .loudness-row > label:first-child {
            font-weight: 500;
            color: var(--text-primary, #e0e0e0);
        }

        .loudness-explainer {
            margin: 0.5rem 0 0 0;
            font-size: 0.8rem;
            color: var(--text-muted, #707070);
            line-height: 1.4;
        }

        .loudness-slider-row {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            margin-top: 0.75rem;
        }

        .loudness-slider {
            flex: 1;
            min-width: 80px;
        }

        .loudness-value {
            font-family: monospace;
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
            min-width: 3.5rem;
            text-align: right;
        }

        .loudness-labels {
            display: flex;
            justify-content: space-between;
            font-size: 0.7rem;
            color: var(--text-muted, #707070);
            margin-top: 0.25rem;
            padding: 0 4.5rem;
        }

        /* Noise Section */
        .noise-section {
            background: var(--surface-100, #242424);
            border-radius: 8px;
            margin-top: 1rem;
            margin-bottom: 1rem;
            padding: 1rem;
        }

        .noise-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .noise-row > label:first-child {
            font-weight: 500;
            color: var(--text-primary, #e0e0e0);
        }

        .noise-explainer {
            margin: 0.5rem 0 0 0;
            font-size: 0.8rem;
            color: var(--text-muted, #707070);
            line-height: 1.4;
        }

        .noise-slider-row {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            margin-top: 0.75rem;
        }

        .noise-slider {
            flex: 1;
            min-width: 80px;
        }

        .noise-value {
            font-family: monospace;
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
            min-width: 4rem;
            text-align: right;
        }

        .noise-labels {
            display: flex;
            justify-content: space-between;
            font-size: 0.7rem;
            color: var(--text-muted, #707070);
            margin-top: 0.25rem;
            padding: 0 4.5rem;
        }

        .noise-mode-row {
            display: flex;
            gap: 0;
            margin: 0.75rem 0 0.5rem 0;
            background: var(--surface-100, #242424);
            border-radius: 6px;
            padding: 4px;
        }

        .noise-mode-btn {
            flex: 1;
            padding: 0.5rem 1rem;
            border: none;
            border-radius: 4px;
            background: transparent;
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
            cursor: pointer;
            transition: background 0.15s, color 0.15s;
        }

        .noise-mode-btn:hover {
            color: var(--text-primary, #e0e0e0);
        }

        .noise-mode-btn.active {
            background: var(--primary-600, #2563eb);
            color: white;
        }

        .noise-mode-hint {
            margin: 0 0 0.5rem 0;
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
            font-style: italic;
        }

        /* Mobile */
        @media (max-width: 767px) {
            .eq-page {
                padding: 0.5rem;
            }

            .eq-header h1 {
                font-size: 1.25rem;
            }
        }
    `
});
