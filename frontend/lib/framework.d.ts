/**
 * VDX-Web Framework Type Definitions
 * https://github.com/iwalton3/vdx-web
 *
 * Zero-dependency reactive web framework with:
 * - Web Components based architecture
 * - Vue 3-style proxy reactivity
 * - Fine-grained reactive rendering for efficient DOM updates
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
  readonly template?: Node;
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
   * Resolve after the next effect flush and DOM commit complete.
   * Rendering is globally batched - this delegates to the global nextRender().
   */
  nextRender(): Promise<void>;

  /**
   * Resolve when a matched child exists in this subtree, its custom element is
   * defined (covers lazy import()ed definitions), and its first render +
   * mounted() have completed. Resolves null if THIS component unmounts first.
   *
   * @param selectorOrElement - CSS selector (scoped to this subtree) or element
   */
  whenMounted(selectorOrElement: string | Element): Promise<Element | null>;

  /**
   * Create a latest-wins async task bound to this component's lifetime
   * (auto-cancelled and disposed at unmount).
   */
  createTask<T = unknown>(
    fn: (signal: AbortSignal, ...args: any[]) => Promise<T> | T
  ): Task<T>;

  /**
   * Get a bound method by name
   */
  $method<T extends (...args: any[]) => any>(name: string): T | undefined;

  /**
   * Batched prop assignment: updates all backing values before firing any
   * propsChanged callback, so handlers can read this.props for sibling
   * props delivered in the same batch. Fires one re-render for the batch.
   */
  setProps(newProps: Partial<P>): void;

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
   * External stores to wire up.
   * `this.stores.name` becomes a direct reference to the store's reactive
   * state - reads are tracked fine-grained and cleanup is automatic.
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
   * Computed properties - lazy, cached values that recompute when their
   * reactive dependencies change. Exposed as plain instance properties
   * (read `this.total`, not `this.total()`). Plain functions only
   * (no `get` accessors). Disposed automatically on unmount.
   *
   * @example
   * computed: {
   *   total() { return this.state.items.reduce((s, i) => s + i.price, 0); }
   * },
   * template() {
   *   return html`<p>Total: ${this.total}</p>`;
   * }
   */
  computed?: Record<string, (this: ComponentInstance<P, S, St>) => any>;

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

  /**
   * Error boundary - called when template() throws an error.
   * Return an html`` template to render fallback UI, or nothing to render blank.
   * The error is also logged to console automatically.
   *
   * @param error - The error that was thrown
   * @returns Fallback template to render, or void for blank
   *
   * @example
   * renderError(error) {
   *   console.error('Render failed:', error);
   *   return html`<div class="error">Something went wrong</div>`;
   * }
   */
  renderError?(this: ComponentInstance<P, S, St>, error: Error): HtmlTemplate | void;
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
/**
 * Any class extending Component (loose construct signature so subclasses
 * with concrete generics and required constructor params are accepted).
 */
export type ComponentClass = abstract new (...args: any[]) => Component<any, any, any>;

export function defineComponent(
  name: string,
  componentClass: ComponentClass
): CustomElementConstructor;
export function defineComponent<P = any, S = any, St = any>(
  name: string,
  options: ComponentOptions<P, S, St>
): CustomElementConstructor;

/**
 * Base class for class-authored components.
 *
 * This declaration describes the RUNTIME `this` seen by your methods,
 * template, and lifecycle hooks: the custom element itself (hence
 * `extends HTMLElement` - all DOM APIs on `this` are real). defineComponent
 * translates the class into the framework's internal format at registration;
 * the class itself is never instantiated as a separate object.
 *
 * Authoring contract:
 * - `static props` declares props with defaults (observed as attributes).
 *   Do NOT declare props as class fields - they would shadow the generated
 *   accessors (the framework removes such fields and warns).
 * - `static stores` wires stores; access state via `this.stores.name`.
 * - `static styles` provides scoped CSS. All three merge across inheritance.
 * - Getters become computed properties: lazy, cached, auto-disposed. Keep
 *   them pure derivations of state/stores/props. A getter that tracks no
 *   reactive dependency (and never reads props) is re-evaluated on every
 *   read instead of cached, since nothing could ever invalidate it.
 * - Methods are auto-bound to the element.
 * - The constructor runs at FIRST CONNECT (not element creation), after
 *   attributes are parsed - so `props` has real values you can copy into
 *   state. It runs once per element; reconnection does not re-run it.
 *
 * @example
 * class TaskList extends Component<TaskProps, TaskState> {
 *   static props = { title: 'Tasks' };
 *
 *   constructor(props: TaskProps & BuiltinProps) {
 *     super(props);
 *     this.state = { items: [], filter: props.title };
 *   }
 *
 *   get remaining() { return this.state.items.filter(i => !i.done).length; }
 *
 *   addItem(name: string) { this.state.items.push({ name, done: false }); }
 *
 *   template() {
 *     return html`<div>${this.props.title}: ${this.remaining} left</div>`;
 *   }
 * }
 * export default defineComponent('task-list', TaskList);
 */
export abstract class Component<P = any, S = any, St = any> extends HTMLElement {
  // Declared as P (not P & BuiltinProps) so `super(props)` type-checks when
  // the subclass annotates `constructor(props: MyProps)`. At runtime the
  // object also carries children/slots - annotate with BuiltinProps if needed.
  constructor(props?: P);

  /** Reactive props (read-only from the component's perspective) */
  readonly props: P & BuiltinProps;

  /** Reactive local state - assign a plain object in the constructor or as a field */
  state: S;

  /** Subscribed store states (unwrapped for direct access) */
  stores: UnwrapStores<St>;

  /** DOM element references via ref="name" attribute */
  refs: Record<string, HTMLElement>;

  /** Props with default values (observed as attributes). Merged across inheritance. */
  static props?: Record<string, any>;

  /** Scoped CSS. Concatenated parent-first across inheritance. */
  static styles?: string;

  /** Stores to wire up (pass Store objects; unwrapped on `this.stores`). */
  static stores?: Record<string, Store<any>>;

  /**
   * Emit a change event for x-model binding.
   * @param e - The original event (will have propagation stopped)
   * @param value - The new value to emit
   * @param propName - The prop name (default: 'value')
   */
  emitChange(e: Event | null, value: unknown, propName?: string): void;

  /**
   * Batched prop assignment: updates all backing values before firing any
   * propsChanged callback. Fires one re-render for the batch.
   */
  setProps(newProps: Partial<P>): void;

  /** Get a bound method by name */
  $method<T extends (...args: any[]) => any>(name: string): T | undefined;

  /**
   * Resolve after the next effect flush and DOM commit complete.
   * Delegates to the global nextRender() (rendering is globally batched).
   */
  nextRender(): Promise<void>;

  /**
   * Resolve when a matched child exists in this subtree, its custom element is
   * defined, and its first render + mounted() completed. Resolves null if this
   * component unmounts first.
   * @param selectorOrElement - CSS selector (scoped to this subtree) or element
   */
  whenMounted(selectorOrElement: string | Element): Promise<Element | null>;

  /**
   * Create a latest-wins async task bound to this component's lifetime
   * (auto-cancelled and disposed at unmount).
   */
  createTask<T = unknown>(
    fn: (signal: AbortSignal, ...args: any[]) => Promise<T> | T
  ): Task<T>;

  /** Template function returning an html`` tagged template */
  abstract template(): HtmlTemplate;

  /** Called after the component is added to the DOM */
  mounted?(): void | Promise<void>;

  /** Called when the component is removed from the DOM - clean up here */
  unmounted?(): void;

  /** Called after each render (before browser layout/paint) */
  afterRender?(): void;

  /** Called when a prop value changes - use newValue, not this.props */
  propsChanged?(prop: string, newValue: unknown, oldValue: unknown): void;

  /** Error boundary - return a fallback template when template() throws */
  renderError?(error: Error): HtmlTemplate | void;
}

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
 * Note: Consider using trackMutations() for O(1) tracking instead.
 *
 * @param obj - Object to track
 */
export function trackAllDependencies(obj: unknown): void;

/**
 * Track mutations to a reactive object using O(1) mutation counter.
 * Much more efficient than trackAllDependencies() for large objects.
 *
 * @param obj - The reactive object to track
 *
 * @example
 * createEffect(() => {
 *     trackMutations(state);  // O(1) - just reads mutation counter
 *     console.log('State changed!');
 * });
 */
export function trackMutations(obj: unknown): void;

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
 * A reactive Set-like object that triggers updates on mutations.
 */
export interface ReactiveSet<T> {
    add(value: T): ReactiveSet<T>;
    delete(value: T): boolean;
    has(value: T): boolean;
    clear(): void;
    readonly size: number;
    forEach(callback: (value: T, value2: T, set: ReactiveSet<T>) => void, thisArg?: unknown): void;
    keys(): IterableIterator<T>;
    values(): IterableIterator<T>;
    entries(): IterableIterator<[T, T]>;
    [Symbol.iterator](): IterableIterator<T>;
    /** Add multiple values at once (single trigger) */
    addAll(values: Iterable<T>): ReactiveSet<T>;
    /** Delete multiple values at once (single trigger) */
    deleteAll(values: Iterable<T>): number;
}

/**
 * A reactive Map-like object that triggers updates on mutations.
 */
export interface ReactiveMap<K, V> {
    set(key: K, value: V): ReactiveMap<K, V>;
    get(key: K): V | undefined;
    delete(key: K): boolean;
    has(key: K): boolean;
    clear(): void;
    readonly size: number;
    forEach(callback: (value: V, key: K, map: ReactiveMap<K, V>) => void, thisArg?: unknown): void;
    keys(): IterableIterator<K>;
    values(): IterableIterator<V>;
    entries(): IterableIterator<[K, V]>;
    [Symbol.iterator](): IterableIterator<[K, V]>;
    /** Set multiple key-value pairs at once (single trigger) */
    setAll(entries: Iterable<[K, V]>): ReactiveMap<K, V>;
    /** Delete multiple keys at once (single trigger) */
    deleteAll(keys: Iterable<K>): number;
}

/**
 * Create a reactive Set that triggers updates on mutations.
 * Note: Sets in reactive state are auto-wrapped, so this is mainly for
 * creating reactive sets outside of component state.
 *
 * @param initial - Initial values for the Set
 * @returns A reactive Set-like object
 */
export function reactiveSet<T>(initial?: Iterable<T>): ReactiveSet<T>;

/**
 * Create a reactive Map that triggers updates on mutations.
 * Note: Maps in reactive state are auto-wrapped, so this is mainly for
 * creating reactive maps outside of component state.
 *
 * @param initial - Initial entries for the Map
 * @returns A reactive Map-like object
 */
export function reactiveMap<K, V>(initial?: Iterable<[K, V]>): ReactiveMap<K, V>;

/**
 * Check if an object is a reactive collection (reactiveSet or reactiveMap).
 *
 * @param obj - Object to check
 * @returns True if object is a reactive collection
 */
export function isReactiveCollection(obj: unknown): boolean;

/**
 * Execute a function without tracking reactive dependencies.
 * Any state accessed during the callback won't become a dependency
 * of the current effect. However, new effects created inside the callback
 * will track their own dependencies normally.
 *
 * @param fn - Callback to execute without current effect context
 * @returns Return value of the callback
 *
 * @example
 * createEffect(() => {
 *   // This will NOT be tracked as a dependency:
 *   const largeData = withoutTracking(() => this.state.hugeArray);
 *   // This WILL be tracked:
 *   console.log(this.state.filter);
 * });
 */
export function withoutTracking<T>(fn: () => T): T;

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
 * Memoize a function result based on explicit dependencies.
 * Re-runs the function only when dependencies change.
 *
 * @param fn - Function to memoize
 * @param deps - Function returning a dependency array, re-evaluated on every
 *   call (use this for reactive state). A static array is snapshotted once
 *   and only useful for fixed values.
 * @returns Memoized function
 *
 * @example
 * const expensiveRender = memo(() => {
 *   return html`<div>${this.state.items.length} items</div>`;
 * }, () => [this.state.items]);
 */
export function memo<T extends (...args: any[]) => any>(
  fn: T,
  deps?: (() => unknown[]) | unknown[]
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

/**
 * Resolve after the next effect flush AND DOM commit complete. If no flush is
 * pending, one is scheduled, so `mutate; await nextRender()` always works.
 * Newly mounted conditional branches are present when it resolves.
 *
 * Also available as `this.nextRender()` on components (delegates to this).
 *
 * @returns Promise that resolves once the DOM is up to date
 *
 * @example
 * this.state.showPanel = true;
 * await nextRender();          // DOM updated; new branches mounted
 * this.refs.panel.scrollTop = 0;
 */
export function nextRender(): Promise<void>;

// =============================================================================
// Versioned List
// =============================================================================

/**
 * A reactive array wrapper. Behaves like the array it wraps, plus:
 * structural edits bump a reactive version; reads of length/index/iteration
 * subscribe to it; items are returned raw (no per-item proxying).
 *
 * @template T - Item type
 */
export type VersionedList<T> = T[] & {
  /** Manually bump the version (for in-place item-field edits). */
  touch(): void;
  /** Replace all contents in one operation (single version bump). */
  replace(next: T[]): void;
  /** Reactive version integer - reading it subscribes to structural changes. */
  readonly version: number;
};

/**
 * Create a versioned list: a thin reactive wrapper over a raw array. Structural
 * edits (push/pop/shift/unshift/splice/sort/reverse/fill/copyWithin, index and
 * length writes) bump one reactive version cell; reads of length, numeric
 * indices, and iteration subscribe to it. Items are returned RAW - the same
 * performance contract as untracked() - so in-place item-field edits are NOT
 * tracked (use `.touch()` for those).
 *
 * Windowing integration is automatic: `count: () => list.length` becomes a
 * reactive read, so createWindowing refreshes with no manual refresh() call.
 *
 * @param initialArray - Backing array (used directly, not copied)
 * @returns The array wrapper with touch()/replace()/version
 *
 * @example
 * state = { songs: versionedList([]) };
 * this.state.songs.push(track);   // auto version bump -> re-render
 * this.state.songs.replace(next); // wholesale swap, single bump
 */
export function versionedList<T = any>(initialArray?: T[]): VersionedList<T>;

// =============================================================================
// Tasks
// =============================================================================

/**
 * A latest-wins async task. Carries STATUS (pending/error), never data -
 * commit results to real state from inside the task body.
 *
 * @template T - The task body's return type
 */
export interface Task<T = unknown> {
  /**
   * Abort the previous in-flight run and start a new one: `fn(signal, ...args)`.
   * Never rejects - resolves the body's return value when the run completed and
   * is still current, or undefined when superseded, aborted, or failed.
   */
  run(...args: any[]): Promise<T | undefined>;
  /** Abort the in-flight run (clears pending). */
  cancel(): void;
  /** Reactive: true while the latest run is in flight. */
  readonly pending: boolean;
  /** Reactive: the latest current run's failure (cleared when a new run starts). */
  readonly error: any;
  /** Cancel and permanently deactivate the task. */
  dispose(): void;
}

/**
 * Create a latest-wins async task (the imperative replacement-flow primitive;
 * awaitThen is the declarative one). `run()` aborts the previous run via an
 * AbortSignal passed to `fn`, so a superseded body's abort-aware awaits reject
 * before their state commits run - no manual request-ID guards needed.
 *
 * Also available as `this.createTask(fn)` on components (auto-disposed at unmount).
 *
 * @param fn - Task body; receives an AbortSignal that aborts on supersession
 * @returns The task (with a manual dispose())
 *
 * @example
 * const search = createTask(async (signal, q) => {
 *   const r = await fetch('/api/search?q=' + q, { signal });
 *   store.state.hits = (await r.json()).hits;   // reached only if still current
 * });
 * search.run('hello');
 */
export function createTask<T = unknown>(
  fn: (signal: AbortSignal, ...args: any[]) => Promise<T> | T
): Task<T>;

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
  keyFn?: (item: T, index: number) => string | number
): HtmlTemplate;

/**
 * Memoization cache for memoEach.
 */
export type MemoCache = Map<string | number, { item: unknown; result: HtmlTemplate }>;

/**
 * Options for memoEach().
 */
export interface MemoEachOptions {
  /**
   * If true, only compare keys (not item references).
   * Useful for virtual scroll where items may be different object refs with same key.
   * @default false
   */
  trustKey?: boolean;
  /**
   * External dependencies array. When any value changes, ALL items re-render.
   * Useful when item rendering depends on state outside the item itself.
   */
  deps?: unknown[];
  /**
   * Explicit cache Map (for advanced use cases).
   * Usually not needed - memoEach() automatically manages caches inside component templates.
   */
  cache?: MemoCache;
}

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
 * Only re-renders items that have changed (by reference, or by key if trustKey is true).
 *
 * When used inside a component template, caching is automatic.
 * Pass an explicit cache or options object for advanced use cases.
 *
 * @param array - Array to iterate over
 * @param mapFn - Function that returns template for each item
 * @param keyFn - Required function to extract unique key from item
 * @param options - Optional cache Map or options object with trustKey, deps, cache
 * @returns Compiled fragment template
 *
 * @example
 * // Automatic caching (recommended)
 * memoEach(songs, song => html`<div>${song.title}</div>`, song => song.uuid)
 *
 * // With explicit cache (backward compatible)
 * memoEach(songs, song => html`<div>${song.title}</div>`, song => song.uuid, this._cache)
 *
 * // With trustKey for virtual scroll (items may be different object refs with same key)
 * memoEach(songs, song => html`<div>${song.title}</div>`, song => song.uuid, { trustKey: true })
 *
 * // With deps for external state (busts ALL item caches when selection changes)
 * memoEach(items, (item, idx) => {
 *     const isSelected = this.state.selectedIndex === idx;
 *     return html`<div class="${isSelected ? 'selected' : ''}">${item.name}</div>`;
 * }, item => item.id, { deps: [this.state.selectedIndex] })
 */
export function memoEach<T>(
  array: T[] | null | undefined,
  mapFn: (item: T, index: number) => HtmlTemplate,
  keyFn: (item: T, index: number) => string | number,
  options?: MemoCache | MemoEachOptions
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
 *
 * This is both the shape returned by createStore() AND the base class for
 * class-authored stores (`class CartStore extends Store`). Class stores seed
 * reactive state in the constructor (`super(); this.state = {...}`); top-level
 * state keys are promoted onto the instance, getters become cached computeds,
 * and methods are auto-bound. The index signature covers those promoted
 * fields, computed getters, and methods on subclasses.
 *
 * @template T - State type
 */
export declare class Store<T = any> {
  constructor();

  /** The reactive state object (assign a plain object in the constructor to seed it) */
  readonly state: T;

  /**
   * Subscribe to store changes.
   * Callback is called immediately, then on each change (fine-grained).
   * @param callback - Function called on changes
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

  /** Dispose computed getters. Rarely needed - stores are usually singletons. */
  dispose(): void;

  /** Promoted state fields, computed getters, and methods on subclasses. */
  [key: string]: any;
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
