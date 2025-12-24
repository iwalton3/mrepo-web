/**
 * Comfort Noise AudioWorklet Processor
 * Minimal implementation to avoid deadline misses on mobile.
 */
class NoiseProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.enabled = true;
        this.isPlaying = false;
        this.thresholdLinear = 0.015;
        this.powerLinear = 0.063;
        this.attackMs = 25;
        this.level = 0;
        this.rng = (Math.random() * 0xFFFFFFFF) >>> 0;

        // Pre-compute smoothing coefficient (updated when attackMs changes)
        // Assumes 128 sample blocks at 48kHz
        this._updateSmoothing();

        this.port.onmessage = (e) => {
            const d = e.data;
            if (d.threshold !== undefined) this.thresholdLinear = Math.pow(10, d.threshold / 20);
            if (d.power !== undefined) this.powerLinear = Math.pow(10, d.power / 20);
            if (d.attack !== undefined) {
                this.attackMs = d.attack;
                this._updateSmoothing();
            }
            if (d.enabled !== undefined) this.enabled = d.enabled;
            if (d.isPlaying !== undefined) this.isPlaying = d.isPlaying;
        };
    }

    _updateSmoothing() {
        // blockTime = 128 / 48000 ≈ 0.00267s
        const blockTime = 128 / 48000;
        this.smooth = 1 - Math.exp(-blockTime / (this.attackMs * 0.001));
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        if (!output.length) return true;

        const out0 = output[0];
        const out1 = output[1] || out0;
        const blockSize = out0.length;

        // RMS from first input channel only, strided
        let rms = 0;
        if (input && input[0]) {
            const samples = input[0];
            let sum = 0;
            for (let i = 0; i < samples.length; i += 8) {
                sum += samples[i] * samples[i];
            }
            rms = Math.sqrt(sum / (samples.length >> 3));
        }

        // Target level
        let target = 0;
        if (this.enabled && this.isPlaying && rms < this.thresholdLinear) {
            target = this.powerLinear;
        }

        // Smoothing with pre-computed coefficient
        const prevLevel = this.level;
        let newLevel = prevLevel + (target - prevLevel) * this.smooth;

        // Floor at -120dB instead of true zero to keep downstream filters stable
        // (prevents transients from BiquadFilter state clearing)
        if (newLevel < 0.000001) {
            newLevel = 0.000001;
        }
        this.level = newLevel;

        // Noise generation with per-sample gain ramp
        const delta = (newLevel - prevLevel) / blockSize;
        let lvl = prevLevel;
        let rng = this.rng;

        for (let i = 0; i < blockSize; i++) {
            rng = (rng * 1664525 + 1013904223) | 0;
            // Signed int / 2^31 gives -1 to +0.9999... (symmetric around 0)
            const noise = rng / 2147483648;
            out0[i] = noise * lvl;
            out1[i] = noise * lvl;
            lvl += delta;
        }

        this.rng = rng >>> 0;
        return true;
    }
}

registerProcessor('noise-processor', NoiseProcessor);
