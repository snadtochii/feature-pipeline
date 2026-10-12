// Syntax colouring for the margin viewer: the seam between the page and the vendored
// highlight.js under ./vendor/, which nothing else imports. highlight.js colours the whole file
// in one pass and emits nested spans that cross newlines; this module splits that output into
// lines, reopening every span still open at a line break on the next line, so each line renders
// on its own and a block comment or template literal keeps its colour on every line it covers.

import hljs from './vendor/highlight.min.js';
import dockerfile from './vendor/dockerfile.min.js';

hljs.registerLanguage('dockerfile', dockerfile);

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" };

const decode = (text) => text.replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity]);

const plain = (lines) => lines.map((text) => (text === '' ? [] : [{ className: null, text }]));

// The language is the file's extension, or its whole name when it has none (Dockerfile,
// Makefile), resolved through highlight.js's own names and aliases. Never auto-detected.
function languageOf(path) {
  const name = path.split('/').at(-1).toLowerCase();
  const key = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  return key !== '' && hljs.getLanguage(key) ? key : null;
}

// Splits highlight.js's HTML into per-line tokens; null when the markup is not the span-only
// shape highlight.js emits.
function splitLines(html) {
  const out = [[]];
  const open = []; // class strings of the spans open at the scan position
  const scan = /<span class="([^"]*)">|<\/span>|\n|[^<\n]+/y;
  while (scan.lastIndex < html.length) {
    const match = scan.exec(html);
    if (match === null) {
      return null;
    }
    const [piece, opened] = match;
    if (opened !== undefined) {
      open.push(opened);
    } else if (piece === '</span>') {
      if (open.pop() === undefined) {
        return null;
      }
    } else if (piece === '\n') {
      out.push([]);
    } else {
      const tokens = out.at(-1);
      const className = open.length > 0 ? open.join(' ') : null;
      const text = decode(piece);
      const last = tokens.at(-1);
      if (last && last.className === className) {
        last.text += text;
      } else {
        tokens.push({ className, text });
      }
    }
  }
  return out;
}

// Returns one token list per line: [{ className, text }], where className is null for plain text.
export function highlightLines(lines, path) {
  const language = languageOf(path);
  if (language === null || lines.length === 0) {
    return plain(lines);
  }
  let html;
  try {
    html = hljs.highlight(lines.join('\n'), { language, ignoreIllegals: true }).value;
  } catch {
    return plain(lines);
  }
  const split = splitLines(html);
  if (
    split === null ||
    split.length !== lines.length ||
    split.some((tokens, i) => tokens.map((token) => token.text).join('') !== lines[i])
  ) {
    return plain(lines);
  }
  return split;
}
