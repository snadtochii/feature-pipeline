// Line tokenizer for the margin viewer. Enough colour to orient while reading — comments,
// strings, numbers, keywords, tags — not an editor grammar. Owned on purpose: no runtime
// download, no vendored file. Swap at the `highlightLines` seam if accuracy ever matters more.
//
// A language is a list of sticky regexes tried in order at the current position, plus
// optional multi-line spans (block comments, template literals, triple-quoted strings) whose
// open state carries from one line to the next.

const JS_KEYWORDS =
  'abstract|any|as|async|await|boolean|break|case|catch|class|const|continue|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|keyof|let|namespace|never|new|null|number|of|override|private|protected|public|readonly|return|satisfies|set|static|string|super|switch|this|throw|true|try|type|typeof|undefined|unknown|var|void|while|yield';

const PY_KEYWORDS =
  'False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|self';

const SH_KEYWORDS =
  'if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|return|exit|export|local|readonly|set|shift|source|alias|unset|trap';

const rule = (type, source) => ({ type, re: new RegExp(source, 'y') });
const span = (type, open, close) => ({ type, open: new RegExp(open, 'y'), close });

const STRING = rule('string', String.raw`'(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?`);
const NUMBER = rule('number', String.raw`\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)[nLlfF]?\b`);
const HASH_COMMENT = rule('comment', String.raw`#.*`);
// A tag opener switches the line scanner into tag mode, where `>` and `/>` close it; outside
// that mode `>` is a comparison. Generics (`Array<string>`) do not open because an identifier
// precedes the `<`.
const TAG_OPEN = { ...rule('tag', String.raw`(?<=^|[\s(={,>?:&|})])<\/?[A-Za-z][\w.:-]*`), enter: 'tag' };
const TAG_CLOSE = { ...rule('tag', String.raw`\/?>`), only: 'tag', exit: true };

const LANGUAGES = {
  js: {
    spans: [span('comment', String.raw`\/\*`, '*/'), span('string', '`', '`')],
    rules: [
      rule('comment', String.raw`\/\/.*`),
      STRING,
      TAG_CLOSE,
      TAG_OPEN,
      NUMBER,
      { ...rule('keyword', String.raw`\b(?:${JS_KEYWORDS})\b`), not: 'tag' },
      rule('decorator', String.raw`@[\w.]+`),
    ],
  },
  css: {
    spans: [span('comment', String.raw`\/\*`, '*/')],
    rules: [
      STRING,
      rule('keyword', String.raw`@[\w-]+`),
      rule('property', String.raw`(?<=^|[\s{;])[\w-]+(?=\s*:)`),
      rule('number', String.raw`#[\da-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\b`),
    ],
  },
  json: {
    spans: [],
    rules: [
      rule('property', String.raw`"(?:\\.|[^"\\])*"(?=\s*:)`),
      STRING,
      NUMBER,
      rule('keyword', String.raw`\b(?:true|false|null)\b`),
    ],
  },
  yaml: {
    spans: [],
    rules: [
      HASH_COMMENT,
      rule('property', String.raw`(?<=^\s*(?:- )?)[\w.-]+(?=:(?:\s|$))`),
      STRING,
      rule('keyword', String.raw`\b(?:true|false|null|yes|no)\b`),
      NUMBER,
    ],
  },
  md: {
    spans: [span('string', '```', '```')],
    rules: [
      rule('keyword', String.raw`^#{1,6} .*`),
      rule('string', '`[^`]*`'),
      rule('tag', String.raw`\[[^\]]*\]\([^)]*\)`),
      rule('comment', String.raw`^>.*`),
      rule('property', String.raw`^\s*(?:[-*+]|\d+\.)(?= )`),
    ],
  },
  sh: {
    spans: [],
    rules: [
      HASH_COMMENT,
      STRING,
      rule('tag', String.raw`\$\{[^}]*\}|\$\w+`),
      rule('keyword', String.raw`\b(?:${SH_KEYWORDS})\b`),
      NUMBER,
    ],
  },
  py: {
    spans: [span('string', '"""', '"""'), span('string', "'''", "'''")],
    rules: [
      HASH_COMMENT,
      STRING,
      rule('decorator', String.raw`@[\w.]+`),
      rule('keyword', String.raw`\b(?:${PY_KEYWORDS})\b`),
      NUMBER,
    ],
  },
  html: {
    spans: [span('comment', '<!--', '-->')],
    rules: [TAG_CLOSE, { ...rule('tag', String.raw`<\/?[A-Za-z][\w.:-]*`), enter: 'tag' }, STRING],
  },
};

const BY_EXTENSION = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  css: 'css', scss: 'css', less: 'css',
  json: 'json', jsonc: 'json',
  yml: 'yaml', yaml: 'yaml', toml: 'yaml',
  md: 'md', mdx: 'md',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  py: 'py',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', astro: 'html',
};

export function languageFor(path) {
  const name = path.split('/').at(-1);
  const ext = name.includes('.') ? name.split('.').at(-1).toLowerCase() : '';
  if (ext === '' && (name === 'Dockerfile' || name === 'Makefile')) {
    return 'sh';
  }
  return BY_EXTENSION[ext] ?? null;
}

// Returns one token list per line: [{ type, text }], where type is null for plain text.
export function highlightLines(lines, path) {
  const language = LANGUAGES[languageFor(path)];
  if (!language) {
    return lines.map((text) => [{ type: null, text }]);
  }
  let carry = null; // the span still open from an earlier line
  let mode = null; // 'tag' while inside a JSX/HTML tag, which may span lines
  return lines.map((line) => {
    const tokens = [];
    let pos = 0;
    const push = (type, text) => {
      if (text === '') {
        return;
      }
      const last = tokens.at(-1);
      if (last && last.type === type) {
        last.text += text;
      } else {
        tokens.push({ type, text });
      }
    };
    if (carry) {
      const end = line.indexOf(carry.close);
      if (end === -1) {
        push(carry.type, line);
        return tokens;
      }
      pos = end + carry.close.length;
      push(carry.type, line.slice(0, pos));
      carry = null;
    }
    while (pos < line.length) {
      const opened = language.spans.find((s) => ((s.open.lastIndex = pos), s.open.test(line)));
      if (opened) {
        const start = pos;
        const bodyStart = opened.open.lastIndex;
        const end = line.indexOf(opened.close, bodyStart);
        if (end === -1) {
          push(opened.type, line.slice(start));
          carry = opened;
          return tokens;
        }
        pos = end + opened.close.length;
        push(opened.type, line.slice(start, pos));
        continue;
      }
      const matched = language.rules.find(
        (r) =>
          (!r.only || r.only === mode) &&
          (!r.not || r.not !== mode) &&
          ((r.re.lastIndex = pos), r.re.test(line)),
      );
      if (matched) {
        push(matched.type, line.slice(pos, matched.re.lastIndex));
        pos = matched.re.lastIndex;
        if (matched.enter) {
          mode = matched.enter;
        } else if (matched.exit) {
          mode = null;
        }
        continue;
      }
      const plain = /[A-Za-z_$][\w$]*|\s+|[^\sA-Za-z_$]/y;
      plain.lastIndex = pos;
      plain.test(line);
      push(null, line.slice(pos, plain.lastIndex));
      pos = plain.lastIndex;
    }
    return tokens;
  });
}
