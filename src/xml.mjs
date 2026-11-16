const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*/;

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (all, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    if (body in NAMED_ENTITIES) return NAMED_ENTITIES[body];
    throw new Error(`unknown entity &${body};`);
  });
}

// Minimal XML parser for the trusted local profile: elements, attributes,
// text, comments, CDATA and processing instructions. External definitions
// (DOCTYPE/ENTITY) are refused. Every element records its source offsets so
// unsupported nodes can be retained verbatim.
export function parseXml(source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('external definitions not supported');
  let index = 0;
  const length = source.length;

  function fail(message) {
    const error = new Error(`${message} at offset ${index}`);
    error.offset = index;
    throw error;
  }

  function skipWhitespace() {
    const match = /^\s+/.exec(source.slice(index));
    if (match) index += match[0].length;
  }

  function skipMisc() {
    for (;;) {
      if (source.startsWith('<?', index)) {
        const end = source.indexOf('?>', index);
        if (end < 0) fail('unterminated processing instruction');
        index = end + 2;
      } else if (source.startsWith('<!--', index)) {
        const end = source.indexOf('-->', index);
        if (end < 0) fail('unterminated comment');
        index = end + 3;
      } else if (/^\s/.test(source.slice(index, index + 1)) && index < length) {
        skipWhitespace();
      } else return;
    }
  }

  function parseName() {
    const match = NAME_PATTERN.exec(source.slice(index));
    if (!match) fail('expected name');
    index += match[0].length;
    return match[0];
  }

  function parseAttributes() {
    const attributes = {};
    for (;;) {
      skipWhitespace();
      const char = source[index];
      if (char === '>' || char === '/' || char === undefined) return attributes;
      const name = parseName();
      skipWhitespace();
      if (source[index] !== '=') fail(`attribute ${name} missing =`);
      index += 1;
      skipWhitespace();
      const quote = source[index];
      if (quote !== '"' && quote !== "'") fail(`attribute ${name} missing quote`);
      const end = source.indexOf(quote, index + 1);
      if (end < 0) fail(`attribute ${name} unterminated`);
      attributes[name] = decodeEntities(source.slice(index + 1, end));
      index = end + 1;
    }
  }

  function parseElement() {
    const start = index;
    if (source[index] !== '<') fail('expected element');
    index += 1;
    const name = parseName();
    const attributes = parseAttributes();
    const node = {
      type: 'element', name, local: name.split(':').pop(), attributes,
      children: [], start, innerStart: index, innerEnd: index, end: index
    };
    if (source.startsWith('/>', index)) {
      index += 2;
      node.innerStart = node.innerEnd = node.end = index;
      return node;
    }
    if (source[index] !== '>') fail('expected >');
    index += 1;
    node.innerStart = index;
    for (;;) {
      if (index >= length) fail(`unclosed element ${name}`);
      if (source.startsWith('</', index)) {
        node.innerEnd = index;
        index += 2;
        const closing = parseName();
        if (closing !== name) fail(`mismatched closing tag ${closing} for ${name}`);
        skipWhitespace();
        if (source[index] !== '>') fail('expected > after closing tag');
        index += 1;
        node.end = index;
        return node;
      }
      if (source.startsWith('<!--', index)) {
        const end = source.indexOf('-->', index);
        if (end < 0) fail('unterminated comment');
        index = end + 3;
        continue;
      }
      if (source.startsWith('<![CDATA[', index)) {
        const end = source.indexOf(']]>', index);
        if (end < 0) fail('unterminated cdata');
        node.children.push({ type: 'text', value: source.slice(index + 9, end) });
        index = end + 3;
        continue;
      }
      if (source.startsWith('<?', index)) {
        const end = source.indexOf('?>', index);
        if (end < 0) fail('unterminated processing instruction');
        index = end + 2;
        continue;
      }
      if (source[index] === '<') {
        node.children.push(parseElement());
        continue;
      }
      const next = source.indexOf('<', index);
      const end = next < 0 ? length : next;
      node.children.push({ type: 'text', value: decodeEntities(source.slice(index, end)) });
      index = end;
    }
  }

  skipMisc();
  if (index >= length) fail('empty document');
  const root = parseElement();
  skipMisc();
  if (index < length) fail('content after root element');
  return root;
}

export function children(node, local) {
  return node.children.filter(child => child.type === 'element' && (local === undefined || child.local === local));
}

export function textOf(node) {
  let out = '';
  for (const child of node.children) {
    out += child.type === 'text' ? child.value : textOf(child);
  }
  return out;
}

export function rawOf(source, node) {
  return source.slice(node.start, node.end);
}

export function innerOf(source, node) {
  return source.slice(node.innerStart, node.innerEnd);
}
