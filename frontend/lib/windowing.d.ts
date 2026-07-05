/**
 * TypeScript definitions for the windowing (virtual scroll) controller.
 */

/**
 * Scroll tracking mode:
 * - 'self': the host element scrolls
 * - 'parent': nearest scrollable ancestor
 * - 'window': the page scrolls
 * - string: CSS selector for the scroll container
 * - Element: an explicit scroll container
 */
export type ScrollContainer = 'self' | 'parent' | 'window' | string | Element;

export interface WindowingOptions {
  /** Fixed row height in px (number, or function for late-bound props) */
  itemHeight: number | (() => number);
  /**
   * Returns the total item count. If this reads reactive state, item-count
   * changes update the window automatically; for untracked()/props-delivered
   * sources call refresh() after changes.
   */
  count: () => number;
  /** Extra rows rendered above/below the viewport (default: 10) */
  buffer?: number | (() => number);
  /** Extra rows added in the scroll direction during fast scrolling (default: 0) */
  overscan?: number | (() => number);
  /** Scroll tracking mode (default: 'self') */
  scrollContainer?: ScrollContainer;
  /**
   * Element whose position is measured in parent/window/element modes
   * (defaults to host; pass the inner items container when other content
   * sits above the list inside the host).
   */
  measureElement?: HTMLElement | (() => HTMLElement | null);
  /**
   * For on-demand loading: how many items are actually loaded. The window
   * clamps to loaded rows while the spacer covers count(); bottom-locking
   * uses loaded rows.
   */
  loadedCount?: () => number;
  /** Viewport height used before the container can be measured (default: 400) */
  fallbackHeight?: number | (() => number);
  /** Called after the visible range changes (use for on-demand loading) */
  onRange?: (start: number, end: number) => void;
}

export interface WindowingController {
  /** First index of the rendered window (inclusive). Reactive. */
  readonly visibleStart: number;
  /** End index of the rendered window (exclusive). Reactive. */
  readonly visibleEnd: number;
  /** translateY offset for the window container, in px. Reactive. */
  readonly offsetY: number;
  /** Height of the spacer element, in px. Reactive (reads count()). */
  readonly totalHeight: number;
  /** Current scroll position relative to the list. Reactive. */
  readonly scrollTop: number;
  /** Measured viewport height. Reactive. */
  readonly containerHeight: number;

  /** Recompute dimensions and the visible range (after untracked/props data changes) */
  refresh(): void;
  /** Scroll so the given item index is at the top of the viewport */
  scrollToIndex(index: number): void;
  scrollToTop(): void;
  scrollToBottom(): void;
  /** Switch scroll tracking mode (e.g. when a scrollContainer prop changes) */
  setScrollContainer(mode: ScrollContainer): void;
  /** (Re-)attach listeners and observers. Idempotent. Pair with detach(). */
  attach(): void;
  /** Remove listeners/observers but keep state (host may reconnect) */
  detach(): void;
  /** Full teardown: detach and dispose effects */
  destroy(): void;
}

/**
 * Create a windowing controller for virtual scrolling. The controller owns
 * the window state and scroll/resize plumbing; the component owns the markup.
 *
 * Range commits are flushSync'd so window position and contents land in the
 * same animation frame. Reading the reactive getters in a template tracks
 * them - the template re-renders when the window moves.
 *
 * @example
 * data() {
 *     this._win = createWindowing(this, {
 *         itemHeight: 52,
 *         count: () => this.state.items.length
 *     });
 *     return { items: untracked([]) };
 * },
 * unmounted() { this._win.destroy(); }
 */
export function createWindowing(host: HTMLElement, options: WindowingOptions): WindowingController;
