/**
 * Loop Song Page
 *
 * Standalone page that plays a single song on repeat.
 * - No authentication required (UUID contains enough info)
 * - No queue interaction (doesn't corrupt queue state)
 * - Beat-aware crossfade looping for seamless transitions
 * - Uses player's audio pipeline (EQ, crossfeed, etc.)
 */

import { defineComponent, html, when } from '../../../lib/framework.js';
import { songs as songsApi, getStreamUrl } from '../offline/offline-api.js';
import { getAudioUrl } from '../offline/offline-audio.js';
import { player } from '../stores/player-store.js';

/**
 * Format duration from seconds to MM:SS or HH:MM:SS
 */
function formatDuration(seconds) {
    if (!seconds && seconds !== 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Audio analyzer for finding loop points.
 * Captures both beat onsets and rolling structural fingerprints.
 */
class BeatAnalyzer {
    constructor(analyser, { numBands = 12 } = {}) {
        this.analyser = analyser;
        this.numBands = numBands;
        this.freqData = new Uint8Array(analyser.frequencyBinCount);
        this.timeData = new Uint8Array(analyser.fftSize);

        // Logarithmic frequency bands - ensure each band has at least 1 bin
        const binCount = analyser.frequencyBinCount;
        this.bandRanges = [];
        for (let i = 0; i < numBands; i++) {
            const start = Math.floor(Math.pow(binCount, i / numBands));
            const end = Math.floor(Math.pow(binCount, (i + 1) / numBands));
            this.bandRanges.push([Math.max(1, start), Math.max(start + 1, end)]);
        }

        // For onset detection
        this.prevEnergy = 0;
        this.energyHistory = [];
        this.historySize = 10;
        this.lastOnsetTime = 0;
        this.minOnsetInterval = 0.1;

        // Rolling envelope for structural matching (sampled at ~50Hz)
        this.envelopeHistory = [];  // { time, envelope, chroma, amplitude }
    }

    /**
     * Get current spectral envelope (normalized).
     */
    getEnvelope() {
        this.analyser.getByteFrequencyData(this.freqData);

        const envelope = [];
        for (const [start, end] of this.bandRanges) {
            let sum = 0;
            for (let i = start; i < end && i < this.freqData.length; i++) {
                sum += this.freqData[i];
            }
            envelope.push(sum / (end - start));
        }

        // Normalize
        const max = Math.max(...envelope, 1);
        return envelope.map(e => e / max);
    }

    /**
     * Get chroma features - maps frequencies to 12 pitch classes.
     * Much more harmonically meaningful than raw envelope.
     */
    getChroma() {
        this.analyser.getByteFrequencyData(this.freqData);

        const chroma = new Array(12).fill(0);
        const sampleRate = this.analyser.context.sampleRate;
        const binCount = this.analyser.frequencyBinCount;
        const binWidth = sampleRate / (binCount * 2);

        // Map each FFT bin to a pitch class
        for (let i = 1; i < binCount; i++) {
            const freq = i * binWidth;
            if (freq < 60 || freq > 4000) continue;  // Focus on musical range

            // Convert frequency to MIDI note, then to pitch class (0-11)
            const midi = 12 * Math.log2(freq / 440) + 69;
            const pitchClass = Math.round(midi) % 12;

            chroma[pitchClass] += this.freqData[i];
        }

        // Normalize
        const max = Math.max(...chroma, 1);
        return chroma.map(c => c / max);
    }

    /**
     * Get low-frequency energy (for kick/beat detection).
     */
    getLowEnergy() {
        this.analyser.getByteFrequencyData(this.freqData);
        // Focus on low frequencies (first 1/8 of spectrum ~0-1kHz)
        const lowBins = Math.floor(this.freqData.length / 8);
        let sum = 0;
        for (let i = 1; i < lowBins; i++) {
            sum += this.freqData[i];
        }
        return sum / lowBins;
    }

    /**
     * Detect if current frame is a beat onset.
     * Uses low-frequency energy spike detection.
     */
    isOnset(currentTime = 0) {
        const energy = this.getLowEnergy();
        this.energyHistory.push(energy);
        if (this.energyHistory.length > this.historySize) {
            this.energyHistory.shift();
        }

        // Need enough history
        if (this.energyHistory.length < 5) {
            this.prevEnergy = energy;
            return false;
        }

        // Enforce minimum time between onsets
        if (currentTime - this.lastOnsetTime < this.minOnsetInterval) {
            this.prevEnergy = energy;
            return false;
        }

        // Average and variance for adaptive threshold
        const avgEnergy = this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length;

        // Onset = rising edge that exceeds average (sensitive for beat detection)
        const isRising = energy > this.prevEnergy * 1.05;
        const isAboveAvg = energy > avgEnergy * 1.08;
        const isOnset = isRising && isAboveAvg;

        this.prevEnergy = energy;

        if (isOnset) {
            this.lastOnsetTime = currentTime;
        }

        return isOnset;
    }

    /**
     * Capture time-domain samples for sample-level cross-correlation.
     * Returns a normalized Float32Array of samples.
     */
    getSamples() {
        this.analyser.getByteTimeDomainData(this.timeData);

        // Convert to normalized float (-1 to 1)
        const samples = new Float32Array(this.timeData.length);
        for (let i = 0; i < this.timeData.length; i++) {
            samples[i] = (this.timeData[i] - 128) / 128;
        }
        return samples;
    }

    /**
     * Get RMS amplitude of current audio.
     */
    getAmplitude() {
        this.analyser.getByteTimeDomainData(this.timeData);
        let sum = 0;
        for (let i = 0; i < this.timeData.length; i++) {
            const sample = (this.timeData[i] - 128) / 128;
            sum += sample * sample;
        }
        return Math.sqrt(sum / this.timeData.length);
    }

    /**
     * Capture a structural snapshot for the rolling history.
     */
    captureSnapshot(time) {
        const envelope = this.getEnvelope();
        const chroma = this.getChroma();
        const amplitude = this.getAmplitude();
        this.envelopeHistory.push({ time, envelope, chroma, amplitude });
    }

    /**
     * Generate chromaprint-style fingerprint for a time window.
     * Encodes transitions between adjacent chroma frames as bits.
     * This captures melodic/harmonic movement over time.
     */
    getWindowFingerprint(centerTime, windowDuration) {
        const halfWindow = windowDuration / 2;
        const startTime = centerTime - halfWindow;
        const endTime = centerTime + halfWindow;

        const snapshots = this.envelopeHistory.filter(
            s => s.time >= startTime && s.time <= endTime
        );

        if (snapshots.length < 10) return null;

        // Sort by time
        snapshots.sort((a, b) => a.time - b.time);

        // Generate chromaprint-style fingerprint
        // Each frame: 12 chroma comparisons (is this pitch class > previous?)
        // Plus 12 inter-chroma comparisons (is chroma[i] > chroma[i+1]?)
        // = 24 bits per frame transition
        const fingerprint = [];

        for (let i = 1; i < snapshots.length; i++) {
            const prev = snapshots[i - 1];
            const curr = snapshots[i];
            let bits = 0;

            // Temporal differences: did each pitch class increase?
            for (let p = 0; p < 12; p++) {
                if (curr.chroma[p] > prev.chroma[p]) {
                    bits |= (1 << p);
                }
            }

            // Spectral shape: is chroma[p] > chroma[(p+1) % 12]?
            for (let p = 0; p < 12; p++) {
                if (curr.chroma[p] > curr.chroma[(p + 1) % 12]) {
                    bits |= (1 << (12 + p));
                }
            }

            fingerprint.push(bits);
        }

        // Also store amplitude contour for shape matching
        const amplitudeShape = snapshots.map(s => s.amplitude);

        return {
            fingerprint,  // Array of 24-bit integers encoding chroma transitions
            amplitudeShape,
            snapshotCount: snapshots.length,
            startTime: snapshots[0].time,
            endTime: snapshots[snapshots.length - 1].time
        };
    }

    /**
     * Compare two chromaprint-style fingerprints.
     * Uses cubed bit-distance (rewards perfect frame matches heavily).
     * Zone-based weighting: 0-0.5s=20%, 0.5-2s=40%, 2-5s=40%
     */
    static compareFingerprintsChromaprint(fp1, fp2) {
        if (!fp1 || !fp2 || fp1.fingerprint.length < 5 || fp2.fingerprint.length < 5) {
            return { score: 0, offset: 0 };
        }

        const f1 = fp1.fingerprint;
        const f2 = fp2.fingerprint;
        const minLen = Math.min(f1.length, f2.length);
        const maxLag = Math.floor(minLen * 0.2);  // Allow 20% shift
        const center = f1.length / 2;

        // Zone boundaries in frames (at 20ms/frame: 25=0.5s, 100=2s)
        const zone1 = 25;   // 0.5s
        const zone2 = 100;  // 2s

        let bestScore = -Infinity;
        let bestLag = 0;

        for (let lag = -maxLag; lag <= maxLag; lag++) {
            let zone1Dist = 0, zone1Count = 0;
            let zone2Dist = 0, zone2Count = 0;
            let zone3Dist = 0, zone3Count = 0;

            for (let i = 0; i < f1.length; i++) {
                const j = i + lag;
                if (j >= 0 && j < f2.length) {
                    const xor = f1[i] ^ f2[j];
                    const diffBits = BeatAnalyzer._popcount(xor);

                    // Cube the difference - perfect matches (0) contribute 0, small diffs amplified
                    const cubedDist = diffBits * diffBits * diffBits;

                    const distFromCenter = Math.abs(i - center);
                    if (distFromCenter <= zone1) {
                        zone1Dist += cubedDist;
                        zone1Count++;
                    } else if (distFromCenter <= zone2) {
                        zone2Dist += cubedDist;
                        zone2Count++;
                    } else {
                        zone3Dist += cubedDist;
                        zone3Count++;
                    }
                }
            }

            // Weighted average distance (lower is better)
            // Zone weights: 0.5s=20%, 2s=40%, 5s=40%
            let totalDist = 0;
            if (zone1Count > 0) totalDist += (zone1Dist / zone1Count) * 0.2;
            if (zone2Count > 0) totalDist += (zone2Dist / zone2Count) * 0.4;
            if (zone3Count > 0) totalDist += (zone3Dist / zone3Count) * 0.4;

            // Convert distance to score (0-1 range, higher is better)
            // Max possible cubed dist per frame = 24^3 = 13824
            const maxDist = 13824;
            const score = 1 - (totalDist / maxDist);

            if (score > bestScore) {
                bestScore = score;
                bestLag = lag;
            }
        }

        return { score: Math.max(0, bestScore), offset: bestLag };
    }

    /**
     * Count set bits in a 32-bit integer using lookup table.
     */
    // Popcount lookup table
    static _popcountTable = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4, 1, 2, 2, 3, 2, 3, 3, 4, 2, 3, 3, 4, 3, 4, 4, 5, 1, 2, 2, 3, 2, 3, 3, 4, 2, 3, 3, 4, 3, 4, 4, 5, 2, 3, 3, 4, 3, 4, 4, 5, 3, 4, 4, 5, 4, 5, 5, 6, 1, 2, 2, 3, 2, 3, 3, 4, 2, 3, 3, 4, 3, 4, 4, 5, 2, 3, 3, 4, 3, 4, 4, 5, 3, 4, 4, 5, 4, 5, 5, 6, 2, 3, 3, 4, 3, 4, 4, 5, 3, 4, 4, 5, 4, 5, 5, 6, 3, 4, 4, 5, 4, 5, 5, 6, 4, 5, 5, 6, 5, 6, 6, 7, 1, 2, 2, 3, 2, 3, 3, 4, 2, 3, 3, 4, 3, 4, 4, 5, 2, 3, 3, 4, 3, 4, 4, 5, 3, 4, 4, 5, 4, 5, 5, 6, 2, 3, 3, 4, 3, 4, 4, 5, 3, 4, 4, 5, 4, 5, 5, 6, 3, 4, 4, 5, 4, 5, 5, 6, 4, 5, 5, 6, 5, 6, 6, 7, 2, 3, 3, 4, 3, 4, 4, 5, 3, 4, 4, 5, 4, 5, 5, 6, 3, 4, 4, 5, 4, 5, 5, 6, 4, 5, 5, 6, 5, 6, 6, 7, 3, 4, 4, 5, 4, 5, 5, 6, 4, 5, 5, 6, 5, 6, 6, 7, 4, 5, 5, 6, 5, 6, 6, 7, 5, 6, 6, 7, 6, 7, 7, 8];

    static _popcount(n) {
        const bl = BeatAnalyzer._popcountTable;
        return bl[n & 0xff] + bl[(n >> 8) & 0xff] + bl[(n >> 16) & 0xff] + bl[(n >> 24) & 0xff];
    }

    /**
     * Compare two envelopes using cosine similarity.
     */
    static compareEnvelopes(env1, env2) {
        if (env1.length !== env2.length) return 0;

        let dot = 0, norm1 = 0, norm2 = 0;
        for (let i = 0; i < env1.length; i++) {
            dot += env1[i] * env2[i];
            norm1 += env1[i] * env1[i];
            norm2 += env2[i] * env2[i];
        }

        if (norm1 === 0 || norm2 === 0) return 0;
        return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
    }

    /**
     * Compute normalized cross-correlation between two sample arrays.
     * Uses two-pass approach: coarse search with downsampling, then fine refinement.
     * Returns { correlation, offset } where offset is the lag for best alignment.
     */
    static crossCorrelate(samples1, samples2, maxLag = 256) {
        // Downsample factor for coarse search (16x = ~2.7kHz effective rate)
        const downsampleFactor = 16;
        const coarseMaxLag = Math.ceil(maxLag / downsampleFactor);

        // Downsample for coarse search
        const coarse1 = [];
        const coarse2 = [];
        for (let i = 0; i < samples1.length; i += downsampleFactor) {
            coarse1.push(samples1[i]);
        }
        for (let i = 0; i < samples2.length; i += downsampleFactor) {
            coarse2.push(samples2[i]);
        }

        // Coarse search
        const coarseResult = BeatAnalyzer._correlateArrays(coarse1, coarse2, coarseMaxLag);
        const coarseLag = coarseResult.bestLag * downsampleFactor;

        // Fine search around the coarse result (±downsampleFactor samples)
        const fineSearchRange = downsampleFactor * 2;
        const fineResult = BeatAnalyzer._correlateArrays(
            samples1, samples2,
            fineSearchRange,
            coarseLag - fineSearchRange  // Start from coarse estimate
        );

        return {
            correlation: Math.max(0, fineResult.bestCorr),
            offset: fineResult.bestLag
        };
    }

    /**
     * Raw cross-correlation helper.
     */
    static _correlateArrays(arr1, arr2, maxLag, startLag = null) {
        const n1 = arr1.length;
        const n2 = arr2.length;

        // Compute norms
        let norm1 = 0, norm2 = 0;
        for (let i = 0; i < n1; i++) norm1 += arr1[i] * arr1[i];
        for (let i = 0; i < n2; i++) norm2 += arr2[i] * arr2[i];

        const normFactor = Math.sqrt(norm1 * norm2);
        if (normFactor === 0) return { bestCorr: 0, bestLag: 0 };

        let bestCorr = -Infinity;
        let bestLag = 0;

        const lagStart = startLag !== null ? startLag : -maxLag;
        const lagEnd = startLag !== null ? startLag + maxLag * 2 : maxLag;

        for (let lag = lagStart; lag <= lagEnd; lag++) {
            let sum = 0;
            let count = 0;

            for (let i = 0; i < n1; i++) {
                const j = i + lag;
                if (j >= 0 && j < n2) {
                    sum += arr1[i] * arr2[j];
                    count++;
                }
            }

            if (count > n1 / 4) {  // Require at least 25% overlap
                const corr = sum / normFactor;
                if (corr > bestCorr) {
                    bestCorr = corr;
                    bestLag = lag;
                }
            }
        }

        return { bestCorr, bestLag };
    }
}

/**
 * Beat-aligned crossfade looper (Infinite Jukebox style).
 *
 * Uses AudioBuffer for sample-accurate crossfade scheduling.
 * Analysis phase uses MediaElements, playback uses scheduled BufferSourceNodes.
 *
 * Strategy:
 * 1. Analyze first N seconds via real-time playback (user is listening anyway)
 * 2. Pre-analyze last N seconds via silent MediaElement playback
 * 3. Find similar sections using chromaprint-style matching
 * 4. Schedule sample-accurate crossfades using Web Audio timing
 */
class CrossfadeLooper {
    constructor(audioBuffer, audioContext, {
        crossfadeDuration = 0.5,    // 500ms crossfade for smooth transition
        captureWindow = 60,         // Capture from first 60s
        scanWindow = 90,            // Analyze last 90s
        sampleInterval = 0.02,      // Sample every 20ms
        structuralWindow = 5,       // 5 second window for structural matching
        matchThreshold = 0.75,      // Structural similarity threshold
        minSongLength = 60          // Don't use matching for songs < 60s
    } = {}) {
        this.audioBuffer = audioBuffer;
        this.audioContext = audioContext;
        this.crossfadeDuration = crossfadeDuration;
        this.captureWindow = captureWindow;
        this.scanWindow = scanWindow;
        this.sampleInterval = sampleInterval;
        this.structuralWindow = structuralWindow;
        this.matchThreshold = matchThreshold;
        this.minSongLength = minSongLength;

        this.duration = audioBuffer.duration;

        // Playback state
        this.isPlaying = false;
        this.currentSource = null;
        this._contextTimeAtStart = 0;
        this._bufferOffsetAtStart = 0;
        this._scheduledLoopTime = null;
        this._loopCount = 0;

        // Create gain nodes for crossfade
        this.gain1 = audioContext.createGain();
        this.gain2 = audioContext.createGain();
        this.gain1.gain.value = 1;
        this.gain2.gain.value = 0;

        // Master volume gain (user control)
        this.masterGain = audioContext.createGain();
        this.masterGain.gain.value = 1;

        // Which gain is currently active
        this.activeGain = this.gain1;
        this.nextGain = this.gain2;

        // Connect gains to master
        this.gain1.connect(this.masterGain);
        this.gain2.connect(this.masterGain);

        // Analysers for real-time feature capture during analysis phase
        // Need two separate analysers for start and end sections
        this.analyser1 = audioContext.createAnalyser();
        this.analyser1.fftSize = 32768;
        this.analyser1.smoothingTimeConstant = 0.3;

        this.analyser2 = audioContext.createAnalyser();
        this.analyser2.fftSize = 32768;
        this.analyser2.smoothingTimeConstant = 0.3;

        // Beat analyzers for start and end sections
        this.beatAnalyzer1 = new BeatAnalyzer(this.analyser1);
        this.beatAnalyzer2 = new BeatAnalyzer(this.analyser2);

        // Beat storage for precise alignment
        this.startBeats = [];
        this.endBeats = [];

        // Analysis state
        this.analysisComplete = false;
        this.bestLoopPoint = null;

        this.onLoop = null;
    }

    connect(destination) {
        this.destination = destination;
        this.masterGain.connect(destination);
    }

    setVolume(value) {
        this.masterGain.gain.value = value;
    }

    /**
     * Get current playback position in the buffer.
     */
    getCurrentTime() {
        if (!this.isPlaying) return this._lastPosition || 0;
        const elapsed = this.audioContext.currentTime - this._contextTimeAtStart;
        return this._bufferOffsetAtStart + elapsed;
    }

    /**
     * Start or resume playback.
     */
    play(startOffset = 0) {
        if (this.currentSource) {
            try { this.currentSource.stop(); } catch (e) {}
            this.currentSource.disconnect();
        }

        this.currentSource = this.audioContext.createBufferSource();
        this.currentSource.buffer = this.audioBuffer;
        this.currentSource.connect(this.activeGain);

        this._contextTimeAtStart = this.audioContext.currentTime;
        this._bufferOffsetAtStart = startOffset;
        this._scheduledLoopTime = null;

        this.activeGain.gain.setValueAtTime(1, this.audioContext.currentTime);
        this.nextGain.gain.setValueAtTime(0, this.audioContext.currentTime);

        this.currentSource.start(0, startOffset);
        this.isPlaying = true;

        // Start monitoring for loop scheduling
        this._startMonitoring();
    }

    /**
     * Pause playback.
     */
    pause() {
        this._lastPosition = this.getCurrentTime();
        if (this.currentSource) {
            try { this.currentSource.stop(); } catch (e) {}
            this.currentSource.disconnect();
            this.currentSource = null;
        }
        this.isPlaying = false;
        this._stopMonitoring();
    }

    /**
     * Stop and reset.
     */
    stop() {
        this.pause();
        this._lastPosition = 0;
        this._loopCount = 0;
    }

    _startMonitoring() {
        if (this._monitorInterval) return;
        this._monitorInterval = setInterval(() => this._monitorLoop(), 100);
    }

    _stopMonitoring() {
        if (this._monitorInterval) {
            clearInterval(this._monitorInterval);
            this._monitorInterval = null;
        }
    }

    /**
     * Find best loop point using three-phase approach:
     * 1. Structural matching: Find sections with similar 5-second shape/content
     * 2. Beat alignment: Refine to nearest beat boundary within matched sections
     * 3. Sample alignment: Fine-tune with sample-level cross-correlation
     */
    _findBestLoopPoint() {
        const startHistory = this.beatAnalyzer1.envelopeHistory;
        const endHistory = this.beatAnalyzer2.envelopeHistory;

        if (startHistory.length < 50 || endHistory.length < 50) {
            console.log('Loop: Not enough snapshots (need 50+)', { start: startHistory.length, end: endHistory.length });
            return null;
        }

        // Phase 1: Structural matching with 5-second windows
        // Sample candidate positions every 0.5 seconds
        const stepSize = 0.5;
        const halfWindow = this.structuralWindow / 2;

        const structuralCandidates = [];

        // Get valid time ranges (need full window on each side)
        const startTimes = [];
        const endTimes = [];

        for (let t = halfWindow; t <= this.captureWindow - halfWindow; t += stepSize) {
            startTimes.push(t);
        }
        for (let t = endHistory[0].time + halfWindow; t <= endHistory[endHistory.length - 1].time - halfWindow; t += stepSize) {
            endTimes.push(t);
        }

        // Compare all pairs of windows using chromaprint-style matching
        console.log('Loop: Comparing windows -', startTimes.length, 'start x', endTimes.length, 'end =', startTimes.length * endTimes.length, 'pairs');

        // Log sample fingerprint for debugging
        if (startTimes.length > 0) {
            const sampleFp = this.beatAnalyzer1.getWindowFingerprint(startTimes[0], this.structuralWindow);
            if (sampleFp) {
                console.log('Loop: Sample fingerprint from start section:', {
                    length: sampleFp.fingerprint.length,
                    first5: sampleFp.fingerprint.slice(0, 5).map(n => n.toString(2).padStart(24, '0')),
                    snapshotCount: sampleFp.snapshotCount
                });
            }
        }

        let comparisons = 0;
        let skippedFp = 0;
        let allScores = [];

        for (const endTime of endTimes) {
            const endFp = this.beatAnalyzer2.getWindowFingerprint(endTime, this.structuralWindow);
            if (!endFp || endFp.fingerprint.length < 20) {
                skippedFp++;
                continue;
            }

            for (const startTime of startTimes) {
                const startFp = this.beatAnalyzer1.getWindowFingerprint(startTime, this.structuralWindow);
                if (!startFp || startFp.fingerprint.length < 20) {
                    skippedFp++;
                    continue;
                }

                comparisons++;
                const { score, offset } = BeatAnalyzer.compareFingerprintsChromaprint(endFp, startFp);
                allScores.push(score);

                if (score >= this.matchThreshold) {
                    structuralCandidates.push({
                        endTime,
                        startTime,
                        structuralScore: score,
                        alignmentOffset: offset,  // Frame offset for best alignment
                        endFp,
                        startFp
                    });
                }
            }
        }

        // Log score distribution
        if (allScores.length > 0) {
            allScores.sort((a, b) => b - a);
            console.log('Loop: Fingerprint scores - best:', (allScores[0] * 100).toFixed(1) + '%',
                'median:', (allScores[Math.floor(allScores.length / 2)] * 100).toFixed(1) + '%',
                'threshold:', (this.matchThreshold * 100).toFixed(1) + '%');
            console.log('Loop: Top 5 scores:', allScores.slice(0, 5).map(s => (s * 100).toFixed(1) + '%').join(', '));
        }

        console.log('Loop: Comparisons:', comparisons, 'skipped (short fp):', skippedFp, 'candidates above threshold:', structuralCandidates.length);

        if (structuralCandidates.length === 0) {
            console.log('Loop: No structural matches found above threshold');
            return null;
        }

        // Get top structural candidates
        const bestStructuralScore = Math.max(...structuralCandidates.map(c => c.structuralScore));
        let topCandidates = structuralCandidates.filter(c => c.structuralScore >= bestStructuralScore - 0.05);
        topCandidates.sort((a, b) => b.structuralScore - a.structuralScore);
        topCandidates = topCandidates.slice(0, 10);

        console.log('Loop: Top candidates for fine alignment:', topCandidates.length);

        // Phase 2: Fine alignment using high-resolution chromaprint (0.5s window)
        const fineWindow = 0.5;  // 0.5 second window for fine alignment
        const refined = [];

        for (const candidate of topCandidates) {
            // Coarse alignment from structural match
            const coarseAlignedStart = candidate.startTime + (candidate.alignmentOffset * this.sampleInterval);

            // Search for best fine alignment within ±0.5s of the coarse position
            let bestFineScore = 0;
            let bestEndTime = candidate.endTime;
            let bestStartTime = coarseAlignedStart;

            // Try different offsets at 20ms resolution
            for (let offsetMs = -500; offsetMs <= 500; offsetMs += 20) {
                const offsetS = offsetMs / 1000;
                const testEndTime = candidate.endTime + offsetS;
                const testStartTime = coarseAlignedStart + offsetS;

                // Get fine fingerprints (0.5s windows)
                const endFp = this.beatAnalyzer2.getWindowFingerprint(testEndTime, fineWindow);
                const startFp = this.beatAnalyzer1.getWindowFingerprint(testStartTime, fineWindow);

                if (!endFp || !startFp || endFp.fingerprint.length < 5 || startFp.fingerprint.length < 5) {
                    continue;
                }

                // Compare with same cubed-distance algorithm
                const { score } = BeatAnalyzer.compareFingerprintsChromaprint(endFp, startFp);

                if (score > bestFineScore) {
                    bestFineScore = score;
                    bestEndTime = testEndTime;
                    bestStartTime = testStartTime;
                }
            }

            refined.push({
                endTime: bestEndTime,
                startTime: bestStartTime,
                fineScore: bestFineScore,
                structuralScore: candidate.structuralScore,
                // Combined: structural got us here, fine score picks the best
                combinedScore: candidate.structuralScore * 0.3 + bestFineScore * 0.7
            });

            console.log(`Loop:   Candidate end=${candidate.endTime.toFixed(1)}s: fineScore=${(bestFineScore * 100).toFixed(1)}% offset=${((bestEndTime - candidate.endTime) * 1000).toFixed(0)}ms`);
        }

        // Calculate loop duration for each candidate
        for (const r of refined) {
            r.loopDuration = r.endTime - r.startTime;
        }

        // Cluster candidates by duration (within 5s = same cluster)
        const clusterThreshold = 5;
        refined.sort((a, b) => b.loopDuration - a.loopDuration);  // Sort by duration desc first

        const clusters = [];
        for (const r of refined) {
            let addedToCluster = false;
            for (const cluster of clusters) {
                if (Math.abs(cluster.duration - r.loopDuration) <= clusterThreshold) {
                    cluster.candidates.push(r);
                    if (r.fineScore > cluster.bestFineScore) {
                        cluster.bestFineScore = r.fineScore;
                        cluster.bestCandidate = r;
                    }
                    addedToCluster = true;
                    break;
                }
            }
            if (!addedToCluster) {
                clusters.push({
                    duration: r.loopDuration,
                    bestFineScore: r.fineScore,
                    bestCandidate: r,
                    candidates: [r]
                });
            }
        }

        // Sort clusters: trade-off between duration and best fine score
        // 20 seconds duration = 0.1% fine score
        clusters.sort((a, b) => {
            const durationDiff = b.duration - a.duration;
            const fineDiff = b.bestFineScore - a.bestFineScore;
            const durationAsScore = durationDiff * 0.00005;
            return (fineDiff + durationAsScore) > 0 ? 1 : -1;
        });

        console.log('Loop: Duration clusters:');
        clusters.slice(0, 3).forEach((c, i) => {
            console.log(`Loop:   Cluster ${i + 1}: ~${c.duration.toFixed(0)}s duration, ${c.candidates.length} candidates, best fine=${(c.bestFineScore * 100).toFixed(1)}%`);
        });

        // Pick the best candidate from the best cluster
        const bestCluster = clusters[0];
        const winner = bestCluster.bestCandidate;

        console.log('Loop: Winner from best cluster:');
        console.log(`Loop:   end=${winner.endTime.toFixed(2)}s -> start=${winner.startTime.toFixed(2)}s (fine=${(winner.fineScore * 100).toFixed(1)}% duration=${winner.loopDuration.toFixed(1)}s)`);

        // Final step: sample-level refinement for sub-20ms precision
        // Find closest captured beats to the winner times
        const endBeat = this.endBeats.reduce((closest, b) =>
            Math.abs(b.time - winner.endTime) < Math.abs(closest.time - winner.endTime) ? b : closest
        , this.endBeats[0]);

        const startBeat = this.startBeats.reduce((closest, b) =>
            Math.abs(b.time - winner.startTime) < Math.abs(closest.time - winner.startTime) ? b : closest
        , this.startBeats[0]);

        let finalStartTime = winner.startTime;

        if (endBeat?.samples && startBeat?.samples) {
            const sampleRate = this.audioContext.sampleRate;
            const samples1 = endBeat.samples;
            const samples2 = startBeat.samples;
            const len = Math.min(samples1.length, samples2.length);

            // Search ±50ms (±2205 samples at 44.1kHz) for best alignment
            const maxLag = Math.min(Math.floor(sampleRate * 0.05), Math.floor(len / 4));
            let minError = Infinity;
            let bestOffset = 0;

            for (let lag = -maxLag; lag <= maxLag; lag++) {
                let error = 0;
                let count = 0;
                for (let i = 0; i < len; i++) {
                    const j = i + lag;
                    if (j >= 0 && j < len) {
                        const diff = samples1[i] - samples2[j];
                        error += diff * diff;
                        count++;
                    }
                }
                if (count > 0) {
                    error /= count;
                    if (error < minError) {
                        minError = error;
                        bestOffset = lag;
                    }
                }
            }

            const timeOffset = bestOffset / sampleRate;
            finalStartTime = startBeat.time + timeOffset;

            console.log(`Loop: Sample refinement: offset=${bestOffset} samples (${(timeOffset * 1000).toFixed(1)}ms), error=${minError.toFixed(6)}`);
        }

        return {
            endTime: winner.endTime,
            startTime: finalStartTime,
            score: winner.fineScore
        };
    }

    /**
     * Monitor loop - checks if we need to schedule a crossfade.
     * With AudioBuffer, we schedule crossfades ahead of time for sample-accuracy.
     */
    _monitorLoop() {
        if (!this.isPlaying) return;

        const currentTime = this.getCurrentTime();

        // If analysis is complete and we have a loop point, schedule the crossfade
        if (this.analysisComplete && this.bestLoopPoint) {
            const timeToLoop = this.bestLoopPoint.endTime - currentTime;

            // Schedule crossfade 2 seconds ahead (gives us time to set it up)
            if (timeToLoop > 0.5 && timeToLoop <= 2.0 && !this._scheduledLoopTime) {
                this._scheduleLoop();
            }
        }

        // Fallback: if no loop point, loop to start
        if (this.analysisComplete && !this.bestLoopPoint) {
            const timeToEnd = this.duration - currentTime;
            if (timeToEnd > 0.5 && timeToEnd <= 2.0 && !this._scheduledLoopTime) {
                this._scheduleLoopToStart();
            }
        }
    }

    /**
     * Schedule a sample-accurate crossfade at the loop point.
     * Uses Web Audio's precise timing for sub-millisecond accuracy.
     */
    _scheduleLoop() {
        if (!this.bestLoopPoint || this._scheduledLoopTime) return;

        const currentPos = this.getCurrentTime();
        const timeUntilLoop = this.bestLoopPoint.endTime - currentPos;
        const crossfadeStart = this.audioContext.currentTime + timeUntilLoop;

        this._scheduledLoopTime = crossfadeStart;

        console.log(`Loop: Scheduling crossfade in ${(timeUntilLoop * 1000).toFixed(0)}ms`,
            `(end=${this.bestLoopPoint.endTime.toFixed(2)}s -> start=${this.bestLoopPoint.startTime.toFixed(2)}s)`);

        // Create next source node
        const nextSource = this.audioContext.createBufferSource();
        nextSource.buffer = this.audioBuffer;
        nextSource.connect(this.nextGain);

        // Schedule gain crossfade with sample accuracy
        this.activeGain.gain.setValueAtTime(1, crossfadeStart);
        this.activeGain.gain.linearRampToValueAtTime(0, crossfadeStart + this.crossfadeDuration);

        this.nextGain.gain.setValueAtTime(0, crossfadeStart);
        this.nextGain.gain.linearRampToValueAtTime(1, crossfadeStart + this.crossfadeDuration);

        // Start next source at EXACT time from EXACT position - this is sample-accurate!
        nextSource.start(crossfadeStart, this.bestLoopPoint.startTime);

        // Schedule old source to stop after crossfade completes
        if (this.currentSource) {
            try {
                this.currentSource.stop(crossfadeStart + this.crossfadeDuration + 0.1);
            } catch (e) {}
        }

        // Update state for next iteration
        this._nextSource = nextSource;

        // Schedule the swap after crossfade completes
        const swapDelay = (timeUntilLoop + this.crossfadeDuration) * 1000 + 50;
        setTimeout(() => this._completeCrossfade(), swapDelay);
    }

    /**
     * Schedule loop back to start (fallback when no match found).
     */
    _scheduleLoopToStart() {
        if (this._scheduledLoopTime) return;

        const currentPos = this.getCurrentTime();
        const timeUntilEnd = this.duration - currentPos;
        const crossfadeStart = this.audioContext.currentTime + timeUntilEnd - this.crossfadeDuration;

        this._scheduledLoopTime = crossfadeStart;

        console.log(`Loop: Scheduling loop to start in ${(timeUntilEnd * 1000).toFixed(0)}ms`);

        // Create next source node
        const nextSource = this.audioContext.createBufferSource();
        nextSource.buffer = this.audioBuffer;
        nextSource.connect(this.nextGain);

        // Schedule gain crossfade
        this.activeGain.gain.setValueAtTime(1, crossfadeStart);
        this.activeGain.gain.linearRampToValueAtTime(0, crossfadeStart + this.crossfadeDuration);

        this.nextGain.gain.setValueAtTime(0, crossfadeStart);
        this.nextGain.gain.linearRampToValueAtTime(1, crossfadeStart + this.crossfadeDuration);

        // Start from beginning
        nextSource.start(crossfadeStart, 0);

        if (this.currentSource) {
            try {
                this.currentSource.stop(crossfadeStart + this.crossfadeDuration + 0.1);
            } catch (e) {}
        }

        this._nextSource = nextSource;

        const swapDelay = timeUntilEnd * 1000 + 50;
        setTimeout(() => this._completeCrossfade(), swapDelay);
    }

    /**
     * Complete the crossfade - swap active/next and prepare for next loop.
     */
    _completeCrossfade() {
        // Swap sources
        this.currentSource = this._nextSource;
        this._nextSource = null;

        // Swap gains
        [this.activeGain, this.nextGain] = [this.nextGain, this.activeGain];

        // Update tracking - the new source started at the loop start time
        const loopStartTime = this.bestLoopPoint ? this.bestLoopPoint.startTime : 0;
        this._contextTimeAtStart = this._scheduledLoopTime;
        this._bufferOffsetAtStart = loopStartTime;

        // Reset for next loop
        this._scheduledLoopTime = null;
        this._loopCount++;

        console.log(`Loop: Crossfade complete, loop #${this._loopCount}`);

        if (this.onLoop) this.onLoop();
    }

    /**
     * Run analysis using two MediaElements connected via player.
     * This uses the same approach that worked before the buffer refactor.
     */
    async runAnalysis(audio1, source1, audio2, source2, silentGain) {
        console.log('Loop: Starting analysis...');

        // Connect sources to analysers (tapping audio before silent gain)
        source1.connect(this.analyser1);
        source2.connect(this.analyser2);

        // Reset analyzers
        this.beatAnalyzer1.envelopeHistory = [];
        this.beatAnalyzer2.envelopeHistory = [];
        this.startBeats = [];
        this.endBeats = [];

        // Phase 1: Analyze start section (first captureWindow seconds)
        console.log('Loop: Analyzing start section...');
        audio1.currentTime = 0;
        await audio1.play();

        await new Promise(resolve => {
            let lastSampleTime = 0;
            const captureStart = () => {
                if (audio1.currentTime >= this.captureWindow) {
                    audio1.pause();
                    resolve();
                    return;
                }

                const currentTime = audio1.currentTime;
                if (currentTime - lastSampleTime >= this.sampleInterval) {
                    this.beatAnalyzer1.captureSnapshot(currentTime);
                    if (this.beatAnalyzer1.isOnset(currentTime)) {
                        const envelope = this.beatAnalyzer1.getEnvelope();
                        const chroma = this.beatAnalyzer1.getChroma();
                        const samples = this.beatAnalyzer1.getSamples();
                        this.startBeats.push({ time: currentTime, envelope, chroma, samples });
                    }
                    lastSampleTime = currentTime;
                }
                requestAnimationFrame(captureStart);
            };
            captureStart();
        });

        console.log('Loop: Start section -', this.beatAnalyzer1.envelopeHistory.length, 'snapshots,', this.startBeats.length, 'beats');

        // Phase 2: Analyze end section (last scanWindow seconds)
        if (this.duration >= this.minSongLength) {
            console.log('Loop: Analyzing end section...');
            const endStart = Math.max(0, this.duration - this.scanWindow);
            audio2.currentTime = endStart;

            // Reset for end section
            this.beatAnalyzer2.energyHistory = [];
            this.beatAnalyzer2.prevEnergy = 0;

            await audio2.play();

            await new Promise(resolve => {
                let lastSampleTime = endStart;
                const captureEnd = () => {
                    if (audio2.ended || audio2.currentTime >= this.duration - 0.1) {
                        audio2.pause();
                        resolve();
                        return;
                    }

                    const currentTime = audio2.currentTime;
                    if (currentTime - lastSampleTime >= this.sampleInterval) {
                        this.beatAnalyzer2.captureSnapshot(currentTime);
                        if (this.beatAnalyzer2.isOnset(currentTime)) {
                            const envelope = this.beatAnalyzer2.getEnvelope();
                            const chroma = this.beatAnalyzer2.getChroma();
                            const samples = this.beatAnalyzer2.getSamples();
                            this.endBeats.push({ time: currentTime, envelope, chroma, samples });
                        }
                        lastSampleTime = currentTime;
                    }
                    requestAnimationFrame(captureEnd);
                };
                captureEnd();
            });

            console.log('Loop: End section -', this.beatAnalyzer2.envelopeHistory.length, 'snapshots,', this.endBeats.length, 'beats');
        }

        // Find best loop point
        this.bestLoopPoint = this._findBestLoopPoint();
        this.analysisComplete = true;

        if (this.bestLoopPoint) {
            console.log('Loop: Found loop point', {
                endTime: this.bestLoopPoint.endTime.toFixed(2),
                startTime: this.bestLoopPoint.startTime.toFixed(2),
                score: (this.bestLoopPoint.score * 100).toFixed(1) + '%'
            });
        } else {
            console.log('Loop: No suitable loop point found, will loop to start');
        }

        return this.bestLoopPoint;
    }
}

export default defineComponent('loopsong-page', {
    props: {
        params: {}
    },

    data() {
        return {
            song: null,
            error: null,
            loading: true,
            bufferLoading: false,
            analyzing: false,
            isPlaying: false,
            currentTime: 0,
            duration: 0,
            volume: parseFloat(localStorage.getItem('loopsong-volume') || '1.0'),
            loopCount: 0,
            copied: false
        };
    },

    async mounted() {
        // Load song from UUID
        const uuid = this.props.params?.uuid;
        if (!uuid) {
            this.state.error = 'No song UUID provided';
            this.state.loading = false;
            return;
        }

        await this._loadSong(uuid);
    },

    unmounted() {
        // Stop the looper
        if (this._looper) {
            this._looper.stop();
        }

        // Clean up analysis audio elements
        if (this._analysisAudio1) {
            this._analysisAudio1.pause();
            this._analysisAudio1.src = '';
        }
        if (this._analysisAudio2) {
            this._analysisAudio2.pause();
            this._analysisAudio2.src = '';
        }

        if (this._timeUpdateInterval) {
            clearInterval(this._timeUpdateInterval);
        }
        if (this._audioContext) {
            this._audioContext.close().catch(() => {});
        }
    },

    methods: {
        async _loadSong(uuid) {
            this.state.loading = true;
            this.state.error = null;

            try {
                // Fetch song metadata
                const song = await songsApi.get(uuid);
                if (!song || song.error) {
                    this.state.error = song?.error || 'Song not found';
                    this.state.loading = false;
                    return;
                }

                this.state.song = song;
                this.state.duration = song.duration_seconds || 0;

                // Get audio URL (try offline first, then streaming)
                let audioUrl = await getAudioUrl(uuid);
                if (!audioUrl) {
                    audioUrl = getStreamUrl(uuid, song.type);
                }

                this._audioUrl = audioUrl;
                this.state.loading = false;
            } catch (e) {
                console.error('Failed to load song:', e);
                this.state.error = `Failed to load song: ${e.message}`;
                this.state.loading = false;
            }
        },

        async _initAudioPipeline() {
            console.log('Loop: Initializing audio pipeline...');
            this.state.bufferLoading = true;

            try {
                // Create audio context via player (ensures correct latency hints)
                this._audioContext = player.getAudioContext();
                if (!this._audioContext) {
                    // Initialize player's audio context
                    const tempAudio = new Audio();
                    tempAudio.src = this._audioUrl;
                    const { disconnect } = await player.connectExternalAudio(tempAudio);
                    disconnect();
                    tempAudio.src = '';
                    this._audioContext = player.getAudioContext();
                }

                if (!this._audioContext) {
                    throw new Error('Failed to get audio context');
                }

                // Resume context if suspended
                if (this._audioContext.state === 'suspended') {
                    await this._audioContext.resume();
                }

                // Fetch and decode audio into buffer
                console.log('Loop: Fetching audio buffer...');
                const response = await fetch(this._audioUrl);
                const arrayBuffer = await response.arrayBuffer();

                console.log('Loop: Decoding audio data...');
                this._audioBuffer = await this._audioContext.decodeAudioData(arrayBuffer);
                this.state.duration = this._audioBuffer.duration;

                console.log('Loop: Audio buffer ready:', {
                    duration: this._audioBuffer.duration.toFixed(1) + 's',
                    sampleRate: this._audioBuffer.sampleRate,
                    channels: this._audioBuffer.numberOfChannels
                });

                // Get EQ filters for output routing
                const eqFilters = player.getEQFilters();
                const destination = (eqFilters && eqFilters.length > 0)
                    ? eqFilters[0]
                    : this._audioContext.destination;

                // Create the crossfade looper with the audio buffer
                this._looper = new CrossfadeLooper(this._audioBuffer, this._audioContext);
                this._looper.connect(destination);
                this._looper.setVolume(this.state.volume);
                this._looper.onLoop = () => {
                    this.state.loopCount++;
                };
            } finally {
                this.state.bufferLoading = false;
            }
        },

        async _runAnalysis() {
            this.state.analyzing = true;

            try {
                // Create two audio elements for analysis (same approach that worked before)
                this._analysisAudio1 = new Audio();
                this._analysisAudio2 = new Audio();

                this._analysisAudio1.src = this._audioUrl;
                this._analysisAudio2.src = this._audioUrl;
                this._analysisAudio1.preload = 'auto';
                this._analysisAudio2.preload = 'auto';
                this._analysisAudio1.volume = 1;  // Full volume for analysis
                this._analysisAudio2.volume = 1;

                // Wait for both to be ready
                await Promise.all([
                    new Promise((resolve, reject) => {
                        this._analysisAudio1.addEventListener('canplaythrough', resolve, { once: true });
                        this._analysisAudio1.addEventListener('error', reject, { once: true });
                        this._analysisAudio1.load();
                    }),
                    new Promise((resolve, reject) => {
                        this._analysisAudio2.addEventListener('canplaythrough', resolve, { once: true });
                        this._analysisAudio2.addEventListener('error', reject, { once: true });
                        this._analysisAudio2.load();
                    })
                ]);

                // Connect via player (this properly sets up MediaElementSource)
                const { source: source1, disconnect: disconnect1 } = await player.connectExternalAudio(this._analysisAudio1);
                const { source: source2, disconnect: disconnect2 } = await player.connectExternalAudio(this._analysisAudio2);

                // Disconnect from EQ - we'll route through silent gain
                disconnect1();
                disconnect2();

                // Create silent output (sources need to connect to destination to process)
                const silentGain = this._audioContext.createGain();
                silentGain.gain.value = 0;
                silentGain.connect(this._audioContext.destination);

                source1.connect(silentGain);
                source2.connect(silentGain);

                // Run the analysis
                await this._looper.runAnalysis(
                    this._analysisAudio1, source1,
                    this._analysisAudio2, source2,
                    silentGain
                );

                // Clean up
                silentGain.disconnect();
                source1.disconnect();
                source2.disconnect();
            } finally {
                // Clean up analysis audio elements
                if (this._analysisAudio1) {
                    this._analysisAudio1.pause();
                    this._analysisAudio1.src = '';
                    this._analysisAudio1 = null;
                }
                if (this._analysisAudio2) {
                    this._analysisAudio2.pause();
                    this._analysisAudio2.src = '';
                    this._analysisAudio2 = null;
                }
                this.state.analyzing = false;
            }
        },

        async togglePlay() {
            if (!this._audioUrl || this.state.bufferLoading) return;

            if (this.state.isPlaying) {
                // Pause
                if (this._looper) {
                    this._looper.pause();
                }
                this.state.isPlaying = false;
                if (this._timeUpdateInterval) {
                    clearInterval(this._timeUpdateInterval);
                    this._timeUpdateInterval = null;
                }
            } else {
                try {
                    // Initialize audio pipeline on first play (requires user gesture)
                    if (!this._audioBuffer) {
                        await this._initAudioPipeline();
                    }

                    // Resume context if suspended
                    if (this._audioContext.state === 'suspended') {
                        await this._audioContext.resume();
                    }

                    // Run analysis if not done yet (happens in background during first playback)
                    if (!this._looper.analysisComplete && !this.state.analyzing) {
                        // Start analysis in background
                        this._runAnalysis().catch(e => console.error('Analysis error:', e));
                    }

                    // Start playback from buffer
                    const startPosition = this._looper.getCurrentTime() || 0;
                    this._looper.play(startPosition);

                    this.state.isPlaying = true;
                    this._timeUpdateInterval = setInterval(() => {
                        if (this._looper && this._looper.isPlaying) {
                            this.state.currentTime = this._looper.getCurrentTime();
                        }
                    }, 250);
                } catch (e) {
                    console.error('Play failed:', e);
                    this.state.error = 'Playback failed. Try clicking play again.';
                }
            }
        },

        handleSeek(e) {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const percent = x / rect.width;
            const newTime = percent * this.state.duration;

            if (this._looper && this._looper.isPlaying) {
                // Restart playback from new position
                this._looper.play(newTime);
            }
            this.state.currentTime = newTime;
        },

        handleVolumeChange(e) {
            const volume = parseFloat(e.target.value);
            this.state.volume = volume;
            if (this._looper) {
                this._looper.setVolume(volume);
            }
            localStorage.setItem('loopsong-volume', String(volume));
        },

        async copyPermalink() {
            try {
                await navigator.clipboard.writeText(window.location.href);
                this.state.copied = true;
                setTimeout(() => { this.state.copied = false; }, 1500);
            } catch (e) {
                console.error('Failed to copy:', e);
            }
        },

        goToLibrary() {
            window.location.hash = '/';
        }
    },

    template() {
        const { song, error, loading, analyzing, isPlaying, currentTime, duration, volume, loopCount, copied } = this.state;

        if (loading) {
            return html`
                <div class="loop-page">
                    <div class="loading-state">
                        <div class="loading-spinner"></div>
                        <div class="loading-text">Loading song...</div>
                    </div>
                </div>
            `;
        }

        if (error) {
            return html`
                <div class="loop-page">
                    <div class="error-state">
                        <div class="error-icon">!</div>
                        <div class="error-message">${error}</div>
                        <button class="back-btn" on-click="goToLibrary">Go to Library</button>
                    </div>
                </div>
            `;
        }

        const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

        return html`
            <div class="loop-page">
                <div class="loop-container">
                    <div class="loop-badge">${analyzing ? 'Analyzing...' : 'Loop Mode'}</div>

                    <div class="song-info">
                        <h1 class="song-title">${song?.title || 'Unknown'}</h1>
                        <div class="song-artist">${song?.artist || 'Unknown Artist'}</div>
                        ${when(song?.album, html`
                            <div class="song-album">${song.album}</div>
                        `)}
                    </div>

                    <div class="player-controls">
                        <button class="play-btn ${this.state.bufferLoading ? 'loading' : ''}" on-click="togglePlay">
                            ${this.state.bufferLoading
                                ? html`<span class="icon">\u23F3</span>`
                                : isPlaying
                                    ? html`<span class="pause-icon"></span>`
                                    : html`<span class="play-icon"></span>`}
                        </button>
                    </div>

                    <div class="progress-section">
                        <div class="progress-bar" on-click="handleSeek">
                            <div class="progress-fill" style="width: ${progressPercent}%"></div>
                        </div>
                        <div class="time-display">
                            <span>${formatDuration(currentTime)}</span>
                            <span>${formatDuration(duration)}</span>
                        </div>
                    </div>

                    <div class="volume-section">
                        <span class="volume-icon">${volume === 0 ? '\uD83D\uDD07' : volume < 0.5 ? '\uD83D\uDD09' : '\uD83D\uDD0A'}</span>
                        <input type="range" class="volume-slider"
                            min="0" max="1" step="0.01"
                            value="${volume}"
                            on-input="handleVolumeChange">
                    </div>

                    <div class="loop-stats">
                        <span class="loop-count">Loops: ${loopCount}</span>
                    </div>

                    <div class="actions">
                        <button class="action-btn ${copied ? 'copied' : ''}" on-click="copyPermalink">
                            ${copied ? 'Copied!' : 'Copy Link'}
                        </button>
                        <button class="action-btn secondary" on-click="goToLibrary">
                            Go to Library
                        </button>
                    </div>
                </div>
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: block;
            height: 100%;
            background: var(--surface-100, #1e1e1e);
        }

        .loop-page {
            min-height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
        }

        .loading-state,
        .error-state {
            text-align: center;
            color: var(--text-secondary, #a0a0a0);
        }

        .loading-spinner {
            width: 48px;
            height: 48px;
            border: 4px solid var(--surface-300, #404040);
            border-top-color: var(--primary-500, #3b82f6);
            border-radius: 50%;
            margin: 0 auto 16px;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .error-icon {
            width: 64px;
            height: 64px;
            border-radius: 50%;
            background: var(--error-500, #ef4444);
            color: white;
            font-size: 32px;
            font-weight: bold;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 16px;
        }

        .error-message {
            margin-bottom: 24px;
            color: var(--text-primary, #e0e0e0);
        }

        .loop-container {
            max-width: 400px;
            width: 100%;
            background: var(--surface-200, #2a2a2a);
            border-radius: 16px;
            padding: 32px;
            text-align: center;
        }

        .loop-badge {
            display: inline-block;
            background: var(--primary-500, #3b82f6);
            color: white;
            font-size: 0.75rem;
            font-weight: 600;
            padding: 4px 12px;
            border-radius: 12px;
            margin-bottom: 24px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .song-info {
            margin-bottom: 32px;
        }

        .song-title {
            font-size: 1.5rem;
            font-weight: 600;
            color: var(--text-primary, #e0e0e0);
            margin: 0 0 8px;
            line-height: 1.3;
        }

        .song-artist {
            font-size: 1rem;
            color: var(--text-secondary, #a0a0a0);
            margin-bottom: 4px;
        }

        .song-album {
            font-size: 0.875rem;
            color: var(--text-tertiary, #707070);
        }

        .player-controls {
            margin-bottom: 24px;
        }

        .play-btn {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: var(--primary-500, #3b82f6);
            border: none;
            color: white;
            cursor: pointer;
            transition: all 0.2s;
            margin: 0 auto;
            padding: 0;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .play-btn:hover {
            background: var(--primary-600, #2563eb);
            transform: scale(1.05);
        }

        .play-btn:active {
            transform: scale(0.95);
        }

        /* CSS play triangle */
        .play-icon {
            width: 0;
            height: 0;
            border-style: solid;
            border-width: 14px 0 14px 22px;
            border-color: transparent transparent transparent white;
            margin-left: 6px;
        }

        /* CSS pause bars */
        .pause-icon {
            display: flex;
            gap: 6px;
        }

        .pause-icon::before,
        .pause-icon::after {
            content: '';
            width: 8px;
            height: 26px;
            background: white;
            border-radius: 2px;
        }

        /* Loading state */
        .play-btn.loading {
            cursor: wait;
            animation: pulse 1s infinite;
        }

        .play-btn .icon {
            font-size: 32px;
            filter: brightness(0) invert(1);
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
        }

        .progress-section {
            margin-bottom: 20px;
        }

        .progress-bar {
            height: 8px;
            background: var(--surface-300, #404040);
            border-radius: 4px;
            cursor: pointer;
            overflow: hidden;
        }

        .progress-fill {
            height: 100%;
            background: var(--primary-500, #3b82f6);
            border-radius: 4px;
            transition: width 0.1s linear;
        }

        .time-display {
            display: flex;
            justify-content: space-between;
            margin-top: 8px;
            font-size: 0.75rem;
            color: var(--text-secondary, #a0a0a0);
            font-variant-numeric: tabular-nums;
        }

        .volume-section {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 20px;
        }

        .volume-icon {
            font-size: 1.25rem;
            width: 28px;
            text-align: center;
        }

        .volume-slider {
            flex: 1;
            height: 6px;
            -webkit-appearance: none;
            appearance: none;
            background: var(--surface-300, #404040);
            border-radius: 3px;
            cursor: pointer;
        }

        .volume-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: var(--primary-500, #3b82f6);
            cursor: pointer;
        }

        .volume-slider::-moz-range-thumb {
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: var(--primary-500, #3b82f6);
            border: none;
            cursor: pointer;
        }

        .loop-stats {
            margin-bottom: 24px;
            font-size: 0.875rem;
            color: var(--text-secondary, #a0a0a0);
        }

        .loop-count {
            background: var(--surface-300, #404040);
            padding: 4px 12px;
            border-radius: 12px;
        }

        .actions {
            display: flex;
            gap: 12px;
            justify-content: center;
        }

        .action-btn {
            padding: 10px 20px;
            border-radius: 8px;
            font-size: 0.875rem;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s;
            background: var(--primary-500, #3b82f6);
            border: none;
            color: white;
        }

        .action-btn:hover {
            background: var(--primary-600, #2563eb);
        }

        .action-btn.secondary {
            background: var(--surface-300, #404040);
            color: var(--text-primary, #e0e0e0);
        }

        .action-btn.secondary:hover {
            background: var(--surface-400, #505050);
        }

        .action-btn.copied {
            background: var(--success-500, #22c55e);
        }

        .back-btn {
            padding: 12px 24px;
            border-radius: 8px;
            background: var(--primary-500, #3b82f6);
            border: none;
            color: white;
            font-size: 1rem;
            cursor: pointer;
            transition: background 0.15s;
        }

        .back-btn:hover {
            background: var(--primary-600, #2563eb);
        }

        @media (max-width: 480px) {
            .loop-container {
                padding: 24px 20px;
            }

            .song-title {
                font-size: 1.25rem;
            }

            .play-btn {
                width: 72px;
                height: 72px;
            }

            .play-icon {
                border-width: 12px 0 12px 18px;
                margin-left: 5px;
            }

            .pause-icon::before,
            .pause-icon::after {
                width: 7px;
                height: 22px;
            }

            .actions {
                flex-direction: column;
            }
        }
    `
});
