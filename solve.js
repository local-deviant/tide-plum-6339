// Fast drop-in for makefun-site 1.0.0: builds the same output tree, byte for byte,
// faster. Written from the README's rules and the reference's behaviour, in my
// own code: one fused pass per document, bulk HTML escaping, indexOf-driven
// inline scanning, and templates rendered from pre-parsed nodes with flat scopes.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ text */

// The HTML escape table, in this order: & < > " '.
const ESC_RE = /[&<>"']/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(text) {
  if (text.indexOf('&') === -1 && text.indexOf('<') === -1 && text.indexOf('>') === -1 && text.indexOf('"') === -1 && text.indexOf("'") === -1) return text;
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

// Short strings (template values, titles, urls) repeat across pages: memoise them.
const escCache = new Map();
function escMemo(s) {
  if (s.length > 200) return escapeHtml(s);
  let e = escCache.get(s);
  if (e === undefined) { e = escapeHtml(s); escCache.set(s, e); }
  return e;
}

/** A YYYY-MM-DD date in words, from the string alone. */
const dateCache = new Map();
function longDate(date) {
  let v = dateCache.get(date);
  if (v === undefined) {
    v = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    dateCache.set(date, v);
  }
  return v;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * ASCII-only input takes a fast path that is identical: NFKD is the identity
 * on ASCII and ASCII holds no combining marks.
 */
const slugCache = new Map();
function slugify(text) {
  let out = slugCache.get(text);
  if (out !== undefined) return out;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let s = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = s.length > 0;
      continue;
    }
    if (gap) s += '-';
    gap = false;
    s += keep;
  }
  s = s.slice(0, 64).replace(/-+$/, '');
  out = s === '' ? 'untitled' : s;
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** Whether a code unit is whitespace, as /\s/ reads it. */
function isWS(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) ||
    c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) ||
      c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/* ------------------------------------------------------------ front matter */

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
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
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
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
      // YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31.
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = +raw.slice(0, 4); mo = +raw.slice(5, 7); d = +raw.slice(8, 10);
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t[i];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '-') {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Lines are walked
 * with indexOf instead of splitting the whole body.
 */
function parseFrontMatter(text) {
  let e = text.indexOf('\n');
  if (e === -1) e = text.length;
  if (text.slice(0, e) !== '---') return { error: 'no front matter' };
  // Find the closing --- line.
  let closeStart = -1, closeEnd = -1;
  let q = e + 1;
  while (q <= text.length) {
    let e2 = text.indexOf('\n', q);
    if (e2 === -1) e2 = text.length;
    if (text.slice(q, e2) === '---') { closeStart = q; closeEnd = e2; break; }
    if (e2 === text.length) break;
    q = e2 + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let r = e + 1;
  let ln = 2;
  while (r < closeStart) {
    let e2 = text.indexOf('\n', r);
    if (e2 === -1 || e2 > closeStart) e2 = closeStart;
    const line = text.slice(r, e2);
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      // key: value — key of a-z and _, a colon, one space and the value.
      let i = 0;
      while (i < line.length) {
        const c = line.charCodeAt(i);
        if ((c >= 97 && c <= 122) || c === 95) i++;
        else break;
      }
      if (i === 0 || i >= line.length || line.charCodeAt(i) !== 58) return { error: `line ${ln} is not "key: value"` };
      const key = line.slice(0, i);
      let raw;
      if (i + 1 === line.length) raw = '';
      else if (line.charCodeAt(i + 1) === 32) raw = line.slice(i + 2);
      else return { error: `line ${ln} is not "key: value"` };
      let end = raw.length;
      while (end > 0) {
        const c = raw.charCodeAt(end - 1);
        if (c === 32 || c === 9) end--;
        else break;
      }
      raw = raw.slice(0, end);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    r = e2 + 1;
    ln++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd + 1) };
}

/* --------------------------------------------------------------- markdown */

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/**
 * The first index from `from` where `s` holds `what` outside a backslash
 * escape, or -1. An escape pair is a backslash plus an escapable character,
 * read left to right, so a run of backslashes before the match decides it:
 * an even run leaves the match plain, an odd run escapes its first char.
 */
function findUnescaped(s, what, from) {
  let p = s.indexOf(what, from);
  while (p !== -1) {
    let b = p - 1, cnt = 0;
    while (b >= 0 && s.charCodeAt(b) === 92) { cnt++; b--; }
    if (cnt % 2 === 0) return p;
    p = s.indexOf(what, p + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let p = s.indexOf('*', from);
  while (p !== -1) {
    let b = p - 1, cnt = 0;
    while (b >= 0 && s.charCodeAt(b) === 92) { cnt++; b--; }
    if (cnt % 2 === 1) { p = s.indexOf('*', p + 1); continue; }
    if (s.charCodeAt(p + 1) === 42) { p = s.indexOf('*', p + 2); continue; }
    return p;
  }
  return -1;
}

/** The next inline special (\\, `, * or [) at or after `from`, or -1. */
function nextSpecial(s, from) {
  let best = -1;
  let j = s.indexOf('\\', from);
  if (j !== -1) best = j;
  j = s.indexOf('`', from);
  if (j !== -1 && (best === -1 || j < best)) best = j;
  j = s.indexOf('*', from);
  if (j !== -1 && (best === -1 || j < best)) best = j;
  j = s.indexOf('[', from);
  if (j !== -1 && (best === -1 || j < best)) best = j;
  return best;
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const j = nextSpecial(s, i);
    if (j === -1) { out += escapeHtml(s.slice(i)); break; }
    if (j > i) out += escapeHtml(s.slice(i, j));
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) { out += escapeHtml(s[j + 1]); i = j + 2; }
      else { out += '\\'; i = j + 1; }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) { out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`; i = k + 1; }
      else { out += '`'; i = j + 1; }
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) { out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`; i = k + 2; }
        else { out += '**'; i = j + 2; }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) { out += `<em>${inline(s.slice(j + 1, k), env)}</em>`; i = k + 1; }
      else { out += '*'; i = j + 1; }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1);
    let m = -1;
    let target = '';
    if (k !== -1 && s.charCodeAt(k + 1) === 40) {
      m = s.indexOf(')', k + 2);
      if (m !== -1) target = s.slice(k + 2, m);
    }
    if (target !== '' && !/\s/.test(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
      i = m + 1;
    } else {
      out += '[';
      i = j + 1;
    }
  }
  return out;
}

/** Trim spaces and tabs at both ends of a line. */
function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language, or null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return line.slice(3, langEnd);
}

/** Whether a line closes a fence: three backticks, spaces or tabs after them. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  let i = d;
  if (i >= line.length) return null;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  const text = trimLine(line.slice(i));
  if (text === '') return null;
  return { depth: d, text };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents and its excerpt (the first paragraph's inline
 * HTML, or ""). Lines are walked with indexOf; lexing and rendering are one
 * pass, since rendering a block never changes how later lines lex.
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const len = src.length;
  // split('\n') yields one last empty line when src ends in '\n'; the reference
  // lexes that line too (it lands in a fence body at the end of input).
  const trailing = len > 0 && src.charCodeAt(len - 1) === 10;
  let pos = 0;
  // Fetch the next line without building an array of all lines.
  const nextLine = () => {
    if (pos > len) return null;
    if (pos === len) {
      if (!trailing) return null;
      pos = len + 1;
      return '';
    }
    let e = src.indexOf('\n', pos);
    if (e === -1) e = len;
    const line = src.slice(pos, e);
    pos = e + 1;
    return line;
  };
  let line = nextLine();
  while (line !== null) {
    if (isBlank(line)) { line = nextLine(); continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      line = nextLine();
      while (line !== null && !isFenceClose(line)) { body.push(line); line = nextLine(); }
      if (line !== null) line = nextLine(); // consume the close
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      let code = '';
      for (const l of body) code += `${escapeHtml(l)}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      line = nextLine();
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      line = nextLine();
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (line !== null && line.charCodeAt(0) === 62) {
        let t = line.slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        body.push(t);
        line = nextLine();
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    // List?
    let isBullet = false, isOrdered = false, start = 1, firstText = '';
    const c0 = line.charCodeAt(0);
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
      isBullet = true;
      firstText = line.slice(2);
    } else {
      let i = 0;
      while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
      if (i >= 1 && i <= 9 && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
        isOrdered = true;
        start = Number(line.slice(0, i));
        firstText = line.slice(i + 2);
      }
    }
    if (isBullet || isOrdered) {
      const items = [];
      let parts = [trimLine(firstText)];
      line = nextLine();
      while (line !== null) {
        let m = null;
        if (isBullet) {
          const d0 = line.charCodeAt(0);
          if ((d0 === 45 || d0 === 42) && line.charCodeAt(1) === 32) m = line.slice(2);
        } else {
          let i = 0;
          while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
          if (i >= 1 && i <= 9 && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) m = line.slice(i + 2);
        }
        if (m !== null) {
          items.push(parts.join('\n'));
          parts = [trimLine(m)];
          line = nextLine();
        } else if (line.length >= 3 && line.charCodeAt(0) === 32 && line.charCodeAt(1) === 32) {
          // Continued: two or more spaces then a non-space.
          let sp = 0;
          while (sp < line.length && line.charCodeAt(sp) === 32) sp++;
          if (sp >= 2 && sp < line.length && !isWS(line.charCodeAt(sp))) {
            parts.push(trimLine(line));
            line = nextLine();
          } else break;
        } else break;
      }
      items.push(parts.join('\n'));
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const item of items) html += `<li>${inline(item, env)}</li>\n`;
      html += `</${tag}>`;
      blocks.push(html);
      continue;
    }
    // Paragraph.
    const body = [trimLine(line)];
    line = nextLine();
    while (line !== null && !endsParagraph(line)) {
      body.push(trimLine(line));
      line = nextLine();
    }
    const text = body.join('\n');
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

/* -------------------------------------------------------------- templates */

class TemplateError extends Error {}
const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
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
      const raw = src.charCodeAt(open + 2) === 123;
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
    let standalone = true;
    for (let k = lineStart; k < open; k++) {
      const c = src.charCodeAt(k);
      if (c !== 32 && c !== 9) { standalone = false; break; }
    }
    if (standalone) {
      for (let k = end; k < lineEnd; k++) {
        const c = src.charCodeAt(k);
        if (c !== 32 && c !== 9) { standalone = false; break; }
      }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/**
 * The names a template's output depends on, beyond the case's root values:
 * every first-segment its nodes read (following includes, minus names its
 * own fors bind, and minus names bound at an include site). A cycle, or an
 * include of a cycled template, taints every template on the stack: their
 * outputs are never cached, only rendered.
 */
function templateInputs(templates) {
  const memo = new Map();
  const tainted = new Set();
  const visiting = new Set();
  const compute = (name) => {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) {
      for (const v of visiting) tainted.add(v);
      return new Set();
    }
    const nodes = templates.get(name);
    if (nodes === undefined) return new Set();
    visiting.add(name);
    const out = new Set();
    const walk = (ns, bound) => {
      for (const n of ns) {
        if (n.kind === 'var' || n.kind === 'raw') {
          if (!bound.has(n.path[0])) out.add(n.path[0]);
        } else if (n.kind === 'if') {
          if (!bound.has(n.path[0])) out.add(n.path[0]);
          walk(n.then, bound);
          if (n.else !== null) walk(n.else, bound);
        } else if (n.kind === 'for') {
          if (!bound.has(n.path[0])) out.add(n.path[0]);
          const b2 = new Set(bound);
          b2.add(n.name);
          b2.add('loop');
          walk(n.body, b2);
        } else if (n.kind === 'include') {
          if (tainted.has(n.name)) for (const v of visiting) tainted.add(v);
          for (const v of compute(n.name)) if (!bound.has(v)) out.add(v);
        }
      }
    };
    walk(nodes, new Set());
    visiting.delete(name);
    memo.set(name, out);
    return out;
  };
  for (const name of templates.keys()) compute(name);
  return { inputs: memo, tainted };
}

/**
 * Which templates may be cached, and on what: a template whose inputs are
 * the root values (site, tags, recent) alone renders once per depth; one
 * with a single further input renders once per (depth, that input's value).
 * Anything else, and anything tainted, is rendered every time.
 */
function cacheableTemplates(templates) {
  const { inputs, tainted } = templateInputs(templates);
  const ROOT = new Set(['site', 'tags', 'recent']);
  const out = new Map();
  for (const [name, set] of inputs) {
    if (tainted.has(name)) continue;
    let x = null;
    let ok = true;
    for (const v of set) {
      if (ROOT.has(v)) continue;
      if (x === null) x = v;
      else if (x !== v) { ok = false; break; }
    }
    if (ok) out.set(name, x);
  }
  return out;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` in `scope` ({ vars, parent }); `ctx` holds the parsed templates and the include depth. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escMemo(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) {
          const cx = ctx.cacheable.get(n.name);
          if (cx === undefined) {
            renderNodes(t, scope, ctx, depth + 1, out);
          } else if (cx === null) {
            const key = `${n.name}\n${depth + 1}`;
            let s = ctx.cache.get(key);
            if (s === undefined) {
              const sub = [];
              renderNodes(t, scope, ctx, depth + 1, sub);
              s = sub.join('');
              ctx.cache.set(key, s);
            }
            out.push(s);
          } else {
            const v = lookup(scope, [cx]);
            let byDepth = ctx.varCache.get(n.name);
            if (byDepth === undefined) { byDepth = new Map(); ctx.varCache.set(n.name, byDepth); }
            let byVal = byDepth.get(depth + 1);
            if (byVal === undefined) { byVal = new Map(); byDepth.set(depth + 1, byVal); }
            let s = byVal.get(v);
            if (s === undefined) {
              const sub = [];
              renderNodes(t, scope, ctx, depth + 1, sub);
              s = sub.join('');
              byVal.set(v, s);
            }
            out.push(s);
          }
        }
        break;
      }
    }
  }
}

/* ------------------------------------------------- compiled templates */

/** The value at `path` in an array scope stack (innermost last). */
function lookupArr(S, path) {
  for (let i = S.length - 1; i >= 0; i--) {
    const vars = S[i];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/**
 * A template's nodes compiled to a function (S, T, O, D, P, C, LK, TX, ES, TR):
 * S the scope stack, T the compiled templates by name, O the output pieces,
 * D the include depth, P this template's paths, C the render context (its
 * constant-template cache). Straight-line code, so it runs fast cold too.
 * Throws when the runtime forbids code generation; the caller then falls
 * back to the interpreter above, which renders the same nodes.
 */
function compileTemplate(nodes, cacheable) {
  const paths = [];
  let uid = 0;
  const src = [];
  const emit = (ns) => {
    for (const n of ns) {
      if (n.kind === 'text') src.push(`O.push(${JSON.stringify(n.text)});`);
      else if (n.kind === 'var') {
        const pi = paths.push(n.path) - 1;
        src.push(`O.push(ES(TX(LK(S,P[${pi}]))));`);
      } else if (n.kind === 'raw') {
        const pi = paths.push(n.path) - 1;
        src.push(`O.push(TX(LK(S,P[${pi}])));`);
      } else if (n.kind === 'if') {
        const pi = paths.push(n.path) - 1;
        src.push(`if(${n.not ? '!' : ''}TR(LK(S,P[${pi}]))){`);
        emit(n.then);
        src.push('}');
        if (n.else !== null) {
          src.push('else{');
          emit(n.else);
          src.push('}');
        }
      } else if (n.kind === 'for') {
        const pi = paths.push(n.path) - 1;
        const u = uid++;
        src.push(`{const A${u}=LK(S,P[${pi}]);if(Array.isArray(A${u})){for(let K${u}=0;K${u}<A${u}.length;K${u}++){S.push({[${JSON.stringify(n.name)}]:A${u}[K${u}],loop:{index:K${u}+1,first:K${u}===0,last:K${u}===A${u}.length-1,length:A${u}.length}});`);
        emit(n.body);
        src.push('S.pop();}}}');
      } else if (n.kind === 'include') {
        const u = uid++;
        src.push(`{if(D<8){const G${u}=T.get(${JSON.stringify(n.name)});if(G${u}!==undefined){`);
        const cx = cacheable.get(n.name);
        if (cx === undefined) {
          src.push(`G${u}.f(S,T,O,D+1,G${u}.p,C,LK,TX,ES,TR);`);
        } else if (cx === null) {
          src.push(`const KK${u}=${JSON.stringify(`${n.name}\n`)}+(D+1);let V${u}=C.cache.get(KK${u});if(V${u}===undefined){const O${u}=[];G${u}.f(S,T,O${u},D+1,G${u}.p,C,LK,TX,ES,TR);V${u}=O${u}.join('');C.cache.set(KK${u},V${u});}O.push(V${u});`);
        } else {
          const pi = paths.push([cx]) - 1;
          src.push(`let M1${u}=C.varCache.get(${JSON.stringify(n.name)});if(M1${u}===undefined){M1${u}=new Map();C.varCache.set(${JSON.stringify(n.name)},M1${u});}let M2${u}=M1${u}.get(D+1);if(M2${u}===undefined){M2${u}=new Map();M1${u}.set(D+1,M2${u});}const KV${u}=LK(S,P[${pi}]);let V${u}=M2${u}.get(KV${u});if(V${u}===undefined){const O${u}=[];G${u}.f(S,T,O${u},D+1,G${u}.p,C,LK,TX,ES,TR);V${u}=O${u}.join('');M2${u}.set(KV${u},V${u});}O.push(V${u});`);
        }
        src.push('}}}');
      }
    }
  };
  emit(nodes);
  const f = new Function('S', 'T', 'O', 'D', 'P', 'C', 'LK', 'TX', 'ES', 'TR', src.join(''));
  return { f, p: paths };
}

/* ------------------------------------------------------------------ build */

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
const resolveCache = new Map();
function resolvePath(dir, rel) {
  const key = `${dir}\n${rel}`;
  let out = resolveCache.get(key);
  if (out === undefined) {
    const parts = dir === '' ? [] : dir.split('/');
    for (const seg of rel.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (parts.length === 0) { out = null; break; }
        parts.pop();
      } else parts.push(seg);
    }
    if (out === undefined) out = parts.join('/');
    resolveCache.set(key, out);
  }
  return out;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
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
  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }
  // 2. Each source's front matter.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
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
  // 3. Each page's output directory and url.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  // 4. Each body's Markdown, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        // A target with a scheme, opening on / or opening on # is kept as written.
        let scheme = false;
        const c0 = target.charCodeAt(0);
        if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
          let i = 1;
          while (i < target.length) {
            const c = target.charCodeAt(i);
            if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) i++;
            else break;
          }
          scheme = i < target.length && target.charCodeAt(i) === 58;
        }
        if (scheme || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
  // 5. The posts, newest first and then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  // 6. The tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  // 7. Every page through its layout, the index pages and the tag pages.
  const output = {};
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const cacheable = cacheableTemplates(templates);
  const ctx = { templates, cacheable, cache: new Map(), varCache: new Map() };
  let compiled = null;
  try {
    compiled = new Map();
    for (const [name, nodes] of templates) compiled.set(name, compileTemplate(nodes, cacheable));
  } catch {
    compiled = null; // code generation is refused here: render from the nodes instead
  }
  const baseVars = { site, tags: allTags, recent };
  const render = (name, vars) => {
    if (compiled !== null) {
      const g = compiled.get(name);
      if (g === undefined) return null;
      const out = [];
      g.f([baseVars, vars], compiled, out, 0, g.p, ctx, lookupArr, textOf, escMemo, truthy);
      return out.join('');
    }
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: { vars: baseVars, parent: null } }, ctx, 0, out);
    return out.join('');
  };
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const tagObj = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = render('tag', { tag: tagObj });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const npages = kept.filter((s) => !s.post).length;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
