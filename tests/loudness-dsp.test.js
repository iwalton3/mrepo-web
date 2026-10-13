/**
 * Loudness Compensation DSP Tests
 *
 * Checks the ISO 226 module and the fitted filter gains numerically. The
 * combined response is computed with an RBJ biquad implementation written
 * here, independently of frontend/stores/loudness-dsp.js, and that
 * implementation is itself checked against real BiquadFilterNodes - so "within
 * 2 dB of ISO 226" is a claim about what the browser actually plays.
 *
 * Lane 1 (backend-free): no login, no API; it only needs an origin serving
 * frontend/. The live-graph paths (muted, disabled) are in audio-effects.test.js.
 */

const TestHelper = require('./test-helper');
const test = new TestHelper();

const BASE_URL = process.env.TEST_URL || 'http://127.0.0.1:9900';

/** Runs in the browser. Returns an array of {name, pass, detail}. */
const HARNESS = async (base) => {
    const { ISO226_FREQS, splForPhon, compensationDb } = await import(`${base}/stores/iso226.js`);
    const { LOUDNESS_FILTERS, loudnessGains, loudnessGainsForSettings, biquadResponseDb } =
        await import(`${base}/stores/loudness-dsp.js`);

    const results = [];
    const check = (name, pass, detail) => results.push({ name, pass, detail });
    const maxAbs = arr => Math.max(...arr.map(Math.abs));

    // RBJ cookbook, evaluated as |H(e^jw)| in dB. Shelves use S = 1 and the
    // peak uses Q directly, as the Web Audio spec defines BiquadFilterNode.
    function rbjDb(type, f0, gainDb, Q, f, fs) {
        const A = 10 ** (gainDb / 40);
        const w0 = 2 * Math.PI * f0 / fs;
        const cw = Math.cos(w0);
        let b, a;
        if (type === 'peaking') {
            const al = Math.sin(w0) / (2 * Q);
            b = [1 + al * A, -2 * cw, 1 - al * A];
            a = [1 + al / A, -2 * cw, 1 - al / A];
        } else {
            const al = Math.sin(w0) / 2 * Math.sqrt(2);
            const s = 2 * Math.sqrt(A) * al;
            const sign = type === 'lowshelf' ? 1 : -1;
            b = [A * ((A + 1) - sign * (A - 1) * cw + s),
                 sign * 2 * A * ((A - 1) - sign * (A + 1) * cw),
                 A * ((A + 1) - sign * (A - 1) * cw - s)];
            a = [(A + 1) + sign * (A - 1) * cw + s,
                 -sign * 2 * ((A - 1) + sign * (A + 1) * cw),
                 (A + 1) + sign * (A - 1) * cw - s];
        }
        const w = 2 * Math.PI * f / fs;
        const mag2 = c => {
            const re = c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w);
            const im = -(c[1] * Math.sin(w) + c[2] * Math.sin(2 * w));
            return re * re + im * im;
        };
        return 10 * Math.log10(mag2(b) / mag2(a));
    }
    const chainDb = (gains, f, fs) => LOUDNESS_FILTERS.reduce(
        (db, spec, k) => db + rbjDb(spec.type, spec.frequency, gains[k], spec.Q ?? 1, f, fs), 0);

    // Real nodes, for checking the formulas above against the browser.
    function nodeChainDb(gains, freqs, fs) {
        const ctx = new OfflineAudioContext(1, 128, fs);
        const out = new Float32Array(freqs.length).fill(0);
        LOUDNESS_FILTERS.forEach((spec, k) => {
            const n = ctx.createBiquadFilter();
            n.type = spec.type;
            n.frequency.value = spec.frequency;
            if (spec.Q !== undefined) n.Q.value = spec.Q;
            n.gain.value = gains[k];
            const mag = new Float32Array(freqs.length);
            n.getFrequencyResponse(new Float32Array(freqs), mag, new Float32Array(freqs.length));
            mag.forEach((m, i) => { out[i] += 20 * Math.log10(m); });
        });
        return Array.from(out);
    }

    // ---- ISO 226 ----
    const at40 = splForPhon(40);
    check('ISO 226: 40 phon at 20 Hz is about 99.9 dB',
        Math.abs(at40[0] - 99.9) < 0.1, `${at40[0].toFixed(2)} dB`);

    // The 2003 formula with the published (rounded) table gives 40.01 at 1 kHz,
    // not exactly 40; the tolerance allows for that.
    const k1 = ISO226_FREQS.indexOf(1000);
    const off1k = [20, 40, 60, 80, 90].map(p => splForPhon(p)[k1] - p);
    check('ISO 226: 1 kHz equals the phon value',
        maxAbs(off1k) < 0.05, `max ${maxAbs(off1k).toFixed(3)} dB off`);

    // ---- zero at the mix reference ----
    const zeroComp = [75, 80, 83, 85, 90].map(p => maxAbs(compensationDb(p, p)));
    const zeroGains = [75, 80, 83, 85, 90].flatMap(p => [
        ...loudnessGains(p, p), ...loudnessGains(p + 5, p), ...loudnessGains(p, p, 1.5)
    ]);
    check('no compensation when listening at or above the mix reference',
        maxAbs(zeroComp) === 0 && maxAbs(zeroGains) === 0,
        `ISO max ${maxAbs(zeroComp)}, filter gains max ${maxAbs(zeroGains)}`);

    // ---- the formulas match the browser's biquads ----
    const probe = [20, 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 12500, 16000];
    for (const fs of [44100, 48000]) {
        const gains = loudnessGains(40, 80);
        const node = nodeChainDb(gains, probe, fs);
        const test = probe.map(f => chainDb(gains, f, fs));
        const lib = probe.map(f => LOUDNESS_FILTERS.reduce((db, s, k) =>
            db + biquadResponseDb(s.type, s.frequency, gains[k], s.Q ?? 1, f, fs), 0));
        const dTest = maxAbs(test.map((v, i) => v - node[i]));
        const dLib = maxAbs(lib.map((v, i) => v - node[i]));
        check(`RBJ formulas match BiquadFilterNode at ${fs} Hz`,
            dTest < 0.05 && dLib < 0.05,
            `test impl ${dTest.toFixed(4)} dB, loudness-dsp ${dLib.toFixed(4)} dB`);
    }

    // ---- fit quality ----
    const band = ISO226_FREQS.flatMap((f, i) => (f >= 31.5 && f <= 12500 ? [i] : []));
    for (const mix of [80, 85]) {
        for (const listen of [40, 50, 60, 70]) {
            const gains = loudnessGains(listen, mix);
            const target = compensationDb(listen, mix);
            const err = band.map(i => chainDb(gains, ISO226_FREQS[i], 48000) - target[i]);
            check(`filters within 2 dB of ISO 226 at ${listen} phon (mix ${mix}), 31.5 Hz-12.5 kHz`,
                maxAbs(err) <= 2,
                `max error ${maxAbs(err).toFixed(2)} dB; gains ${gains.map(g => g.toFixed(2)).join(', ')}`);
        }
    }

    // ---- strength ----
    const s0 = loudnessGainsForSettings({
        volume: 0.01, loudnessReferenceSPL: 80, loudnessMixPhon: 80, loudnessStrength: 0
    });
    const flat = nodeChainDb(s0, probe, 48000);
    check('strength 0 gives a flat response',
        maxAbs(s0) === 0 && maxAbs(flat) < 1e-3,
        `gains ${s0.join(', ')}; node response max ${maxAbs(flat).toExponential(1)} dB`);

    const half = loudnessGainsForSettings({
        volume: 0.01, loudnessReferenceSPL: 80, loudnessMixPhon: 80, loudnessStrength: 50
    });
    const full = loudnessGains(40, 80);
    check('strength scales all four gains',
        maxAbs(half.map((g, k) => g - full[k] / 2)) < 1e-9,
        `50%: ${half.map(g => g.toFixed(2)).join(', ')}`);

    // ---- clamping ----
    const low = loudnessGainsForSettings({
        volume: 1e-6, loudnessReferenceSPL: 80, loudnessMixPhon: 80, loudnessStrength: 100
    });
    check('listening level clamps to the table range',
        low.every(Number.isFinite) && maxAbs(low.map((g, k) => g - loudnessGains(20, 80)[k])) < 1e-9,
        `-120 dB volume -> ${low.map(g => g.toFixed(2)).join(', ')}`);

    return results;
};

(async () => {
    await test.setup();
    // NOTE: intentionally no test.login() - only the origin is needed.

    console.log('Loudness Compensation DSP Tests');
    console.log('-'.repeat(50));

    await test.goto('/eq/');

    let results = [];
    let harnessError = null;
    try {
        results = await test.page.evaluate(HARNESS, BASE_URL);
    } catch (e) {
        harnessError = e;
    }

    await test.test('loudness DSP harness runs', async () => {
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
