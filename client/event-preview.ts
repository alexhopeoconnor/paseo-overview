import type { EventPreview } from "../shared/model";
import { record } from "./transport";

export interface PreviewText { text: string; truncated: boolean }

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

/** Conservative fallback for marks, emoji modifiers, flags and joined emoji. */
export function fallbackGraphemes(value: string): string[] {
  const result: string[] = [];
  let regionalCount = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const regional = code >= 0x1f1e6 && code <= 0x1f1ff;
    const previous = result[result.length - 1];
    const extension = /\p{Mark}/u.test(character) || code === 0xfe0e || code === 0xfe0f ||
      (code >= 0x1f3fb && code <= 0x1f3ff) || (code >= 0xe0020 && code <= 0xe007f);
    if (previous && (extension || code === 0x200d || previous.endsWith("\u200d") || (regional && regionalCount % 2 === 1))) {
      result[result.length - 1] += character;
    } else result.push(character);
    regionalCount = regional ? regionalCount + 1 : 0;
  }
  return result;
}

/** Work and retained memory are bounded even for megabyte messages or leading whitespace. */
export function previewText(value: unknown, limit = 240, useFallback = false): PreviewText {
  if (typeof value !== "string" || limit < 1) return { text: "", truncated: false };
  const scanLimit = Math.max(1024, Math.min(8192, limit * 24));
  const sourceCut = value.length > scanLimit;
  let prefix = value.slice(0, scanLimit);
  // A capped scan is not evidence that the final grapheme was complete.
  if (sourceCut && /[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  const compact = prefix.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const characters = segmenter && !useFallback
    ? Array.from(segmenter.segment(compact), item => item.segment)
    : fallbackGraphemes(compact);
  if (sourceCut) characters.pop();
  const truncated = sourceCut || characters.length > limit;
  const content = characters.slice(0, truncated ? Math.max(0, limit - 1) : limit).join("").trimEnd();
  return { text: truncated ? `${content}…` : content, truncated };
}

function makePreview(title: string, detail?: unknown): EventPreview {
  const heading = previewText(title, 60);
  const body = previewText(detail, 240);
  return { title: heading.text, detail: body.text || undefined, truncated: heading.truncated || body.truncated };
}

function fileLabel(value: unknown): PreviewText {
  const bounded = previewText(value, 320);
  const parts = bounded.text.replace(/\\/g, "/").split("/").filter(Boolean);
  const shortened = parts.length > 2;
  return { text: `${shortened ? "…/" : ""}${parts.slice(-2).join("/")}`, truncated: bounded.truncated || shortened };
}

/** Public timeline fields only. Private reasoning and unstructured tool output are excluded. */
export function timelinePreview(input: unknown): EventPreview | undefined {
  const item = record(input);
  if (!item) return undefined;
  if (item.type === "assistant_message") return makePreview("Assistant update", item.text);
  if (item.type === "error" || (item.type === "notification" && item.level === "error")) return makePreview("Error", item.message);
  if (item.type !== "tool_call") return undefined;

  const detail = record(item.detail);
  const status = item.status === "failed" ? "failed" : item.status === "running" ? "running"
    : item.status === "completed" ? "finished" : item.status === "canceled" ? "canceled" : "updated";
  let title = `${previewText(item.name, 40).text || "Tool"} · ${status}`;
  let body: unknown;
  let shortened = false;
  switch (detail?.type) {
    case "shell": {
      title = `Command ${status}`;
      const command = previewText(detail.command, 210);
      body = `${command.text}${typeof detail.exitCode === "number" ? ` · exit ${detail.exitCode}` : ""}`;
      shortened = command.truncated;
      break;
    }
    case "read":
    case "edit":
    case "write": {
      title = `${detail.type === "read" ? "Read" : detail.type === "edit" ? "Edit" : "Write"} ${status}`;
      const path = fileLabel(detail.filePath);
      body = path.text;
      shortened = path.truncated;
      break;
    }
    case "search": {
      title = `Search ${status}`;
      const query = previewText(detail.query, 200);
      const count = typeof detail.numMatches === "number" ? `${detail.numMatches} matches`
        : typeof detail.numFiles === "number" ? `${detail.numFiles} files` : undefined;
      body = `${query.text}${count ? ` · ${count}` : ""}`;
      shortened = query.truncated || detail.truncated === true;
      break;
    }
    case "fetch": title = `Fetch ${status}`; body = detail.url; break;
    case "sub_agent": title = `Delegation ${status}`; body = detail.description; break;
    case "plain_text": body = detail.label; break;
  }
  const preview = makePreview(title, body);
  return { ...preview, truncated: preview.truncated || shortened };
}

export function previewSummary(preview: EventPreview): string {
  return preview.detail ? `${preview.title} · ${preview.detail}` : preview.title;
}
