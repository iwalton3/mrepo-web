# VDX Framework Reference

Zero-dependency reactive web framework. No build step required.

## Component Pattern

```javascript
import { defineComponent, html, when, each } from 'vdx/lib/framework.js';

export default defineComponent('my-component', {
    props: { title: 'Default' },          // Observed attributes
    data() { return { count: 0 }; },      // Reactive state

    mounted() { /* DOM ready */ },
    unmounted() { /* cleanup timers/subscriptions */ },

    methods: {
        increment() { this.state.count++; }
    },

    template() {
        return html`
            <h1>${this.props.title}</h1>
            <p>Count: ${this.state.count}</p>
            <button on-click="increment">+1</button>
        `;
    },

    styles: /*css*/`button { background: #007bff; color: white; }`
});
```

## Event Binding

**Always use `on-*` attributes:**
```javascript
<button on-click="handleClick">Click</button>
<form on-submit-prevent="handleSubmit">...</form>
<input on-change="handleChange">
<div on-custom-event="handleCustom">  // Any event name works
```

## Two-Way Binding (x-model)

```javascript
data() { return { name: '', age: 0, agreed: false }; },
template() {
    return html`
        <input type="text" x-model="name">
        <input type="number" x-model="age">       <!-- auto number -->
        <input type="checkbox" x-model="agreed">  <!-- auto boolean -->
    `;
}
```

## Template Helpers

```javascript
// Conditional (function form preferred - caches by condition)
${when(condition, () => html`<p>Yes</p>`, () => html`<p>No</p>`)}

// Lists
${each(items, item => html`<li>${item.name}</li>`)}

// Keyed lists (preserves DOM state)
${each(items, item => html`<li>${item.name}</li>`, item => item.id)}

// Memoized lists (performance)
${memoEach(items, item => html`<div>${item.name}</div>`, item => item.id)}

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

## Passing Props

Objects, arrays, and functions pass automatically:
```javascript
<child-component
    items="${this.state.items}"
    onSelect="${this.handleSelect}">
</child-component>
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
},
methods: {
    focus() { this.refs.myInput.focus(); }
}
```

## Reactivity Rules

**sort()/reverse() are safe** - made atomic automatically:
```javascript
this.state.items.sort((a, b) => a.time - b.time)  // ✅ Works
this.state.items.reverse()  // ✅ Works
```

**Sets/Maps are automatically reactive:**
```javascript
data() { return { ids: new Set(), scores: new Map() }; }
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

// ✅ GOOD - Use getter methods for computed values
methods: {
    get doubled() { return this.state.count * 2; }
},
template() {
    return html`<p>${this.doubled}</p>`;  // Getter called inside contain()
}
```

**Same applies to when()/each() function callbacks** (they create reactive boundaries):
```javascript
// ❌ BAD - isAdmin captured before callback
const isAdmin = this.stores.auth.isAdmin;
${when(isAdmin, () => html`<admin-panel></admin-panel>`)}

// ✅ GOOD - Access inside callback
${when(this.stores.auth.isAdmin, () => html`<admin-panel></admin-panel>`)}
```

**Optional: untracked() to skip proxying entirely:**
```javascript
import { untracked } from 'vdx/lib/framework.js';
data() { return { songs: untracked([]) }; }  // Items aren't reactive
```

**Immediate DOM updates:**
```javascript
import { flushSync } from 'vdx/lib/framework.js';
flushSync(() => { this.state.showInput = true; });
this.refs.input.focus();
```

## Stores

```javascript
// Auto-subscribe pattern (recommended)
import userStore from './stores/user.js';

defineComponent('my-component', {
    stores: { userStore },
    template() {
        return html`<p>${this.stores.userStore.name}</p>`;
    },
    methods: {
        logout() { userStore.state.logout(); }  // Call methods on .state
    }
});
```

## Router

```javascript
import { enableRouting } from 'vdx/lib/router.js';

enableRouting(outlet, {
    '/': { component: 'home-page' },
    '/users/:id/': { component: 'user-page' },  // params in this.props.params
});

// Navigation
<router-link to="/users/123/">View User</router-link>
```

## Error Boundaries

```javascript
defineComponent('my-component', {
    template() { /* may throw */ },
    renderError(error) {
        return html`<cl-error-boundary error="${error}" showRetry="true"></cl-error-boundary>`;
    }
});
```

## Component Library (cl-*)

Common components from `vdx/componentlib/`:

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
