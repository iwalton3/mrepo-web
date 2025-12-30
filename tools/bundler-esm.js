#!/usr/bin/env node
/**
 * ESM Bundler with Tree Shaking
 *
 * A generic tree-shaking bundler that:
 * - Discovers all dependencies from an entry file
 * - Builds dependency graph with import/export tracking
 * - Performs tree shaking to remove unused exports
 * - Handles circular dependencies
 * - Outputs a single bundle with only the entry file's exports
 *
 * Usage:
 *   node bundler-esm.js --entry ./app/lib/framework.js --output ./app/dist/framework.js
 *   node bundler-esm.js -e ./app/lib/framework.js -o ./app/dist/framework.js
 *
 * Options:
 *   --entry, -e    Entry file (required)
 *   --output, -o   Output file (required)
 *   --verbose, -v  Show detailed output
 *   --no-comments  Strip all comments (default: keep licenses)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse CLI arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        entry: null,
        output: null,
        verbose: false,
        keepComments: true,
        compact: false,
        tabs: false,
        sourcemap: false
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--entry':
            case '-e':
                options.entry = args[++i];
                break;
            case '--output':
            case '-o':
                options.output = args[++i];
                break;
            case '--verbose':
            case '-v':
                options.verbose = true;
                break;
            case '--no-comments':
                options.keepComments = false;
                break;
            case '--compact':
            case '-c':
                options.compact = true;
                options.keepComments = false;  // Compact implies no comments
                break;
            case '--tabs':
            case '-t':
                options.tabs = true;
                break;
            case '--sourcemap':
            case '-s':
                options.sourcemap = true;
                options.compact = true;  // Source maps imply compact
                options.keepComments = true;  // Keep comments for minifier to strip (for source map accuracy)
                break;
            case '--help':
            case '-h':
                console.log(`
ESM Bundler with Tree Shaking

Usage:
  node bundler-esm.js                              # Default: bundle all (framework, router, utils)
  node bundler-esm.js -e <file> -o <file> [opts]   # Custom: single file bundle

Default mode (no arguments):
  Generates minified bundles in app/dist/ with source maps:
    framework.js + framework.js.map   (tree-shaken, minified)
    router.js + router.js.map         (minified)
    utils.js + utils.js.map           (minified)

  Source maps contain embedded readable source for debugging.
  Just swap lib/ files with dist/ files to distribute your app.

Options:
  --entry, -e     Entry file (for custom single-file mode)
  --output, -o    Output file (for custom single-file mode)
  --verbose, -v   Show detailed output
  --no-comments   Strip all comments (default: keep licenses)
  --tabs, -t      Convert indentation to tabs (smaller, still debuggable)
  --compact, -c   Minify output (strip comments, squash whitespace)
  --sourcemap, -s Minify with source map (.map file alongside output)
  --help, -h      Show this help
`);
                process.exit(0);
        }
    }

    // Entry and output are optional - if not provided, use default mode
    return options;
}

class ModuleInfo {
    constructor(filePath) {
        this.filePath = filePath;
        this.content = '';
        this.imports = [];      // { source, specifiers: [{imported, local}], namespace, default }
        this.exports = [];      // { name, alias, isDefault, isReExport, reExportSource }
        this.dependencies = new Set();
        this.usedExports = new Set();  // Which exports are actually used
        this.usedImports = new Set();  // Which imports are actually used
    }
}

/**
 * Parse import statements from code
 * Handles:
 * - import foo from './bar.js'
 * - import { a, b } from './bar.js'
 * - import { a as b } from './bar.js'
 * - import * as foo from './bar.js'
 * - import './bar.js' (side effects)
 * - import foo, { bar } from './baz.js' (default + named)
 */
function parseImports(code) {
    const imports = [];

    // More comprehensive regex that handles default + named imports
    const importRegex = /import\s+(?:(\w+)\s*,\s*)?(?:(?:{([^}]+)}|\*\s+as\s+(\w+))\s+from\s+)?(?:(\w+)\s+from\s+)?['"]([^'"]+)['"]/g;

    let match;
    while ((match = importRegex.exec(code)) !== null) {
        const [, defaultWithNamed, namedImports, namespaceImport, defaultOnly, source] = match;

        const importInfo = {
            source,
            specifiers: [],
            namespace: null,
            default: null,
            fullMatch: match[0]
        };

        // Default import (either standalone or with named)
        if (defaultWithNamed) {
            importInfo.default = defaultWithNamed;
        } else if (defaultOnly) {
            importInfo.default = defaultOnly;
        }

        if (namespaceImport) {
            importInfo.namespace = namespaceImport;
        }

        if (namedImports) {
            // Parse named imports: { a, b as c, d }
            const specs = namedImports.split(',').map(s => s.trim()).filter(s => s);
            for (const spec of specs) {
                const asMatch = spec.match(/(\w+)\s+as\s+(\w+)/);
                if (asMatch) {
                    importInfo.specifiers.push({
                        imported: asMatch[1],
                        local: asMatch[2]
                    });
                } else {
                    importInfo.specifiers.push({
                        imported: spec,
                        local: spec
                    });
                }
            }
        }

        imports.push(importInfo);
    }

    return imports;
}

/**
 * Parse export statements from code
 * Handles:
 * - export function foo() {}
 * - export const bar = 1
 * - export { a, b }
 * - export { a as b }
 * - export default foo
 * - export { foo } from './bar.js' (re-export)
 * - export * from './bar.js' (re-export all)
 */
function parseExports(code) {
    const exports = [];

    // export function/const/let/var/class/async function
    const declarationRegex = /export\s+(?:async\s+)?(function|const|let|var|class)\s+(\w+)/g;
    let match;
    while ((match = declarationRegex.exec(code)) !== null) {
        exports.push({
            name: match[2],
            alias: null,
            isDefault: false,
            isReExport: false,
            reExportSource: null
        });
    }

    // export { a, b as c } from './source.js' (re-export)
    const reExportRegex = /export\s+{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = reExportRegex.exec(code)) !== null) {
        const specs = match[1].split(',').map(s => s.trim()).filter(s => s);
        const source = match[2];
        for (const spec of specs) {
            const asMatch = spec.match(/(\w+)\s+as\s+(\w+)/);
            if (asMatch) {
                exports.push({
                    name: asMatch[1],
                    alias: asMatch[2],
                    isDefault: false,
                    isReExport: true,
                    reExportSource: source
                });
            } else {
                exports.push({
                    name: spec,
                    alias: null,
                    isDefault: false,
                    isReExport: true,
                    reExportSource: source
                });
            }
        }
    }

    // export * from './source.js' (re-export all)
    const reExportAllRegex = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = reExportAllRegex.exec(code)) !== null) {
        exports.push({
            name: '*',
            alias: null,
            isDefault: false,
            isReExport: true,
            reExportSource: match[1]
        });
    }

    // export { a, b as c } (named export, not re-export)
    const namedExportRegex = /export\s+{([^}]+)}(?!\s+from)/g;
    while ((match = namedExportRegex.exec(code)) !== null) {
        const specs = match[1].split(',').map(s => s.trim()).filter(s => s);
        for (const spec of specs) {
            const asMatch = spec.match(/(\w+)\s+as\s+(\w+)/);
            if (asMatch) {
                exports.push({
                    name: asMatch[1],
                    alias: asMatch[2],
                    isDefault: false,
                    isReExport: false,
                    reExportSource: null
                });
            } else {
                exports.push({
                    name: spec,
                    alias: null,
                    isDefault: false,
                    isReExport: false,
                    reExportSource: null
                });
            }
        }
    }

    // export default
    const defaultExportRegex = /export\s+default\s+(\w+)/;
    const defaultMatch = code.match(defaultExportRegex);
    if (defaultMatch) {
        exports.push({
            name: defaultMatch[1],
            alias: null,
            isDefault: true,
            isReExport: false,
            reExportSource: null
        });
    }

    return exports;
}

/**
 * Resolve relative import path to absolute file path
 */
function resolveImportPath(fromFile, importSource, baseDir) {
    if (!importSource.startsWith('.')) {
        return null; // External module, not in our bundle
    }

    const fromDir = path.dirname(fromFile);
    const resolved = path.resolve(fromDir, importSource);

    // Return path relative to base directory
    return path.relative(baseDir, resolved);
}

/**
 * Discover all dependencies recursively from entry file
 */
function discoverDependencies(entryFile, baseDir, verbose) {
    const discovered = new Map();  // filePath -> ModuleInfo
    const queue = [entryFile];
    const seen = new Set();

    while (queue.length > 0) {
        const filePath = queue.shift();

        if (seen.has(filePath)) continue;
        seen.add(filePath);

        const absolutePath = path.resolve(baseDir, filePath);

        if (!fs.existsSync(absolutePath)) {
            console.warn(`  ⚠ File not found: ${filePath}`);
            continue;
        }

        const module = new ModuleInfo(filePath);
        module.content = fs.readFileSync(absolutePath, 'utf-8');
        module.imports = parseImports(module.content);
        module.exports = parseExports(module.content);

        if (verbose) {
            console.log(`  ${filePath}`);
            console.log(`    Imports: ${module.imports.length}, Exports: ${module.exports.length}`);
        }

        // Add dependencies to queue
        for (const imp of module.imports) {
            const depPath = resolveImportPath(absolutePath, imp.source, baseDir);
            if (depPath) {
                module.dependencies.add(depPath);
                if (!seen.has(depPath)) {
                    queue.push(depPath);
                }
            }
        }

        // Handle re-export sources
        for (const exp of module.exports) {
            if (exp.isReExport && exp.reExportSource) {
                const depPath = resolveImportPath(absolutePath, exp.reExportSource, baseDir);
                if (depPath) {
                    module.dependencies.add(depPath);
                    if (!seen.has(depPath)) {
                        queue.push(depPath);
                    }
                }
            }
        }

        discovered.set(filePath, module);
    }

    return discovered;
}

/**
 * Mark exports as used starting from entry file exports
 * This implements tree shaking by tracking what's actually imported
 */
function markUsedExports(modules, entryFile, baseDir, verbose) {
    const entryModule = modules.get(entryFile);
    if (!entryModule) return;

    // Start with all exports from entry file as used
    for (const exp of entryModule.exports) {
        entryModule.usedExports.add(exp.alias || exp.name);
    }

    // Propagate usage through the dependency graph
    let changed = true;
    while (changed) {
        changed = false;

        for (const [filePath, module] of modules) {
            // For each used export, find what it depends on
            for (const usedExportName of module.usedExports) {
                // Find the export
                const exp = module.exports.find(e =>
                    (e.alias || e.name) === usedExportName || e.name === usedExportName
                );

                if (!exp) continue;

                // If it's a re-export, mark the source as used
                if (exp.isReExport && exp.reExportSource) {
                    const depPath = resolveImportPath(
                        path.resolve(baseDir, filePath),
                        exp.reExportSource,
                        baseDir
                    );

                    if (depPath && modules.has(depPath)) {
                        const depModule = modules.get(depPath);
                        const exportName = exp.name === '*' ? '*' : exp.name;

                        if (exportName === '*') {
                            // Mark all exports from source as used
                            for (const depExp of depModule.exports) {
                                if (!depModule.usedExports.has(depExp.alias || depExp.name)) {
                                    depModule.usedExports.add(depExp.alias || depExp.name);
                                    changed = true;
                                }
                            }
                        } else if (!depModule.usedExports.has(exportName)) {
                            depModule.usedExports.add(exportName);
                            changed = true;
                        }
                    }
                }
            }

            // Mark imports as used if they're needed by used code
            // For simplicity, if a module has any used exports, consider all its imports used
            if (module.usedExports.size > 0) {
                for (const imp of module.imports) {
                    const depPath = resolveImportPath(
                        path.resolve(baseDir, filePath),
                        imp.source,
                        baseDir
                    );

                    if (!depPath || !modules.has(depPath)) continue;

                    const depModule = modules.get(depPath);

                    // Mark the specific imports as used
                    if (imp.namespace) {
                        // Namespace import - mark all exports as used
                        for (const depExp of depModule.exports) {
                            if (!depModule.usedExports.has(depExp.alias || depExp.name)) {
                                depModule.usedExports.add(depExp.alias || depExp.name);
                                changed = true;
                            }
                        }
                    }

                    if (imp.default) {
                        // Default import
                        const defaultExp = depModule.exports.find(e => e.isDefault);
                        if (defaultExp && !depModule.usedExports.has(defaultExp.name)) {
                            depModule.usedExports.add(defaultExp.name);
                            changed = true;
                        }
                    }

                    for (const spec of imp.specifiers) {
                        if (!depModule.usedExports.has(spec.imported)) {
                            depModule.usedExports.add(spec.imported);
                            changed = true;
                        }
                    }

                    // Side-effect import (no default, no namespace, no specifiers)
                    // Include all exports from the module
                    if (!imp.default && !imp.namespace && imp.specifiers.length === 0) {
                        for (const depExp of depModule.exports) {
                            const exportName = depExp.alias || depExp.name;
                            if (!depModule.usedExports.has(exportName)) {
                                depModule.usedExports.add(exportName);
                                changed = true;
                            }
                        }
                    }
                }
            }
        }
    }

    if (verbose) {
        console.log('\nUsed exports per module:');
        for (const [filePath, module] of modules) {
            if (module.usedExports.size > 0) {
                console.log(`  ${path.basename(filePath)}: ${[...module.usedExports].join(', ')}`);
            }
        }
    }
}

/**
 * Topological sort of modules based on dependencies
 * Handles circular dependencies gracefully
 */
function topologicalSort(modules, verbose) {
    const sorted = [];
    const visited = new Set();
    const visiting = new Set();

    function visit(filePath) {
        if (visited.has(filePath)) return;

        if (visiting.has(filePath)) {
            if (verbose) {
                console.log(`  ⚠ Circular dependency: ${path.basename(filePath)}`);
            }
            return;
        }

        visiting.add(filePath);
        const module = modules.get(filePath);

        if (module) {
            for (const dep of module.dependencies) {
                if (modules.has(dep)) {
                    visit(dep);
                }
            }
        }

        visiting.delete(filePath);
        visited.add(filePath);
        sorted.push(filePath);
    }

    for (const filePath of modules.keys()) {
        visit(filePath);
    }

    return sorted;
}

/**
 * Remove import and export statements from code
 */
function stripImportsExports(code) {
    let result = '';
    let i = 0;
    const len = code.length;

    while (i < len) {
        // Check for 'import' keyword
        if (code.substring(i, i + 6) === 'import' &&
            (i === 0 || /\s/.test(code[i - 1])) &&
            (i + 6 >= len || /\s/.test(code[i + 6]))) {

            i += 6;

            // Skip entire import statement
            let braceDepth = 0;
            while (i < len) {
                if (code[i] === '{') braceDepth++;
                if (code[i] === '}') braceDepth--;
                if (braceDepth === 0 && code[i] === ';') {
                    i++;
                    break;
                }
                // Handle import without semicolon (end of line)
                if (braceDepth === 0 && code[i] === '\n') {
                    break;
                }
                i++;
            }

            while (i < len && /[\s]/.test(code[i])) i++;
            continue;
        }

        // Check for 'export' keyword
        if (code.substring(i, i + 6) === 'export' &&
            (i === 0 || /\s/.test(code[i - 1])) &&
            (i + 6 >= len || /\s/.test(code[i + 6]))) {

            i += 6;
            while (i < len && /\s/.test(code[i])) i++;

            // export { ... } from '...' or export { ... }
            if (code[i] === '{') {
                let braceDepth = 1;
                i++;

                while (i < len && braceDepth > 0) {
                    if (code[i] === '{') braceDepth++;
                    if (code[i] === '}') braceDepth--;
                    i++;
                }

                while (i < len && code[i] !== ';' && code[i] !== '\n') i++;
                if (code[i] === ';') i++;

                while (i < len && /[\s]/.test(code[i])) i++;
                continue;
            }

            // export * from '...'
            if (code[i] === '*') {
                while (i < len && code[i] !== ';' && code[i] !== '\n') i++;
                if (code[i] === ';') i++;
                while (i < len && /[\s]/.test(code[i])) i++;
                continue;
            }

            // export default
            if (code.substring(i, i + 7) === 'default') {
                i += 7;
                while (i < len && /\s/.test(code[i])) i++;
            }

            continue;
        }

        result += code[i];
        i++;
    }

    return result;
}

/**
 * Strip comments but keep licenses
 */
function stripComments(code, keepLicenses = true) {
    let result = '';
    let i = 0;
    const len = code.length;

    while (i < len) {
        // Regex literals
        if (code[i] === '/') {
            let j = i - 1;
            while (j >= 0 && /\s/.test(code[j])) j--;

            const prevChar = j >= 0 ? code[j] : '';
            const isLikelyRegex = j < 0 ||
                                '=([{,;!&|?:\n'.includes(prevChar) ||
                                code.substring(Math.max(0, j - 5), j + 1).match(/return$/);

            if (isLikelyRegex && code[i + 1] !== '/' && code[i + 1] !== '*') {
                result += code[i];
                i++;

                while (i < len) {
                    if (code[i] === '\\' && i + 1 < len) {
                        result += code[i] + code[i + 1];
                        i += 2;
                    } else if (code[i] === '/') {
                        result += code[i];
                        i++;
                        while (i < len && /[gimsuvy]/.test(code[i])) {
                            result += code[i];
                            i++;
                        }
                        break;
                    } else {
                        result += code[i];
                        i++;
                    }
                }
                continue;
            }
        }

        // Single-line comment
        if (code[i] === '/' && code[i + 1] === '/') {
            i += 2;
            while (i < len && code[i] !== '\n') i++;
            if (i < len) {
                result += '\n';
                i++;
            }
            continue;
        }

        // Multi-line comment
        if (code[i] === '/' && code[i + 1] === '*') {
            i += 2;
            let commentText = '';

            while (i < len - 1) {
                if (code[i] === '*' && code[i + 1] === '/') break;
                commentText += code[i];
                i++;
            }

            const isLicense = keepLicenses && (
                commentText.includes('@license') ||
                commentText.includes('Copyright') ||
                commentText.includes('(c)') ||
                commentText.includes('MIT') ||
                commentText.includes('Apache')
            );

            if (isLicense) {
                result += '/*' + commentText + '*/';
            }

            i += 2;
            continue;
        }

        // String literals
        if (code[i] === '"' || code[i] === "'") {
            const quote = code[i];
            result += code[i];
            i++;

            while (i < len) {
                if (code[i] === '\\' && i + 1 < len) {
                    result += code[i] + code[i + 1];
                    i += 2;
                } else if (code[i] === quote) {
                    result += code[i];
                    i++;
                    break;
                } else {
                    result += code[i];
                    i++;
                }
            }
            continue;
        }

        // Template literals
        if (code[i] === '`') {
            result += code[i];
            i++;

            while (i < len) {
                if (code[i] === '\\' && i + 1 < len) {
                    result += code[i] + code[i + 1];
                    i += 2;
                } else if (code[i] === '$' && i + 1 < len && code[i + 1] === '{') {
                    result += code[i] + code[i + 1];
                    i += 2;

                    let braceDepth = 1;
                    while (i < len && braceDepth > 0) {
                        if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
                            const quote = code[i];
                            result += code[i];
                            i++;

                            while (i < len) {
                                if (code[i] === '\\' && i + 1 < len) {
                                    result += code[i] + code[i + 1];
                                    i += 2;
                                } else if (code[i] === quote) {
                                    result += code[i];
                                    i++;
                                    break;
                                } else {
                                    result += code[i];
                                    i++;
                                }
                            }
                            continue;
                        }

                        if (code[i] === '{') braceDepth++;
                        if (code[i] === '}') braceDepth--;

                        result += code[i];
                        i++;
                    }
                } else if (code[i] === '`') {
                    result += code[i];
                    i++;
                    break;
                } else {
                    result += code[i];
                    i++;
                }
            }
            continue;
        }

        result += code[i];
        i++;
    }

    return result;
}

/**
 * Extract top-level declarations from code
 * Returns array of { name, code, startIndex, endIndex }
 */
function extractDeclarations(code) {
    const declarations = [];

    // Match function declarations
    const funcRegex = /^((?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{)/gm;
    let match;

    while ((match = funcRegex.exec(code)) !== null) {
        const name = match[2];
        const startIndex = match.index;
        const endIndex = findBlockEnd(code, match.index + match[1].length - 1);
        if (endIndex > startIndex) {
            declarations.push({
                name,
                code: code.substring(startIndex, endIndex),
                startIndex,
                endIndex,
                type: 'function'
            });
        }
    }

    // Match class declarations
    const classRegex = /^(class\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:extends\s+[A-Za-z_$][A-Za-z0-9_$.]*)?\s*\{)/gm;
    while ((match = classRegex.exec(code)) !== null) {
        const name = match[2];
        const startIndex = match.index;
        const endIndex = findBlockEnd(code, match.index + match[1].length - 1);
        if (endIndex > startIndex) {
            declarations.push({
                name,
                code: code.substring(startIndex, endIndex),
                startIndex,
                endIndex,
                type: 'class'
            });
        }
    }

    // Match const/let/var declarations (simple single-line or until semicolon)
    const varRegex = /^(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/gm;
    while ((match = varRegex.exec(code)) !== null) {
        const name = match[2];
        const startIndex = match.index;
        // Find the end - either semicolon or end of object/array/function
        let endIndex = findDeclarationEnd(code, startIndex);
        if (endIndex > startIndex) {
            declarations.push({
                name,
                code: code.substring(startIndex, endIndex),
                startIndex,
                endIndex,
                type: 'variable'
            });
        }
    }

    // Sort by startIndex to maintain order
    declarations.sort((a, b) => a.startIndex - b.startIndex);

    return declarations;
}

/**
 * Find the end of a block (matching closing brace)
 */
function findBlockEnd(code, openBraceIndex) {
    let depth = 1;
    let i = openBraceIndex + 1;
    const len = code.length;

    while (i < len && depth > 0) {
        const char = code[i];

        // Skip strings
        if (char === '"' || char === "'" || char === '`') {
            i = skipString(code, i);
            continue;
        }

        // Skip comments
        if (char === '/' && code[i + 1] === '/') {
            while (i < len && code[i] !== '\n') i++;
            i++;
            continue;
        }
        if (char === '/' && code[i + 1] === '*') {
            i += 2;
            while (i < len - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++;
            i += 2;
            continue;
        }

        if (char === '{') depth++;
        if (char === '}') depth--;
        i++;
    }

    return i;
}

/**
 * Find the end of a variable declaration
 */
function findDeclarationEnd(code, startIndex) {
    let i = startIndex;
    const len = code.length;
    let depth = 0;
    let sawArrow = false;

    while (i < len) {
        const char = code[i];

        // Skip strings
        if (char === '"' || char === "'" || char === '`') {
            i = skipString(code, i);
            continue;
        }

        // Skip comments
        if (char === '/' && code[i + 1] === '/') {
            while (i < len && code[i] !== '\n') i++;
            continue;
        }
        if (char === '/' && code[i + 1] === '*') {
            i += 2;
            while (i < len - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++;
            i += 2;
            continue;
        }

        // Track braces/brackets/parens for objects, arrays, arrow functions
        if (char === '{' || char === '[' || char === '(') depth++;
        if (char === '}' || char === ']' || char === ')') depth--;

        // Detect arrow function
        if (char === '=' && code[i + 1] === '>') {
            sawArrow = true;
            i += 2;
            continue;
        }

        // End at semicolon when depth is 0
        if (depth === 0 && char === ';') {
            return i + 1;
        }

        // End at newline when depth is 0 (unless we're in an arrow function body)
        if (depth === 0 && char === '\n' && i > startIndex + 10) {
            // Check if next non-whitespace is a new declaration or statement
            let j = i + 1;
            while (j < len && (code[j] === ' ' || code[j] === '\t')) j++;

            // If we saw an arrow and the next line continues the expression, keep going
            if (sawArrow) {
                // Arrow function implicit return - continue until we hit a semicolon or a clear break
                // Skip over the expression
                i++;
                continue;
            }

            if (j < len && /[a-zA-Z_$})\]]/.test(code[j])) {
                // Likely end of declaration
                return i;
            }
        }

        i++;
    }

    return len;
}

/**
 * Skip past a string literal
 */
function skipString(code, startIndex) {
    const quote = code[startIndex];
    let i = startIndex + 1;
    const len = code.length;

    while (i < len) {
        if (code[i] === '\\' && i + 1 < len) {
            i += 2;
            continue;
        }
        if (code[i] === quote) {
            if (quote === '`') {
                return i + 1;
            }
            return i + 1;
        }
        // Handle template literal interpolation
        if (quote === '`' && code[i] === '$' && code[i + 1] === '{') {
            i += 2;
            let depth = 1;
            while (i < len && depth > 0) {
                if (code[i] === '{') depth++;
                if (code[i] === '}') depth--;
                if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
                    i = skipString(code, i);
                    continue;
                }
                i++;
            }
            continue;
        }
        i++;
    }

    return len;
}

/**
 * Find all identifier references in a code block
 * Uses simple word boundary matching - may have false positives but that's OK
 */
function findReferences(code, allNames) {
    const refs = new Set();

    for (const name of allNames) {
        // Match word boundaries - \b doesn't work well with $ in names
        const regex = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegex(name)}(?![A-Za-z0-9_$])`, 'g');
        if (regex.test(code)) {
            refs.add(name);
        }
    }

    return refs;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Perform function-level tree shaking on code
 * Returns code with unused declarations removed
 */
function treeshakeCode(code, usedExports, verbose) {
    const declarations = extractDeclarations(code);

    if (declarations.length === 0) {
        return code;
    }

    // Build name -> declaration map
    const declMap = new Map();
    for (const decl of declarations) {
        declMap.set(decl.name, decl);
    }

    const allNames = new Set(declMap.keys());

    // Build reference graph
    const references = new Map();
    for (const decl of declarations) {
        const refs = findReferences(decl.code, allNames);
        refs.delete(decl.name); // Remove self-reference
        references.set(decl.name, refs);
    }

    // Find code outside declarations (top-level statements)
    // Remove all declaration code from the full code to get only top-level statements
    let topLevelCode = code;
    const sortedByEnd = [...declarations].sort((a, b) => b.startIndex - a.startIndex);
    for (const decl of sortedByEnd) {
        topLevelCode = topLevelCode.substring(0, decl.startIndex) + topLevelCode.substring(decl.endIndex);
    }
    const topLevelRefs = findReferences(topLevelCode, allNames);

    // Start with used exports and transitively find all needed declarations
    const needed = new Set();

    // Add exports and their transitive dependencies
    for (const exportName of usedExports) {
        if (declMap.has(exportName)) {
            addTransitiveDeps(exportName, needed, references, declMap);
        }
    }

    // Add anything referenced at top level
    for (const ref of topLevelRefs) {
        if (declMap.has(ref)) {
            addTransitiveDeps(ref, needed, references, declMap);
        }
    }

    // If nothing was identified as needed, keep everything (conservative)
    if (needed.size === 0 && declarations.length > 0) {
        return code;
    }

    // Remove unused declarations
    let result = code;
    const removed = [];

    // Sort declarations by startIndex descending to remove from end first
    const sortedDecls = [...declarations].sort((a, b) => b.startIndex - a.startIndex);

    for (const decl of sortedDecls) {
        if (!needed.has(decl.name)) {
            removed.push(decl.name);
            result = result.substring(0, decl.startIndex) + result.substring(decl.endIndex);
        }
    }

    if (verbose && removed.length > 0) {
        console.log(`    Removed: ${removed.join(', ')}`);
    }

    return result;
}

/**
 * Recursively add transitive dependencies
 */
function addTransitiveDeps(name, needed, references, declMap) {
    if (needed.has(name)) return;
    if (!declMap.has(name)) return;

    needed.add(name);

    const refs = references.get(name);
    if (refs) {
        for (const ref of refs) {
            addTransitiveDeps(ref, needed, references, declMap);
        }
    }
}

/**
 * VLQ encoding for source maps
 */
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
 * Minify CSS by removing comments, collapsing whitespace
 */
function minifyCSS(css) {
    let result = css;
    result = result.replace(/\/\*[\s\S]*?\*\//g, '');  // Remove comments
    result = result.replace(/\s*([{};:,>+~])\s*/g, '$1');
    result = result.replace(/\s+/g, ' ');
    result = result.replace(/\{\s+/g, '{');
    result = result.replace(/\s+\}/g, '}');
    result = result.replace(/;}/g, '}');
    return result.trim();
}

/**
 * Minify HTML template content for html`` templates.
 * Removes comments, collapses whitespace, preserves pre/code/script/style/textarea.
 */
function minifyHTMLTemplate(html) {
    const preserveTags = ['pre', 'code', 'script', 'style', 'textarea'];
    const preserved = [];
    let result = html;

    // Extract and preserve content from special tags
    for (const tag of preserveTags) {
        const regex = new RegExp(`(<${tag}[^>]*>)([\\s\\S]*?)(</${tag}>)`, 'gi');
        result = result.replace(regex, (match) => {
            const placeholder = `__PRESERVE_${preserved.length}__`;
            preserved.push(match);
            return placeholder;
        });
    }

    // Remove HTML comments
    result = result.replace(/<!--[\s\S]*?-->/g, '');

    // Collapse whitespace
    result = result.replace(/\s+/g, ' ');
    result = result.replace(/>\s+</g, '><');
    result = result.replace(/>\s+\$/g, '>$');
    result = result.replace(/\}\s+</g, '}<');
    result = result.replace(/\}\s+\$/g, '}$');
    // NOTE: Do NOT trim - trailing space may be significant for expressions in attributes

    // Squash whitespace within opening tags
    result = result.replace(/<([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)\s*>/g, (match, tag, attrs) => {
        if (!attrs) return `<${tag}>`;
        const squashedAttrs = attrs.replace(/\s+/g, ' ').trim();
        return `<${tag}${squashedAttrs ? ' ' + squashedAttrs : ''}>`;
    });

    // Restore preserved content
    for (let i = 0; i < preserved.length; i++) {
        result = result.replace(`__PRESERVE_${i}__`, () => preserved[i]);
    }

    return result;
}

/**
 * Minify embedded CSS and HTML within JavaScript code.
 * Finds styles: `...` and html`...` templates and minifies their content.
 */
function minifyEmbeddedContent(code) {
    let result = code;

    // Minify styles: /*css*/`...` or styles: `...`
    result = result.replace(
        /(styles\s*:\s*(?:\/\*\s*css\s*\*\/)?\s*`)([^`]*?)(`)/g,
        (match, prefix, css, suffix) => prefix + minifyCSS(css) + suffix
    );

    // Find and minify html`...` templates
    const templateStarts = [];
    for (let i = 0; i < result.length - 4; i++) {
        if (result.slice(i, i + 5) === 'html`') {
            templateStarts.push(i);
        }
    }

    // Process in reverse order
    for (let t = templateStarts.length - 1; t >= 0; t--) {
        const startIdx = templateStarts[t];
        const templateStart = startIdx + 5;

        let i = templateStart;
        let parts = [];
        let currentText = '';

        while (i < result.length) {
            const ch = result[i];

            if (ch === '\\' && i + 1 < result.length) {
                currentText += ch + result[i + 1];
                i += 2;
                continue;
            }

            if (ch === '$' && result[i + 1] === '{') {
                if (currentText) {
                    parts.push({ type: 'text', content: currentText });
                    currentText = '';
                }

                let exprStart = i;
                i += 2;
                let braceDepth = 1;
                let inString = false;
                let stringChar = '';
                const templateStack = [];  // Track nested template literal depth

                while (i < result.length && braceDepth > 0) {
                    const c = result[i];
                    const inTemplate = templateStack.length > 0;

                    if ((inString || inTemplate) && c === '\\' && i + 1 < result.length) {
                        i += 2;
                        continue;
                    }
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
                    if (!inString && c === '`') {
                        if (inTemplate && braceDepth === templateStack[templateStack.length - 1]) {
                            templateStack.pop();  // Closing current template
                        } else {
                            templateStack.push(braceDepth);  // Opening new template
                        }
                        i++;
                        continue;
                    }
                    if (inTemplate && c === '$' && result[i + 1] === '{') {
                        braceDepth++;
                        i += 2;
                        continue;
                    }
                    if (!inString && !inTemplate) {
                        if (c === '{') braceDepth++;
                        else if (c === '}') braceDepth--;
                    }
                    if (inTemplate && c === '}' && braceDepth > templateStack[templateStack.length - 1]) {
                        braceDepth--;
                    }
                    i++;
                }
                parts.push({ type: 'expr', content: result.slice(exprStart, i) });
                continue;
            }

            if (ch === '`') {
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
                break;
            }

            currentText += ch;
            i++;
        }
    }

    return result;
}

/**
 * Minify code and optionally generate source map
 * @param {string} code - Source code to minify
 * @param {boolean} generateMap - Whether to generate source map
 * @param {Array} fileMap - Optional array of {file, startLine, endLine, content} for multi-file source maps
 * @returns {{code: string, map?: object}} - Minified code and optional source map
 */
function minifyCode(code, generateMap = false, fileMap = null) {
    let result = '';
    let i = 0;
    const len = code.length;
    let lastChar = '';

    // Source map tracking
    let srcLine = 0, srcCol = 0;
    let outLine = 0, outCol = 0;
    let prevSrcLine = 0, prevSrcCol = 0, prevOutCol = 0;
    let prevSrcIndex = 0;
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

    // Multi-file tracking
    let currentFileIndex = -1;
    let currentFileStartLine = 0;

    // Build source file lookup if fileMap provided
    // Returns -1 if line is not in any tracked file (e.g., header, aliases)
    function getSourceIndex(line) {
        if (!fileMap || fileMap.length === 0) return 0;

        for (let idx = 0; idx < fileMap.length; idx++) {
            const f = fileMap[idx];
            if (line >= f.startLine && line < f.endLine) {
                if (idx !== currentFileIndex) {
                    currentFileIndex = idx;
                    currentFileStartLine = f.startLine;
                }
                return idx;
            }
        }
        return -1;  // Not in any tracked file
    }

    function addMapping(name = null) {
        if (!generateMap) return;

        const srcIndex = fileMap ? getSourceIndex(srcLine) : 0;

        // Skip mapping for lines not in any tracked file (header, aliases, etc.)
        if (srcIndex === -1) return;

        // Calculate line relative to current file's start
        const relativeLine = srcLine - currentFileStartLine;

        // Build VLQ mapping - 4 segments without name, 5 segments with name
        let mapping = vlqEncode(outCol - prevOutCol) +
            vlqEncode(srcIndex - prevSrcIndex) +
            vlqEncode(relativeLine - prevSrcLine) +
            vlqEncode(srcCol - prevSrcCol);

        // Add 5th segment for identifier name
        if (name !== null) {
            const nameIdx = getNameIndex(name);
            mapping += vlqEncode(nameIdx - prevNameIdx);
            prevNameIdx = nameIdx;
        }

        currentLineMappings.push(mapping);
        prevOutCol = outCol;
        prevSrcIndex = srcIndex;
        prevSrcLine = relativeLine;
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

    // Add initial mapping
    addMapping();

    while (i < len) {
        const char = code[i];

        // Skip single-line comments
        if (char === '/' && code[i + 1] === '/') {
            while (i < len && code[i] !== '\n') advance();
            if (i < len) advance(); // skip newline
            continue;
        }

        // Skip multi-line comments (but keep license comments /*!)
        if (char === '/' && code[i + 1] === '*') {
            const isLicense = code[i + 2] === '!';
            if (isLicense) {
                // Keep license comment
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
                // Skip regular comment
                advance(); advance(); // skip /*
                while (i < len && !(code[i] === '*' && code[i + 1] === '/')) advance();
                if (i < len) { advance(); advance(); } // skip */
            }
            continue;
        }

        // Handle regex literals - must come before string check
        // Regex can start after: = ( [ { , ; ! & | ? : return
        if (char === '/') {
            // Look back to determine if this is regex or division
            let j = result.length - 1;
            while (j >= 0 && /\s/.test(result[j])) j--;
            const prevResultChar = j >= 0 ? result[j] : '';

            // Check if previous token suggests regex
            const isLikelyRegex = j < 0 ||
                '=([{,;!&|?:\n'.includes(prevResultChar) ||
                result.substring(Math.max(0, j - 5), j + 1).match(/return$/);

            if (isLikelyRegex && code[i + 1] !== '/' && code[i + 1] !== '*') {
                // This is a regex literal
                addMapping();
                emit(char); // opening /
                advance();

                // Copy regex body
                while (i < len) {
                    if (code[i] === '\\' && i + 1 < len) {
                        // Escape sequence
                        emit(code[i]); advance();
                        emit(code[i]); advance();
                    } else if (code[i] === '[') {
                        // Character class - copy until ]
                        emit(code[i]); advance();
                        while (i < len && code[i] !== ']') {
                            if (code[i] === '\\' && i + 1 < len) {
                                emit(code[i]); advance();
                                emit(code[i]); advance();
                            } else {
                                emit(code[i]); advance();
                            }
                        }
                        if (i < len) {
                            emit(code[i]); advance(); // ]
                        }
                    } else if (code[i] === '/') {
                        // End of regex
                        emit(code[i]); advance();
                        // Copy flags
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

        // Preserve string literals exactly (with whitespace collapsing for html``)
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
                const needsSpace =
                    (/[a-zA-Z0-9_$]/.test(lastChar) && /[a-zA-Z0-9_$]/.test(nextChar)) ||
                    (lastChar === ')' && /[a-zA-Z_$]/.test(nextChar)) ||
                    (/[a-zA-Z_$]/.test(lastChar) && nextChar === '(');

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

    // Finalize mappings
    if (generateMap && currentLineMappings.length > 0) {
        mappings.push(currentLineMappings.join(','));
    }

    const output = { code: result };

    if (generateMap) {
        if (fileMap && fileMap.length > 0) {
            // Multi-file source map
            output.map = {
                version: 3,
                sources: fileMap.map(f => f.file),
                sourcesContent: fileMap.map(f => f.content),
                names: namesArray,
                mappings: mappings.join(';')
            };
        } else {
            // Single-file source map (caller fills in sources)
            output.map = {
                version: 3,
                sources: [],
                sourcesContent: [code],
                names: namesArray,
                mappings: mappings.join(';')
            };
        }
    }

    return output;
}

/**
 * Resolve the actual local binding name for an export
 * Traces through re-exports to find the original binding
 */
function resolveExportBinding(exportName, sourceModule, modules, baseDir, visited = new Set()) {
    // Prevent infinite loops in circular re-exports
    const key = `${sourceModule.filePath}:${exportName}`;
    if (visited.has(key)) return exportName;
    visited.add(key);

    // Find the export in the source module
    const exp = sourceModule.exports.find(e =>
        e.alias === exportName || (!e.alias && e.name === exportName)
    );

    if (!exp) {
        // Not found - return original name
        return exportName;
    }

    // If this export is aliased (e.g., createElement as h), the actual binding is exp.name
    const actualName = exp.name;

    // If it's a re-export, trace further
    if (exp.isReExport && exp.reExportSource) {
        const depPath = resolveImportPath(
            path.resolve(baseDir, sourceModule.filePath),
            exp.reExportSource,
            baseDir
        );

        if (depPath && modules.has(depPath)) {
            const depModule = modules.get(depPath);
            return resolveExportBinding(actualName, depModule, modules, baseDir, visited);
        }
    }

    return actualName;
}

/**
 * Generate namespace object for namespace imports
 */
function generateNamespaceObject(module, namespaceName) {
    const exports = module.exports
        .filter(e => !e.isDefault && !e.isReExport)
        .map(e => `    ${e.alias || e.name}: ${e.name}`)
        .join(',\n');

    return `const ${namespaceName} = {\n${exports}\n};\n`;
}

/**
 * Generate the final bundle
 * Returns { bundle, fileMap } where fileMap tracks original file positions
 */
function generateBundle(modules, sortedFiles, entryFile, baseDir, keepComments, verbose, compact, tabs) {
    const entryModule = modules.get(entryFile);

    // Track file positions for source maps
    // Each entry: { file, startLine, endLine, content }
    const fileMap = [];
    let currentLine = 0;

    function countLines(str) {
        return (str.match(/\n/g) || []).length;
    }

    // Header - minimal in compact mode
    let bundle = compact
        ? `/*! ESM Bundle | ${new Date().toISOString().split('T')[0]} */\n`
        : `/**
 * ESM Bundle
 * Generated: ${new Date().toISOString()}
 * Entry: ${entryFile}
 */

`;
    currentLine += countLines(bundle);

    // Track defined names to detect duplicates
    const definedNames = new Map();

    // Collect all import aliases that need const declarations
    // Maps localName -> actualBindingName
    const importAliases = new Map();

    // First pass: collect import aliases from all modules
    for (const [filePath, module] of modules) {
        if (module.usedExports.size === 0 && filePath !== entryFile) {
            continue;
        }

        for (const imp of module.imports) {
            const depPath = resolveImportPath(
                path.resolve(baseDir, filePath),
                imp.source,
                baseDir
            );

            if (!depPath || !modules.has(depPath)) continue;
            const depModule = modules.get(depPath);

            // Handle named imports with aliases: import { foo as bar }
            for (const spec of imp.specifiers) {
                if (spec.local !== spec.imported) {
                    // Local name differs from imported name
                    // Resolve the actual binding name through the export chain
                    const actualBinding = resolveExportBinding(spec.imported, depModule, modules, baseDir);
                    if (actualBinding !== spec.local) {
                        importAliases.set(spec.local, actualBinding);
                    }
                } else {
                    // Same name, but might be an alias in the source module
                    // e.g., import { h } where h is exported as createElement as h
                    const actualBinding = resolveExportBinding(spec.imported, depModule, modules, baseDir);
                    if (actualBinding !== spec.imported) {
                        importAliases.set(spec.imported, actualBinding);
                    }
                }
            }
        }
    }

    // Generate alias declarations
    if (importAliases.size > 0 && !compact) {
        const aliasCode = `// Import aliases\n` +
            [...importAliases].map(([local, actual]) => `const ${local} = ${actual};`).join('\n') + `\n\n`;
        bundle += aliasCode;
        currentLine += countLines(aliasCode);
    } else if (importAliases.size > 0) {
        for (const [localName, actualBinding] of importAliases) {
            bundle += `const ${localName}=${actualBinding};`;
        }
    }

    // Process modules in dependency order
    for (const filePath of sortedFiles) {
        const module = modules.get(filePath);

        // Skip modules with no used exports (tree shaking)
        if (module.usedExports.size === 0 && filePath !== entryFile) {
            continue;
        }

        // Store original content for source map (before any processing)
        const originalContent = module.content;

        let code = module.content;

        // Don't strip comments here - they'll be stripped by minifyCode
        // This preserves comments in the source map's sourcesContent

        // Remove import/export statements
        code = stripImportsExports(code);

        // Function-level tree shaking
        code = treeshakeCode(code, module.usedExports, verbose);

        // Handle namespace imports
        for (const imp of module.imports) {
            if (imp.namespace) {
                const depPath = resolveImportPath(
                    path.resolve(baseDir, filePath),
                    imp.source,
                    baseDir
                );

                if (depPath && modules.has(depPath)) {
                    const depModule = modules.get(depPath);
                    code = generateNamespaceObject(depModule, imp.namespace) + code;
                }
            }
        }

        // Detect duplicate function declarations
        const funcRegex = /^function\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
        let match;
        while ((match = funcRegex.exec(code)) !== null) {
            const funcName = match[1];
            if (definedNames.has(funcName)) {
                console.log(`  ⚠ Duplicate '${funcName}' in ${path.basename(filePath)} (first in ${path.basename(definedNames.get(funcName))})`);
            } else {
                definedNames.set(funcName, filePath);
            }
        }

        // Add section marker (skip in compact mode)
        if (!compact) {
            const basename = path.basename(filePath);
            const parentDir = path.basename(path.dirname(filePath));
            const label = parentDir && parentDir !== '.' ? `${parentDir}/${basename}` : basename;
            const marker = `\n// ============= ${label} =============\n`;
            bundle += marker;
            currentLine += countLines(marker);
        }

        // Track file position for source map
        const codeToAdd = code.trim() + '\n';
        const startLine = currentLine;
        fileMap.push({
            file: filePath,
            startLine: startLine,
            endLine: startLine + countLines(codeToAdd),
            content: codeToAdd  // Processed code (what's in the bundle) - lines must match!
        });

        bundle += codeToAdd;
        currentLine += countLines(codeToAdd);
    }

    // Collect public exports from entry file
    // Each export is {localBinding, publicName} where:
    // - localBinding is the actual variable/function name in the bundled code
    // - publicName is the name it should be exported as
    const publicExports = [];
    for (const exp of entryModule.exports) {
        if (exp.isReExport && exp.name === '*') {
            // Re-export all - include all exports from source
            const depPath = resolveImportPath(
                path.resolve(baseDir, entryFile),
                exp.reExportSource,
                baseDir
            );

            if (depPath && modules.has(depPath)) {
                const depModule = modules.get(depPath);
                for (const depExp of depModule.exports) {
                    if (!depExp.isDefault) {
                        // The public name is the alias (or name if no alias)
                        const publicName = depExp.alias || depExp.name;
                        // Trace to find the actual local binding
                        const localBinding = resolveExportBinding(publicName, depModule, modules, baseDir);
                        publicExports.push({ localBinding, publicName });
                    }
                }
            }
        } else if (exp.isReExport) {
            // Re-export: export { foo } from './source' or export { foo as bar } from './source'
            // The public name is exp.alias (if present) or exp.name
            const publicName = exp.alias || exp.name;

            // Trace through the re-export chain to find the actual local binding
            const depPath = resolveImportPath(
                path.resolve(baseDir, entryFile),
                exp.reExportSource,
                baseDir
            );

            if (depPath && modules.has(depPath)) {
                const depModule = modules.get(depPath);
                // Look up exp.name (what we're importing) in the source module
                const localBinding = resolveExportBinding(exp.name, depModule, modules, baseDir);
                publicExports.push({ localBinding, publicName });
            } else {
                // Fallback if source not found
                publicExports.push({ localBinding: exp.name, publicName });
            }
        } else {
            // Direct export - local binding is the name, public name is alias or name
            const publicName = exp.alias || exp.name;
            publicExports.push({ localBinding: exp.name, publicName });
        }
    }

    // Add public exports
    if (publicExports.length > 0) {
        // Deduplicate by the public name
        const seen = new Set();
        const uniqueExports = publicExports.filter(e => {
            if (seen.has(e.publicName)) return false;
            seen.add(e.publicName);
            return true;
        });

        if (!compact) {
            bundle += `\n// ============= Public API =============\n`;
            bundle += `export {\n`;
            for (const exp of uniqueExports) {
                if (exp.localBinding !== exp.publicName) {
                    // Aliased export: export { createElement as h }
                    bundle += `    ${exp.localBinding} as ${exp.publicName},\n`;
                } else {
                    bundle += `    ${exp.localBinding},\n`;
                }
            }
            bundle += `};\n`;
        } else {
            // Compact export format
            const exportParts = uniqueExports.map(exp => {
                if (exp.localBinding !== exp.publicName) {
                    return `${exp.localBinding} as ${exp.publicName}`;
                }
                return exp.localBinding;
            });
            bundle += `export{${exportParts.join(',')}};\n`;
        }
    }

    // Clean up whitespace - only remove trailing spaces from lines
    // Don't collapse multiple newlines as this would invalidate source map line numbers
    bundle = bundle.replace(/^[ \t]+$/gm, '');

    // Tabs mode: convert leading spaces to tabs (smaller but still debuggable)
    if (tabs && !compact) {
        bundle = bundle.replace(/^( {2})+/gm, m => '\t'.repeat(m.length / 2));
        // Also convert 4-space indents
        bundle = bundle.replace(/^(\t*)( {4})+/gm, (m, tabs, spaces) => {
            const tabCount = (tabs ? tabs.length : 0) + (m.length - (tabs ? tabs.length : 0)) / 4;
            return '\t'.repeat(tabCount);
        });
    }

    return { bundle, fileMap };
}

/**
 * Bundle a single entry file (custom mode)
 */
function bundleSingleFile(options) {
    const baseDir = process.cwd();
    const entryFile = path.relative(baseDir, path.resolve(baseDir, options.entry));
    const outputFile = path.resolve(baseDir, options.output);

    console.log('ESM Bundler with Tree Shaking\n');
    console.log(`Entry: ${entryFile}`);
    console.log(`Output: ${outputFile}\n`);

    // Discover dependencies
    console.log('Discovering dependencies...');
    const modules = discoverDependencies(entryFile, baseDir, options.verbose);
    console.log(`  Found ${modules.size} modules\n`);

    // Mark used exports (tree shaking)
    console.log('Analyzing exports...');
    markUsedExports(modules, entryFile, baseDir, options.verbose);

    // Count modules that will be included
    let includedCount = 0;
    for (const [filePath, module] of modules) {
        if (module.usedExports.size > 0 || filePath === entryFile) {
            includedCount++;
        }
    }
    console.log(`  ${includedCount} modules have used exports\n`);

    // Topological sort
    console.log('Sorting dependencies...');
    const sortedFiles = topologicalSort(modules, options.verbose);
    console.log(`  Sorted ${sortedFiles.length} modules\n`);

    // Generate bundle
    console.log('Generating bundle...');
    const { bundle, fileMap } = generateBundle(
        modules,
        sortedFiles,
        entryFile,
        baseDir,
        options.keepComments,
        options.verbose,
        options.compact,
        options.tabs
    );
    let bundleContent = bundle;

    // Minification (compact or sourcemap mode)
    let sourceMap = null;
    if (options.compact) {
        console.log('Minifying...');

        if (options.sourcemap) {
            // When generating source maps, skip embedded content minification
            // to ensure accurate position mapping. The source map's sourcesContent
            // contains original source, so mappings must point to original positions.
            const minified = minifyCode(bundleContent, true, fileMap);
            bundleContent = minified.code;
            sourceMap = minified.map;
            sourceMap.file = path.basename(outputFile);
            bundleContent += `\n//# sourceMappingURL=${path.basename(outputFile)}.map\n`;
        } else {
            // Without source maps, minify everything for smallest size
            bundleContent = minifyEmbeddedContent(bundleContent);
            const minified = minifyCode(bundleContent, false, null);
            bundleContent = minified.code;
        }
    }

    // Ensure output directory exists
    const outputDir = path.dirname(outputFile);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write output
    fs.writeFileSync(outputFile, bundleContent);

    // Write source map if generated
    if (sourceMap) {
        const mapFile = outputFile + '.map';
        fs.writeFileSync(mapFile, JSON.stringify(sourceMap));
        console.log(`  Source map: ${mapFile}`);
    }

    console.log(`\n✓ Bundle created: ${outputFile}`);
    console.log(`  Size: ${(bundleContent.length / 1024).toFixed(2)} KB`);
    console.log('  Done!\n');
}

/**
 * Process a simple file (router, utils) - minify with source map
 * @param {string} srcPath - Source file path
 * @param {string} destPath - Destination path (minified output)
 */
function processSimpleFile(srcPath, destPath) {
    // Read source file (keep original formatting for source map)
    const originalContent = fs.readFileSync(srcPath, 'utf-8');

    // Minify JS with source map, skipping embedded content minification
    // to ensure accurate position mapping. The source map will contain
    // the original source for debugging.
    const minified = minifyCode(originalContent, true);
    let minContent = minified.code;

    // Setup source map - sources points to a virtual readable file
    const sourceMap = minified.map;
    const baseName = path.basename(destPath);
    sourceMap.file = baseName;
    sourceMap.sources = [baseName];  // Source map references same filename (content embedded)
    sourceMap.sourcesContent = [originalContent];  // Embed original source

    // Add sourceMappingURL
    minContent += `\n//# sourceMappingURL=${baseName}.map\n`;

    // Write minified file
    fs.writeFileSync(destPath, minContent);

    // Write source map
    fs.writeFileSync(destPath + '.map', JSON.stringify(sourceMap));

    return {
        readable: originalContent.length,
        minified: minContent.length
    };
}

/**
 * Default mode: bundle all framework files
 * Outputs minified files with source maps (readable source embedded in map)
 */
function bundleAll(verbose) {
    const baseDir = process.cwd();
    const distDir = path.join(baseDir, 'app', 'dist');

    console.log('ESM Bundler - Default Mode\n');
    console.log('Building all framework files...\n');

    // Ensure dist directory exists
    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
    }

    // === 1. Bundle framework.js ===
    console.log('=== framework.js ===');
    const frameworkEntry = 'app/lib/framework.js';

    // Discover dependencies
    const modules = discoverDependencies(frameworkEntry, baseDir, verbose);
    console.log(`  Discovered ${modules.size} modules`);

    // Mark used exports (tree shaking)
    markUsedExports(modules, frameworkEntry, baseDir, verbose);

    // Topological sort
    const sortedFiles = topologicalSort(modules, verbose);

    // Generate readable bundle (with comments, section markers, no tabs for source map)
    const { bundle: frameworkReadable, fileMap } = generateBundle(
        modules,
        sortedFiles,
        frameworkEntry,
        baseDir,
        true,   // keepComments
        verbose,
        false,  // NOT compact (we want section markers)
        false   // no tabs (source map needs original formatting)
    );
    console.log(`  Readable: ${(frameworkReadable.length / 1024).toFixed(2)} KB`);
    console.log(`  Sources: ${fileMap.length} files`);

    // Minify with source map (pass fileMap for multi-file source map)
    const frameworkMinified = minifyCode(frameworkReadable, true, fileMap);
    let frameworkContent = frameworkMinified.code;

    // Setup source map - sources and sourcesContent already set from fileMap
    const frameworkMap = frameworkMinified.map;
    frameworkMap.file = 'framework.js';

    // Add sourceMappingURL
    frameworkContent += `\n//# sourceMappingURL=framework.js.map\n`;

    // Write minified bundle and source map
    const frameworkPath = path.join(distDir, 'framework.js');
    fs.writeFileSync(frameworkPath, frameworkContent);
    fs.writeFileSync(frameworkPath + '.map', JSON.stringify(frameworkMap));
    console.log(`  ✓ framework.js (${(frameworkContent.length / 1024).toFixed(2)} KB) + .map`);

    // === 2. Process router.js ===
    console.log('\n=== router.js ===');
    const routerSizes = processSimpleFile(
        path.join(baseDir, 'app', 'lib', 'router.js'),
        path.join(distDir, 'router.js')
    );
    console.log(`  Readable: ${(routerSizes.readable / 1024).toFixed(2)} KB`);
    console.log(`  ✓ router.js (${(routerSizes.minified / 1024).toFixed(2)} KB) + .map`);

    // === 3. Process utils.js ===
    console.log('\n=== utils.js ===');
    const utilsSizes = processSimpleFile(
        path.join(baseDir, 'app', 'lib', 'utils.js'),
        path.join(distDir, 'utils.js')
    );
    console.log(`  Readable: ${(utilsSizes.readable / 1024).toFixed(2)} KB`);
    console.log(`  ✓ utils.js (${(utilsSizes.minified / 1024).toFixed(2)} KB) + .map`);

    // === 4. Process opt.js ===
    console.log('\n=== opt.js ===');
    const optSizes = processSimpleFile(
        path.join(baseDir, 'app', 'lib', 'opt.js'),
        path.join(distDir, 'opt.js')
    );
    console.log(`  Readable: ${(optSizes.readable / 1024).toFixed(2)} KB`);
    console.log(`  ✓ opt.js (${(optSizes.minified / 1024).toFixed(2)} KB) + .map`);

    // Summary
    console.log('\n=== Summary ===');
    console.log(`  Output directory: ${distDir}`);
    console.log('  Files generated:');
    console.log('    framework.js + framework.js.map');
    console.log('    router.js + router.js.map');
    console.log('    utils.js + utils.js.map');
    console.log('    opt.js + opt.js.map');
    console.log('\n  Source maps contain embedded readable source for debugging.');
    console.log('\n✓ Done!\n');
}

/**
 * Main bundler entry point
 */
function main() {
    const options = parseArgs();

    // If no entry/output specified, run in default mode (bundle all)
    if (!options.entry || !options.output) {
        bundleAll(options.verbose);
    } else {
        bundleSingleFile(options);
    }
}

main();
