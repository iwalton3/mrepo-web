/**
 * White Noise Generator AudioWorklet
 *
 * Generates white noise on the audio thread for efficiency.
 * Output is then filtered by BiquadFilter for colored noise.
 */
class NoiseProcessor extends AudioWorkletProcessor {
    process(inputs, outputs, parameters) {
        const output = outputs[0];

        for (let channel = 0; channel < output.length; channel++) {
            const outputChannel = output[channel];
            for (let i = 0; i < outputChannel.length; i++) {
                // White noise: uniform random in range [-1, 1]
                outputChannel[i] = Math.random() * 2 - 1;
            }
        }

        return true; // Keep processor alive
    }
}

registerProcessor('noise-processor', NoiseProcessor);
