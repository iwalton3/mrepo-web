/**
 * Visualizer Page
 *
 * Fullscreen milkdrop-style visualizer using butterchurn.
 * Features:
 * - Canvas-based WebGL visualization
 * - Preset switching
 * - Bottom toolbar with playback controls
 * - Graceful degradation if butterchurn/WebGL unavailable
 */

import { defineComponent, html, when, each } from '../lib/framework.js';
import { player, playerStore } from '../stores/player-store.js';

// Visualizer mode localStorage key
const VISUALIZER_MODE_KEY = 'music-visualizer-mode';
const VISUALIZER_PRESET_KEY = 'music-visualizer-preset';
const VISUALIZER_RANDOM_PER_SONG_KEY = 'music-visualizer-random-per-song';
const VISUALIZER_PRESET_PACKS_KEY = 'music-visualizer-preset-packs';

// Local butterchurn files
const config = window.MREPO_CONFIG || {};
const BASE = config.basePath || '';
const BUTTERCHURN_URL = `${BASE}/vendor/butterchurn/butterchurn.min.js`;
const BUTTERCHURN_PRESETS_URL = `${BASE}/vendor/butterchurn/butterchurnPresets.min.js`;
const BUTTERCHURN_PRESET_META_URL = `${BASE}/vendor/butterchurn/presetPackMeta.min.js`;

// Available preset packs with descriptions
const PRESET_PACKS = [
    { id: 'base', label: 'Base', description: 'High quality curated presets' },
    { id: 'extra', label: 'Extra', description: 'Additional community presets' },
    { id: 'image', label: 'Image', description: 'Image-based presets' }
];

export default defineComponent('visualizer-page', {
    // NOTE: We intentionally do NOT subscribe to playerStore here.
    // Store subscriptions cause re-renders which interrupt the WebGL animation loop.
    // Instead, we access player state directly and update the toolbar manually.

    data() {
        // Load saved mode or default to butterchurn
        let savedMode = 'butterchurn';
        let savedRandomPerSong = false;
        let savedPresetPacks = ['base'];  // Default to base only
        try {
            savedMode = localStorage.getItem(VISUALIZER_MODE_KEY) || 'butterchurn';
            savedRandomPerSong = localStorage.getItem(VISUALIZER_RANDOM_PER_SONG_KEY) === 'true';
            const packsJson = localStorage.getItem(VISUALIZER_PRESET_PACKS_KEY);
            if (packsJson) {
                savedPresetPacks = JSON.parse(packsJson);
            }
        } catch (e) {}

        return {
            error: null,
            loading: true,
            mode: savedMode,  // 'butterchurn', 'spectrogram', 'waveform', 'both'
            presetNames: [],
            allPresetNames: [],  // All loaded presets before filtering
            currentPreset: '',
            showPresetMenu: false,
            showModeMenu: false,
            isFullscreen: false,
            randomPresetPerSong: savedRandomPerSong,
            enabledPacks: savedPresetPacks
        };
    },

    async mounted() {
        // Remove shell padding for fullscreen visualizer
        this._shell = this.closest('cl-shell');
        if (this._shell) {
            this._shell.style.setProperty('--shell-content-padding', '0');
            this._shell.style.setProperty('--shell-content-padding-bottom', '0');
        }

        // Wait for next frame to ensure refs are available
        await new Promise(r => requestAnimationFrame(r));
        await this._initVisualizer();
        this._startRenderLoop();

        // Handle resize
        this._resizeHandler = () => this._handleResize();
        window.addEventListener('resize', this._resizeHandler);

        // Handle fullscreen changes
        this._fullscreenHandler = () => {
            this.state.isFullscreen = !!document.fullscreenElement;
        };
        document.addEventListener('fullscreenchange', this._fullscreenHandler);

        // Request screen wake lock to prevent phone sleeping during visualizer
        this._requestWakeLock();
        this._visibilityHandler = () => {
            if (document.visibilityState === 'visible') {
                this._requestWakeLock();
            }
        };
        document.addEventListener('visibilitychange', this._visibilityHandler);
    },

    unmounted() {
        this._stopRenderLoop();

        // Restore shell padding
        if (this._shell) {
            this._shell.style.removeProperty('--shell-content-padding');
            this._shell.style.removeProperty('--shell-content-padding-bottom');
        }

        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
        }
        if (this._fullscreenHandler) {
            document.removeEventListener('fullscreenchange', this._fullscreenHandler);
        }

        // Unsubscribe from audio source changes
        if (this._unsubscribeAudioSource) {
            this._unsubscribeAudioSource();
            this._unsubscribeAudioSource = null;
        }

        // Release wake lock
        if (this._visibilityHandler) {
            document.removeEventListener('visibilitychange', this._visibilityHandler);
        }
        this._releaseWakeLock();

        // Always remove the analyser when leaving visualizer to save CPU
        // (FFT calculations are expensive even when not rendering)
        player.removeAnalyser();

        // Check if low latency is always enabled in settings
        let lowLatencyAlways = false;
        try {
            const stored = localStorage.getItem('music-low-latency-always');
            // Default to true on desktop, false on mobile
            const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
                             (navigator.maxTouchPoints > 0 && window.innerWidth < 768);
            lowLatencyAlways = stored !== null ? stored === 'true' : !isMobile;
        } catch (e) {}

        // Only switch back to high-latency mode if not always using low latency
        if (!lowLatencyAlways) {
            player.switchLatencyMode('playback');
        }
    },

    methods: {
        async _requestWakeLock() {
            if ('wakeLock' in navigator) {
                try {
                    this._wakeLock = await navigator.wakeLock.request('screen');
                } catch (e) {
                    // Wake lock request can fail (e.g., low battery, permission denied)
                    console.warn('Wake lock request failed:', e.message);
                }
            }
        },

        _releaseWakeLock() {
            if (this._wakeLock) {
                this._wakeLock.release().catch(() => {});
                this._wakeLock = null;
            }
        },

        async _initVisualizer() {
            try {
                // Check WebGL support
                const testCanvas = document.createElement('canvas');
                const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
                if (!gl) {
                    throw new Error('WebGL is not supported in this browser');
                }

                // Load butterchurn (ES module), presets (UMD script), and preset metadata
                const [butterchurnModule] = await Promise.all([
                    import(BUTTERCHURN_URL),
                    import(BUTTERCHURN_PRESETS_URL),
                    import(BUTTERCHURN_PRESET_META_URL)
                ]);

                // Get butterchurn from ES module default export
                const butterchurn = butterchurnModule.default || butterchurnModule;

                if (!butterchurn || !butterchurn.createVisualizer) {
                    throw new Error('butterchurn library not loaded correctly');
                }

                const butterchurnPresets = window.allButterchurnPresets.default;
                if (!butterchurnPresets) {
                    throw new Error('butterchurn presets not loaded correctly');
                }

                // Get preset pack metadata
                const presetPackMeta = window.presetPackMetaButterchurnPresets;
                if (presetPackMeta) {
                    this._presetPackMeta = {
                        base: presetPackMeta.getBasePresetKeys().presets,
                        extra: presetPackMeta.getExtraPresetKeys().presets,
                        image: presetPackMeta.getImagePresetKeys().presets
                    };
                }

                // Get the canvas
                const canvas = this.refs.canvas;
                if (!canvas) {
                    throw new Error('Canvas element not found');
                }

                // Switch to low-latency mode for synchronized visualizer
                // This recreates the audio element with latencyHint: 'interactive'
                // and returns the analyser node
                this._analyser = await player.switchLatencyMode('interactive');

                const audioContext = player.getAudioContext();

                // Validate audio context is available
                if (!audioContext) {
                    throw new Error('Audio context not available. Try playing a song first.');
                }

                // Get the combined pipeline node (mixer output when crossfade enabled, source otherwise)
                const visualizerInputNode = player.getVisualizerInputNode();
                if (!visualizerInputNode) {
                    throw new Error('Audio source not available. Try playing a song first.');
                }

                // Ensure audio context is running (may be suspended without user gesture)
                if (audioContext.state === 'suspended') {
                    await audioContext.resume();
                }

                // Set up 2D canvas context for spectrogram/waveform modes
                this._2dCanvas = this.refs.canvas2d;
                if (this._2dCanvas) {
                    this._2dCtx = this._2dCanvas.getContext('2d');
                }

                // Size canvas before creating visualizer
                const rect = this.refs.container.getBoundingClientRect();
                canvas.width = rect.width * (window.devicePixelRatio || 1);
                canvas.height = rect.height * (window.devicePixelRatio || 1);

                // Create visualizer
                const visualizer = butterchurn.createVisualizer(
                    audioContext,
                    canvas,
                    {
                        width: canvas.width,
                        height: canvas.height,
                        pixelRatio: window.devicePixelRatio || 1,
                        textureRatio: 1
                    }
                );

                // Connect to combined audio pipeline (sees both audio elements during crossfade)
                visualizer.connectAudio(visualizerInputNode);

                // Load presets
                const presets = butterchurnPresets;
                const allPresetNames = Object.keys(presets).sort();

                // Store visualizer directly on this (not in state) to avoid reactive proxy
                this._visualizer = visualizer;
                this._presets = presets;
                this.state.allPresetNames = allPresetNames;

                // Filter presets based on enabled packs
                this._updateFilteredPresets();

                // Set initial preset - restore saved or pick random
                if (this.state.presetNames.length > 0) {
                    let savedPreset = null;
                    try {
                        savedPreset = localStorage.getItem(VISUALIZER_PRESET_KEY);
                    } catch (e) {}

                    // Use saved preset if it exists and is valid, otherwise random
                    if (savedPreset && this.state.presetNames.includes(savedPreset)) {
                        this._setPreset(savedPreset);
                    } else {
                        this._randomPreset();
                    }
                }

                this.state.loading = false;
                this._handleResize();

                // If starting in butterchurn mode, remove the analyser from chain
                // (butterchurn has its own internal analyser)
                if (this.state.mode === 'butterchurn') {
                    player.removeAnalyser();
                }

                // Subscribe to audio source changes (e.g., after crossfade or pipeline rebuild)
                // Butterchurn reconnects to the combined pipeline node
                this._unsubscribeAudioSource = player.onAudioSourceChange(() => {
                    const inputNode = player.getVisualizerInputNode();
                    if (this._visualizer && inputNode) {
                        try {
                            this._visualizer.connectAudio(inputNode);
                        } catch (e) {
                            console.warn('Failed to reconnect visualizer audio:', e);
                        }
                    }
                });

            } catch (e) {
                console.error('Visualizer init error:', e);
                this.state.error = e.message;
                this.state.loading = false;
            }
        },

        _loadScript(url) {
            return new Promise((resolve, reject) => {
                // Check if already loaded
                if (document.querySelector(`script[src="${url}"]`)) {
                    resolve();
                    return;
                }

                const script = document.createElement('script');
                script.src = url;
                script.onload = resolve;
                script.onerror = () => reject(new Error(`Failed to load ${url}`));
                document.head.appendChild(script);
            });
        },

        _setPreset(name) {
            if (!this._visualizer || !this._presets[name]) return;

            this._visualizer.loadPreset(this._presets[name], 2.0); // 2 second blend
            this.state.currentPreset = name;
            this.state.showPresetMenu = false;

            // Save preset to localStorage for persistence
            try {
                localStorage.setItem(VISUALIZER_PRESET_KEY, name);
            } catch (e) {}
        },

        _randomPreset() {
            const names = this.state.presetNames;
            if (names.length === 0) return;
            const randomIndex = Math.floor(Math.random() * names.length);
            this._setPreset(names[randomIndex]);
        },

        _checkSongChange() {
            const currentUuid = playerStore.state.currentSong?.uuid || null;
            if (currentUuid && currentUuid !== this._lastSongUuid) {
                this._lastSongUuid = currentUuid;
                // Trigger random preset if enabled and in butterchurn mode
                if (this.state.randomPresetPerSong && this.state.mode === 'butterchurn') {
                    this._randomPreset();
                }
            }
        },

        toggleRandomPerSong() {
            this.state.randomPresetPerSong = !this.state.randomPresetPerSong;
            try {
                localStorage.setItem(VISUALIZER_RANDOM_PER_SONG_KEY, String(this.state.randomPresetPerSong));
            } catch (e) {}
        },

        togglePresetPack(packId) {
            const packs = [...this.state.enabledPacks];
            const index = packs.indexOf(packId);
            if (index === -1) {
                packs.push(packId);
            } else {
                // Don't allow disabling all packs
                if (packs.length > 1) {
                    packs.splice(index, 1);
                }
            }
            this.state.enabledPacks = packs;

            // Save to localStorage
            try {
                localStorage.setItem(VISUALIZER_PRESET_PACKS_KEY, JSON.stringify(packs));
            } catch (e) {}

            // Update filtered presets
            this._updateFilteredPresets();
        },

        _updateFilteredPresets() {
            if (!this._presetPackMeta || !this.state.allPresetNames) {
                // No metadata loaded, use all presets
                this.state.presetNames = this.state.allPresetNames || [];
                return;
            }

            // Build set of allowed presets from enabled packs
            const allowedPresets = new Set();
            for (const packId of this.state.enabledPacks) {
                const packPresets = this._presetPackMeta[packId];
                if (packPresets) {
                    for (const name of packPresets) {
                        allowedPresets.add(name);
                    }
                }
            }

            // Filter to only allowed presets
            this.state.presetNames = this.state.allPresetNames.filter(name => allowedPresets.has(name));
        },

        _handleResize() {
            const canvas = this.refs.canvas;
            const canvas2d = this.refs.canvas2d;
            const container = this.refs.container;
            if (!container) return;

            const rect = container.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;

            // Resize WebGL canvas (butterchurn)
            if (canvas) {
                canvas.width = rect.width * dpr;
                canvas.height = rect.height * dpr;

                if (this._visualizer) {
                    this._visualizer.setRendererSize(canvas.width, canvas.height);
                }
            }

            // Resize 2D canvas (spectrogram/waveform)
            if (canvas2d) {
                canvas2d.width = rect.width * dpr;
                canvas2d.height = rect.height * dpr;

                // Clear the 2D canvas on resize
                if (this._2dCtx) {
                    this._2dCtx.fillStyle = '#000';
                    this._2dCtx.fillRect(0, 0, canvas2d.width, canvas2d.height);
                }

                // Pre-allocate spectrogram color lookup table for performance
                this._spectrogramColors = new Array(256);
                for (let i = 0; i < 256; i++) {
                    const normalized = i / 255;
                    const hue = 240 - normalized * 240;
                    const lightness = 5 + normalized * 45;
                    // Pre-compute RGB values
                    const rgb = this._hslToRgb(hue / 360, 1, lightness / 100);
                    this._spectrogramColors[i] = rgb;
                }
            }
        },

        _hslToRgb(h, s, l) {
            let r, g, b;
            if (s === 0) {
                r = g = b = l;
            } else {
                const hue2rgb = (p, q, t) => {
                    if (t < 0) t += 1;
                    if (t > 1) t -= 1;
                    if (t < 1/6) return p + (q - p) * 6 * t;
                    if (t < 1/2) return q;
                    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                    return p;
                };
                const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                const p = 2 * l - q;
                r = hue2rgb(p, q, h + 1/3);
                g = hue2rgb(p, q, h);
                b = hue2rgb(p, q, h - 1/3);
            }
            return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
        },

        _startRenderLoop() {
            let lastTime = 0;
            let lastToolbarUpdate = 0;
            // Track current song to detect changes
            this._lastSongUuid = playerStore.state.currentSong?.uuid || null;

            const render = (time) => {
                // Render based on current mode at ~60fps
                if (time - lastTime >= 16) {
                    switch (this.state.mode) {
                        case 'butterchurn':
                            if (this._visualizer) {
                                this._visualizer.render();
                            }
                            break;
                        case 'spectrogram':
                            this._renderSpectrogram(false);
                            break;
                        case 'waveform':
                            this._renderWaveform();
                            break;
                        case 'both':
                            this._renderSplitView();  // Waveform on top, spectrogram on bottom
                            break;
                    }
                    lastTime = time;
                }

                // Update toolbar at ~4fps (every 250ms) to avoid DOM thrashing
                if (time - lastToolbarUpdate >= 250) {
                    this._updateToolbar();
                    this._checkSongChange();
                    lastToolbarUpdate = time;
                }

                this._animationFrame = requestAnimationFrame(render);
            };

            this._animationFrame = requestAnimationFrame(render);
        },

        _renderSpectrogram() {
            if (!this._analyser || !this._2dCtx || !this._spectrogramColors) return;

            const canvas = this._2dCanvas;
            const ctx = this._2dCtx;
            const analyser = this._analyser;
            const colors = this._spectrogramColors;

            const bufferLength = analyser.frequencyBinCount;

            // Reuse frequency data array
            if (!this._freqData || this._freqData.length !== bufferLength) {
                this._freqData = new Uint8Array(bufferLength);
            }
            analyser.getByteFrequencyData(this._freqData);

            // Shift existing image left by 2 pixels
            const shiftAmount = 2;
            const imageData = ctx.getImageData(shiftAmount, 0, canvas.width - shiftAmount, canvas.height);
            ctx.putImageData(imageData, 0, 0);

            // Create ImageData for the new column
            const colData = ctx.createImageData(shiftAmount, canvas.height);
            const pixels = colData.data;

            // Draw new column using pre-computed colors
            for (let y = 0; y < canvas.height; y++) {
                // Map canvas Y to frequency bin (low freq at bottom, log scale)
                const normalizedY = (canvas.height - 1 - y) / canvas.height;
                const logIndex = Math.pow(normalizedY, 2) * bufferLength;
                const freqIndex = Math.min(logIndex | 0, bufferLength - 1);  // Bitwise floor
                const value = this._freqData[freqIndex];
                const rgb = colors[value];

                // Fill both pixels of the column width
                for (let x = 0; x < shiftAmount; x++) {
                    const idx = (y * shiftAmount + x) * 4;
                    pixels[idx] = rgb[0];
                    pixels[idx + 1] = rgb[1];
                    pixels[idx + 2] = rgb[2];
                    pixels[idx + 3] = 255;
                }
            }

            ctx.putImageData(colData, canvas.width - shiftAmount, 0);
        },

        _renderSplitView() {
            if (!this._analyser || !this._2dCtx || !this._spectrogramColors) return;

            const canvas = this._2dCanvas;
            const ctx = this._2dCtx;
            const analyser = this._analyser;
            const colors = this._spectrogramColors;

            const halfHeight = Math.floor(canvas.height / 2);
            const bufferLength = analyser.frequencyBinCount;

            // Reuse data arrays
            if (!this._waveData || this._waveData.length !== analyser.fftSize) {
                this._waveData = new Uint8Array(analyser.fftSize);
            }
            if (!this._freqData || this._freqData.length !== bufferLength) {
                this._freqData = new Uint8Array(bufferLength);
            }

            analyser.getByteTimeDomainData(this._waveData);
            analyser.getByteFrequencyData(this._freqData);

            // --- Top half: Waveform ---
            ctx.fillStyle = 'rgb(0, 0, 0)';
            ctx.fillRect(0, 0, canvas.width, halfHeight);

            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgb(0, 255, 128)';
            ctx.beginPath();

            const sliceWidth = canvas.width / this._waveData.length;
            let x = 0;

            for (let i = 0; i < this._waveData.length; i++) {
                const v = this._waveData[i] / 128.0;
                const y = (v * halfHeight) / 2;

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
                x += sliceWidth;
            }
            ctx.stroke();

            // Draw divider line
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, halfHeight);
            ctx.lineTo(canvas.width, halfHeight);
            ctx.stroke();

            // --- Bottom half: Spectrogram ---
            const shiftAmount = 2;
            const spectrogramHeight = canvas.height - halfHeight;
            const imageData = ctx.getImageData(shiftAmount, halfHeight, canvas.width - shiftAmount, spectrogramHeight);
            ctx.putImageData(imageData, 0, halfHeight);

            // Create ImageData for the new column
            const colData = ctx.createImageData(shiftAmount, spectrogramHeight);
            const pixels = colData.data;

            for (let y = 0; y < spectrogramHeight; y++) {
                const normalizedY = (spectrogramHeight - 1 - y) / spectrogramHeight;
                const logIndex = Math.pow(normalizedY, 2) * bufferLength;
                const freqIndex = Math.min(logIndex | 0, bufferLength - 1);
                const value = this._freqData[freqIndex];
                const rgb = colors[value];

                for (let xOff = 0; xOff < shiftAmount; xOff++) {
                    const idx = (y * shiftAmount + xOff) * 4;
                    pixels[idx] = rgb[0];
                    pixels[idx + 1] = rgb[1];
                    pixels[idx + 2] = rgb[2];
                    pixels[idx + 3] = 255;
                }
            }

            ctx.putImageData(colData, canvas.width - shiftAmount, halfHeight);
        },

        _renderWaveform() {
            if (!this._analyser || !this._2dCtx) return;

            const canvas = this._2dCanvas;
            const ctx = this._2dCtx;
            const analyser = this._analyser;
            const bufferLength = analyser.fftSize;

            // Reuse waveform data array
            if (!this._waveData || this._waveData.length !== bufferLength) {
                this._waveData = new Uint8Array(bufferLength);
            }
            analyser.getByteTimeDomainData(this._waveData);

            // Clear with black
            ctx.fillStyle = 'rgb(0, 0, 0)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Draw waveform
            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgb(0, 255, 128)';
            ctx.beginPath();

            const sliceWidth = canvas.width / bufferLength;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                const v = this._waveData[i] / 128.0;
                const y = (v * canvas.height) / 2;

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
                x += sliceWidth;
            }

            ctx.stroke();
        },

        closeModeMenu() {
            this.state.showModeMenu = false;
        },

        setMode(mode) {
            this.state.showModeMenu = false;  // Close menu

            if (mode === this.state.mode) return;

            const wasButterchurn = this.state.mode === 'butterchurn';
            const isButterchurn = mode === 'butterchurn';

            this.state.mode = mode;

            // Save preference
            try {
                localStorage.setItem(VISUALIZER_MODE_KEY, mode);
            } catch (e) {}

            // Manage analyser for performance:
            // - Butterchurn has its own analyser, so remove ours from the chain
            // - Spectrogram/waveform/both need our analyser in the chain
            if (wasButterchurn && !isButterchurn) {
                // Switching FROM butterchurn - need to insert analyser for 2D modes
                if (this._analyser) {
                    player.insertAnalyser(this._analyser);
                }
            } else if (!wasButterchurn && isButterchurn) {
                // Switching TO butterchurn - remove analyser to save CPU
                player.removeAnalyser();
            }

            // Clear 2D canvas when switching modes
            if (this._2dCtx && this._2dCanvas) {
                this._2dCtx.fillStyle = '#000';
                this._2dCtx.fillRect(0, 0, this._2dCanvas.width, this._2dCanvas.height);
            }
        },

        _updateToolbar() {
            // Manually update toolbar elements without triggering reactive re-render
            // Use store state instead of direct audio element references to handle crossfade element swaps
            const state = playerStore.state;

            // Update play/pause button
            const playBtn = this.querySelector('.play-btn');
            if (playBtn) {
                const isPlaying = state.isPlaying;
                playBtn.title = isPlaying ? 'Pause' : 'Play';
                // Update icon
                const iconHtml = isPlaying
                    ? '<span class="pause-icon"></span>'
                    : '<span class="play-icon"></span>';
                if (playBtn.innerHTML !== iconHtml) {
                    playBtn.innerHTML = iconHtml;
                }
            }

            // Update time display
            const timeEl = this.querySelector('.song-time');
            if (timeEl) {
                const currentTime = state.currentTime || 0;
                const duration = state.duration || 0;
                timeEl.textContent = `${this.formatTime(currentTime)} / ${this.formatTime(duration)}`;
            }

            // Update song title
            const titleEl = this.querySelector('.song-title');
            if (titleEl && state.currentSong) {
                const title = this.getDisplayTitle(state.currentSong);
                if (titleEl.textContent !== title) {
                    titleEl.textContent = title;
                }
            }
        },

        _stopRenderLoop() {
            if (this._animationFrame) {
                cancelAnimationFrame(this._animationFrame);
                this._animationFrame = null;
            }
        },

        togglePresetMenu() {
            this.state.showPresetMenu = !this.state.showPresetMenu;
        },

        async toggleFullscreen() {
            try {
                if (document.fullscreenElement) {
                    await document.exitFullscreen();
                } else {
                    await this.refs.container?.requestFullscreen();
                }
            } catch (e) {
                console.warn('Fullscreen error:', e);
            }
        },

        // Playback controls
        handlePlayPause() {
            player.togglePlayPause();
        },

        handlePrevious() {
            player.previous();
        },

        handleNext() {
            player.next();
        },

        formatTime(seconds) {
            if (!seconds || isNaN(seconds)) return '0:00';
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        },

        getDisplayTitle(song) {
            if (!song) return 'No song playing';
            if (song.title) return song.title;
            const path = song.virtual_file || song.file || '';
            const filename = path.split('/').pop() || '';
            return filename.replace(/\.[^.]+$/, '') || 'Unknown';
        }
    },

    template() {
        const { error, loading, mode, presetNames, currentPreset, showPresetMenu, showModeMenu, isFullscreen } = this.state;
        // Access player state directly (non-reactively) to avoid re-renders
        const currentSong = playerStore.state.currentSong;
        const isPlaying = playerStore.state.isPlaying;

        return html`
            <div class="visualizer-container" ref="container">
                ${when(loading, () => html`
                    <div class="loading-overlay">
                        <div class="loading-spinner"></div>
                        <p>Loading visualizer...</p>
                    </div>
                `)}

                ${when(error, () => html`
                    <div class="error-overlay">
                        <div class="error-icon">⚠️</div>
                        <h2>Visualizer Unavailable</h2>
                        <p>${error}</p>
                        <p class="error-hint">Try using a browser with WebGL support.</p>
                    </div>
                `)}

                <!-- WebGL canvas for butterchurn -->
                <canvas ref="canvas" class="visualizer-canvas ${mode !== 'butterchurn' ? 'hidden' : ''}"></canvas>

                <!-- 2D canvas for spectrogram/waveform/both -->
                <canvas ref="canvas2d" class="visualizer-canvas canvas-2d ${mode === 'butterchurn' ? 'hidden' : ''}"></canvas>

                <!-- Preset selector overlay -->
                ${when(showPresetMenu && !error, () => html`
                    <div class="preset-overlay" on-click="${() => this.state.showPresetMenu = false}">
                        <div class="preset-menu" on-click="${(e) => e.stopPropagation()}">
                            <div class="preset-header">
                                <h3>Select Preset</h3>
                                <button class="close-btn" on-click="${() => this.state.showPresetMenu = false}">×</button>
                            </div>
                            <div class="preset-options">
                                <div class="preset-option-row">
                                    <label class="preset-option">
                                        <input type="checkbox"
                                               checked="${this.state.randomPresetPerSong}"
                                               on-change="toggleRandomPerSong">
                                        <span>Random preset each song</span>
                                    </label>
                                    <span class="preset-count">${presetNames.length} presets</span>
                                </div>
                                <div class="preset-packs">
                                    <span class="pack-label">Packs:</span>
                                    ${each(PRESET_PACKS, pack => html`
                                        <label class="pack-option" title="${pack.description}">
                                            <input type="checkbox"
                                                   checked="${this.state.enabledPacks.includes(pack.id)}"
                                                   on-change="${() => this.togglePresetPack(pack.id)}">
                                            <span>${pack.label}</span>
                                        </label>
                                    `)}
                                </div>
                            </div>
                            <div class="preset-list">
                                ${each(presetNames, name => html`
                                    <button class="preset-item ${name === currentPreset ? 'active' : ''}"
                                            on-click="${() => this._setPreset(name)}">
                                        ${name}
                                    </button>
                                `)}
                            </div>
                        </div>
                    </div>
                `)}

                <!-- Bottom toolbar -->
                <div class="toolbar">
                    <div class="toolbar-left">
                        <!-- Mode selector dropdown -->
                        <div class="mode-dropdown">
                            <button class="toolbar-btn" on-click="${() => this.state.showModeMenu = !this.state.showModeMenu}" title="Visualizer mode">
                                ${mode === 'butterchurn' ? '🎆' : mode === 'spectrogram' ? '📊' : mode === 'waveform' ? '〰️' : '⚡'}
                            </button>
                            ${when(showModeMenu, () => html`
                                <div class="mode-menu" on-click-outside-stop="closeModeMenu">
                                    <button class="mode-item ${mode === 'butterchurn' ? 'active' : ''}"
                                            on-click="${() => this.setMode('butterchurn')}">
                                        <span>🎆</span> Milkdrop
                                    </button>
                                    <button class="mode-item ${mode === 'spectrogram' ? 'active' : ''}"
                                            on-click="${() => this.setMode('spectrogram')}">
                                        <span>📊</span> Spectrogram
                                    </button>
                                    <button class="mode-item ${mode === 'waveform' ? 'active' : ''}"
                                            on-click="${() => this.setMode('waveform')}">
                                        <span>〰️</span> Waveform
                                    </button>
                                    <button class="mode-item ${mode === 'both' ? 'active' : ''}"
                                            on-click="${() => this.setMode('both')}">
                                        <span>⚡</span> Both
                                    </button>
                                </div>
                            `)}
                        </div>

                        <!-- Butterchurn preset controls (only show in butterchurn mode) -->
                        ${when(mode === 'butterchurn', () => html`
                            <button class="toolbar-btn" on-click="togglePresetMenu" title="Change preset">
                                🎨
                            </button>
                            <button class="toolbar-btn" on-click="${() => this._randomPreset()}" title="Random preset">
                                🎲
                            </button>
                            <span class="preset-name" title="${currentPreset}">${currentPreset || 'No preset'}</span>
                        `)}
                    </div>

                    <div class="toolbar-center">
                        <button class="ctrl-btn" on-click="handlePrevious" title="Previous">
                            <span class="icon">⏮</span>
                        </button>
                        <button class="ctrl-btn play-btn" on-click="handlePlayPause" title="${isPlaying ? 'Pause' : 'Play'}">
                            ${isPlaying ? html`<span class="pause-icon"></span>` : html`<span class="play-icon"></span>`}
                        </button>
                        <button class="ctrl-btn" on-click="handleNext" title="Next">
                            <span class="icon">⏭</span>
                        </button>
                    </div>

                    <div class="toolbar-right">
                        <div class="song-info">
                            <span class="song-title">${this.getDisplayTitle(currentSong)}</span>
                            <span class="song-time">0:00 / 0:00</span>
                        </div>
                        <button class="toolbar-btn" on-click="toggleFullscreen" title="${isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}">
                            ${isFullscreen ? '⛶' : '⛶'}
                        </button>
                    </div>
                </div>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
            height: 100%;
            width: 100%;
            background: #000;
        }

        .visualizer-container {
            position: relative;
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            background: #000;
        }

        .visualizer-canvas {
            flex: 1;
            width: 100%;
            min-height: 0;  /* Allow flex shrinking */
            display: block;
            position: relative;
            z-index: 1;
        }

        .visualizer-canvas.hidden {
            /* Use visibility instead of display:none to preserve WebGL context.
               display:none causes WebGL context loss in most browsers. */
            visibility: hidden;
            position: absolute;
            top: 0;
            left: 0;
            z-index: 0;
            flex: none;
        }

        .canvas-2d {
            background: #000;
        }

        .loading-overlay,
        .error-overlay {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.9);
            color: #fff;
            z-index: 10;
        }

        .loading-spinner {
            width: 50px;
            height: 50px;
            border: 3px solid rgba(255, 255, 255, 0.3);
            border-top-color: #fff;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .error-icon {
            font-size: 4rem;
            margin-bottom: 1rem;
        }

        .error-overlay h2 {
            margin: 0 0 0.5rem;
        }

        .error-overlay p {
            margin: 0.25rem 0;
            color: #aaa;
        }

        .error-hint {
            font-size: 0.875rem;
        }

        /* Preset overlay */
        .preset-overlay {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 60px;
            background: rgba(0, 0, 0, 0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 20;
        }

        .preset-menu {
            background: #1a1a1a;
            border-radius: 8px;
            width: 90%;
            max-width: 500px;
            max-height: 80%;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .preset-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 1rem;
            border-bottom: 1px solid #333;
        }

        .preset-header h3 {
            margin: 0;
            color: #fff;
        }

        .close-btn {
            background: none;
            border: none;
            color: #888;
            font-size: 1.5rem;
            cursor: pointer;
            padding: 0;
            line-height: 1;
        }

        .close-btn:hover {
            color: #fff;
        }

        .preset-options {
            border-bottom: 1px solid #333;
            padding: 0.75rem 1rem;
        }

        .preset-option-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .preset-option {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            color: #ccc;
            cursor: pointer;
            font-size: 0.875rem;
        }

        .preset-option:hover {
            color: #fff;
        }

        .preset-option input[type="checkbox"],
        .pack-option input[type="checkbox"] {
            width: 16px;
            height: 16px;
            accent-color: #2a4a6a;
        }

        .preset-packs {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            margin-top: 0.75rem;
            flex-wrap: wrap;
        }

        .pack-label {
            color: #888;
            font-size: 0.8rem;
        }

        .pack-option {
            display: flex;
            align-items: center;
            gap: 0.35rem;
            color: #ccc;
            cursor: pointer;
            font-size: 0.8rem;
        }

        .pack-option:hover {
            color: #fff;
        }

        .preset-count {
            color: #666;
            font-size: 0.75rem;
        }

        .preset-list {
            flex: 1;
            overflow-y: auto;
            padding: 0.5rem;
        }

        .preset-item {
            display: block;
            width: 100%;
            text-align: left;
            background: none;
            border: none;
            color: #ccc;
            padding: 0.75rem 1rem;
            cursor: pointer;
            border-radius: 4px;
            font-size: 0.875rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .preset-item:hover {
            background: #333;
        }

        .preset-item.active {
            background: #2a4a6a;
            color: #fff;
        }

        /* Mode Dropdown */
        .mode-dropdown {
            position: relative;
        }

        .mode-menu {
            position: absolute;
            bottom: 100%;
            left: 0;
            margin-bottom: 8px;
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 4px;
            min-width: 140px;
            z-index: 100;
            animation: fadeIn 0.15s ease-out;
        }

        .mode-item {
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
            padding: 8px 12px;
            background: none;
            border: none;
            color: #ccc;
            font-size: 0.875rem;
            cursor: pointer;
            border-radius: 4px;
            text-align: left;
        }

        .mode-item:hover {
            background: #333;
            color: #fff;
        }

        .mode-item.active {
            background: #2a4a6a;
            color: #fff;
        }

        .mode-item span {
            font-size: 1rem;
        }

        /* Toolbar */
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.75rem 1rem;
            background: rgba(0, 0, 0, 0.9);
            border-top: 1px solid #333;
            gap: 1rem;
            min-height: 60px;
        }

        .toolbar-left,
        .toolbar-center,
        .toolbar-right {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .toolbar-left {
            flex: 1;
            min-width: 0;
        }

        .toolbar-right {
            flex: 1;
            justify-content: flex-end;
            min-width: 0;
        }

        .toolbar-btn {
            background: rgba(255, 255, 255, 0.1);
            border: none;
            color: #fff;
            width: 40px;
            height: 40px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 1.25rem;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }

        .toolbar-btn:hover {
            background: rgba(255, 255, 255, 0.2);
        }

        .ctrl-btn {
            background: var(--surface-200, #2d2d2d);
            border: 1px solid var(--surface-300, #404040);
            cursor: pointer;
            width: 44px;
            height: 44px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s ease;
        }

        /* Make prev/next emoji icons white */
        .ctrl-btn .icon {
            line-height: 1;
            filter: brightness(0) invert(1);
        }

        .ctrl-btn:hover {
            background: var(--surface-300, #404040);
            border-color: var(--surface-400, #505050);
        }

        .ctrl-btn:active {
            transform: scale(0.95);
        }

        .ctrl-btn.play-btn {
            width: 52px;
            height: 52px;
            background: var(--primary-500, #0066cc);
            border-color: var(--primary-500, #0066cc);
        }

        .ctrl-btn.play-btn:hover {
            background: var(--primary-400, #3399ff);
            border-color: var(--primary-400, #3399ff);
        }

        /* CSS play triangle */
        .play-icon {
            width: 0;
            height: 0;
            border-style: solid;
            border-width: 9px 0 9px 15px;
            border-color: transparent transparent transparent white;
            margin-left: 4px;
        }

        /* CSS pause bars */
        .pause-icon {
            display: flex;
            gap: 4px;
        }

        .pause-icon::before,
        .pause-icon::after {
            content: '';
            width: 5px;
            height: 18px;
            background: white;
            border-radius: 1px;
        }

        .preset-name {
            color: #888;
            font-size: 0.75rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 150px;
        }

        .song-info {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            min-width: 0;
        }

        .song-title {
            color: #fff;
            font-size: 0.875rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 200px;
        }

        .song-time {
            color: #888;
            font-size: 0.75rem;
        }

        /* Mobile adjustments - single row layout */
        @media (max-width: 600px) {
            .toolbar {
                padding: 0.5rem;
                gap: 0.5rem;
            }

            .toolbar-left {
                flex: 0 0 auto;
            }

            .toolbar-center {
                flex: 0 0 auto;
            }

            .toolbar-right {
                flex: 0 0 auto;
            }

            .toolbar-btn {
                width: 36px;
                height: 36px;
                font-size: 1rem;
            }

            .ctrl-btn {
                width: 38px;
                height: 38px;
            }

            .ctrl-btn.play-btn {
                width: 44px;
                height: 44px;
            }

            .preset-name {
                display: none;
            }

            .song-info {
                display: none;
            }
        }

        /* Fullscreen styles */
        .visualizer-container:fullscreen {
            background: #000;
        }

        .visualizer-container:fullscreen .toolbar {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            opacity: 0;
            transition: opacity 0.3s;
        }

        .visualizer-container:fullscreen:hover .toolbar {
            opacity: 1;
        }
    `
});
