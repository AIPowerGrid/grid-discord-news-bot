# grid-discord-news-bot - DOX root

## Purpose

Discord news bot that reads RSS feeds, summarizes/enhances news through AI Power
Grid, optionally generates images, posts to Discord, and answers user questions
about recent articles.

## Ownership

- `index.js` - bot runtime, RSS polling, prompt templates, Grid calls, Discord
  posting, and user interaction behavior.
- Root package/env files own dependencies, scripts, and operator setup.

## Local Contracts

- Discord bot tokens, Grid API keys, channel IDs, and prompt env values are
  sensitive/operator configuration. Do not commit real values.
- RSS/news content is untrusted. Do not let feed content become system-level
  prompt instructions.
- Generated news must not fabricate source attribution. Preserve article links
  and make AI enhancements clearly derived from fetched content.

## Work Guidance

- Keep prompt templates and README env docs synchronized.
- Add tests for feed parsing, prompt construction, polling intervals, and Grid
  error handling when changing bot behavior.

## Verification

- `npm test`
- `npm run smoke`
- `node --check index.js`

## Child DOX Index

- None - single-file runtime.

