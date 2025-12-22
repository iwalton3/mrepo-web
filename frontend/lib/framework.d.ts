/**
 * VDX-Web Framework Type Definitions
 * https://github.com/iwalton3/vdx-web
 *
 * Zero-dependency reactive web framework with:
 * - Web Components based architecture
 * - Vue 3-style proxy reactivity
 * - Preact rendering for efficient DOM updates
 * - Compile-once template system
 */

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Extract state type from a Store.
 * Store<T> -> T
 */
export type UnwrapStore<T> = T extends Store<infer S> ? S : T;

/**
 * Unwrap all stores in an object to their state types.
 * { auth: Store<AuthState> } -> { auth: AuthState }
 *
 * Use this when defining the stores interface for a component:
 * @example
 * const stores = { tasks: tasksStore, auth: authStore };
 * type MyStores = UnwrapStores<typeof stores>;
 * // MyStores = { tasks: TasksState; auth: AuthState }
 */
export type UnwrapStores<T> = {
    [K in keyof T]: UnwrapStore<T[K]>;
};

// =============================================================================
// Core Types
// =============================================================================

/**
 * A reactive proxy that tracks dependencies and triggers effects on change.
 * Use this to type your component's state.
 */
export type Reactive<T> = T;

/**
 * Result of html`` tagged template - can be nested in other templates.
 */
export interface HtmlTemplate {
  readonly _compiled: CompiledTemplate;
  readonly _values: unknown[];
  toString(): string;
}

/**
 * Internal compiled template structure (not typically used directly)
 */
export interface CompiledTemplate {
  readonly op: number;
  readonly type: string;
  readonly vnode?: unknown;
  readonly wrapped?: boolean;
  readonly children?: CompiledTemplate[];
  readonly key?: string | number;
}

// =============================================================================
// Component System
// =============================================================================

/**
 * Built-in props available on all components
 */
export interface BuiltinProps {
  /** Child elements passed to this component */
  children: unknown[];
  /** Named slot contents */
  slots: Record<string, unknown[]>;
}

/**
 * The component instance context available in methods, template, and lifecycle hooks.
 * @template P - Props type (defaults to any for flexibility)
 * @template S - State type (defaults to any for flexibility)
 * @template St - Stores input type (Store objects; will be unwrapped for access)
 */
export interface ComponentInstance<
  P = any,
  S = any,
  St = any
> {
  /** Reactive props (read-only from component's perspective) */
  readonly props: P & BuiltinProps;

  /** Reactive local state */
  state: S;

  /**
   * Subscribed store states (unwrapped for direct access).
   * If you pass { tasks: Store<TasksState> }, this becomes { tasks: TasksState }
   */
  stores: UnwrapStores<St>;

  /** DOM element references via ref="name" attribute */
  refs: Record<string, HTMLElement>;

  /**
   * Emit a change event for x-model binding.
   * @param e - The original event (will have propagation stopped)
   * @param value - The new value to emit
   * @param propName - The prop name (default: 'value')
   */
  emitChange(e: Event | null, value: unknown, propName?: string): void;

  /**
   * Dispatch a custom event
   */
  dispatchEvent(event: CustomEvent): boolean;

  /**
   * Force a re-render of this component
   */
  render(): void;

  /**
   * Get a bound method by name
   */
  $method<T extends (...args: any[]) => any>(name: string): T | undefined;

  /** Allow any other properties for flexibility */
  [key: string]: any;
}

/**
 * Component options passed to defineComponent.
 * Use generics for type-safe components, or omit them for flexibility.
 *
 * @template P - Props type
 * @template S - State type
 * @template St - Stores type
 */
export interface ComponentOptions<
  P = any,
  S = any,
  St = any
> {
  /**
   * Props with default values. Props are automatically observed as attributes.
   * @example
   * props: {
   *   title: 'Default Title',
   *   count: 0,
   *   disabled: false
   * }
   */
  props?: P;

  /**
   * Function returning initial reactive state.
   * Called once when component is constructed.
   * @example
   * data() {
   *   return { message: 'Hello', items: [] };
   * }
   */
  data?(this: ComponentInstance<P, S, St>): S;

  /**
   * Methods available on the component instance.
   * Methods are automatically bound to the component.
   * @example
   * methods: {
   *   handleClick() {
   *     this.state.count++;
   *   }
   * }
   */
  methods?: Record<string, (this: ComponentInstance<P, S, St>, ...args: any[]) => any>;

  /**
   * Template function returning html`` tagged template.
   * Called on every render.
   * @example
   * template() {
   *   return html`<div>${this.state.message}</div>`;
   * }
   */
  template(this: ComponentInstance<P, S, St>): HtmlTemplate;

  /**
   * Scoped CSS styles for the component.
   * Styles are automatically scoped to prevent leakage.
   * @example
   * styles: `
   *   button { background: blue; color: white; }
   * `
   */
  styles?: string;

  /**
   * External stores to subscribe to.
   * Component automatically subscribes on mount and unsubscribes on unmount.
   * Pass Store objects here - they are automatically unwrapped for `this.stores` access.
   *
   * @example
   * // Define stores input type (with Store wrappers)
   * const storesInput = { tasks: tasksStore, auth: authStore };
   *
   * defineComponent('my-comp', {
   *   stores: storesInput,
   *   template() {
   *     // this.stores is auto-unwrapped: { tasks: TasksState, auth: AuthState }
   *     return html`<p>${this.stores.tasks.filter}</p>`;
   *   }
   * });
   */
  stores?: St;

  /**
   * Lifecycle hook called after component is added to DOM.
   * Use for data fetching, subscriptions, DOM manipulation.
   */
  mounted?(this: ComponentInstance<P, S, St>): void | Promise<void>;

  /**
   * Lifecycle hook called before component is removed from DOM.
   * Use for cleanup: unsubscribe, clear timers, etc.
   */
  unmounted?(this: ComponentInstance<P, S, St>): void;

  /**
   * Lifecycle hook called after each render.
   * Use sparingly - prefer reactive patterns instead.
   */
  afterRender?(this: ComponentInstance<P, S, St>): void;

  /**
   * Called when a prop value changes.
   * @param prop - Name of the prop that changed
   * @param newValue - New value
   * @param oldValue - Previous value
   */
  propsChanged?(this: ComponentInstance<P, S, St>, prop: string, newValue: unknown, oldValue: unknown): void;
}

/**
 * Define a custom element component with reactive state and template rendering.
 *
 * @param name - Component tag name (must contain hyphen, e.g., 'my-component')
 * @param options - Component configuration
 * @returns Custom element class (also registers with customElements)
 *
 * @example
 * // Basic usage (untyped)
 * defineComponent('my-counter', {
 *   props: { title: 'Counter' },
 *   data() { return { count: 0 }; },
 *   methods: {
 *     increment() { this.state.count++; }
 *   },
 *   template() {
 *     return html`
 *       <div>
 *         <h1>${this.props.title}</h1>
 *         <p>Count: ${this.state.count}</p>
 *         <button on-click="increment">+1</button>
 *       </div>
 *     `;
 *   }
 * });
 *
 * @example
 * // Typed usage
 * interface MyProps { title: string; }
 * interface MyState { count: number; }
 *
 * defineComponent<MyProps, MyState>('my-counter', {
 *   props: { title: 'Counter' },
 *   data() { return { count: 0 }; },
 *   template() {
 *     return html`<p>${this.state.count}</p>`;
 *   }
 * });
 */
export function defineComponent<P = any, S = any, St = any>(
  name: string,
  options: ComponentOptions<P, S, St>
): CustomElementConstructor;

// =============================================================================
// Reactivity System
// =============================================================================

/**
 * Create a reactive proxy that tracks dependencies and triggers effects on change.
 * Nested objects are automatically made reactive.
 *
 * @param obj - Object to make reactive
 * @returns Reactive proxy of the object
 *
 * @example
 * const state = reactive({ count: 0, user: { name: 'Alice' } });
 * state.count++; // Triggers reactive effects
 * state.user.name = 'Bob'; // Deep reactivity works
 */
export function reactive<T extends object>(obj: T): Reactive<T>;

/**
 * Effect result with cleanup function
 */
export interface EffectResult {
  /** The effect function that can be called to re-run */
  effect: () => void;
  /** Cleanup function to stop the effect and remove all dependencies */
  dispose: () => void;
}

/**
 * Create an effect that automatically runs when its reactive dependencies change.
 *
 * @param fn - Function to run (dependencies tracked automatically)
 * @returns Object with effect function and dispose cleanup
 *
 * @example
 * const state = reactive({ count: 0 });
 * const { dispose } = createEffect(() => {
 *   console.log('Count:', state.count);
 * });
 * state.count++; // Logs: Count: 1
 * dispose(); // Stop tracking
 */
export function createEffect(fn: () => void): EffectResult;

/**
 * Track all reactive dependencies deeply in an object.
 * Useful for ensuring all nested properties trigger re-renders.
 *
 * @param obj - Object to track
 */
export function trackAllDependencies(obj: unknown): void;

/**
 * Check if a value is a reactive proxy.
 *
 * @param value - Value to check
 * @returns True if value is reactive
 *
 * @example
 * const state = reactive({ count: 0 });
 * isReactive(state); // true
 * isReactive({}); // false
 */
export function isReactive(value: unknown): boolean;

/**
 * Mark an object as untracked to prevent deep dependency tracking.
 * Use for large data structures (arrays of hundreds/thousands of items)
 * where you only care about the array being replaced, not individual item changes.
 *
 * @param obj - Object to mark as untracked
 * @returns The same object with untracked marker
 *
 * @example
 * data() {
 *   return {
 *     songs: untracked([]),  // Large array - only track replacement
 *     currentIndex: 0        // Small value - track normally
 *   };
 * }
 *
 * // Reassign to trigger update:
 * this.state.songs = untracked([...this.state.songs, newSong]);
 */
export function untracked<T>(obj: T): T;

/**
 * Check if an object is marked as untracked.
 *
 * @param obj - Object to check
 * @returns True if object is untracked
 */
export function isUntracked(obj: unknown): boolean;

/**
 * Watch reactive dependencies and call callback when they change.
 *
 * @param fn - Function that accesses reactive values (return value is watched)
 * @param callback - Callback with new and old values
 * @returns Cleanup function to stop watching
 *
 * @example
 * const state = reactive({ count: 0 });
 * const stop = watch(
 *   () => state.count,
 *   (newVal, oldVal) => console.log(`${oldVal} -> ${newVal}`)
 * );
 */
export function watch<T>(
  fn: () => T,
  callback: (newValue: T, oldValue: T) => void
): () => void;

/**
 * Computed value result
 */
export interface ComputedResult<T> {
  /** Get the current computed value (recomputes if dependencies changed) */
  get(): T;
  /** Cleanup function to stop tracking */
  dispose(): void;
}

/**
 * Create a computed value with automatic reactive dependency tracking.
 * The getter is lazily evaluated and cached until reactive dependencies change.
 *
 * @param getter - Function that computes the value (dependencies are auto-tracked)
 * @returns Object with get() and dispose() methods
 *
 * @example
 * const state = reactive({ a: 1, b: 2 });
 * const sum = computed(() => state.a + state.b);
 * console.log(sum.get()); // 3
 * state.a = 5;
 * console.log(sum.get()); // 7 (automatically recomputed)
 * sum.dispose(); // Clean up when done
 */
export function computed<T>(getter: () => T): ComputedResult<T>;

/**
 * Memoize a function result based on an explicit dependency array.
 * Re-runs the function only when dependencies change.
 *
 * @param fn - Function to memoize
 * @param deps - Dependency array (when any value changes, function re-runs)
 * @returns Memoized function
 *
 * @example
 * const expensiveRender = memo(() => {
 *   return html`<div>${this.state.items.length} items</div>`;
 * }, [this.state.items]);
 */
export function memo<T extends (...args: any[]) => any>(
  fn: T,
  deps?: unknown[]
): T;

// =============================================================================
// Render Control
// =============================================================================

/**
 * Execute a function and immediately flush any pending renders.
 * Use when you need synchronous DOM updates after state changes,
 * such as when measuring elements or interacting with focus.
 *
 * Similar to React's flushSync() - use sparingly as it bypasses batching.
 *
 * @param fn - Function to execute (typically contains state updates)
 * @returns Return value of the function
 *
 * @example
 * // Focus an input after showing it
 * flushSync(() => {
 *   this.state.showInput = true;
 * });
 * this.refs.input.focus();
 *
 * @example
 * // Scroll to bottom after adding an item
 * flushSync(() => {
 *   this.state.items.push(newItem);
 * });
 * this.refs.container.scrollTop = this.refs.container.scrollHeight;
 */
export function flushSync<T>(fn: () => T): T;

/**
 * Flush any pending renders synchronously.
 * Useful for tests that need to verify DOM state immediately after state changes.
 * In normal application code, you don't need this - use flushSync() instead.
 *
 * @example
 * // In a test:
 * component.state.count = 5;
 * flushRenders();  // Force render to happen now
 * expect(component.textContent).toBe('5');
 */
export function flushRenders(): void;

// =============================================================================
// Template System
// =============================================================================

/**
 * Tagged template literal for creating XSS-safe HTML templates.
 * Values are automatically escaped based on context.
 *
 * @param strings - Template strings
 * @param values - Interpolated values (automatically escaped)
 * @returns Compiled template structure
 *
 * @example
 * html`<div>${userInput}</div>` // Auto-escaped
 * html`<a href="${url}">Link</a>` // URL sanitized
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): HtmlTemplate;

/**
 * Render trusted HTML without escaping.
 * WARNING: Only use for content you absolutely trust!
 *
 * @param htmlString - Trusted HTML string
 * @returns Raw HTML marker
 *
 * @example
 * raw(apiResponse.htmlContent) // Safe - from your API
 * raw(userComment) // DANGEROUS - XSS vulnerability!
 */
export function raw(htmlString: string): { toString(): string };

/**
 * Conditional rendering helper.
 * Use instead of ternaries for cleaner templates.
 *
 * @param condition - Condition to evaluate
 * @param thenValue - Value/template to return if true (or function returning it)
 * @param elseValue - Value/template to return if false (optional)
 * @returns The appropriate value based on condition
 *
 * @example
 * when(isLoggedIn,
 *   html`<p>Welcome!</p>`,
 *   html`<p>Please log in</p>`
 * )
 *
 * // With lazy evaluation
 * when(user,
 *   () => html`<p>${user.name}</p>`,
 *   () => html`<p>No user</p>`
 * )
 */
export function when<T, E = null>(
  condition: unknown,
  thenValue: T | (() => T),
  elseValue?: E | (() => E)
): T | E | HtmlTemplate;

/**
 * List rendering helper with automatic keying.
 * More efficient than map() for reactive lists.
 *
 * @param array - Array to iterate over
 * @param mapFn - Function that returns template for each item
 * @param keyFn - Optional function to extract unique key (recommended for lists that reorder)
 * @returns Array of rendered templates
 *
 * @example
 * each(items, item => html`<li>${item.name}</li>`)
 *
 * // With key function for stable DOM identity
 * each(items, item => html`<li>${item.name}</li>`, item => item.id)
 */
export function each<T>(
  array: T[] | null | undefined,
  mapFn: (item: T, index: number) => HtmlTemplate,
  keyFn?: (item: T) => string | number
): HtmlTemplate;

/**
 * Memoization cache for memoEach.
 */
export type MemoCache = Map<string | number, { item: unknown; result: HtmlTemplate }>;

/**
 * Create a memoization cache for use with memoEach().
 * Usually not needed - memoEach() automatically manages caches inside component templates.
 *
 * @returns Cache map for memoEach
 *
 * @example
 * mounted() {
 *     this._cache = createMemoCache();
 * }
 */
export function createMemoCache(): MemoCache;

/**
 * Memoized list rendering - caches rendered templates per item key.
 * Only re-renders items that have changed (by reference).
 *
 * When used inside a component template, caching is automatic.
 * Pass an explicit cache for advanced use cases.
 *
 * @param array - Array to iterate over
 * @param mapFn - Function that returns template for each item
 * @param keyFn - Required function to extract unique key from item
 * @param cache - Optional explicit cache (omit for automatic caching)
 * @returns Compiled fragment template
 *
 * @example
 * // Automatic caching (recommended)
 * memoEach(songs, song => html`<div>${song.title}</div>`, song => song.uuid)
 *
 * // With explicit cache
 * memoEach(songs, song => html`<div>${song.title}</div>`, song => song.uuid, this._cache)
 */
export function memoEach<T>(
  array: T[] | null | undefined,
  mapFn: (item: T, index: number) => HtmlTemplate,
  keyFn: (item: T) => string | number,
  cache?: MemoCache
): HtmlTemplate;

/**
 * Async content rendering helper with loading state.
 * Automatically handles promise lifecycle.
 *
 * @param promiseOrValue - Promise to await, or immediate value
 * @param thenFn - Function to render resolved data
 * @param pendingContent - Content to show while loading
 * @param catchFn - Content or function for errors (optional)
 * @returns Template containing x-await-then component
 *
 * @example
 * awaitThen(
 *   fetchUser(123),
 *   user => html`<div>${user.name}</div>`,
 *   html`<loading-spinner></loading-spinner>`,
 *   error => html`<div class="error">${error.message}</div>`
 * )
 */
export function awaitThen<T>(
  promiseOrValue: Promise<T> | T,
  thenFn: (data: T) => HtmlTemplate,
  pendingContent: HtmlTemplate | string,
  catchFn?: ((error: Error) => HtmlTemplate) | HtmlTemplate
): HtmlTemplate;

/**
 * Clear the template compilation cache.
 * Rarely needed - only for memory optimization in long-running apps.
 */
export function pruneTemplateCache(): void;

// =============================================================================
// Store System
// =============================================================================

/**
 * A reactive store with subscription support.
 * @template T - State type
 */
export interface Store<T> {
  /** The reactive state object */
  readonly state: T;

  /**
   * Subscribe to store changes.
   * Callback is called immediately with current state, then on each change.
   * @param callback - Function called with state on changes
   * @returns Unsubscribe function
   */
  subscribe(callback: (state: T) => void): () => void;

  /**
   * Replace store state with new values.
   * @param newState - New state to merge
   */
  set(newState: Partial<T>): void;

  /**
   * Update store using updater function.
   * @param updater - Function that receives current state and returns new state
   */
  update(updater: (state: T) => Partial<T> | void): void;
}

/**
 * Create a reactive store with pub/sub pattern.
 *
 * @param initialState - Initial state object
 * @returns Store object with state, subscribe, set, and update methods
 *
 * @example
 * const store = createStore({ count: 0, user: null });
 *
 * const unsubscribe = store.subscribe(state => {
 *   console.log('Count:', state.count);
 * });
 *
 * store.state.count++; // Direct mutation works
 * store.set({ count: 5 }); // Or use set()
 * store.update(s => ({ count: s.count + 1 })); // Or update()
 *
 * unsubscribe(); // Stop listening
 */
export function createStore<T extends object>(initialState: T): Store<T>;

// =============================================================================
// Preact Exports (for advanced usage)
// =============================================================================

/**
 * Virtual DOM node (Preact VNode)
 */
export interface VNode<P = Record<string, unknown>> {
  type: string | ComponentType<P>;
  props: P & { children?: VNode | VNode[] | string | null };
  key: string | number | null;
}

/**
 * Component type (function or class)
 */
export type ComponentType<P = Record<string, unknown>> = (props: P) => VNode | null;

/**
 * Preact's createElement function.
 * For advanced usage when you need to create VNodes directly.
 *
 * @param type - Element type or component
 * @param props - Props/attributes
 * @param children - Child elements
 * @returns VNode
 */
export function h<P extends Record<string, unknown>>(
  type: string | ComponentType<P>,
  props: P | null,
  ...children: (VNode | string | number | null | undefined)[]
): VNode<P>;

/**
 * Preact's Fragment component.
 * For grouping elements without a wrapper DOM element.
 *
 * @example
 * h(Fragment, null, h('span', null, 'A'), h('span', null, 'B'))
 */
export const Fragment: ComponentType<{ children?: VNode | VNode[] }>;

/**
 * Preact's render function.
 * For manual rendering when needed.
 *
 * @param vnode - Virtual node to render
 * @param container - Container element
 */
export function render(vnode: VNode | null, container: Element): void;
