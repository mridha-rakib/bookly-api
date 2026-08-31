import sanitizeHtml from "sanitize-html";

/**
 * Shared server-side HTML sanitizer for Content Manager rich-text (`bodyHtml` on Blog posts and
 * Static Pages). Runs on EVERY write so the DB only ever stores render-safe HTML — pages can
 * then render it with `dangerouslySetInnerHTML` without a client-side sanitizer.
 *
 * Allow-list scoped to what the Content Manager editors can produce (`document.execCommand`:
 * bold/italic/underline/strike, H1–H4, ordered/unordered lists, links, blockquote, horizontal
 * rule, text alignment). No `img`, `script`, `style` tags, `iframe`, event handlers, or
 * non-http(s)/mailto URLs survive. Links are forced to `target="_blank" rel="noopener noreferrer"`.
 * `text-align` is the only inline style permitted (safe — no `url()` / `expression()`).
 */
const options: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "br",
    "b",
    "strong",
    "i",
    "em",
    "u",
    "s",
    "strike",
    "h1",
    "h2",
    "h3",
    "h4",
    "ul",
    "ol",
    "li",
    "a",
    "blockquote",
    "hr",
    "span",
    "div",
    "pre",
    "code",
  ],
  allowedAttributes: {
    a: ["href", "target", "rel"],
    p: ["style"],
    div: ["style"],
    h1: ["style"],
    h2: ["style"],
    h3: ["style"],
    h4: ["style"],
    li: ["style"],
    blockquote: ["style"],
  },
  allowedStyles: {
    "*": {
      "text-align": [/^(left|right|center|justify)$/],
    },
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { a: ["http", "https", "mailto"] },
  disallowedTagsMode: "discard",
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", {
      target: "_blank",
      rel: "noopener noreferrer",
    }),
  },
};

export const sanitizeContentHtml = (dirty: string): string => sanitizeHtml(dirty, options);

/** Plain-text projection of sanitized HTML — used to auto-derive a Blog excerpt when the author
 * doesn't supply one. Never an article/page body; only a short summary source. */
export const htmlToPlainText = (html: string): string =>
  sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim();
