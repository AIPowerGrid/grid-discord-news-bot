// Pure utility functions extracted from index.js so they can be unit-tested.
// index.js requires this file and re-uses the same implementations.

const { decode } = require('html-entities');

/**
 * Normalize text returned by the Grid LLM API. The API sometimes inserts
 * newlines mid-word; this stitches them back together and collapses
 * runaway whitespace.
 */
function normalizeApiText(text) {
  if (!text) return '';

  let normalized = text;

  // Remove newlines that break words (main API quirk)
  normalized = normalized.replace(/(\S)\n(\S)/g, '$1$2');

  // Normalize line endings + collapse excessive blank lines
  normalized = normalized
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return normalized;
}

/**
 * Sanitize HTML content for Discord plaintext rendering.
 * Strips tags + entities; drops <img> and <figure> blocks entirely.
 */
function sanitizeHtmlForDiscord(htmlContent) {
  if (!htmlContent) return '';

  let content = decode(htmlContent);

  content = content
    .replace(/<img[^>]*>/g, '')
    .replace(/<figure[^>]*>[\s\S]*?<\/figure>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return content;
}

module.exports = { normalizeApiText, sanitizeHtmlForDiscord };
