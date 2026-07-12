# VDX Framework Reference

Zero-dependency reactive web framework. No build step required.

## Component Pattern

Components are ES classes extending `Component`, registered with `defineComponent`. At runtime
`this` **is the custom element** (all DOM APIs work); the class gives full IDE autocomplete
for `this.state` and methods. (A legacy options-object format is also supported - see below.)

```javascript
import { defineComponent, Component, html } from 'vdx/lib/framework.js';

export class TodoList extends Component {
    static props = { title: 'Todos' };      // Observed attributes - NEVER declare props as class fields
    static stores = { cart: cartStore };    // access via this.stores.cart
    static styles = /*css*/`button { color: white; }`;

    constructor(props) {                    // Runs at FIRST CONNECT: props has real values
        super(props);
        this.state = { items: [], filter: props.title };  // wrapped reactive after constructor
    }

    get remaining() {                       // Getters become computed: lazy, cached, auto-disposed
        return this.state.items.filter(i => !i.done).length;
    }

    addItem(name) {                         // Methods auto-bound to the element
        this.state.items.push({ name, done: false });
    }

    template() { return html`<h1>${this.props.title}: ${this.remaining}</h1>`; }
    mounted() { /* DOM ready */ }
    unmounted() { /* cleanup */ }
}

export default defineComponent('todo-list', TodoList);   // import the class to inherit or re-namespace
```

**Rules and contracts:**
- **Constructor timing**: runs once per element at first connect (after attributes/children are
  captured), so `constructor(props)` can copy real prop values into state - React-style. It is
  NOT re-run on disconnect/reconnect (e.g. drag-reorder moves). Field-style
  `state = { n: this.props.start }` also works and sees real props.
- **Props go in `static props`, never class fields** - a prop-named field would shadow the
  generated accessor; the framework deletes it at mount and warns (`optimize.js --lint-only`
  also flags it). Same for fields named `children`, `slots`, or `style`.
- **Getters must read ONLY `state`/`stores`/`props`** - never refs, DOM measurements, or
  non-reactive instance fields. A getter mixing a reactive dep with a non-reactive read caches
  on the reactive dep and silently goes stale on the rest. A getter with NO reactive dep at
  all (and no props read) is detected at mount and re-evaluated per read instead of cached.
- **Migrating `data()` to a constructor changes timing**: `data()` saw prop *defaults* (values
  arrive later); the constructor sees *real* prop values. `data(){ return {v: this.props.value} }`
  moved to `constructor(props){ ...this.state = {v: props.value}; }` now seeds real data on
  first render - usually an improvement, but audit any `propsChanged`/`mounted` logic that
  assumed the initial state held defaults.
- **Inheritance works**: `class Fancy extends TodoList` - `static props`/`stores`/`styles`
  merge parent-first, `super.method()` works, getters can be overridden. Registering only the
  subclass is fine.
- **Tag collisions**: re-registering the same class/options is silent and idempotent; a
  *different* definition under an existing name warns and keeps the first. Export the class so
  consumers can `defineComponent('their-prefix-todo', TodoList)` under their own name.
- **Not real instances**: `el instanceof TodoList` is false (the element class is a framework
  internal - do not rely on component class identity). Private `#fields` work after mount, but
  a bound method touching them throws if called pre-mount.
- `data()` has no special meaning on classes (kept as a plain method, with a warning) - state
  initialization belongs in the constructor or a field.

## Legacy Options Format (deprecated)

Very old code may pass `defineComponent` an options object (`props`/`data()`/`methods`/
`computed`/`template`) instead of a class. It still runs (classes are translated into it
internally) but is deprecated - don't write new code in it. `tools/scripts/convert-to-class.mjs`
converts mechanically. One timing difference to know when reading old code: `data()` runs at
element construction, before prop *values* arrive (unlike a class constructor, which sees
real values). Details, if ever needed: docs/components.md.

## Event Binding

**Always use `on-*` attributes:**
```javascript
<button on-click="handleClick">Click</button>
<form on-submit-prevent="handleSubmit">...</form>       // -prevent / -stop chain
<input on-change="${(e, value) => this.state.x = value}">  // handler gets (event, value)
<div on-custom-event="handleCustom">  // Any event name works
<div on-touchmove-passive="handleTouch">  // -passive: never blocks scrolling
<div on-click-outside="closeMenu">        // fires on clicks outside the element
<cl-widget on-input-delegate="onInput">   // -delegate: also see native events from inner controls
```

Every handler is called with `(event, value)` - the resolved value as a 2nd arg (typed target
value for native controls, `event.detail.value` for custom elements). `-passive` handlers must
never call `preventDefault()` (ignored; the framework warns if combined with `-prevent`).

## Two-Way Binding (x-model)

```javascript
state = { name: '', age: 0, agreed: false };
template() {
    return html`
        <input type="text" x-model="name">
        <input type="number" x-model="age">       <!-- auto number -->
        <input type="checkbox" x-model="agreed">  <!-- auto boolean -->
    `;
}
```

**`x-model` / `on-change` on a custom element** listen for the *component's own* change - a
`CustomEvent` it dispatches on the host via `this.emitChange(null, value)` - not native
`input`/`change` events that bubble up from an inner `<input>`. Those bubbled native events are
ignored so they can't clobber the binding, which means **a component that wraps a native input
must emit its own change** to be drivable. This holds for both `x-model` and a plain `on-change`,
and it composes: `x-model` + `on-change` on the same element both fire with `(event, value)`.
If you actually want the raw bubbled native events, opt in per-handler with `-delegate`
(`on-input-delegate="..."`).

## Template Helpers

```javascript
// Conditional (function form preferred - caches by condition)
${when(condition, () => html`<p>Yes</p>`, () => html`<p>No</p>`)}

// Lists
${each(items, item => html`<li>${item.name}</li>`)}

// Keyed lists (preserves DOM state)
${each(items, item => html`<li>${item.name}</li>`, item => item.id)}

// Memoized lists (performance). Windowed slices need trustKey; external
// state affecting all rows needs deps - see docs/performance.md
${memoEach(items.slice(a, b), item => html`<div>${item.name}</div>`, item => item.id, { trustKey: true })}

// Reactive boundary (isolates high-frequency updates from parent)
${contain(() => html`<div>${this.state.timer}</div>`)}

// Async data
${awaitThen(promise, data => html`<p>${data}</p>`, html`<p>Loading...</p>`)}

// Trusted HTML only
${raw(trustedHtml)}

// Fine-grained reactivity (auto-contain all expressions)
import { opt } from './lib/opt.js';
template: eval(opt(function() {
    return html`<p>${this.state.count}</p>`;  // Each ${} is isolated
}))
```

**⚠️ `raw()` re-inserts on every re-render.** Normal template content is diffed and its DOM
(and any live child-component state) is preserved across re-renders - even when the whole
component re-renders, the framework diffs *within* each template rather than rebuilding it.
`raw()` opts out of that: because it's an opaque source-code splice, every re-render destroys
and recreates the entire subtree it produced, resetting anything inside (child components,
form values, scroll position). If the `raw()` content should survive re-renders driven by
*unrelated* state, isolate it in a `contain()` keyed to only the state it actually depends on:

```javascript
// ❌ typing in a search box or toggling a theme re-inserts the demo, remounting it
${raw(this.state.current.demo)}

// ✅ contain() re-runs only when `current` changes, so unrelated re-renders leave it alone
${contain(() => raw(this.state.current.demo))}
```

## Passing Props

Objects, arrays, and functions pass automatically:
```javascript
<child-component
    items="${this.state.items}"
    onSelect="${this.handleSelect}">
</child-component>
```

In static HTML (outside templates), camelCase props are set via kebab-case attributes:
```html
<unit-converter from-unit="liters" initial-value="10"></unit-converter>
<!-- from-unit="..." sets this.props.fromUnit (always a string) -->
```

## Children & Slots

```javascript
// Default children
template() {
    return html`<div class="wrapper">${this.props.children}</div>`;
}

// Named slots
const footer = this.props.slots.footer || [];
return html`
    <div>${this.props.children}</div>
    <footer>${footer}</footer>
`;

// Usage
<my-dialog>
    <p>Content</p>
    <div slot="footer"><button>OK</button></div>
</my-dialog>
```

## Refs

```javascript
template() {
    return html`<input ref="myInput" type="text">`;
}
focus() { this.refs.myInput.focus(); }
```

**Refs are for already-mounted nodes.** A `ref` on a node that is *conditionally shown this
tick* is not populated synchronously - even right after `flushSync(() => this.state.editing = true)`,
`this.refs.myInput` can still be empty. `await this.nextRender()` waits through branch
mounting, so the node IS there afterwards:

```javascript
async startEdit() {
    this.state.editing = true;
    await this.nextRender();               // DOM committed, new branches mounted
    const input = this.querySelector('.my-input');
    if (input) { input.focus(); input.select(); }
}
```

Prefer `this.querySelector(...)` over `this.refs` for nodes in a freshly-swapped template
branch. To wait for a **child component** (including one whose definition lazy-loads), use
`const el = await this.whenMounted('child-tag'); if (!el) return;` - it resolves after the
child's first render + `mounted()`, and resolves `null` if *this* component unmounts while
waiting.

## Reactivity Rules

**sort()/reverse() are safe** - made atomic automatically:
```javascript
this.state.items.sort((a, b) => a.time - b.time)  // ✅ Works
this.state.items.reverse()  // ✅ Works
```

**Sets/Maps are automatically reactive:**
```javascript
state = { ids: new Set(), scores: new Map() };
this.state.ids.add(1);        // ✅ Triggers re-render
this.state.scores.set('a', 1); // ✅ Triggers re-render

// Batch operations (single trigger):
this.state.ids.addAll([1, 2, 3]);
this.state.scores.setAll([['a', 1], ['b', 2]]);
```

**Array iteration is O(1)** - large arrays work efficiently:
```javascript
// Iterating 2000 items creates 1 dependency, not 2000
each(this.state.items, item => html`<div>${item.name}</div>`)
```

**contain()/opt() require reactive access INSIDE the closure:**
```javascript
// ❌ BAD - Variable captured before template, won't update
const count = this.state.count;
return html`<p>${count}</p>`;  // contain(() => count) has no dependencies!

// ✅ GOOD - Reactive access inside template
return html`<p>${this.state.count}</p>`;  // contain(() => this.state.count) works

// ✅ GOOD - Use a getter (computed: lazy, cached, auto-disposed; read as a property)
get doubled() { return this.state.count * 2; }
template() {
    return html`<p>${this.doubled}</p>`;  // Tracked inside contain()
}

// ✅ ALSO GOOD - Plain method (recomputed on every call, not cached)
doubled() { return this.state.count * 2; }
template() {
    return html`<p>${this.doubled()}</p>`;  // Called inside contain()
}
```

**when()/each() do NOT create boundaries** — captured variables work fine there (the
template's own effect re-runs); this rule is specific to `contain()`/`opt()`. Function-form
`when()` branches exist for lazy evaluation, not tracking:
```javascript
// ✅ FINE - when/each have no boundary; isAdmin still updates
const isAdmin = this.stores.auth.isAdmin;
${when(isAdmin, () => html`<admin-panel></admin-panel>`)}

// Function-form branch: only evaluated when shown, so this is null-safe
${when(this.state.user, () => html`<p>${this.state.user.name}</p>`)}
```

**Optional: untracked() / versionedList() to skip per-item proxying:**
```javascript
import { untracked, versionedList } from 'vdx/lib/framework.js';
state = { raw: untracked([]) };           // fully inert: reassign to update
state = { songs: versionedList([]) };     // items raw, but push/splice/index
                                          // writes auto-notify (preferred)
```

**Computed values are never stale** - invalidation is synchronous on writes, so reading a computed right after mutating its deps is safe (mutate-then-emit-event patterns):
```javascript
this.state.items.push(item);
this.emitChange(null, this.total);  // computed `total` is already fresh
```

**Proxy identity is stable** - `state.items[0] === state.items[0]` holds (cached proxies). But a raw object captured before insertion !== its proxied read; compare primitives when mixing raw and proxied references.

**Waiting for the DOM (prefer async):**
```javascript
import { nextRender } from 'vdx/lib/framework.js';
this.state.showInput = true;
await nextRender();            // effects flushed, DOM committed, new branches mounted
this.querySelector('input').focus();
```
`flushSync(() => { ... })` still exists for genuinely synchronous needs (tests, same-frame
scroll handoff), but it does NOT mount new conditional branches - `await nextRender()` does.

**Large lists (versionedList):** for arrays too big to deep-proxy, `versionedList([])` wraps a
raw array so structural edits (`push`/`splice`/index writes) auto-notify while items stay
untracked. Reads of `length`/indices subscribe, so templates and `createWindowing`'s `count()`
update with no manual refresh. `.touch()` for in-place item edits, `.replace(arr)` for
wholesale swaps. This replaces the hand-rolled untracked-array + version-counter pattern.

## Stores

Author stores as classes - methods on the instance, reactive data in `this.state`, ordinary
fields for non-reactive internals (audio nodes, sockets):

```javascript
import { Store } from 'vdx/lib/framework.js';

class UserStore extends Store {
    constructor() {
        super();
        this.state = { name: '', capabilities: [] };   // reactive, like a component
    }
    _client = new ApiClient();                          // plain field: NOT reactive
    async logout() { await this._client.logout(); this.state.name = ''; }
    get isAdmin() { return this.state.capabilities.includes('admin'); }  // cached computed
}
export const userStore = new UserStore();
```

State keys are promoted onto the instance (`userStore.name` ⇄ `userStore.state.name`), so in
components state fields, computed getters, AND methods all hang off `this.stores.name`:

```javascript
class MyComponent extends Component {
    static stores = { user: userStore };
    template() {
        return html`<p>${this.stores.user.name}</p>
            <button on-click="${() => this.stores.user.logout()}">Log out</button>`;
    }
}
```

Rules: assign `this.state` in the constructor (a `state = {...}` CLASS FIELD bypasses the
reactive setter and throws at first use); declare top-level keys up front; a state key that
collides with a method/getter/reserved name throws at construction. `subscribe(fn)` returns
an unsubscribe function. The older `createStore(initial)` factory still works (methods live
on `.state` there, called as `store.state.method()`); both kinds coexist in one component.

## Async Tasks (createTask)

The latest-wins primitive for imperative async flows (search-as-you-type, re-fetch on
navigation). **A task carries status, never data** - the body commits results to real state:

```javascript
class SearchPage extends Component {
    search = this.createTask(async (signal, query) => {
        const r = await fetch('/api/search?q=' + encodeURIComponent(query), { signal });
        this.state.hits = (await r.json()).hits;   // reached only if still current
    });
    onInput(e, value) { this.search.run(value); }
    template() {
        return html`${when(this.search.pending, () => html`<cl-spinner></cl-spinner>`)}
            ${each(this.state.hits, h => html`...`, h => h.id)}`;
    }
}
```

- `run()` aborts the previous in-flight run; abort **throws** through abort-aware awaits
  (fetch), so a superseded body never reaches its commit lines. After a non-abort-aware
  await, call `signal.throwIfAborted()`.
- `await task.run(q)` never rejects: resolves the body's return value when current,
  `undefined` when superseded/aborted/failed. Current-run failures land on reactive
  `task.error`; `pending`/`error` are template-trackable. `task.cancel()` aborts.
- `this.createTask(fn)` auto-cancels in-flight runs at unmount but stays usable (a class-field
  task survives DOM moves/reconnection); the standalone `createTask(fn)` export (for stores)
  needs a manual `task.dispose()`.
- **Not for appends**: if aborting the previous run would lose data (overlapping
  `loadMore()` pages), it's not a createTask - use a busy-guard
  (`if (this.state.isLoading) return;`) and re-check after each load.

## Router

```javascript
import { enableRouting } from 'vdx/lib/router.js';

// A second enableRouting call warns and merges routes into the existing router
enableRouting(outlet, {
    '/': { component: 'home-page' },
    '/users/:id/': { component: 'user-page' },   // params in this.props.params
    '/files/:path*/': { component: 'file-page' }, // wildcard: multi-segment param
    '/admin/': { component: 'admin-page', require: 'admin' }  // fails closed
}, {
    // Routes with `require` are DENIED unless this approves
    checkCapability: (required) => auth.state.capabilities.includes(required)
});

// Navigation
<router-link to="/users/123/">View User</router-link>
```

## Error Boundaries

```javascript
class MyComponent extends Component {
    template() { /* may throw */ }
    renderError(error) {
        return html`<cl-error-boundary error="${error}" showRetry="true"></cl-error-boundary>`;
    }
}
defineComponent('my-component', MyComponent);
```

## Component Library (cl-*)

Common components from `vdx/ui/`:

```javascript
// Buttons
<cl-button label="Save" on-click="save"></cl-button>
<cl-button label="Delete" severity="danger"></cl-button>

// Form inputs
<cl-input-text x-model="name" label="Name"></cl-input-text>
<cl-select-box options="${options}" x-model="selected"></cl-select-box>
<cl-checkbox x-model="agreed" label="I agree"></cl-checkbox>

// Dialogs
<cl-dialog visible="${showDialog}" header="Confirm" on-hide="closeDialog">
    <p>Are you sure?</p>
</cl-dialog>

// Tables
<cl-datatable items="${rows}" columns="${cols}"></cl-datatable>
```

## Virtual Scrolling (createWindowing)

```javascript
import { createWindowing } from 'vdx/lib/windowing.js';

constructor(props) {
    super(props);
    // Created in the constructor so window state exists for the first render
    this._win = createWindowing(this, {
        itemHeight: 52,
        count: () => this.state.items.length,
        scrollContainer: 'self',   // 'self' | 'parent' | 'window' | selector
        onRange: (start, end) => this.maybeLoadMore(end)   // optional
    });
    this.state = { items: untracked([]) };
}
unmounted() { this._win.destroy(); }
template() {
    const win = this._win;
    return html`
        <div class="spacer" style="height: ${win.totalHeight}px;"></div>
        <div class="window" style="transform: translateY(${win.offsetY}px);">
            ${memoEach(this.state.items.slice(win.visibleStart, win.visibleEnd),
                item => html`...`, item => item.id, { trustKey: true })}
        </div>
    `;
}
```

With a `versionedList()` item source, `count: () => this.state.songs.length` is a reactive
read - the window recomputes on structural edits with no manual call. Call
`this._win.refresh()` only after replacing a fully-`untracked()` source or a programmatic
scroll. Or just use `<cl-virtual-list>`. Full guide: [docs/performance.md](docs/performance.md).

## List Gestures (createRowGestures)

Drag-reorder, long-press, and touch-drag for list rows - composes with windowing:

```javascript
import { createRowGestures } from 'vdx/lib/gestures.js';

constructor(props) {
    super(props);
    this._g = createRowGestures(this, {
        itemHeight: 52,
        windowing: this._win,                       // optional composition
        onReorder: (fromIndices, gap) => { ... },   // gap pre-clamped, no-ops filtered
        onTap: (i, e) => { ... }, onLongPress: (i, e) => { ... }
    });
    ...
}
```

Rows bind thin delegations (`on-dragover="${(e) => this._g.dragOver(index, e)}"` etc.). Passive-safety is a module invariant: `touchStart`/`touchMove` never preventDefault (bind `-passive`); `touchEnd` and the drag-handle `handleTouch*` suite may (bind non-passive). Translate the gap with the pure helpers: `gapToRemoveInsertIndex(from, gap)` for splice APIs, `gapToGapIndex` for gap-semantic APIs, `groupReorderTargets` for batches. `<cl-virtual-list reorderable>` is the packaged version (emits `reorder` with `{ fromIndices, gap, from, to }`; the consumer applies the change).

## Reactive Boundaries (Critical for Performance)

Templates re-evaluate as a single unit - you can't track individual `${}` slots separately. For frequently updating values mixed with expensive content, use reactive boundaries:

```javascript
// ❌ ANTIPATTERN: High-frequency updates in large templates
// Every currentTime update re-evaluates the entire template including memoEach
template() {
    return html`
        <div class="time">${this.stores.player.currentTime}</div>
        ${memoEach(this.state.songs, song => html`...`, song => song.uuid)}
    `;
}

// ✅ CORRECT: Isolate high-frequency updates with contain()
template() {
    return html`
        ${contain(() => html`<div class="time">${this.stores.player.currentTime}</div>`)}
        ${memoEach(this.state.songs, song => html`...`, song => song.uuid)}
    `;
}
```

**When to use reactive boundaries:**
- `contain()` - Isolate frequently updating values (timers, progress, animations)
- Child components - Moving content to a child naturally isolates its updates

**Note:** `when()` and `each()` do NOT create boundaries by default - they work like regular JavaScript.

**The rule:** If a template has both high-frequency updates AND expensive content (large lists, complex rendering), use `contain()` or move content to child components.

For virtual scrolling, memoEach invalidation strategies (composite keys, deps, version counters), and 60fps non-reactive islands, see [docs/performance.md](docs/performance.md). For drag-reorder/long-press/touch-drag list gestures, use `createRowGestures` from `lib/gestures.js` (composes with `createWindowing`).

## Build-Time Optimizer

The optimizer applies fine-grained reactivity transformations at build time:

```bash
# Optimize for production
node optimize.js -i ./app -o ./dist

# Check for issues the optimizer CAN'T fix (CI integration)
node optimize.js -i ./app --lint-only
```

**Lint mode (`--lint-only`)** - Detects patterns that break reactivity inside `contain()`:
```javascript
// ❌ DETECTED: contain() callback captures dead value
const { count } = this.state;
${contain(() => html`<p>${count}</p>`)}  // count never updates!

// ✅ SAFE: Access state inside contain()
${contain(() => html`<p>${this.state.count}</p>`)}

// ✅ SAFE: when/each work fine with captured variables (no boundaries)
const { items } = this.state;
${each(items, item => html`...`)}  // works - parent re-renders when items change
```

**Coding assistants should run lint mode to verify contain() callbacks access state correctly.**

## Anti-Patterns

```javascript
// DON'T use onclick - use on-click
<button onclick="...">  // WRONG
<button on-click="..."> // CORRECT

// DON'T stringify objects
options="${JSON.stringify(items)}"  // WRONG
options="${items}"                   // CORRECT

// DON'T manually bind methods - they're auto-bound
this._bound = this.method.bind(this)  // WRONG
renderItem="${this.method}"           // CORRECT

```

---

## Using This File

Projects using VDX can reference this in their CLAUDE.md:

```markdown
## Framework

This project uses the VDX framework. See [FRAMEWORK.md](path/to/vdx/FRAMEWORK.md) for patterns.
```
