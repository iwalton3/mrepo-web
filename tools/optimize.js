#!/usr/bin/env node
/**
 * VDX Optimizer - Build-Time opt() Transformations
 *
 * Copies source files while applying fine-grained reactivity transformations.
 * Wraps ${...} expressions in html`` templates with html.contain() for
 * Solid-style fine-grained reactivity without runtime eval().
 *
 * Default mode: Optimizes ALL html`` templates (not just eval(opt()) wrapped)
 * --wrapped-only: Only optimize templates wrapped in eval(opt())
 *
 * Usage:
 *   node optimize.js --input ./src --output ./dist
 *   node optimize.js -i ./src -o ./dist --minify --sourcemap
 *   node optimize.js -i ./src -o ./dist --wrapped-only
 *
 * Options:
 *   --input, -i       Input directory (required)
 *   --output, -o      Output directory (required, except with --lint-only)
 *   --minify, -m      Minify JavaScript
 *   --sourcemap, -s   Generate source maps (implies --minify)
 *   --wrapped-only    Only optimize eval(opt()) wrapped templates (default: optimize all)
 *   --lint-only       Check for early dereference issues without transforming (no output required)
 *   --verbose, -v     Show processing details
 *   --dry-run         Preview without writing files
 *   --help, -h        Show help
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// CLI Argument Parsing
// =============================================================================

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        input: null,
        output: null,
        minify: false,
        sourcemap: false,
        wrappedOnly: false,
        lintOnly: false,
        autoFix: false,
        verbose: false,
        dryRun: false,
        strict: false
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--input':
            case '-i':
                options.input = args[++i];
                break;
            case '--output':
            case '-o':
                options.output = args[++i];
                break;
            case '--minify':
            case '-m':
                options.minify = true;
                break;
            case '--sourcemap':
            case '-s':
                options.sourcemap = true;
                options.minify = true;  // Source maps imply minify
                break;
            case '--wrapped-only':
                options.wrappedOnly = true;
                break;
            case '--lint-only':
            case '-l':
                options.lintOnly = true;
                break;
            case '--auto-fix':
                options.autoFix = true;
                options.lintOnly = true;  // Auto-fix implies lint mode
                break;
            case '--verbose':
            case '-v':
                options.verbose = true;
                break;
            case '--dry-run':
                options.dryRun = true;
                break;
            case '--strict':
                options.strict = true;
                break;
            case '--help':
            case '-h':
                showHelp();
                process.exit(0);
        }
    }

    return options;
}

function showHelp() {
    console.log(`
VDX Optimizer - Build-Time opt() Transformations

Copies source files while applying fine-grained reactivity transformations.
By default, optimizes ALL html\`\` templates for Solid-style fine-grained reactivity.

Usage:
  node optimize.js --input <dir> --output <dir> [options]
  node optimize.js --input <dir> --lint-only

Examples:
  node optimize.js -i ./app/componentlib -o ./app/componentlib-opt
  node optimize.js -i ./src -o ./dist --minify --sourcemap
  node optimize.js -i ./src -o ./dist --wrapped-only
  node optimize.js -i ./src --lint-only              # Check for issues
  node optimize.js -i ./src --lint-only --strict     # Fail CI on unfixable

Options:
  --input, -i       Input directory (required)
  --output, -o      Output directory (required, except with --lint-only)
  --minify, -m      Minify JavaScript output
  --sourcemap, -s   Generate source maps (implies --minify)
  --wrapped-only    Only optimize templates wrapped in eval(opt())
                    Default: optimize ALL html\`\` templates
  --lint-only, -l   Check ALL files for early dereference issues
                    Shows both fixable (auto-fixed by optimizer) and unfixable issues
                    Exit code 1 if fixable issues, 2 if unfixable issues
  --strict          With --lint-only: only show UNFIXABLE issues (optimizer can't fix)
                    Use to check code before running optimizer
                    Exit code 1 if unfixable issues found (for CI)
  --auto-fix        Fix early dereferences in-place (all files)
                    Only fixes simple patterns, not computed expressions
  --verbose, -v     Show detailed processing information
  --dry-run         Preview files that would be processed without writing
  --help, -h        Show this help message

What the optimizer does:
  1. Transforms \${expr} in html\`\` templates to \${html.contain(() => expr)}
  2. Fixes early dereferences (const x = this.state.y before template)
  3. Strips eval(opt()) wrappers (they become redundant)
  4. Optionally minifies with source maps

Early Dereference Detection:
  The linter warns about code patterns that break reactivity:

  1. Variables captured in callbacks:
    const { count } = this.state;
    \${when(condition, () => html\`\${count}\`)}  // BREAKS - captured value

  2. Early dereferences in templates:
    const { count } = this.state;
    return html\`\${count}\`;  // OK with optimizer, but breaks without it

  3. Stale arguments to helpers (UNFIXABLE - optimizer skips these files):
    const items = data.slice(start, end);  // Computed from state
    \${memoEach(items, ...)}                // STALE after contain() updates

  Run --lint-only to find issues that would break the deployed codebase.
  Run --auto-fix to automatically fix simple patterns.
  Run --lint-only --strict in CI to fail on unfixable patterns.

This eliminates the need for 'unsafe-eval' CSP and runtime eval().
`);
}

// =============================================================================
// opt() Transformation Functions (ported from app/lib/opt.js)
// =============================================================================

/**
 * Check if character at position is escaped (odd number of preceding backslashes)
 */
function isEscaped(source, pos) {
    let count = 0;
    let p = pos - 1;
    while (p >= 0 && source[p] === '\\') {
        count++;
        p--;
    }
    return count % 2 === 1;
}

/**
 * Parse a single expression starting at position i (after the ${).
 * Returns the expression text and end position (after the closing }).
 */
function parseExpression(source, startPos) {
    let i = startPos;
    let depth = 1;
    let inString = false;
    let stringChar = null;
    let inTemplate = false;

    while (i < source.length && depth > 0) {
        const ch = source[i];
        const prev = i > 0 ? source[i - 1] : '';

        if (prev === '\\' && !isEscaped(source, i - 1)) {
            i++;
            continue;
        }

        // Handle comments (only when not in string or template)
        if (!inString && !inTemplate) {
            if (ch === '/' && source[i + 1] === '/') {
                while (i < source.length && source[i] !== '\n') i++;
                continue;
            }
            if (ch === '/' && source[i + 1] === '*') {
                i += 2;
                while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
                i += 2;
                continue;
            }
        }

        // Handle strings
        if (!inString && !inTemplate && (ch === '"' || ch === "'")) {
            inString = true;
            stringChar = ch;
            i++;
            continue;
        }
        if (inString && ch === stringChar && !isEscaped(source, i)) {
            inString = false;
            stringChar = null;
            i++;
            continue;
        }
        if (inString) {
            i++;
            continue;
        }

        // Handle nested template literals
        if (ch === '`' && !inTemplate) {
            inTemplate = true;
            i++;
            continue;
        }
        if (ch === '`' && inTemplate) {
            inTemplate = false;
            i++;
            continue;
        }

        // Handle ${ inside nested template
        if (inTemplate && ch === '$' && source[i + 1] === '{') {
            i += 2;
            const nested = parseExpression(source, i);
            i = nested.end;
            continue;
        }

        // Handle braces
        if (!inTemplate && ch === '{') {
            depth++;
            i++;
            continue;
        }
        if (!inTemplate && ch === '}') {
            depth--;
            if (depth === 0) {
                const text = source.slice(startPos, i);
                return { text, end: i + 1 };
            }
            i++;
            continue;
        }

        i++;
    }

    const text = source.slice(startPos, i);
    return { text, end: i };
}

/**
 * Find all html`` template start positions in source (including nested ones).
 */
function findAllHtmlTemplateStarts(source) {
    const starts = [];
    for (let i = 0; i < source.length - 4; i++) {
        if (source.slice(i, i + 5) === 'html`') {
            starts.push(i);
        }
    }
    return starts;
}

/**
 * Extract expressions from a single html`` template starting at templateStart.
 * Returns expressions with absolute positions in the source.
 */
function extractExpressionsFromTemplate(source, templateStart) {
    const expressions = [];
    let i = templateStart + 5;  // After 'html`'
    let templateDepth = 1;

    while (i < source.length && templateDepth > 0) {
        const ch = source[i];
        const prev = i > 0 ? source[i - 1] : '';

        if (prev === '\\' && !isEscaped(source, i - 1)) {
            i++;
            continue;
        }

        if (ch === '`') {
            templateDepth--;
            if (templateDepth === 0) break;
            i++;
            continue;
        }

        // Skip nested html`` templates (they'll be processed separately)
        if (source.slice(i, i + 5) === 'html`') {
            i += 5;
            let nestedDepth = 1;
            while (i < source.length && nestedDepth > 0) {
                if (source[i] === '`' && source[i - 1] !== '\\') nestedDepth--;
                else if (source.slice(i, i + 5) === 'html`') { nestedDepth++; i += 4; }
                i++;
            }
            continue;
        }

        if (ch === '$' && source[i + 1] === '{') {
            const start = i;
            i += 2;
            const expr = parseExpression(source, i);
            i = expr.end;
            expressions.push({
                start,
                end: i,
                expr: expr.text
            });
            continue;
        }

        i++;
    }

    return expressions;
}

/**
 * Extract all ${...} expressions from ALL html`` template literals in source.
 * Handles nested templates (e.g., inside when/each callbacks).
 */
function extractExpressions(source) {
    const templateStarts = findAllHtmlTemplateStarts(source);
    const allExpressions = [];

    for (const start of templateStarts) {
        const exprs = extractExpressionsFromTemplate(source, start);
        allExpressions.push(...exprs);
    }

    // Sort by position (for consistent processing order)
    allExpressions.sort((a, b) => a.start - b.start);

    return allExpressions;
}

/**
 * Determine if an expression should be skipped (not wrapped in html.contain).
 */
function shouldSkipWrapping(expr) {
    const trimmed = expr.trim();

    // Skip already-isolated helpers and special vnodes
    // - contain/raw: already isolated
    // - memoEach: has its own caching mechanism, complex to wrap in contain
    // - when/each: condition/array is evaluated before callback runs, captured vars won't update
    if (/^(contain|raw|html\.contain|memoEach|when|each)\s*\(/.test(trimmed)) {
        return true;
    }

    // Skip expressions containing raw() anywhere - raw() returns a special vnode
    // marker that must be placed directly in the template, not wrapped
    if (/\braw\s*\(/.test(trimmed)) {
        return true;
    }

    // Skip arrow functions
    if (/^\([^)]*\)\s*=>/.test(trimmed) || /^\w+\s*=>/.test(trimmed)) {
        return true;
    }

    // Skip function expressions
    if (/^function\s*[\w]*\s*\(/.test(trimmed)) {
        return true;
    }

    // Skip async arrow functions
    if (/^async\s+\([^)]*\)\s*=>/.test(trimmed) || /^async\s+\w+\s*=>/.test(trimmed)) {
        return true;
    }

    // Skip async function expressions
    if (/^async\s+function\s*[\w]*\s*\(/.test(trimmed)) {
        return true;
    }

    // Skip slot/children access
    if (/^this\.props\.(children|slots)\b/.test(trimmed)) {
        return true;
    }

    // Skip expressions that have no reactive content
    // If it doesn't reference this.state, this.stores, or this.props, there's nothing reactive to wrap
    // This prevents wrapping function parameters like promiseOrValue in awaitThen()
    if (!/\bthis\.(state|stores|props)\b/.test(trimmed)) {
        return true;
    }

    return false;
}

// =============================================================================
// Early Dereference Detection and Fixing (for optimize.js build-time)
// =============================================================================

/**
 * Detect early dereference patterns in template() functions only.
 *
 * Returns an object with:
 *   - fixable: Map of variable name -> reactive path (optimizer can fix)
 *   - unfixable: Map of variable name -> { path, reason } (optimizer cannot fix)
 *
 * Fixable patterns (simple property access):
 *   const x = this.state.y           → x -> this.state.y
 *   const { x, y } = this.state      → x -> this.state.x, y -> this.state.y
 *
 * Unfixable patterns (computed/chained expressions):
 *   const x = this.state.y + 2       → can't replace x with expression
 *   const x = this.state.y || def    → can't replace x with expression
 *   const x = fn(this.state.y)       → can't replace x with expression
 */
function detectEarlyDereferences(source) {
    // Find template() function - look for template() { or template: function() {
    const templateMatch = source.match(/\btemplate\s*\(\s*\)\s*\{|\btemplate\s*:\s*function\s*\(\s*\)\s*\{/);
    if (!templateMatch) {
        // No template function - check the whole source (for test files)
        return detectDereferencesInSource(source);
    }

    // Extract template function body
    const templateStart = templateMatch.index + templateMatch[0].length;

    // Find the end of the template function (matching brace)
    let depth = 1;
    let i = templateStart;
    while (i < source.length && depth > 0) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        i++;
    }
    const templateBody = source.slice(templateMatch.index, i);

    // Find first html`` in template body
    const firstHtml = templateBody.indexOf('html`');
    if (firstHtml === -1) return { fixable: new Map(), unfixable: new Map() };

    // Only look for dereferences BEFORE the first html`` call
    const preHtmlSection = templateBody.slice(0, firstHtml);

    const result = detectDereferencesInSource(preHtmlSection);

    // Also look for dereferences inside callback bodies that contain nested html`` calls.
    // These are problematic if used in a NESTED contain() (boundary between def and usage).
    // We track positions so the linter can check if def is inside/outside usage region.
    // Pass templateBodyOffset so positions are in SOURCE coordinates (not templateBody-relative)
    const templateBodyOffset = templateMatch.index;
    detectNestedCallbackDereferences(templateBody, result, templateBodyOffset);

    return result;
}

/**
 * Find early dereferences inside callback bodies that have nested html`` calls.
 * Modifies the result in place by adding to fixable/unfixable maps.
 * Tracks the callback region (bodyStart, bodyEnd) so we can determine if a usage
 * is in the same region as its definition (which is fine) or a nested region (problematic).
 *
 * @param templateBody - The template function body text
 * @param result - Object with fixable/unfixable Maps to update
 * @param sourceOffset - Offset to add to positions to convert from templateBody coords to source coords
 */
function detectNestedCallbackDereferences(templateBody, result, sourceOffset = 0) {
    // Find arrow function callbacks: () => { ... } or (args) => { ... }
    // that contain html`` calls
    const callbackPattern = /(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>\s*\{/g;
    let match;

    while ((match = callbackPattern.exec(templateBody)) !== null) {
        const bodyStart = match.index + match[0].length;

        // Find the matching closing brace for this callback body
        let depth = 1;
        let i = bodyStart;
        let inString = false;
        let stringChar = '';

        while (i < templateBody.length && depth > 0) {
            const ch = templateBody[i];

            // Handle strings (skip their contents)
            if (!inString && (ch === '"' || ch === "'" || ch === '`')) {
                inString = true;
                stringChar = ch;
                i++;
                continue;
            }
            if (inString) {
                if (ch === '\\' && i + 1 < templateBody.length) {
                    i += 2; // Skip escape sequence
                    continue;
                }
                if (ch === stringChar) {
                    inString = false;
                }
                // Handle ${} in template literals
                if (stringChar === '`' && ch === '$' && templateBody[i + 1] === '{') {
                    i += 2;
                    let tDepth = 1;
                    while (i < templateBody.length && tDepth > 0) {
                        if (templateBody[i] === '{') tDepth++;
                        else if (templateBody[i] === '}') tDepth--;
                        i++;
                    }
                    continue;
                }
                i++;
                continue;
            }

            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            i++;
        }

        const bodyEnd = i - 1; // Position of closing brace
        const callbackBody = templateBody.slice(bodyStart, bodyEnd);

        // Check if this callback body contains a html`` call
        const nestedHtmlIdx = callbackBody.indexOf('html`');
        if (nestedHtmlIdx === -1) continue;

        // Look for dereferences BEFORE the nested html`` call
        const preNestedHtml = callbackBody.slice(0, nestedHtmlIdx);
        const nestedResult = detectDereferencesInSource(preNestedHtml);

        // Merge into main result, tracking the callback region for each dereference
        // The region info lets us determine if usage is in same callback (fine) or nested (problematic)
        // Add sourceOffset to convert from templateBody coordinates to source coordinates
        for (const [varName, pathOrInfo] of nestedResult.fixable) {
            if (!result.fixable.has(varName)) {
                // Store path with region info (in source coordinates)
                result.fixable.set(varName, {
                    path: typeof pathOrInfo === 'string' ? pathOrInfo : pathOrInfo.path,
                    defRegionStart: bodyStart + sourceOffset,
                    defRegionEnd: bodyEnd + sourceOffset
                });
            }
        }
        for (const [varName, info] of nestedResult.unfixable) {
            if (!result.unfixable.has(varName)) {
                result.unfixable.set(varName, {
                    ...info,
                    defRegionStart: bodyStart + sourceOffset,
                    defRegionEnd: bodyEnd + sourceOffset
                });
            }
        }
    }
}

/**
 * Helper: detect dereferences in a source string.
 * Returns { fixable: Map, unfixable: Map }
 */
function detectDereferencesInSource(source) {
    const fixable = new Map();
    const unfixable = new Map();

    // Pattern 1: Direct assignment - const/let/var x = this.state.y...
    // We need to check if it's a simple path or a computed expression
    const directAssign = /\b(?:const|let|var)\s+(\w+)\s*=\s*(this\.(?:state|stores)(?:\.\w+)+)/g;
    let match;
    while ((match = directAssign.exec(source)) !== null) {
        const [fullMatch, varName, path] = match;
        const afterPath = source.slice(match.index + fullMatch.length);

        // Look past whitespace/newlines for what comes next
        const nextNonWhitespace = afterPath.match(/^\s*(\S)/);
        const nextChar = nextNonWhitespace ? nextNonWhitespace[1] : '';

        // If followed by operator or ternary, it's a computed expression (unfixable)
        // Simple assignments end with ; or have nothing but whitespace/newline
        const isComputed = nextChar && !/^[;\n]$/.test(nextChar) && nextChar !== '';

        if (isComputed) {
            // Has additional operations - unfixable
            const snippet = afterPath.slice(0, 20).replace(/\s+/g, ' ');
            unfixable.set(varName, {
                path,
                reason: `computed: ${path}${snippet}...`
            });
        } else {
            // Simple path access - fixable
            fixable.set(varName, path);
        }
    }

    // Pattern 2: Destructuring - const { x, y } = this.state or this.stores.foo
    // These are always fixable (simple property access)
    const destructure = /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(this\.(?:state|stores)(?:\.\w+)*)/g;
    while ((match = destructure.exec(source)) !== null) {
        const [, vars, basePath] = match;

        // Parse destructured variables (handles { a, b: c, d = default })
        for (const part of vars.split(',')) {
            const trimmed = part.trim();
            if (!trimmed) continue;

            let propName, varName;

            if (trimmed.includes(':')) {
                // Renamed: { prop: varName } or { prop: varName = default }
                const [left, right] = trimmed.split(':').map(s => s.trim());
                propName = left;
                varName = right.split('=')[0].trim();
            } else {
                // Simple: { prop } or { prop = default }
                propName = trimmed.split('=')[0].trim();
                varName = propName;
            }

            if (varName && /^\w+$/.test(varName) && propName && /^\w+$/.test(propName)) {
                fixable.set(varName, `${basePath}.${propName}`);
            }
        }
    }

    // Pattern 3: Variable assigned from function/method that uses state
    // Examples:
    //   const x = doSomething(this.state.y)
    //   const x = this.doSomething()  (where doSomething might use state)
    //   const x = someFunc(a, b, this.stores.foo)
    // These are always unfixable
    const funcWithState = /\b(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]*?)\bthis\.(?:state|stores)\b/g;
    while ((match = funcWithState.exec(source)) !== null) {
        const [fullMatch, varName, prefix] = match;
        // Skip if this is a simple assignment we already handled
        if (fixable.has(varName) || unfixable.has(varName)) continue;

        // Extract a snippet of the expression
        const exprStart = source.indexOf('=', match.index) + 1;
        let exprEnd = match.index + fullMatch.length + 30;
        let expr = source.slice(exprStart, exprEnd).trim();
        const semicolon = expr.indexOf(';');
        const newline = expr.indexOf('\n');
        if (semicolon > 0) expr = expr.slice(0, semicolon);
        if (newline > 0 && newline < expr.length) expr = expr.slice(0, newline);

        unfixable.set(varName, {
            path: 'derived from state',
            reason: `fn call: ${expr.slice(0, 25)}...`
        });
    }

    // Pattern 4: Method call that accesses state internally
    // const x = this.someMethod()
    // Only flag if the method body actually accesses this.state or this.stores
    const methodCall = /\b(?:const|let|var)\s+(\w+)\s*=\s*this\.(\w+)\s*\(/g;
    while ((match = methodCall.exec(source)) !== null) {
        const [, varName, methodName] = match;
        // Skip if already handled
        if (fixable.has(varName) || unfixable.has(varName)) continue;

        // Find the method definition and check if it accesses state
        // Look for: methodName() { ... } or methodName: function() { ... }
        const methodDefPattern = new RegExp(
            `\\b${methodName}\\s*\\([^)]*\\)\\s*\\{|` +
            `\\b${methodName}\\s*:\\s*function\\s*\\([^)]*\\)\\s*\\{`,
            'g'
        );
        const methodDefMatch = methodDefPattern.exec(source);

        if (methodDefMatch) {
            // Extract method body by counting braces
            let braceDepth = 0;
            let i = methodDefMatch.index + methodDefMatch[0].length - 1;  // Start at {
            const bodyStart = i;

            while (i < source.length) {
                if (source[i] === '{') braceDepth++;
                else if (source[i] === '}') {
                    braceDepth--;
                    if (braceDepth === 0) break;
                }
                i++;
            }

            const methodBody = source.slice(bodyStart, i + 1);

            // Check if method body accesses this.state or this.stores
            if (/\bthis\.(?:state|stores)\b/.test(methodBody)) {
                unfixable.set(varName, {
                    path: `this.${methodName}()`,
                    reason: `method accesses state/stores internally`
                });
            }
            // If method doesn't access state/stores, it's safe - don't flag it
        }
    }

    return { fixable, unfixable };
}

/**
 * Detect "stale argument" patterns where a computed local variable
 * (derived from state) is passed as an argument to memoEach/each/when.
 *
 * This pattern is UNFIXABLE because:
 * 1. The variable is computed ONCE when the template renders
 * 2. When optimizer wraps other expressions in contain(), the parent template
 *    no longer re-renders on state changes
 * 3. The helper receives the OLD stale value
 *
 * Example:
 *   const visibleItems = items.slice(visibleStart, visibleEnd);  // computed from state
 *   ${memoEach(visibleItems, ...)}  // STALE when contain() effects update
 *
 * Returns { taintedArgs: Map<varName, { line, helper, expression }> }
 */
function detectStaleArgumentPatterns(source) {
    const taintedArgs = new Map();

    // First, find template() function to scope our search
    const templateMatch = source.match(/\btemplate\s*\(\s*\)\s*\{|\btemplate\s*:\s*function\s*\(\s*\)\s*\{/);
    if (!templateMatch) {
        return { taintedArgs };
    }

    // Extract template function body
    const templateStart = templateMatch.index + templateMatch[0].length;
    let depth = 1;
    let i = templateStart;
    while (i < source.length && depth > 0) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        i++;
    }
    const templateBody = source.slice(templateMatch.index, i);

    // Find first html`` in template body
    const firstHtml = templateBody.indexOf('html`');
    if (firstHtml === -1) return { taintedArgs };

    // Get section before html`` - this is where computed locals are defined
    const preHtmlSection = templateBody.slice(0, firstHtml);

    // Find all local variables computed from state (not simple assignments)
    // Pattern: const x = <expression> where expression involves state
    const computedVars = new Map(); // varName -> { expression, line }

    // Get early dereferences first (to know which vars are state-derived)
    const { fixable, unfixable } = detectDereferencesInSource(preHtmlSection);
    const stateVars = new Set([...fixable.keys(), ...unfixable.keys()]);

    // Find computed assignments that use state-derived vars or direct state access
    // Pattern: const x = <anything involving state or state-derived vars>
    const computedPattern = /\b(?:const|let|var)\s+(\w+)\s*=\s*([^;]+);/g;
    let match;
    while ((match = computedPattern.exec(preHtmlSection)) !== null) {
        const [, varName, expression] = match;

        // Skip if this is a simple state assignment (handled by fixable)
        if (fixable.has(varName)) continue;

        // Check if expression uses any state-derived vars OR direct state access
        const usesState = stateVars.size > 0 && Array.from(stateVars).some(sv =>
            new RegExp(`(?<![.\\-])\\b${sv}\\b(?![\\-]|\\s*:)`).test(expression)
        );
        const usesDirectState = /\bthis\.(state|stores)\b/.test(expression);

        if (usesState || usesDirectState) {
            const linesBefore = preHtmlSection.slice(0, match.index).split('\n').length;
            // Add templateMatch.index offset for global line number
            const templateLineOffset = source.slice(0, templateMatch.index).split('\n').length - 1;
            computedVars.set(varName, {
                expression: expression.trim().slice(0, 50) + (expression.length > 50 ? '...' : ''),
                line: templateLineOffset + linesBefore
            });
        }
    }

    if (computedVars.size === 0) {
        return { taintedArgs };
    }

    // Now find usages as first argument to memoEach/each/when in the html section
    const htmlSection = templateBody.slice(firstHtml);
    const helperPattern = /\b(memoEach|each|when)\s*\(\s*(\w+)\s*[,)]/g;

    while ((match = helperPattern.exec(htmlSection)) !== null) {
        const [, helper, varName] = match;

        if (computedVars.has(varName)) {
            const info = computedVars.get(varName);
            // Avoid duplicates
            const key = `${varName}:${helper}`;
            if (!taintedArgs.has(key)) {
                taintedArgs.set(key, {
                    variable: varName,
                    helper,
                    expression: info.expression,
                    line: info.line
                });
            }
        }
    }

    return { taintedArgs };
}

/**
 * Replace early-dereferenced variable usages with their reactive paths.
 *
 * Example: if fixableMap has { count: "this.state.count" }
 *   "count + 1" → "this.state.count + 1"
 *   "user.name" (where user → this.state.user) → "this.state.user.name"
 */
function fixTaintedReferences(expr, fixableMap) {
    if (fixableMap.size === 0) return expr;

    // Find regions to SKIP (inside strings and template literals)
    // This prevents replacing variables in text like "No items found"
    const skipRegions = [];
    let j = 0;
    while (j < expr.length) {
        const ch = expr[j];
        if (ch === '"' || ch === "'" || ch === '`') {
            const strStart = j;
            const quote = ch;
            j++;
            while (j < expr.length) {
                if (expr[j] === '\\') { j += 2; continue; }
                if (expr[j] === quote) { j++; break; }
                // For template literals, skip nested ${...}
                if (quote === '`' && expr[j] === '$' && expr[j + 1] === '{') {
                    j += 2;
                    let tDepth = 1;
                    while (j < expr.length && tDepth > 0) {
                        if (expr[j] === '{') tDepth++;
                        else if (expr[j] === '}') tDepth--;
                        j++;
                    }
                    continue;
                }
                j++;
            }
            skipRegions.push({ start: strStart, end: j });
        } else {
            j++;
        }
    }

    let result = expr;

    for (const [varName, path] of fixableMap) {
        // Match as standalone identifier (not property access like obj.varName)
        // Uses negative lookbehind for . and - (hyphenated class names)
        // Uses negative lookahead for - and : (object literal key)
        const pattern = new RegExp(`(?<![.\\-])\\b${varName}\\b(?![\\-]|\\s*:)`, 'g');

        // Replace only if match is NOT inside a skip region and NOT a declaration
        let lastIndex = 0;
        let newResult = '';
        let match;
        while ((match = pattern.exec(result)) !== null) {
            const matchStart = match.index;
            const matchEnd = match.index + match[0].length;

            // Check if this match is inside any skip region
            const insideSkipRegion = skipRegions.some(r => matchStart >= r.start && matchEnd <= r.end);

            // Check if this is a declaration (const/let/var varName = ...)
            // Also check for destructuring: const { a, b } = ... (any position in the pattern)
            const beforeMatch = result.slice(Math.max(0, matchStart - 100), matchStart);
            const isSimpleDecl = /\b(?:const|let|var)\s+$/.test(beforeMatch);
            // For destructuring, check if we're inside { } that follows const/let/var
            // Look for const/let/var { ... without a closing } before our position
            const isDestructuring = /\b(?:const|let|var)\s*\{(?:[^{}])*$/.test(beforeMatch);
            const isDeclaration = isSimpleDecl || isDestructuring;

            newResult += result.slice(lastIndex, matchStart);
            if (insideSkipRegion || isDeclaration) {
                newResult += match[0];  // Keep original
            } else {
                newResult += path;  // Replace
            }
            lastIndex = matchEnd;
        }
        newResult += result.slice(lastIndex);
        result = newResult || result;
    }

    return result;
}

// =============================================================================
// Simple Early Dereference Detection (for opt() runtime - just detect, don't fix)
// =============================================================================

/**
 * Quick check if source has any early dereference patterns.
 * Used by opt() to decide whether to skip transformation entirely.
 */
function hasEarlyDereferences(source) {
    // Quick regex test - if no matches, definitely no early dereference
    return /\b(?:const|let|var)\s+(?:\w+|\{[^}]+\})\s*=\s*this\.(?:state|stores)/.test(source);
}

/**
 * Lint a source file for early dereference issues.
 *
 * Returns two types of issues:
 * 1. Fixable (warning): Variables in deferred callbacks that optimizer will fix
 * 2. Unfixable (error): Computed expressions that optimizer cannot fix
 *
 * Also detects eval(opt()) which runs at runtime.
 */
function lintEarlyDereferences(source, filename = '') {
    const issues = [];
    const { fixable, unfixable } = detectEarlyDereferences(source);

    if (fixable.size === 0 && unfixable.size === 0) {
        return issues;
    }

    // Build patterns for all early-dereferenced variables (both fixable and unfixable)
    // Pattern excludes: property access (.error), hyphenated names (error-message, my-error)
    // Also track defRegion info to determine if usage is in same callback (fine) or nested (problematic)
    const varPatterns = new Map();
    for (const [varName, pathOrInfo] of fixable) {
        // pathOrInfo can be a string (template-level) or object with path and region info (inside callback)
        const isObj = typeof pathOrInfo === 'object';
        varPatterns.set(varName, {
            pattern: new RegExp(`(?<![.\\-])\\b${varName}\\b(?![\\-]|\\s*:)`, 'g'),
            path: isObj ? pathOrInfo.path : pathOrInfo,
            fixable: true,
            defRegionStart: isObj ? pathOrInfo.defRegionStart : undefined,
            defRegionEnd: isObj ? pathOrInfo.defRegionEnd : undefined
        });
    }
    for (const [varName, info] of unfixable) {
        varPatterns.set(varName, {
            pattern: new RegExp(`(?<![.\\-])\\b${varName}\\b(?![\\-]|\\s*:)`, 'g'),
            path: info.path,
            fixable: false,
            reason: info.reason,
            defRegionStart: info.defRegionStart,
            defRegionEnd: info.defRegionEnd
        });
    }

    // Check 1: Find eval(opt()) blocks and check for early derefs inside
    const evalOptPattern = /eval\s*\(\s*opt\s*\(/g;
    let match;
    while ((match = evalOptPattern.exec(source)) !== null) {
        const startPos = match.index;
        // Find the matching closing ))
        let depth = 2;  // After eval(opt(
        let i = match.index + match[0].length;
        while (i < source.length && depth > 0) {
            if (source[i] === '(') depth++;
            else if (source[i] === ')') depth--;
            i++;
        }
        const evalOptContent = source.slice(startPos, i);

        for (const [varName, info] of varPatterns) {
            if (info.pattern.test(evalOptContent)) {
                const beforeMatch = source.slice(0, startPos);
                const lineNumber = (beforeMatch.match(/\n/g) || []).length + 1;
                issues.push({
                    line: lineNumber,
                    variable: varName,
                    path: info.path,
                    fixable: false,  // eval(opt()) is always unfixable (runtime)
                    message: `eval(opt()) uses early-dereferenced '${varName}' - opt() runs at runtime, optimizer can't fix`
                });
            }
        }
    }

    // Check 2: Find deferred callbacks (when/each/contain with arrow/function callbacks)
    // These create reactive boundaries where captured variables lose reactivity
    // IMPORTANT: Only check INSIDE the callback body, not the array/condition arguments
    //
    // Collect callback regions first, then check if early-dereferenced variables are used in them
    const callbackRegions = [];
    const deferredPattern = /\b(when|each|memoEach|contain)\s*\(/g;
    while ((match = deferredPattern.exec(source)) !== null) {
        const helperName = match[1];
        const callStart = match.index;

        // Parse to find arguments, tracking where each starts
        // Track all bracket types to avoid false comma detection
        let i = match.index + match[0].length;
        let depth = 1;
        let bracketDepth = 0;
        let braceDepth = 0;
        const argStarts = [i];  // Track start of each argument

        while (i < source.length && depth > 0) {
            const ch = source[i];

            // Skip strings
            if (ch === '"' || ch === "'" || ch === '`') {
                const quote = ch;
                i++;
                while (i < source.length) {
                    if (source[i] === '\\') { i += 2; continue; }
                    if (source[i] === quote) { i++; break; }
                    if (quote === '`' && source[i] === '$' && source[i+1] === '{') {
                        i += 2;
                        let tDepth = 1;
                        while (i < source.length && tDepth > 0) {
                            if (source[i] === '{') tDepth++;
                            else if (source[i] === '}') tDepth--;
                            i++;
                        }
                        continue;
                    }
                    i++;
                }
                continue;
            }

            if (ch === '(') { depth++; i++; continue; }
            if (ch === ')') { depth--; i++; continue; }
            if (ch === '[') { bracketDepth++; i++; continue; }
            if (ch === ']') { bracketDepth--; i++; continue; }
            if (ch === '{') { braceDepth++; i++; continue; }
            if (ch === '}') { braceDepth--; i++; continue; }
            if (ch === ',' && depth === 1 && bracketDepth === 0 && braceDepth === 0) {
                argStarts.push(i + 1);  // Next arg starts after comma
            }
            i++;
        }

        const callEnd = i;

        // Determine which argument contains the callback
        // Only contain() creates boundaries now - when/each/memoEach no longer do by default
        // The optimizer wraps when/each in contain(), so their callbacks don't need checking
        // contain(callback) - arg 0
        let callbackArgIndices;
        if (helperName === 'contain') {
            callbackArgIndices = [0];
        } else {
            // Skip when, each, memoEach - they no longer create boundaries by default
            // and the optimizer wraps the WHOLE expression in contain()
            continue;
        }

        // Find callback function bodies and record their regions
        for (const argIdx of callbackArgIndices) {
            if (argIdx >= argStarts.length) continue;

            const argStart = argStarts[argIdx];
            const argEnd = argIdx + 1 < argStarts.length
                ? argStarts[argIdx + 1] - 1  // Before the comma
                : callEnd - 1;  // Before closing paren

            const argContent = source.slice(argStart, argEnd);
            const trimmedArg = argContent.trim();

            let bodyStart = null;

            // Arrow function at start: () => body or () => { body }
            // Include optional { to match detectNestedCallbackDereferences positioning
            const arrowMatch = trimmedArg.match(/^(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>\s*\{?/);
            if (arrowMatch) {
                const bodyOffset = argStart + argContent.indexOf(trimmedArg) + arrowMatch[0].length;
                bodyStart = bodyOffset;
            }

            // Function expression at start: function(...) { body }
            const funcMatch = trimmedArg.match(/^function\s*\([^)]*\)\s*\{/);
            if (funcMatch) {
                const bodyOffset = argStart + argContent.indexOf(trimmedArg) + funcMatch[0].length;
                bodyStart = bodyOffset;
            }

            if (bodyStart !== null) {
                callbackRegions.push({
                    start: bodyStart,
                    end: argEnd,
                    helperName,
                    callStart  // For line number calculation
                });
            }
        }
    }

    // Now check if early-dereferenced variables are used inside callback regions
    // Only flag if there's a contain() BOUNDARY between definition and usage:
    // - Template-level def (defRegionStart undefined): any contain() usage has a boundary
    // - Def inside callback: only flag if usage is in a DIFFERENT contain() callback
    for (const [varName, info] of varPatterns) {
        let varMatch;
        while ((varMatch = info.pattern.exec(source)) !== null) {
            const matchStart = varMatch.index;
            const matchEnd = varMatch.index + varMatch[0].length;

            // Check if this match is inside a callback region
            // Find the INNERMOST region (smallest range) that contains the match
            // This handles nested callbacks correctly
            const matchingRegions = callbackRegions.filter(r => matchStart >= r.start && matchEnd <= r.end);
            const region = matchingRegions.length > 0
                ? matchingRegions.reduce((a, b) => (b.end - b.start) < (a.end - a.start) ? b : a)
                : null;
            if (region) {
                // Check if def and usage are in the SAME callback
                // If defRegionStart === region.start, they're in the same callback body → FINE
                // If defRegionStart is undefined or different, there's a boundary → BAD
                const sameCallback = info.defRegionStart !== undefined && info.defRegionStart === region.start;
                if (sameCallback) {
                    // Variable defined and used in same contain() callback - this is fine
                    // because the callback re-runs and re-captures the value
                    continue;
                }

                const beforeMatch = source.slice(0, region.callStart);
                const lineNumber = (beforeMatch.match(/\n/g) || []).length + 1;

                if (info.fixable) {
                    issues.push({
                        line: lineNumber,
                        variable: varName,
                        path: info.path,
                        fixable: true,
                        message: `${region.helperName}() callback captures early-dereferenced '${varName}' - callback creates reactive boundary`
                    });
                } else {
                    issues.push({
                        line: lineNumber,
                        variable: varName,
                        path: info.path,
                        fixable: false,
                        message: `${region.helperName}() callback captures '${varName}' (${info.reason}) - UNFIXABLE`
                    });
                }
            }
        }
        // Reset regex lastIndex for next variable
        info.pattern.lastIndex = 0;
    }

    // Deduplicate issues (same variable/line)
    const seen = new Set();
    return issues.filter(issue => {
        const key = `${issue.line}:${issue.variable}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Lint for stale argument patterns only (issues that break AFTER optimization).
 * Used in --strict mode to check if code is ready for optimization.
 */
function lintStaleArgumentPatterns(source, filename = '') {
    const issues = [];
    const { taintedArgs } = detectStaleArgumentPatterns(source);

    for (const [key, info] of taintedArgs) {
        issues.push({
            line: info.line,
            variable: info.variable,
            path: info.expression,
            fixable: false,
            message: `${info.helper}() receives computed '${info.variable}' - will be stale after contain() optimization`
        });
    }

    return issues;
}

/**
 * Check if an expression will be modified (either wrapped or fixed).
 */
function willBeModified(exprText, varToPath) {
    // Will be wrapped if not skipped
    if (!shouldSkipWrapping(exprText)) {
        return true;
    }
    // Will be fixed if contains any early-dereferenced variable
    for (const varName of varToPath.keys()) {
        // Check if variable appears as standalone identifier (not in strings)
        const pattern = new RegExp(`(?<![.\\-])\\b${varName}\\b(?![\\-]|\\s*:)`);
        if (pattern.test(exprText)) {
            return true;
        }
    }
    return false;
}

/**
 * Apply transformations to a single pass of expressions.
 * Returns the transformed source and count of changes.
 */
function applyOptPass(source, varToPath) {
    // Normalize varToPath - values can be strings or objects with {path, defRegionStart, defRegionEnd}
    // fixTaintedReferences expects string values, so extract just the paths
    const normalizedVarToPath = new Map();
    for (const [varName, pathOrInfo] of varToPath) {
        const path = typeof pathOrInfo === 'string' ? pathOrInfo : pathOrInfo.path;
        normalizedVarToPath.set(varName, path);
    }

    const allExpressions = extractExpressions(source);

    // Categorize expressions:
    // - Wrappable: will be wrapped in contain()
    // - Skipped: each/when/etc that won't be wrapped but may have fixes
    // - Nested in wrappable: inside an expression that will be wrapped (defer)
    const wrappable = [];
    const skippedWithNestedProcessing = [];
    const skippedNoNested = [];

    for (const expr of allExpressions) {
        const willBeSkipped = shouldSkipWrapping(expr.expr);

        // Check if this expression CONTAINS nested expressions that will be MODIFIED
        // (wrapped OR fixed - either causes position shifts)
        // If so, we must defer this expression until the nested ones are processed,
        // otherwise our end position will be stale after they're modified.
        const containsModifiableNested = allExpressions.some(other =>
            expr !== other &&
            other.start > expr.start &&
            other.end < expr.end &&
            willBeModified(other.expr, normalizedVarToPath)
        );

        if (containsModifiableNested) {
            // Defer to next pass - nested expressions must be processed first
            skippedWithNestedProcessing.push(expr);
        } else if (willBeSkipped) {
            skippedNoNested.push(expr);  // Process now (apply fixes, no wrapping)
        } else {
            wrappable.push(expr);  // Process now (apply fixes and wrapping)
        }
    }

    // Process: wrappable + skipped-no-nested this pass
    // Defer: skipped-with-nested to next pass (after nested are processed)
    const toProcess = [...wrappable, ...skippedNoNested].sort((a, b) => a.start - b.start);

    let result = source;
    let fixedCount = 0;

    // Build new source, replacing from end to start
    for (let i = toProcess.length - 1; i >= 0; i--) {
        const { start, end, expr } = toProcess[i];

        // Always fix early dereferences by replacing variables with reactive paths
        const fixedExpr = fixTaintedReferences(expr, normalizedVarToPath);
        if (fixedExpr !== expr) {
            fixedCount++;
        }

        // Skip contain() wrapping for certain patterns, but still apply the fix
        if (shouldSkipWrapping(expr)) {
            if (fixedExpr !== expr) {
                result = result.slice(0, start) + '${' + fixedExpr + '}' + result.slice(end);
            }
            continue;
        }

        const wrapped = '${html.contain(() => (' + fixedExpr + '))}';
        result = result.slice(0, start) + wrapped + result.slice(end);
    }

    return { code: result, fixedCount };
}

function applyOptTransformations(source, filename = '', verbose = false) {
    const { fixable, unfixable } = detectEarlyDereferences(source);

    // Check for stale argument patterns - warn but continue optimization
    // The when/each/memoEach helper calls are already skipped from contain() wrapping
    // by shouldSkipWrapping(), so we can safely optimize other expressions
    const { taintedArgs } = detectStaleArgumentPatterns(source);
    if (taintedArgs.size > 0 && verbose) {
        const filePrefix = filename ? `[${filename}] ` : '';
        console.log(`${filePrefix}Note: Found stale argument pattern(s) (skipped from wrapping):`);
        for (const [, info] of taintedArgs) {
            console.log(`  - ${info.helper}(${info.variable}) at line ${info.line}`);
        }
    }

    let totalFixed = 0;
    let result = source;

    // Apply passes until no more changes (handles nested templates)
    // Max 10 passes to prevent infinite loops
    for (let pass = 0; pass < 10; pass++) {
        const { code, fixedCount } = applyOptPass(result, fixable);
        if (code === result) break;  // No changes, done
        result = code;
        totalFixed += fixedCount;
    }

    // Report fixes in verbose mode
    if (totalFixed > 0 && verbose) {
        const filePrefix = filename ? `[${filename}] ` : '';
        console.log(`${filePrefix}Fixed ${totalFixed} early dereference(s)`);
    }

    return {
        code: result,
        fixedCount: totalFixed,
        unfixableCount: unfixable.size
    };
}

// =============================================================================
// eval(opt()) Stripping
// =============================================================================

/**
 * Skip over a template literal starting at position i (pointing at opening backtick).
 * Returns the position after the closing backtick.
 */
function skipTemplateLiteral(source, i) {
    i++; // Skip opening backtick
    while (i < source.length && source[i] !== '`') {
        // Handle escape sequences
        if (source[i] === '\\') {
            i += 2;
            continue;
        }
        // Handle ${} expressions
        if (source[i] === '$' && source[i + 1] === '{') {
            i = skipTemplateExpression(source, i + 2);
            continue;
        }
        i++;
    }
    return i + 1; // Skip closing backtick
}

/**
 * Skip over a ${} expression starting at position i (pointing just after ${).
 * Returns the position after the closing }.
 */
function skipTemplateExpression(source, i) {
    let depth = 1;
    while (i < source.length && depth > 0) {
        const ch = source[i];

        // Handle braces
        if (ch === '{') { depth++; i++; continue; }
        if (ch === '}') { depth--; i++; continue; }

        // Handle line comments (// ...)
        if (ch === '/' && source[i + 1] === '/') {
            i += 2;
            while (i < source.length && source[i] !== '\n') i++;
            i++; // Skip newline
            continue;
        }

        // Handle block comments (/* ... */)
        if (ch === '/' && source[i + 1] === '*') {
            i += 2;
            while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
            i += 2; // Skip */
            continue;
        }

        // Handle strings
        if (ch === '"' || ch === "'") {
            const quote = ch;
            i++;
            while (i < source.length && source[i] !== quote) {
                if (source[i] === '\\') i++;
                i++;
            }
            i++; // Skip closing quote
            continue;
        }

        // Handle template literals (recursive)
        if (ch === '`') {
            i = skipTemplateLiteral(source, i);
            continue;
        }

        i++;
    }
    return i;
}

/**
 * Strip eval(opt()) wrappers from source.
 * Finds patterns like:
 *   template: eval(opt(function() { ... }))
 *   template: eval(opt(() => html`...`))
 *
 * Replaces with the inner function, optionally applying transformations.
 */
function stripEvalOptCalls(source, applyTransformations = false) {
    let result = source;

    // Pattern: eval(opt(...))
    // We need to find eval(opt( and then match the closing ))
    const evalOptStart = /eval\s*\(\s*opt\s*\(/g;

    let match;
    const replacements = [];

    while ((match = evalOptStart.exec(result)) !== null) {
        const startPos = match.index;
        const afterEvalOpt = match.index + match[0].length;

        // Parse the function argument to opt()
        let depth = 1;  // We're after opt(, so depth starts at 1
        let i = afterEvalOpt;
        let inString = false;
        let stringChar = null;

        while (i < result.length && depth > 0) {
            const ch = result[i];

            // Handle strings
            if (!inString && (ch === '"' || ch === "'")) {
                inString = true;
                stringChar = ch;
                i++;
                continue;
            }
            if (inString && ch === stringChar && result[i - 1] !== '\\') {
                inString = false;
                stringChar = null;
                i++;
                continue;
            }
            if (inString) {
                i++;
                continue;
            }

            // Handle template literals (use recursive helpers)
            if (ch === '`') {
                i = skipTemplateLiteral(result, i);
                continue;
            }

            // Handle parens (only when not in template - but templates are now skipped entirely)
            if (ch === '(') {
                depth++;
                i++;
                continue;
            }
            if (ch === ')') {
                depth--;
                i++;
                continue;
            }

            i++;
        }

        // After the loop: i points at the closing ) of eval
        // The function is between afterEvalOpt and (i - 1) - just before opt's closing )
        const innerFn = result.slice(afterEvalOpt, i - 1);

        // Convert arrow to regular function if needed
        let transformedFn = convertArrowToFunction(innerFn.trim());

        // Apply opt transformations if requested
        if (applyTransformations) {
            transformedFn = applyOptTransformations(transformedFn).code;
        }

        replacements.push({
            start: startPos,
            end: i + 1,  // Include both closing parens ))
            replacement: transformedFn
        });
    }

    // Apply replacements from end to start
    for (let i = replacements.length - 1; i >= 0; i--) {
        const { start, end, replacement } = replacements[i];
        result = result.slice(0, start) + replacement + result.slice(end);
    }

    return result;
}

/**
 * Convert arrow functions to regular functions for proper `this` binding.
 */
function convertArrowToFunction(source) {
    const trimmed = source.trim();

    // () => { body }  ->  function() { body }
    if (/^\(\s*\)\s*=>\s*\{/.test(trimmed)) {
        return trimmed.replace(/^\(\s*\)\s*=>\s*\{/, 'function() {');
    }

    // () => expr  ->  function() { return expr; }
    if (/^\(\s*\)\s*=>\s*/.test(trimmed)) {
        const expr = trimmed.replace(/^\(\s*\)\s*=>\s*/, '');
        return 'function() { return ' + expr + '; }';
    }

    return source;
}

// =============================================================================
// Minification (ported from bundler-esm.js)
// =============================================================================

const VLQ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function vlqEncode(value) {
    let encoded = '';
    let vlq = value < 0 ? ((-value) << 1) | 1 : value << 1;

    do {
        let digit = vlq & 0x1f;
        vlq >>>= 5;
        if (vlq > 0) digit |= 0x20;
        encoded += VLQ_CHARS[digit];
    } while (vlq > 0);

    return encoded;
}

/**
 * Minify CSS by removing comments, collapsing whitespace, and removing unnecessary chars.
 */
function minifyCSS(css) {
    let result = css;

    // Remove CSS comments /* ... */
    result = result.replace(/\/\*[\s\S]*?\*\//g, '');

    // Collapse whitespace around special chars
    result = result.replace(/\s*([{};:,>+~])\s*/g, '$1');

    // Collapse multiple whitespace to single space
    result = result.replace(/\s+/g, ' ');

    // Remove space after opening brace and before closing brace
    result = result.replace(/\{\s+/g, '{');
    result = result.replace(/\s+\}/g, '}');

    // Remove trailing semicolons before closing braces
    result = result.replace(/;}/g, '}');

    // Remove leading/trailing whitespace
    result = result.trim();

    return result;
}

/**
 * Minify HTML template content for html`` templates.
 * - Removes HTML comments (<!-- ... -->)
 * - Removes whitespace between tags
 * - Squashes whitespace within tags to single space
 * - Preserves whitespace in <pre>, <code>, <script>, <style>, <textarea> tags
 */
function minifyHTMLTemplate(html) {
    // Tags where whitespace must be preserved
    const preserveTags = ['pre', 'code', 'script', 'style', 'textarea'];
    const preserved = [];
    let result = html;

    // Extract and preserve content from special tags
    for (const tag of preserveTags) {
        const regex = new RegExp(`(<${tag}[^>]*>)([\\s\\S]*?)(</${tag}>)`, 'gi');
        result = result.replace(regex, (match, open, content, close) => {
            const placeholder = `__PRESERVE_${preserved.length}__`;
            preserved.push(match);
            return placeholder;
        });
    }

    // Remove HTML comments (<!-- ... -->)
    result = result.replace(/<!--[\s\S]*?-->/g, '');

    // Collapse whitespace: multiple spaces/newlines -> single space
    result = result.replace(/\s+/g, ' ');

    // Remove space between tags: >   < becomes ><
    result = result.replace(/>\s+</g, '><');

    // Remove space between tag and expression: >   ${ becomes >${
    result = result.replace(/>\s+\$/g, '>$');

    // Remove space between expression and tag: }   < becomes }<
    result = result.replace(/\}\s+</g, '}<');

    // Remove space between adjacent expressions: }   ${ becomes }${
    result = result.replace(/\}\s+\$/g, '}$');

    // NOTE: Do NOT trim leading/trailing whitespace here - it may be significant
    // when the text part is inside an attribute value with expressions
    // e.g., class="tab ${condition}" needs the space before ${

    // Squash whitespace within opening tags (between attributes)
    // <div   class="foo"   id="bar"> becomes <div class="foo" id="bar">
    // But be careful to preserve quoted attribute values
    result = result.replace(/<([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)\s*>/g, (match, tag, attrs) => {
        if (!attrs) return `<${tag}>`;
        // Squash whitespace between attributes to single space
        const squashedAttrs = attrs.replace(/\s+/g, ' ').trim();
        return `<${tag}${squashedAttrs ? ' ' + squashedAttrs : ''}>`;
    });

    // Restore preserved content (use function to avoid $-pattern issues)
    for (let i = 0; i < preserved.length; i++) {
        result = result.replace(`__PRESERVE_${i}__`, () => preserved[i]);
    }

    return result;
}

/**
 * Minify a standalone HTML file.
 * Minifies inline <style> and <script> content, and collapses HTML whitespace.
 */
function minifyHTMLFile(html) {
    let result = html;

    // Minify inline <style> content
    result = result.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (match, open, css, close) => {
        return open + minifyCSS(css) + close;
    });

    // Minify inline <script> content (but not type="module" imports or complex scripts)
    result = result.replace(/(<script[^>]*>)([\s\S]*?)(<\/script>)/gi, (match, open, js, close) => {
        // Skip empty scripts or scripts with src attribute
        if (!js.trim() || /\bsrc\s*=/.test(open)) {
            return match;
        }
        // Use the JS minifier for inline scripts
        try {
            // First minify embedded CSS and HTML templates inside the script
            let minifiedJs = minifyEmbeddedContent(js);
            // Then minify the JS code itself
            const minified = minifyCode(minifiedJs);
            return open + minified.code + close;
        } catch (e) {
            return match;  // Keep original on error
        }
    });

    // Collapse whitespace in HTML (but preserve <pre>, <code>, etc.)
    const preserveTags = ['pre', 'code', 'textarea', 'script', 'style'];
    const preserved = [];

    for (const tag of preserveTags) {
        const regex = new RegExp(`(<${tag}[^>]*>[\\s\\S]*?</${tag}>)`, 'gi');
        result = result.replace(regex, (match) => {
            const placeholder = `__HTML_PRESERVE_${preserved.length}__`;
            preserved.push(match);
            return placeholder;
        });
    }

    // Remove HTML comments (<!-- ... -->)
    result = result.replace(/<!--[\s\S]*?-->/g, '');

    // Collapse whitespace
    result = result.replace(/\s+/g, ' ');
    result = result.replace(/>\s+</g, '><');

    // Restore preserved content
    // Use function replacer to avoid special $-pattern interpretation
    for (let i = 0; i < preserved.length; i++) {
        result = result.replace(`__HTML_PRESERVE_${i}__`, () => preserved[i]);
    }

    return result;
}

/**
 * Minify a standalone CSS file.
 */
function minifyCSSFile(css) {
    return minifyCSS(css);
}

/**
 * Minify embedded CSS and HTML within JavaScript code.
 * Finds styles: `...` blocks and html`...` templates and minifies their content.
 */
function minifyEmbeddedContent(code) {
    let result = code;

    // Minify styles: /*css*/`...` or styles: `...` blocks
    // Match: styles: followed by optional /*css*/ and then a template literal
    result = result.replace(
        /(styles\s*:\s*(?:\/\*\s*css\s*\*\/)?\s*`)([^`]*?)(`)/g,
        (match, prefix, css, suffix) => {
            return prefix + minifyCSS(css) + suffix;
        }
    );

    // Minify html`...` templates (but preserve ${...} expressions and their content)
    // Process templates from end to start so nested templates are handled first
    // Track skipped positions (templates that couldn't be parsed, likely nested)
    const skippedPositions = new Set();
    let lastProcessedEnd = result.length;

    while (true) {
        // Find the LAST html`` template before lastProcessedEnd
        let startIdx = -1;

        for (let j = lastProcessedEnd - 1; j >= 4; j--) {
            if (result.slice(j, j + 5) === 'html`' && !skippedPositions.has(j)) {
                startIdx = j;
                break;
            }
        }

        if (startIdx === -1) break;
        const templateStart = startIdx + 5;  // After 'html`'

        // Find the end of this template, handling nested ${...} and strings
        let i = templateStart;
        let parts = [];  // Array of { type: 'text'|'expr', content: string }
        let currentText = '';

        while (i < result.length) {
            const ch = result[i];

            if (ch === '\\' && i + 1 < result.length) {
                currentText += ch + result[i + 1];
                i += 2;
                continue;
            }

            if (ch === '$' && result[i + 1] === '{') {
                // Start of expression
                if (currentText) {
                    parts.push({ type: 'text', content: currentText });
                    currentText = '';
                }

                // Find matching closing brace, handling nested braces, strings, and templates
                let exprStart = i;
                i += 2;
                let braceDepth = 1;
                let inString = false;
                let stringChar = '';
                // Track template depths: each entry is the braceDepth when template started
                const templateStack = [];

                while (i < result.length && braceDepth > 0) {
                    const c = result[i];
                    const inTemplate = templateStack.length > 0;

                    // Handle escape in strings/templates
                    if ((inString || inTemplate) && c === '\\' && i + 1 < result.length) {
                        i += 2;
                        continue;
                    }

                    // Handle strings (only when not in template)
                    if (!inString && !inTemplate && (c === '"' || c === "'")) {
                        inString = true;
                        stringChar = c;
                        i++;
                        continue;
                    }
                    if (inString && c === stringChar) {
                        inString = false;
                        i++;
                        continue;
                    }

                    // Handle template literals
                    if (!inString && c === '`') {
                        if (inTemplate && braceDepth === templateStack[templateStack.length - 1]) {
                            // Closing current template - we're at same brace depth as when it opened
                            templateStack.pop();
                        } else {
                            // Opening a new template
                            templateStack.push(braceDepth);
                        }
                        i++;
                        continue;
                    }

                    // Handle ${} in template literals
                    if (inTemplate && c === '$' && result[i + 1] === '{') {
                        braceDepth++;
                        i += 2;
                        continue;
                    }

                    // Handle braces outside templates
                    if (!inString && !inTemplate) {
                        if (c === '{') braceDepth++;
                        else if (c === '}') braceDepth--;
                    }
                    // Handle closing brace inside template's expression
                    if (inTemplate && c === '}' && braceDepth > templateStack[templateStack.length - 1]) {
                        braceDepth--;
                    }
                    i++;
                }
                parts.push({ type: 'expr', content: result.slice(exprStart, i) });
                continue;
            }

            if (ch === '`') {
                // End of template
                if (currentText) {
                    parts.push({ type: 'text', content: currentText });
                }

                // Minify text parts, trimming only start of first and end of last
                const minifiedParts = parts.map((part, idx) => {
                    if (part.type === 'text') {
                        let minified = minifyHTMLTemplate(part.content);
                        // Trim leading whitespace from first part
                        if (idx === 0) {
                            minified = minified.trimStart();
                        }
                        // Trim trailing whitespace from last part
                        if (idx === parts.length - 1) {
                            minified = minified.trimEnd();
                        }
                        return minified;
                    }
                    return part.content;
                });

                const minifiedTemplate = 'html`' + minifiedParts.join('') + '`';
                result = result.slice(0, startIdx) + minifiedTemplate + result.slice(i + 1);
                // Continue searching before this template (don't restart from end)
                lastProcessedEnd = startIdx;
                break;
            }

            currentText += ch;
            i++;
        }

        // If we exited the while loop without finding a closing backtick,
        // this template couldn't be parsed (likely a nested template that
        // was already processed as part of an expression). Skip it.
        if (i >= result.length) {
            skippedPositions.add(startIdx);
            lastProcessedEnd = startIdx;
        }
    }

    return result;
}

/**
 * Minify code and optionally generate source map.
 */
function minifyCode(code, generateMap = false, filename = 'source.js') {
    let result = '';
    let i = 0;
    const len = code.length;
    let lastChar = '';

    // Source map tracking
    let srcLine = 0, srcCol = 0;
    let outLine = 0, outCol = 0;
    let prevSrcLine = 0, prevSrcCol = 0, prevOutCol = 0;
    let prevNameIdx = 0;
    const mappings = [];
    let currentLineMappings = [];

    // Names array for source map (identifier names)
    const namesArray = [];
    const nameToIndex = new Map();

    function getNameIndex(name) {
        if (nameToIndex.has(name)) {
            return nameToIndex.get(name);
        }
        const idx = namesArray.length;
        namesArray.push(name);
        nameToIndex.set(name, idx);
        return idx;
    }

    function addMapping(name = null) {
        if (!generateMap) return;

        // Build VLQ mapping - 4 segments without name, 5 segments with name
        let mapping = vlqEncode(outCol - prevOutCol) +
            vlqEncode(0) +  // source index always 0
            vlqEncode(srcLine - prevSrcLine) +
            vlqEncode(srcCol - prevSrcCol);

        // Add 5th segment for identifier name
        if (name !== null) {
            const nameIdx = getNameIndex(name);
            mapping += vlqEncode(nameIdx - prevNameIdx);
            prevNameIdx = nameIdx;
        }

        currentLineMappings.push(mapping);
        prevOutCol = outCol;
        prevSrcLine = srcLine;
        prevSrcCol = srcCol;
    }

    function emit(char) {
        result += char;
        if (char === '\n') {
            outLine++;
            outCol = 0;
            prevOutCol = 0;
            if (generateMap) {
                mappings.push(currentLineMappings.join(','));
                currentLineMappings = [];
            }
        } else {
            outCol++;
        }
    }

    function advance() {
        if (code[i] === '\n') {
            srcLine++;
            srcCol = 0;
        } else {
            srcCol++;
        }
        i++;
    }

    addMapping();

    while (i < len) {
        const char = code[i];

        // Skip single-line comments
        if (char === '/' && code[i + 1] === '/') {
            while (i < len && code[i] !== '\n') advance();
            if (i < len) advance();
            continue;
        }

        // Skip multi-line comments (keep license /*!)
        if (char === '/' && code[i + 1] === '*') {
            const isLicense = code[i + 2] === '!';
            if (isLicense) {
                addMapping();
                while (i < len && !(code[i] === '*' && code[i + 1] === '/')) {
                    emit(code[i]);
                    advance();
                }
                if (i < len) {
                    emit('*'); advance();
                    emit('/'); advance();
                }
                emit('\n');
            } else {
                advance(); advance();
                while (i < len && !(code[i] === '*' && code[i + 1] === '/')) advance();
                if (i < len) { advance(); advance(); }
            }
            continue;
        }

        // Handle regex literals
        if (char === '/') {
            let j = result.length - 1;
            while (j >= 0 && /\s/.test(result[j])) j--;
            const prevResultChar = j >= 0 ? result[j] : '';
            const isLikelyRegex = j < 0 ||
                '=([{,;!&|?:\n'.includes(prevResultChar) ||
                result.substring(Math.max(0, j - 5), j + 1).match(/return$/);

            if (isLikelyRegex && code[i + 1] !== '/' && code[i + 1] !== '*') {
                addMapping();
                emit(char);
                advance();
                while (i < len) {
                    if (code[i] === '\\' && i + 1 < len) {
                        emit(code[i]); advance();
                        emit(code[i]); advance();
                    } else if (code[i] === '[') {
                        emit(code[i]); advance();
                        while (i < len && code[i] !== ']') {
                            if (code[i] === '\\' && i + 1 < len) {
                                emit(code[i]); advance();
                                emit(code[i]); advance();
                            } else {
                                emit(code[i]); advance();
                            }
                        }
                        if (i < len) { emit(code[i]); advance(); }
                    } else if (code[i] === '/') {
                        emit(code[i]); advance();
                        while (i < len && /[gimsuvy]/.test(code[i])) {
                            emit(code[i]); advance();
                        }
                        break;
                    } else {
                        emit(code[i]); advance();
                    }
                }
                lastChar = '/';
                continue;
            }
        }

        // Preserve string literals (with whitespace collapsing for html``)
        if (char === '"' || char === "'" || char === '`') {
            addMapping();
            emit(char);
            advance();
            const quote = char;

            // Check if this is an html`` template (look back for "html")
            const isHtmlTemplate = quote === '`' &&
                result.length >= 4 &&
                result.slice(-5, -1) === 'html';

            while (i < len) {
                if (code[i] === '\\' && i + 1 < len) {
                    emit(code[i]); advance();
                    emit(code[i]); advance();
                    continue;
                }
                if (code[i] === quote && quote !== '`') {
                    emit(code[i]); advance();
                    break;
                }

                // Collapse whitespace in html`` templates (static parts only)
                if (isHtmlTemplate && /\s/.test(code[i])) {
                    // Skip all consecutive whitespace, emit single space
                    addMapping();
                    while (i < len && /\s/.test(code[i]) && code[i] !== '`') {
                        // Stop at ${
                        if (code[i] === '$' && code[i + 1] === '{') break;
                        advance();
                    }
                    // Only emit space if not at end of template or before ${
                    if (i < len && code[i] !== '`') {
                        emit(' ');
                    }
                    continue;
                }

                if (quote === '`' && code[i] === '$' && code[i + 1] === '{') {
                    // Use helper functions for recursive template/expression parsing
                    // These handle arbitrary nesting depth correctly

                    // Skip a string literal, emitting all content
                    const skipString = (q) => {
                        emit(code[i]); advance(); // opening quote
                        while (i < len) {
                            if (code[i] === '\\' && i + 1 < len) {
                                emit(code[i]); advance();
                                emit(code[i]); advance();
                            } else if (code[i] === q) {
                                emit(code[i]); advance();
                                break;
                            } else {
                                emit(code[i]); advance();
                            }
                        }
                    };

                    // Skip a template literal, emitting all content (recursive for ${})
                    // Also collapses whitespace if this is an html`` template
                    const skipTemplateLiteral = () => {
                        // Check if this is an html`` template
                        const isNestedHtml = result.length >= 4 && result.slice(-4) === 'html';

                        emit(code[i]); advance(); // opening backtick
                        while (i < len) {
                            if (code[i] === '\\' && i + 1 < len) {
                                emit(code[i]); advance();
                                emit(code[i]); advance();
                            } else if (code[i] === '$' && code[i + 1] === '{') {
                                emit(code[i]); advance(); // $
                                emit(code[i]); advance(); // {
                                skipExpression(); // recursive!
                            } else if (code[i] === '`') {
                                emit(code[i]); advance();
                                break;
                            } else if (isNestedHtml && /\s/.test(code[i])) {
                                // Collapse whitespace in nested html`` templates
                                addMapping();
                                while (i < len && /\s/.test(code[i]) && code[i] !== '`') {
                                    if (code[i] === '$' && code[i + 1] === '{') break;
                                    advance();
                                }
                                if (i < len && code[i] !== '`') {
                                    emit(' ');
                                }
                            } else {
                                emit(code[i]); advance();
                            }
                        }
                    };

                    // Skip an expression inside ${}, emitting content with minification
                    const skipExpression = () => {
                        let depth = 1;
                        let exprLast = '';
                        while (i < len && depth > 0) {
                            const c = code[i];

                            // Handle / - could be comment, regex, or division
                            if (c === '/') {
                                // Check for comments first
                                if (code[i + 1] === '/') {
                                    // Single-line comment - skip to newline
                                    while (i < len && code[i] !== '\n') advance();
                                    if (i < len) advance();
                                    continue;
                                }
                                if (code[i + 1] === '*') {
                                    // Block comment
                                    const isLicense = code[i + 2] === '!';
                                    if (isLicense) {
                                        while (i < len && !(code[i] === '*' && code[i + 1] === '/')) {
                                            emit(code[i]); advance();
                                        }
                                        if (i < len) { emit('*'); advance(); emit('/'); advance(); }
                                    } else {
                                        advance(); advance();
                                        while (i < len && !(code[i] === '*' && code[i + 1] === '/')) advance();
                                        if (i < len) { advance(); advance(); }
                                    }
                                    continue;
                                }
                                // Check if this is a regex literal (based on preceding token)
                                // Regex can follow: = ( , ; ! & | ? { } [ < > + - * % ^ ~ : return
                                const isLikelyRegex = /[=(:,;!&|?{}\[\]<>+\-*%^~:]/.test(exprLast) ||
                                    exprLast === '' || exprLast === ' ';
                                if (isLikelyRegex) {
                                    // Parse regex literal
                                    emit(code[i]); advance(); // opening /
                                    let inCharClass = false;
                                    while (i < len) {
                                        if (code[i] === '\\' && i + 1 < len) {
                                            // Escape sequence - emit both chars
                                            emit(code[i]); advance();
                                            emit(code[i]); advance();
                                        } else if (code[i] === '[' && !inCharClass) {
                                            inCharClass = true;
                                            emit(code[i]); advance();
                                        } else if (code[i] === ']' && inCharClass) {
                                            inCharClass = false;
                                            emit(code[i]); advance();
                                        } else if (code[i] === '/' && !inCharClass) {
                                            // End of regex
                                            emit(code[i]); advance();
                                            // Emit flags
                                            while (i < len && /[gimsuy]/.test(code[i])) {
                                                emit(code[i]); advance();
                                            }
                                            break;
                                        } else {
                                            emit(code[i]); advance();
                                        }
                                    }
                                    exprLast = '/';
                                    continue;
                                }
                                // Otherwise it's division - fall through to emit
                            }

                            // Skip strings
                            if (c === '"' || c === "'") {
                                skipString(c);
                                exprLast = c;
                                continue;
                            }

                            // Skip nested templates (recursive)
                            if (c === '`') {
                                skipTemplateLiteral();
                                exprLast = '`';
                                continue;
                            }

                            // Collapse whitespace
                            if (/\s/.test(c)) {
                                while (i < len && /\s/.test(code[i])) advance();
                                if (i < len && depth > 0) {
                                    const nextC = code[i];
                                    const needsSpace =
                                        (/[a-zA-Z0-9_$]/.test(exprLast) && /[a-zA-Z0-9_$]/.test(nextC)) ||
                                        (exprLast === ')' && /[a-zA-Z_$]/.test(nextC)) ||
                                        (/[a-zA-Z_$]/.test(exprLast) && nextC === '(');
                                    if (needsSpace) {
                                        emit(' ');
                                        exprLast = ' ';
                                    }
                                }
                                continue;
                            }

                            // Track braces
                            if (c === '{') depth++;
                            if (c === '}') depth--;

                            if (depth > 0) {
                                emit(c);
                                exprLast = c;
                            }
                            advance();
                        }
                        // Emit final closing brace
                        emit('}');
                    };

                    emit(code[i]); advance(); // $
                    emit(code[i]); advance(); // {
                    skipExpression();
                    continue;
                }
                if (quote === '`' && code[i] === '`') {
                    emit(code[i]); advance();
                    break;
                }
                emit(code[i]); advance();
            }
            lastChar = quote;
            continue;
        }

        // Collapse whitespace
        if (/\s/.test(char)) {
            while (i < len && /\s/.test(code[i])) advance();

            if (i < len) {
                const nextChar = code[i];
                // Check if result ends with 'import' or 'export' for special handling
                const endsWithImport = result.length >= 6 && result.slice(-6) === 'import';
                const endsWithExport = result.length >= 6 && result.slice(-6) === 'export';
                // Check if next 4 chars are 'from' (for import/export from syntax)
                const nextIsFrom = code.slice(i, i + 4) === 'from';
                // Check if result ends with 'from' (for space before quote)
                const endsWithFrom = result.length >= 4 && result.slice(-4) === 'from';
                const needsSpace =
                    (/[a-zA-Z0-9_$]/.test(lastChar) && /[a-zA-Z0-9_$]/.test(nextChar)) ||
                    (lastChar === ')' && /[a-zA-Z_$]/.test(nextChar)) ||
                    (/[a-zA-Z_$]/.test(lastChar) && nextChar === '(') ||
                    // Keep space before { and * after import/export (for regex-based parsers)
                    ((endsWithImport || endsWithExport) && (nextChar === '{' || nextChar === '*')) ||
                    // Keep space after import before quote (for bare imports: import './foo.js')
                    (endsWithImport && (nextChar === '"' || nextChar === "'")) ||
                    // Keep space before 'from' after } or * (for import/export from syntax)
                    ((lastChar === '}' || lastChar === '*') && nextIsFrom) ||
                    // Keep space after 'from' before quote (for import/export from syntax)
                    (endsWithFrom && (nextChar === '"' || nextChar === "'"));

                if (needsSpace) {
                    emit(' ');
                    lastChar = ' ';
                }
            }
            continue;
        }

        // Identifier - collect full identifier and add to names array
        if (/[a-zA-Z_$]/.test(char)) {
            // Read ahead to get full identifier
            let identifier = char;
            let j = i + 1;
            while (j < len && /[a-zA-Z0-9_$]/.test(code[j])) {
                identifier += code[j];
                j++;
            }

            // Add mapping with identifier name
            addMapping(identifier);

            // Emit all identifier characters
            for (const c of identifier) {
                emit(c);
                advance();
            }
            lastChar = identifier[identifier.length - 1];
            continue;
        }

        // Regular character (operators, punctuation, etc.)
        addMapping();
        emit(char);
        lastChar = char;
        advance();
    }

    if (generateMap && currentLineMappings.length > 0) {
        mappings.push(currentLineMappings.join(','));
    }

    const output = { code: result };

    if (generateMap) {
        output.map = {
            version: 3,
            sources: [filename],
            sourcesContent: [code],
            names: namesArray,
            mappings: mappings.join(';')
        };
    }

    return output;
}

// =============================================================================
// HTML File Processing
// =============================================================================

/**
 * Process HTML file - find and transform inline <script> tags.
 */
function processHtmlFile(content, options) {
    const scriptRegex = /<script([^>]*)>([\s\S]*?)<\/script>/gi;

    return content.replace(scriptRegex, (match, attrs, scriptContent) => {
        // Skip external scripts
        if (/src\s*=/.test(attrs)) {
            return match;
        }

        // Skip non-JS scripts
        if (/type\s*=\s*["'](?!text\/javascript|module)/.test(attrs)) {
            return match;
        }

        // Transform the script content
        let transformed = scriptContent;

        if (!options.wrappedOnly) {
            const result = applyOptTransformations(transformed, '', options.verbose);
            transformed = result.code;
        }
        transformed = stripEvalOptCalls(transformed, options.wrappedOnly);

        return `<script${attrs}>${transformed}</script>`;
    });
}

// =============================================================================
// File Processing
// =============================================================================

// Framework bundle files should never be optimized - they contain internal templates
const FRAMEWORK_BUNDLE_FILES = new Set(['framework.js', 'router.js', 'utils.js']);

/**
 * Process a single JavaScript file.
 */
function processJsFile(inputPath, outputPath, options) {
    let content = fs.readFileSync(inputPath, 'utf-8');
    const originalSize = content.length;
    const filename = path.basename(inputPath);
    let fixedCount = 0;

    // Extract shebang if present (e.g., #!/usr/bin/env node)
    let shebang = '';
    if (content.startsWith('#!')) {
        const newlineIdx = content.indexOf('\n');
        if (newlineIdx !== -1) {
            shebang = content.slice(0, newlineIdx + 1);
            content = content.slice(newlineIdx + 1);
        }
    }

    // Save original content for source map (before opt transformations)
    const originalContent = content;

    // Skip optimization for framework bundle files (they have internal templates that
    // were already optimized during bundling)
    const isFrameworkBundle = FRAMEWORK_BUNDLE_FILES.has(filename) &&
        (inputPath.includes('/lib/') || inputPath.includes('/dist/'));

    // Step 1: Apply opt() transformations to ALL html`` templates (unless --wrapped-only)
    let unfixableCount = 0;
    if (!options.wrappedOnly && !isFrameworkBundle) {
        const result = applyOptTransformations(content, filename, options.verbose);
        content = result.code;
        fixedCount = result.fixedCount;
        unfixableCount = result.unfixableCount || 0;
    }

    // Step 2: Strip eval(opt()) calls
    // If --wrapped-only, this also applies transformations to wrapped templates
    content = stripEvalOptCalls(content, options.wrappedOnly);

    // Step 3: Minify if requested (CSS/HTML embedded content + JS)
    let sourceMap = null;
    if (options.minify) {
        const filename = path.basename(inputPath);

        if (options.sourcemap) {
            // When generating source maps, skip embedded content minification
            // to ensure accurate position mapping to the original source.
            const minified = minifyCode(content, true, filename);
            content = minified.code;
            sourceMap = minified.map;
            sourceMap.file = path.basename(outputPath);
            // Use original source (before opt transformations) for debugger display
            sourceMap.sourcesContent = [originalContent];
            content += `\n//# sourceMappingURL=${path.basename(outputPath)}.map\n`;
        } else {
            // Without source maps, minify everything for smallest size
            content = minifyEmbeddedContent(content);
            const minified = minifyCode(content, false, filename);
            content = minified.code;
        }
    }

    // Restore shebang if present
    if (shebang) {
        content = shebang + content;
    }

    if (!options.dryRun) {
        // Ensure output directory exists
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        fs.writeFileSync(outputPath, content);

        if (sourceMap) {
            fs.writeFileSync(outputPath + '.map', JSON.stringify(sourceMap));
        }
    }

    return {
        originalSize,
        outputSize: content.length,
        hasSourceMap: !!sourceMap,
        fixedCount,
        unfixableCount
    };
}

/**
 * Process a single HTML file.
 */
function processHtmlFile2(inputPath, outputPath, options) {
    let content = fs.readFileSync(inputPath, 'utf-8');
    const originalSize = content.length;

    // Process inline scripts for opt transformations
    content = processHtmlFile(content, options);

    // Minify HTML if requested
    if (options.minify) {
        content = minifyHTMLFile(content);
    }

    if (!options.dryRun) {
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        fs.writeFileSync(outputPath, content);
    }

    return {
        originalSize,
        outputSize: content.length,
        hasSourceMap: false
    };
}

/**
 * Process a single CSS file.
 */
function processCssFile(inputPath, outputPath, options) {
    let content = fs.readFileSync(inputPath, 'utf-8');
    const originalSize = content.length;

    if (options.minify) {
        content = minifyCSSFile(content);
    }

    if (!options.dryRun) {
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        fs.writeFileSync(outputPath, content);
    }

    return {
        originalSize,
        outputSize: content.length,
        hasSourceMap: false
    };
}

/**
 * Copy a file without processing.
 */
function copyFile(inputPath, outputPath, options) {
    if (!options.dryRun) {
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        fs.copyFileSync(inputPath, outputPath);
    }

    const stats = fs.statSync(inputPath);
    return {
        originalSize: stats.size,
        outputSize: stats.size,
        hasSourceMap: false
    };
}

/**
 * Walk a directory recursively and return all file paths.
 */
function walkDirectory(dir, baseDir = dir) {
    const files = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            // Skip hidden directories and node_modules
            if (entry.name.startsWith('.') || entry.name === 'node_modules') {
                continue;
            }
            files.push(...walkDirectory(fullPath, baseDir));
        } else if (entry.isFile()) {
            const relativePath = path.relative(baseDir, fullPath);
            files.push(relativePath);
        }
    }

    return files;
}

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * Show a simple line-by-line diff between two strings.
 */
function showDiff(original, modified) {
    const origLines = original.split('\n');
    const modLines = modified.split('\n');

    let inChange = false;
    let changeStart = -1;

    for (let i = 0; i < Math.max(origLines.length, modLines.length); i++) {
        const orig = origLines[i] || '';
        const mod = modLines[i] || '';

        if (orig !== mod) {
            if (!inChange) {
                inChange = true;
                changeStart = i;
                console.log(`\x1b[90m@@ line ${i + 1} @@\x1b[0m`);
            }
            if (origLines[i] !== undefined && orig !== mod) {
                console.log(`\x1b[31m-${orig}\x1b[0m`);
            }
            if (modLines[i] !== undefined && orig !== mod) {
                console.log(`\x1b[32m+${mod}\x1b[0m`);
            }
        } else if (inChange) {
            inChange = false;
        }
    }
}

/**
 * Auto-fix early dereferences in a source file.
 *
 * Fixes variables in two contexts:
 * 1. Inside eval(opt()) blocks: ALL occurrences, because the runtime optimizer
 *    will wrap expressions in contain() - including when() conditions and each() arrays
 * 2. Outside eval(opt()): ONLY inside callback function bodies (when/each/memoEach/contain)
 *    because non-callback args like conditions are evaluated synchronously
 */
function autoFixSource(source) {
    const { fixable } = detectEarlyDereferences(source);
    if (fixable.size === 0) return { code: source, fixedCount: 0 };

    let result = source;
    let totalFixed = 0;

    // Regions where ALL early-dereferenced variables should be fixed
    const fixAllRegions = [];

    // Regions where only callback-body variables should be fixed
    const callbackRegions = [];

    // Find eval(opt()) blocks - everything inside needs fixing
    const evalOptPattern = /eval\s*\(\s*opt\s*\(/g;
    let match;
    while ((match = evalOptPattern.exec(source)) !== null) {
        const startPos = match.index;
        let depth = 2;  // After eval(opt(
        let i = match.index + match[0].length;
        while (i < source.length && depth > 0) {
            if (source[i] === '(') depth++;
            else if (source[i] === ')') depth--;
            i++;
        }
        fixAllRegions.push({ start: startPos, end: i });
    }

    // Find callback bodies in contain() calls only (outside eval(opt()))
    // when/each/memoEach no longer create boundaries, so their callbacks don't need fixing
    // The optimizer wraps the WHOLE when/each expression in contain()
    const deferredPattern = /\bcontain\s*\(/g;
    while ((match = deferredPattern.exec(source)) !== null) {
        const helperStart = match.index;

        // Skip if inside an eval(opt()) region - those are handled by fixAllRegions
        const insideEvalOpt = fixAllRegions.some(r => helperStart >= r.start && helperStart < r.end);
        if (insideEvalOpt) continue;

        // Parse to find arguments, tracking all bracket types
        let i = match.index + match[0].length;
        let depth = 1;
        let bracketDepth = 0;
        let braceDepth = 0;
        const argStarts = [i];

        while (i < source.length && depth > 0) {
            const ch = source[i];

            // Skip strings
            if (ch === '"' || ch === "'" || ch === '`') {
                const quote = ch;
                i++;
                while (i < source.length) {
                    if (source[i] === '\\') { i += 2; continue; }
                    if (source[i] === quote) { i++; break; }
                    if (quote === '`' && source[i] === '$' && source[i+1] === '{') {
                        i += 2;
                        let tDepth = 1;
                        while (i < source.length && tDepth > 0) {
                            if (source[i] === '{') tDepth++;
                            else if (source[i] === '}') tDepth--;
                            i++;
                        }
                        continue;
                    }
                    i++;
                }
                continue;
            }

            if (ch === '(') { depth++; i++; continue; }
            if (ch === ')') { depth--; i++; continue; }
            if (ch === '[') { bracketDepth++; i++; continue; }
            if (ch === ']') { bracketDepth--; i++; continue; }
            if (ch === '{') { braceDepth++; i++; continue; }
            if (ch === '}') { braceDepth--; i++; continue; }
            if (ch === ',' && depth === 1 && bracketDepth === 0 && braceDepth === 0) {
                argStarts.push(i + 1);
            }
            i++;
        }

        const callEnd = i;

        // contain(callback) - arg 0 is the callback
        const callbackArgIndices = [0];

        // Find callback function bodies
        for (const argIdx of callbackArgIndices) {
            if (argIdx >= argStarts.length) continue;

            const argStart = argStarts[argIdx];
            const argEnd = argIdx + 1 < argStarts.length
                ? argStarts[argIdx + 1] - 1
                : callEnd - 1;

            const argContent = source.slice(argStart, argEnd);
            const trimmedArg = argContent.trim();

            let bodyStart = null;

            // Arrow function: () => body or name => body
            const arrowMatch = trimmedArg.match(/^(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>\s*/);
            if (arrowMatch) {
                const bodyOffset = argStart + argContent.indexOf(trimmedArg) + arrowMatch[0].length;
                bodyStart = bodyOffset;
            }

            // Function expression: function(...) { body }
            const funcMatch = trimmedArg.match(/^function\s*\([^)]*\)\s*\{/);
            if (funcMatch) {
                const bodyOffset = argStart + argContent.indexOf(trimmedArg) + funcMatch[0].length;
                bodyStart = bodyOffset;
            }

            if (bodyStart !== null) {
                callbackRegions.push({ start: bodyStart, end: argEnd });
            }
        }
    }

    if (fixAllRegions.length === 0 && callbackRegions.length === 0) {
        return { code: source, fixedCount: 0 };
    }

    // Collect all replacements
    const replacements = [];

    for (const [varName, path] of fixable) {
        const pattern = new RegExp(`(?<![.\\-])\\b${varName}\\b(?![\\-]|\\s*:)`, 'g');

        let varMatch;
        while ((varMatch = pattern.exec(source)) !== null) {
            const matchStart = varMatch.index;
            const matchEnd = varMatch.index + varMatch[0].length;

            // Skip if this is the variable's own declaration (const/let/var varName = ...)
            const beforeMatch = source.slice(Math.max(0, matchStart - 100), matchStart);
            const isSimpleDecl = /\b(?:const|let|var)\s+$/.test(beforeMatch);
            // For destructuring, check if we're inside { } that follows const/let/var
            const isDestructuring = /\b(?:const|let|var)\s*\{(?:[^{}])*$/.test(beforeMatch);
            if (isSimpleDecl || isDestructuring) {
                continue;
            }

            // Check if inside a fix-all region (eval(opt()))
            const insideFixAll = fixAllRegions.some(r => matchStart >= r.start && matchEnd <= r.end);

            // Check if inside a callback region
            const insideCallback = callbackRegions.some(r => matchStart >= r.start && matchEnd <= r.end);

            if (insideFixAll || insideCallback) {
                replacements.push({ start: matchStart, end: matchEnd, replacement: path });
            }
        }
    }

    if (replacements.length === 0) {
        return { code: source, fixedCount: 0 };
    }

    // Sort by position descending and apply
    replacements.sort((a, b) => b.start - a.start);

    for (const { start, end, replacement } of replacements) {
        result = result.slice(0, start) + replacement + result.slice(end);
        totalFixed++;
    }

    return { code: result, fixedCount: totalFixed };
}

/**
 * Lint-only mode: check files for issues without transforming.
 */
function runLintOnly(inputDir, options) {
    const mode = options.autoFix ? 'Auto-Fix Mode' : 'Lint Mode';
    console.log(`VDX Optimizer - ${mode}\n`);
    console.log(`Checking: ${inputDir}\n`);

    const files = walkDirectory(inputDir);
    let fixableCount = 0;
    let unfixableCount = 0;
    let filesWithIssues = 0;
    let filesFixed = 0;
    let totalAutoFixed = 0;

    for (const relativePath of files) {
        const ext = path.extname(relativePath).toLowerCase();
        if (ext !== '.js' && ext !== '.mjs') continue;

        const inputPath = path.join(inputDir, relativePath);
        let content = fs.readFileSync(inputPath, 'utf-8');

        // Auto-fix if enabled
        if (options.autoFix) {
            const { code, fixedCount } = autoFixSource(content);
            if (fixedCount > 0) {
                if (options.dryRun) {
                    // Show diff without writing
                    console.log(`\x1b[36m--- ${relativePath}\x1b[0m`);
                    console.log(`\x1b[36m+++ ${relativePath} (auto-fixed)\x1b[0m`);
                    showDiff(content, code);
                    console.log('');
                } else {
                    fs.writeFileSync(inputPath, code);
                    console.log(`\x1b[32m✓ Fixed ${relativePath}\x1b[0m (${fixedCount} replacements)`);
                }
                filesFixed++;
                totalAutoFixed += fixedCount;
                content = code;  // Re-lint with fixed content
            }
        }

        // --strict mode: Check for issues that break AFTER optimization (stale arguments)
        // Normal mode: Check for issues that break deployed code AS-IS (early derefs in callbacks)
        let issues;
        if (options.strict) {
            issues = lintStaleArgumentPatterns(content, relativePath);
        } else {
            issues = lintEarlyDereferences(content, relativePath);
        }

        const unfixable = issues.filter(i => !i.fixable);
        const fixable = issues.filter(i => i.fixable);

        if (issues.length > 0) {
            filesWithIssues++;
            console.log(`\x1b[33m${relativePath}\x1b[0m`);  // Yellow filename

            for (const issue of unfixable) {
                console.log(`  \x1b[31m✗\x1b[0m Line ${issue.line}: ${issue.message}`);
                console.log(`    \x1b[90mThis CANNOT be auto-fixed - refactor the code\x1b[0m`);
            }

            for (const issue of fixable) {
                console.log(`  \x1b[33m⚠\x1b[0m Line ${issue.line}: ${issue.message}`);
                if (options.autoFix) {
                    console.log(`    \x1b[90mCould not auto-fix - manually change to: ${issue.path}\x1b[0m`);
                } else {
                    console.log(`    \x1b[90mFix: use ${issue.path} directly (or run --auto-fix)\x1b[0m`);
                }
            }
            console.log('');

            fixableCount += fixable.length;
            unfixableCount += unfixable.length;
        }
    }

    const totalIssues = fixableCount + unfixableCount;

    if (options.autoFix && filesFixed > 0) {
        if (options.dryRun) {
            console.log(`\x1b[36mDry run: would fix ${totalAutoFixed} replacement(s) in ${filesFixed} file(s)\x1b[0m\n`);
        } else {
            console.log(`\x1b[32m✓ Auto-fixed ${totalAutoFixed} replacement(s) in ${filesFixed} file(s)\x1b[0m\n`);
        }
    }

    if (totalIssues === 0) {
        if (options.strict) {
            console.log('\x1b[32m✓ No stale argument patterns found (ready for optimization)\x1b[0m\n');
        } else {
            console.log('\x1b[32m✓ No early dereference issues found (deployed code is safe)\x1b[0m\n');
        }
        return 0;
    } else {
        if (options.strict) {
            // --strict mode: stale argument patterns
            console.log(`\x1b[31m✗ Found ${totalIssues} stale argument pattern(s)\x1b[0m`);
            console.log('   These will break AFTER optimization - fix before running optimizer.');
            console.log(`\n  Total: ${totalIssues} issue(s) in ${filesWithIssues} file(s)\n`);
            return 1;  // Exit with error for CI
        } else {
            // Normal mode: early dereferences
            if (unfixableCount > 0) {
                console.log(`\x1b[31m✗ Found ${unfixableCount} UNFIXABLE issue(s) - these MUST be fixed manually\x1b[0m`);
            }
            if (fixableCount > 0) {
                if (options.autoFix) {
                    console.log(`\x1b[33m⚠ Found ${fixableCount} issue(s) that could not be auto-fixed - manual fix needed\x1b[0m`);
                } else {
                    console.log(`\x1b[33m⚠ Found ${fixableCount} issue(s) - run with --auto-fix or fix manually\x1b[0m`);
                }
            }
            console.log(`\n  Total: ${totalIssues} issue(s) in ${filesWithIssues} file(s)\n`);
            return unfixableCount > 0 ? 2 : 1;  // Exit 2 for unfixable errors
        }
    }
}

function main() {
    const options = parseArgs();

    // Handle lint-only mode
    if (options.lintOnly) {
        if (!options.input) {
            console.error('Error: --input is required');
            console.error('Run with --help for usage information');
            process.exit(1);
        }

        const inputDir = path.resolve(options.input);
        if (!fs.existsSync(inputDir)) {
            console.error(`Error: Input directory not found: ${inputDir}`);
            process.exit(1);
        }

        const exitCode = runLintOnly(inputDir, options);
        process.exit(exitCode);
    }

    // Normal optimization mode
    if (!options.input || !options.output) {
        console.error('Error: --input and --output are required');
        console.error('Run with --help for usage information');
        process.exit(1);
    }

    const inputDir = path.resolve(options.input);
    const outputDir = path.resolve(options.output);

    if (!fs.existsSync(inputDir)) {
        console.error(`Error: Input directory not found: ${inputDir}`);
        process.exit(1);
    }

    if (inputDir === outputDir) {
        console.error('Error: Input and output directories cannot be the same');
        console.error('The optimizer always copies files, never modifies in place');
        process.exit(1);
    }

    console.log('VDX Optimizer\n');
    console.log(`Input:  ${inputDir}`);
    console.log(`Output: ${outputDir}`);
    console.log(`Mode:   ${options.wrappedOnly ? 'Wrapped only (eval(opt()) templates)' : 'All html`` templates'}`);
    console.log(`Minify: ${options.minify ? 'Yes' : 'No'}`);
    if (options.sourcemap) console.log(`Source maps: Yes`);
    if (options.dryRun) console.log(`Dry run: Yes (no files will be written)`);
    console.log('');

    // Get all files
    const files = walkDirectory(inputDir);
    console.log(`Found ${files.length} files to process\n`);

    let jsCount = 0, htmlCount = 0, otherCount = 0;
    let totalOriginal = 0, totalOutput = 0;
    let totalFixed = 0;
    let totalUnfixable = 0;
    const warningFiles = [];

    for (const relativePath of files) {
        const inputPath = path.join(inputDir, relativePath);
        const outputPath = path.join(outputDir, relativePath);
        const ext = path.extname(relativePath).toLowerCase();

        let result;

        if (ext === '.js' || ext === '.mjs') {
            result = processJsFile(inputPath, outputPath, options);
            jsCount++;
            totalFixed += result.fixedCount || 0;
            totalUnfixable += result.unfixableCount || 0;
            if (result.fixedCount > 0) {
                warningFiles.push({ path: relativePath, count: result.fixedCount });
            }
            if (options.verbose) {
                const saved = result.originalSize - result.outputSize;
                const percent = result.originalSize > 0 ? Math.round((saved / result.originalSize) * 100) : 0;
                const fixNote = result.fixedCount > 0 ? ` [${result.fixedCount} deref fixed]` : '';
                console.log(`  JS: ${relativePath} (${percent}% saved${result.hasSourceMap ? ' +map' : ''}${fixNote})`);
            }
        } else if (ext === '.html' || ext === '.htm') {
            result = processHtmlFile2(inputPath, outputPath, options);
            htmlCount++;
            if (options.verbose) {
                console.log(`  HTML: ${relativePath}`);
            }
        } else if (ext === '.css') {
            result = processCssFile(inputPath, outputPath, options);
            // Count as "other" for now, could add cssCount if needed
            otherCount++;
            if (options.verbose) {
                const saved = result.originalSize - result.outputSize;
                const percent = result.originalSize > 0 ? Math.round((saved / result.originalSize) * 100) : 0;
                console.log(`  CSS: ${relativePath} (${percent}% saved)`);
            }
        } else {
            result = copyFile(inputPath, outputPath, options);
            otherCount++;
            if (options.verbose) {
                console.log(`  Copy: ${relativePath}`);
            }
        }

        totalOriginal += result.originalSize;
        totalOutput += result.outputSize;
    }

    console.log('\n=== Summary ===');
    console.log(`JavaScript files: ${jsCount}`);
    console.log(`HTML files: ${htmlCount}`);
    console.log(`Other files: ${otherCount}`);
    console.log(`Total input size: ${(totalOriginal / 1024).toFixed(2)} KB`);
    console.log(`Total output size: ${(totalOutput / 1024).toFixed(2)} KB`);
    if (totalOriginal > 0) {
        const saved = totalOriginal - totalOutput;
        const percent = Math.round((saved / totalOriginal) * 100);
        console.log(`Size reduction: ${(saved / 1024).toFixed(2)} KB (${percent}%)`);
    }

    // Show warning about fixed dereferences
    if (totalFixed > 0) {
        console.log(`\n\x1b[33m⚠ Fixed ${totalFixed} early dereference(s)\x1b[0m`);
        console.log(`  These patterns would break reactivity without the optimizer:`);
        for (const { path: filePath, count } of warningFiles) {
            console.log(`    - ${filePath} (${count})`);
        }
        console.log(`  Run with --lint-only to see details.`);
    }

    // In --strict mode, fail if there are any unfixable issues
    if (options.strict && totalUnfixable > 0) {
        console.log(`\n\x1b[31m❌ --strict mode: ${totalUnfixable} unfixable issue(s) found\x1b[0m`);
        console.log('   Fix these patterns manually before deploying.\n');
        process.exit(1);
    }

    console.log(`\n${options.dryRun ? 'Dry run complete (no files written)' : 'Done!'}\n`);
}

main();
