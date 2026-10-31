/** Empty slots render nothing. Strings and numbers become text nodes, never HTML. */
function isEmptySlot(node) {
  return node === undefined || node === null || node === false;
}

/** @param {unknown} node */
function toNode(node) {
  return typeof node === 'object'
    ? node
    : document.createTextNode(String(node));
}

/**
 * Builds DOM nodes. Strings become text nodes. Nothing is parsed as HTML, so
 * untrusted text (issue titles, provider notes, runner summaries) stays inert.
 *
 * @param {string} tag
 * @param {Record<string, unknown> | null} [props]
 * @param {...unknown} children
 * @returns {HTMLElement}
 */
export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key === 'class') {
      el.className = String(value);
    } else if (key === 'dataset') {
      for (const [name, data] of Object.entries(value)) {
        el.dataset[name] = String(data);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value);
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  el.append(
    ...children
      .flat(Infinity)
      .filter((c) => !isEmptySlot(c))
      .map(toNode),
  );
  return el;
}

/**
 * Replaces the children of `root` with `nodes`.
 *
 * @param {Element} root
 * @param {...unknown} nodes
 */
export function replaceChildren(root, ...nodes) {
  root.replaceChildren(
    ...nodes
      .flat(Infinity)
      .filter((n) => !isEmptySlot(n))
      .map(toNode),
  );
}
