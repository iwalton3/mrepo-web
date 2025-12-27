/**
 * EQ Response Canvas Component
 *
 * Interactive frequency response visualization for parametric EQ.
 * Features:
 * - Logarithmic frequency axis (20Hz - 20kHz)
 * - Linear dB axis (-24dB to +24dB)
 * - Draggable control points for each band
 * - Real-time frequency response curve calculation
 */

import { defineComponent, html, each } from '../lib/framework.js';

// Grid frequencies for labels (log scale)
const GRID_FREQUENCIES = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

// Grid gains for labels (indexed by range - 12dB or 24dB)
const GRID_GAINS_12 = [-12, -6, 0, 6, 12];
const GRID_GAINS_24 = [-24, -12, 0, 12, 24];

// Frequency range
const MIN_FREQ = 20;
const MAX_FREQ = 20000;

// Gain range options
const GAIN_RANGE_12 = { min: -12, max: 12 };
const GAIN_RANGE_24 = { min: -24, max: 24 };

// Threshold for switching to extended range (absolute dB value)
const EXTENDED_RANGE_THRESHOLD = 10;

// Number of points for curve calculation
const CURVE_POINTS = 512;

/**
 * Convert frequency to X pixel position (log scale).
 */
function freqToX(freq, width, padding) {
    const logMin = Math.log10(MIN_FREQ);
    const logMax = Math.log10(MAX_FREQ);
    const logFreq = Math.log10(Math.max(MIN_FREQ, Math.min(MAX_FREQ, freq)));
    const ratio = (logFreq - logMin) / (logMax - logMin);
    return padding + ratio * (width - 2 * padding);
}

/**
 * Convert X pixel position to frequency (log scale).
 */
function xToFreq(x, width, padding) {
    const logMin = Math.log10(MIN_FREQ);
    const logMax = Math.log10(MAX_FREQ);
    const ratio = (x - padding) / (width - 2 * padding);
    const logFreq = logMin + ratio * (logMax - logMin);
    return Math.pow(10, logFreq);
}

/**
 * Convert gain to Y pixel position (linear scale).
 */
function gainToY(gain, height, padding, gainRange) {
    const minGain = gainRange.min;
    const maxGain = gainRange.max;
    const ratio = (maxGain - gain) / (maxGain - minGain);
    return padding + ratio * (height - 2 * padding);
}

/**
 * Convert Y pixel position to gain (linear scale).
 */
function yToGain(y, height, padding, gainRange) {
    const minGain = gainRange.min;
    const maxGain = gainRange.max;
    const ratio = (y - padding) / (height - 2 * padding);
    return maxGain - ratio * (maxGain - minGain);
}

/**
 * Format frequency for display.
 */
function formatFreq(freq) {
    if (freq >= 1000) {
        return (freq / 1000) + 'k';
    }
    return freq.toString();
}

/**
 * Calculate combined frequency response magnitude.
 * @param {Object[]} bands - Band configurations
 * @param {AudioContext} audioContext - Web Audio context for calculation
 * @returns {Float32Array} Magnitude response in dB
 */
function calculateFrequencyResponse(bands, audioContext) {
    if (!bands || bands.length === 0 || !audioContext) {
        return new Float32Array(CURVE_POINTS).fill(0);
    }

    // Generate log-spaced frequencies
    const frequencies = new Float32Array(CURVE_POINTS);
    const logMin = Math.log10(MIN_FREQ);
    const logMax = Math.log10(MAX_FREQ);
    for (let i = 0; i < CURVE_POINTS; i++) {
        const logFreq = logMin + (i / (CURVE_POINTS - 1)) * (logMax - logMin);
        frequencies[i] = Math.pow(10, logFreq);
    }

    // Combined magnitude response (in dB, starts at 0)
    const combinedMag = new Float32Array(CURVE_POINTS).fill(0);

    // For each band, calculate response and combine (skip disabled bands)
    for (const band of bands) {
        if (band.enabled === false) continue;

        const filter = audioContext.createBiquadFilter();
        filter.type = band.type;
        filter.frequency.value = band.frequency;
        filter.gain.value = band.gain;
        if (['peaking', 'notch', 'bandpass', 'allpass', 'lowpass', 'highpass'].includes(band.type)) {
            filter.Q.value = band.q || 1.0;
        }

        const magResponse = new Float32Array(CURVE_POINTS);
        const phaseResponse = new Float32Array(CURVE_POINTS);
        filter.getFrequencyResponse(frequencies, magResponse, phaseResponse);

        // Convert to dB and add (in dB domain, we add)
        for (let i = 0; i < CURVE_POINTS; i++) {
            combinedMag[i] += 20 * Math.log10(magResponse[i]);
        }
    }

    return combinedMag;
}

export default defineComponent('eq-response-canvas', {
    props: {
        bands: [],  // Array of band configurations
        width: 600,
        height: 200,
        selectedBand: -1  // Index of selected band for highlighting
    },

    data() {
        return {
            dragging: false,
            dragIndex: -1,
            dragStartX: 0,
            dragStartY: 0,
            dragStartFreq: 0,
            dragStartGain: 0,
            // Current gain range - defaults to +/- 12 dB
            gainRange: GAIN_RANGE_12
        };
    },

    mounted() {
        this._canvas = this.refs.canvas;
        this._ctx = this._canvas.getContext('2d');
        this._padding = 40;

        // Check if any existing bands need extended range
        this._checkGainRange();

        // Initial draw
        this._draw();

        // Redraw on resize
        this._resizeObserver = new ResizeObserver(() => {
            this._updateCanvasSize();
            this._draw();
        });
        this._resizeObserver.observe(this);
    },

    unmounted() {
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
        }
    },

    propsChanged(prop, newValue) {
        if (prop === 'bands') {
            // Only check gain range when not actively dragging (to avoid jarring changes mid-drag)
            if (!this.state.dragging) {
                this._checkGainRange();
            }
            this._draw();
        } else if (prop === 'selectedBand') {
            this._draw();
        }
    },

    methods: {
        /**
         * Check if any band has gain near the edge and switch range accordingly.
         * Called on mouse release to avoid jarring changes during drag.
         */
        _checkGainRange() {
            const bands = this.props.bands || [];
            const needsExtendedRange = bands.some(band =>
                Math.abs(band.gain) >= EXTENDED_RANGE_THRESHOLD
            );

            // Use max value comparison instead of reference comparison (reactive proxy safe)
            if (needsExtendedRange && this.state.gainRange.max === 12) {
                // Expand to 24 dB range
                this.state.gainRange = GAIN_RANGE_24;
            } else if (!needsExtendedRange && this.state.gainRange.max === 24) {
                // Shrink back to 12 dB range when all bands are within threshold
                this.state.gainRange = GAIN_RANGE_12;
            }
        },

        _updateCanvasSize() {
            const rect = this.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const width = rect.width || this.props.width;
            const height = this.props.height;

            this._canvas.width = width * dpr;
            this._canvas.height = height * dpr;
            this._canvas.style.width = width + 'px';
            this._canvas.style.height = height + 'px';
            this._ctx.scale(dpr, dpr);

            this._width = width;
            this._height = height;
        },

        _draw() {
            if (!this._ctx) return;

            const ctx = this._ctx;
            const width = this._width || this.props.width;
            const height = this._height || this.props.height;
            const padding = this._padding;

            // Get computed CSS colors
            const styles = getComputedStyle(this);
            this._colors = {
                bg: styles.getPropertyValue('--surface-100').trim() || '#1a1a1a',
                grid: styles.getPropertyValue('--surface-300').trim() || '#333',
                gridBold: styles.getPropertyValue('--surface-400').trim() || '#555',
                text: styles.getPropertyValue('--text-muted').trim() || '#666',
                curve: styles.getPropertyValue('--primary-400').trim() || '#60a5fa',
                point: styles.getPropertyValue('--primary-500').trim() || '#3b82f6',
                pointAlt: styles.getPropertyValue('--primary-600').trim() || '#2563eb'
            };

            // Clear
            ctx.fillStyle = this._colors.bg;
            ctx.fillRect(0, 0, width, height);

            // Draw grid
            this._drawGrid(ctx, width, height, padding);

            // Calculate and draw frequency response curve
            const audioContext = this._getAudioContext();
            if (audioContext) {
                const response = calculateFrequencyResponse(this.props.bands, audioContext);
                this._drawCurve(ctx, response, width, height, padding);
            }

            // Draw control points
            this._drawControlPoints(ctx, width, height, padding);
        },

        _getAudioContext() {
            // Create a temporary AudioContext for frequency response calculation
            if (!this._tempAudioContext) {
                try {
                    this._tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
                } catch (e) {
                    console.warn('Could not create AudioContext for EQ visualization');
                    return null;
                }
            }
            return this._tempAudioContext;
        },

        _drawGrid(ctx, width, height, padding) {
            const colors = this._colors;
            const gainRange = this.state.gainRange;
            const gridGains = gainRange.max === 24 ? GRID_GAINS_24 : GRID_GAINS_12;

            ctx.strokeStyle = colors.grid;
            ctx.lineWidth = 1;
            ctx.fillStyle = colors.text;
            ctx.font = '10px sans-serif';

            // Vertical lines (frequency)
            for (const freq of GRID_FREQUENCIES) {
                const x = freqToX(freq, width, padding);
                ctx.beginPath();
                ctx.moveTo(x, padding);
                ctx.lineTo(x, height - padding);
                ctx.stroke();

                // Label
                ctx.textAlign = 'center';
                ctx.fillText(formatFreq(freq), x, height - padding + 15);
            }

            // Horizontal lines (gain)
            for (const gain of gridGains) {
                const y = gainToY(gain, height, padding, gainRange);
                ctx.beginPath();

                // Make 0dB line more prominent
                if (gain === 0) {
                    ctx.strokeStyle = colors.gridBold;
                    ctx.lineWidth = 2;
                } else {
                    ctx.strokeStyle = colors.grid;
                    ctx.lineWidth = 1;
                }

                ctx.moveTo(padding, y);
                ctx.lineTo(width - padding, y);
                ctx.stroke();

                // Label
                ctx.textAlign = 'right';
                ctx.fillStyle = colors.text;
                const label = (gain > 0 ? '+' : '') + gain + 'dB';
                ctx.fillText(label, padding - 5, y + 4);
            }
        },

        _drawCurve(ctx, response, width, height, padding) {
            const colors = this._colors;
            const gainRange = this.state.gainRange;
            ctx.strokeStyle = colors.curve;
            ctx.lineWidth = 2;
            ctx.beginPath();

            const logMin = Math.log10(MIN_FREQ);
            const logMax = Math.log10(MAX_FREQ);

            for (let i = 0; i < CURVE_POINTS; i++) {
                const logFreq = logMin + (i / (CURVE_POINTS - 1)) * (logMax - logMin);
                const freq = Math.pow(10, logFreq);
                const x = freqToX(freq, width, padding);

                // Clamp response to visible range
                const gain = Math.max(gainRange.min, Math.min(gainRange.max, response[i]));
                const y = gainToY(gain, height, padding, gainRange);

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }

            ctx.stroke();

            // Fill under curve with gradient
            ctx.globalAlpha = 0.2;
            const zeroY = gainToY(0, height, padding, gainRange);
            ctx.lineTo(width - padding, zeroY);
            ctx.lineTo(padding, zeroY);
            ctx.closePath();
            ctx.fillStyle = colors.curve;
            ctx.fill();
            ctx.globalAlpha = 1;
        },

        _drawControlPoints(ctx, width, height, padding) {
            const colors = this._colors;
            const gainRange = this.state.gainRange;
            const bands = this.props.bands || [];

            for (let i = 0; i < bands.length; i++) {
                const band = bands[i];
                const x = freqToX(band.frequency, width, padding);
                const y = gainToY(band.gain, height, padding, gainRange);

                const isSelected = i === this.props.selectedBand;
                const isDragging = i === this.state.dragIndex;

                // Outer ring
                ctx.beginPath();
                ctx.arc(x, y, isDragging ? 10 : 8, 0, Math.PI * 2);
                ctx.fillStyle = isSelected || isDragging ? colors.point : colors.pointAlt;
                ctx.fill();

                // Inner dot
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#fff';
                ctx.fill();

                // Band number label
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 10px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText((i + 1).toString(), x, y - 14);
            }
        },

        handleMouseDown(e) {
            const rect = this._canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const padding = this._padding;
            const gainRange = this.state.gainRange;

            // Check if clicking on a control point
            const bands = this.props.bands || [];
            for (let i = 0; i < bands.length; i++) {
                const band = bands[i];
                const px = freqToX(band.frequency, this._width, padding);
                const py = gainToY(band.gain, this._height, padding, gainRange);

                const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
                if (dist <= 12) {
                    // Start dragging
                    this.state.dragging = true;
                    this.state.dragIndex = i;
                    this.state.dragStartX = x;
                    this.state.dragStartY = y;
                    this.state.dragStartFreq = band.frequency;
                    this.state.dragStartGain = band.gain;

                    // Emit band-select event
                    this.dispatchEvent(new CustomEvent('band-select', {
                        detail: { index: i },
                        bubbles: true
                    }));

                    // Add document-level listeners for drag
                    document.addEventListener('mousemove', this._handleMouseMove);
                    document.addEventListener('mouseup', this._handleMouseUp);

                    e.preventDefault();
                    return;
                }
            }
        },

        handleMouseMove(e) {
            if (!this.state.dragging) return;

            const rect = this._canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const padding = this._padding;
            const gainRange = this.state.gainRange;

            // Calculate new frequency and gain
            let newFreq = xToFreq(x, this._width, padding);
            let newGain = yToGain(y, this._height, padding, gainRange);

            // Clamp values - always allow full 24dB range for actual values
            newFreq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, newFreq));
            newGain = Math.max(GAIN_RANGE_24.min, Math.min(GAIN_RANGE_24.max, newGain));

            // Round gain to 0.5 dB increments
            newGain = Math.round(newGain * 2) / 2;

            // Emit band-change event
            this.dispatchEvent(new CustomEvent('band-change', {
                detail: {
                    index: this.state.dragIndex,
                    frequency: Math.round(newFreq),
                    gain: newGain
                },
                bubbles: true
            }));
        },

        handleMouseUp() {
            if (this.state.dragging) {
                this.state.dragging = false;
                this.state.dragIndex = -1;

                // Remove document-level listeners
                document.removeEventListener('mousemove', this._handleMouseMove);
                document.removeEventListener('mouseup', this._handleMouseUp);

                // Emit drag-end event for undo batching
                this.dispatchEvent(new CustomEvent('band-change-end', {
                    bubbles: true
                }));

                // Check if we need to switch to extended range after drag completes
                this._checkGainRange();
                this._draw();
            }
        },

        // Touch events for mobile support
        handleTouchStart(e) {
            if (e.touches.length !== 1) return;
            const touch = e.touches[0];
            this.handleMouseDown({
                clientX: touch.clientX,
                clientY: touch.clientY,
                preventDefault: () => e.preventDefault()
            });
        },

        handleTouchMove(e) {
            if (e.touches.length !== 1) return;
            const touch = e.touches[0];
            this.handleMouseMove({
                clientX: touch.clientX,
                clientY: touch.clientY
            });
        },

        handleTouchEnd() {
            if (this.state.dragging) {
                this.state.dragging = false;
                this.state.dragIndex = -1;

                // Remove document-level listeners
                document.removeEventListener('mousemove', this._handleMouseMove);
                document.removeEventListener('mouseup', this._handleMouseUp);

                // Emit drag-end event for undo batching
                this.dispatchEvent(new CustomEvent('band-change-end', {
                    bubbles: true
                }));

                // Check if we need to switch to extended range after drag completes
                this._checkGainRange();
                this._draw();
            }
        }
    },

    afterRender() {
        // Bind document-level event handlers
        this._handleMouseMove = this.handleMouseMove.bind(this);
        this._handleMouseUp = this.handleMouseUp.bind(this);

        // Update canvas if refs are available (may not be on first render before mounted)
        if (this._canvas) {
            this._updateCanvasSize();
            this._draw();
        }
    },

    template() {
        return html`
            <div class="eq-canvas-container">
                <canvas
                    ref="canvas"
                    on-mousedown="handleMouseDown"
                    on-touchstart-prevent="handleTouchStart"
                    on-touchmove-prevent="handleTouchMove"
                    on-touchend="handleTouchEnd">
                </canvas>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
            width: 100%;
        }

        .eq-canvas-container {
            position: relative;
            width: 100%;
            border-radius: 8px;
            overflow: hidden;
            background: var(--surface-100, #1a1a1a);
        }

        canvas {
            display: block;
            width: 100%;
            cursor: crosshair;
        }
    `
});
