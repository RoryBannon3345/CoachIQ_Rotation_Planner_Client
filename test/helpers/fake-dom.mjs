// fake-dom.mjs — the smallest real DOM that can boot and drive src/ui.js under `node --test`,
// with no dependency (jsdom/happy-dom/etc. are not installed in this project on purpose).
//
// Scope is deliberately narrow: it implements exactly the DOM surface ui.js itself touches
// (see the `Grep` audit that produced this list) — getElementById, a two-clause attribute/class
// matcher for closest()/querySelectorAll(), delegated click bubbling, .value on input/textarea,
// and no-op focus()/setSelectionRange(). It does NOT attempt to be a general HTML parser: it
// only has to parse what ui.js's own template strings produce.
//
// document.querySelector() always returns null here (see comment on the method) — every call
// site in ui.js null-checks its result, since it exists purely to preserve scroll position
// across a re-render, which this harness has no reason to exercise.

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img']);

// Splits a selector into its clauses (`.class` or `[attr]`/`[attr="value"]`) — every selector
// ui.js or this test file ever builds is a run of such clauses ANDed together on one element,
// with no combinators (no descendant/child selectors), so that is all this needs to support.
function selectorClauses(selector) {
  return selector.match(/\.[a-zA-Z0-9_-]+|\[[^\]]+\]/g) || [];
}

class FakeElement {
  constructor(tagName, attrs) {
    this.tagName = tagName.toUpperCase();
    this._attrs = attrs; // Map<string,string>
    this.children = [];
    this.parentNode = null;
    this._value = undefined;
    this._listeners = {};
    this.dataset = {};
    for (const [k, v] of attrs) {
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[camel] = v;
      }
    }
  }

  get id() {
    return this._attrs.get('id') || '';
  }

  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }

  hasAttribute(name) {
    return this._attrs.has(name);
  }

  get value() {
    return this._value;
  }

  set value(v) {
    this._value = v;
  }

  focus() {
    /* no-op: this harness does not model focus for the flows it drives */
  }

  setSelectionRange() {
    /* no-op, same as focus() */
  }

  matches(selector) {
    const clauses = selectorClauses(selector);
    return clauses.every((clause) => {
      if (clause.startsWith('.')) {
        const cls = clause.slice(1);
        return (this._attrs.get('class') || '').split(/\s+/).includes(cls);
      }
      const inner = clause.slice(1, -1);
      const m = /^([a-zA-Z0-9_-]+)(?:="([^"]*)")?$/.exec(inner);
      if (!m) return false;
      const [, attrName, attrVal] = m;
      if (attrVal === undefined) return this._attrs.has(attrName);
      return this._attrs.get(attrName) === attrVal;
    });
  }

  closest(selector) {
    let el = this;
    while (el) {
      if (typeof el.matches === 'function' && el.matches(selector)) return el;
      el = el.parentNode;
    }
    return null;
  }

  addEventListener(type, handler) {
    (this._listeners[type] ??= []).push(handler);
  }

  // Delegated-event bubbling, matching how ui.js listens (click/keydown are only ever bound on
  // #app). Walks target -> ... -> root, invoking every listener registered for `type` at each
  // level, in bubble order. No stopPropagation support: nothing in ui.js calls it.
  dispatchEvent(type) {
    const event = { target: this, currentTarget: null, preventDefault() {}, defaultPrevented: false };
    let el = this;
    while (el) {
      event.currentTarget = el;
      const handlers = el._listeners[type];
      if (handlers) for (const h of handlers.slice()) h(event);
      el = el.parentNode;
    }
    return event;
  }

  click() {
    return this.dispatchEvent('click');
  }
}

/** Parses one of ui.js's rendered HTML strings into a FakeElement tree rooted at `parent`. */
function parseInto(parent, html) {
  const VOID = VOID_TAGS;
  const stack = [parent];
  let i = 0;
  const len = html.length;
  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    if (html[lt + 1] === '/') {
      const gt = html.indexOf('>', lt);
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }
    const gt = html.indexOf('>', lt);
    if (gt === -1) break;
    let tagContent = html.slice(lt + 1, gt);
    const selfClose = tagContent.endsWith('/');
    if (selfClose) tagContent = tagContent.slice(0, -1);
    const tagMatch = /^([a-zA-Z][\w-]*)/.exec(tagContent);
    if (!tagMatch) {
      i = gt + 1;
      continue;
    }
    const tagName = tagMatch[1];
    const rest = tagContent.slice(tagName.length);
    const attrs = new Map();
    const attrRe = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*"([^"]*)")?/g;
    let m;
    while ((m = attrRe.exec(rest))) {
      attrs.set(m[1], m[2] !== undefined ? decodeEntities(m[2]) : '');
    }
    const el = new FakeElement(tagName, attrs);
    el.parentNode = stack[stack.length - 1];
    stack[stack.length - 1].children.push(el);
    i = gt + 1;
    const lowerTag = tagName.toLowerCase();
    if (lowerTag === 'textarea') {
      const closeIdx = html.indexOf('</textarea>', i);
      const inner = closeIdx === -1 ? '' : html.slice(i, closeIdx);
      el._value = decodeEntities(inner);
      i = closeIdx === -1 ? len : closeIdx + '</textarea>'.length;
      continue;
    }
    if (VOID.has(lowerTag) || selfClose) {
      if (lowerTag === 'input') el._value = attrs.get('value') || '';
      continue;
    }
    stack.push(el);
  }
}

function findById(root, id) {
  if (root.id === id) return root;
  for (const c of root.children) {
    const found = findById(c, id);
    if (found) return found;
  }
  return null;
}

function collectMatches(root, selector, out) {
  if (root.matches && root.matches(selector)) out.push(root);
  for (const c of root.children) collectMatches(c, selector, out);
  return out;
}

/**
 * Builds one fresh `document` + its permanent `#app` mount element, the way index.html provides
 * it. `#app` itself is never replaced (matching the real DOM) — only its children are rebuilt on
 * every `app.innerHTML = html` assignment, exactly like ui.js's own render().
 */
export function createFakeDom() {
  const appEl = new FakeElement('div', new Map([['id', 'app']]));
  Object.defineProperty(appEl, 'innerHTML', {
    get() {
      return this._html || '';
    },
    set(html) {
      this._html = html;
      this.children = [];
      parseInto(this, html);
    },
  });

  const document = {
    _listeners: {},
    activeElement: null,
    hidden: false,
    getElementById(id) {
      return findById(appEl, id);
    },
    // Only ever used by ui.js's render() to preserve a scroll offset across re-renders — every
    // call site null-checks the result, so a harness with no notion of scrolling can safely
    // always report "not found" without breaking anything it drives.
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return collectMatches(appEl, selector, []);
    },
    addEventListener(type, handler) {
      (this._listeners[type] ??= []).push(handler);
    },
  };

  return { document, appEl };
}

/** Waits for any pending microtask chain (an `await`ed clipboard/share promise, say) to settle
 * before the caller inspects state — needed because ui.js's own click handlers never await the
 * async ones they invoke (matching real delegated DOM events, which don't either). */
export function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}
