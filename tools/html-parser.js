/**
 * Custom HTML Template Parser for VDX Framework
 *
 * Parses template strings array directly (no slot markers needed).
 * Gap after strings[i] = slot at index i.
 *
 * Features:
 * - Single-pass streaming parser
 * - Inline entity decoding
 * - Whitespace-preserving (fixes pre-wrap CSS)
 * - Outputs tree structure for buildOpTree()
 *
 * @module core/html-parser
 */

// Parser states
const State = {
    TEXT: 0,
    TAG_OPEN: 1,
    TAG_NAME: 2,
    TAG_SPACE: 3,
    ATTR_NAME: 4,
    ATTR_EQ: 5,
    ATTR_VALUE_START: 6,
    ATTR_VALUE: 7,
    END_TAG: 8,
    COMMENT: 9,
    TAG_SELF_CLOSE: 10
};

// Void elements (self-closing, no end tag)
const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

// Known event modifiers
// prevent: e.preventDefault() | stop: e.stopPropagation() |
// passive: register with { passive: true } (scroll-friendly touch/wheel) |
// delegate: on a custom element, still receive native input/change events that
// bubble up from inner controls (off by default; see FRAMEWORK.md x-model notes)
const KNOWN_MODIFIERS = new Set(['prevent', 'stop', 'passive', 'delegate']);

// HTML entities - common ones for inline decoding
const HTML_ENTITIES = new Map([
    // XML predefined
    ['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"'], ['apos', "'"],
    // Common
    ['nbsp', '\u00A0'], ['copy', '\u00A9'], ['reg', '\u00AE'], ['trade', '\u2122'],
    ['mdash', '\u2014'], ['ndash', '\u2013'], ['lsquo', '\u2018'], ['rsquo', '\u2019'],
    ['ldquo', '\u201C'], ['rdquo', '\u201D'], ['bull', '\u2022'], ['hellip', '\u2026'],
    ['euro', '\u20AC'], ['pound', '\u00A3'], ['yen', '\u00A5'], ['cent', '\u00A2'],
    ['deg', '\u00B0'], ['plusmn', '\u00B1'], ['times', '\u00D7'], ['divide', '\u00F7'],
    ['frac12', '\u00BD'], ['frac14', '\u00BC'], ['frac34', '\u00BE'],
    ['para', '\u00B6'], ['sect', '\u00A7'], ['dagger', '\u2020'], ['Dagger', '\u2021'],
    ['laquo', '\u00AB'], ['raquo', '\u00BB'], ['iexcl', '\u00A1'], ['iquest', '\u00BF'],
    ['acute', '\u00B4'], ['cedil', '\u00B8'], ['macr', '\u00AF'], ['micro', '\u00B5'],
    ['middot', '\u00B7'], ['ordf', '\u00AA'], ['ordm', '\u00BA'],
    ['sup1', '\u00B9'], ['sup2', '\u00B2'], ['sup3', '\u00B3'],
    ['not', '\u00AC'], ['shy', '\u00AD'], ['brvbar', '\u00A6'], ['curren', '\u00A4'],
    // Greek letters
    ['Alpha', '\u0391'], ['Beta', '\u0392'], ['Gamma', '\u0393'], ['Delta', '\u0394'],
    ['Epsilon', '\u0395'], ['Zeta', '\u0396'], ['Eta', '\u0397'], ['Theta', '\u0398'],
    ['Iota', '\u0399'], ['Kappa', '\u039A'], ['Lambda', '\u039B'], ['Mu', '\u039C'],
    ['Nu', '\u039D'], ['Xi', '\u039E'], ['Omicron', '\u039F'], ['Pi', '\u03A0'],
    ['Rho', '\u03A1'], ['Sigma', '\u03A3'], ['Tau', '\u03A4'], ['Upsilon', '\u03A5'],
    ['Phi', '\u03A6'], ['Chi', '\u03A7'], ['Psi', '\u03A8'], ['Omega', '\u03A9'],
    ['alpha', '\u03B1'], ['beta', '\u03B2'], ['gamma', '\u03B3'], ['delta', '\u03B4'],
    ['epsilon', '\u03B5'], ['zeta', '\u03B6'], ['eta', '\u03B7'], ['theta', '\u03B8'],
    ['iota', '\u03B9'], ['kappa', '\u03BA'], ['lambda', '\u03BB'], ['mu', '\u03BC'],
    ['nu', '\u03BD'], ['xi', '\u03BE'], ['omicron', '\u03BF'], ['pi', '\u03C0'],
    ['rho', '\u03C1'], ['sigmaf', '\u03C2'], ['sigma', '\u03C3'], ['tau', '\u03C4'],
    ['upsilon', '\u03C5'], ['phi', '\u03C6'], ['chi', '\u03C7'], ['psi', '\u03C8'], ['omega', '\u03C9'],
    // Arrows
    ['larr', '\u2190'], ['uarr', '\u2191'], ['rarr', '\u2192'], ['darr', '\u2193'],
    ['harr', '\u2194'], ['crarr', '\u21B5'],
    ['lArr', '\u21D0'], ['uArr', '\u21D1'], ['rArr', '\u21D2'], ['dArr', '\u21D3'], ['hArr', '\u21D4'],
    // Math
    ['forall', '\u2200'], ['part', '\u2202'], ['exist', '\u2203'], ['empty', '\u2205'],
    ['nabla', '\u2207'], ['isin', '\u2208'], ['notin', '\u2209'], ['ni', '\u220B'],
    ['prod', '\u220F'], ['sum', '\u2211'], ['minus', '\u2212'], ['lowast', '\u2217'],
    ['radic', '\u221A'], ['prop', '\u221D'], ['infin', '\u221E'], ['ang', '\u2220'],
    ['and', '\u2227'], ['or', '\u2228'], ['cap', '\u2229'], ['cup', '\u222A'],
    ['int', '\u222B'], ['there4', '\u2234'], ['sim', '\u223C'], ['cong', '\u2245'],
    ['asymp', '\u2248'], ['ne', '\u2260'], ['equiv', '\u2261'], ['le', '\u2264'],
    ['ge', '\u2265'], ['sub', '\u2282'], ['sup', '\u2283'], ['nsub', '\u2284'],
    ['sube', '\u2286'], ['supe', '\u2287'], ['oplus', '\u2295'], ['otimes', '\u2297'],
    ['perp', '\u22A5'], ['sdot', '\u22C5'],
    // Misc
    ['spades', '\u2660'], ['clubs', '\u2663'], ['hearts', '\u2665'], ['diams', '\u2666'],
    ['loz', '\u25CA'], ['lceil', '\u2308'], ['rceil', '\u2309'], ['lfloor', '\u230A'], ['rfloor', '\u230B'],
    ['lang', '\u2329'], ['rang', '\u232A'],
    // Whitespace
    ['ensp', '\u2002'], ['emsp', '\u2003'], ['thinsp', '\u2009'],
    ['zwnj', '\u200C'], ['zwj', '\u200D'], ['lrm', '\u200E'], ['rlm', '\u200F']
]);

/**
 * Decode an HTML entity
 * @param {string} entity - Entity without & and ; (e.g., 'nbsp', '#160', '#xA0')
 * @returns {string|null} Decoded character or null if invalid
 */
function decodeEntity(entity) {
    // Numeric decimal: #123
    if (entity.startsWith('#') && !entity.startsWith('#x') && !entity.startsWith('#X')) {
        const code = parseInt(entity.slice(1), 10);
        if (!isNaN(code) && code >= 0 && code <= 0x10FFFF) {
            return String.fromCodePoint(code);
        }
        return null;
    }

    // Numeric hex: #x7B or #X7B
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
        const code = parseInt(entity.slice(2), 16);
        if (!isNaN(code) && code >= 0 && code <= 0x10FFFF) {
            return String.fromCodePoint(code);
        }
        return null;
    }

    // Named entity
    return HTML_ENTITIES.get(entity) || null;
}

/**
 * Decode all entities in a string
 * @param {string} str - String with potential entities
 * @returns {string} String with entities decoded
 */
function decodeEntities(str) {
    if (!str.includes('&')) return str;

    return str.replace(/&([a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#[xX][0-9a-fA-F]+);?/g, (match, entity) => {
        // If it ends with semicolon, it's a proper entity
        if (match.endsWith(';')) {
            const decoded = decodeEntity(entity);
            return decoded !== null ? decoded : match;
        }
        // No semicolon - leave as-is (bare ampersand is valid in HTML5)
        return match;
    });
}

/**
 * Parse HTML template strings into tree structure
 * @param {TemplateStringsArray} strings - Template literal string parts
 * @returns {Object} Parsed tree structure for buildOpTree
 */
export function htmlParse(strings) {
    const parser = new Parser(strings);
    return parser.parse();
}

/**
 * Parser class - streaming parser for template strings
 */
class Parser {
    constructor(strings) {
        this.strings = strings;
        this.stringIndex = 0;
        this.pos = 0;
        this.state = State.TEXT;

        // Current parsing context
        this.textBuffer = '';
        this.tagName = '';
        this.attrName = '';
        this.attrValue = '';
        this.attrQuote = '';

        // Element stack for nesting
        this.stack = [];
        this.root = { type: 'fragment', wrapped: false, children: [] };
        this.current = this.root;

        // Current element being built
        this.currentElement = null;

        // Track if we're inside an attribute value when a slot boundary hits
        this.attrHasSlot = false;
        this.attrSlots = [];
        this.attrTemplate = '';
    }

    /**
     * Get current character or null if at end
     */
    peek() {
        if (this.stringIndex >= this.strings.length) return null;
        const str = this.strings[this.stringIndex];
        if (this.pos >= str.length) return null;
        return str[this.pos];
    }

    /**
     * Consume current character and advance
     */
    consume() {
        const ch = this.peek();
        if (ch !== null) {
            this.pos++;
        }
        return ch;
    }

    /**
     * Check if we're at the end of current string
     */
    atStringEnd() {
        return this.pos >= this.strings[this.stringIndex].length;
    }

    /**
     * Check if there's a slot after current string
     */
    hasSlotAfter() {
        return this.stringIndex < this.strings.length - 1;
    }

    /**
     * Move to next string (after processing a slot)
     */
    nextString() {
        this.stringIndex++;
        this.pos = 0;
    }

    /**
     * Lookahead to check for a sequence
     */
    lookAhead(seq) {
        const str = this.strings[this.stringIndex];
        return str.slice(this.pos, this.pos + seq.length) === seq;
    }

    /**
     * Skip ahead by n characters
     */
    skip(n) {
        this.pos += n;
    }

    /**
     * Main parse loop
     */
    parse() {
        while (this.stringIndex < this.strings.length) {
            // Process characters in current string
            while (!this.atStringEnd()) {
                this.processChar();
            }

            // At end of current string - check for slot
            if (this.hasSlotAfter()) {
                this.handleSlot(this.stringIndex);
                this.nextString();
            } else {
                // Last string - done
                break;
            }
        }

        // Finalize any pending text
        this.flushText();

        // Close any unclosed tags
        while (this.stack.length > 0) {
            this.closeElement();
        }

        return this.root;
    }

    /**
     * Process a single character based on current state
     */
    processChar() {
        const ch = this.peek();

        switch (this.state) {
            case State.TEXT:
                this.parseText();
                break;

            case State.TAG_OPEN:
                this.parseTagOpen();
                break;

            case State.TAG_NAME:
                this.parseTagName();
                break;

            case State.TAG_SPACE:
                this.parseTagSpace();
                break;

            case State.ATTR_NAME:
                this.parseAttrName();
                break;

            case State.ATTR_EQ:
                this.parseAttrEq();
                break;

            case State.ATTR_VALUE_START:
                this.parseAttrValueStart();
                break;

            case State.ATTR_VALUE:
                this.parseAttrValue();
                break;

            case State.END_TAG:
                this.parseEndTag();
                break;

            case State.COMMENT:
                this.parseComment();
                break;

            case State.TAG_SELF_CLOSE:
                this.parseTagSelfClose();
                break;
        }
    }

    /**
     * Parse text content
     */
    parseText() {
        const ch = this.peek();
        if (ch === '<') {
            this.flushText();
            this.consume();
            this.state = State.TAG_OPEN;
        } else {
            this.textBuffer += this.consume();
        }
    }

    /**
     * After seeing '<', decide what kind of tag
     */
    parseTagOpen() {
        const ch = this.peek();

        if (ch === '/') {
            this.consume();
            this.tagName = '';
            this.state = State.END_TAG;
        } else if (ch === '!') {
            // Could be comment or doctype
            if (this.lookAhead('!--')) {
                this.skip(3);
                this.state = State.COMMENT;
            } else {
                // DOCTYPE or other - skip to >
                while (!this.atStringEnd() && this.peek() !== '>') {
                    this.consume();
                }
                if (this.peek() === '>') this.consume();
                this.state = State.TEXT;
            }
        } else if (ch === '?' || ch === null) {
            // Processing instruction or invalid - recover
            this.textBuffer += '<';
            this.state = State.TEXT;
        } else {
            this.tagName = '';
            this.state = State.TAG_NAME;
        }
    }

    /**
     * Parse tag name
     */
    parseTagName() {
        const ch = this.peek();

        if (ch === null || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            this.finishTagName();
            this.state = State.TAG_SPACE;
            if (ch !== null) this.consume();
        } else if (ch === '>') {
            this.finishTagName();
            this.consume();
            this.openElement();
            this.state = State.TEXT;
        } else if (ch === '/') {
            this.finishTagName();
            this.consume();
            this.state = State.TAG_SELF_CLOSE;
        } else {
            this.tagName += this.consume();
        }
    }

    /**
     * Finish collecting tag name
     */
    finishTagName() {
        this.tagName = this.tagName.toLowerCase();
        this.currentElement = {
            type: 'element',
            tag: this.tagName,
            attrs: {},
            events: {},
            children: []
        };
    }

    /**
     * Parse whitespace between tag name and attributes
     */
    parseTagSpace() {
        const ch = this.peek();

        if (ch === null) {
            return;
        } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            this.consume();
        } else if (ch === '>') {
            this.consume();
            this.openElement();
            this.state = State.TEXT;
        } else if (ch === '/') {
            this.consume();
            this.state = State.TAG_SELF_CLOSE;
        } else {
            this.attrName = '';
            this.attrValue = '';
            this.attrQuote = '';
            this.attrHasSlot = false;
            this.attrSlots = [];
            this.attrTemplate = '';
            this.state = State.ATTR_NAME;
        }
    }

    /**
     * Parse attribute name
     */
    parseAttrName() {
        const ch = this.peek();

        if (ch === null) {
            return;
        } else if (ch === '=') {
            this.consume();
            this.state = State.ATTR_VALUE_START;
        } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            this.consume();
            this.state = State.ATTR_EQ;
        } else if (ch === '>') {
            // Boolean attribute at end of tag
            this.finishAttr(true);
            this.consume();
            this.openElement();
            this.state = State.TEXT;
        } else if (ch === '/') {
            // Boolean attribute before self-close
            this.finishAttr(true);
            this.consume();
            this.state = State.TAG_SELF_CLOSE;
        } else {
            this.attrName += this.consume();
        }
    }

    /**
     * After attr name, looking for = or next attr
     */
    parseAttrEq() {
        const ch = this.peek();

        if (ch === null) {
            return;
        } else if (ch === '=') {
            this.consume();
            this.state = State.ATTR_VALUE_START;
        } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            this.consume();
        } else if (ch === '>') {
            // Boolean attribute
            this.finishAttr(true);
            this.consume();
            this.openElement();
            this.state = State.TEXT;
        } else if (ch === '/') {
            this.finishAttr(true);
            this.consume();
            this.state = State.TAG_SELF_CLOSE;
        } else {
            // New attribute without value (boolean attr)
            this.finishAttr(true);
            this.attrName = '';
            this.attrValue = '';
            this.attrHasSlot = false;
            this.attrSlots = [];
            this.attrTemplate = '';
            this.state = State.ATTR_NAME;
        }
    }

    /**
     * After =, expecting quote or unquoted value
     */
    parseAttrValueStart() {
        const ch = this.peek();

        if (ch === null) {
            return;
        } else if (ch === '"' || ch === "'") {
            this.attrQuote = ch;
            this.consume();
            this.state = State.ATTR_VALUE;
        } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            this.consume();
        } else if (ch === '>') {
            // Empty value
            this.finishAttr(false);
            this.consume();
            this.openElement();
            this.state = State.TEXT;
        } else {
            // Unquoted value
            this.attrQuote = '';
            this.state = State.ATTR_VALUE;
        }
    }

    /**
     * Parse attribute value
     */
    parseAttrValue() {
        const ch = this.peek();

        if (ch === null) {
            return;
        }

        if (this.attrQuote) {
            // Quoted value
            if (ch === this.attrQuote) {
                this.consume();
                this.finishAttr(false);
                this.state = State.TAG_SPACE;
            } else {
                this.attrValue += this.consume();
            }
        } else {
            // Unquoted value
            if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
                this.finishAttr(false);
                this.consume();
                this.state = State.TAG_SPACE;
            } else if (ch === '>') {
                this.finishAttr(false);
                this.consume();
                this.openElement();
                this.state = State.TEXT;
            } else if (ch === '/') {
                this.finishAttr(false);
                this.consume();
                this.state = State.TAG_SELF_CLOSE;
            } else {
                this.attrValue += this.consume();
            }
        }
    }

    /**
     * Parse self-closing tag end
     */
    parseTagSelfClose() {
        const ch = this.peek();

        if (ch === '>') {
            this.consume();
            this.openElement(true);
            this.state = State.TEXT;
        } else if (ch === null) {
            return;
        } else {
            // Malformed - treat / as part of attribute
            this.state = State.TAG_SPACE;
        }
    }

    /**
     * Parse end tag name
     */
    parseEndTag() {
        const ch = this.peek();

        if (ch === '>') {
            this.consume();
            this.closeElementByName(this.tagName.toLowerCase());
            this.tagName = '';
            this.state = State.TEXT;
        } else if (ch === null) {
            return;
        } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            // Skip whitespace in end tag
            this.consume();
        } else {
            this.tagName += this.consume();
        }
    }

    /**
     * Parse comment
     */
    parseComment() {
        // Look for -->
        if (this.lookAhead('-->')) {
            this.skip(3);
            this.state = State.TEXT;
        } else {
            this.consume();
        }
    }

    /**
     * Handle a slot at current position
     * @param {number} slotIndex - Index of the slot
     */
    handleSlot(slotIndex) {
        switch (this.state) {
            case State.TEXT:
                // Flush any pending text
                this.flushText();
                // Add slot as text child
                this.current.children.push({
                    type: 'text',
                    slot: slotIndex,
                    context: 'content'
                });
                break;

            case State.ATTR_VALUE:
            case State.ATTR_VALUE_START:
                // Slot in attribute value
                this.attrHasSlot = true;
                this.attrSlots.push(slotIndex);
                // Track position in template for multi-slot attrs
                this.attrTemplate += this.attrValue + `\x00${slotIndex}\x00`;
                this.attrValue = '';
                break;

            case State.TAG_SPACE:
            case State.ATTR_EQ:
                // Slot where an attribute value would be (entire value is slot)
                // This is like: <div class=${foo}>
                // We're between = and the value, or in tag space
                if (this.attrName) {
                    this.attrHasSlot = true;
                    this.attrSlots.push(slotIndex);
                    this.attrTemplate = `\x00${slotIndex}\x00`;
                    this.finishAttr(false);
                    this.state = State.TAG_SPACE;
                }
                break;

            case State.TAG_NAME:
                // Dynamic tag name (rare but possible)
                // For now, just treat as static
                break;

            case State.ATTR_NAME:
                // Slot in attribute name - unusual, skip
                break;

            default:
                // Other states - skip slot
                break;
        }
    }

    /**
     * Finish an attribute and add to current element
     * @param {boolean} isBoolean - True if this is a boolean attribute (no value)
     */
    finishAttr(isBoolean) {
        if (!this.attrName || !this.currentElement) return;

        // Preserve original case for attribute names (needed for custom element props)
        // Only lowercase for special attribute detection (x-model, on-*, ref)
        const name = this.attrName;
        const nameLower = name.toLowerCase();

        // Decode entities in value
        let value = decodeEntities(this.attrValue);

        // Determine attribute type and create appropriate definition
        // Use lowercase for special attribute detection
        if (nameLower === 'x-model') {
            this.handleXModel(value);
        } else if (nameLower === 'ref') {
            this.currentElement.attrs['__ref__'] = { refName: value };
        } else if (nameLower.startsWith('on-')) {
            this.handleEvent(name, value);  // Pass original name for event parsing
        } else {
            // Regular attribute - preserve original case
            this.handleRegularAttr(name, value, isBoolean);
        }

        // Reset attr state
        this.attrName = '';
        this.attrValue = '';
        this.attrQuote = '';
        this.attrHasSlot = false;
        this.attrSlots = [];
        this.attrTemplate = '';
    }

    /**
     * Handle x-model attribute
     */
    handleXModel(value) {
        const tag = this.currentElement.tag;
        const isCustomElement = tag.includes('-');

        // Get input type if available
        const typeAttr = this.currentElement.attrs['type'];
        const inputType = typeAttr ? typeAttr.value : null;

        if (isCustomElement) {
            this.currentElement.attrs['value'] = { xModel: value, context: 'x-model-value' };
            this.currentElement.events['change'] = { xModel: value, modifier: null, customElement: true };
        } else if (inputType === 'checkbox') {
            this.currentElement.attrs['checked'] = { xModel: value, context: 'x-model-checked' };
            this.currentElement.events['change'] = { xModel: value, modifier: null };
        } else if (inputType === 'radio') {
            const radioValue = this.currentElement.attrs['value']?.value;
            this.currentElement.attrs['checked'] = { xModel: value, radioValue, context: 'x-model-radio' };
            this.currentElement.events['change'] = { xModel: value, modifier: null };
        } else if (inputType === 'file') {
            this.currentElement.events['change'] = { xModel: value, modifier: null };
        } else {
            this.currentElement.attrs['value'] = { xModel: value, context: 'x-model-value' };
            this.currentElement.events['input'] = { xModel: value, modifier: null };
        }
    }

    /**
     * Handle on-* event attribute
     */
    handleEvent(name, value) {
        const fullEventName = name.substring(3);
        let eventName;
        const modifiers = [];

        if (fullEventName === 'click-outside') {
            eventName = 'clickoutside';
        } else {
            // Strip ALL trailing known modifiers (on-click-prevent-stop -> click + [prevent, stop])
            const parts = fullEventName.split('-');
            while (parts.length > 1 && KNOWN_MODIFIERS.has(parts[parts.length - 1])) {
                modifiers.unshift(parts.pop());
            }
            eventName = parts.join('-');
        }

        let eventDef;
        if (this.attrHasSlot && this.attrSlots.length === 1 && !value) {
            // Entire value is a slot (function reference)
            eventDef = { slot: this.attrSlots[0], modifiers };
        } else {
            // Method name string
            eventDef = { method: value, modifiers };
        }

        // Handle chaining
        if (this.currentElement.events[eventName]) {
            eventDef._chainWith = this.currentElement.events[eventName];
        }

        this.currentElement.events[eventName] = eventDef;
    }

    /**
     * Handle regular attribute
     */
    handleRegularAttr(name, value, isBoolean) {
        const tag = this.currentElement.tag;
        const isCustomElement = tag.includes('-');

        // Determine context
        let context = 'attribute';
        if (name === 'href' || name === 'src' || name === 'action') {
            context = 'url';
        } else if (name === 'style' || name === 'srcdoc') {
            context = 'dangerous';
        } else if (isCustomElement) {
            context = 'custom-element-attr';
        }

        if (this.attrHasSlot) {
            // Dynamic attribute
            if (this.attrSlots.length === 1 && (this.attrTemplate === `\x00${this.attrSlots[0]}\x00` || !this.attrTemplate)) {
                // Single slot, entire value
                this.currentElement.attrs[name] = {
                    slot: this.attrSlots[0],
                    context,
                    attrName: name
                };
            } else {
                // Multiple slots or mixed content
                // Build template string with slot markers
                let template = this.attrTemplate + value;
                this.currentElement.attrs[name] = {
                    slots: this.attrSlots,
                    context,
                    attrName: name,
                    template
                };
            }
        } else if (isBoolean) {
            // Boolean attribute
            this.currentElement.attrs[name] = { value: name };
        } else {
            // Static attribute
            this.currentElement.attrs[name] = { value };
        }
    }

    /**
     * Open a new element and push onto stack
     * @param {boolean} selfClosing - True if self-closing tag
     */
    openElement(selfClosing = false) {
        if (!this.currentElement) return;

        const el = this.currentElement;
        const isVoid = VOID_ELEMENTS.has(el.tag) || selfClosing;

        // Add to current container
        this.current.children.push(el);

        if (!isVoid) {
            // Push onto stack and make this the current container
            this.stack.push(this.current);
            this.current = el;
        }

        this.currentElement = null;
    }

    /**
     * Close current element
     */
    closeElement() {
        if (this.stack.length > 0) {
            this.current = this.stack.pop();
        }
    }

    /**
     * Close element by name, handling mismatches
     */
    closeElementByName(tagName) {
        // Find the tag in the stack
        let found = -1;
        if (this.current.type === 'element' && this.current.tag === tagName) {
            this.closeElement();
            return;
        }

        // Search stack for matching tag
        for (let i = this.stack.length - 1; i >= 0; i--) {
            const el = this.stack[i];
            if (el.type === 'element' && el.tag === tagName) {
                found = i;
                break;
            }
        }

        if (found >= 0) {
            // Close everything up to and including the found element
            while (this.stack.length > found) {
                this.closeElement();
            }
        }
        // If not found, ignore the close tag (browser behavior)
    }

    /**
     * Flush pending text buffer to current container
     */
    flushText() {
        if (this.textBuffer) {
            // Decode entities
            let text = decodeEntities(this.textBuffer);

            // Whitespace handling:
            // - If text is ONLY whitespace, collapse to single space (unless empty)
            // - Otherwise preserve as-is
            if (/^\s+$/.test(text)) {
                // Pure whitespace - collapse to single space
                // But only add if we have non-whitespace siblings
                if (this.current.children.length > 0 || text.includes('\n')) {
                    text = ' ';
                } else {
                    text = '';
                }
            }

            if (text) {
                this.current.children.push({
                    type: 'text',
                    value: text
                });
            }

            this.textBuffer = '';
        }
    }
}
