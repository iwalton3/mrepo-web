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
// Conditional
${when(condition, html`<p>Yes</p>`, html`<p>No</p>`)}

// Lists
${each(items, item => html`<li>${item.name}</li>`)}

// Keyed lists (preserves DOM state)
${each(items, item => html`<li>${item.name}</li>`, item => item.id)}

// Memoized lists (performance)
${memoEach(items, item => html`<div>${item.name}</div>`, item => item.id)}

// Async data
${awaitThen(promise, data => html`<p>${data}</p>`, html`<p>Loading...</p>`)}

// Trusted HTML only
${raw(trustedHtml)}
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

**Critical - avoid infinite loops:**
```javascript
// WRONG - mutates in place, causes infinite loop
this.state.items.sort((a, b) => a.time - b.time)

// CORRECT - create copy first
[...this.state.items].sort((a, b) => a.time - b.time)
```

**Sets/Maps must be reassigned:**
```javascript
const newSet = new Set(this.state.items);
newSet.add(item);
this.state.items = newSet;
```

**Large arrays (100+ items):**
```javascript
import { untracked } from 'vdx/lib/framework.js';
data() { return { songs: untracked([]) }; }
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

// DON'T mutate reactive arrays in place
this.state.items.sort()        // WRONG - infinite loop
[...this.state.items].sort()   // CORRECT
```
