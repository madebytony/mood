import DOMPurify from "isomorphic-dompurify";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A note body counts as HTML if it opens with a tag; otherwise it's a legacy plain-text note. */
export function isHtmlNote(content: string | null | undefined): boolean {
  return /^\s*</.test(content ?? "");
}

/** Wrap legacy plain-text note content into paragraphs so TipTap/render can consume it. */
export function plainToHtml(text: string): string {
  const lines = (text ?? "").split("\n");
  return lines.map((l) => (l.trim() ? `<p>${escapeHtml(l)}</p>` : "<p></p>")).join("") || "<p></p>";
}

const SANITIZE_OPTS = {
  ALLOWED_TAGS: ["p", "br", "strong", "b", "em", "i", "u", "s", "h1", "h2", "ul", "ol", "li", "a", "blockquote", "code", "span", "div", "label", "input"],
  ALLOWED_ATTR: ["href", "target", "rel", "style", "data-type", "data-checked", "type", "checked", "disabled", "class"],
};

/** Produce safe, render-ready HTML from a note's stored content (HTML or legacy plain text). */
export function noteToSafeHtml(content: string | null | undefined): string {
  const raw = content ?? "";
  const html = isHtmlNote(raw) ? raw : plainToHtml(raw);
  return DOMPurify.sanitize(html, SANITIZE_OPTS);
}
