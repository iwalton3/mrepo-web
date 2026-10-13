/**
 * Loudness Curve
 *
 * Preview of the loudness compensation at the current volume: the ISO 226
 * target (scaled by strength) against the response of the filters that
 * approximate it, relative to loudnessAnchorPhon. Reads the player store directly, so it follows the volume
 * slider wherever that is moved.
 */

import { defineComponent, html, Component } from 'vdx/framework.js';
import { playerStore } from '../stores/player-store.js';
import { ISO226_FREQS, compensationDb } from '../stores/iso226.js';
import { loudnessGainsForSettings, loudnessResponseDb, loudnessAnchorPhon, LOUDNESS_MIN_PHON } from '../stores/loudness-dsp.js';

const W = 300;
const H = 120;
const PAD = 4;
const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MIN_DB = -6;
const GRID_FREQS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

const x = f => PAD + (W - 2 * PAD) * Math.log(f / MIN_FREQ) / Math.log(MAX_FREQ / MIN_FREQ);

export class LoudnessCurve extends Component {
    static stores = { player: playerStore };

    get listenPhon() {
        const { volume, loudnessReferenceSPL } = this.stores.player;
        return volume > 0 ? loudnessReferenceSPL + 20 * Math.log10(volume) : -Infinity;
    }

    get curves() {
        const p = this.stores.player;
        const mix = loudnessAnchorPhon(p);
        const strength = p.loudnessStrength / 100;
        const listen = Math.max(LOUDNESS_MIN_PHON, this.listenPhon);
        const gains = loudnessGainsForSettings(p);
        const target = listen < mix
            ? compensationDb(listen, mix).map(db => db * strength)
            : ISO226_FREQS.map(() => 0);
        const actual = [];
        for (let i = 0; i <= 96; i++) {
            const f = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, i / 96);
            actual.push([f, loudnessResponseDb(gains, f)]);
        }
        const peak = Math.max(12, ...target, ...actual.map(([, db]) => db));
        const maxDb = Math.ceil(peak / 6) * 6;
        const y = db => PAD + (H - 2 * PAD) * (maxDb - db) / (maxDb - MIN_DB);
        const path = pts => pts.map(([f, db], i) => `${i ? 'L' : 'M'}${x(f).toFixed(1)},${y(db).toFixed(1)}`).join('');
        return {
            target: path(ISO226_FREQS.map((f, i) => [f, target[i]])),
            actual: path(actual),
            zeroY: y(0).toFixed(1),
            maxDb
        };
    }

    template() {
        const { target, actual, zeroY, maxDb } = this.curves;
        const listen = this.listenPhon;
        const p = this.stores.player;
        const anchor = loudnessAnchorPhon(p);
        const caption = listen < anchor
            ? `Listening at ≈${Math.max(0, Math.round(listen))} phon, flat at ${anchor} phon`
            : p.loudnessUseMixReference
                ? `No compensation at this volume (≥ ${anchor} phon mix reference)`
                : 'No compensation at full volume';
        return html`
            <svg class="loudness-curve-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
                 role="img" aria-label="Loudness compensation curve">
                <path class="grid" d="${GRID_FREQS.map(f => `M${x(f).toFixed(1)},${PAD}V${H - PAD}`).join('')}"></path>
                <path class="zero" d="M${PAD},${zeroY}H${W - PAD}"></path>
                <path class="target" d="${target}"></path>
                <path class="actual" d="${actual}"></path>
            </svg>
            <div class="loudness-curve-legend">
                <span><i class="swatch actual"></i>Filters</span>
                <span><i class="swatch target"></i>ISO 226 target</span>
                <span class="scale">${MIN_DB} to +${maxDb} dB, 20 Hz to 20 kHz</span>
            </div>
            <div class="loudness-curve-caption">${caption}</div>
        `;
    }

    static styles = /*css*/`
        :host {
            display: block;
            margin-top: 0.75rem;
        }
        .loudness-curve-svg {
            display: block;
            width: 100%;
            height: 120px;
            background: var(--surface-200, #2a2a2a);
            border-radius: 4px;
        }
        .loudness-curve-svg path {
            fill: none;
            vector-effect: non-scaling-stroke;
        }
        .grid { stroke: var(--border-color, #3a3a3a); stroke-width: 1; }
        .zero { stroke: var(--text-muted, #707070); stroke-width: 1; }
        .target { stroke: var(--text-secondary, #a0a0a0); stroke-width: 1.5; stroke-dasharray: 4 3; }
        .actual { stroke: var(--primary-500, #2196f3); stroke-width: 2; }
        .loudness-curve-legend {
            display: flex;
            flex-wrap: wrap;
            gap: 0.25rem 0.75rem;
            margin-top: 0.35rem;
            font-size: 0.7rem;
            color: var(--text-muted, #707070);
        }
        .loudness-curve-legend .scale { margin-left: auto; }
        .swatch {
            display: inline-block;
            width: 14px;
            height: 0;
            margin-right: 0.3rem;
            vertical-align: middle;
            border-top: 2px solid var(--primary-500, #2196f3);
        }
        .swatch.target { border-top: 2px dashed var(--text-secondary, #a0a0a0); }
        .loudness-curve-caption {
            margin-top: 0.15rem;
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
        }
    `;
}

export default defineComponent('loudness-curve', LoudnessCurve);
