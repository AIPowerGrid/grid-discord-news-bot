# grid-discord-news-bot - DOX root

## Purpose

Discord news bot that reads RSS feeds, summarizes/enhances news through AI Power
Grid, optionally generates images, posts to Discord, and answers user questions
about recent articles.

## Ownership

- `index.js` - bot runtime, RSS polling, prompt templates, Discord posting, and
  user interaction behavior.
- `grid.js` - canonical `/v1` text/image client.
- `db.js` - SQLite seen-article and recent-context store.
- `utils.js` / `utils.test.js` - sanitization and API-text normalization.
- Root package/env files own dependencies, scripts, and operator setup.

## Local Contracts

- Discord bot tokens, Grid API keys, channel IDs, and prompt env values are
  sensitive/operator configuration. Do not commit real values.
- RSS/news content is untrusted. Do not let feed content become system-level
  prompt instructions.
- The canonical Grid base is `https://api.aipowergrid.io/v1`; do not restore the
  retired `grid.aipowergrid.io` alias or Horde submit/poll flow.
- Generated news must not fabricate source attribution. Preserve article links
  and make AI enhancements clearly derived from fetched content.

## Work Guidance

- Keep prompt templates and README env docs synchronized.
- Add tests for feed parsing, prompt construction, polling intervals, and Grid
  error handling when changing bot behavior.

## Verification

- Use Node.js 20 or later.
- `npm test`
- `npm run smoke`
- `node --check index.js`

## Child DOX Index

- None - single-file runtime.
