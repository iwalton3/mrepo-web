/**
 * Comfort Noise DSP Tests
 *
 * Renders the comfort-noise audio graph through an OfflineAudioContext and
 * measures the result, so the gate's behaviour is checked numerically rather
 * than only "the toggle didn't throw" (which is all audio-effects.test.js can
 * do against a live context in headless mode).
 *
 * The curves, one-pole coefficients and level conversions are imported from
 * frontend/stores/noise-dsp.js - the same module player-store.js uses, so a
 * change to the math is caught here. The graph *wiring* is reproduced below
 * (player-store builds it as methods on a live AudioController), so a rewiring
 * mistake in the store would not be caught; keep this in sync with
 * `_initNoise` / `_updateNoiseGating`.
 *
 * Regression this guards: the attack time constant belongs *after* the gate
 * curve, not on the level detector. With it on the detector, the time for the
 * noise to fade back in scaled with how loud the music had been - a 2s attack
 * took ~16s to recover from a loud passage.
 *
 * DESIGN NOTES:
 * - Lane 1 (backend-free): this does NOT log in and never calls the API. It
 *   needs an origin serving frontend/ and nothing else, so it runs fine under
 *   `python3 -m http.server` from frontend/ as well as the harness's static
 *   server.
 * - The renders are offline and faster than realtime, but there are eight of
 *   them (one up to 12s of audio), so the single evaluate() call is the slow
 *   part of this suite rather than any page interaction.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

const BASE_URL = process.env.TEST_URL || 'http://127.0.0.1:9900';
const DSP_MODULE = `${BASE_URL}/stores/noise-dsp.js`;
const SR = 48000;

/** Runs in the browser. Returns an array of {name, pass, detail}. */
const HARNESS = async (dspUrl, sampleRate) => {
    const {
        NOISE_LOOP_SECONDS, NOISE_DETECTOR_MS,
        createNoiseSquarerCurve, createNoiseGateCurve, onePoleCoefficients,
        noiseThresholdScale, noiseLevelToLinear, noiseLoopMixGain
    } = await import(dspUrl);

    // Deterministic noise so runs are reproducible.
    let seed = 12345;
    const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return (seed / 4294967296) * 2 - 1;
    };

    function noiseBuffer(ctx, seconds) {
        const len = Math.floor(seconds * ctx.sampleRate);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = rand();
        return buf;
    }

    /**
     * Mirrors player-store `_initNoise` + `_updateNoiseGating`, rendering the
     * noise branch alone (music feeds the sidechain but not the output, so the
     * measurement is of noise only).
     */
    async function render(opts) {
        const seconds = opts.seconds || 3;
        const ctx = new OfflineAudioContext(1, sampleRate * seconds, sampleRate);

        const sources = NOISE_LOOP_SECONDS.map(s => {
            const src = ctx.createBufferSource();
            src.buffer = noiseBuffer(ctx, s);
            src.loop = true;
            return src;
        });
        const mix = ctx.createGain();
        mix.gain.value = noiseLoopMixGain();

        const low = ctx.createBiquadFilter();
        low.type = 'lowshelf'; low.frequency.value = 100; low.gain.value = 0;
        const high = ctx.createBiquadFilter();
        high.type = 'highshelf'; high.frequency.value = 3000; high.gain.value = 0;

        const powerGain = ctx.createGain();
        powerGain.gain.value = noiseLevelToLinear(opts.power);
        const gateGain = ctx.createGain();
        gateGain.gain.value = 1;
        const outputGain = ctx.createGain();
        outputGain.gain.value = 1;

        for (const s of sources) s.connect(mix);
        mix.connect(low).connect(high).connect(powerGain)
           .connect(gateGain).connect(outputGain).connect(ctx.destination);

        const onePole = ms => {
            const { feedforward, feedback } = onePoleCoefficients(ms, ctx.sampleRate);
            return ctx.createIIRFilter(feedforward, feedback);
        };

        if (opts.threshold < 0) {
            const squarer = ctx.createWaveShaper();
            squarer.curve = createNoiseSquarerCurve();
            squarer.oversample = 'none';

            const detector = onePole(NOISE_DETECTOR_MS);

            const scale = ctx.createGain();
            scale.gain.value = noiseThresholdScale(opts.threshold);

            const shaper = ctx.createWaveShaper();
            shaper.curve = createNoiseGateCurve();
            shaper.oversample = 'none';

            const attack = onePole(opts.attack);

            squarer.connect(detector).connect(scale).connect(shaper)
                   .connect(attack).connect(gateGain.gain);
            gateGain.gain.value = 0;

            if (opts.musicAmp > 0) {
                const osc = ctx.createOscillator();
                osc.frequency.value = 440;
                const amp = ctx.createGain();
                amp.gain.value = opts.musicAmp;
                osc.connect(amp).connect(squarer);
                osc.start();
                if (opts.musicStopAt) {
                    amp.gain.setValueAtTime(opts.musicAmp, 0);
                    amp.gain.setValueAtTime(0, opts.musicStopAt);
                }
            }
        }

        for (const s of sources) s.start();
        const rendered = await ctx.startRendering();
        return rendered.getChannelData(0);
    }

    function rms(data, fromSec, toSec) {
        const a = Math.floor(fromSec * sampleRate), b = Math.floor(toSec * sampleRate);
        let sum = 0;
        for (let i = a; i < b; i++) sum += data[i] * data[i];
        return Math.sqrt(sum / (b - a));
    }

    const results = [];
    const check = (name, pass, detail) => results.push({ name, pass, detail });

    // Uniform noise in [-1,1] has RMS 1/sqrt(3); the half-weighted uncorrelated
    // loops sum back to the same variance.
    const want = (1 / Math.sqrt(3)) * noiseLevelToLinear(-24);
    const rel = got => 20 * Math.log10(got / want);

    let d = await render({ threshold: 0, power: -24, attack: 25, musicAmp: 0 });
    check('always-on level matches the Level setting',
        Math.abs(rel(rms(d, 0.5, 3))) < 0.5,
        `${rel(rms(d, 0.5, 3)).toFixed(2)} dB from target`);

    d = await render({ threshold: -36, power: -24, attack: 25, musicAmp: 0 });
    check('gate fully open on silence',
        Math.abs(rel(rms(d, 0.5, 3))) < 0.5,
        `${rel(rms(d, 0.5, 3)).toFixed(2)} dB from full`);

    d = await render({ threshold: -36, power: -24, attack: 25, musicAmp: 0.5 });
    check('gate closed under loud music',
        rel(rms(d, 0.5, 3)) < -40,
        `noise suppressed by ${(-rel(rms(d, 0.5, 3))).toFixed(1)} dB`);

    // Sine RMS = A/sqrt(2). 12 dB below threshold is the bottom of the knee.
    d = await render({ threshold: -36, power: -24, attack: 25,
                       musicAmp: Math.pow(10, -48 / 20) * Math.SQRT2 });
    check('gate open 12 dB below threshold',
        Math.abs(rel(rms(d, 0.5, 3))) < 1.0,
        `${rel(rms(d, 0.5, 3)).toFixed(2)} dB from full`);

    d = await render({ threshold: -36, power: -24, attack: 25,
                       musicAmp: Math.pow(10, -36 / 20) * Math.SQRT2 });
    check('gate closed at threshold',
        rel(rms(d, 0.5, 3)) < -20,
        `${rel(rms(d, 0.5, 3)).toFixed(1)} dB from full`);

    d = await render({ threshold: -36, power: -24, attack: 25,
                       musicAmp: Math.pow(10, -42 / 20) * Math.SQRT2 });
    const mid = rel(rms(d, 0.5, 3));
    check('knee is gradual, not a step',
        mid < -1 && mid > -20, `${mid.toFixed(1)} dB from full at mid-knee`);

    // Attack applies to the gate, so recovery takes ~the attack time
    // regardless of how loud the music was.
    d = await render({ threshold: -36, power: -24, attack: 500, musicAmp: 0.5,
                       musicStopAt: 1, seconds: 4 });
    const early = rel(rms(d, 1.0, 1.1));
    const late = rel(rms(d, 2.5, 4));
    check('attack ramps over its time constant',
        early < -6 && late > -1,
        `+0.1s: ${early.toFixed(1)} dB, +1.5s: ${late.toFixed(1)} dB`);

    // The longest attack puts the one-pole coefficient very close to unity.
    d = await render({ threshold: -36, power: -24, attack: 2000, musicAmp: 0.5,
                       musicStopAt: 1, seconds: 12 });
    const settled = rel(rms(d, 9, 12));
    let finite = true;
    for (let i = 0; i < d.length; i += 97) {
        if (!Number.isFinite(d[i])) { finite = false; break; }
    }
    check('2000 ms attack is stable and settles',
        finite && Math.abs(settled) < 1.0,
        `settled ${settled.toFixed(2)} dB from full, all finite: ${finite}`);

    return results;
};

(async () => {
    await test.setup();
    // NOTE: intentionally no test.login() - the harness only needs the origin
    // to import the DSP module from; nothing here touches the backend.

    console.log('Comfort Noise DSP Tests');
    console.log('-'.repeat(50));

    // Any same-origin page will do - the harness needs the origin, not the UI.
    await test.goto('/eq/');

    let results = [];
    let harnessError = null;
    try {
        results = await test.page.evaluate(HARNESS, DSP_MODULE, SR);
    } catch (e) {
        harnessError = e;
    }

    await test.test('comfort noise DSP harness runs', async () => {
        await test.assert(!harnessError, `harness threw: ${harnessError?.message}`);
        await test.assert(results.length > 0, 'harness returned no results');
    });

    for (const r of results) {
        await test.test(r.name, async () => {
            await test.assert(r.pass, r.detail);
        });
        console.log(`     ${r.detail}`);
    }

    await test.teardown();
})();
