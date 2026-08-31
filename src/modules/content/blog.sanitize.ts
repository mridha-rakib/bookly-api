/**
 * Blog `bodyHtml` sanitization is now the shared Content sanitizer (see content.sanitize.ts).
 * This module stays as a stable import surface for the Blog code — behaviour is unchanged
 * (`sanitizeContentHtml` uses the same allow-list Blog always relied on, plus additive,
 * inert-for-Blog `text-align`/`div` support added for Static Pages).
 */
export { htmlToPlainText, sanitizeContentHtml as sanitizeBlogHtml } from "./content.sanitize.js";
