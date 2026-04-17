/**
 * Message rendering — Telegram HTML with session signatures.
 */

export const MAX_MESSAGE_LENGTH = 4096;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Format a reply with a session signature prefix.
 */
export function signReply(sessionName: string, text: string): string {
  return `<b>[${escapeHtml(sessionName)}]</b>\n${renderMarkdownToHtml(text)}`;
}

/**
 * Very simple markdown → Telegram HTML.
 * Handles: bold, italic, code, code blocks, links, headers.
 */
export function renderMarkdownToHtml(markdown: string): string {
  let result = markdown;

  // Code blocks: ```lang\n...\n```
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang: string, code: string) => {
    return `<pre><code>${escapeHtml(code.trim())}</code></pre>`;
  });

  // Inline code
  result = result.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    return `<code>${escapeHtml(code)}</code>`;
  });

  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => {
    return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
  });

  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");

  // Headers
  result = result.replace(/^### (.+)$/gm, "<b>$1</b>");
  result = result.replace(/^## (.+)$/gm, "<b>$1</b>");
  result = result.replace(/^# (.+)$/gm, "<b>$1</b>");

  return result;
}

/**
 * Chunk a message into Telegram-safe pieces (≤4096 chars).
 */
export function chunkMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph break
    let splitAt = remaining.lastIndexOf("\n\n", MAX_MESSAGE_LENGTH);
    if (splitAt < MAX_MESSAGE_LENGTH * 0.5) {
      // Try newline
      splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    }
    if (splitAt < MAX_MESSAGE_LENGTH * 0.5) {
      // Hard split
      splitAt = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  return chunks;
}
