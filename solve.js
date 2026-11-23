// sitegen-entry1 v1: a faster drop-in for makefun-site 1.0.0, written from its README + spec.
// Same answers, byte for byte; different engine: single-pass escaping, a stack-based inline
// renderer (no slicing, no recursion), a regex-free block lexer, and a template interpreter
// whose scopes are prototype-chained vars objects (lookup is a property read).
// Memoisation lives inside one case only (slug cache); nothing is carried across cases.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const RESERVED = ['posts', 'tags', 'page'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Append `s[a..b)` to `out`, HTML-escaped. */
function escRange(out, s, a, b) {
  let start = a;
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    let e = null;
    if (c === 38) e = '&amp;';
    else if (c === 60) e = '&lt;';
    else if (c === 62) e = '&gt;';
    else if (c === 34) e = '&quot;';
    else if (c === 39) e = '&#39;';
    if (e !== null) {
      if (i > start) out.push(s.slice(start, i));
      out.push(e);
      start = i + 1;
    }
  }
  if (b > start) out.push(s.slice(start, b));
}

/** The slug of `text` (NFKD, combining marks dropped, runs of other chars one `-`, max 64). */
const NON_ASCII = /[^\x00-\x7F]/;
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  // Pure ASCII is NFKD-stable and holds no combining marks: skip both passes.
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
  let out = '';
  let gap = false;
  for (const ch of plain) {
    const code = ch.codePointAt(0);
    let keep = '';
    if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = ch;
    if (keep === '') {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Exact JS \s test on one code unit. */
function isWS(code) {
  return code === 32 || (code >= 9 && code <= 13) || code === 0x00a0 || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f ||
    code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the closing line ("---" alone on its line).
  let pos = 4;
  let closeStart = -1;
  let bodyStart = text.length;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (text.slice(pos, end) === '---') {
      closeStart = pos;
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lp = 4;
  let k = 0;
  while (lp < closeStart) {
    const nl = text.indexOf('\n', lp);
    const lend = nl === -1 || nl > closeStart ? closeStart : nl;
    const line = text.slice(lp, lend);
    lp = nl === -1 || nl > closeStart ? closeStart : nl + 1;
    let blank = true;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || line.startsWith('#')) { k++; continue; }
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    k++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

/** Trim spaces and tabs at both ends. */
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** Fence opener: ``` + optional language + spaces/tabs only; returns the language or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null. */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  if (h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  const text = trimST(line.slice(h + 1));
  if (text === '') return null;
  return { depth: h, text };
}

function isHR(line) {
  const p = line.startsWith('---') ? 3 : line.startsWith('***') ? 3 : 0;
  if (p === 0) return false;
  for (let i = p; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** One-pass block kind of a line: 0 blank, 1 fence, 2 heading, 3 hr, 4 quote, 5 bullet, 6 ordered, 7 paragraph. */
function lineKind(line) {
  if (line.length === 0) return 0;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) {
    for (let i = 1; i < line.length; i++) {
      const d = line.charCodeAt(i);
      if (d !== 32 && d !== 9) return 7;
    }
    return 0;
  }
  if (c === 96) return fenceOpen(line) !== null ? 1 : 7;
  if (c === 35) return headingOf(line) !== null ? 2 : 7;
  if (c === 45) {
    if (isHR(line)) return 3;
    return line.charCodeAt(1) === 32 ? 5 : 7;
  }
  if (c === 42) {
    if (isHR(line)) return 3;
    return line.charCodeAt(1) === 32 ? 5 : 7;
  }
  if (c === 62) return 4;
  if (c >= 48 && c <= 57) return orderedOf(line) !== null ? 6 : 7;
  return 7;
}

/** Bullet marker: returns the item text or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** Ordered marker: returns [number, item text] or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return [Number(line.slice(0, i)), line.slice(i + 2)];
}

function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2) return false;
  return i < line.length && !isWS(line.charCodeAt(i));
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1 (search bounded by `lim`). */
function isEscapable(code) {
  return code === 92 || code === 96 || code === 42 || code === 95 || code === 91 || code === 93 ||
    code === 40 || code === 41 || code === 35 || code === 43 || code === 45 || code === 46 ||
    code === 33 || code === 62;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1 (search bounded by `lim`). */
function findUnescaped(s, what, from, lim) {
  const w0 = what.charCodeAt(0);
  const w1 = what.length > 1 ? what.charCodeAt(1) : -1;
  for (let j = from; j + what.length <= lim; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < lim && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.charCodeAt(j) === w0 && (w1 === -1 || s.charCodeAt(j + 1) === w1)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1 (bounded by `lim`). */
function findSingleStar(s, from, lim) {
  for (let j = from; j < lim; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < lim && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < lim && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/**
 * `s` rendered inline, appended to `out`. One left-to-right pass with an explicit stack for
 * strong / emphasis / link frames; every closer search is bounded by the innermost open
 * frame, which is exactly the recursion bound of the reference's inline-on-a-slice.
 */
function inlineInto(out, s, link) {
  const n = s.length;
  const frames = [];
  let lim = n;
  let i = 0;
  let run = -1;
  const flush = (upto) => {
    if (run !== -1) {
      escRange(out, s, run, upto);
      run = -1;
    }
  };
  while (i < n) {
    const f = frames.length === 0 ? null : frames[frames.length - 1];
    if (f !== null && i === f.end) {
      flush(i);
      out.push(f.close);
      i = f.after;
      frames.pop();
      lim = frames.length === 0 ? n : frames[frames.length - 1].end;
      continue;
    }
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < lim && isEscapable(s.charCodeAt(i + 1))) {
      flush(i);
      // The escaped char is written escaped: '>' is both escapable and in the escape table.
      escRange(out, s, i + 1, i + 2);
      i += 2;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < lim && j > i + 1) {
        flush(i);
        out.push('<code>');
        escRange(out, s, i + 1, j);
        out.push('</code>');
        i = j + 1;
        continue;
      }
    } else if (c === 42) {
      if (i + 1 < lim && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, lim);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>');
          frames.push({ end: j, after: j + 2, close: '</strong>' });
          lim = j;
          i += 2;
          continue;
        }
        flush(i);
        out.push('**');
        i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, lim);
      if (j > i + 1) {
        flush(i);
        out.push('<em>');
        frames.push({ end: j, after: j + 1, close: '</em>' });
        lim = j;
        i += 1;
        continue;
      }
      flush(i);
      out.push('*');
      i += 1;
      continue;
    } else if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, lim);
      let m = -1;
      if (k !== -1 && k + 1 < lim && s.charCodeAt(k + 1) === 40) {
        const r = s.indexOf(')', k + 2);
        if (r !== -1 && r < lim) m = r;
      }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      let ok = false;
      if (target !== '') {
        ok = true;
        for (let t = 0; t < target.length; t++) {
          if (isWS(target.charCodeAt(t))) { ok = false; break; }
        }
      }
      if (ok) {
        flush(i);
        const href = link(target);
        out.push('<a href="');
        escRange(out, href, 0, href.length);
        out.push('">');
        frames.push({ end: k, after: m + 1, close: '</a>' });
        lim = k;
        i += 1;
        continue;
      }
      flush(i);
      out.push('[');
      i += 1;
      continue;
    }
    if (run === -1) run = i;
    i++;
  }
  flush(n);
  // Frames left open cannot happen: every frame's end is reached before its bound's end.
  while (frames.length > 0) {
    out.push(frames.pop().close);
  }
}

/** `s` rendered inline, as a string. */
const NO_SPECIAL = /[\\`*\[]/;
function inlineStr(s, link) {
  if (!NO_SPECIAL.test(s)) {
    const out = [];
    escRange(out, s, 0, s.length);
    return out.join('');
  }
  const out = [];
  inlineInto(out, s, link);
  return out.join('');
}

/** `src` rendered: its HTML, its table of contents and its excerpt. */
function renderMarkdown(src, link, cache) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kind = lineKind(line);
    if (kind === 0) {
      i++;
      continue;
    }
    if (kind === 1) {
      const lang = fenceOpen(line);
      const body = [];
      i++;
      while (i < lines.length && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const out = ['<pre><code'];
      if (lang !== '') {
        out.push(' class="language-');
        escRange(out, lang, 0, lang.length);
        out.push('"');
      }
      out.push('>');
      for (const l of body) {
        escRange(out, l, 0, l.length);
        out.push('\n');
      }
      out.push('</code></pre>');
      blocks.push(out.join(''));
      continue;
    }
    if (kind === 2) {
      const heading = headingOf(line);
      const id = uniqueSlug(slugify(heading.text, cache), ids);
      const html = inlineStr(heading.text, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (kind === 3) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (kind === 4) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimST(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else blocks.push(`<blockquote>\n<p>${inlineStr(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    if (kind === 5 || kind === 6) {
      const bullet = kind === 5 ? bulletOf(line) : null;
      const ordered = kind === 6 ? orderedOf(line) : null;
      const isOrdered = ordered !== null;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) {
            items.push([trimST(m[1])]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(l);
          if (m !== null) {
            items.push([trimST(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimST(l));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered[0] !== 1 ? `<ol start="${ordered[0]}">` : `<${tag}>`;
      const out = [`${open}\n`];
      for (const item of items) out.push(`<li>${inlineStr(item.join('\n'), link)}</li>\n`);
      out.push(`</${tag}>`);
      blocks.push(out.join(''));
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < lines.length) {
      const k2 = lineKind(lines[i]);
      if (k2 === 0 || k2 === 1 || k2 === 2 || k2 === 3) break;
      body.push(trimST(lines[i++]));
    }
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  const htmlOut = [];
  for (const b of blocks) {
    htmlOut.push(b);
    htmlOut.push('\n');
  }
  return { html: htmlOut.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let beforeOk = true;
    for (let j = lineStart; j < open; j++) {
      const c = src.charCodeAt(j);
      if (c !== 32 && c !== 9) { beforeOk = false; break; }
    }
    let afterOk = true;
    for (let j = end; j < lineEnd; j++) {
      const c = src.charCodeAt(j);
      if (c !== 32 && c !== 9) { afterOk = false; break; }
    }
    const standalone = beforeOk && afterOk;
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 6, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 0, text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t === 'var' ? 1 : 2, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 4, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 3, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 3 || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 6 ? parent.body : parent.kind === 4 ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 5, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind === 4 ? 'for' : 'if'} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain (prototype-chained vars objects). */
function lookup(vars, path) {
  // Vars objects are null-proto (root) or prototype-chained to them: a plain read is
  // exactly the reference's nearest-scope-hasOwn walk (no value is ever undefined).
  let v = vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** A template's external first-segment names + its includes (loop-bound names excluded). */
function templateDeps(nodes, forVars) {
  const own = new Set();
  const includes = [];
  const walk = (ns, bound) => {
    for (const nd of ns) {
      if (nd.kind === 0) continue;
      if (nd.kind === 1 || nd.kind === 2 || nd.kind === 3) {
        if (!bound.has(nd.path[0])) own.add(nd.path[0]);
      }
      if (nd.kind === 4) {
        if (!bound.has(nd.path[0])) own.add(nd.path[0]);
        forVars.add(nd.name);
        const b2 = new Set(bound);
        b2.add(nd.name);
        b2.add('loop');
        walk(nd.body, b2);
      } else if (nd.kind === 3) {
        walk(nd.then, bound);
        if (nd.else !== null) walk(nd.else, bound);
      } else if (nd.kind === 5) {
        includes.push(nd.name);
      }
    }
  };
  walk(nodes, new Set());
  return { own, includes };
}

const ROOT_CONST_NAMES = new Set(['site', 'tags', 'recent']);

/** name -> whether the template reads only site/tags/recent (so one render per case suffices). */
function constantTemplates(templates) {
  const deps = new Map();
  const incs = new Map();
  const forVars = new Set();
  for (const [name, nodes] of templates) {
    const d = templateDeps(nodes, forVars);
    deps.set(name, d.own);
    incs.set(name, d.includes);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, list] of incs) {
      const d = deps.get(name);
      for (const inc of list) {
        const dd = deps.get(inc);
        if (dd === undefined) continue;
        for (const x of dd) {
          if (!d.has(x)) {
            d.add(x);
            changed = true;
          }
        }
      }
    }
  }
  let shadowed = false;
  for (const v of forVars) {
    if (ROOT_CONST_NAMES.has(v)) {
      shadowed = true;
      break;
    }
  }
  const isConst = new Map();
  for (const [name, d] of deps) {
    let ok = !shadowed;
    if (ok) {
      for (const x of d) {
        if (!ROOT_CONST_NAMES.has(x)) {
          ok = false;
          break;
        }
      }
    }
    isConst.set(name, ok);
  }
  return isConst;
}

const ESC_TEST = /[&<>"']/;
function renderNodes(nodes, vars, ctx, depth, out) {
  for (const nd of nodes) {
    switch (nd.kind) {
      case 0:
        out.push(nd.text);
        break;
      case 1: {
        const v = lookup(vars, nd.path);
        if (typeof v === 'string') {
          if (ESC_TEST.test(v)) escRange(out, v, 0, v.length);
          else out.push(v);
        } else {
          const tv = textOf(v);
          if (ESC_TEST.test(tv)) escRange(out, tv, 0, tv.length);
          else out.push(tv);
        }
        break;
      }
      case 2: {
        const v = lookup(vars, nd.path);
        out.push(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case 3: {
        const v = truthy(lookup(vars, nd.path));
        const branch = v !== nd.not ? nd.then : nd.else;
        if (branch !== null) renderNodes(branch, vars, ctx, depth, out);
        break;
      }
      case 4: {
        const xs = lookup(vars, nd.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const child = Object.create(vars);
          child[nd.name] = xs[k];
          child.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(nd.body, child, ctx, depth, out);
        }
        break;
      }
      case 5: {
        if (depth >= 8) break;
        const t = ctx.templates.get(nd.name);
        if (t === undefined) break;
        if (ctx.isConst.get(nd.name)) {
          const key = `${nd.name}|${depth + 1}`;
          let s = ctx.constCache.get(key);
          if (s === undefined) {
            const tmp = [];
            renderNodes(t, vars, ctx, depth + 1, tmp);
            s = tmp.join('');
            ctx.constCache.set(key, s);
          }
          out.push(s);
        } else {
          renderNodes(t, vars, ctx, depth + 1, out);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- pipeline

function resolvePath(dir, rel, cache) {
  if (cache !== undefined) {
    const key = `${dir}\n${rel}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const r = resolvePath(dir, rel, undefined);
    cache.set(key, r);
    return r;
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const b = {
    input, base, templates, report,
    sources: [], statics: [], bySource: new Map(), broken: new Set(), pathCache: new Map(),
    posts: [], tags: [], cards: new Map(), output: {},
  };

  // 1. Sources, in code-unit order of their paths.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in the reference's check order.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Permalinks.
  const taken = new Map();
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel, b.pathCache);
      if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      b.broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of b.sources) {
    s.card = cardOf(s);
    if (s.post) b.cards.set(s, s.card);
  }
  const site = { title: input.site.title, base_url: base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates, isConst: constantTemplates(templates), constCache: new Map() };
  const render = (name, extra) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const vars = Object.create(null);
    vars.site = site;
    vars.tags = allTags;
    vars.recent = recent;
    for (const k of Object.keys(extra)) vars[k] = extra[k];
    const out = [];
    renderNodes(nodes, vars, ctx, 0, out);
    return out.join('');
  };
  for (const s of b.sources) {
    const c = s.card;
    const page = {
      title: c.title, url: c.url, date: c.date, date_long: c.date_long,
      summary: c.summary, excerpt: c.excerpt, reading_minutes: c.reading_minutes, tags: c.tags,
      slug: s.slug, content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post,
    };
    b.output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) } });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. Report.
  const lines = [...report, ...b.broken].sort(byCodeUnits);
  const pagesCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output['build-report.txt'] = `${lines.join('\n')}\n`;
  return b.output;
}
