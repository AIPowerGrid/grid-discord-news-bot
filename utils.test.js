// Smoke tests for grid-discord-news-bot pure utilities.

const { normalizeApiText, sanitizeHtmlForDiscord } = require('./utils');

describe('normalizeApiText', () => {
  test('returns empty string for null/undefined/empty', () => {
    expect(normalizeApiText(null)).toBe('');
    expect(normalizeApiText(undefined)).toBe('');
    expect(normalizeApiText('')).toBe('');
  });

  test('stitches mid-word newlines back together', () => {
    expect(normalizeApiText('hel\nlo')).toBe('hello');
  });

  test('preserves paragraph breaks', () => {
    expect(normalizeApiText('para one.\n\npara two.')).toBe(
      'para one.\n\npara two.',
    );
  });

  test('collapses 3+ newlines to a double break', () => {
    expect(normalizeApiText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  test('normalizes Windows line endings', () => {
    expect(normalizeApiText('a\r\nb')).toBe('a\nb');
  });
});

describe('sanitizeHtmlForDiscord', () => {
  test('returns empty for falsy input', () => {
    expect(sanitizeHtmlForDiscord(null)).toBe('');
    expect(sanitizeHtmlForDiscord('')).toBe('');
  });

  test('strips simple HTML tags but keeps content', () => {
    expect(sanitizeHtmlForDiscord('<p>hello <b>world</b></p>')).toBe(
      'hello world',
    );
  });

  test('removes <img> tags completely', () => {
    expect(sanitizeHtmlForDiscord('text <img src="x.png"/> more')).toBe(
      'text  more',
    );
  });

  test('removes <figure> blocks including content', () => {
    const html = 'before <figure><img src="x"/><figcaption>cap</figcaption></figure> after';
    expect(sanitizeHtmlForDiscord(html)).toBe('before  after');
  });

  test('decodes HTML entities (ampersand survives because no surrounding tag chars)', () => {
    expect(sanitizeHtmlForDiscord('AT&amp;T rocks')).toBe('AT&T rocks');
  });

  test('decoded angle brackets get stripped as tags (documented behavior)', () => {
    // &lt;rocks&gt; decodes to <rocks> which then matches the tag-strip regex.
    // This is the intended Discord-safety behavior — anything that looks like
    // a tag after decoding is also removed.
    expect(sanitizeHtmlForDiscord('AT&amp;T &lt;rocks&gt;')).toBe('AT&T');
  });
});
