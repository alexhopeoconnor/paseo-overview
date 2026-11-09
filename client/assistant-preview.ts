import type { EventPreview } from "../shared/model";
import { fallbackGraphemes, previewText } from "./event-preview";

const BUFFER_LIMIT = 2048, STREAM_LIMIT = 128;
const WAIT_MS = 800, CADENCE_MS = 1000, IDLE_MS = 30_000;

interface Stream {
  sourceKey: string;
  identified: boolean;
  pending: string;
  clipped: boolean;
  inputAt: number;
  due?: number;
  last?: EventPreview;
  shownAt?: number;
}

/** Standalone separators and fence markers are structure, not useful activity. */
function formattingOnly(value: string): boolean {
  const line = value.trim();
  return /^([-*_])(?:\s*\1){2,}$/.test(line) || /^(?:`{3,}[^`\n]*|~{3,}[^~\n]*)$/.test(line);
}

/** The buffer contains raw deltas. Formatting happens only after choosing a boundary. */
function latestExcerpt(stream: Stream, terminal: boolean): EventPreview | undefined {
  let start = 0, completed = "", consumed = 0;
  // Internal ASCII sentence boundaries require following whitespace. At the
  // deadline, final punctuation is also usable; an unpunctuated tail still waits
  // for complete words. Lines give code and lists boundaries without parsing Markdown.
  const boundaries = /\n+|[。！？]["'’”）\]]*|[.!?]["'’”)\]]*(?=\s)/g;
  for (const match of stream.pending.matchAll(boundaries)) {
    const end = match.index! + match[0].length;
    const candidate = stream.pending.slice(start, end);
    if (candidate.trim() && !formattingOnly(candidate)) completed = candidate;
    // Consume ignored complete lines too, while retaining the last useful one.
    consumed = end;
    start = end;
  }
  const tail = stream.pending.slice(consumed);
  const usefulTail = tail.trim().length > 0 && !formattingOnly(tail);
  const ended = usefulTail && /[.!?。！？]["'’”)）\]]*\s*$/.test(tail);
  const clipped = stream.clipped;
  // Make progress even when the buffer contains only ignored structure. Keep
  // an unfinished tail intact, including whitespace and split words.
  if (ended) {
    stream.pending = "";
    stream.clipped = false;
  } else if (consumed) {
    stream.pending = tail;
    stream.clipped = false;
  }
  let chosen = (terminal && usefulTail) || ended ? tail : completed;
  let openChunk = false;
  if (!chosen && !terminal) {
    if (!usefulTail) return undefined;
    // A timer is not evidence that the last word has finished. Keep tiny tails
    // behind the useful previous preview until more words or a terminal arrive.
    const lastSpace = tail.search(/\s\S*$/);
    chosen = lastSpace >= 0 ? tail.slice(0, lastSpace) : "";
    if (previewText(chosen).text.length < 24) {
      const unspaced = tail.trim();
      if (/\s/.test(unspaced) || fallbackGraphemes(unspaced).length < 64) return undefined;
      // CJK and long code identifiers need a bounded fallback too. An ellipsis
      // makes the unbroken, still-streaming chunk explicit instead of inventing
      // a word boundary. Short partial ASCII words continue to wait.
      chosen = unspaced; openChunk = true;
    }
  }
  if (!chosen) return undefined;
  const compact = previewText(chosen.replace(/[\uD800-\uDBFF]$/, ""), BUFFER_LIMIT);
  if (!compact.text) return undefined;
  const graphemes = fallbackGraphemes(compact.text);
  const shortened = graphemes.length > 240;
  let detail = compact.text;
  if (shortened) {
    detail = graphemes.slice(-237).join("");
    const space = detail.search(/\s/);
    if (space >= 0 && space < 80) detail = detail.slice(space + 1);
  }
  const omitted = clipped || shortened || compact.truncated;
  if (omitted) detail = previewText(`… ${detail}`, 240).text;
  if (openChunk) {
    detail = previewText(detail, 239).text;
    if (!detail.endsWith("…")) detail += "…";
  }
  return { title: "Assistant update", detail, truncated: omitted || openChunk };
}

/** Bounded, lossy previews of public assistant deltas; never a transcript backlog. */
export class AssistantPreviewBuffer {
  private readonly streams = new Map<string, Stream>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly emit: (nodeId: string, sourceKey: string, preview: EventPreview) => void) {}

  append(nodeId: string, sourceKey: string, delta: string, identified = false): void {
    if (!delta) return;
    const now = Date.now();
    let stream = this.streams.get(nodeId);
    if (!stream || stream.sourceKey !== sourceKey || now - stream.inputAt >= IDLE_MS) {
      stream = { sourceKey, identified, pending: "", clipped: false, inputAt: now };
      this.streams.delete(nodeId);
      this.streams.set(nodeId, stream);
    }
    // Slice before concatenation so a megabyte delta cannot create a megabyte buffer.
    const overflow = stream.pending.length + delta.length > BUFFER_LIMIT;
    stream.pending = (delta.length >= BUFFER_LIMIT ? delta.slice(-BUFFER_LIMIT) : stream.pending + delta).slice(-BUFFER_LIMIT);
    if (overflow) {
      // The first grapheme may have been cut by the bounded suffix scan.
      stream.pending = fallbackGraphemes(stream.pending.replace(/^[\uDC00-\uDFFF]/, "")).slice(1).join("");
      stream.clipped = true;
    }
    stream.inputAt = now;
    stream.due ??= Math.max(now + WAIT_MS, (stream.shownAt ?? -Infinity) + CADENCE_MS);
    while (this.streams.size > STREAM_LIMIT) this.streams.delete(this.streams.keys().next().value!);
    this.schedule();
  }

  /** Without a message ID, an intervening timeline item ends the contiguous run. */
  boundary(nodeId: string): void {
    if (!this.streams.get(nodeId)?.identified) this.drop(nodeId);
  }

  finish(nodeId: string): EventPreview | undefined {
    const stream = this.streams.get(nodeId);
    this.drop(nodeId);
    if (!stream) return undefined;
    return latestExcerpt(stream, true) ?? (Date.now() - (stream.shownAt ?? -Infinity) < 8000 ? stream.last : undefined);
  }

  drop(nodeId: string): void { this.streams.delete(nodeId); this.schedule(); }

  prune(present: ReadonlySet<string>): void {
    for (const id of this.streams.keys()) if (!present.has(id)) this.streams.delete(id);
    this.schedule();
  }

  clear(): void {
    this.streams.clear();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    let due = Infinity;
    for (const stream of this.streams.values()) due = Math.min(due, stream.due ?? Infinity, stream.inputAt + IDLE_MS);
    if (!Number.isFinite(due)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const now = Date.now();
      for (const [id, stream] of this.streams) {
        if (now - stream.inputAt >= IDLE_MS) { this.streams.delete(id); continue; }
        if (stream.due === undefined || stream.due > now) continue;
        stream.due = undefined;
        const pending = stream.pending;
        const preview = latestExcerpt(stream, false);
        if (stream.pending !== pending && stream.pending.trim()) stream.due = now + CADENCE_MS;
        if (!preview || stream.last && preview.detail === stream.last.detail && preview.truncated === stream.last.truncated) continue;
        stream.last = preview;
        stream.shownAt = now;
        this.emit(id, stream.sourceKey, preview);
      }
      this.schedule();
    }, Math.max(0, due - Date.now()));
  }
}
