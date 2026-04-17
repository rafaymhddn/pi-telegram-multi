/**
 * Message rendering — Telegram HTML with session signatures.
 */

export const MAX_MESSAGE_LENGTH = 4096;

// Tags that are self-closing / void and must not be tracked on the tag stack.
const VOID_TAGS = new Set(["br", "hr", "img"]);

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Build the chunked final reply for a session. Each chunk carries the
 * session signature as a trailing footer in the form:
 *
 *   --session_name              (single-chunk reply)
 *   --session_name (i/N)        (multi-chunk reply, per chunk)
 *
 * The body is rendered to Telegram HTML once, then chunked to fit the
 * 4096-char limit *minus* the worst-case footer length so no chunk overflows.
 */
export function buildReplyChunks(sessionName: string, markdown: string): string[] {
  const body = renderMarkdownToHtml(markdown);
  const safeName = escapeHtml(sessionName);
  const footer = (idx: number, total: number): string =>
    total <= 1
      ? `\n\n<i>--${safeName}</i>`
      : `\n\n<i>--${safeName} (${idx}/${total})</i>`;

  // Reserve space for the worst-case footer (up to 999/999) so that even
  // after pagination we never overshoot the 4096-char message limit.
  const worstCaseFooter = footer(999, 999).length;
  const bodyLimit = MAX_MESSAGE_LENGTH - worstCaseFooter;

  const bodyChunks = chunkMessage(body, bodyLimit);
  const total = bodyChunks.length;
  return bodyChunks.map((chunk, i) => chunk + footer(i + 1, total));
}

/**
 * Build a single-bubble streaming preview: body (truncated for responsiveness)
 * + trailing `--session_name` footer. No chunk counter since the preview is
 * always one message edited in place.
 */
export function buildPreview(sessionName: string, markdown: string, maxBodyChars = 500): string {
  const trimmedMd = markdown.length > maxBodyChars ? markdown.slice(0, maxBodyChars) + "…" : markdown;
  const body = renderMarkdownToHtml(trimmedMd);
  return `${body}\n\n<i>--${escapeHtml(sessionName)}</i>`;
}

/**
 * Very simple markdown → Telegram HTML.
 * Handles: bold, italic, code, code blocks, links, headers.
 *
 * Code blocks, inline code and links are extracted to opaque placeholders
 * *before* bold/italic/header passes run, so inline markdown inside code
 * (or URLs with `_`) is not mangled.
 */
export function renderMarkdownToHtml(markdown: string): string {
  const placeholders: string[] = [];
  const place = (html: string): string => {
    const idx = placeholders.length;
    placeholders.push(html);
    return `\x00P${idx}\x00`;
  };

  let result = markdown;

  // Code blocks: ```lang\n...\n```
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang: string, code: string) =>
    place(`<pre><code>${escapeHtml(code.trim())}</code></pre>`),
  );

  // Inline code
  result = result.replace(/`([^`\n]+)`/g, (_m, code: string) =>
    place(`<code>${escapeHtml(code)}</code>`),
  );

  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) =>
    place(`<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`),
  );

  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");

  // Headers
  result = result.replace(/^#{1,3} (.+)$/gm, "<b>$1</b>");

  // Restore placeholders
  result = result.replace(/\x00P(\d+)\x00/g, (_m, idx: string) => placeholders[Number(idx)] ?? "");

  return result;
}

/**
 * Walk an HTML string up to `limit` chars, tracking the open-tag stack.
 * Returns { index, stack, lastSafeAtDepthZero, lastParaAtDepthZero, lastLineAtDepthZero }
 * where "safe" positions are boundaries where no tag is open (depth 0).
 */
interface WalkState {
  index: number;
  stack: string[];
  lastSafeAtDepthZero: number;
  lastParaAtDepthZero: number;
  lastLineAtDepthZero: number;
}

function walk(html: string, limit: number): WalkState {
  const stack: string[] = [];
  let i = 0;
  let lastSafeAtDepthZero = 0;
  let lastParaAtDepthZero = -1;
  let lastLineAtDepthZero = -1;

  while (i < Math.min(html.length, limit)) {
    const ch = html.charCodeAt(i);

    // Tag?
    if (ch === 60 /* < */) {
      const close = html.indexOf(">", i);
      if (close === -1 || close >= limit) break; // tag straddles the boundary
      const tag = html.slice(i, close + 1);
      if (tag.startsWith("</")) {
        const name = tag.slice(2, -1).trim().toLowerCase().split(/\s/)[0];
        if (stack[stack.length - 1] === name) stack.pop();
      } else if (!tag.endsWith("/>")) {
        const name = tag.slice(1, -1).trim().toLowerCase().split(/[\s/>]/)[0];
        if (!VOID_TAGS.has(name)) stack.push(name);
      }
      i = close + 1;
      if (stack.length === 0) lastSafeAtDepthZero = i;
      continue;
    }

    // Entity?
    if (ch === 38 /* & */) {
      const semi = html.indexOf(";", i);
      if (semi === -1 || semi >= limit) break; // entity straddles the boundary
      i = semi + 1;
      if (stack.length === 0) lastSafeAtDepthZero = i;
      continue;
    }

    // Surrogate pair? Advance by 2 atomically.
    if (ch >= 0xd800 && ch <= 0xdbff) {
      i += 2;
    } else {
      i += 1;
    }

    if (stack.length === 0) {
      lastSafeAtDepthZero = i;
      if (ch === 10 /* \n */) {
        lastLineAtDepthZero = i;
        if (html.charCodeAt(i) === 10) lastParaAtDepthZero = i + 1;
      }
    }
  }

  return {
    index: i,
    stack,
    lastSafeAtDepthZero,
    lastParaAtDepthZero,
    lastLineAtDepthZero,
  };
}

/**
 * Chunk a Telegram-HTML message into pieces ≤ MAX_MESSAGE_LENGTH,
 * preserving tag balance across chunks by closing open tags at the end
 * of a chunk and re-opening them at the start of the next.
 *
 * Never splits inside a `<tag>`, inside an `&entity;`, or inside a UTF-16
 * surrogate pair.
 */
export function chunkMessage(html: string, limit: number = MAX_MESSAGE_LENGTH): string[] {
  if (html.length <= limit) return [html];

  const chunks: string[] = [];
  let remaining = html;
  let carry = ""; // re-opened tags prepended to the next chunk

  while (remaining.length > 0) {
    const candidate = carry + remaining;
    if (candidate.length <= limit) {
      chunks.push(candidate);
      break;
    }

    const { index, lastSafeAtDepthZero, lastParaAtDepthZero, lastLineAtDepthZero } = walk(
      candidate,
      limit,
    );

    // Pick best split position: paragraph > line > any safe point > walker exit.
    const half = limit * 0.5;
    let splitAt: number;
    if (lastParaAtDepthZero > half) splitAt = lastParaAtDepthZero;
    else if (lastLineAtDepthZero > half) splitAt = lastLineAtDepthZero;
    else if (lastSafeAtDepthZero > 0) splitAt = lastSafeAtDepthZero;
    else splitAt = index;

    // Guarantee forward progress. If the walker stalled at 0 (e.g. a tag
    // straddles the very start of the limit window), hard-cut at the limit.
    if (splitAt <= 0) splitAt = Math.min(limit, candidate.length);

    // Re-compute the effective open-tag stack at splitAt.
    const { stack: effectiveStack } = walk(candidate, splitAt);

    const head = candidate.slice(0, splitAt);
    const closers = effectiveStack
      .slice()
      .reverse()
      .map((t) => `</${t}>`)
      .join("");
    chunks.push(head + closers);

    carry = effectiveStack.map((t) => `<${t}>`).join("");
    remaining = candidate.slice(splitAt).replace(/^\n+/, "");
  }

  return chunks;
}
