#!/usr/bin/env node
/**
 * spider-deps.js - Dependency Spider for PWA Cache Manifest
 *
 * Discovers all JavaScript dependencies by parsing import statements.
 * Run before deploy: node spider-deps.js
 *
 * Output: cache-manifest.json with version, timestamp, and file list
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs';
import { dirname, resolve, join, relative, extname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const ENTRY_POINT = 'index.html';
const OUTPUT_FILE = 'cache-manifest.json';
const APP_ROOT = __dirname;
const PROJECT_ROOT = __dirname; // frontend directory is the deploy root

// Files to always include (even if not discovered via imports)
const ALWAYS_INCLUDE = [
    'index.html',
    'manifest.json',
    'noise-processor.js'  // AudioWorklet loaded dynamically
];

// Directories to scan for vendor files (include all files)
const VENDOR_DIRS = [
    'vendor/butterchurn'
];

// File extensions to cache
const CACHEABLE_EXTENSIONS = new Set(['.js', '.css', '.html', '.json', '.svg', '.png', '.jpg', '.woff', '.woff2']);

class DependencySpider {
    constructor() {
        this.discovered = new Set();
        this.visited = new Set();
        this.errors = [];
    }

    /**
     * Parse HTML file for script tags, link tags, and inline module imports
     */
    parseHtml(filePath) {
        const content = readFileSync(filePath, 'utf-8');
        const deps = [];

        // Find <script src="..."> and <script type="module" src="...">
        const scriptRegex = /<script[^>]+src=["']([^"']+)["'][^>]*>/gi;
        let match;
        while ((match = scriptRegex.exec(content)) !== null) {
            deps.push(match[1]);
        }

        // Find inline <script type="module">...</script> and parse for imports
        const inlineScriptRegex = /<script[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi;
        while ((match = inlineScriptRegex.exec(content)) !== null) {
            const scriptContent = match[1];
            // Parse imports from inline script
            const importRegex = /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
            let importMatch;
            while ((importMatch = importRegex.exec(scriptContent)) !== null) {
                deps.push(importMatch[1]);
            }
        }

        // Find <link rel="stylesheet" href="...">
        const linkRegex = /<link[^>]+href=["']([^"']+)["'][^>]*>/gi;
        while ((match = linkRegex.exec(content)) !== null) {
            const href = match[1];
            if (!href.startsWith('http')) {
                deps.push(href);
            }
        }

        return deps;
    }

    /**
     * Parse JavaScript file for import statements
     */
    parseJs(filePath) {
        const content = readFileSync(filePath, 'utf-8');
        const deps = [];

        // Static imports: import ... from '...'
        const staticImportRegex = /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
        let match;
        while ((match = staticImportRegex.exec(content)) !== null) {
            deps.push(match[1]);
        }

        // Re-exports: export { ... } from '...'
        const reExportRegex = /export\s+\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/g;
        while ((match = reExportRegex.exec(content)) !== null) {
            deps.push(match[1]);
        }

        // Export all: export * from '...'
        const exportAllRegex = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
        while ((match = exportAllRegex.exec(content)) !== null) {
            deps.push(match[1]);
        }

        // Dynamic imports: import('...')
        const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        while ((match = dynamicImportRegex.exec(content)) !== null) {
            deps.push(match[1]);
        }

        // Also check for fetch/XMLHttpRequest loading JSON configs
        // (common pattern for loading config files)
        const fetchRegex = /fetch\s*\(\s*['"]([^'"]+\.json)['"]/g;
        while ((match = fetchRegex.exec(content)) !== null) {
            deps.push(match[1]);
        }

        return deps;
    }

    /**
     * Resolve a dependency path relative to the importing file
     */
    resolvePath(dep, fromFile) {
        // Skip external URLs
        if (dep.startsWith('http://') || dep.startsWith('https://') || dep.startsWith('//')) {
            return null;
        }

        const fromDir = dirname(fromFile);

        // Resolve relative path
        let resolved;
        if (dep.startsWith('./') || dep.startsWith('../')) {
            resolved = resolve(fromDir, dep);
        } else if (dep.startsWith('/')) {
            // Absolute path from project root
            resolved = resolve(PROJECT_ROOT, dep.slice(1));
        } else {
            // Bare specifier - try relative first
            resolved = resolve(fromDir, dep);
        }

        // Ensure file exists
        if (!existsSync(resolved)) {
            // Try adding .js extension
            if (existsSync(resolved + '.js')) {
                resolved = resolved + '.js';
            } else {
                return null;
            }
        }

        return resolved;
    }

    /**
     * Recursively spider dependencies starting from a file
     */
    spider(filePath) {
        if (this.visited.has(filePath)) {
            return;
        }
        this.visited.add(filePath);

        if (!existsSync(filePath)) {
            this.errors.push(`File not found: ${filePath}`);
            return;
        }

        // Add to discovered files
        const ext = extname(filePath).toLowerCase();
        if (CACHEABLE_EXTENSIONS.has(ext)) {
            this.discovered.add(filePath);
        }

        // Parse based on file type
        let deps = [];
        try {
            if (ext === '.html') {
                deps = this.parseHtml(filePath);
            } else if (ext === '.js') {
                deps = this.parseJs(filePath);
            }
        } catch (err) {
            this.errors.push(`Error parsing ${filePath}: ${err.message}`);
            return;
        }

        // Resolve and spider each dependency
        for (const dep of deps) {
            const resolved = this.resolvePath(dep, filePath);
            if (resolved) {
                this.spider(resolved);
            }
        }
    }

    /**
     * Add all files from a vendor directory
     */
    addVendorDir(vendorPath) {
        const fullPath = resolve(APP_ROOT, vendorPath);
        if (!existsSync(fullPath)) {
            console.warn(`Vendor directory not found: ${vendorPath}`);
            return;
        }

        const addFilesRecursive = (dir) => {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = join(dir, entry.name);
                if (entry.isDirectory()) {
                    addFilesRecursive(entryPath);
                } else if (entry.isFile()) {
                    const ext = extname(entry.name).toLowerCase();
                    if (CACHEABLE_EXTENSIONS.has(ext)) {
                        this.discovered.add(entryPath);
                    }
                }
            }
        };

        addFilesRecursive(fullPath);
    }

    /**
     * Generate content hash for versioning
     */
    generateContentHash() {
        const hash = createHash('md5');
        const sortedFiles = [...this.discovered].sort();

        for (const file of sortedFiles) {
            try {
                const content = readFileSync(file);
                hash.update(content);
            } catch (err) {
                // Skip files that can't be read
            }
        }

        return hash.digest('hex').slice(0, 8);
    }

    /**
     * Convert absolute paths to URL paths relative to frontend root
     */
    toUrlPaths() {
        const urls = [];
        for (const file of this.discovered) {
            const relativePath = relative(PROJECT_ROOT, file);
            urls.push('/' + relativePath.replace(/\\/g, '/'));
        }
        return urls.sort();
    }

    /**
     * Run the spider and generate manifest
     */
    run() {
        console.log('Spidering dependencies...\n');

        // Start from entry point
        const entryPath = resolve(APP_ROOT, ENTRY_POINT);
        this.spider(entryPath);

        // Add always-included files
        for (const file of ALWAYS_INCLUDE) {
            const filePath = resolve(APP_ROOT, file);
            if (existsSync(filePath)) {
                this.discovered.add(filePath);
            }
        }

        // Add vendor directories
        for (const vendorDir of VENDOR_DIRS) {
            this.addVendorDir(vendorDir);
        }

        // Generate manifest
        const urls = this.toUrlPaths();
        const contentHash = this.generateContentHash();

        const manifest = {
            version: contentHash,
            timestamp: Date.now(),
            generatedAt: new Date().toISOString(),
            fileCount: urls.length,
            files: urls
        };

        // Write manifest
        const outputPath = resolve(APP_ROOT, OUTPUT_FILE);
        writeFileSync(outputPath, JSON.stringify(manifest, null, 2));

        // Report
        console.log(`Discovered ${urls.length} files`);
        console.log(`Content hash: ${contentHash}`);
        console.log(`Manifest written to: ${OUTPUT_FILE}\n`);

        if (this.errors.length > 0) {
            console.log('Warnings:');
            for (const err of this.errors) {
                console.log(`  - ${err}`);
            }
            console.log('');
        }

        // Group files by type for summary
        const byType = {};
        for (const url of urls) {
            const ext = extname(url) || 'other';
            byType[ext] = (byType[ext] || 0) + 1;
        }

        console.log('Files by type:');
        for (const [ext, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${ext}: ${count}`);
        }

        return manifest;
    }
}

// Run spider
const spider = new DependencySpider();
spider.run();
