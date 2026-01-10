/**
 * mrepo Test Helper Utilities
 *
 * Provides Puppeteer-based test utilities for the mrepo music streaming application.
 * Follows the vdx-web test architecture pattern.
 */

const puppeteer = require('puppeteer');

const BASE_URL = process.env.TEST_URL || 'http://127.0.0.1:9900';
const VIEWPORT = { width: 1280, height: 800 };
const CREDENTIALS = { username: 'testuser', password: 'testuser' };

class TestHelper {
    constructor() {
        this.browser = null;
        this.page = null;
        this.testsPassed = 0;
        this.testsFailed = 0;
        this.currentTest = '';
        this.consoleErrors = [];
        this.pageErrors = [];
    }

    // ==================== Lifecycle Methods ====================

    async setup() {
        this.browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--autoplay-policy=no-user-gesture-required'
            ]
        });

        this.page = await this.browser.newPage();
        await this.page.setViewport(VIEWPORT);

        // Setup error handlers
        this.page.on('pageerror', error => {
            this.pageErrors.push({ message: error.message, stack: error.stack });
            console.error(`[PAGE ERROR] ${error.message}`);
        });

        this.page.on('console', msg => {
            if (msg.type() === 'error') {
                const text = msg.text();
                // Ignore some common non-critical errors
                if (!text.includes('favicon.ico') &&
                    !text.includes('ResizeObserver loop') &&
                    !text.includes('net::ERR_FAILED')) {
                    this.consoleErrors.push(text);
                    console.error(`[CONSOLE ERROR] ${text}`);
                }
            }
        });

        await this.page.goto(BASE_URL, { waitUntil: 'networkidle2' });
        await this.page.waitForTimeout(500);
    }

    async teardown() {
        if (this.browser) {
            await this.browser.close();
        }

        console.log('\nTest Results:');
        console.log(`  Passed: ${this.testsPassed} ✅`);
        console.log(`  Failed: ${this.testsFailed} ${this.testsFailed > 0 ? '❌' : ''}`);

        if (this.testsFailed > 0) {
            process.exit(1);
        }
    }

    // ==================== Test Execution ====================

    async test(name, fn) {
        this.currentTest = name;
        // Clear errors for each test
        this.consoleErrors = [];
        this.pageErrors = [];

        try {
            await fn();
            console.log(`  ✅ ${name}`);
            this.testsPassed++;
        } catch (error) {
            console.error(`  ❌ ${name}`);
            console.error(`     ${error.message}`);
            // Take screenshot on failure
            await this.screenshot(this.currentTest.replace(/[^a-z0-9]/gi, '-').toLowerCase());
            this.testsFailed++;
        }
    }

    // ==================== Assertions ====================

    async assert(condition, message) {
        if (!condition) {
            throw new Error(message || 'Assertion failed');
        }
    }

    async assertEqual(actual, expected, message) {
        if (actual !== expected) {
            throw new Error(message || `Expected "${expected}", got "${actual}"`);
        }
    }

    async assertNotEqual(actual, expected, message) {
        if (actual === expected) {
            throw new Error(message || `Expected value to not equal "${expected}"`);
        }
    }

    async assertGreaterThan(actual, expected, message) {
        if (actual <= expected) {
            throw new Error(message || `Expected ${actual} > ${expected}`);
        }
    }

    async assertExists(selector, message, timeout = 5000) {
        try {
            await this.page.waitForSelector(selector, { timeout });
        } catch (error) {
            throw new Error(message || `Element ${selector} not found`);
        }
    }

    async assertNotExists(selector, message, timeout = 2000) {
        try {
            await this.page.waitForSelector(selector, { hidden: true, timeout });
        } catch (error) {
            throw new Error(message || `Element ${selector} should not exist`);
        }
    }

    async assertVisible(selector, message, timeout = 5000) {
        try {
            await this.page.waitForSelector(selector, { visible: true, timeout });
        } catch (error) {
            throw new Error(message || `Element ${selector} not visible`);
        }
    }

    async assertHidden(selector, message, timeout = 5000) {
        try {
            await this.page.waitForSelector(selector, { hidden: true, timeout });
        } catch (error) {
            throw new Error(message || `Element ${selector} should be hidden`);
        }
    }

    async assertTextContains(selector, text, message) {
        const content = await this.getText(selector);
        if (!content.includes(text)) {
            throw new Error(message || `Expected "${selector}" to contain "${text}", got "${content}"`);
        }
    }

    async assertNoConsoleErrors(ignorePatterns = []) {
        const filteredErrors = this.consoleErrors.filter(e =>
            !ignorePatterns.some(pattern =>
                typeof pattern === 'string' ? e.includes(pattern) : pattern.test(e)
            )
        );
        if (filteredErrors.length > 0) {
            throw new Error(`Console errors found:\n${filteredErrors.join('\n')}`);
        }
    }

    // ==================== Navigation ====================

    async goto(route) {
        const fullUrl = `${BASE_URL}/#${route}`;
        await this.page.goto(fullUrl, { waitUntil: 'networkidle2' });
        await this.page.waitForTimeout(300);
    }

    async getRoute() {
        return await this.page.evaluate(() => {
            const hash = window.location.hash;
            return hash.startsWith('#') ? hash.slice(1) : hash;
        });
    }

    async waitForRoute(route, timeout = 5000) {
        await this.page.waitForFunction(
            (expectedRoute) => {
                const hash = window.location.hash;
                return hash === `#${expectedRoute}` || hash.startsWith(`#${expectedRoute}?`);
            },
            { timeout },
            route
        );
    }

    async navigateViaMenu(menuText) {
        // Click on menu item by text content
        await this.page.evaluate((text) => {
            const menuItems = document.querySelectorAll('.cl-menu-item, .menu-item');
            for (const item of menuItems) {
                if (item.textContent.includes(text)) {
                    item.click();
                    return true;
                }
            }
            return false;
        }, menuText);
        await this.page.waitForTimeout(500);
    }

    // ==================== Authentication ====================

    async login(credentials = CREDENTIALS) {
        // First navigate to login page
        await this.goto('/login/');

        // Wait for login form - try multiple selectors
        try {
            await this.page.waitForSelector('#username', { timeout: 5000 });
        } catch {
            // May already be authenticated, check for user-badge
            const isAuth = await this.page.evaluate(() => {
                return document.querySelector('.user-badge') !== null;
            });
            if (isAuth) {
                return; // Already logged in
            }
            throw new Error('Login form not found');
        }

        // Clear fields first and type credentials
        await this.page.evaluate(() => {
            const usernameInput = document.querySelector('#username');
            const passwordInput = document.querySelector('#password');
            if (usernameInput) usernameInput.value = '';
            if (passwordInput) passwordInput.value = '';
        });

        await this.page.type('#username', credentials.username);
        await this.page.type('#password', credentials.password);

        // Submit form directly by dispatching submit event
        await this.page.evaluate(() => {
            const form = document.querySelector('form.login-form');
            if (form) {
                const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
                form.dispatchEvent(submitEvent);
            }
        });

        // Wait for navigation (page will reload after successful login)
        // The login page does: window.location.hash = '/'; window.location.reload();
        try {
            await this.page.waitForNavigation({
                waitUntil: 'networkidle2',
                timeout: 15000
            });
        } catch {
            // Navigation might have already completed
        }

        // Wait for app to fully load with authenticated state
        await this.page.waitForSelector('cl-shell', { timeout: 10000 });

        // Wait for user-badge to confirm login (indicates authenticated)
        try {
            await this.page.waitForSelector('.user-badge', { timeout: 5000 });
        } catch {
            // May still be loading, give it more time
            await this.page.waitForTimeout(1000);
        }

        await this.page.waitForTimeout(500);

        // Clear any console errors that occurred before/during login
        // These are expected (unauthorized requests before login completes)
        this.consoleErrors = [];
        this.pageErrors = [];
    }

    async logout() {
        // Call logout API
        await this.page.evaluate(async () => {
            try {
                await fetch('/api/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ method: 'auth_logout', kwargs: {}, version: 2 })
                });
            } catch (e) {
                console.error('Logout API error:', e);
            }
            localStorage.clear();
            sessionStorage.clear();
        });
        await this.page.reload({ waitUntil: 'networkidle2' });
        await this.page.waitForTimeout(500);
    }

    async isAuthenticated() {
        return await this.page.evaluate(() => {
            const userBadge = document.querySelector('.user-badge');
            return userBadge !== null;
        });
    }

    // ==================== Element Interaction ====================

    async click(selector) {
        await this.page.waitForSelector(selector, { timeout: 5000 });
        await this.page.click(selector);
    }

    async clickByText(text, tag = '*') {
        await this.page.evaluate((searchText, searchTag) => {
            const elements = document.querySelectorAll(searchTag);
            for (const el of elements) {
                if (el.textContent.trim() === searchText || el.textContent.includes(searchText)) {
                    el.click();
                    return true;
                }
            }
            return false;
        }, text, tag);
    }

    async type(selector, text) {
        await this.page.waitForSelector(selector, { timeout: 5000 });
        await this.page.type(selector, text);
    }

    async clearAndType(selector, text) {
        await this.page.waitForSelector(selector, { timeout: 5000 });
        await this.page.click(selector, { clickCount: 3 });
        await this.page.type(selector, text);
    }

    async select(selector, value) {
        await this.page.waitForSelector(selector, { timeout: 5000 });
        await this.page.select(selector, value);
    }

    async getText(selector) {
        await this.page.waitForSelector(selector, { timeout: 5000 });
        return await this.page.$eval(selector, el => el.textContent.trim());
    }

    async getValue(selector) {
        await this.page.waitForSelector(selector, { timeout: 5000 });
        return await this.page.$eval(selector, el => el.value);
    }

    async getAttribute(selector, attribute) {
        await this.page.waitForSelector(selector, { timeout: 5000 });
        return await this.page.$eval(selector, (el, attr) => el.getAttribute(attr), attribute);
    }

    async isVisible(selector) {
        try {
            await this.page.waitForSelector(selector, { visible: true, timeout: 1000 });
            return true;
        } catch {
            return false;
        }
    }

    async waitForElement(selector, timeout = 5000) {
        await this.page.waitForSelector(selector, { timeout });
    }

    async waitForElementHidden(selector, timeout = 5000) {
        await this.page.waitForSelector(selector, { hidden: true, timeout });
    }

    async countElements(selector) {
        return await this.page.$$eval(selector, els => els.length);
    }

    async rightClick(selector) {
        await this.page.waitForSelector(selector, { timeout: 5000 });
        await this.page.click(selector, { button: 'right' });
    }

    async pressKey(key) {
        await this.page.keyboard.press(key);
    }

    async scrollTo(selector) {
        await this.page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
        }, selector);
        await this.page.waitForTimeout(300);
    }

    async scrollDown(selector, pixels = 500) {
        await this.page.evaluate((sel, px) => {
            const el = document.querySelector(sel) || document.documentElement;
            el.scrollTop += px;
        }, selector, pixels);
        await this.page.waitForTimeout(300);
    }

    // ==================== Player/Media Methods ====================

    async getPlayerState() {
        return await this.page.evaluate(() => {
            // Try to access player store through global or page element
            const nowPlaying = document.querySelector('now-playing-page');
            const miniPlayer = document.querySelector('mini-player');

            // Try to get state from the store
            try {
                // Access via window if exposed
                if (window.playerStore) {
                    const state = window.playerStore.state;
                    return {
                        isPlaying: state.isPlaying,
                        currentSong: state.currentSong,
                        queueLength: state.queue?.length || 0,
                        queueIndex: state.queueIndex,
                        volume: state.volume,
                        muted: state.muted,
                        shuffle: state.shuffle,
                        repeatMode: state.repeatMode,
                        scaEnabled: state.scaEnabled
                    };
                }
            } catch (e) {
                // Fallback: get what we can from DOM
            }

            // DOM-based state detection
            const playBtn = document.querySelector('.play-btn, .ctrl-btn.play-btn');
            const isPlaying = playBtn?.classList?.contains('playing') ||
                              playBtn?.querySelector('[data-playing]') !== null;

            const queueItems = document.querySelectorAll('.queue-item, .queue-song');
            const currentSongEl = document.querySelector('.current-song-title, .song-title');

            return {
                isPlaying,
                currentSong: currentSongEl ? { title: currentSongEl.textContent } : null,
                queueLength: queueItems.length,
                queueIndex: null,
                volume: null,
                muted: null,
                shuffle: null,
                repeatMode: null,
                scaEnabled: null
            };
        });
    }

    async getQueueLength() {
        const state = await this.getPlayerState();
        return state.queueLength;
    }

    async getCurrentSong() {
        const state = await this.getPlayerState();
        return state.currentSong;
    }

    async getAudioElementState() {
        return await this.page.evaluate(() => {
            const audio = document.querySelector('audio');
            if (!audio) return null;

            return {
                paused: audio.paused,
                currentTime: audio.currentTime,
                duration: audio.duration,
                readyState: audio.readyState,
                volume: audio.volume,
                muted: audio.muted,
                src: audio.src ? 'present' : 'missing'
            };
        });
    }

    async waitForAudioPlaying(timeout = 15000) {
        await this.page.waitForFunction(
            () => {
                const audio = document.querySelector('audio');
                return audio && !audio.paused && audio.readyState >= 2;
            },
            { timeout }
        );
    }

    async waitForAudioPaused(timeout = 5000) {
        await this.page.waitForFunction(
            () => {
                const audio = document.querySelector('audio');
                return !audio || audio.paused;
            },
            { timeout }
        );
    }

    // ==================== API Helpers ====================

    async waitForApiCall(method, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.page.off('response', handler);
                reject(new Error(`Timeout waiting for API call: ${method}`));
            }, timeout);

            const handler = async (response) => {
                if (response.url().includes('/api/')) {
                    try {
                        const request = response.request();
                        const postData = request.postData();
                        if (postData) {
                            const body = JSON.parse(postData);
                            if (body.method === method) {
                                clearTimeout(timeoutId);
                                this.page.off('response', handler);
                                try {
                                    const json = await response.json();
                                    resolve(json);
                                } catch {
                                    resolve(null);
                                }
                            }
                        }
                    } catch (e) {
                        // Ignore parse errors
                    }
                }
            };

            this.page.on('response', handler);
        });
    }

    // ==================== Utility Methods ====================

    async screenshot(name) {
        const safeName = name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
        await this.page.screenshot({
            path: `/tmp/mrepo-${safeName}.png`,
            fullPage: false
        });
        console.log(`     Screenshot saved: /tmp/mrepo-${safeName}.png`);
    }

    async wait(ms) {
        await this.page.waitForTimeout(ms);
    }

    async evaluate(fn, ...args) {
        return await this.page.evaluate(fn, ...args);
    }

    // Helper to find elements inside shadow DOM
    async queryShadow(hostSelector, innerSelector) {
        return await this.page.evaluate((host, inner) => {
            const hostEl = document.querySelector(host);
            if (!hostEl || !hostEl.shadowRoot) return null;
            const innerEl = hostEl.shadowRoot.querySelector(inner);
            return innerEl ? true : null;
        }, hostSelector, innerSelector);
    }

    // Assert element exists inside shadow DOM
    async assertShadowExists(hostSelector, innerSelector, message) {
        const found = await this.queryShadow(hostSelector, innerSelector);
        if (!found) {
            throw new Error(message || `Element ${innerSelector} not found inside ${hostSelector}`);
        }
    }

    // Click element inside shadow DOM
    async clickShadow(hostSelector, innerSelector) {
        await this.page.evaluate((host, inner) => {
            const hostEl = document.querySelector(host);
            if (hostEl && hostEl.shadowRoot) {
                const innerEl = hostEl.shadowRoot.querySelector(inner);
                if (innerEl) innerEl.click();
            }
        }, hostSelector, innerSelector);
    }

    // Get all options from a dropdown
    async getSelectOptions(selector) {
        return await this.page.$$eval(`${selector} option`, options =>
            options.map(opt => ({ value: opt.value, text: opt.textContent.trim() }))
        );
    }

    // Check if a checkbox/toggle is checked
    async isChecked(selector) {
        return await this.page.$eval(selector, el => el.checked);
    }

    // Toggle a checkbox/toggle
    async toggleCheckbox(selector) {
        await this.page.click(selector);
        await this.page.waitForTimeout(200);
    }

    // Drag element from one position to another
    async drag(sourceSelector, targetSelector) {
        const source = await this.page.$(sourceSelector);
        const target = await this.page.$(targetSelector);

        if (!source || !target) {
            throw new Error('Drag source or target not found');
        }

        const sourceBox = await source.boundingBox();
        const targetBox = await target.boundingBox();

        await this.page.mouse.move(
            sourceBox.x + sourceBox.width / 2,
            sourceBox.y + sourceBox.height / 2
        );
        await this.page.mouse.down();
        await this.page.mouse.move(
            targetBox.x + targetBox.width / 2,
            targetBox.y + targetBox.height / 2,
            { steps: 10 }
        );
        await this.page.mouse.up();
        await this.page.waitForTimeout(300);
    }
}

module.exports = TestHelper;
