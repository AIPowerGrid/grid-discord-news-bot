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

- Node.js (v14 or later)
- A Discord bot token
- An AI Power Grid API key

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

- `NEWS_CHECK_INTERVAL`: How often to check for news (in minutes)
- `POLL_TIMEOUT_TEXT_RESULTS`: Maximum time to wait for text generation results (in seconds)
- `POLL_TIMEOUT_IMAGE_RESULTS`: Maximum time to wait for image generation results (in seconds)
- `ENABLE_POLLS`: Set to "true" or "false" to enable/disable automatic poll creation

### Prompt Templates:

The `.env` file contains several prompt templates that you can customize:

- `NEWS_ENHANCEMENT_PROMPT`: Template for enhancing news content
- `IMAGE_PROMPT_TEMPLATE`: Template for generating images
- `LLM_ASSISTED_IMAGE_PROMPT_GENERATION`: Template for generating image prompts using LLM
- `POLL_CREATION_PROMPT`: Template for deciding whether to create polls and what options to include

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

### Prompt Engineering

You can customize how the AI generates content by editing the prompt templates in your `.env` file.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the Apache License 2.0 - see the LICENSE file for details.

## Acknowledgements

- [AI Power Grid](https://aipowergrid.io) for providing the AI text and image generation API
- [Discord.js](https://discord.js.org) for the Discord bot framework 
