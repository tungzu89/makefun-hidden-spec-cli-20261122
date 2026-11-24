// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON tool calls), finds the lines each edit names at the first of
// three matching tiers, and writes every change or none. See SPEC.md.
// Node 22, standard library only. Run as: node main.ts [options] [PATCH].

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Split text into lines the way a patch is split: at `\n`, one trailing
 * `\r` removed from each line, and no empty piece after a final `\n`. An
 * empty text has no lines. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

/** A blank line is one that is empty or only whitespace. */
function isBlank(s: string): boolean {
  return s.trim() === '';
}

/** Remove trailing spaces and tabs. */
function rtrimWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

/** Remove surrounding whitespace. */
function trimWs(s: string): string {
  return s.trim();
}

/** The leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line with trailing spaces and tabs removed. */
function trailingTrim(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

/** A line with leading and trailing spaces and tabs removed. */
function bothTrim(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 * `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** A file broken into lines, with its line break and whether it ends with
 * one. The break is CRLF when the file's first line feed follows a carriage
 * return, and LF otherwise. An empty file has no lines and no final break. */
interface FileParts {
  lines: string[];
  br: string;
  eol: boolean;
}

function parseFileText(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', eol: false };
  let br = '\n';
  const nl = text.indexOf('\n');
  if (nl > 0 && text[nl - 1] === '\r') br = '\r\n';
  const parts = text.split(br);
  let eol = false;
  if (text.endsWith(br)) {
    parts.pop();
    eol = true;
  }
  return { lines: parts, br, eol };
}

/** Join lines back into a file's text. A file of no lines is written empty. */
function serializeFile(parts: FileParts): string {
  if (parts.lines.length === 0) return '';
  return parts.lines.join(parts.br) + (parts.eol ? parts.br : '');
}

/** Compare two strings in UTF-8 byte order. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A patch that cannot be read in its format, at a 1-based patch line. */
class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super('parse ' + line);
    this.line = line;
  }
}

/** One edit that failed: its code and the path the failure concerns. */
interface EditFail {
  code: string;
  path: string;
}

/** The tree of files under the working directory, kept in memory while a
 * patch applies so a failed patch writes nothing. A file's first touch
 * records its bytes before the patch (null when it did not exist). */
class Tree {
  private orig = new Map<string, string | null>();
  private cur = new Map<string, string | null>();

  get(path: string): string | null {
    if (this.cur.has(path)) return this.cur.get(path) as string | null;
    let text: string | null = null;
    try {
      if (existsSync(path)) text = readFileSync(path, 'utf8');
    } catch {
      text = null;
    }
    this.orig.set(path, text);
    this.cur.set(path, text);
    return text;
  }

  set(path: string, text: string | null): void {
    if (!this.cur.has(path)) this.get(path);
    this.cur.set(path, text);
  }

  exists(path: string): boolean {
    return this.get(path) !== null;
  }

  /** Every touched path whose bytes differ from before the patch. */
  changed(): { path: string; before: string | null; after: string | null }[] {
    const out: { path: string; before: string | null; after: string | null }[] = [];
    for (const [p, after] of this.cur) {
      const before = this.orig.get(p) as string | null;
      if (before !== after) out.push({ path: p, before, after });
    }
    return out;
  }

  /** Write every change to disk: create parent directories as needed, and
   * remove files that are gone. */
  writeAll(): void {
    for (const c of this.changed()) {
      if (c.after === null) {
        try {
          rmSync(c.path, { force: true });
        } catch {
          // A file that cannot be removed stays; nothing else to do here.
        }
      } else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.after, 'utf8');
      }
    }
  }
}

/** One line of new text: either a fresh line, or a context line, which is
 * written as the file's own matched line. `ctx` is the line's index in O. */
interface NLine {
  text: string;
  ctx: number;
}

/** Whether two lines are equal at a matching tier. */
function lineEqAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailingTrim(a) === trailingTrim(b);
  return bothTrim(a) === bothTrim(b);
}

/** Every 0-based position where O occurs in lines at one tier, at or after
 * `from`. Occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEqAt(lines[i + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs in lines at least once, with its
 * occurrences. With `strict` only tier 0 is tried. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to one line, at the first tier
 * where one is. Used for V4A anchors. */
function findSingleTier(lines: string[], one: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEqAt(lines[i], one, t)) return i;
    }
  }
  return null;
}

/** Build the lines that replace the matched lines: a context line is the
 * file's own matched line, never the patch's. At tier 2 every other line is
 * re-indented: the leading spaces and tabs of O's first line are replaced
 * by those of the file's first matched line. */
function buildNewLines(fileLines: string[], pos: number, oTexts: string[], nLines: NLine[], tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && oTexts.length > 0) {
    f = leadingWs(fileLines[pos]);
    p = leadingWs(oTexts[0]);
  }
  return nLines.map((nl) => {
    if (nl.ctx >= 0) return fileLines[pos + nl.ctx];
    let t = nl.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    return t;
  });
}

/** ---- Unified diffs (SPEC section 6) ---- */

interface HunkBodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  /** True only for a body line that is literally empty in the patch. */
  emptyLine: boolean;
}

interface Hunk {
  /** The old start line A from the header (1-based). */
  a: number;
  body: HunkBodyLine[];
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renFrom: string | undefined;
  renTo: string | undefined;
  diffOld: string | null | undefined;
  diffNew: string | null | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
  /** Resolved after parsing: null means no file (`/dev/null`). */
  oldPath?: string | null;
  newPath?: string | null;
}

/** A `--- ` or `+++ ` path: text after the four characters, up to the first
 * tab, with surrounding spaces removed, a leading `a/` or `b/` removed,
 * `/dev/null` meaning no file. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const startSection = (): Section => {
    const s: Section = {
      pairOld: undefined,
      pairNew: undefined,
      renFrom: undefined,
      renTo: undefined,
      diffOld: undefined,
      diffNew: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (m === null) throw new ParseError(i + 1);
      const s = startSection();
      s.diffOld = m[1] === '/dev/null' ? null : m[1];
      s.diffNew = m[2] === '/dev/null' ? null : m[2];
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]);
      } else {
        const s = startSection();
        s.pairOld = headerPath(line);
        s.pairNew = headerPath(lines[i + 1]);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new ParseError(i + 2);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseError(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new ParseError(i + 1);
      const a = parseInt(m[1], 10);
      inHeader = false;
      const body: HunkBodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j];
        if (bl.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: 'ctx', text: '', emptyLine: true });
          j++;
          continue;
        }
        const c = bl[0];
        if (c === ' ') {
          body.push({ kind: 'ctx', text: bl.slice(1), emptyLine: false });
          j++;
          continue;
        }
        if (c === '-') {
          body.push({ kind: 'old', text: bl.slice(1), emptyLine: false });
          j++;
          continue;
        }
        if (c === '+') {
          body.push({ kind: 'new', text: bl.slice(1), emptyLine: false });
          j++;
          continue;
        }
        if (c === '\\') {
          body.push({ kind: 'bs', text: bl.slice(1), emptyLine: false });
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1].emptyLine) body.pop();
      cur.hunks.push({ a, body });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new ParseError(1);
  for (const s of sections) {
    s.oldPath = s.pairOld !== undefined ? s.pairOld : s.renFrom !== undefined ? s.renFrom : s.diffOld;
    s.newPath = s.pairNew !== undefined ? s.pairNew : s.renTo !== undefined ? s.renTo : s.diffNew;
  }
  return sections;
}

/** Split a hunk body into its old lines O and its new lines N. */
function hunkON(body: HunkBodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const bl of body) {
    if (bl.kind === 'ctx') {
      o.push(bl.text);
      n.push({ text: bl.text, ctx: o.length - 1 });
    } else if (bl.kind === 'old') {
      o.push(bl.text);
    } else if (bl.kind === 'new') {
      n.push({ text: bl.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line, meaning
 * that line had no line break after it. */
function hunkNoNewline(body: HunkBodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k].kind === 'ctx' || body[k].kind === 'new') last = k;
  }
  if (last < 0) return false;
  return last + 1 < body.length && body[last + 1].kind === 'bs';
}

function applyUnifiedSection(
  tree: Tree,
  s: Section,
  strict: boolean,
  moves: { old: string; new: string }[],
): EditFail | null {
  const oldPath = s.oldPath as string | null;
  const newPath = s.newPath as string | null;
  if (oldPath !== null && !isSafePath(oldPath)) return { code: 'unsafe', path: oldPath };
  if (newPath !== null && !isSafePath(newPath)) return { code: 'unsafe', path: newPath };
  const isCreate = s.newFile || oldPath === null;
  const isDelete = !isCreate && (s.deletedFile || newPath === null);

  if (isCreate) {
    const target = newPath;
    if (target === null) return null;
    if (tree.exists(target)) return { code: 'exists', path: target };
    const outLines: string[] = [];
    for (const h of s.hunks) {
      for (const bl of h.body) if (bl.kind === 'new') outLines.push(bl.text);
    }
    let noNL = false;
    outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
      const h = s.hunks[hi];
      for (let k = h.body.length - 1; k >= 0; k--) {
        if (h.body[k].kind === 'new') {
          noNL = k + 1 < h.body.length && h.body[k + 1].kind === 'bs';
          break outer;
        }
      }
    }
    tree.set(target, serializeFile({ lines: outLines, br: '\n', eol: !noNL }));
    return null;
  }

  if (isDelete) {
    const target = oldPath;
    if (target === null) return null;
    if (!tree.exists(target)) return { code: 'missing', path: target };
    tree.set(target, null);
    return null;
  }

  const src = oldPath as string;
  const isMove = newPath !== null && newPath !== src;
  if (!tree.exists(src)) return { code: 'missing', path: src };
  if (isMove && tree.exists(newPath as string)) return { code: 'exists', path: newPath as string };

  const raw = tree.get(src) as string;
  let parts = parseFileText(raw);
  let d = 0;
  for (const h of s.hunks) {
    const { o, n } = hunkON(h.body);
    if (o.length === 0) {
      const at = Math.min(h.a + d, parts.lines.length);
      const newLines = buildNewLines(parts.lines, at, o, n, 0);
      const nl = [...parts.lines.slice(0, at), ...newLines, ...parts.lines.slice(at)];
      let eol = parts.eol;
      if (at === parts.lines.length && n.length > 0) eol = !hunkNoNewline(h.body);
      parts = { lines: nl, br: parts.br, eol };
      d += n.length;
      continue;
    }
    const found = findTier(parts.lines, o, strict, 0);
    if (found === null) return { code: 'no-match', path: src };
    const targetPos = h.a - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - targetPos);
    for (const p of found.occ) {
      const dist = Math.abs(p - targetPos);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const pos = best;
    const newLines = buildNewLines(parts.lines, pos, o, n, found.tier);
    const nl = [...parts.lines.slice(0, pos), ...newLines, ...parts.lines.slice(pos + o.length)];
    let eol = parts.eol;
    if (pos + o.length === parts.lines.length) eol = !hunkNoNewline(h.body);
    parts = { lines: nl, br: parts.br, eol };
    d += n.length - o.length;
  }
  const outText = serializeFile(parts);
  if (isMove) {
    tree.set(src, null);
    tree.set(newPath as string, outText);
    moves.push({ old: src, new: newPath as string });
  } else {
    tree.set(src, outText);
  }
  return null;
}

/** ---- SEARCH/REPLACE blocks (SPEC section 7) ---- */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (rtrimWs(lines[i]) === '<<<<<<< SEARCH') {
      const s = i;
      let path: string | null = null;
      for (let k = s - 1; k > prevEnd; k--) {
        const t = lines[k];
        if (isBlank(t)) continue;
        if (trimWs(t).startsWith('```')) continue;
        path = trimWs(t);
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new ParseError(s + 1);
        path = prevPath;
      }
      let j = -1;
      for (let k = s + 1; k < lines.length; k++) {
        if (rtrimWs(lines[k]) === '=======') {
          j = k;
          break;
        }
      }
      if (j < 0) throw new ParseError(s + 1);
      let k = -1;
      for (let m = j + 1; m < lines.length; m++) {
        if (rtrimWs(lines[m]) === '>>>>>>> REPLACE') {
          k = m;
          break;
        }
      }
      if (k < 0) throw new ParseError(s + 1);
      blocks.push({ path, oldLines: lines.slice(s + 1, j), newLines: lines.slice(j + 1, k) });
      prevPath = path;
      prevEnd = k;
      i = k + 1;
      continue;
    }
    i++;
  }
  if (blocks.length === 0) throw new ParseError(1);
  return blocks;
}

function applySRBlock(tree: Tree, b: SRBlock, strict: boolean): EditFail | null {
  if (!isSafePath(b.path)) return { code: 'unsafe', path: b.path };
  if (b.oldLines.length === 0) {
    if (tree.exists(b.path)) return { code: 'exists', path: b.path };
    tree.set(b.path, serializeFile({ lines: b.newLines, br: '\n', eol: true }));
    return null;
  }
  if (!tree.exists(b.path)) return { code: 'missing', path: b.path };
  const raw = tree.get(b.path) as string;
  const parts = parseFileText(raw);
  const found = findTier(parts.lines, b.oldLines, strict, 0);
  if (found === null) return { code: 'no-match', path: b.path };
  if (found.occ.length > 1) return { code: 'ambiguous', path: b.path };
  const pos = found.occ[0];
  const nLines: NLine[] = b.newLines.map((t) => ({ text: t, ctx: -1 }));
  const newLines = buildNewLines(parts.lines, pos, b.oldLines, nLines, found.tier);
  const nl = [...parts.lines.slice(0, pos), ...newLines, ...parts.lines.slice(pos + b.oldLines.length)];
  tree.set(b.path, serializeFile({ lines: nl, br: parts.br, eol: parts.eol }));
  return null;
}

/** ---- V4A patches (SPEC section 8) ---- */

interface V4ABodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

interface V4AChunk {
  /** Null when the chunk has no anchor. */
  anchor: string | null;
  body: V4ABodyLine[];
  /** True when a `*** End of File` line closed the chunk. */
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  /** For Add: the file's lines. */
  lines: string[];
  moveTo: string | null;
  chunks: V4AChunk[];
  /** 1-based line of the section header. */
  headerLine: number;
}

interface RawLine {
  text: string;
  line: number;
}

function parseV4A(lines: string[]): V4ASection[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new ParseError(1);
  if (trimWs(lines[first]) !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (trimWs(lines[last]) !== '*** End Patch') throw new ParseError(lines.length + 1);

  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = trimWs(line.slice('*** Add File: '.length));
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = trimWs(line.slice('*** Delete File: '.length));
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = trimWs(line.slice('*** Update File: '.length));
    } else {
      throw new ParseError(i + 1);
    }
    const headerLine = i + 1;
    i++;
    const raw: RawLine[] = [];
    while (i < last) {
      const l = lines[i];
      if (
        l.startsWith('*** Add File: ') ||
        l.startsWith('*** Delete File: ') ||
        l.startsWith('*** Update File: ') ||
        trimWs(l) === '*** End Patch'
      ) {
        break;
      }
      raw.push({ text: l, line: i + 1 });
      i++;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1].text)) raw.pop();

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const rl of raw) {
        if (rl.text.startsWith('+')) fileLines.push(rl.text.slice(1));
        else if (rl.text === '') fileLines.push('');
        else throw new ParseError(rl.line);
      }
      sections.push({ kind, path, lines: fileLines, moveTo: null, chunks: [], headerLine });
    } else if (kind === 'delete') {
      for (const rl of raw) {
        if (!isBlank(rl.text)) throw new ParseError(rl.line);
      }
      sections.push({ kind, path, lines: [], moveTo: null, chunks: [], headerLine });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (idx < raw.length && raw[idx].text.startsWith('*** Move to: ')) {
        moveTo = trimWs(raw[idx].text.slice('*** Move to: '.length));
        idx++;
      }
      const chunks: V4AChunk[] = [];
      let curChunk: V4AChunk | null = null;
      const closeChunk = (): void => {
        if (curChunk !== null) {
          chunks.push(curChunk);
          curChunk = null;
        }
      };
      for (; idx < raw.length; idx++) {
        const rl = raw[idx];
        const l = rl.text;
        if (l.startsWith('@@')) {
          closeChunk();
          const anchor = trimWs(l.slice(2));
          curChunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          continue;
        }
        if (trimWs(l) === '*** End of File') {
          if (curChunk === null) throw new ParseError(rl.line);
          curChunk.eof = true;
          closeChunk();
          continue;
        }
        if (l.startsWith('*** ')) throw new ParseError(rl.line);
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (curChunk === null) {
            if (chunks.length === 0) {
              curChunk = { anchor: null, body: [], eof: false };
            } else {
              if (l === '') continue;
              throw new ParseError(rl.line);
            }
          }
          if (l === '') curChunk.body.push({ kind: 'ctx', text: '' });
          else if (l[0] === ' ') curChunk.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') curChunk.body.push({ kind: 'old', text: l.slice(1) });
          else curChunk.body.push({ kind: 'new', text: l.slice(1) });
          continue;
        }
        throw new ParseError(rl.line);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new ParseError(headerLine);
      sections.push({ kind, path, lines: [], moveTo, chunks, headerLine });
    }
  }
  if (sections.length === 0) throw new ParseError(1);
  return sections;
}

function applyV4ASection(
  tree: Tree,
  s: V4ASection,
  strict: boolean,
  moves: { old: string; new: string }[],
): EditFail | null {
  if (!isSafePath(s.path)) return { code: 'unsafe', path: s.path };
  if (s.moveTo !== null && !isSafePath(s.moveTo)) return { code: 'unsafe', path: s.moveTo };
  if (s.kind === 'add') {
    if (tree.exists(s.path)) return { code: 'exists', path: s.path };
    tree.set(s.path, serializeFile({ lines: s.lines, br: '\n', eol: true }));
    return null;
  }
  if (s.kind === 'delete') {
    if (!tree.exists(s.path)) return { code: 'missing', path: s.path };
    tree.set(s.path, null);
    return null;
  }
  if (!tree.exists(s.path)) return { code: 'missing', path: s.path };
  if (s.moveTo !== null && tree.exists(s.moveTo)) return { code: 'exists', path: s.moveTo };
  const raw = tree.get(s.path) as string;
  let parts = parseFileText(raw);
  let cursor = 0;
  for (const ch of s.chunks) {
    if (ch.anchor !== null) {
      const at = findSingleTier(parts.lines, ch.anchor, strict, cursor);
      if (at === null) return { code: 'no-match', path: s.path };
      cursor = at + 1;
    }
    const o: string[] = [];
    const n: NLine[] = [];
    for (const bl of ch.body) {
      if (bl.kind === 'ctx') {
        o.push(bl.text);
        n.push({ text: bl.text, ctx: o.length - 1 });
      } else if (bl.kind === 'old') {
        o.push(bl.text);
      } else {
        n.push({ text: bl.text, ctx: -1 });
      }
    }
    if (o.length === 0) {
      const at = ch.eof ? parts.lines.length : cursor;
      const newLines = buildNewLines(parts.lines, at, o, n, 0);
      parts = {
        lines: [...parts.lines.slice(0, at), ...newLines, ...parts.lines.slice(at)],
        br: parts.br,
        eol: parts.eol,
      };
      cursor = at + newLines.length;
      continue;
    }
    const found = findTier(parts.lines, o, strict, cursor);
    if (found === null) return { code: 'no-match', path: s.path };
    let pos = -1;
    for (const p of found.occ) {
      if (ch.eof && p + o.length !== parts.lines.length) continue;
      pos = p;
      break;
    }
    if (pos < 0) return { code: 'no-match', path: s.path };
    const newLines = buildNewLines(parts.lines, pos, o, n, found.tier);
    parts = {
      lines: [...parts.lines.slice(0, pos), ...newLines, ...parts.lines.slice(pos + o.length)],
      br: parts.br,
      eol: parts.eol,
    };
    cursor = pos + newLines.length;
  }
  const outText = serializeFile(parts);
  if (s.moveTo !== null) {
    tree.set(s.path, null);
    tree.set(s.moveTo, outText);
    moves.push({ old: s.path, new: s.moveTo });
  } else {
    tree.set(s.path, outText);
  }
  return null;
}

/** ---- JSON edits (SPEC section 9) ---- */

interface JsonEdit {
  path: string;
  command: string;
  fileText?: string;
  oldStr?: string;
  newStr?: string;
  insertLine?: number;
}

function validateJsonEdit(v: unknown, line: number): JsonEdit {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ParseError(line);
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseError(line);
  if (typeof o.command !== 'string') throw new ParseError(line);
  const cmd = o.command;
  if (cmd === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseError(line);
    return { path: o.path, command: cmd, fileText: o.file_text };
  }
  if (cmd === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str.length === 0) throw new ParseError(line);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseError(line);
    return { path: o.path, command: cmd, oldStr: o.old_str, newStr: typeof o.new_str === 'string' ? o.new_str : '' };
  }
  if (cmd === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseError(line);
    if (typeof o.new_str !== 'string') throw new ParseError(line);
    return { path: o.path, command: cmd, insertLine: o.insert_line, newStr: o.new_str };
  }
  throw new ParseError(line);
}

function parseJson(lines: string[]): JsonEdit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new ParseError(1);
  const firstText = lines[first].trimStart();
  if (firstText.startsWith('[')) {
    const startLine = first + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines.join('\n'));
    } catch {
      throw new ParseError(startLine);
    }
    if (!Array.isArray(parsed)) throw new ParseError(startLine);
    const edits: JsonEdit[] = [];
    for (const el of parsed) edits.push(validateJsonEdit(el, startLine));
    if (edits.length === 0) throw new ParseError(1);
    return edits;
  }
  const edits: JsonEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      throw new ParseError(i + 1);
    }
    edits.push(validateJsonEdit(parsed, i + 1));
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function applyJsonEdit(tree: Tree, e: JsonEdit): EditFail | null {
  if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
  if (e.command === 'create') {
    if (tree.exists(e.path)) return { code: 'exists', path: e.path };
    tree.set(e.path, e.fileText as string);
    return null;
  }
  if (!tree.exists(e.path)) return { code: 'missing', path: e.path };
  const raw = tree.get(e.path) as string;
  if (e.command === 'str_replace') {
    const parts = parseFileText(raw);
    let text = raw;
    let oldStr = e.oldStr as string;
    let newStr = e.newStr as string;
    if (parts.br === '\r\n') {
      text = raw.replace(/\r\n/g, '\n');
      oldStr = oldStr.replace(/\r\n/g, '\n');
      newStr = newStr.replace(/\r\n/g, '\n');
    }
    let count = 0;
    let at = -1;
    let from = 0;
    while (true) {
      const p = text.indexOf(oldStr, from);
      if (p < 0) break;
      count++;
      at = p;
      from = p + 1;
      if (count > 1) break;
    }
    if (count === 0) return { code: 'no-match', path: e.path };
    if (count > 1) return { code: 'ambiguous', path: e.path };
    let out = text.slice(0, at) + newStr + text.slice(at + oldStr.length);
    if (parts.br === '\r\n') out = out.replace(/\n/g, '\r\n');
    tree.set(e.path, out);
    return null;
  }
  const parts = parseFileText(raw);
  const n = e.insertLine as number;
  if (n < 0 || n > parts.lines.length) return { code: 'no-match', path: e.path };
  const ins = splitLines(e.newStr as string);
  const nl = [...parts.lines.slice(0, n), ...ins, ...parts.lines.slice(n)];
  tree.set(e.path, serializeFile({ lines: nl, br: parts.br, eol: parts.eol }));
  return null;
}

/** ---- Invocation, format detection, and the main flow (SPEC 1, 2, 4, 10) ---- */

interface Options {
  format: string;
  check: boolean;
  strict: boolean;
  /** Null when the patch comes from standard input. */
  patch: string | null;
}

/** Parse the arguments. Null means a usage error. */
function parseArgs(argv: string[]): Options | null {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const pos: string[] = [];
  let afterDD = false;
  for (const a of argv) {
    if (!afterDD && a === '--') {
      afterDD = true;
      continue;
    }
    if (!afterDD && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        format = v;
      } else if (a === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else {
        return null;
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return null;
  return { format, check, strict, patch: pos.length === 1 ? pos[0] : null };
}

/** Detect the format with `--format=auto`: the first rule that holds. */
function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  if (trimWs(lines[first]) === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  for (const l of lines) {
    if (rtrimWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

function main(): number {
  const opts = parseArgs(process.argv.slice(2));
  if (opts === null) {
    process.stdout.write('error: usage\n');
    return 2;
  }

  let patchText: string;
  if (opts.patch === null || opts.patch === '-') {
    try {
      patchText = readFileSync(0, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      return 2;
    }
  } else {
    try {
      patchText = readFileSync(opts.patch, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      return 2;
    }
  }
  const lines = splitLines(patchText);

  let format = opts.format;
  if (format === 'auto') {
    const d = detectFormat(lines);
    if (d === null) {
      process.stdout.write('error: format\n');
      return 2;
    }
    format = d;
  }

  const tree = new Tree();
  const moves: { old: string; new: string }[] = [];
  const failures: EditFail[] = [];
  let total = 0;
  try {
    if (format === 'unified') {
      const sections = parseUnified(lines);
      total = sections.length;
      for (const s of sections) {
        const f = applyUnifiedSection(tree, s, opts.strict, moves);
        if (f !== null) failures.push(f);
      }
    } else if (format === 'search-replace') {
      const blocks = parseSearchReplace(lines);
      total = blocks.length;
      for (const b of blocks) {
        const f = applySRBlock(tree, b, opts.strict);
        if (f !== null) failures.push(f);
      }
    } else if (format === 'v4a') {
      const secs = parseV4A(lines);
      total = secs.length;
      for (const s of secs) {
        const f = applyV4ASection(tree, s, opts.strict, moves);
        if (f !== null) failures.push(f);
      }
    } else {
      const edits = parseJson(lines);
      total = edits.length;
      for (const e of edits) {
        const f = applyJsonEdit(tree, e);
        if (f !== null) failures.push(f);
      }
    }
  } catch (err) {
    if (err instanceof ParseError) {
      process.stdout.write('error: parse ' + err.line + '\n');
      return 2;
    }
    throw err;
  }

  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += 'error: ' + f.code + ' ' + f.path + '\n';
    out += 'failed: ' + failures.length + ' of ' + total + ' edits\n';
    process.stdout.write(out);
    return 1;
  }

  const changed = tree.changed();
  interface OutEntry {
    key: string;
    line: string;
  }
  const entries: OutEntry[] = [];
  const beforeOf = new Map<string, string | null>();
  const afterOf = new Map<string, string | null>();
  for (const c of changed) {
    beforeOf.set(c.path, c.before);
    afterOf.set(c.path, c.after);
    let line: string;
    if (c.after === null) line = 'D ' + c.path;
    else if (c.before === null) line = 'A ' + c.path;
    else line = 'M ' + c.path;
    entries.push({ key: c.path, line });
  }
  for (const m of moves) {
    const bOld = beforeOf.get(m.old);
    const aOld = afterOf.get(m.old);
    const bNew = beforeOf.get(m.new);
    const aNew = afterOf.get(m.new);
    if (bOld !== null && bOld !== undefined && aOld === null && bNew === null && aNew !== null && aNew !== undefined) {
      const di = entries.findIndex((e) => e.key === m.old && e.line.startsWith('D '));
      const ai = entries.findIndex((e) => e.key === m.new && e.line.startsWith('A '));
      if (di >= 0 && ai >= 0) {
        const hi = Math.max(di, ai);
        const lo = Math.min(di, ai);
        entries.splice(hi, 1);
        entries.splice(lo, 1);
        entries.push({ key: m.new, line: 'R ' + m.old + ' -> ' + m.new });
      }
    }
  }
  entries.sort((a, b) => byteCompare(a.key, b.key));
  if (!opts.check) tree.writeAll();
  let out = '';
  for (const e of entries) out += e.line + '\n';
  out += 'ok: ' + entries.length + (entries.length === 1 ? ' file\n' : ' files\n');
  process.stdout.write(out);
  return 0;
}

/** Trial hand-over: when the trial environment is set, the runner takes
 * over and runs the trial's checks; otherwise run the CLI normally. */
const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  process.exitCode = main();
}
