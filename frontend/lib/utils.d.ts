/**
 * VDX-Web Utilities Type Definitions
 *
 * Common helpers for:
 * - Async operations (sleep, debounce, throttle)
 * - Memoization for expensive computations
 * - Notifications and toast messages
 * - Form helpers
 * - Event bus for cross-component communication
 * - localStorage persistence
 * - Dark theme management
 */

import type { Store } from './framework.js';

// =============================================================================
// Memoization
// =============================================================================

/**
 * Memoize a function based on its arguments.
 * Caches the result until arguments change.
 *
 * @param fn - Function to memoize that takes arguments
 * @returns Memoized function that caches results based on arguments
 *
 * @example
 * data() {
 *   return {
 *     items: [...],
 *     sortedItems: memoize((items) =>
 *       [...items].sort((a, b) => a.name.localeCompare(b.name))
 *     )
 *   };
 * }
 *
 * template() {
 *   const sorted = this.state.sortedItems(this.state.items);
 *   return html`...`;
 * }
 */
export function memoize<T, Args extends unknown[]>(
  fn: (...args: Args) => T
): (...args: Args) => T;

// =============================================================================
// Async Utilities
// =============================================================================

/**
 * Sleep/delay utility for async operations.
 *
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after specified time
 *
 * @example
 * async function demo() {
 *   console.log('Start');
 *   await sleep(1000);
 *   console.log('1 second later');
 * }
 */
export function sleep(ms: number): Promise<void>;

/**
 * Debounce function - delays execution until after delay has elapsed since last call.
 * Useful for search inputs, resize handlers, etc.
 *
 * @param fn - Function to debounce
 * @param delay - Delay in milliseconds (default: 300)
 * @returns Debounced function
 *
 * @example
 * const handleSearch = debounce((query: string) => {
 *   searchAPI(query);
 * }, 500);
 *
 * // Only calls searchAPI once, 500ms after user stops typing
 * input.addEventListener('input', e => handleSearch(e.target.value));
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay?: number
): (...args: Parameters<T>) => void;

/**
 * Throttle function - ensures function is called at most once per limit period.
 * Useful for scroll handlers, frequent updates.
 *
 * @param fn - Function to throttle
 * @param limit - Minimum time between calls in milliseconds (default: 300)
 * @returns Throttled function
 *
 * @example
 * const handleScroll = throttle(() => {
 *   updateScrollPosition();
 * }, 100);
 *
 * window.addEventListener('scroll', handleScroll);
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit?: number
): (...args: Parameters<T>) => void;

/**
 * Creates a function that batches calls to the next animation frame.
 * Multiple calls before the frame fires will only execute once.
 * Useful for scroll/resize handlers that need smooth 60fps updates.
 */
export function rafThrottle<T extends (...args: unknown[]) => unknown>(
  fn: T
): (...args: Parameters<T>) => void;

// =============================================================================
// Notifications
// =============================================================================

/**
 * Notification severity levels
 */
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

/**
 * A notification object
 */
export interface Notification {
  /** Unique notification ID */
  id: number;
  /** Notification message */
  message: string;
  /** Severity level */
  severity: NotificationSeverity;
  /** Creation timestamp */
  timestamp: number;
}

/**
 * Notifications store state
 */
export interface NotificationsState {
  list: Notification[];
}

/**
 * Reactive store containing current notifications.
 * Subscribe to display notifications in your UI.
 *
 * @example
 * notifications.subscribe(({ list }) => {
 *   console.log('Current notifications:', list);
 * });
 */
export const notifications: Store<NotificationsState>;

/**
 * Show a toast notification.
 *
 * @param message - Notification message
 * @param severity - Notification severity (default: 'info')
 * @param ttl - Time to live in seconds, 0 for persistent (default: 5)
 * @returns Notification ID (can be used with dismissNotification)
 *
 * @example
 * notify('Saved successfully!', 'success', 3);
 * notify('Error occurred', 'error', 5);
 *
 * const id = notify('Processing...', 'info', 0); // Persistent
 * dismissNotification(id); // Manually dismiss
 */
export function notify(
  message: string,
  severity?: NotificationSeverity,
  ttl?: number
): number;

/**
 * Dismiss a notification by ID.
 *
 * @param id - Notification ID (returned from notify())
 *
 * @example
 * const id = notify('Loading...', 'info', 0);
 * // Later:
 * dismissNotification(id);
 */
export function dismissNotification(id: number): void;

// =============================================================================
// Form Helpers
// =============================================================================

/**
 * Extract form data as object.
 *
 * @param formElement - Form element
 * @returns Form data as key-value pairs
 *
 * @example
 * const data = formData(formElement);
 * // { username: 'alice', email: 'alice@example.com' }
 */
export function formData(formElement: HTMLFormElement): Record<string, string>;

/**
 * Serialize form data as URL-encoded string.
 *
 * @param formElement - Form element
 * @returns URL-encoded form data
 *
 * @example
 * const encoded = serializeForm(formElement);
 * // "username=alice&email=alice%40example.com"
 */
export function serializeForm(formElement: HTMLFormElement): string;

/**
 * Fetch JSON with better error handling.
 *
 * @param url - URL to fetch
 * @param options - Fetch options
 * @returns Parsed JSON response
 * @throws Error with HTTP status on failure
 *
 * @example
 * try {
 *   const data = await fetchJSON('/api/users');
 * } catch (error) {
 *   console.error('Failed:', error.message); // "HTTP 404: Not Found"
 * }
 */
export function fetchJSON<T = unknown>(
  url: string,
  options?: RequestInit
): Promise<T>;

// =============================================================================
// Interval Helper
// =============================================================================

/**
 * Interval controller returned by createInterval
 */
export interface IntervalController {
  /** Interval ID from setInterval */
  id: number;
  /** Clear the interval */
  clear(): void;
}

/**
 * Interval helper that provides a clear method.
 *
 * @param fn - Function to run at interval
 * @param delay - Delay in milliseconds
 * @returns Interval controller
 *
 * @example
 * const interval = createInterval(() => {
 *   fetchUpdates();
 * }, 60000);
 *
 * // Later: cleanup
 * interval.clear();
 */
export function createInterval(
  fn: () => void,
  delay: number
): IntervalController;

// =============================================================================
// Event Bus
// =============================================================================

/**
 * Event bus for cross-component communication.
 */
export interface EventBusInstance {
  /**
   * Subscribe to an event.
   *
   * @param event - Event name
   * @param callback - Event handler
   * @returns Unsubscribe function
   */
  on<T = unknown>(event: string, callback: (data: T) => void): () => void;

  /**
   * Unsubscribe from an event.
   *
   * @param event - Event name
   * @param callback - Event handler to remove
   */
  off<T = unknown>(event: string, callback: (data: T) => void): void;

  /**
   * Emit an event to all subscribers.
   *
   * @param event - Event name
   * @param args - Arguments to pass to handlers
   */
  emit<T = unknown>(event: string, ...args: T[]): void;

  /**
   * Subscribe to an event for one emission only.
   *
   * @param event - Event name
   * @param callback - Event handler
   * @returns Unsubscribe function
   */
  once<T = unknown>(event: string, callback: (data: T) => void): () => void;
}

/**
 * Global event bus instance for cross-component communication.
 *
 * @example
 * // In one component
 * eventBus.on('user-updated', (user) => {
 *   console.log('User updated:', user);
 * });
 *
 * // In another component
 * eventBus.emit('user-updated', { name: 'Alice', id: 123 });
 */
export const eventBus: EventBusInstance;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if value is empty (null, undefined, empty string/array/object).
 *
 * @param value - Value to check
 * @returns True if value is empty
 *
 * @example
 * isEmpty(null); // true
 * isEmpty(''); // true
 * isEmpty([]); // true
 * isEmpty({}); // true
 * isEmpty('hello'); // false
 */
export function isEmpty(value: unknown): boolean;

/**
 * Clamp number between min and max.
 *
 * @param value - Value to clamp
 * @param min - Minimum value
 * @param max - Maximum value
 * @returns Clamped value
 *
 * @example
 * clamp(150, 0, 100); // 100
 * clamp(-10, 0, 100); // 0
 * clamp(50, 0, 100); // 50
 */
export function clamp(value: number, min: number, max: number): number;

/**
 * Generate random ID.
 *
 * @param prefix - Prefix for the ID (default: 'id')
 * @returns Random ID string
 *
 * @example
 * randomId(); // 'id-x7k2m9p4q'
 * randomId('user'); // 'user-a3f8g1h5j'
 */
export function randomId(prefix?: string): string;

/**
 * Format date to relative time (e.g., "2 hours ago").
 *
 * @param date - Date to format
 * @returns Relative time string
 *
 * @example
 * relativeTime(new Date(Date.now() - 3600000)); // "1 hours ago"
 * relativeTime(new Date(Date.now() - 120000)); // "2 minutes ago"
 */
export function relativeTime(date: Date | string | number): string;

/**
 * Range utility (like Python's range) - generates array of numbers.
 *
 * @param a - Start (or stop if b is null)
 * @param b - Stop (exclusive)
 * @param step - Step size (default: 1)
 * @returns Array of numbers
 *
 * @example
 * range(5); // [0, 1, 2, 3, 4]
 * range(2, 5); // [2, 3, 4]
 * range(0, 10, 2); // [0, 2, 4, 6, 8]
 */
export function range(a: number, b?: number | null, step?: number): number[];

// =============================================================================
// Local Storage
// =============================================================================

/**
 * Create a store that persists to localStorage.
 * Automatically loads on creation and saves on changes.
 *
 * @param name - Storage key name (prefix will be added automatically)
 * @param initial - Initial value if not found in localStorage
 * @returns Store object that auto-syncs to localStorage
 *
 * @example
 * const prefs = localStore('user-prefs', { theme: 'light', lang: 'en' });
 *
 * // Automatically loads from localStorage on creation
 * console.log(prefs.state.theme);
 *
 * // Automatically saves to localStorage on change
 * prefs.state.theme = 'dark';
 */
export function localStore<T extends object>(name: string, initial: T): Store<T>;

// =============================================================================
// Dark Theme
// =============================================================================

/**
 * Dark theme state
 */
export interface DarkThemeState {
  enabled: boolean;
}

/**
 * Global dark theme store with localStorage persistence.
 *
 * @example
 * // Toggle dark mode
 * darkTheme.update(s => ({ enabled: !s.enabled }));
 *
 * // Subscribe to changes
 * darkTheme.subscribe(state => {
 *   document.body.classList.toggle('dark', state.enabled);
 * });
 */
export const darkTheme: Store<DarkThemeState>;

// =============================================================================
// Lazy Component Loading
// =============================================================================

/**
 * Lazy load a component module.
 * Returns a cached promise that resolves when the component is registered.
 * Works seamlessly with awaitThen() for loading states.
 *
 * @param importFn - Dynamic import function, e.g., () => import('./my-component.js')
 * @returns Promise that resolves to true when component is ready
 *
 * @example
 * import { lazy } from './lib/utils.js';
 * import { awaitThen, html } from './lib/framework.js';
 *
 * const LazyChart = lazy(() => import('./chart-component.js'));
 *
 * template() {
 *     return html`
 *         ${awaitThen(LazyChart,
 *             () => html`<chart-component data="${this.state.data}"></chart-component>`,
 *             html`<cl-spinner></cl-spinner>`
 *         )}
 *     `;
 * }
 */
export function lazy(importFn: () => Promise<any>): Promise<true>;

/**
 * Preload a lazy component without rendering it.
 * Useful for preloading components the user is likely to need.
 *
 * @param importFn - Dynamic import function
 * @returns Promise that resolves when loaded
 *
 * @example
 * import { preloadLazy } from './lib/utils.js';
 *
 * // Preload on hover for instant display when clicked
 * <button on-mouseenter="${() => preloadLazy(() => import('./heavy-dialog.js'))}">
 */
export function preloadLazy(importFn: () => Promise<any>): Promise<true>;

/**
 * Clear the lazy loading cache.
 * Rarely needed - mainly for testing or memory optimization.
 */
export function clearLazyCache(): void;

// =============================================================================
// Debug Logging
// =============================================================================

/**
 * Options for rlog function
 */
export interface RlogOptions {
  /** If true, output as JSON (useful for puppeteer) */
  json?: boolean;
}

/**
 * Debug logging helper that doesn't create reactive dependencies.
 * Strips reactive proxies so objects print cleanly in console.
 *
 * Must pass a function to avoid tracking - the function is called inside
 * withoutTracking() so state access won't create dependencies.
 *
 * @param fn - Function that returns array of values to log
 * @param options - Optional settings
 *
 * @example
 * // Basic usage - pass a function to avoid creating dependencies
 * rlog(() => ['Current state:', this.state]);
 * rlog(() => ['Queue:', this.state.queue, 'Index:', this.state.index]);
 *
 * // With JSON output (useful for puppeteer)
 * rlog(() => ['Data:', this.state.items], { json: true });
 */
export function rlog(fn: () => unknown[], options?: RlogOptions): void;

// =============================================================================
// Default Export
// =============================================================================

/**
 * Default export is the notify function for backward compatibility.
 */
declare const _default: typeof notify;
export default _default;
