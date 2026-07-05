/**
 * Minimal static file server for Lane 1 (backend-free injection suites).
 *
 * Serves frontend/ as web root. The injection suites (queue-reorder, windowing)
 * import the live module-cache singletons and drive them directly, so no real
 * backend is needed — but the page must boot, so we synthesize /config.js and
 * answer /api/ POSTs with a harmless "no backend" envelope instead of a 501.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8',
};

function startStaticServer(rootDir) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const pathname = req.url.split('?')[0];
            // Answer the JSON-RPC endpoint (exactly /api/, POST) with a harmless
            // envelope. NOTE: must NOT hijack the real frontend module at
            // /api/music-api.js — only the bare POST endpoint.
            if (req.method === 'POST' && pathname === '/api/') {
                let body = '';
                req.on('data', (c) => (body += c));
                req.on('end', () => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'NoBackend' }));
                });
                return;
            }

            // Synthesize runtime config so window.MREPO_CONFIG is defined.
            if (req.url === '/config.js') {
                const js = 'window.MREPO_CONFIG = ' + JSON.stringify({
                    basePath: '', apiBase: '/api/', streamBase: '/stream/',
                    transcodeEnabled: false, transcodeFormats: [], setupRequired: false,
                }) + ';';
                res.writeHead(200, { 'Content-Type': 'text/javascript' });
                res.end(js);
                return;
            }

            let urlPath = decodeURIComponent(req.url.split('?')[0]);
            if (urlPath === '/') urlPath = '/index.html';

            const filePath = path.join(rootDir, urlPath);
            // Prevent path traversal outside the root.
            if (!filePath.startsWith(rootDir)) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }

            fs.readFile(filePath, (err, data) => {
                if (err) {
                    // SPA fallback for client-side routes.
                    if (!path.extname(urlPath)) {
                        fs.readFile(path.join(rootDir, 'index.html'), (e2, html) => {
                            if (e2) { res.writeHead(404); res.end('Not found'); return; }
                            res.writeHead(200, { 'Content-Type': MIME['.html'] });
                            res.end(html);
                        });
                        return;
                    }
                    res.writeHead(404);
                    res.end('Not found');
                    return;
                }
                const ext = path.extname(filePath).toLowerCase();
                res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
                res.end(data);
            });
        });

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({ server, port, url: `http://127.0.0.1:${port}` });
        });
    });
}

module.exports = { startStaticServer };
