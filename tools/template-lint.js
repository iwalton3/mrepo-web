#!/usr/bin/env node
/**
 * VDX Template Lint - static existence/declaration checks for html`` templates.
 *
 * TypeScript (with class components) checks every ${...} interpolation, but
 * treats the template HTML itself as an opaque string. This lint covers the
 * string-form bindings TS cannot reach:
 *
 *   T1  on-*="name"     handler must exist on the enclosing component (v0)
 *   T2  x-model="a.b"   root key must be a declared state key        (v1)
 *   T3  ref="x"         declared refs vs this.refs.x reads           (v1)
 *   T4  modifier sanity (-passive with -prevent)                     (v1)
 *   T5  cross-component props against the child's static props       (v1)
 *
 * Design spec: docs/proposals/template-lint-spec.md. Guiding rule: silence
 * over false positives - every check bails out rather than guessing.
 *
 * Template HTML is parsed with the framework's OWN parser (htmlParse), so
 * event-name/modifier parsing cannot diverge from runtime semantics.
 *
 * Usage (standalone):
 *   node template-lint.js <dir> [dirs...] [--disable t1-handler] [--include-tests] [--json]
 *
 * Also imported by optimize.js and wired into `--lint-only`.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { htmlParse } from './html-parser.js';

// =============================================================================
// Source scanning utilities
// =============================================================================

/**
 * Blank out string/template-literal text, comments, and regex-literal bodies
 * (preserving length, newlines, and delimiters) so structural scanning can't
 * be fooled by code-looking text. ${...} expression CODE inside templates is
 * kept (recursively), so brace matching stays accurate across templates.
 *
 * This replaces an earlier version (formerly in optimize.js) that lost
 * code/text phase after a template expression containing a string literal -
 * it spliced in a recursive mask of the remainder computed from the wrong
 * starting state, silently blanking real code downstream (e.g. the class
 * declarations after the first such template in a file).
 */
export function maskStringsAndComments(source) {
    const chars = source.split('');

    const blank = (from, to) => {
        for (let k = from; k < to; k++) {
            if (chars[k] !== '\n') chars[k] = ' ';
        }
    };

    const walkCode = (from, to) => {
        let i = from;
        let lastSig = '(';
        let lastWord = '';
        while (i < to) {
            const c = source[i];
            if (c === '/' && source[i + 1] === '/') {
                const nl = source.indexOf('\n', i);
                const end = nl === -1 ? to : Math.min(nl, to);
                blank(i, end);
                i = end;
                continue;
            }
            if (c === '/' && source[i + 1] === '*') {
                const e = source.indexOf('*/', i + 2);
                const end = e === -1 ? to : Math.min(e + 2, to);
                blank(i, end);
                i = end;
                continue;
            }
            if (c === '"' || c === "'") {
                const start = i;
                i++;
                while (i < to) {
                    if (source[i] === '\\') { i += 2; continue; }
                    if (source[i] === c) { i++; break; }
                    i++;
                }
                blank(start + 1, i - 1);
                lastSig = c; lastWord = '';
                continue;
            }
            if (c === '`') {
                const t = scanTemplateLiteral(source, i);
                if (!t) { blank(i + 1, to); return; } // unterminated
                for (const p of t.parts) blank(p.start, p.end);
                for (const ex of t.exprs) walkCode(ex.start + 2, ex.end - 1);
                i = t.end + 1;
                lastSig = '`'; lastWord = '';
                continue;
            }
            if (c === '/') {
                if (REGEX_PREV_CHARS.has(lastSig) || KEYWORDS_BEFORE_REGEX.has(lastWord)) {
                    const end = skipRegex(source, i);
                    blank(i + 1, end - 1);
                    i = end;
                } else {
                    i++;
                }
                lastSig = '/'; lastWord = '';
                continue;
            }
            if (/\s/.test(c)) { i++; continue; }
            if (/[A-Za-z_$]/.test(c)) {
                let j = i;
                while (j < to && /[\w$]/.test(source[j])) j++;
                lastWord = source.slice(i, j);
                lastSig = source[j - 1];
                i = j;
                continue;
            }
            lastSig = c; lastWord = '';
            i++;
        }
    };

    walkCode(0, source.length);
    return chars.join('');
}

/**
 * Given masked source and the index of an open bracket, return the index of
 * its matching close bracket. All bracket kinds share one depth counter
 * (safe on masked source: string/comment brackets are blanked).
 */
function matchBracket(masked, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < masked.length; i++) {
        const c = masked[i];
        if (c === '{' || c === '(' || c === '[') depth++;
        else if (c === '}' || c === ')' || c === ']') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return masked.length - 1;
}

/** Top-level comma-separated member spans of a bracketed region (masked). */
function splitTopLevel(masked, openIdx, closeIdx) {
    const spans = [];
    let depth = 0;
    let start = openIdx + 1;
    for (let i = openIdx; i <= closeIdx; i++) {
        const c = masked[i];
        if (c === '{' || c === '(' || c === '[') depth++;
        else if (c === '}' || c === ')' || c === ']') depth--;
        else if (c === ',' && depth === 1) {
            spans.push({ start, end: i });
            start = i + 1;
        }
    }
    spans.push({ start, end: closeIdx });
    return spans.filter(s => masked.slice(s.start, s.end).trim() !== '');
}

/** 1-based line number lookup with precomputed newline positions. */
function makeLineLookup(source) {
    const nl = [];
    for (let i = 0; i < source.length; i++) {
        if (source[i] === '\n') nl.push(i);
    }
    return (idx) => {
        let lo = 0, hi = nl.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (nl[mid] < idx) lo = mid + 1;
            else hi = mid;
        }
        return lo + 1;
    };
}

// =============================================================================
// Template discovery (raw-source walk)
// =============================================================================
// NOTE: maskStringsAndComments blanks template contents ENTIRELY (including
// ${...} expression code) - fine for the registry pass, useless for template
// structure. Templates are therefore discovered with a raw-source code walker
// that understands strings, comments, regex literals, and nested templates
// (same approach as scripts/convert-to-class.mjs scan()).

const KEYWORDS_BEFORE_REGEX = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'do', 'else', 'case', 'yield', 'await', 'throw'
]);
const REGEX_PREV_CHARS = new Set(['(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '/', '%', '^', '~', '<', '>']);

/** Skip a regex literal body + flags; returns index after it. */
function skipRegex(source, i) {
    i++;
    let inClass = false;
    while (i < source.length) {
        const d = source[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { i++; break; }
        else if (d === '\n') break;
        i++;
    }
    while (i < source.length && /[a-z]/i.test(source[i])) i++;
    return i;
}

/**
 * Scan a template literal starting at its backtick. Returns
 * { end, parts: [{start,end}], exprs: [{start,end,inTag}] } (end = closing
 * backtick index; expr end is past the closing brace), or null if
 * unterminated.
 */
function scanTemplateLiteral(source, backtickIdx) {
    const parts = [];
    const exprs = [];
    let i = backtickIdx + 1;
    let partStart = i;
    while (i < source.length) {
        const c = source[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '`') {
            parts.push({ start: partStart, end: i });
            return { end: i, parts, exprs };
        }
        if (c === '$' && source[i + 1] === '{') {
            parts.push({ start: partStart, end: i });
            const close = scanExprBrace(source, i + 1);
            if (close === -1) return null;
            exprs.push({ start: i, end: close + 1, inTag: false });
            i = close + 1;
            partStart = i;
            continue;
        }
        i++;
    }
    return null;
}

/** Matching close brace for the '{' at openIdx, over RAW source. */
function scanExprBrace(source, openIdx) {
    let depth = 0;
    let i = openIdx;
    let lastSig = '(';
    let lastWord = '';
    while (i < source.length) {
        const c = source[i];
        if (c === '/' && source[i + 1] === '/') {
            const nl = source.indexOf('\n', i);
            i = nl === -1 ? source.length : nl;
            continue;
        }
        if (c === '/' && source[i + 1] === '*') {
            const e = source.indexOf('*/', i + 2);
            i = e === -1 ? source.length : e + 2;
            continue;
        }
        if (c === '"' || c === "'") {
            i++;
            while (i < source.length) {
                if (source[i] === '\\') { i += 2; continue; }
                if (source[i] === c) { i++; break; }
                i++;
            }
            lastSig = c; lastWord = '';
            continue;
        }
        if (c === '`') {
            const t = scanTemplateLiteral(source, i);
            if (!t) return -1;
            i = t.end + 1;
            lastSig = '`'; lastWord = '';
            continue;
        }
        if (c === '/') {
            if (REGEX_PREV_CHARS.has(lastSig) || KEYWORDS_BEFORE_REGEX.has(lastWord)) {
                i = skipRegex(source, i);
            } else {
                i++;
            }
            lastSig = '/'; lastWord = '';
            continue;
        }
        if (c === '{' || c === '(' || c === '[') { depth++; lastSig = c; lastWord = ''; i++; continue; }
        if (c === '}' || c === ')' || c === ']') {
            depth--;
            if (depth === 0) return c === '}' ? i : -1;
            lastSig = c; lastWord = '';
            i++;
            continue;
        }
        if (/\s/.test(c)) { i++; continue; }
        if (/[A-Za-z_$]/.test(c)) {
            let j = i;
            while (j < source.length && /[\w$]/.test(source[j])) j++;
            lastWord = source.slice(i, j);
            lastSig = source[j - 1];
            i = j;
            continue;
        }
        lastSig = c; lastWord = '';
        i++;
    }
    return -1;
}

/**
 * Walk a code region collecting every html`` template (including templates
 * nested inside ${...} expressions and inside other template literals).
 */
function collectTemplates(source, from, to, out) {
    let i = from;
    let lastSig = '(';
    let lastWord = '';
    while (i < to) {
        const c = source[i];
        if (c === '/' && source[i + 1] === '/') {
            const nl = source.indexOf('\n', i);
            i = nl === -1 ? to : Math.min(nl, to);
            continue;
        }
        if (c === '/' && source[i + 1] === '*') {
            const e = source.indexOf('*/', i + 2);
            i = e === -1 ? to : Math.min(e + 2, to);
            continue;
        }
        if (c === '"' || c === "'") {
            i++;
            while (i < to) {
                if (source[i] === '\\') { i += 2; continue; }
                if (source[i] === c) { i++; break; }
                i++;
            }
            lastSig = c; lastWord = '';
            continue;
        }
        if (c === '`') {
            const isHtml = i >= 4 && source.slice(i - 4, i) === 'html'
                && !/[\w$.]/.test(i >= 5 ? source[i - 5] : '');
            const t = scanTemplateLiteral(source, i);
            if (!t) return; // unterminated - stop scanning this region
            if (isHtml) {
                // Mark attribute-position expressions: an unclosed '<' in the
                // static text seen so far means the expression sits inside a tag
                let textSoFar = '';
                for (let k = 0; k < t.exprs.length; k++) {
                    textSoFar += source.slice(t.parts[k].start, t.parts[k].end);
                    t.exprs[k].inTag = textSoFar.lastIndexOf('<') > textSoFar.lastIndexOf('>');
                }
                out.push({ start: i - 4, end: t.end, parts: t.parts, exprs: t.exprs });
            }
            for (const ex of t.exprs) collectTemplates(source, ex.start + 2, ex.end - 1, out);
            i = t.end + 1;
            lastSig = '`'; lastWord = '';
            continue;
        }
        if (c === '/') {
            if (REGEX_PREV_CHARS.has(lastSig) || KEYWORDS_BEFORE_REGEX.has(lastWord)) {
                i = skipRegex(source, i);
            } else {
                i++;
            }
            lastSig = '/'; lastWord = '';
            continue;
        }
        if (/\s/.test(c)) { i++; continue; }
        if (/[A-Za-z_$]/.test(c)) {
            let j = i;
            while (j < to && /[\w$]/.test(source[j])) j++;
            lastWord = source.slice(i, j);
            lastSig = source[j - 1];
            i = j;
            continue;
        }
        lastSig = c; lastWord = '';
        i++;
    }
}

function findTemplates(source) {
    const out = [];
    collectTemplates(source, 0, source.length, out);
    out.sort((a, b) => a.start - b.start);
    return out;
}

// =============================================================================
// Pass 1 - component registry
// =============================================================================

// Prototype methods with these names become lifecycle options, NOT element
// members - `on-click="mounted"` would silently bind nothing at runtime.
// (propsChanged IS bound onto the element - see component.js - so it lives
// in FRAMEWORK_MEMBERS instead.)
const LIFECYCLE_HOOKS = new Set([
    'template', 'mounted', 'unmounted', 'afterRender', 'renderError', 'data'
]);

// Framework-provided element members that are valid string-handler targets
// (resolution is a bare `component[name]` lookup - template-renderer.js).
const FRAMEWORK_MEMBERS = new Set(['emitChange', 'render', '$method', 'propsChanged']);

// Native element methods someone could legitimately name as a handler
// (`on-click="focus"` calls element.focus at runtime). Generous on purpose:
// a typo colliding with these is far less likely than intentional use.
const DOM_METHODS = new Set([
    'focus', 'blur', 'click', 'select', 'remove', 'scrollIntoView', 'scrollTo',
    'scrollBy', 'showModal', 'show', 'close', 'play', 'pause', 'load', 'submit',
    'reset', 'requestFullscreen', 'reportValidity', 'checkValidity',
    'showPopover', 'hidePopover', 'togglePopover'
]);

// Tags that must never produce unknown-tag noise (T5/future)
export const BUILTIN_TAGS = new Set(['router-outlet', 'router-link', 'x-await-then']);

function newHarvest() {
    return {
        props: new Set(),        // static props / options.props keys
        methods: new Set(),      // callable string-handler targets
        getters: new Set(),      // computed properties (NOT callable)
        fields: new Set(),       // class fields + this.X= assignments (may hold functions)
        stateKeys: new Set(),    // null => not statically known
        lifecycle: new Set(),
        fires: null,             // JSDoc @fires event names; null => no JSDoc, T6 disabled
        customEvents: new Set(), // CustomEvent('...') literals + emitChange => 'change'
        opaque: false,           // spread / unparseable member => trust nothing
        fullyResolved: false,    // inheritance chain fully harvested in-file
    };
}

/**
 * Parse the JSDoc block immediately preceding a declaration (skipping
 * `export` / `default` keywords). Returns { fires: Set|null,
 * propDocs: Array<{name, index}>|null } or null when there is no doc block.
 */
function parseJsDocBefore(source, pos) {
    let i = pos;
    const skipBackWs = () => { while (i > 0 && /\s/.test(source[i - 1])) i--; };
    skipBackWs();
    for (;;) {
        let j = i;
        while (j > 0 && /[\w$]/.test(source[j - 1])) j--;
        const word = source.slice(j, i);
        if (word === 'export' || word === 'default') { i = j; skipBackWs(); }
        else break;
    }
    if (i < 2 || source.slice(i - 2, i) !== '*/') return null;
    const open = source.lastIndexOf('/**', i - 2);
    if (open === -1) return null;
    if (source.indexOf('*/', open + 3) !== i - 2) return null; // not this block's close
    const block = source.slice(open, i);

    let fires = null;
    for (const m of block.matchAll(/@fires\s+(?:\{[^}]*\}\s+)?([\w-]+)/g)) {
        if (!fires) fires = new Set();
        fires.add(m[1]);
    }
    let propDocs = null;
    for (const m of block.matchAll(/@prop(?:erty)?\s+(?:\{[^}]*\}\s+)?\[?([A-Za-z_$][\w$]*)/g)) {
        if (!propDocs) propDocs = [];
        propDocs.push({ name: m[1], index: open + m.index });
    }
    if (!fires && !propDocs) return null;
    return { fires, propDocs };
}

/** CustomEvent names a component body can dispatch (expands T6's allowed set). */
function harvestCustomEvents(source, bodyStart, bodyEnd, into) {
    const body = source.slice(bodyStart, bodyEnd);
    for (const m of body.matchAll(/new\s+CustomEvent\s*\(\s*['"]([\w-]+)['"]/g)) {
        into.add(m[1]);
    }
    if (/\bemitChange\s*\(/.test(body)) into.add('change');
}

/** Harvest keys of an object literal (masked structure, identifier keys). */
function harvestObjectKeys(masked, openIdx, closeIdx, into) {
    for (const span of splitTopLevel(masked, openIdx, closeIdx)) {
        const text = masked.slice(span.start, span.end);
        if (/^\s*\.\.\./.test(text)) return false; // spread - not statically known
        const m = /^\s*(?:async\s+)?(?:get\s+|set\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*[:(=,]?/.exec(text);
        const shorthand = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(text);
        if (shorthand) { into.add(shorthand[1]); continue; }
        if (!m) return false; // quoted/computed key (blanked in mask) - bail
        into.add(m[1]);
    }
    return true;
}

/** Field-value end: depth-0 ';', or depth-0 newline after an expression-ending char. */
function scanFieldValueEnd(masked, from, limit) {
    let depth = 0;
    let lastSig = '';
    for (let i = from; i < limit; i++) {
        const c = masked[i];
        if (c === '{' || c === '(' || c === '[') { depth++; lastSig = c; continue; }
        if (c === '}' || c === ')' || c === ']') { depth--; lastSig = c; continue; }
        if (depth === 0 && c === ';') return i + 1;
        if (depth === 0 && c === '\n' && /[)\]}\w$]/.test(lastSig)) return i;
        if (!/\s/.test(c)) lastSig = c;
    }
    return limit;
}

/**
 * Harvest one class body. Bails to opaque on any member it cannot parse
 * (TS annotations, decorators, computed names in odd positions).
 */
function harvestClassBody(source, masked, bodyStart, bodyEnd) {
    const h = newHarvest();
    let i = bodyStart;

    const skipWs = () => { while (i < bodyEnd && /[\s;]/.test(masked[i])) i++; };

    while (true) {
        skipWs();
        if (i >= bodyEnd) break;

        let isStatic = false, isGet = false, isSet = false;
        let name = null;

        // Modifier words + member name
        while (i < bodyEnd) {
            if (masked[i] === '*') { i++; continue; }
            if (masked[i] === '#') {
                let j = i + 1;
                while (j < bodyEnd && /[\w$]/.test(masked[j])) j++;
                name = masked.slice(i, j);
                i = j;
                break;
            }
            if (masked[i] === '[') {
                i = matchBracket(masked, i) + 1;
                name = null; // computed member name - unknown
                break;
            }
            if (!/[A-Za-z_$]/.test(masked[i])) { h.opaque = true; return h; }
            let j = i;
            while (j < bodyEnd && /[\w$]/.test(masked[j])) j++;
            const word = masked.slice(i, j);
            let k = j;
            while (k < bodyEnd && /\s/.test(masked[k])) k++;
            if ((word === 'static' || word === 'async' || word === 'get' || word === 'set')
                && k < bodyEnd && /[A-Za-z_$#[*]/.test(masked[k])) {
                if (word === 'static') isStatic = true;
                else if (word === 'get') isGet = true;
                else if (word === 'set') isSet = true;
                i = k;
                continue;
            }
            name = word;
            i = j;
            break;
        }

        // Spaces/tabs only - a newline here means a bare field declaration
        while (i < bodyEnd && (masked[i] === ' ' || masked[i] === '\t')) i++;
        const c = i < bodyEnd ? masked[i] : '';

        if (c === '(') {
            // Method / getter / setter
            const closeParen = matchBracket(masked, i);
            let k = closeParen + 1;
            while (k < bodyEnd && /\s/.test(masked[k])) k++;
            if (masked[k] !== '{') { h.opaque = true; return h; } // TS return annotation etc.
            const bodyClose = matchBracket(masked, k);
            if (name && !isStatic && !name.startsWith('#')) {
                if (isGet) { h.getters.add(name); h.methods.delete(name); }
                else if (!isSet) {
                    if (LIFECYCLE_HOOKS.has(name)) h.lifecycle.add(name);
                    else if (name !== 'constructor') { h.methods.add(name); h.getters.delete(name); }
                }
            }
            i = bodyClose + 1;
            continue;
        }

        if (c === '=' && masked[i + 1] !== '=') {
            // Class field with initializer
            const valStart = i + 1;
            const valEnd = scanFieldValueEnd(masked, valStart, bodyEnd);
            if (name && !name.startsWith('#')) {
                if (isStatic) {
                    if (name === 'props') {
                        const open = masked.indexOf('{', valStart);
                        if (open !== -1 && open < valEnd) {
                            if (!harvestObjectKeys(masked, open, matchBracket(masked, open), h.props)) h.opaque = true;
                        }
                    }
                } else {
                    h.fields.add(name);
                    if (name === 'state') {
                        const open = masked.indexOf('{', valStart);
                        const lead = masked.slice(valStart, open === -1 ? valEnd : open).trim();
                        if (open === -1 || open >= valEnd || lead !== '') h.stateKeys = null;
                        else if (h.stateKeys && !harvestObjectKeys(masked, open, matchBracket(masked, open), h.stateKeys)) h.stateKeys = null;
                    }
                }
            }
            i = valEnd;
            continue;
        }

        if (c === ';' || c === '\n' || c === '' || c === '}') {
            // Bare field declaration
            if (name && !isStatic && !name.startsWith('#')) h.fields.add(name);
            if (c === '') break;
            i++;
            continue;
        }

        h.opaque = true; // TS annotation (`state: Foo = ...`), decorator, etc.
        return h;
    }

    // this.X = assignments anywhere in the class body (constructor, mounted...)
    const body = masked.slice(bodyStart, bodyEnd);
    if (/this\.state\s*\[/.test(body)) h.stateKeys = null;
    const assignRe = /this\.([A-Za-z_$][\w$]*)\s*=(?![=>])/g;
    let am;
    while ((am = assignRe.exec(body)) !== null) {
        const target = am[1];
        h.fields.add(target);
        if (target === 'state' && h.stateKeys !== null) {
            let vi = bodyStart + am.index + am[0].length;
            while (vi < bodyEnd && /\s/.test(masked[vi])) vi++;
            if (masked[vi] !== '{') h.stateKeys = null;
            else if (!harvestObjectKeys(masked, vi, matchBracket(masked, vi), h.stateKeys)) h.stateKeys = null;
        }
    }

    return h;
}

/** Harvest an options-format component object literal. */
function harvestOptionsObject(source, masked, openIdx) {
    const h = newHarvest();
    h.fullyResolved = true;
    const closeIdx = matchBracket(masked, openIdx);

    for (const span of splitTopLevel(masked, openIdx, closeIdx)) {
        const text = masked.slice(span.start, span.end);
        if (/^\s*\.\.\./.test(text)) { h.opaque = true; continue; }
        const m = /^\s*(?:async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*([:(])/.exec(text);
        if (!m) {
            if (text.trim() !== '') h.opaque = true; // quoted/computed key
            continue;
        }
        const key = m[1];
        const memberValueStart = span.start + m.index + m[0].length - 1;

        if (m[2] === '(') {
            if (LIFECYCLE_HOOKS.has(key) || key === 'propsChanged') {
                h.lifecycle.add(key);
                if (key === 'data') {
                    // Single top-level `return {literal}` => state keys
                    const bodyOpen = masked.indexOf('{', matchBracket(masked, memberValueStart) + 1);
                    if (bodyOpen === -1) { h.stateKeys = null; continue; }
                    const bodyClose = matchBracket(masked, bodyOpen);
                    const dataBody = masked.slice(bodyOpen, bodyClose);
                    const returns = dataBody.match(/\breturn\b/g) || [];
                    const rm = /\breturn\s*\{/.exec(dataBody);
                    if (returns.length !== 1 || !rm) { h.stateKeys = null; continue; }
                    const litOpen = bodyOpen + rm.index + rm[0].length - 1;
                    if (!harvestObjectKeys(masked, litOpen, matchBracket(masked, litOpen), h.stateKeys)) h.stateKeys = null;
                }
            }
            continue;
        }

        // key: value members
        if (key === 'methods' || key === 'computed' || key === 'props') {
            let vi = memberValueStart + 1;
            while (vi < span.end && /\s/.test(masked[vi])) vi++;
            if (masked[vi] !== '{') { h.opaque = true; continue; }
            const target = key === 'methods' ? h.methods : key === 'computed' ? h.getters : h.props;
            if (!harvestObjectKeys(masked, vi, matchBracket(masked, vi), target)) h.opaque = true;
        }
        // stores/styles/other keys: irrelevant to current checks
    }

    if (h.opaque) h.fullyResolved = false;
    return h;
}

/**
 * Parse import statements: local name -> { file: resolvedPath, name: exportedName }.
 * Only relative specifiers are followed; bare imports are ignored.
 */
function parseImports(source, masked, filePath) {
    const map = new Map();
    const re = /(?:^|[\n;])\s*import\s+([^;'"]*?)\s*from\s*(['"])/g;
    let m;
    while ((m = re.exec(masked)) !== null) {
        const quotePos = m.index + m[0].length - 1;
        const quote = m[2];
        const end = source.indexOf(quote, quotePos + 1);
        if (end === -1) continue;
        const spec = source.slice(quotePos + 1, end);
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
        const resolved = path.normalize(path.join(path.dirname(filePath), spec));
        const clause = m[1];
        const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
        if (def && def[1] !== 'type') {
            map.set(def[1], { file: resolved, name: 'default' });
        }
        const braces = /\{([^}]*)\}/.exec(clause);
        if (braces) {
            for (const item of braces[1].split(',')) {
                const t = item.trim();
                if (!t) continue;
                const asM = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(t);
                if (asM) map.set(asM[2], { file: resolved, name: asM[1] });
                else if (/^[A-Za-z_$][\w$]*$/.test(t)) map.set(t, { file: resolved, name: t });
            }
        }
    }
    return map;
}

/**
 * Build the component registry over a set of files.
 *
 * Three phases: (1) per-file parse - class declarations with own harvests,
 * import maps, default-export aliases; (2) cross-file inheritance resolution
 * (a superclass or defineComponent argument may be imported from another
 * analyzed file); (3) per-file component lists + defineComponent tag
 * association.
 *
 * @param {Array<{path: string, content: string}>} fileEntries
 * @returns {{byTag: Map, byFile: Map}} byFile maps path -> array of
 *   { kind, name, tag, bodyStart, bodyEnd, harvest } sorted by bodyStart.
 */
export function buildRegistry(fileEntries) {
    const byTag = new Map();
    const byFile = new Map();

    // --- Phase 1: per-file parse ---
    const fileInfo = new Map();
    const normToKey = new Map();
    for (const { path: filePath, content: source } of fileEntries) {
        let masked;
        try {
            masked = maskStringsAndComments(source);
        } catch {
            continue;
        }

        const classes = new Map(); // name -> {superName, bodyStart, bodyEnd, harvest, jsdoc}
        const classRe = /(?:^|[^\w$.])class\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$.]*)\s*\{/g;
        let cm;
        while ((cm = classRe.exec(masked)) !== null) {
            const bodyOpen = cm.index + cm[0].length - 1;
            const bodyEnd = matchBracket(masked, bodyOpen);
            const harvest = harvestClassBody(source, masked, bodyOpen + 1, bodyEnd);
            const jsdoc = parseJsDocBefore(source, cm.index + cm[0].indexOf('class'));
            if (jsdoc && jsdoc.fires) harvest.fires = jsdoc.fires;
            harvestCustomEvents(source, bodyOpen + 1, bodyEnd, harvest.customEvents);
            classes.set(cm[1], {
                superName: cm[2],
                bodyStart: bodyOpen + 1,
                bodyEnd,
                harvest,
                jsdoc,
            });
        }

        // Default-export alias, so `import X from './y.js'` can resolve
        let defaultClassName = null;
        const dc = /(?:^|[\n;])\s*export\s+default\s+(?:class\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*;)/.exec(masked);
        if (dc) defaultClassName = dc[1] || dc[2];

        fileInfo.set(filePath, {
            source, masked, classes, defaultClassName,
            imports: parseImports(source, masked, filePath),
        });
        normToKey.set(path.normalize(filePath), filePath);
    }

    // --- Phase 2: cross-file inheritance resolution ---
    const merged = new Map(); // "file\x00name" -> harvest | null
    const resolveMerged = (fileKey, name, seen = new Set()) => {
        const id = fileKey + '\x00' + name;
        if (merged.has(id)) return merged.get(id);
        if (seen.has(id)) return null;
        seen.add(id);
        const info = fileInfo.get(fileKey);
        if (!info) { merged.set(id, null); return null; }

        let decl = info.classes.get(name);
        if (!decl && name === 'default' && info.defaultClassName) {
            decl = info.classes.get(info.defaultClassName);
        }
        if (!decl) {
            // Imported (possibly re-referenced) name: follow the import
            const imp = info.imports.get(name);
            const targetKey = imp ? normToKey.get(imp.file) : null;
            const h = targetKey ? resolveMerged(targetKey, imp.name, seen) : null;
            merged.set(id, h);
            return h;
        }

        // Merge root-first (mirrors classToOptions: a child method overrides
        // a parent getter and vice versa)
        const h = newHarvest();
        let parent = null;
        if (decl.superName === 'Component') {
            h.fullyResolved = true;
        } else if (/^[A-Za-z_$][\w$]*$/.test(decl.superName)) {
            parent = resolveMerged(fileKey, decl.superName, seen);
            h.fullyResolved = parent ? parent.fullyResolved : false;
        } // dotted superclass (ns.Base): unresolvable

        if (parent) {
            for (const s of ['props', 'methods', 'getters', 'fields', 'lifecycle', 'customEvents']) {
                for (const v of parent[s]) h[s].add(v);
            }
            h.stateKeys = parent.stateKeys === null ? null : new Set(parent.stateKeys);
            h.fires = parent.fires === null ? null : new Set(parent.fires);
            h.opaque = parent.opaque;
        }
        const own = decl.harvest;
        for (const v of own.props) h.props.add(v);
        for (const v of own.methods) { h.methods.add(v); h.getters.delete(v); }
        for (const v of own.getters) { h.getters.add(v); h.methods.delete(v); }
        for (const v of own.fields) h.fields.add(v);
        for (const v of own.lifecycle) h.lifecycle.add(v);
        for (const v of own.customEvents) h.customEvents.add(v);
        if (own.fires) {
            if (h.fires === null) h.fires = new Set();
            for (const v of own.fires) h.fires.add(v);
        }
        if (own.stateKeys === null) h.stateKeys = null;
        else if (h.stateKeys !== null && own.stateKeys.size > 0) {
            // subclass state field REPLACES the parent's (it's one assignment)
            h.stateKeys = new Set(own.stateKeys);
        }
        if (own.opaque) h.opaque = true;
        merged.set(id, h);
        return h;
    };

    // --- Phase 3: per-file component lists + defineComponent sites ---
    for (const [filePath, info] of fileInfo) {
        const { source, masked } = info;
        const components = [];

        for (const [name, decl] of info.classes) {
            components.push({
                kind: 'class', name, tag: null,
                bodyStart: decl.bodyStart, bodyEnd: decl.bodyEnd,
                harvest: resolveMerged(filePath, name),
                ownPropDocs: decl.jsdoc ? decl.jsdoc.propDocs : null,
            });
        }

        const dcRe = /\bdefineComponent\s*\(/g;
        let dm;
        while ((dm = dcRe.exec(masked)) !== null) {
            const argsOpen = dm.index + dm[0].length - 1;
            const argsClose = matchBracket(masked, argsOpen);
            const argSpans = splitTopLevel(masked, argsOpen, argsClose);
            if (argSpans.length < 2) continue;

            const rawArg1 = source.slice(argSpans[0].start, argSpans[0].end).trim();
            const tagLit = /^['"`]([^'"`]+)['"`]$/.exec(rawArg1);
            if (!tagLit) continue; // dynamic tag name - skip site
            const tag = tagLit[1];

            const arg2 = masked.slice(argSpans[1].start, argSpans[1].end).trim();
            let entry = null;

            if (/^[A-Za-z_$][\w$]*$/.test(arg2)) {
                const cls = components.find(c => c.kind === 'class' && c.name === arg2);
                if (cls) {
                    // Class in this file
                    cls.tag = cls.tag || tag;
                    entry = { ...cls, tag };
                } else if (info.imports.has(arg2) || info.classes.has(arg2)) {
                    // Imported class: harvest lives in its own file
                    const harvest = resolveMerged(filePath, arg2);
                    if (harvest) {
                        entry = { kind: 'class', name: arg2, tag, bodyStart: -1, bodyEnd: -1, harvest };
                    }
                } else {
                    const optRe = new RegExp(`(?:const|let|var)\\s+${arg2.replace(/\$/g, '\\$')}\\s*=\\s*\\{`);
                    const om = optRe.exec(masked);
                    if (om) {
                        const openIdx = om.index + om[0].length - 1;
                        const bodyEnd = matchBracket(masked, openIdx);
                        const harvest = harvestOptionsObject(source, masked, openIdx);
                        const jsdoc = parseJsDocBefore(source, om.index);
                        if (jsdoc && jsdoc.fires) harvest.fires = jsdoc.fires;
                        harvestCustomEvents(source, openIdx, bodyEnd, harvest.customEvents);
                        entry = {
                            kind: 'options', name: arg2, tag,
                            bodyStart: openIdx, bodyEnd,
                            harvest,
                            ownPropDocs: jsdoc ? jsdoc.propDocs : null,
                        };
                        components.push(entry);
                    }
                }
            } else if (arg2.startsWith('{')) {
                const openIdx = masked.indexOf('{', argSpans[1].start);
                const bodyEnd = matchBracket(masked, openIdx);
                const harvest = harvestOptionsObject(source, masked, openIdx);
                const jsdoc = parseJsDocBefore(source, dm.index);
                if (jsdoc && jsdoc.fires) harvest.fires = jsdoc.fires;
                harvestCustomEvents(source, openIdx, bodyEnd, harvest.customEvents);
                entry = {
                    kind: 'options', name: null, tag,
                    bodyStart: openIdx, bodyEnd,
                    harvest,
                    ownPropDocs: jsdoc ? jsdoc.propDocs : null,
                };
                components.push(entry);
            }

            if (!entry) {
                // Unresolvable second arg: opaque tag
                const h = newHarvest();
                h.opaque = true;
                entry = { kind: 'opaque', name: null, tag, bodyStart: -1, bodyEnd: -1, harvest: h };
            }
            if (!byTag.has(tag)) byTag.set(tag, { ...entry, file: filePath });
        }

        components.sort((a, b) => a.bodyStart - b.bodyStart);
        byFile.set(filePath, components);
    }

    return { byTag, byFile };
}

// =============================================================================
// Pass 2 - template checks
// =============================================================================

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
export const ALL_CHECKS = new Set([
    't1-handler', 't2-xmodel', 't3-refs', 't4-modifiers', 't5-props',
    't6-events', 't6-prop-docs',
]);

// Native DOM events bubble through components without documentation - only
// custom event names participate in the T6 @fires check.
const NATIVE_EVENTS = new Set([
    'click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'mousemove',
    'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'contextmenu',
    'wheel', 'scroll', 'scrollend', 'input', 'change', 'beforeinput',
    'submit', 'reset', 'invalid', 'select', 'focus', 'blur', 'focusin',
    'focusout', 'keydown', 'keyup', 'keypress', 'touchstart', 'touchmove',
    'touchend', 'touchcancel', 'pointerdown', 'pointerup', 'pointermove',
    'pointerenter', 'pointerleave', 'pointerover', 'pointerout',
    'pointercancel', 'gotpointercapture', 'lostpointercapture',
    'drag', 'dragstart', 'dragend', 'dragenter', 'dragleave', 'dragover',
    'drop', 'copy', 'cut', 'paste', 'compositionstart', 'compositionupdate',
    'compositionend', 'animationstart', 'animationend', 'animationiteration',
    'transitionstart', 'transitionend', 'transitionrun', 'transitioncancel',
    'load', 'error', 'abort', 'toggle', 'close', 'cancel', 'canplay',
    'canplaythrough', 'durationchange', 'emptied', 'ended', 'loadeddata',
    'loadedmetadata', 'pause', 'play', 'playing', 'progress', 'ratechange',
    'seeked', 'seeking', 'stalled', 'suspend', 'timeupdate', 'volumechange',
    'waiting', 'clickoutside',
]);

// Global HTML attributes (plus VDX-isms) that are always legal on any
// element, component or not. Prefix rules (data-/aria-/json-/on-) are
// handled separately. "When in doubt, allow."
const GLOBAL_HTML_ATTRS = new Set([
    'accesskey', 'autocapitalize', 'autofocus', 'class', 'contenteditable',
    'dir', 'draggable', 'enterkeyhint', 'exportparts', 'hidden', 'id',
    'inert', 'inputmode', 'is', 'itemid', 'itemprop', 'itemref', 'itemscope',
    'itemtype', 'lang', 'nonce', 'part', 'popover', 'role', 'slot',
    'spellcheck', 'style', 'tabindex', 'title', 'translate', 'key',
]);

// Tag must look like a well-formed custom-element name (also rejects
// dynamic-tag leftovers containing slot markers)
const CUSTOM_TAG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function kebabToCamel(s) {
    return s.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

/** Does an attribute name map to a declared prop under the runtime's rules?
 *  (exact property-style, kebab-case canonical, or legacy smushed-lowercase) */
function attrMatchesProp(attrName, props) {
    if (props.has(attrName)) return true;
    if (props.has(kebabToCamel(attrName))) return true;
    const lower = attrName.toLowerCase();
    for (const p of props) {
        if (p.toLowerCase() === lower) return true;
    }
    return false;
}

/** Reconstruct the source attribute name for an event definition. */
function eventAttrName(eventName, modifiers) {
    const base = eventName === 'clickoutside' ? 'click-outside' : eventName;
    return 'on-' + base + (modifiers || []).map(m => '-' + m).join('');
}

function isSuppressed(sourceLines, line, checkId) {
    const prev = sourceLines[line - 2]; // line is 1-based; look one line up
    if (!prev) return false;
    const m = /vdx-lint-disable-next-line(?:[ \t]+([\w, \t-]+?))?[ \t]*(?:-->|\*\/)?[ \t]*$/.exec(prev);
    if (!m) return false;
    if (!m[1]) return true; // bare disable suppresses everything
    return m[1].split(/[\s,]+/).filter(Boolean).includes(checkId);
}

/**
 * Lint the html`` templates of one file against the registry.
 * @returns {Array<{line, checkId, severity, message, fixable, path}>}
 */
export function lintTemplates(source, filePath, registry, options = {}) {
    const disabled = options.disable || new Set();
    const on = (id) => !disabled.has(id);

    const components = registry.byFile.get(filePath) || [];
    const templates = findTemplates(source);
    if (templates.length === 0) return [];

    const lineOf = makeLineLookup(source);
    const sourceLines = source.split('\n');
    const issues = [];

    const report = (line, checkId, severity, message) => {
        if (isSuppressed(sourceLines, line, checkId)) return;
        issues.push({ line, checkId, severity, message, fixable: false, path: '' });
    };

    // Innermost enclosing component per template
    const enclosing = (pos) => {
        let best = null;
        for (const c of components) {
            if (c.bodyStart >= 0 && c.bodyStart <= pos && pos < c.bodyEnd) {
                if (!best || c.bodyStart > best.bodyStart) best = c;
            }
        }
        return best;
    };

    // A template nested in an ATTRIBUTE-position expression of another
    // template is rendered by whatever component receives it (renderItem
    // factories etc.) - its string handlers and x-model paths resolve
    // elsewhere. Context-free checks (T4 modifiers, T5 props) still apply.
    // Content-position nesting (when/each/ternary callbacks) renders in the
    // same component context and gets every check.
    const isDetached = (tpl) => {
        for (const outer of templates) {
            if (outer === tpl || !(outer.start < tpl.start && tpl.start < outer.end)) continue;
            const expr = outer.exprs.find(e => e.start <= tpl.start && tpl.start < e.end);
            if (expr && expr.inTag) return true;
        }
        return false;
    };

    // T3 state: ref="name" declarations unioned across each component's
    // templates (including detached factories - refs land somewhere)
    const refsDeclared = new Map(); // comp -> Map(refName -> line)

    for (const tpl of templates) {
        const comp = enclosing(tpl.start);
        const h = comp ? comp.harvest : null;
        const confident = !!(h && !h.opaque && h.fullyResolved);
        const checkContext = confident && !isDetached(tpl);

        // Build the strings array exactly as the runtime tag would see it
        // (light unescape of the sequences that matter in HTML positions)
        const parts = tpl.parts.map(p =>
            source.slice(p.start, p.end).replace(/\\([`$\\])/g, '$1'));
        let tree;
        try {
            tree = htmlParse(parts);
        } catch {
            continue; // malformed template HTML - never guess
        }

        const templateSrc = source.slice(tpl.start, tpl.end);
        const occurrence = new Map();

        // Locate the Nth occurrence of a pattern inside this template
        // (N tracked per key, so repeated identical bindings map to
        // successive lines). Falls back to the template start line.
        const locate = (key, regexSource) => {
            const n = occurrence.get(key) || 0;
            occurrence.set(key, n + 1);
            const re = new RegExp(regexSource, 'g');
            let m, hit = null, count = 0;
            while ((m = re.exec(templateSrc)) !== null) {
                hit = m.index;
                if (count === n) break;
                count++;
            }
            return lineOf(tpl.start + (hit === null ? 0 : hit));
        };

        // ---- T1: string event handlers ----
        const checkHandler = (eventName, def) => {
            const method = def.method;
            if (typeof method !== 'string' || !IDENT_RE.test(method)) return; // slot/mixed/empty value
            if (h.methods.has(method) || h.fields.has(method) || h.props.has(method)
                || FRAMEWORK_MEMBERS.has(method) || DOM_METHODS.has(method)) return;

            const attrName = eventAttrName(eventName, def.modifiers);
            const line = locate(attrName + '=' + method,
                escapeRegex(attrName) + '\\s*=\\s*["\']' + escapeRegex(method) + '["\']');

            let message;
            if (h.getters.has(method)) {
                message = `${attrName}="${method}": "${method}" is a computed getter, not a method - string handlers must name a callable method`;
            } else if (h.lifecycle.has(method)) {
                message = `${attrName}="${method}": "${method}" is a lifecycle hook, not an element method - it is never bound as a handler`;
            } else {
                const known = [...h.methods].slice(0, 6).join(', ');
                message = `${attrName}="${method}": no method "${method}" on ${comp.name || comp.tag || 'this component'}`
                    + (known ? ` (methods: ${known}${h.methods.size > 6 ? ', ...' : ''})` : '');
            }
            report(line, 't1-handler', 'error', message);
        };

        // ---- T2: x-model root state key ----
        const checkXModel = (path_) => {
            if (typeof path_ !== 'string' || path_ === '' || path_.includes('\x00')) return;
            const root = path_.split('.')[0];
            if (!IDENT_RE.test(root)) return;
            if (h.stateKeys === null || h.stateKeys.has(root)) return;
            const line = locate('x-model=' + path_,
                'x-model\\s*=\\s*["\']' + escapeRegex(path_) + '["\']');
            const known = [...h.stateKeys].slice(0, 8).join(', ');
            report(line, 't2-xmodel', 'error',
                `x-model="${path_}": "${root}" is not a state key of ${comp.name || comp.tag || 'this component'}`
                + (known ? ` (state keys: ${known}${h.stateKeys.size > 8 ? ', ...' : ''})` : ''));
        };

        // ---- T4: contradictory modifiers ----
        const checkModifiers = (eventName, def) => {
            const mods = def.modifiers || [];
            if (mods.includes('passive') && mods.includes('prevent')) {
                const attrName = eventAttrName(eventName, mods);
                const line = locate('t4:' + attrName, '\\b' + escapeRegex(attrName) + '\\s*=');
                report(line, 't4-modifiers', 'error',
                    `${attrName}: -passive and -prevent are contradictory - a passive listener cannot call preventDefault()`);
            }
        };

        // ---- T6: undocumented custom events (only when the target
        // component carries @fires JSDoc at all) ----
        const checkEvents = (node) => {
            const tag = node.tag;
            if (!tag || !CUSTOM_TAG_RE.test(tag) || !registry.byTag.has(tag)) return;
            const target = registry.byTag.get(tag).harvest;
            if (!target.fires) return; // no @fires documentation - stay silent

            for (const [eventName, defChain] of Object.entries(node.events || {})) {
                if (defChain.xModel !== undefined) continue; // injected by x-model
                if (NATIVE_EVENTS.has(eventName)) continue;
                if (target.fires.has(eventName) || target.customEvents.has(eventName)) continue;
                const attrName = eventAttrName(eventName, defChain.modifiers);
                const line = locate('t6:' + tag + ':' + attrName, '\\b' + escapeRegex(attrName) + '\\s*=');
                const documented = [...target.fires].sort().join(', ');
                report(line, 't6-events', 'info',
                    `<${tag}> is not documented to fire "${eventName}" (@fires: ${documented})`);
            }
        };

        // ---- T5: attributes on known component tags ----
        const checkProps = (node) => {
            const tag = node.tag;
            if (!tag || !CUSTOM_TAG_RE.test(tag) || !registry.byTag.has(tag)) return;
            const target = registry.byTag.get(tag).harvest;
            // Zero declared props = component reads attributes its own way;
            // opaque = spread/unparseable. Both: stay silent.
            if (target.opaque || target.props.size === 0) return;

            for (const [attrName, def] of Object.entries(node.attrs || {})) {
                if (attrName === '__ref__') continue;
                if (def && def.xModel !== undefined) continue;      // injected by x-model
                if (!/^[A-Za-z][\w-]*$/.test(attrName)) continue;   // marker/dynamic name
                const lower = attrName.toLowerCase();
                if (GLOBAL_HTML_ATTRS.has(lower)) continue;
                if (/^(data-|aria-|json-)/.test(lower)) continue;
                if (attrMatchesProp(attrName, target.props)) continue;

                const line = locate('t5:' + tag + ':' + attrName,
                    '[\\s"\'<]' + escapeRegex(attrName) + '[\\s=>/]');
                const declared = [...target.props].sort().slice(0, 8).join(', ');
                report(line, 't5-props', 'warn',
                    `<${tag}> has no prop "${attrName}" - declared props: ${declared}${target.props.size > 8 ? ', ...' : ''}`);
            }
        };

        const walk = (node) => {
            if (!node) return;
            if (node.type === 'element') {
                if (node.events) {
                    for (const [eventName, defChain] of Object.entries(node.events)) {
                        let def = defChain;
                        while (def) {
                            if (on('t4-modifiers')) checkModifiers(eventName, def);
                            if (on('t1-handler') && checkContext
                                && def.method !== undefined && def.xModel === undefined) {
                                checkHandler(eventName, def);
                            }
                            def = def._chainWith;
                        }
                    }
                }
                if (on('t2-xmodel') && checkContext) {
                    const paths = new Set();
                    for (const def of Object.values(node.attrs || {})) {
                        if (def && typeof def.xModel === 'string') paths.add(def.xModel);
                    }
                    for (const def of Object.values(node.events || {})) {
                        if (def && typeof def.xModel === 'string') paths.add(def.xModel);
                    }
                    for (const p of paths) checkXModel(p);
                }
                if (on('t5-props')) checkProps(node);
                if (on('t6-events')) checkEvents(node);
                const refDef = node.attrs && node.attrs.__ref__;
                if (refDef && comp && typeof refDef.refName === 'string' && IDENT_RE.test(refDef.refName)) {
                    if (!refsDeclared.has(comp)) refsDeclared.set(comp, new Map());
                    const declMap = refsDeclared.get(comp);
                    if (!declMap.has(refDef.refName)) {
                        declMap.set(refDef.refName, locate('ref=' + refDef.refName,
                            'ref\\s*=\\s*["\']' + escapeRegex(refDef.refName) + '["\']'));
                    }
                }
            }
            if (node.children) for (const child of node.children) walk(child);
        };
        walk(tree);
    }

    // ---- T6: @prop doc drift against declared props ----
    if (on('t6-prop-docs')) {
        for (const comp of components) {
            if (!comp.ownPropDocs || !comp.harvest || comp.harvest.opaque) continue;
            for (const doc of comp.ownPropDocs) {
                if (comp.harvest.props.has(doc.name)) continue;
                const declared = [...comp.harvest.props].sort().slice(0, 8).join(', ');
                report(lineOf(doc.index), 't6-prop-docs', 'warn',
                    `@prop "${doc.name}" does not match any declared prop of ${comp.name || comp.tag || 'this component'}`
                    + (declared ? ` (props: ${declared}${comp.harvest.props.size > 8 ? ', ...' : ''})` : ''));
            }
        }
    }

    // ---- T3: this.refs reads vs ref="..." declarations (per component) ----
    if (on('t3-refs') && components.length > 0) {
        let masked;
        try {
            masked = maskStringsAndComments(source);
        } catch {
            masked = null;
        }
        if (masked) {
            for (const comp of components) {
                if (!comp.harvest || comp.bodyStart < 0) continue;
                let body = masked.slice(comp.bodyStart, comp.bodyEnd);

                // Destructuring reads: const { a, b: c } = this.refs
                const reads = new Map(); // name -> absolute source index
                body = body.replace(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*this\.refs\b/g,
                    (m, names, off) => {
                        for (const item of names.split(',')) {
                            const nm = /^\s*([A-Za-z_$][\w$]*)/.exec(item);
                            if (nm) reads.set(nm[1], comp.bodyStart + off);
                        }
                        return ' '.repeat(m.length);
                    });

                // Bail-outs: computed access or this.refs handed off wholesale
                if (/this\.refs\s*\??\s*\[/.test(body)) continue;
                if (/this\.refs\b(?!\s*\??\.)/.test(body)) continue;

                for (const m of body.matchAll(/this\.refs\s*\??\.\s*([A-Za-z_$][\w$]*)/g)) {
                    if (!reads.has(m[1])) reads.set(m[1], comp.bodyStart + m.index);
                }

                const declared = refsDeclared.get(comp) || new Map();
                for (const [name, idx] of reads) {
                    if (!declared.has(name)) {
                        report(lineOf(idx), 't3-refs', 'warn',
                            `this.refs.${name} is read but no ref="${name}" exists in the templates of ${comp.name || comp.tag || 'this component'}`);
                    }
                }
                for (const [name, line] of declared) {
                    if (!reads.has(name)) {
                        report(line, 't3-refs', 'info',
                            `ref="${name}" is declared but this.refs.${name} is never read`);
                    }
                }
            }
        }
    }

    return issues;
}

// =============================================================================
// Registry serialization (--emit-registry) - future editor-tooling hook
// =============================================================================

export function serializeRegistry(registry) {
    const out = {};
    for (const [tag, e] of [...registry.byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const h = e.harvest;
        out[tag] = {
            file: e.file,
            kind: e.kind,
            name: e.name,
            props: [...h.props].sort(),
            methods: [...h.methods].sort(),
            getters: [...h.getters].sort(),
            stateKeys: h.stateKeys ? [...h.stateKeys].sort() : null,
            fires: h.fires ? [...h.fires].sort() : null,
            customEvents: [...h.customEvents].sort(),
            opaque: h.opaque,
            fullyResolved: h.fullyResolved,
        };
    }
    return out;
}

// =============================================================================
// Directory runner + CLI
// =============================================================================

function walkDir(dir, base = dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDir(full, base, out);
        else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
    }
    return out;
}

/** True when a path should be excluded from template checks by default
 *  (test trees contain deliberate error cases). */
export function isDefaultExcluded(relativePath) {
    return relativePath.split(/[\\/]/).includes('tests');
}

/**
 * Run the template lint over directories. Registry is built over ALL files
 * (so cross-file tags resolve); template checks skip excluded paths.
 */
export function runTemplateLint(dirs, options = {}) {
    const files = [];
    for (const dir of dirs) {
        for (const f of walkDir(dir)) {
            files.push({ path: f, content: fs.readFileSync(f, 'utf-8'), root: dir });
        }
    }
    const registry = buildRegistry(files);
    if (options.emitRegistry) {
        fs.writeFileSync(options.emitRegistry, JSON.stringify(serializeRegistry(registry), null, 2) + '\n');
    }
    const results = [];
    for (const f of files) {
        const rel = path.relative(f.root, f.path);
        if (!options.includeTests && isDefaultExcluded(rel)) continue;
        const issues = lintTemplates(f.content, f.path, registry, options);
        if (issues.length > 0) results.push({ file: f.path, relative: rel, issues });
    }
    return results;
}

function cliMain() {
    const args = process.argv.slice(2);
    const dirs = [];
    const options = { disable: new Set(), includeTests: false };
    let json = false;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--disable':
                for (const id of (args[++i] || '').split(',')) options.disable.add(id.trim());
                break;
            case '--include-tests': options.includeTests = true; break;
            case '--json': json = true; break;
            case '--emit-registry': options.emitRegistry = args[++i]; break;
            case '--help': case '-h':
                console.log('Usage: node template-lint.js <dir> [dirs...] [--disable t1-handler,...] [--include-tests] [--json] [--emit-registry <file>]');
                process.exit(0);
                break;
            default: dirs.push(args[i]);
        }
    }

    if (dirs.length === 0) {
        console.error('Error: at least one input directory is required');
        process.exit(1);
    }
    for (const d of dirs) {
        if (!fs.existsSync(d)) {
            console.error(`Error: directory not found: ${d}`);
            process.exit(1);
        }
    }

    const results = runTemplateLint(dirs, options);

    if (json) {
        console.log(JSON.stringify(results, null, 2));
    } else {
        console.log('VDX Template Lint\n');
        for (const r of results) {
            console.log(`\x1b[33m${r.relative}\x1b[0m`);
            for (const issue of r.issues) {
                const mark = issue.severity === 'error' ? '\x1b[31m✗\x1b[0m'
                    : issue.severity === 'warn' ? '\x1b[33m⚠\x1b[0m' : '\x1b[90mℹ\x1b[0m';
                console.log(`  ${mark} Line ${issue.line}: [${issue.checkId}] ${issue.message}`);
            }
            console.log('');
        }
        const total = results.reduce((n, r) => n + r.issues.length, 0);
        if (total === 0) console.log('\x1b[32m✓ No template binding issues found\x1b[0m\n');
        else console.log(`\x1b[31m✗ Found ${total} template issue(s) in ${results.length} file(s)\x1b[0m\n`);
    }

    const hasErrors = results.some(r => r.issues.some(i => i.severity === 'error'));
    process.exit(hasErrors ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    cliMain();
}
