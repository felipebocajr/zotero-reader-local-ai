/** Pure, dependency-free recursive text splitting for retrieved paper context. */

export const DEFAULT_CHUNK_SIZE = 1200;
export const DEFAULT_CHUNK_OVERLAP = 160;
// PDF extraction inserts hard line breaks roughly every 80 characters. Trying
// "\n" before ". " would cut sentences in half, so sentences come first; lines
// remain the fallback for tables, equations and text without punctuation.
export const DEFAULT_SEPARATORS = ["\n\n", ". ", ".\n", "\n", " ", ""] as const;

export type ChunkBoundary = "paragraph" | "line" | "sentence" | "word" | "char" | "end";

export interface ChunkOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  separators?: readonly string[];
}

export interface TextChunk {
  index: number;
  /** Prompt text, including the overlap prefix when present. */
  text: string;
  /** Exact chunk content in the normalized source text, without overlap. */
  coreText: string;
  /** Start of the overlap prefix in the normalized source text. */
  textStart: number;
  /** Start of the non-overlapping chunk content. */
  start: number;
  /** End of the chunk content (exclusive). */
  end: number;
  heading?: string;
  /** The natural boundary where the chunk ended. */
  boundary: ChunkBoundary;
}

export interface HeadingSpan { start: number; end: number; text: string }
interface Span { start: number; end: number }
interface Segment extends Span { index: number; heading?: string }
interface ResolvedOptions { chunkSize: number; chunkOverlap: number; separators: readonly string[] }

/**
 * Zotero inserts form feeds between PDF pages. They are not semantic
 * paragraphs, so normalize them to line breaks; sentences still win first.
 */
export function normalizePaperText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\f/g, "\n");
}

function resolveOptions(options: ChunkOptions): ResolvedOptions {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const separators = options.separators ?? DEFAULT_SEPARATORS;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new RangeError("chunkSize must be a positive integer");
  if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new RangeError("chunkOverlap must be a non-negative integer smaller than chunkSize");
  }
  if (!separators.length || separators.some(separator => typeof separator !== "string")) {
    throw new RangeError("separators must contain at least one string");
  }
  return { chunkSize, chunkOverlap, separators };
}

/** Split [start, end) at the first separator present, then recurse into oversized pieces. */
function splitUnits(text: string, start: number, end: number, separatorIndex: number, options: ResolvedOptions): Span[] {
  if (end - start <= options.chunkSize) return [{ start, end }];
  if (separatorIndex >= options.separators.length) return characterUnits(start, end, options.chunkSize);
  const separator = options.separators[separatorIndex];
  if (!separator) return characterUnits(start, end, options.chunkSize);

  const pieces: Span[] = [];
  let cursor = start;
  while (cursor < end) {
    const found = text.indexOf(separator, cursor);
    if (found < 0 || found + separator.length > end) break;
    const pieceEnd = found + separator.length;
    pieces.push({ start: cursor, end: pieceEnd });
    cursor = pieceEnd;
  }
  if (cursor < end) pieces.push({ start: cursor, end });
  // The separator occurs only at the very end (or not at all); try the next one.
  if (pieces.length <= 1) return splitUnits(text, start, end, separatorIndex + 1, options);

  const units: Span[] = [];
  for (const piece of pieces) {
    if (piece.end - piece.start <= options.chunkSize) units.push(piece);
    else units.push(...splitUnits(text, piece.start, piece.end, separatorIndex + 1, options));
  }
  return units;
}

function characterUnits(start: number, end: number, chunkSize: number): Span[] {
  const units: Span[] = [];
  for (let cursor = start; cursor < end; cursor += chunkSize) {
    units.push({ start: cursor, end: Math.min(cursor + chunkSize, end) });
  }
  return units;
}

/** Merge adjacent natural units greedily up to chunkSize. */
function mergeUnits(units: readonly Span[], chunkSize: number): Span[] {
  const merged: Span[] = [];
  for (const unit of units) {
    const last = merged[merged.length - 1];
    if (last && unit.end - last.start <= chunkSize) last.end = unit.end;
    else merged.push({ ...unit });
  }
  return merged;
}

/**
 * Detect section headings for forced chunk boundaries. Expects normalized text.
 * Numbered headings stop at References so citation entries do not split chunks.
 */
export function findHeadingSpans(text: string): HeadingSpan[] {
  const headings: HeadingSpan[] = [];
  let offset = 0;
  let inReferences = false;
  for (const line of text.split("\n")) {
    const value = line.trim();
    const known = /^(?:abstract|introduction|related work|background|methods?|results?|discussion|conclusions?|references|appendix(?:\s+[A-Z0-9.]+)?)$/i.test(value);
    // Zotero sometimes glues the number to the title ("5.1Baselines"). Requiring
    // a title-like word after the number keeps formulas and table rows such as
    // "2 D1 (p, q)" out. A final question mark is allowed in section titles.
    const numbering = value.match(/\b\d+(?:\.\d+)*[A-Z]/g)?.length ?? 0;
    const equationLike = /[=⌊⌋√∑∫≤≥]|\d[a-z]|\b\d+\s+[a-z]/.test(value);
    const numbered = numbering <= 1 && !equationLike &&
      /^\d+(?:\.\d+)*\.?\s*(?:[A-Z][a-z]|[A-Z]{2,})[^.!?]{0,90}\??$/.test(value);
    if (known) {
      headings.push({ start: offset, end: offset + line.length, text: value });
      if (/^references$/i.test(value)) inReferences = true;
      else if (/^appendix/i.test(value)) inReferences = false;
    } else if (numbered && !inReferences) {
      headings.push({ start: offset, end: offset + line.length, text: value });
    }
    offset += line.length + 1;
  }
  return headings;
}

function buildSegments(text: string, headings: readonly HeadingSpan[]): Segment[] {
  const boundaries = [...new Set([0, ...headings.map(heading => heading.start), text.length])].sort((a, b) => a - b);
  const byStart = new Map(headings.map(heading => [heading.start, heading.text]));
  const segments: Segment[] = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index], end = boundaries[index + 1];
    if (end <= start) continue;
    segments.push({ start, end, index: segments.length, heading: byStart.get(start) });
  }
  return segments;
}

function classifyBoundary(value: string, isEnd: boolean): ChunkBoundary {
  if (isEnd) return "end";
  if (/\n[ \t]*\n$/.test(value)) return "paragraph";
  if (/[.!?;:][ \t]*\n$/.test(value)) return "sentence";
  if (/\n$/.test(value)) return "line";
  if (/[.!?;:][ \t]$/.test(value)) return "sentence";
  if (/[ \t]$/.test(value)) return "word";
  return "char";
}

/** Start the overlap at a word boundary so a chunk never starts mid-word. */
function overlapStart(text: string, previous: Span, chunkOverlap: number): number {
  if (chunkOverlap <= 0) return previous.end;
  const target = Math.max(previous.start, previous.end - chunkOverlap);
  const whitespace = /\s/.exec(text.slice(target, previous.end));
  return whitespace ? target + whitespace.index + 1 : target;
}

/**
 * Split paper text with a hierarchy of natural separators. Sections are kept
 * separate, then each section tries paragraphs, sentences, lines, words and
 * finally characters. Short adjacent units are merged back up to chunkSize.
 */
export function splitRecursive(source: string, options: ChunkOptions = {}): TextChunk[] {
  const resolved = resolveOptions(options);
  const text = normalizePaperText(source);
  if (!text.trim()) return [];
  const segments = buildSegments(text, findHeadingSpans(text));
  const chunks: TextChunk[] = [];
  let previous: TextChunk | undefined;
  let previousSegment = -1;
  for (const segment of segments) {
    const cores = mergeUnits(splitUnits(text, segment.start, segment.end, 0, resolved), resolved.chunkSize);
    for (const core of cores) {
      const coreText = text.slice(core.start, core.end);
      if (!coreText.trim()) continue;
      const textStart = previous && previousSegment === segment.index
        ? overlapStart(text, { start: previous.start, end: previous.end }, resolved.chunkOverlap)
        : core.start;
      const value = text.slice(textStart, core.end).trim();
      if (!value) continue;
      const chunk: TextChunk = {
        index: chunks.length,
        text: value,
        coreText,
        textStart,
        start: core.start,
        end: core.end,
        heading: segment.heading,
        boundary: classifyBoundary(coreText, core.end === text.length),
      };
      chunks.push(chunk);
      previous = chunk;
      previousSegment = segment.index;
    }
  }
  return chunks;
}
