# Discord News Bot (Powered by the Grid)

A Discord bot that automatically generates and posts real news updates using AI Power Grid for text and image generation. The bot fetches news from RSS feeds, enhances the content with AI, and allows users to interact with it to learn more about recent news.

## Features

- **Automated News Posting**: Regularly checks RSS feeds and posts enhanced news to a Discord channel
- **AI-Enhanced Content**: Uses AI Power Grid to expand news summaries into more detailed content
- **AI-Generated Images**: Generates relevant images for news stories when none are available
- **Interactive Responses**: Users can ask questions about the news and get AI-generated responses
- **Polling System**: Can automatically create polls related to news articles
- **Typing Indicators**: Shows typing indicators while generating responses for a more interactive experience

## Prerequisites

- Node.js 20 or later
- A Discord bot token
- An AI Power Grid API key from
  [the developer console](https://console.aipowergrid.io/dashboard/api-key)

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/AIPowerGrid/grid-discord-news-bot.git
   cd grid-discord-news-bot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up your environment variables:
   ```bash
   cp .env.template .env
   ```
   Then edit the `.env` file with your Discord token, channel ID, and AI Power Grid API key.

## Configuration

### Required Environment Variables:

- `DISCORD_TOKEN`: Your Discord bot token
- `NEWS_CHANNEL_ID`: The Discord channel ID where news will be posted
- `GRID_API_KEY`: Your AI Power Grid API key

### Optional Environment Variables:

- `GRID_API_BASE`: Canonical Grid v1 base (default `https://api.aipowergrid.io/v1`)
- `TEXT_MODEL`: Text model name; verify current availability with `/v1/models`
- `IMAGE_MODEL`: Image model name; verify current availability with `/v1/status/models`
- `UPDATE_FREQUENCY`: How often to check for news, in minutes
- `MAX_CANDIDATES`: Maximum recent feed items considered per run
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error`
- `DB_PATH`: SQLite state path
- `NEWS_FEEDS`: Comma-separated `name|url` feed list

Editorial safety prompts are source-controlled in `index.js`; the environment
does not override them. Feed content is untrusted and summaries must stay
grounded in the source text.

## Usage

Start the bot with:

```bash
node index.js
```

### User Interaction

- Users can ask the bot questions about recent news articles
- The bot will respond with information from the most recent articles it has posted
- Users can request image generation with phrases like "generate an image of [topic]"

## Customization

### RSS Feeds

Edit the `NEWS_FEEDS` array in `index.js` to add or remove news sources.

### Editorial behavior

Change the source-controlled prompt only with tests/review. Preserve source
links and the label on AI-generated illustrative images.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the Apache License 2.0 - see the LICENSE file for details.

## Acknowledgements

- [AI Power Grid](https://aipowergrid.io) for providing the AI text and image generation API
- [Discord.js](https://discord.js.org) for the Discord bot framework 
