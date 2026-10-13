/**
 * Loudness Compensation DSP
 *
 * The four fixed filters, the gain lookup that drives them, and their
 * magnitude response. Pure math (no Web Audio) so the EQ page preview, the
 * tests and the table generator share it with the player.
 * See player-store.js `_updateLoudnessGains` for how it is applied.
 */

import { LOUDNESS_TABLE_MIN_PHON, LOUDNESS_TABLE_GAINS } from './loudness-table.js';

// Shelves use the Web Audio default slope (S = 1); Q only applies to the peak.
export const LOUDNESS_FILTERS = [
    { type: 'lowshelf', frequency: 350 },              // broad low-mid tilt
    { type: 'lowshelf', frequency: 80 },               // extra deep-bass rise
    { type: 'peaking', frequency: 3500, Q: 0.9 },     // follows the ear's sensitivity peak (a cut)
    { type: 'highshelf', frequency: 10000 }
];

export const LOUDNESS_MIN_PHON = LOUDNESS_TABLE_MIN_PHON;
export const LOUDNESS_MAX_PHON = LOUDNESS_TABLE_MIN_PHON + LOUDNESS_TABLE_GAINS.length - 1;

function tableGains(phon) {
    const p = Math.max(LOUDNESS_MIN_PHON, Math.min(LOUDNESS_MAX_PHON, phon)) - LOUDNESS_MIN_PHON;
    const i = Math.min(Math.floor(p), LOUDNESS_TABLE_GAINS.length - 2);
    const t = p - i;
    const a = LOUDNESS_TABLE_GAINS[i];
    const b = LOUDNESS_TABLE_GAINS[i + 1];
    return a.map((g, k) => g + (b[k] - g) * t);
}

/**
 * Filter gains (dB, in LOUDNESS_FILTERS order) for listening at `listenPhon`
 * material mixed at `mixPhon`. Zero when listening at or above the mix level.
 *
 * The table holds fits against one fixed top reference, and the gains for any
 * other reference are the difference of two rows. That relies on the filters'
 * dB response being close to linear in their gain, which the generator checks.
 * @param {number} listenPhon
 * @param {number} mixPhon
 * @param {number} [strength=1] - multiplier on all four gains
 * @returns {number[]}
 */
export function loudnessGains(listenPhon, mixPhon, strength = 1) {
    if (!(listenPhon < mixPhon) || strength <= 0) return LOUDNESS_FILTERS.map(() => 0);
    const listen = tableGains(listenPhon);
    const mix = tableGains(mixPhon);
    return listen.map((g, k) => (g - mix[k]) * strength);
}

/**
 * The level compensation is zero at. By default that is the level at 100%
 * volume, so lower volumes sound like full volume and full volume is left to
 * the gear's own tuning. Compensating to the mix reference is opt-in: it also
 * boosts full volume whenever the reference SPL is below the mix level.
 * @param {{loudnessReferenceSPL: number, loudnessMixPhon: number, loudnessUseMixReference: boolean}} s
 */
export function loudnessAnchorPhon(s) {
    return s.loudnessUseMixReference ? s.loudnessMixPhon : s.loudnessReferenceSPL;
}

/**
 * Filter gains for the player's loudness settings at its current volume.
 * The listening level is the reference SPL (the level at 100% volume) moved by
 * the volume in dB.
 * @param {{volume: number, loudnessReferenceSPL: number, loudnessMixPhon: number, loudnessUseMixReference: boolean, loudnessStrength: number}} s
 * @returns {number[]}
 */
export function loudnessGainsForSettings(s) {
    if (!(s.volume > 0)) return LOUDNESS_FILTERS.map(() => 0);
    const listenPhon = s.loudnessReferenceSPL + 20 * Math.log10(s.volume);
    return loudnessGains(listenPhon, loudnessAnchorPhon(s), s.loudnessStrength / 100);
}

/**
 * Magnitude response (dB) of one Web Audio BiquadFilterNode at `freq`, using
 * the coefficient formulas from the Web Audio spec (RBJ cookbook, shelf S = 1).
 */
export function biquadResponseDb(type, frequency, gainDb, Q, freq, sampleRate) {
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * frequency / sampleRate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'peaking') {
        const alpha = sin / (2 * Q);
        b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
    } else {
        const alpha = sin / 2 * Math.SQRT2;
        const k = 2 * Math.sqrt(A) * alpha;
        if (type === 'lowshelf') {
            b0 = A * ((A + 1) - (A - 1) * cos + k);
            b1 = 2 * A * ((A - 1) - (A + 1) * cos);
            b2 = A * ((A + 1) - (A - 1) * cos - k);
            a0 = (A + 1) + (A - 1) * cos + k;
            a1 = -2 * ((A - 1) + (A + 1) * cos);
            a2 = (A + 1) + (A - 1) * cos - k;
        } else {
            b0 = A * ((A + 1) + (A - 1) * cos + k);
            b1 = -2 * A * ((A - 1) + (A + 1) * cos);
            b2 = A * ((A + 1) + (A - 1) * cos - k);
            a0 = (A + 1) - (A - 1) * cos + k;
            a1 = 2 * ((A - 1) - (A + 1) * cos);
            a2 = (A + 1) - (A - 1) * cos - k;
        }
    }
    const w = 2 * Math.PI * freq / sampleRate;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
    const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/**
 * Combined response (dB) of the four loudness filters at `freq`.
 * @param {number[]} gains - dB, in LOUDNESS_FILTERS order
 */
export function loudnessResponseDb(gains, freq, sampleRate = 48000) {
    let db = 0;
    LOUDNESS_FILTERS.forEach((f, k) => {
        if (gains[k] !== 0) db += biquadResponseDb(f.type, f.frequency, gains[k], f.Q ?? 1, freq, sampleRate);
    });
    return db;
}
