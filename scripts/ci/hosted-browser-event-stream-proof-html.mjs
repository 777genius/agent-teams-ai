function parseTag(html, start) {
  if (html[start] !== '<' || html.startsWith('<!--', start)) return null;
  let cursor = start + 1;
  const closing = html[cursor] === '/';
  if (closing) cursor += 1;
  const nameStart = cursor;
  while (/[A-Za-z0-9-]/u.test(html[cursor] ?? '')) cursor += 1;
  const name = html.slice(nameStart, cursor).toLowerCase();
  if (!name || !/[A-Za-z]/u.test(name[0])) return null;
  const attributes = new Map();
  while (cursor < html.length && html[cursor] !== '>') {
    if (/\s/u.test(html[cursor])) {
      cursor += 1;
      continue;
    }
    if (html[cursor] === '/' && html[cursor + 1] === '>')
      return { attributes, closing, end: cursor + 2, name };
    const keyStart = cursor;
    while (cursor < html.length && !/[\s=>]/u.test(html[cursor])) cursor += 1;
    const key = html.slice(keyStart, cursor).toLowerCase();
    if (!key || key.includes('<') || key.includes('`') || attributes.has(key)) return null;
    while (/\s/u.test(html[cursor] ?? '')) cursor += 1;
    let value = '';
    if (html[cursor] === '=') {
      cursor += 1;
      while (/\s/u.test(html[cursor] ?? '')) cursor += 1;
      const quote = html[cursor];
      if (quote !== '"' && quote !== "'") return null;
      const end = html.indexOf(quote, cursor + 1);
      if (end < 0) return null;
      value = html.slice(cursor + 1, end);
      cursor = end + 1;
    }
    attributes.set(key, value);
  }
  return html[cursor] === '>' ? { attributes, closing, end: cursor + 1, name } : null;
}

const HOSTED_PRODUCT_TITLE = 'Agent Teams AI';
const HOSTED_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; worker-src 'self' blob:";

function closingRawTextTag(html, from, tagName) {
  const marker = `</${tagName}`;
  for (let cursor = from; cursor < html.length; ) {
    const found = html.toLowerCase().indexOf(marker, cursor);
    if (found < 0) return -1;
    const tag = parseTag(html, found);
    if (tag?.closing && tag.name === tagName) return { end: tag.end, start: found };
    cursor = found + 1;
  }
  return -1;
}

/**
 * Extract only straightforward active module scripts. Any construct whose
 * browser parsing is not established by this small scanner is rejected.
 */
export function extractHostedHtmlModuleScriptPaths(html) {
  if (typeof html !== 'string') return null;
  const paths = [];
  let contentSecurityPolicyCount = 0;
  let doctypeCount = 0;
  let htmlOpen = false;
  let htmlClosed = false;
  let headOpen = false;
  let headClosed = false;
  let bodyOpen = false;
  let bodyClosed = false;
  let productTitleCount = 0;
  const bodyElements = [];
  for (let cursor = 0; cursor < html.length; ) {
    const next = html.indexOf('<', cursor);
    if (html.slice(cursor, next < 0 ? undefined : next).trim() !== '') return null;
    if (next < 0) break;
    if (html.startsWith('<!--', next)) {
      const end = html.indexOf('-->', next + 4);
      if (end < 0) return null;
      cursor = end + 3;
      continue;
    }
    if (/^<!doctype\s/iu.test(html.slice(next))) {
      const end = html.indexOf('>', next + 2);
      if (
        end < 0 ||
        html.slice(next, end + 1).toLowerCase() !== '<!doctype html>' ||
        htmlOpen ||
        doctypeCount !== 0
      ) {
        return null;
      }
      doctypeCount += 1;
      cursor = end + 1;
      continue;
    }
    const tag = parseTag(html, next);
    if (tag === null) return null;
    cursor = tag.end;
    if (tag.closing) {
      if (tag.attributes.size !== 0) return null;
      if (tag.name === 'head') {
        if (!headOpen || headClosed || bodyOpen) return null;
        headOpen = false;
        headClosed = true;
      } else if (tag.name === 'body') {
        if (!bodyOpen || bodyClosed || !headClosed || bodyElements.length !== 0) return null;
        bodyOpen = false;
        bodyClosed = true;
      } else if (tag.name === 'html') {
        if (!htmlOpen || htmlClosed || !headClosed || !bodyClosed) return null;
        htmlOpen = false;
        htmlClosed = true;
      } else if (tag.name === 'div') {
        if (!bodyOpen || bodyElements.pop() !== 'div') return null;
      } else {
        return null;
      }
      continue;
    }
    if (tag.name === 'html') {
      if (
        htmlOpen ||
        htmlClosed ||
        doctypeCount !== 1 ||
        tag.attributes.size !== 1 ||
        tag.attributes.get('lang')?.toLowerCase() !== 'en'
      ) {
        return null;
      }
      htmlOpen = true;
      continue;
    }
    if (tag.name === 'head') {
      if (!htmlOpen || headOpen || headClosed || bodyOpen || tag.attributes.size !== 0) return null;
      headOpen = true;
      continue;
    }
    if (tag.name === 'body') {
      if (
        !htmlOpen ||
        headOpen ||
        !headClosed ||
        bodyOpen ||
        bodyClosed ||
        tag.attributes.size !== 0
      ) {
        return null;
      }
      bodyOpen = true;
      continue;
    }
    if (!htmlOpen || htmlClosed || (!headOpen && !bodyOpen)) return null;
    if (headOpen && !['meta', 'title', 'link', 'script'].includes(tag.name)) return null;
    if (bodyOpen && tag.name === 'div') {
      if (
        bodyElements.length !== 0 ||
        tag.attributes.size !== 1 ||
        tag.attributes.get('id') !== 'root'
      ) return null;
      bodyElements.push('div');
      continue;
    }
    if (bodyOpen && bodyElements.length !== 0) return null;
    if (bodyOpen && tag.name !== 'script') return null;
    if (tag.name === 'meta') {
      if (!headOpen) return null;
      const httpEquiv = tag.attributes.get('http-equiv')?.toLowerCase();
      if (httpEquiv === 'content-security-policy') {
        if (
          tag.attributes.size !== 2 ||
          tag.attributes.get('content') !== HOSTED_CONTENT_SECURITY_POLICY
        ) {
          return null;
        }
        contentSecurityPolicyCount += 1;
      } else if (
        !(
          (tag.attributes.size === 1 && tag.attributes.get('charset')?.toLowerCase() === 'utf-8') ||
          (tag.attributes.size === 2 &&
            tag.attributes.get('name')?.toLowerCase() === 'viewport' &&
            tag.attributes.get('content') === 'width=device-width, initial-scale=1.0')
        )
      ) {
        return null;
      }
      continue;
    }
    if (tag.name === 'title') {
      if (!headOpen || tag.attributes.size !== 0) return null;
      const closingTag = closingRawTextTag(html, cursor, 'title');
      if (closingTag === -1) return null;
      if (html.slice(cursor, closingTag.start).trim() !== HOSTED_PRODUCT_TITLE) return null;
      productTitleCount += 1;
      cursor = closingTag.end;
      continue;
    }
    if (
      [
        'template',
        'iframe',
        'style',
        'textarea',
        'xmp',
        'noembed',
        'noframes',
        'noscript',
        'plaintext',
      ].includes(tag.name)
    ) {
      // These contexts can make later markup inert. The verifier does not need
      // them in an emitted Vite document, so reject rather than approximate.
      return null;
    }
    if (tag.name === 'base') return null;
    if (tag.name === 'link') {
      const relation = tag.attributes.get('rel')?.toLowerCase();
      const href = tag.attributes.get('href');
      const crossOrigin = tag.attributes.get('crossorigin');
      if (
        contentSecurityPolicyCount !== 1 ||
        tag.attributes.size !== 3 ||
        (crossOrigin !== '' && crossOrigin?.toLowerCase() !== 'anonymous') ||
        (relation === 'modulepreload'
          ? !href || !/^\/assets\/[A-Za-z0-9._-]+\.js$/u.test(href)
          : relation === 'stylesheet'
            ? !href || !/^\/assets\/[A-Za-z0-9._-]+\.css$/u.test(href)
            : true)
      ) {
        return null;
      }
      continue;
    }
    if (tag.name !== 'script') continue;
    if (contentSecurityPolicyCount !== 1) return null;
    const closingTag = closingRawTextTag(html, cursor, 'script');
    if (closingTag === -1) return null;
    if (html.slice(cursor, closingTag.start).trim() !== '') return null;
    cursor = closingTag.end;
    if (tag.attributes.get('type') !== 'module') return null;
    if (
      [...tag.attributes].some(
        ([key, value]) =>
          !['type', 'src', 'crossorigin'].includes(key) ||
          (key === 'crossorigin' && value !== '' && value.toLowerCase() !== 'anonymous')
      )
    ) {
      return null;
    }
    const source = tag.attributes.get('src');
    if (!source || !/^\/assets\/[A-Za-z0-9._-]+\.js$/u.test(source)) return null;
    paths.push(source.slice(1));
  }
  return doctypeCount === 1 &&
    htmlClosed &&
    headClosed &&
    bodyClosed &&
    contentSecurityPolicyCount === 1 &&
    productTitleCount === 1 &&
    paths.length > 0
    ? Object.freeze(paths)
    : null;
}
