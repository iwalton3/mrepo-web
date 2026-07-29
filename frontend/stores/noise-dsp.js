/**
 * Comfort Noise DSP
 *
 * Pure helpers for the comfort-noise audio graph: the WaveShaper curves, the
 * one-pole coefficients, and the level/threshold conversions.
 *
 * Deliberately free of Web Audio and framework dependencies so the test suite
 * can import exactly the math the player uses, rather than a copy of it.
 * See player-store.js `_initNoise` for how these are wired together.
 */

// Two looping buffers of coprime length are mixed so the combined pattern only
// repeats every LCM(10, 13) = 130s. A single loop can become audible as a
// repeating texture once heavy tilt is applied.
export const NOISE_LOOP_SECONDS = [10, 13];

// Width of the gate's soft knee, in dB below the threshold, so the gate opens
// gradually instead of stepping as the envelope crosses the threshold.
export const NOISE_GATE_KNEE_DB = 12;

// Fixed smoothing on the level detector, fast enough to track the music but
// slow enough not to ripple on bass. The user's attack setting is applied
// after the gate instead - smoothing the detector rather than the gate output
// would make the time to open depend on how loud the music had been (recovery
// from a loud passage took several times longer than the attack setting).
export const NOISE_DETECTOR_MS = 20;

// Resolution of the WaveShaper curves. Generous, because the squaring curve
// needs precision near zero where quiet music lives.
export const NOISE_CURVE_SIZE = 8193;

/**
 * WaveShaper curve for x -> x^2, rectifying the music into instantaneous power
 * so the one-pole detector downstream produces a mean-power envelope.
 * @returns {Float32Array}
 */
export function createNoiseSquarerCurve() {
    const curve = new Float32Array(NOISE_CURVE_SIZE);
    for (let i = 0; i < NOISE_CURVE_SIZE; i++) {
        const x = (2 * i) / (NOISE_CURVE_SIZE - 1) - 1;
        curve[i] = x * x;
    }
    return curve;
}

/**
 * WaveShaper curve mapping the threshold-normalised envelope to a gate amount:
 * 1 (full noise) well below the threshold, 0 at or above it, with a smoothstep
 * across NOISE_GATE_KNEE_DB in between.
 *
 * The input is normalised so the threshold sits at 1.0 - see
 * noiseThresholdScale. Without that, a -36 dB threshold would land at 0.00025
 * on a curve whose points are ~0.00024 apart, and the knee would quantise away.
 * @returns {Float32Array}
 */
export function createNoiseGateCurve() {
    const curve = new Float32Array(NOISE_CURVE_SIZE);
    const kneeLow = Math.pow(10, -NOISE_GATE_KNEE_DB / 10);
    for (let i = 0; i < NOISE_CURVE_SIZE; i++) {
        const u = (2 * i) / (NOISE_CURVE_SIZE - 1) - 1;
        if (u <= kneeLow) {
            curve[i] = 1;
        } else if (u >= 1) {
            curve[i] = 0;
        } else {
            const t = Math.log10(u / kneeLow) / (NOISE_GATE_KNEE_DB / 10);
            curve[i] = 1 - t * t * (3 - 2 * t);
        }
    }
    return curve;
}

/**
 * Coefficients for a one-pole lowpass implementing
 * y[n] = a*x[n] + (1-a)*y[n-1], with unity gain at DC. Suitable for
 * BaseAudioContext.createIIRFilter().
 * @param {number} ms - Time constant in milliseconds
 * @param {number} sampleRate
 * @returns {{feedforward: number[], feedback: number[]}}
 */
export function onePoleCoefficients(ms, sampleRate) {
    const tau = Math.max(0.005, ms / 1000);
    const a = 1 - Math.exp(-1 / (sampleRate * tau));
    return { feedforward: [a], feedback: [1, -(1 - a)] };
}

/**
 * Gain that normalises the mean-power envelope so the threshold sits at 1.0,
 * which is where the gate curve expects it.
 * @param {number} thresholdDb
 * @returns {number}
 */
export function noiseThresholdScale(thresholdDb) {
    return 1 / Math.pow(10, thresholdDb / 10);
}

/**
 * Level setting (dB) to linear gain.
 * @param {number} powerDb
 * @returns {number}
 */
export function noiseLevelToLinear(powerDb) {
    return Math.pow(10, powerDb / 20);
}

/**
 * Per-loop gain. Summing N uncorrelated noise sources raises amplitude by
 * sqrt(N), so scale each back to keep the Level setting meaning what it says.
 * @returns {number}
 */
export function noiseLoopMixGain() {
    return 1 / Math.sqrt(NOISE_LOOP_SECONDS.length);
}
