/**
 * Parametric EQ Editor Component
 *
 * Full parametric equalizer with:
 * - Interactive frequency response graph
 * - Dynamic band management (add/remove/edit)
 * - Preset management (save/load/delete)
 * - Real-time audio preview
 */

import { defineComponent, html, when, each } from '../lib/framework.js';
import eqPresetsStore, { FILTER_TYPES, createDefaultBand, graphicToParametric } from '../stores/eq-presets-store.js';
import player, { EQ_BANDS } from '../stores/player-store.js';
import './eq-response-canvas.js';
import '../componentlib/overlay/dialog.js';
import '../componentlib/button/button.js';

export default defineComponent('parametric-eq-editor', {
    props: {
        visible: false
    },

    data() {
        return {
            // Working copy of bands (editable)
            bands: [],

            // Selected band index for highlighting
            selectedBand: -1,

            // Presets from store
            presets: [],
            activePresetUuid: null,

            // UI state
            isLoading: false,
            error: null,
            saveDialogVisible: false,
            saveName: '',
            saveAsNew: false,

            // Track if bands have been modified from the original preset
            isDirty: false,

            // Editing state (to prevent input override while typing)
            editingFreqIndex: -1,
            editingFreqValue: '',
            editingGainIndex: -1,
            editingGainValue: '',
            editingQIndex: -1,
            editingQValue: '',

            // Import dialog
            importDialogVisible: false,
            importText: '',

            // Confirm dialog
            confirmDialog: { show: false, title: '', message: '', action: null }
        };
    },

    stores: { eqPresetsStore },

    async mounted() {
        // Detect Firefox for touch handling CSS
        if (/Firefox/i.test(navigator.userAgent)) {
            this.classList.add('firefox');
        }

        // Load presets from API
        await eqPresetsStore.loadPresets();
        this._syncFromStore();

        // Apply EQ on mount if we have bands
        if (this.state.bands.length > 0) {
            this._applyToPlayer();
        }

        // Subscribe to store changes
        this._unsubscribe = eqPresetsStore.subscribe(() => {
            this._syncFromStore();
        });
    },

    unmounted() {
        if (this._unsubscribe) {
            this._unsubscribe();
        }
    },

    propsChanged(prop, newValue, oldValue) {
        if (prop === 'visible' && newValue && !oldValue) {
            // Editor opened - refresh data
            this._syncFromStore();
        }
    },

    methods: {
        _syncFromStore() {
            this.state.presets = [...eqPresetsStore.state.presets];
            this.state.activePresetUuid = eqPresetsStore.state.activePresetUuid;
            this.state.isLoading = eqPresetsStore.state.isLoading;
            this.state.error = eqPresetsStore.state.error;

            // Load active bands
            const activeBands = eqPresetsStore.getActiveBands();
            this.state.bands = JSON.parse(JSON.stringify(activeBands || []));
            this.state.isDirty = false;
        },

        handleBandChange(e) {
            const { index, frequency, gain } = e.detail;
            if (index >= 0 && index < this.state.bands.length) {
                this.state.bands[index] = {
                    ...this.state.bands[index],
                    frequency,
                    gain
                };
                this.state.isDirty = true;
                this._applyToPlayer();
                // Don't emit here - canvas fires continuously during drag
            }
        },

        // Called when canvas drag ends
        handleBandChangeEnd(e) {
            this._emitBandsChanged();
        },

        handleBandSelect(e) {
            this.state.selectedBand = e.detail.index;
        },

        handleTypeChange(index, e) {
            this.state.bands[index] = {
                ...this.state.bands[index],
                type: e.target.value
            };
            this.state.isDirty = true;
            this._applyToPlayer();
            this._emitBandsChanged();
        },

        handleFreqFocus(index, e) {
            // Set value BEFORE index to avoid empty render
            this.state.editingFreqValue = e.target.value;
            this.state.editingFreqIndex = index;
        },

        handleFreqInput(index, e) {
            if (this.state.editingFreqIndex === index) {
                this.state.editingFreqValue = e.target.value;
            }
        },

        handleFreqBlur(index, e) {
            const freq = parseInt(e.target.value, 10);
            if (!isNaN(freq) && freq >= 20 && freq <= 20000) {
                this.state.bands[index] = {
                    ...this.state.bands[index],
                    frequency: freq
                };
                this.state.isDirty = true;
                this._applyToPlayer();
                this._emitBandsChanged();
            }
            this.state.editingFreqIndex = -1;
            this.state.editingFreqValue = '';
        },

        handleGainSliderChange(index, e) {
            const gain = parseFloat(e.target.value);
            if (!isNaN(gain)) {
                this.state.bands[index] = {
                    ...this.state.bands[index],
                    gain: Math.max(-24, Math.min(24, gain))
                };
                this.state.isDirty = true;
                this._applyToPlayer();
                // Don't emit here - slider fires continuously during drag
            }
        },

        handleGainSliderEnd(index, e) {
            // Don't emit if this was a scroll gesture that got reverted
            if (!this._sliderScrolling) {
                this._emitBandsChanged();
            }
            this._sliderScrolling = false;
        },

        // Mobile: browser-specific touch handling for sliders
        // Firefox: touch-action CSS doesn't work, need full JS control
        // Chrome/Safari: touch-action: pan-y works, minimal JS needed
        _isFirefox() {
            return /Firefox/i.test(navigator.userAgent);
        },

        handleSliderTouchStart(index, field, e) {
            const touch = e.touches[0];
            const band = this.state.bands[index];
            const isFirefox = this._isFirefox();

            // Firefox: prevent default to take full control
            if (isFirefox) {
                e.preventDefault();
            }

            this._sliderTouch = {
                index,
                field,
                startX: touch.clientX,
                startY: touch.clientY,
                lastY: touch.clientY,
                startValue: field === 'gain' ? band.gain : band.q,
                sliderRect: e.target.getBoundingClientRect(),
                decided: false,
                isScrolling: false,
                isFirefox
            };
        },

        handleSliderTouchMove(index, field, e) {
            if (!this._sliderTouch) return;

            const touch = e.touches[0];
            const deltaX = Math.abs(touch.clientX - this._sliderTouch.startX);
            const deltaY = Math.abs(touch.clientY - this._sliderTouch.startY);

            // Need some movement to decide direction
            if (!this._sliderTouch.decided && (deltaX >= 8 || deltaY >= 8)) {
                this._sliderTouch.decided = true;
                this._sliderTouch.isScrolling = deltaY > deltaX;
            }

            if (!this._sliderTouch.decided) return;

            if (this._sliderTouch.isScrolling) {
                // Revert slider to start value (works on all browsers)
                const { index: i, field: f, startValue } = this._sliderTouch;
                const band = this.state.bands[i];
                if (band[f] !== startValue) {
                    this.state.bands[i] = { ...band, [f]: startValue };
                    this._applyToPlayer();
                }

                // Firefox only: manually scroll (CSS doesn't work)
                if (this._sliderTouch.isFirefox) {
                    const scrollDelta = this._sliderTouch.lastY - touch.clientY;
                    this._sliderTouch.lastY = touch.clientY;
                    const scrollContainer = this.closest('.router-wrapper') ||
                                            document.documentElement;
                    scrollContainer.scrollTop += scrollDelta;
                }
            } else if (this._sliderTouch.isFirefox) {
                // Firefox only: manual slider update (since we prevented default)
                const rect = this._sliderTouch.sliderRect;
                const ratio = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
                const band = this.state.bands[index];
                let newValue;

                if (field === 'gain') {
                    newValue = -24 + ratio * 48;
                    newValue = Math.round(newValue * 2) / 2;
                } else {
                    newValue = this._sliderToQ(ratio * 100);
                    newValue = parseFloat(newValue.toFixed(3));
                }

                if (band[field] !== newValue) {
                    this.state.bands[index] = { ...band, [field]: newValue };
                    this._applyToPlayer();
                }
            }
        },

        handleSliderTouchEnd(index, field, e) {
            if (!this._sliderTouch) return;

            // Emit change if slider was actually modified
            if (!this._sliderTouch.isScrolling) {
                const band = this.state.bands[this._sliderTouch.index];
                const currentValue = this._sliderTouch.field === 'gain' ? band.gain : band.q;
                if (currentValue !== this._sliderTouch.startValue) {
                    this._emitBandsChanged();
                }
            }
            this._sliderTouch = null;
        },

        handleGainInputFocus(index, e) {
            // Set value BEFORE index to avoid empty render
            this.state.editingGainValue = e.target.value;
            this.state.editingGainIndex = index;
        },

        handleGainInputChange(index, e) {
            if (this.state.editingGainIndex === index) {
                this.state.editingGainValue = e.target.value;
            }
        },

        // Q slider uses logarithmic scale for better UX
        // Slider value 0-100 maps to Q 0.1-18 logarithmically
        _sliderToQ(sliderValue) {
            const minQ = 0.1;
            const maxQ = 18;
            const logMin = Math.log10(minQ);
            const logMax = Math.log10(maxQ);
            const logValue = logMin + (sliderValue / 100) * (logMax - logMin);
            return Math.pow(10, logValue);
        },

        _qToSlider(q) {
            const minQ = 0.1;
            const maxQ = 18;
            const logMin = Math.log10(minQ);
            const logMax = Math.log10(maxQ);
            const logValue = Math.log10(Math.max(minQ, Math.min(maxQ, q)));
            return ((logValue - logMin) / (logMax - logMin)) * 100;
        },

        handleQSliderChange(index, e) {
            const sliderValue = parseFloat(e.target.value);
            const q = this._sliderToQ(sliderValue);
            this.state.bands[index] = {
                ...this.state.bands[index],
                q: parseFloat(q.toFixed(3))
            };
            this.state.isDirty = true;
            this._applyToPlayer();
            // Don't emit here - slider fires continuously during drag
        },

        handleQSliderEnd(index, e) {
            // Don't emit if this was a scroll gesture that got reverted
            if (!this._sliderScrolling) {
                this._emitBandsChanged();
            }
            this._sliderScrolling = false;
        },

        handleGainInputBlur(index, e) {
            const gain = parseFloat(e.target.value);
            if (!isNaN(gain)) {
                this.state.bands[index] = {
                    ...this.state.bands[index],
                    gain: Math.max(-24, Math.min(24, gain))
                };
                this.state.isDirty = true;
                this._applyToPlayer();
                this._emitBandsChanged();
            }
            this.state.editingGainIndex = -1;
            this.state.editingGainValue = '';
        },

        handleQInputFocus(index, e) {
            // Set value BEFORE index to avoid empty render
            this.state.editingQValue = e.target.value;
            this.state.editingQIndex = index;
        },

        handleQInputChange(index, e) {
            if (this.state.editingQIndex === index) {
                this.state.editingQValue = e.target.value;
            }
        },

        handleQInputBlur(index, e) {
            const q = parseFloat(e.target.value);
            if (!isNaN(q) && q >= 0.1 && q <= 18) {
                this.state.bands[index] = {
                    ...this.state.bands[index],
                    q: parseFloat(q.toFixed(3))
                };
                this.state.isDirty = true;
                this._applyToPlayer();
                this._emitBandsChanged();
            }
            this.state.editingQIndex = -1;
            this.state.editingQValue = '';
        },

        addBand() {
            const newBand = createDefaultBand();

            // Try to pick a frequency that's not already used
            const usedFreqs = new Set(this.state.bands.map(b => b.frequency));
            const defaultFreqs = [1000, 500, 2000, 250, 4000, 125, 8000, 63, 16000];
            for (const freq of defaultFreqs) {
                if (!usedFreqs.has(freq)) {
                    newBand.frequency = freq;
                    break;
                }
            }

            this.state.bands = [...this.state.bands, newBand];
            this.state.selectedBand = this.state.bands.length - 1;
            this.state.isDirty = true;
            this._applyToPlayer();
            this._emitBandsChanged();
        },

        toggleBandEnabled(index) {
            const band = this.state.bands[index];
            this.state.bands[index] = {
                ...band,
                enabled: band.enabled === false ? true : false
            };
            this.state.isDirty = true;
            this._applyToPlayer();
            this._emitBandsChanged();
        },

        /**
         * Set bands externally (for undo/redo support).
         * @param {Object[]} bands - Band configurations
         */
        setBands(bands) {
            this.state.bands = JSON.parse(JSON.stringify(bands));
            this.state.isDirty = true;
            this._applyToPlayer();
        },

        /**
         * Emit event when bands are modified (for undo history).
         */
        _emitBandsChanged() {
            this.dispatchEvent(new CustomEvent('bands-changed', {
                bubbles: true,
                detail: { bands: this.state.bands }
            }));
        },

        removeBand(index) {
            this.state.bands = this.state.bands.filter((_, i) => i !== index);
            if (this.state.selectedBand >= this.state.bands.length) {
                this.state.selectedBand = this.state.bands.length - 1;
            }
            this.state.isDirty = true;
            this._applyToPlayer();
            this._emitBandsChanged();
        },

        handlePresetChange(e) {
            const uuid = e.target.value;
            if (uuid === '' || uuid === '__new__') {
                // Create New / unsaved preset
                eqPresetsStore.setActivePreset(null, []);
            } else if (uuid === '__from_graphic__') {
                // Import from current graphic EQ
                this._importFromGraphicEQ();
            } else {
                // Load preset
                eqPresetsStore.setActivePreset(uuid);
            }
            this._syncFromStore();
            this._applyToPlayer();
        },

        _importFromGraphicEQ() {
            // Convert current 10-band graphic EQ to parametric
            const gains = player.state.eqGains;
            const bands = graphicToParametric(gains);
            this.state.bands = bands;
            this.state.isDirty = true;
            eqPresetsStore.setActivePreset(null, bands);
            this._applyToPlayer();
            this._emitBandsChanged();
        },

        openSaveDialog(asNew = false) {
            const activePreset = this.state.activePresetUuid
                ? this.state.presets.find(p => p.uuid === this.state.activePresetUuid)
                : null;

            this.state.saveAsNew = asNew || !activePreset;
            this.state.saveName = asNew ? '' : (activePreset?.name || '');
            this.state.saveDialogVisible = true;
        },

        closeSaveDialog() {
            this.state.saveDialogVisible = false;
        },

        async handleSave() {
            const name = this.state.saveName.trim();
            if (!name) {
                this.state.error = 'Please enter a name';
                return;
            }

            const uuid = this.state.saveAsNew ? null : this.state.activePresetUuid;
            // Deep clone bands to strip reactive proxy (IndexedDB can't clone proxies)
            const savedUuid = await eqPresetsStore.savePreset({
                uuid,
                name,
                bands: JSON.parse(JSON.stringify(this.state.bands))
            });

            if (savedUuid) {
                eqPresetsStore.setActivePreset(savedUuid);
                this._syncFromStore();
                this.closeSaveDialog();
            }
        },

        handleDelete() {
            if (!this.state.activePresetUuid) return;

            const preset = this.state.presets.find(p => p.uuid === this.state.activePresetUuid);
            if (!preset) return;

            this.showConfirmDialog(
                'Delete Preset',
                `Delete preset "${preset.name}"?`,
                'deletePreset'
            );
        },

        async doDeletePreset() {
            if (!this.state.activePresetUuid) return;
            await eqPresetsStore.deletePreset(this.state.activePresetUuid);
            this._syncFromStore();
        },

        showConfirmDialog(title, message, action) {
            this.state.confirmDialog = { show: true, title, message, action };
        },

        handleConfirmDialogConfirm() {
            const { action } = this.state.confirmDialog;
            this.state.confirmDialog = { show: false, title: '', message: '', action: null };

            if (action === 'deletePreset') {
                this.doDeletePreset();
            }
        },

        handleConfirmDialogCancel() {
            this.state.confirmDialog = { show: false, title: '', message: '', action: null };
        },

        handleReset() {
            // Reset to flat response
            this.state.bands = [];
            this.state.selectedBand = -1;
            this.state.isDirty = true;
            eqPresetsStore.setActivePreset(null, []);
            this._applyToPlayer();
            this._emitBandsChanged();
        },

        _applyToPlayer() {
            // Filter out disabled bands when applying to player
            const enabledBands = this.state.bands.filter(b => b.enabled !== false);

            // Calculate auto-preamp based on peak of combined frequency response
            const autoPreamp = this._calculateAutoPreamp(enabledBands);

            // Apply current bands to the audio player with auto-preamp
            player.setParametricEQ(enabledBands, autoPreamp);

            // Also save to store as custom if no preset is active
            if (!this.state.activePresetUuid) {
                eqPresetsStore.setCustomBands(this.state.bands);
            }
        },

        formatFreq(freq) {
            if (freq >= 1000) {
                return (freq / 1000).toFixed(freq >= 10000 ? 0 : 1) + 'k';
            }
            return freq.toString();
        },

        _calculateAutoPreamp(bandsOverride) {
            const bands = bandsOverride || this.state.bands.filter(b => b.enabled !== false);
            if (!bands || bands.length === 0) return 0;

            // Create temporary AudioContext if needed
            if (!this._tempAudioContext) {
                try {
                    this._tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
                } catch (e) {
                    // Fallback to simple calculation if no AudioContext
                    const maxGain = bands.reduce((max, band) => {
                        if (['peaking', 'lowshelf', 'highshelf'].includes(band.type) && band.gain > 0) {
                            return Math.max(max, band.gain);
                        }
                        return max;
                    }, 0);
                    return maxGain > 0 ? -maxGain : 0;
                }
            }

            // Calculate combined frequency response and find peak
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
                const filter = this._tempAudioContext.createBiquadFilter();
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

            // Find peak of combined response
            let peakDb = 0;
            for (let i = 0; i < numPoints; i++) {
                if (combinedMag[i] > peakDb) {
                    peakDb = combinedMag[i];
                }
            }

            // Round to 0.1 dB precision
            return peakDb > 0 ? -Math.ceil(peakDb * 10) / 10 : 0;
        },

        // Export/Import functionality
        _typeToExport(type) {
            const map = {
                'peaking': 'PK',
                'lowshelf': 'LSC',
                'highshelf': 'HSC',
                'lowpass': 'LP',
                'highpass': 'HP',
                'notch': 'NO',
                'bandpass': 'BP',
                'allpass': 'AP'
            };
            return map[type] || 'PK';
        },

        _exportToType(code) {
            const map = {
                'PK': 'peaking',
                'LSC': 'lowshelf',
                'HSC': 'highshelf',
                'LP': 'lowpass',
                'HP': 'highpass',
                'NO': 'notch',
                'BP': 'bandpass',
                'AP': 'allpass'
            };
            return map[code] || 'peaking';
        },

        handleExport() {
            const bands = this.state.bands;

            // Calculate auto-preamp from combined response peak
            const preamp = this._calculateAutoPreamp();

            let output = `Preamp: ${preamp.toFixed(1)} dB\n`;

            bands.forEach((band, i) => {
                const typeCode = this._typeToExport(band.type);
                output += `Filter ${i + 1}: ON ${typeCode} Fc ${Math.round(band.frequency)} Hz Gain ${band.gain.toFixed(1)} dB Q ${band.q.toFixed(3)}\n`;
            });

            // Create and download file
            const blob = new Blob([output], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'eq-preset.txt';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        },

        openImportDialog() {
            this.state.importText = '';
            this.state.importDialogVisible = true;
        },

        closeImportDialog() {
            this.state.importDialogVisible = false;
        },

        handleFileSelect(e) {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                this.state.importText = event.target.result;
            };
            reader.onerror = () => {
                this.state.error = 'Failed to read file';
            };
            reader.readAsText(file);
        },

        handleImport() {
            const text = this.state.importText.trim();
            if (!text) {
                this.state.error = 'Please paste EQ configuration text';
                return;
            }

            const bands = [];
            const lines = text.split('\n');

            for (const line of lines) {
                // Skip preamp line and empty lines
                if (line.startsWith('Preamp:') || !line.trim()) continue;

                // Parse filter line: Filter N: ON TYPE Fc FREQ Hz Gain GAIN dB Q Q
                const match = line.match(/Filter\s+\d+:\s+ON\s+(\w+)\s+Fc\s+([\d.]+)\s+Hz\s+Gain\s+([-\d.]+)\s+dB\s+Q\s+([\d.]+)/i);
                if (match) {
                    const [, typeCode, freq, gain, q] = match;
                    bands.push({
                        type: this._exportToType(typeCode.toUpperCase()),
                        frequency: parseFloat(freq),
                        gain: parseFloat(gain),
                        q: parseFloat(q)
                    });
                }
            }

            if (bands.length === 0) {
                this.state.error = 'Could not parse any filters from the text';
                return;
            }

            this.state.bands = bands;
            this.state.isDirty = true;
            this.state.error = null;
            eqPresetsStore.setActivePreset(null, bands);
            this._applyToPlayer();
            this._emitBandsChanged();
            this.closeImportDialog();
        }
    },

    template() {
        const { bands, selectedBand, presets, activePresetUuid, isLoading, error,
                saveDialogVisible, saveName, isDirty,
                editingFreqIndex, editingFreqValue,
                editingGainIndex, editingGainValue,
                editingQIndex, editingQValue,
                importDialogVisible, importText } = this.state;

        return html`
            <div class="parametric-eq-editor ${this.props.visible ? '' : 'hidden'}">

                <div class="preset-bar">
                    <select value="${activePresetUuid || ''}" on-change="handlePresetChange">
                        ${when(!activePresetUuid, () => html`
                            <option value="__new__">
                                New
                            </option>
                        `)}
                        <option value="">
                            ${when(!activePresetUuid, () => 'Unsaved', () => 'New')}
                        </option>
                        <option value="__from_graphic__">Import from Graphic EQ</option>
                        ${each(presets, preset => html`
                            <option value="${preset.uuid}">${preset.name}</option>
                        `)}
                    </select>

                    <button on-click="${() => this.openSaveDialog(false)}" title="Save preset">
                        Save
                    </button>
                    <button on-click="${() => this.openSaveDialog(true)}" title="Save as new preset">
                        Save As
                    </button>
                    ${when(activePresetUuid, html`
                        <button class="danger" on-click="handleDelete" title="Delete preset">
                            Delete
                        </button>
                    `)}
                    <button on-click="openImportDialog" title="Import from text file">
                        Import
                    </button>
                    <button on-click="handleExport" title="Export to text file">
                        Export
                    </button>
                </div>

                ${when(error, html`
                    <div class="error-message">${error}</div>
                `)}

                <eq-response-canvas
                    bands="${bands}"
                    selectedBand="${selectedBand}"
                    height="200"
                    on-band-change="handleBandChange"
                    on-band-change-end="handleBandChangeEnd"
                    on-band-select="handleBandSelect">
                </eq-response-canvas>

                <div class="bands-list">
                    <div class="bands-header">
                        <span class="col-enabled"></span>
                        <span class="col-num">#</span>
                        <span class="col-type">Type</span>
                        <span class="col-freq">Frequency</span>
                        <span class="col-gain">Gain</span>
                        <span class="col-q">Q</span>
                        <span class="col-action"></span>
                    </div>

                    ${each(bands, (band, i) => html`
                        <div class="band-row ${selectedBand === i ? 'selected' : ''} ${band.enabled === false ? 'disabled' : ''}"
                             on-click="${() => this.state.selectedBand = i}">
                            <label class="col-enabled band-toggle" on-click="${(e) => e.stopPropagation()}">
                                <input type="checkbox"
                                       checked="${band.enabled !== false}"
                                       on-change="${() => this.toggleBandEnabled(i)}"
                                       title="${band.enabled !== false ? 'Disable filter' : 'Enable filter'}">
                            </label>
                            <span class="col-num">${i + 1}</span>

                            <select class="col-type" value="${band.type}"
                                    on-change="${(e) => this.handleTypeChange(i, e)}"
                                    disabled="${band.enabled === false}">
                                ${each(FILTER_TYPES, ft => html`
                                    <option value="${ft.value}">${ft.label}</option>
                                `)}
                            </select>

                            <div class="col-freq">
                                <input type="number" min="20" max="20000"
                                       value="${editingFreqIndex === i ? editingFreqValue : band.frequency}"
                                       on-focus="${(e) => this.handleFreqFocus(i, e)}"
                                       on-input="${(e) => this.handleFreqInput(i, e)}"
                                       on-blur="${(e) => this.handleFreqBlur(i, e)}"
                                       on-keydown="${(e) => e.key === 'Enter' && e.target.blur()}">
                                <span class="freq-label">${this.formatFreq(band.frequency)}</span>
                            </div>

                            <div class="col-gain">
                                <input type="range" min="-24" max="24" step="0.5"
                                       value="${band.gain}"
                                       on-input="${(e) => this.handleGainSliderChange(i, e)}"
                                       on-change="${(e) => this.handleGainSliderEnd(i, e)}"
                                       on-touchstart="${(e) => this.handleSliderTouchStart(i, 'gain', e)}"
                                       on-touchmove="${(e) => this.handleSliderTouchMove(i, 'gain', e)}"
                                       on-touchend="${(e) => this.handleSliderTouchEnd(i, 'gain', e)}">
                                <input type="number" class="value-input"
                                       min="-24" max="24" step="0.5"
                                       value="${editingGainIndex === i ? editingGainValue : band.gain.toFixed(1)}"
                                       on-focus="${(e) => this.handleGainInputFocus(i, e)}"
                                       on-input="${(e) => this.handleGainInputChange(i, e)}"
                                       on-blur="${(e) => this.handleGainInputBlur(i, e)}"
                                       on-keydown="${(e) => e.key === 'Enter' && e.target.blur()}">
                            </div>

                            <div class="col-q">
                                <input type="range" min="0" max="100" step="1"
                                       value="${this._qToSlider(band.q)}"
                                       on-input="${(e) => this.handleQSliderChange(i, e)}"
                                       on-change="${(e) => this.handleQSliderEnd(i, e)}"
                                       on-touchstart="${(e) => this.handleSliderTouchStart(i, 'q', e)}"
                                       on-touchmove="${(e) => this.handleSliderTouchMove(i, 'q', e)}"
                                       on-touchend="${(e) => this.handleSliderTouchEnd(i, 'q', e)}">
                                <input type="number" class="value-input"
                                       min="0.1" max="18" step="0.1"
                                       value="${editingQIndex === i ? editingQValue : band.q.toFixed(2)}"
                                       on-focus="${(e) => this.handleQInputFocus(i, e)}"
                                       on-input="${(e) => this.handleQInputChange(i, e)}"
                                       on-blur="${(e) => this.handleQInputBlur(i, e)}"
                                       on-keydown="${(e) => e.key === 'Enter' && e.target.blur()}">
                            </div>

                            <button class="col-action remove-btn"
                                    on-click="${() => this.removeBand(i)}"
                                    title="Remove band">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M18 6L6 18M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>
                    `)}

                    <button class="add-band-btn" on-click="addBand">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 5v14M5 12h14"/>
                        </svg>
                        Add Band
                    </button>
                </div>

                <div class="editor-footer">
                    <button on-click="handleReset">Reset (Flat)</button>
                    <span class="preamp-display">Pre-amp: ${this._calculateAutoPreamp().toFixed(1)} dB</span>
                </div>

                ${when(saveDialogVisible, html`
                    <div class="save-dialog-overlay" on-click="closeSaveDialog">
                        <div class="save-dialog" on-click="${(e) => e.stopPropagation()}">
                            <h4>${this.state.saveAsNew ? 'Save As New Preset' : 'Save Preset'}</h4>
                            <input type="text" placeholder="Preset name"
                                   value="${saveName}"
                                   x-model="saveName"
                                   on-keydown="${(e) => e.key === 'Enter' && this.handleSave()}">
                            <div class="dialog-buttons">
                                <button on-click="closeSaveDialog">Cancel</button>
                                <button class="primary" on-click="handleSave">Save</button>
                            </div>
                        </div>
                    </div>
                `)}

                ${when(importDialogVisible, html`
                    <div class="save-dialog-overlay" on-click="closeImportDialog">
                        <div class="save-dialog import-dialog" on-click="${(e) => e.stopPropagation()}">
                            <h4>Import EQ Configuration</h4>
                            <p class="import-help">Select a file or paste EQ configuration:</p>
                            <div class="file-input-row">
                                <input type="file" accept=".txt,.eq" on-change="handleFileSelect">
                            </div>
                            <pre class="import-example">Preamp: -7.7 dB
Filter 1: ON PK Fc 1000 Hz Gain -2.0 dB Q 1.500</pre>
                            <textarea placeholder="Or paste configuration here..."
                                      x-model="importText"
                                      rows="8"></textarea>
                            <div class="dialog-buttons">
                                <button on-click="closeImportDialog">Cancel</button>
                                <button class="primary" on-click="handleImport">Import</button>
                            </div>
                        </div>
                    </div>
                `)}

                ${when(this.state.confirmDialog.show, () => html`
                    <cl-dialog visible="true" header="${this.state.confirmDialog.title}" on-close="handleConfirmDialogCancel">
                        <p>${this.state.confirmDialog.message}</p>
                        <div slot="footer" style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                            <cl-button severity="secondary" on-click="handleConfirmDialogCancel">Cancel</cl-button>
                            <cl-button severity="danger" on-click="handleConfirmDialogConfirm">Delete</cl-button>
                        </div>
                    </cl-dialog>
                `)}
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
        }

        .hidden {
            display: none !important;
        }

        .parametric-eq-editor {
            background: var(--surface-50, #0f0f0f);
            border-radius: 12px;
            padding: 1rem;
        }

        .preset-bar {
            display: flex;
            gap: 0.5rem;
            margin-bottom: 1rem;
            flex-wrap: wrap;
        }

        .preset-bar select {
            flex: 1;
            min-width: 150px;
            padding: 0.5rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-primary, #e0e0e0);
        }

        .preset-bar button {
            padding: 0.5rem 1rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-secondary, #a0a0a0);
            cursor: pointer;
            font-size: 0.875rem;
        }

        .preset-bar button:hover {
            background: var(--surface-200, #2d2d2d);
            color: var(--text-primary, #e0e0e0);
        }

        .preset-bar button.danger {
            color: var(--danger-500, #ef4444);
        }

        .preset-bar button.danger:hover {
            background: var(--danger-900, #450a0a);
        }

        .error-message {
            padding: 0.5rem;
            margin-bottom: 1rem;
            background: var(--danger-900, #450a0a);
            color: var(--danger-400, #f87171);
            border-radius: 4px;
            font-size: 0.875rem;
        }

        eq-response-canvas {
            margin-bottom: 1rem;
        }

        .bands-list {
            background: var(--surface-100, #242424);
            border-radius: 8px;
            overflow: hidden;
            container-type: inline-size;
        }

        .bands-header {
            display: grid;
            grid-template-columns: 28px 30px minmax(70px, 100px) minmax(90px, 120px) 1fr minmax(80px, 100px) 32px;
            gap: 0.5rem;
            padding: 0.5rem 0.75rem;
            background: var(--surface-200, #2d2d2d);
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
            text-transform: uppercase;
        }

        .band-row {
            display: grid;
            grid-template-columns: 28px 30px minmax(70px, 100px) minmax(90px, 120px) 1fr minmax(80px, 100px) 32px;
            gap: 0.5rem;
            padding: 0.5rem 0.75rem;
            align-items: center;
            border-bottom: 1px solid var(--surface-200, #2d2d2d);
            cursor: pointer;
        }

        .band-row.disabled {
            opacity: 0.5;
        }

        .band-toggle {
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .band-toggle input[type="checkbox"] {
            width: 16px;
            height: 16px;
            cursor: pointer;
            accent-color: var(--primary-500, #2196f3);
        }

        .band-row:hover {
            background: var(--surface-150, #1f1f1f);
        }

        .band-row.selected {
            background: var(--primary-900, #1e3a5f);
        }

        .col-num {
            font-weight: 600;
            color: var(--text-secondary, #a0a0a0);
            text-align: center;
        }

        select.col-type {
            width: 100%;
            padding: 0.375rem;
            border: 1px solid #404040;
            border-radius: 4px;
            background-color: #242424 !important;
            color: #e0e0e0 !important;
            font-size: 0.8125rem;
            color-scheme: dark;
        }

        select.col-type option {
            background-color: #242424;
            color: #e0e0e0;
        }

        .col-freq input[type="number"] {
            width: 60px;
            padding: 0.375rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-primary, #e0e0e0);
            font-size: 0.8125rem;
            flex-shrink: 0;
            -moz-appearance: textfield;
        }

        .col-freq input[type="number"]::-webkit-inner-spin-button,
        .col-freq input[type="number"]::-webkit-outer-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }

        .col-freq,
        .col-gain,
        .col-q {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .freq-label {
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
            min-width: 28px;
        }

        .col-gain input[type="range"],
        .col-q input[type="range"] {
            flex: 1;
            min-width: 40px;
            /* Allow vertical scroll - works on Chrome/Safari */
            touch-action: pan-y;
        }

        /* Firefox: touch-action doesn't work properly, use JS control instead */
        :host(.firefox) .col-gain input[type="range"],
        :host(.firefox) .col-q input[type="range"] {
            touch-action: none;
        }

        .value-input {
            width: 54px;
            padding: 0.25rem 0.375rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-primary, #e0e0e0);
            font-size: 0.75rem;
            font-family: monospace;
            text-align: right;
            flex-shrink: 0;
        }

        .value-input::-webkit-inner-spin-button,
        .value-input::-webkit-outer-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }

        .value-input {
            -moz-appearance: textfield;
        }

        .remove-btn {
            background: none;
            border: none;
            color: var(--text-muted, #707070);
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
        }

        .remove-btn:hover {
            background: var(--danger-900, #450a0a);
            color: var(--danger-400, #f87171);
        }

        .add-band-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            width: 100%;
            padding: 0.75rem;
            border: none;
            background: none;
            color: var(--primary-400, #60a5fa);
            cursor: pointer;
            font-size: 0.875rem;
        }

        .add-band-btn:hover {
            background: var(--surface-150, #1f1f1f);
        }

        .editor-footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 1rem;
        }

        .editor-footer button {
            padding: 0.5rem 1rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-secondary, #a0a0a0);
            cursor: pointer;
            font-size: 0.875rem;
        }

        .editor-footer button:hover {
            background: var(--surface-200, #2d2d2d);
            color: var(--text-primary, #e0e0e0);
        }

        .preamp-display {
            font-size: 0.875rem;
            color: var(--text-muted, #707070);
            font-family: monospace;
        }

        /* Save Dialog */
        .save-dialog-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }

        .save-dialog {
            background: var(--surface-100, #242424);
            border-radius: 12px;
            padding: 1.5rem;
            min-width: 300px;
            max-width: 90%;
        }

        .save-dialog h4 {
            margin: 0 0 1rem;
            color: var(--text-primary, #e0e0e0);
        }

        .save-dialog input[type="text"] {
            width: 100%;
            padding: 0.75rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-50, #1a1a1a);
            color: var(--text-primary, #e0e0e0);
            font-size: 1rem;
            margin-bottom: 1rem;
        }

        .dialog-buttons {
            display: flex;
            justify-content: flex-end;
            gap: 0.5rem;
        }

        .dialog-buttons button {
            padding: 0.5rem 1.5rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-secondary, #a0a0a0);
            cursor: pointer;
        }

        .dialog-buttons button.primary {
            background: var(--primary-600, #2563eb);
            border-color: var(--primary-600, #2563eb);
            color: white;
        }

        /* Import Dialog */
        .import-dialog {
            max-width: 500px;
        }

        .import-help {
            margin: 0 0 0.5rem;
            color: var(--text-secondary, #a0a0a0);
            font-size: 0.875rem;
        }

        .import-example {
            background: var(--surface-50, #1a1a1a);
            padding: 0.5rem;
            border-radius: 4px;
            font-size: 0.75rem;
            color: var(--text-muted, #707070);
            margin: 0 0 1rem;
            overflow-x: auto;
        }

        .import-dialog textarea {
            width: 100%;
            padding: 0.75rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-50, #1a1a1a);
            color: var(--text-primary, #e0e0e0);
            font-family: monospace;
            font-size: 0.8125rem;
            resize: vertical;
            margin-bottom: 1rem;
        }

        .file-input-row {
            margin-bottom: 1rem;
        }

        .file-input-row input[type="file"] {
            width: 100%;
            padding: 0.5rem;
            border: 1px solid var(--surface-300, #404040);
            border-radius: 4px;
            background: var(--surface-100, #242424);
            color: var(--text-primary, #e0e0e0);
            font-size: 0.875rem;
            cursor: pointer;
        }

        .file-input-row input[type="file"]::file-selector-button {
            padding: 0.375rem 0.75rem;
            margin-right: 0.75rem;
            border: 1px solid var(--surface-400, #505050);
            border-radius: 4px;
            background: var(--surface-200, #2d2d2d);
            color: var(--text-primary, #e0e0e0);
            cursor: pointer;
        }

        .file-input-row input[type="file"]::file-selector-button:hover {
            background: var(--surface-300, #404040);
        }

        /* Responsive - container query based on .bands-list width */
        @container (max-width: 608px) {
            .bands-header {
                display: none;
            }

            .band-row {
                grid-template-columns: 28px 1fr 1fr 32px;
                grid-template-rows: auto auto auto;
            }

            .col-enabled {
                grid-row: 1 / 4;
                align-self: center;
            }

            .col-num {
                display: none;
            }

            .col-type {
                grid-column: 2;
            }

            .col-freq {
                grid-column: 3;
            }

            .col-gain {
                grid-column: 2 / 4;
            }

            .col-q {
                grid-column: 2 / 4;
            }

            .col-action {
                grid-row: 1 / 4;
                grid-column: 4;
                align-self: center;
            }
        }
    `
});
