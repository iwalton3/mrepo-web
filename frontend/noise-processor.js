/**
 * Comfort Noise AudioWorklet Processor
 *
 * Analyzes input audio RMS and generates white noise when audio is quiet.
 * Runs entirely on the audio thread, so it works when the page is backgrounded.
 *
 * Input: Music audio (for RMS analysis)
 * Output: White noise at appropriate level (filtered externally for coloring)
 */
class NoiseProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        // Settings (updated via port messages)
        this.enabled = true;
        this.isPlaying = false;
        this.thresholdLinear = 0.015;  // ~-36dB default
        this.powerLinear = 0.063;       // ~-24dB default

        // Smoothing state
        this.currentNoiseLevel = 0;

        // Listen for settings updates from main thread
        this.port.onmessage = (e) => {
            const data = e.data;
            if (data.threshold !== undefined) {
                // Convert dB to linear amplitude
                this.thresholdLinear = Math.pow(10, data.threshold / 20);
            }
            if (data.power !== undefined) {
                // Convert dB to linear amplitude
                this.powerLinear = Math.pow(10, data.power / 20);
            }
            if (data.enabled !== undefined) {
                this.enabled = data.enabled;
            }
            if (data.isPlaying !== undefined) {
                this.isPlaying = data.isPlaying;
            }
        };
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];

        // If disabled or not playing, output silence
        if (!this.enabled || !this.isPlaying) {
            // Fade out smoothly
            for (let channel = 0; channel < output.length; channel++) {
                const outputChannel = output[channel];
                for (let i = 0; i < outputChannel.length; i++) {
                    this.currentNoiseLevel *= 0.999;  // Quick fade
                    outputChannel[i] = (Math.random() * 2 - 1) * this.currentNoiseLevel;
                }
            }
            return true;
        }

        // Calculate RMS from input (music)
        let sum = 0;
        let sampleCount = 0;
        if (input.length > 0) {
            for (let channel = 0; channel < input.length; channel++) {
                const samples = input[channel];
                if (samples) {
                    for (let i = 0; i < samples.length; i++) {
                        sum += samples[i] * samples[i];
                        sampleCount++;
                    }
                }
            }
        }

        const rms = sampleCount > 0 ? Math.sqrt(sum / sampleCount) : 0;

        // Determine target noise level based on RMS vs threshold
        let targetNoiseLevel = 0;
        if (this.thresholdLinear >= 1.0) {
            // Threshold at 0dB = always on
            targetNoiseLevel = this.powerLinear;
        } else if (rms < this.thresholdLinear) {
            // Below threshold - fade in noise proportionally
            // Use 6dB fade range (half the threshold in linear terms)
            const fadeRange = this.thresholdLinear * 0.5;
            const fadeAmount = Math.min(1, (this.thresholdLinear - rms) / fadeRange);
            targetNoiseLevel = fadeAmount * this.powerLinear;
        }

        // Smooth transition to avoid clicks/pops
        // ~0.1 smoothing factor at 48kHz with 128 sample blocks
        const smoothing = 0.1;
        this.currentNoiseLevel += (targetNoiseLevel - this.currentNoiseLevel) * smoothing;

        // Generate white noise at calculated level
        for (let channel = 0; channel < output.length; channel++) {
            const outputChannel = output[channel];
            for (let i = 0; i < outputChannel.length; i++) {
                outputChannel[i] = (Math.random() * 2 - 1) * this.currentNoiseLevel;
            }
        }

        return true;
    }
}

registerProcessor('noise-processor', NoiseProcessor);
