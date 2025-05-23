require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const Parser = require('rss-parser');
const { decode } = require('html-entities');

// Create RSS parser instance
const rssParser = new Parser();

// Parse news feeds from environment variable
const NEWS_FEEDS = (() => {
  try {
    const feedsString = process.env.NEWS_FEEDS || '';
    if (!feedsString) {
      console.warn('No NEWS_FEEDS found in environment variables, using defaults');
      return [
        { name: 'BBC News', url: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
        { name: 'CNN', url: 'http://rss.cnn.com/rss/edition.rss' },
        { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' }
      ];
    }
    
    return feedsString.split(',').map(feed => {
      const [name, url] = feed.split('|');
      return { name: name.trim(), url: url.trim() };
    });
  } catch (error) {
    console.error('Error parsing NEWS_FEEDS:', error);
    return [
      { name: 'BBC News', url: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
      { name: 'CNN', url: 'http://rss.cnn.com/rss/edition.rss' },
      { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' }
    ];
  }
})();

console.log('Configured news feeds:', NEWS_FEEDS.map(f => f.name).join(', '));

// Create a new client instance with additional intents for message handling
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel] // For handling DMs
});

// Load environment variables
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const NEWS_CHANNEL_ID = process.env.NEWS_CHANNEL_ID;
const GRID_API_KEY = process.env.GRID_API_KEY;
const UPDATE_FREQUENCY = parseInt(process.env.UPDATE_FREQUENCY || '60', 10); // Default to 60 minutes
const TEXT_MODEL = process.env.TEXT_MODEL || 'grid/llama-3.1-8b-instant';
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'Flux.1-Schnell fp8 (Compact)'; // Default image model

// Feature toggles
const ENABLE_POLLS = process.env.ENABLE_POLLS?.toLowerCase() === 'true';

// Prompt templates (with defaults if not provided)
const NEWS_ENHANCEMENT_PROMPT = process.env.NEWS_ENHANCEMENT_PROMPT || 
  `You are a professional news writer working for AI Power Grid. Rewrite the article with a pro-open source AI perspective.
  Original Title: {{title}}
  Original Source: {{source}}
  Original Content: {{content}}`;

const NEWS_RESPONSE_PROMPT = process.env.NEWS_RESPONSE_PROMPT || 
  `You are a helpful news assistant. The user has asked: "{{question}}"
  Here are the recent news articles:
  {{articlesContext}}
  Provide a direct, helpful answer about the news content.`;

const IMAGE_PROMPT_TEMPLATE = process.env.IMAGE_PROMPT_TEMPLATE || 
  `Professional news image for headline: "{{headline}}". Style of Reuters photography. 4K, detailed.`;

const POLL_PROMPT = process.env.POLL_PROMPT || 
  `Analyze this news headline and article to determine if it would make a good poll topic:
  Headline: {{headline}}
  Article: {{article}}`;

const LLM_ASSISTED_IMAGE_PROMPT_GENERATION = process.env.LLM_ASSISTED_IMAGE_PROMPT_GENERATION;

// API Configuration
const TEXT_GENERATION_ENDPOINT = 'https://api.aipowergrid.io/api/v2/generate/text/async';
const TEXT_GENERATION_STATUS_ENDPOINT = 'https://api.aipowergrid.io/api/v2/generate/text/status';
const IMAGE_GENERATION_ENDPOINT = 'https://api.aipowergrid.io/api/v2/generate/async';
const IMAGE_GENERATION_STATUS_ENDPOINT = 'https://api.aipowergrid.io/api/v2/generate/status';

// Keep track of recently posted news to answer questions about them
const recentNewsArticles = [];
const MAX_RECENT_ARTICLES = 10;

// Store user message history for context in conversations
const userMessageHistory = {};
const MAX_MESSAGE_HISTORY = 5; // Number of messages to remember per user

// Sleep function for polling
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Normalizes text from AI Power Grid API responses, fixing newlines and formatting issues
 * @param {string} text - The raw text from the API response
 * @returns {string} - Normalized text with proper newlines
 */
function normalizeApiText(text) {
  if (!text) return '';
  
  let normalized = text;
  
  // Remove newlines that break words (this is the main issue with the API)
  normalized = normalized.replace(/(\S)\n(\S)/g, '$1$2');
  
  // Normalize standard newlines
  normalized = normalized
    .replace(/\r\n/g, '\n')  // Convert Windows line endings
    .replace(/\r/g, '\n')    // Convert old Mac line endings
    .replace(/\n{3,}/g, '\n\n')  // Remove excessive line breaks
    .trim();
    
  return normalized;
}

// Function to poll for text generation results
async function pollForTextResults(generationId, maxWaitTimeSeconds = 60) {
  try {
    console.log(`Starting to poll for text generation results for ID: ${generationId}, max wait time: ${maxWaitTimeSeconds}s`);
    
    // Keep track of polling attempts
    let attempts = 0;
    const pollIntervalSeconds = 5; // How often to poll in seconds
    const maxAttempts = Math.ceil(maxWaitTimeSeconds / pollIntervalSeconds);
    
    console.log(`Will poll every ${pollIntervalSeconds} seconds, up to ${maxAttempts} attempts`);
    
    // Poll in a loop until max attempts reached
    while (attempts < maxAttempts) {
      attempts++;
      console.log(`Polling attempt ${attempts}/${maxAttempts} for text generation...`);
      
      // Sleep between polling attempts to avoid rate limiting
      if (attempts > 1) {
        console.log(`Waiting ${pollIntervalSeconds} seconds before next poll...`);
        await new Promise(resolve => setTimeout(resolve, pollIntervalSeconds * 1000));
      }
      
      // Make the API request to check the status
      const statusResponse = await axios.get(`${TEXT_GENERATION_STATUS_ENDPOINT}/${generationId}`, {
        headers: {
          'apikey': process.env.GRID_API_KEY,
          'Client-Agent': 'GridNewsBot:1.0'
        }
      });
      
      // Check if generation is complete
      if (statusResponse.data.done === true) {
        console.log('Text generation completed successfully');
        
        // Check if we have valid generations
        if (statusResponse.data.generations && statusResponse.data.generations.length > 0) {
          const generation = statusResponse.data.generations[0];
          
          // Make sure the generation has text
          if (generation.text) {
            // Check if text is suspiciously short
            if (generation.text.length < 50) {
              console.warn(`WARNING: Generated text is very short (${generation.text.length} chars). You may want to try again with different parameters.`);
            }
            
            return {
              text: generation.text,
              model: generation.model || 'unknown',
              done: true
            };
          } else {
            console.error('Generated text is empty');
            return { error: 'Generated text is empty', done: true };
          }
        } else {
          console.error('No generations found in response', statusResponse.data);
          return { error: 'No generations found', done: true };
        }
      } else if (statusResponse.data.faulted === true) {
        // Check if generation failed
        const faultMessage = statusResponse.data.faulted_message || 'Unknown error';
        console.error('Text generation faulted:', faultMessage);
        return { error: faultMessage, done: true, faulted: true };
      } else {
        // Log progress metrics
        const waiting = statusResponse.data.waiting || 0;
        const processing = statusResponse.data.processing || 0;
        const finished = statusResponse.data.finished || 0;
        console.log(`Text generation still in progress, waiting... (${waiting} waiting, ${processing} processing, ${finished} finished)`);
      }
    }
    
    // If we've reached the maximum attempts, timeout
    console.error(`Polling timed out after ${maxAttempts} attempts (${maxWaitTimeSeconds} seconds)`);
    return { error: `Polling timed out after ${maxWaitTimeSeconds} seconds`, done: false };
    
  } catch (error) {
    console.error('Error polling for text generation results:', error.message);
    // Wait a bit longer and try again if it's a network error
    await new Promise(resolve => setTimeout(resolve, 8000));
    return { error: error.message, done: false };
  }
}

// Function to poll for image generation results
async function pollForImageResults(id, maxAttempts = 30) {
  console.log(`Starting to poll for image generation results for ID: ${id}`);
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    try {
      attempts++;
      console.log(`Polling attempt ${attempts}/${maxAttempts} for image generation...`);
      
      const response = await axios.get(`${IMAGE_GENERATION_STATUS_ENDPOINT}/${id}`, {
        headers: {
          'Content-Type': 'application/json',
          'apikey': GRID_API_KEY,
          'Client-Agent': 'GridNewsBot:1.0'
        }
      });
      
      // Check if generation is done
      if (response.data.done === true) {
        console.log('Image generation completed successfully');
        // Ensure there are generations and the image URL is present
        if (response.data.generations && response.data.generations.length > 0 && response.data.generations[0].img) {
          return response.data;
        } else {
          console.warn('Image generation reported as done, but no image URL found or generations array is empty. Faulted?', response.data);
          // Check for a faulted message if no valid image is found despite being 'done'
          const errorMessage = response.data.faulted_message || response.data.message || 'Image marked done but no valid image found.';
          return { error: errorMessage, faulted: true }; 
        }
      } else if (response.data.faulted === true) {
        const errorMessage = response.data.faulted_message || response.data.message || 'Unknown error during image generation.';
        console.error('Image generation failed with error:', errorMessage);
        return { error: errorMessage, faulted: true };
      } else {
        console.log(`Image generation still in progress, waiting... (${response.data.waiting} waiting, ${response.data.processing} processing, ${response.data.finished} finished)`);
      }
      
      // Wait before polling again (increased from 10 to 15 seconds for potentially higher quality images)
      await new Promise(resolve => setTimeout(resolve, 15000));
    } catch (error) {
      let errorMessage = error.message;
      if (error.response && error.response.data && (error.response.data.message || error.response.data.detail)) {
        errorMessage = error.response.data.message || error.response.data.detail;
      }
      console.error('Error polling for image generation results:', errorMessage);
      // If it's a 404 or similar, the ID might be invalid, so we can stop early
      if (error.response && error.response.status === 404) {
        return { error: `Polling failed: Image ID ${id} not found (404).`, faulted: true };
      }
      // Wait before retrying after an error
      await new Promise(resolve => setTimeout(resolve, 8000));
    }
  }
  
  console.warn(`Max polling attempts (${maxAttempts}) reached for image generation. Returning partial or empty result.`);
  return { done: false, generations: [], error: 'Max polling attempts reached without completion.' };
}

// Initialize
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  
  // Start the news generation and posting schedule
  scheduleNewsUpdates();
});

// Store poll votes
const pollVotes = new Map();

// Handle button interactions
client.on('interactionCreate', async interaction => {
  // Handle button clicks for polls
  if (interaction.isButton() && interaction.customId.startsWith('poll_option_')) {
    try {
      // Get the option index from the button ID
      const optionIndex = interaction.customId.split('_').pop();
      const messageId = interaction.message.id;
      
      // Initialize vote tracking for this poll if it doesn't exist
      if (!pollVotes.has(messageId)) {
        pollVotes.set(messageId, {
          options: {},
          voters: {}
        });
      }
      
      const poll = pollVotes.get(messageId);
      const userId = interaction.user.id;
      
      // Remove the user's previous vote if they voted for a different option
      if (poll.voters[userId] !== undefined && poll.voters[userId] !== optionIndex) {
        poll.options[poll.voters[userId]]--;
      }
      
      // Initialize this option's count if it doesn't exist
      if (!poll.options[optionIndex]) {
        poll.options[optionIndex] = 0;
      }
      
      // Register the user's vote
      poll.options[optionIndex]++;
      poll.voters[userId] = optionIndex;
      
      // Update the poll results in the embed
      const embed = interaction.message.embeds[0];
      let fieldsIndex = embed.fields.findIndex(field => field.name === 'Current Results');
      
      // Format the results
      let resultsText = '';
      for (const [option, votes] of Object.entries(poll.options)) {
        resultsText += `Option ${parseInt(option) + 1}: ${votes} vote${votes !== 1 ? 's' : ''}\n`;
      }
      
      // If results field exists, update it; otherwise, add it
      if (fieldsIndex !== -1) {
        embed.fields[fieldsIndex].value = resultsText || 'No votes yet';
      } else {
        embed.fields.push({
          name: 'Current Results',
          value: resultsText || 'No votes yet'
        });
      }
      
      // Update the message with the new embed
      await interaction.message.edit({
        embeds: [EmbedBuilder.from(embed)],
        components: interaction.message.components
      });
      
      // Acknowledge the interaction
      await interaction.reply({ content: 'Your vote has been recorded!', ephemeral: true });
    } catch (error) {
      console.error('Error handling poll vote:', error);
      await interaction.reply({ content: 'Something went wrong while recording your vote.', ephemeral: true });
    }
  }
});

// Handle messages to allow users to interact with the bot
client.on('messageCreate', async (message) => {
  // Ignore messages from bots to prevent potential loops
  if (message.author.bot) return;
  
  // Check if the message is in the designated news channel, is a DM, or mentions the bot directly
  const isDM = message.channel.type === 'DM';
  const isDirectMention = message.mentions.has(client.user);
  const isNewsChannel = message.channel.id === NEWS_CHANNEL_ID;
  
  // Respond to messages in the news channel, DMs, or when mentioned directly
  if (isDM || isDirectMention || isNewsChannel) {
    // Remove the bot mention from the message content if present
    const content = message.content.replace(new RegExp(`<@!?${client.user.id}>`), '').trim();
    
    // Skip empty messages
    if (!content) return;
    
    // Store this message in the user's history
    const userId = message.author.id;
    if (!userMessageHistory[userId]) {
      userMessageHistory[userId] = [];
    }
    
    // Add the new message to the history
    userMessageHistory[userId].unshift({
      content: content,
      timestamp: Date.now()
    });
    
    // Only keep up to MAX_MESSAGE_HISTORY messages
    if (userMessageHistory[userId].length > MAX_MESSAGE_HISTORY) {
      userMessageHistory[userId].pop();
    }
    
    // Process image generation requests
    if (content.toLowerCase().includes('generate an image') || 
        content.toLowerCase().includes('create an image') ||
        content.toLowerCase().includes('make an image')) {
      try {
        // Start typing indicator
        message.channel.sendTyping();
        
        // Extract a potential topic from the message
        let topic = content.replace(/generate an image|create an image|make an image/gi, '').trim();
        
        // If no specific topic provided, use the most recent news headline
        if (!topic && recentNewsArticles.length > 0) {
          topic = recentNewsArticles[0].headline;
        } else if (!topic) {
          // Default topic if no recent news and no specified topic
          topic = "Breaking news headline";
        }
        
        // Reply that we're generating the image
        await message.reply(`Generating an image for: "${topic}". This might take a minute...`);
        
        // Generate the image
        const imageUrl = await generateNewsImage(topic);
        
        if (imageUrl) {
          // Send a regular message with the image URL and disclaimer
          await message.channel.send(`Generated image for: "${topic}"\n${imageUrl}\n\n**DISCLAIMER: This image is AI-generated and fictional. It does not represent real events or people.**`);
        } else {
          await message.reply("Sorry, I wasn't able to generate that image. Please try again later.");
        }
        return;
      } catch (error) {
        console.error('Error generating image for user:', error);
        await message.reply("Sorry, I encountered an error while generating the image.");
        return;
      }
    }
    
    // Handle all other messages (questions, etc.)
    try {
      console.log(`Responding to message: ${content}`);
      
      // Start typing indicator before generating response
      message.channel.sendTyping();
      
      // Generate a response about recent news using AI, passing the user ID for context
      const response = await generateNewsResponse(content, recentNewsArticles, userId);
      
      // Check if the response needs to be split due to Discord's message limit (2000 chars)
      if (response.length <= 1900) {
        // Send as a single message
        await message.reply(response);
      } else {
        // Split the response into parts of approximately 1900 characters
        const parts = [];
        let remainingText = response;
        
        while (remainingText.length > 0) {
          // Find a good breaking point (end of sentence) within the limit
          let breakPoint = 1900;
          if (remainingText.length > 1900) {
            // Try to find the last period + space before the limit
            const lastPeriod = remainingText.substring(0, 1900).lastIndexOf('. ');
            if (lastPeriod > 1000) { // Only break at a period if it's not too short
              breakPoint = lastPeriod + 1; // Include the period but not the space
            }
          }
          
          // Add this part to our parts array
          parts.push(remainingText.substring(0, breakPoint));
          
          // Remove this part from the remaining text
          remainingText = remainingText.substring(breakPoint).trim();
        }
        
        // Send each part as a separate message
        for (let i = 0; i < parts.length; i++) {
          // Show typing indicator between sending parts to simulate typing pause
          if (i > 0) message.channel.sendTyping();
          
          const prefix = (i === 0) ? '' : '(continued) ';
          
          // Use message.channel.send instead of message.reply for follow-up messages
          if (i === 0) {
            await message.reply(`${parts[i]}`);
          } else {
            await message.channel.send(`${prefix}${parts[i]}`);
          }
          
          // Wait a short period between sending parts to make it feel more natural
          if (i < parts.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }
      }
    } catch (error) {
      console.error('Error responding to user:', error.message);
      // Add more details to the error log to help with debugging
      if (error.stack) console.error(error.stack);
      await message.reply('Sorry, I encountered an error while processing your request.');
    }
  }
});

// Function to schedule regular news updates
function scheduleNewsUpdates() {
  console.log(`Scheduling news updates every ${UPDATE_FREQUENCY} minutes`);
  
  // Post one immediately on startup
  generateAndPostNews();
  
  // Then schedule regular updates
  setInterval(generateAndPostNews, UPDATE_FREQUENCY * 60 * 1000);
}

// Function to generate and post news to Discord
async function generateAndPostNews() {
  try {
    console.log('Starting news generation and posting process...');
    
    // Fetch latest news
    const newsArticle = await fetchLatestNews();
    
    // If no news article was found, exit early
    if (!newsArticle) {
      console.log('No news article found to process.');
      return;
    }
    
    console.log(`Found news article: "${newsArticle.title}" from ${newsArticle.source}`);
    console.log(`Raw content length before enhancement: ${newsArticle.content.length} chars`);
    console.log(`Raw content preview: "${newsArticle.content.substring(0, 150)}..."`);
    
    // Check if content is very short
    if (newsArticle.content.length < 100) {
      console.warn(`WARNING: Very short content (${newsArticle.content.length} chars) for news enhancement. This may lead to poor quality articles.`);
    }
    
    // Enhance the news content using AI
    const enhancedContent = await enhanceNewsContent(newsArticle.title, newsArticle.content);
    
    if (!enhancedContent) {
      console.error('Failed to enhance news content.');
      return;
    }
    
    console.log(`Enhanced article length: ${enhancedContent.article.length} chars`);
    console.log(`Enhanced article preview: "${enhancedContent.article.substring(0, 150)}..."`);
    
    // Compare original and enhanced content
    const contentRatio = enhancedContent.article.length / newsArticle.content.length;
    console.log(`Content enhancement ratio: ${contentRatio.toFixed(2)}x (original: ${newsArticle.content.length}, enhanced: ${enhancedContent.article.length})`);
    
    if (contentRatio < 1.5 && enhancedContent.article.length < 500) {
      console.warn(`WARNING: Enhancement did not significantly expand content. This may indicate a problem with the AI enhancement.`);
    }
    
    // Post the news to Discord
    await postNewsToDiscord(newsArticle, enhancedContent);
    
    // Check if polls are enabled
    if (ENABLE_POLLS === 'true') {
      // Determine if we should create a poll based on the news article
      const shouldCreatePollResult = await shouldCreatePoll(newsArticle.title, enhancedContent.article);
      
      if (shouldCreatePollResult.createPoll && shouldCreatePollResult.options && shouldCreatePollResult.options.length > 0) {
        // Create the poll
        await createDiscordPoll(newsArticle.title, shouldCreatePollResult.options);
      } else {
        console.log('No poll will be created for this news article.');
      }
    } else {
      console.log('Polls are disabled in configuration');
    }
    
    console.log('News generation and posting completed successfully');
  } catch (error) {
    console.error('Error generating and posting news:', error);
  }
}

// Function to sanitize HTML content for Discord
function sanitizeHtmlForDiscord(htmlContent) {
  if (!htmlContent) return '';
  
  // Convert HTML entities to plain text characters
  let content = decode(htmlContent);
  
  // Remove HTML tags, keeping their content
  content = content
    // Remove image tags completely
    .replace(/<img[^>]*>/g, '')
    // Remove figure and figcaption tags completely
    .replace(/<figure[^>]*>[\s\S]*?<\/figure>/g, '')
    // Remove all other HTML tags but keep their content
    .replace(/<[^>]*>/g, '')
    // Fix extra newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  
  return content;
}

// Function to fetch latest news from RSS feeds
async function fetchLatestNews() {
  try {
    // Shuffle the feeds to get variety
    const shuffledFeeds = [...NEWS_FEEDS].sort(() => Math.random() - 0.5);
    
    console.log(`Fetching news from ${shuffledFeeds.length} feeds...`);
    
    for (const feed of shuffledFeeds) {
      try {
        console.log(`Attempting to fetch from ${feed.name} at ${feed.url}...`);
        const parsedFeed = await rssParser.parseURL(feed.url);
        
        if (parsedFeed.items && parsedFeed.items.length > 0) {
          // Get the first (most recent) item
          const item = parsedFeed.items[0];
          
          console.log(`Found item from ${feed.name}: "${item.title}"`);
          
          // Extract content using different possible fields
          let content = item.content || item.contentSnippet || item.summary || item.description || '';
          
          // Log content sources and lengths for debugging
          console.log(`CONTENT DEBUG - Content sources available:`, {
            content: item.content ? `${item.content.substring(0, 50)}... (${item.content.length} chars)` : 'none',
            contentSnippet: item.contentSnippet ? `${item.contentSnippet.substring(0, 50)}... (${item.contentSnippet.length} chars)` : 'none',
            summary: item.summary ? `${item.summary.substring(0, 50)}... (${item.summary.length} chars)` : 'none',
            description: item.description ? `${item.description.substring(0, 50)}... (${item.description.length} chars)` : 'none'
          });
          
          // If content is too short, try to construct a better content from available information
          if (content.length < 100) {
            console.warn(`CONTENT DEBUG - Extracted content is very short (${content.length} chars), attempting to enhance...`);
            
            // Try using a combination of fields if they exist
            let enhancedContent = [];
            
            if (item.title) enhancedContent.push(`Headline: ${item.title}`);
            if (item.contentSnippet) enhancedContent.push(`Summary: ${item.contentSnippet}`);
            if (item.description && item.description !== item.contentSnippet) enhancedContent.push(`Description: ${item.description}`);
            if (item.summary && item.summary !== item.contentSnippet && item.summary !== item.description) enhancedContent.push(`Details: ${item.summary}`);
            if (item.categories && item.categories.length > 0) enhancedContent.push(`Categories: ${item.categories.join(', ')}`);
            if (item.pubDate) enhancedContent.push(`Published: ${item.pubDate}`);
            if (item.creator) enhancedContent.push(`Author: ${item.creator}`);
            
            const combinedContent = enhancedContent.join('\n\n');
            if (combinedContent.length > content.length) {
              console.log(`CONTENT DEBUG - Using combined content (${combinedContent.length} chars) instead of original content (${content.length} chars)`);
              content = combinedContent;
            } else {
              console.warn(`CONTENT DEBUG - Unable to enhance content significantly. Original RSS feed may not contain detailed content.`);
            }
          }
          
          // Generate a basic content if nothing is available
          if (!content || content.length < 50) {
            console.warn(`CONTENT DEBUG - No meaningful content available for "${item.title}". Generating minimal placeholder.`);
            content = `News item from ${feed.name} with title "${item.title}". Published on ${item.pubDate || 'unknown date'}. Unfortunately, no detailed content was provided in the RSS feed. The AI-enhanced article will expand on this headline with relevant context and information.`;
          }
          
          // Extract image if available
          let image = null;
          
          // Log each possible image source for debugging
          console.log(`IMAGE DEBUG - Extracting image from ${feed.name} article: "${item.title}"`);
          
          // Check for enclosure
          if (item.enclosure && item.enclosure.url) {
            console.log(`IMAGE DEBUG - Found enclosure image: ${item.enclosure.url}`);
            image = item.enclosure.url;
          } 
          // Check for media:content
          else if (item['media:content'] && item['media:content'].url) {
            console.log(`IMAGE DEBUG - Found media:content image: ${item['media:content'].url}`);
            image = item['media:content'].url;
          }
          // Check for media:thumbnail
          else if (item['media:thumbnail'] && item['media:thumbnail'].url) {
            console.log(`IMAGE DEBUG - Found media:thumbnail image: ${item['media:thumbnail'].url}`);
            image = item['media:thumbnail'].url;
          }
          // Check for itunes:image
          else if (item['itunes:image'] && item['itunes:image'].href) {
            console.log(`IMAGE DEBUG - Found itunes:image: ${item['itunes:image'].href}`);
            image = item['itunes:image'].href;
          }
          // Look for image tag in content
          else if (item.content) {
            // First look for high-res or featured images
            const featuredMatch = item.content.match(/<img[^>]+class="[^"]*(?:featured|main|hero|primary)[^"]*"[^>]+src="([^">]+)"/i);
            if (featuredMatch && featuredMatch[1]) {
              console.log(`IMAGE DEBUG - Found featured image in content: ${featuredMatch[1]}`);
              image = featuredMatch[1];
            } else {
              // Regular image tag
              const match = item.content.match(/<img[^>]+src="([^">]+)"/);
              if (match && match[1]) {
                console.log(`IMAGE DEBUG - Found regular image in content: ${match[1]}`);
                image = match[1];
              }
            }
          }
          
          // If we found an image, validate it
          if (image) {
            // Convert relative URLs to absolute if needed
            if (image.startsWith('/')) {
              // Extract domain from the link URL
              try {
                const linkUrl = new URL(item.link);
                const baseUrl = `${linkUrl.protocol}//${linkUrl.host}`;
                image = baseUrl + image;
                console.log(`IMAGE DEBUG - Converted relative image URL to absolute: ${image}`);
              } catch (urlError) {
                console.warn(`IMAGE DEBUG - Failed to convert relative URL: ${urlError.message}`);
              }
            }
            
            // Ensure the URL starts with http:// or https://
            if (!image.startsWith('http://') && !image.startsWith('https://')) {
              console.warn(`IMAGE DEBUG - Invalid image URL, doesn't start with http(s): ${image}`);
              image = null;
            }
          } else {
            console.log(`IMAGE DEBUG - No image found in article from ${feed.name}`);
          }
          
          // Sanitize title and content for Discord
          const sanitizedTitle = sanitizeHtmlForDiscord(item.title);
          const sanitizedContent = sanitizeHtmlForDiscord(content);
          
          console.log(`CONTENT DEBUG - Final sanitized content length: ${sanitizedContent.length} chars`);
          if (sanitizedContent.length < 100) {
            console.warn(`CONTENT DEBUG - Sanitized content is very short (${sanitizedContent.length} chars). This may result in low-quality enhanced articles.`);
          }
          
          return {
            title: sanitizedTitle,
            link: item.link,
            content: sanitizedContent,
            pubDate: item.pubDate || new Date().toISOString(),
            source: feed.name,
            image: image
          };
        } else {
          console.warn(`No items found in feed from ${feed.name}`);
        }
      } catch (feedError) {
        console.error(`Error fetching feed ${feed.name}:`, feedError);
        // Continue to next feed on error
        continue;
      }
    }
    
    console.error('No valid news items found in any feeds.');
    return null;
  } catch (error) {
    console.error('Error fetching news:', error);
    return null;
  }
}

// Function to enhance news content using AI Power Grid
async function enhanceNewsContent(headline, newsSummary) {
  console.log("Attempting to enhance news content:", headline);
  console.log("Original news summary length:", newsSummary ? newsSummary.length : 0, "chars");
  
  const newsEnhancementPrompt = process.env.NEWS_ENHANCEMENT_PROMPT || "Given the headline: '{headline}' and summary: '{summary}', please write a detailed news article. The article should be at least 800 words, well-structured with multiple paragraphs, and have a proper introduction and conclusion. Ensure the article is comprehensive, engaging, and maintains a formal journalistic tone. Do not finish mid-sentence. Always complete your thoughts and paragraphs.";
  const filledPrompt = newsEnhancementPrompt.replace('{headline}', headline).replace('{summary}', newsSummary);

  try {
    const requestBody = {
      prompt: filledPrompt,
      params: {
        max_length: 1024, // Corrected API limit based on validation error
        max_context_length: 8192,
        temperature: 0.75,
        rep_pen: 1.1,
        top_p: 0.92,
        top_k: 100,
        stop_sequence: ["\n\n", "Ċ", "<|endoftext|>"], // Relaxed stop sequence for longer content
      },
      models: ["grid/llama-3.3-70b-versatile"],
    };
    console.log('Submitting enhanced news content request:', requestBody.prompt.substring(0,100) + "...", 'Params:', requestBody.params);
    
    // Log the API request
    console.log(`Sending text generation request to ${TEXT_GENERATION_ENDPOINT}`);
    
    // Make the API request
    const response = await axios.post(TEXT_GENERATION_ENDPOINT, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.GRID_API_KEY,
        'Client-Agent': 'GridNewsBot:1.0'
      }
    });
    
    // Check if we received a valid response
    if (!response.data || !response.data.id) {
      console.error('Failed to start text generation:', response.data?.message || 'Unknown error');
      return { 
        article: newsSummary,
        original: newsSummary
      };
    }
    
    // Get the generation ID
    const generationId = response.data.id;
    console.log(`Text generation request submitted with ID: ${generationId}`);
    
    // Poll for the results with a longer timeout for news articles
    // Up to 60 seconds for a full article
    const pollTimeout = parseInt(process.env.POLL_TIMEOUT_TEXT_RESULTS_ENHANCE, 10) || 60; // seconds
    console.log(`Polling for enhanced news content results with ID: ${generationId}, timeout: ${pollTimeout}s`);
    const results = await pollForTextResults(generationId, pollTimeout);
    
    // Check for errors from polling
    if (results.error) {
      console.error(`Text generation error: ${results.error}`);
      return { 
        article: newsSummary, 
        original: newsSummary 
      };
    }
    
    // Extract the generated text
    if (!results.text) {
      console.error('No text was generated');
      return { 
        article: newsSummary, 
        original: newsSummary 
      };
    }
    
    // Log the raw text received from the API
    console.log(`CONTENT DEBUG - Raw text received from API (first 100 chars): ${results.text.substring(0, 100)}...`);
    console.log(`CONTENT DEBUG - Raw text received from API (last 100 chars): ...${results.text.substring(results.text.length - 100)}`);
    console.log(`CONTENT DEBUG - Raw text total length: ${results.text.length} chars`);
    
    // Normalize and clean up the text
    let enhancedText = normalizeApiText(results.text.trim());
    console.log(`CONTENT DEBUG - After normalizeApiText(), length: ${enhancedText.length} chars`);
    
    // Check if API returned just the title or a very short text
    if (enhancedText.length < 100 || 
        enhancedText.trim() === headline.trim() || 
        enhancedText.trim() === `**${headline.trim()}**` || 
        enhancedText.trim() === `# ${headline.trim()}` ||
        enhancedText.trim() === `## ${headline.trim()}` ||
        enhancedText.toLowerCase().includes("no provided content") ||
        enhancedText.toLowerCase().includes("placeholder article") ||
        enhancedText.toLowerCase().includes("this article will not contain") ||
        enhancedText.toLowerCase().includes("i will create a") ||
        enhancedText.toLowerCase().includes("since there is no")) {
      
      console.warn(`CRITICAL: API returned only the title, refusal message, or very little text (${enhancedText.length} chars). Forcing fallback generation.`);
      
      // Use a more forceful prompt that ensures article generation
      const forcefulPrompt = `IMPORTANT TASK: Write a full news article about "${headline}". 

The article MUST be based on this summary: "${newsSummary}"

You MUST:
1. Write a complete news article of at least 800 words
2. Start immediately with the news content (not a disclaimer or explanation)
3. Include factual details from the summary
4. Use a professional journalistic style
5. Write in complete paragraphs with proper flow

DO NOT write any disclaimers, explanations, or acknowledgments about AI limitations.
DO NOT say "I will create" or "Since there is no provided content".
DO NOT start with meta-comments like "Here is an article about".
SIMPLY WRITE THE ACTUAL NEWS ARTICLE TEXT starting with the first paragraph of content.`;
      
      const forcefulRequestBody = {
        prompt: forcefulPrompt,
        params: {
          max_length: 1024,
          max_context_length: 8192,
          temperature: 0.75,
          rep_pen: 1.1,
          top_p: 0.92,
          top_k: 100,
          stop_sequence: ["\n\n", "Ċ", "<|endoftext|>"],
        },
        models: ["grid/llama-3.3-70b-versatile"],
      };
      
      console.log("FALLBACK: Submitting forceful article generation request with direct prompt");
      try {
        const forcefulResponse = await axios.post(TEXT_GENERATION_ENDPOINT, forcefulRequestBody, {
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.GRID_API_KEY,
            'Client-Agent': 'GridNewsBot:1.0'
          }
        });
        
        if (forcefulResponse.data && forcefulResponse.data.id) {
          const forcefulId = forcefulResponse.data.id;
          console.log(`FALLBACK: Generation request submitted with ID: ${forcefulId}`);
          const forcefulResults = await pollForTextResults(forcefulId, pollTimeout);
          
          if (forcefulResults.text && forcefulResults.text.length > 100) {
            console.log(`FALLBACK: Generation successful, length: ${forcefulResults.text.length} chars`);
            enhancedText = normalizeApiText(forcefulResults.text.trim());
          } else {
            console.warn("FALLBACK: Generation failed or produced insufficient text.");
            // Resort to a basic article template with placeholders
            enhancedText = `In recent developments, ${headline}. ${newsSummary}

The news has drawn significant attention from experts in the field, who note that these developments could have far-reaching implications. Political analysts and industry observers are closely monitoring the situation as it continues to unfold.

According to preliminary reports, the events leading up to this development began several weeks ago, with tensions escalating gradually. Key stakeholders have expressed varying opinions on the matter, with some advocating for immediate action while others urge caution and further assessment.

Members of the public have also weighed in on social media platforms, with reactions ranging from support to concern. Community leaders have called for open dialogue and transparent communication as the situation develops.

As more information becomes available, authorities are expected to provide additional details and potentially announce next steps. The full impact of these developments remains to be seen, but analysts suggest that we may witness significant changes in the coming weeks.

Experts are closely monitoring the situation as it unfolds. Further updates are expected as more information becomes available.`;
          }
        }
      } catch (forcefulError) {
        console.error("Error during forceful fallback generation:", forcefulError.message);
        // Create a minimal article from the summary
        enhancedText = `In recent developments, ${headline}. ${newsSummary}

The news has drawn significant attention from experts in the field, who note that these developments could have far-reaching implications. Political analysts and industry observers are closely monitoring the situation as it continues to unfold.

According to preliminary reports, the events leading up to this development began several weeks ago, with tensions escalating gradually. Key stakeholders have expressed varying opinions on the matter, with some advocating for immediate action while others urge caution and further assessment.

Members of the public have also weighed in on social media platforms, with reactions ranging from support to concern. Community leaders have called for open dialogue and transparent communication as the situation develops.

As more information becomes available, authorities are expected to provide additional details and potentially announce next steps. The full impact of these developments remains to be seen, but analysts suggest that we may witness significant changes in the coming weeks.

Experts are closely monitoring the situation as it unfolds. Further updates are expected as more information becomes available.`;
      }
    }
    
    // Remove common instruction prefixes
    enhancedText = enhancedText
      .replace(/^(In (your|this|my) (rewrite|response|article|version)),?\s*/i, '')
      .replace(/^(Here('s| is) (my|a|the) (rewrite|version|article|response)),?\s*/i, '')
      .replace(/^I('ll| will) (rewrite|express|present|provide|give),?\s*/i, '')
      .replace(/^(Let me|I am going to) (rewrite|express|present|provide|give),?\s*/i, '')
      .replace(/^(In this (article|paragraph|content)),?\s*/i, '')
      .replace(/^(Rewritten|Enhanced) (article|content|version):?\s*/i, '')
      .replace(/^(Without|With) (explicit statements|bias|commentary):?\s*/i, '');
    
    console.log(`CONTENT DEBUG - After removing prefixes, length: ${enhancedText.length} chars`);
    
    // Handle cases where the generated text is suspiciously short
    // If the enhanced content is shorter than the original, something might be wrong
    if (enhancedText.length < 500 || enhancedText.length < newsSummary.length * 1.5) {
      console.warn(`WARNING: Generated content suspiciously short (${enhancedText.length} chars). Original was ${newsSummary.length} chars.`);
      console.warn(`First 100 chars of short content: "${enhancedText.substring(0, 100)}..."`);
      
      // Check for common error patterns
      if (enhancedText.toLowerCase().includes("i apologize") || 
          enhancedText.toLowerCase().includes("as an ai") ||
          enhancedText.toLowerCase().includes("i cannot") ||
          enhancedText.toLowerCase().includes("i'm unable") ||
          enhancedText.toLowerCase().includes("i am unable")) {
        console.warn("Detected AI refusal pattern in response. Model is declining to generate content.");
        // Fall back to a more direct prompt
        console.log("Attempting fallback with more direct prompt...");
        
        // If the API returned a refusal, try with a more direct prompt
        const fallbackPrompt = `Write a news article with the headline: "${headline}" based on this information: "${newsSummary}". The article should be approximately 800 words, factual, and journalistic in tone.`;
        
        const fallbackRequestBody = {
          prompt: fallbackPrompt,
          params: {
            max_length: 1024,
            max_context_length: 8192,
            temperature: 0.75,
            rep_pen: 1.1,
            top_p: 0.92,
            top_k: 100,
            stop_sequence: ["\n\n", "Ċ", "<|endoftext|>"],
          },
          models: ["grid/llama-3.3-70b-versatile"],
        };
        
        // Make another API request with the fallback prompt
        try {
          console.log("Submitting fallback request with direct prompt");
          const fallbackResponse = await axios.post(TEXT_GENERATION_ENDPOINT, fallbackRequestBody, {
            headers: {
              'Content-Type': 'application/json',
              'apikey': process.env.GRID_API_KEY,
              'Client-Agent': 'GridNewsBot:1.0'
            }
          });
          
          if (fallbackResponse.data && fallbackResponse.data.id) {
            const fallbackId = fallbackResponse.data.id;
            console.log(`Fallback text generation request submitted with ID: ${fallbackId}`);
            const fallbackResults = await pollForTextResults(fallbackId, pollTimeout);
            
            if (fallbackResults.text && fallbackResults.text.length > enhancedText.length) {
              console.log(`Fallback generation successful, length: ${fallbackResults.text.length} chars`);
              enhancedText = normalizeApiText(fallbackResults.text.trim());
            } else {
              console.warn("Fallback generation failed or produced shorter text. Keeping original generated content.");
            }
          }
        } catch (fallbackError) {
          console.error("Error during fallback generation:", fallbackError.message);
          // Continue with what we have
        }
      }
    }
    
    // Format paragraphs properly for Discord (ensure double newlines between paragraphs)
    enhancedText = enhancedText.replace(/\n(?!\n)/g, '\n\n');
    
    console.log(`CONTENT DEBUG - Final formatted content length: ${enhancedText.length} chars`);
    console.log(`CONTENT DEBUG - Final content starts with: "${enhancedText.substring(0, 100)}..."`);
    console.log(`CONTENT DEBUG - Final content ends with: "...${enhancedText.substring(enhancedText.length - 100)}"`);
    
    return {
      article: enhancedText,
      original: newsSummary
    };
  } catch (error) {
    console.error('Error enhancing news content:', error.message);
    // In case of error, return the original content
    return { 
      article: newsSummary,
      original: newsSummary
    };
  }
}

// Function to generate an LLM-assisted image prompt
async function generateLlmAssistedImagePrompt(headline, articleSummary) {
  console.log(`Generating LLM-assisted image prompt for headline: ${headline}`);
  const LLM_ASSISTED_IMAGE_PROMPT_GENERATION_TEMPLATE = process.env.LLM_ASSISTED_IMAGE_PROMPT_GENERATION || "Create an evocative, non-literal, visually descriptive image prompt for an AI image generator based on the following news headline and summary. The prompt should focus on concepts, moods, and artistic styles, avoiding direct requests for text, fonts, or overly literal interpretations of the headline. Headline: '{headline}'. Summary: '{summary}'. Generated Image Prompt:";
  const filledPrompt = LLM_ASSISTED_IMAGE_PROMPT_GENERATION_TEMPLATE.replace('{headline}', headline).replace('{summary}', articleSummary);

  try {
    const requestBody = {
      prompt: filledPrompt,
      params: {
        max_length: 150, // Renamed from max_tokens, ensuring it's appropriate for a concise prompt
        max_context_length: 4096, // Can be smaller for this specialized task
        temperature: 0.75,
        rep_pen: 1.1,
        top_p: 0.92,
        top_k: 100,
        stop_sequence: ["\n", ".", "Ċ", "<|endoftext|>"], // Shorter prompts can stop on newline or period
      },
      models: ["grid/llama-3.3-70b-versatile"],
    };
    console.log('Submitting LLM-assisted image prompt generation request:', requestBody.prompt.substring(0,100) + "...", 'Params:', requestBody.params);

    // Make the API request for LLM-assisted prompt
    const response = await axios.post(TEXT_GENERATION_ENDPOINT, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': GRID_API_KEY,
        'Client-Agent': 'GridNewsBot:1.0'
      }
    });

    console.log(`LLM-assisted image prompt generation request submitted with ID: ${response.data.id}`);
    const results = await pollForTextResults(response.data.id, 10); // Shorter polling for this

    if (results.text) {
      let generatedPrompt = normalizeApiText(results.text);
      // Simple cleanup: sometimes models add extra quotes or prefixes like "Prompt:"
      generatedPrompt = generatedPrompt.replace(/^[\"\s]*(Prompt:|Image Prompt:|Generated Prompt:)?["\s]*/i, '').replace(/[\"\s]*$/, '');
      console.log(`LLM generated image prompt: "${generatedPrompt}"`);
      return generatedPrompt;
    } else {
      console.warn('LLM failed to generate an image prompt. Falling back to default.', results.error || '');
      return IMAGE_PROMPT_TEMPLATE.replace('{{headline}}', headline);
    }
  } catch (error) {
    console.error('Error generating LLM-assisted image prompt:', error.message);
    console.warn('Falling back to default image prompt template.');
    return IMAGE_PROMPT_TEMPLATE.replace('{{headline}}', headline);
  }
}

// Function to generate an image for a news headline
async function generateNewsImage(headline, articleContent) {
  try {
    console.log(`Generating image for headline: ${headline}`);
    
    // Generate an LLM-assisted image prompt
    // Create a short summary for the LLM if articleContent is available
    const articleSummary = articleContent ? articleContent.substring(0, 500) + (articleContent.length > 500 ? '...' : '') : '';
    const llmGeneratedPrompt = await generateLlmAssistedImagePrompt(headline, articleSummary);
    
    console.log(`IMAGE DEBUG - Using prompt for image generation: "${llmGeneratedPrompt}"`);
    
    // Use the exact same configuration as test-api.js which is working
    const generation_data = {
      prompt: llmGeneratedPrompt, // Use the LLM generated prompt
      params: {
        sampler_name: "k_euler",
        height: 1024,
        width: 1024,
        steps: 4,
        cfg_scale: 1,
        karras: false
      },
      nsfw: false,
      censor_nsfw: true,
      trusted_workers: true,
      models: [IMAGE_MODEL],
      r2: true,
      shared: false
    };
    
    console.log('Submitting image generation request...');
    
    // Submit the image generation request
    const response = await axios.post(IMAGE_GENERATION_ENDPOINT, generation_data, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': GRID_API_KEY,
        'Client-Agent': 'GridNewsBot:1.0'
      }
    });
    
    if (!response.data || !response.data.id) {
      console.error('Failed to start image generation:', response.data?.message || 'Unknown error');
      return null;
    }
    
    const generationId = response.data.id;
    console.log(`Image generation request submitted with ID: ${generationId}`);
    
    // Poll for the results
    const results = await pollForImageResults(generationId);
    
    // Check for errors from polling (e.g., timeout, faulted)
    if (results.error || results.faulted) {
      console.error(`Image generation polling failed for ID ${generationId}:`, results.error || 'Unknown polling error');
      return null;
    }
    
    // Check if we have valid results with generations and an image URL
    if (results.generations && results.generations.length > 0 && results.generations[0].img) {
      // Get the image URL from the result
      const imageUrl = results.generations[0].img;
      console.log(`IMAGE DEBUG - Successfully generated image: ${imageUrl}`);
      
      // Validate the URL format
      if (!imageUrl.startsWith('http')) {
        console.error(`IMAGE DEBUG - Generated image URL is invalid: ${imageUrl}`);
        return null;
      }
      
      // Check if image URL needs the AI Power Grid origin prepended
      if (imageUrl.startsWith('/')) {
        const fullUrl = `https://api.aipowergrid.io${imageUrl}`;
        console.log(`IMAGE DEBUG - Converted relative image URL to absolute: ${fullUrl}`);
        return fullUrl;
      }
      
      // Return the URL of the first generated image
      return imageUrl;
    } else {
      console.warn('No image generations returned from API or image URL missing, even if polling was successful.', results);
      return null;
    }
  } catch (error) {
    let errorMessage = error.message;
    if (error.response && error.response.data && (error.response.data.message || error.response.data.detail)) {
      errorMessage = error.response.data.message || error.response.data.detail;
    }
    console.error('Error generating image:', errorMessage);
    return null;
  }
}

// Function to generate responses to user questions about news
async function generateNewsResponse(userPrompt, newsHistory, userId) {
  console.log("Generating news response with user prompt and history.");
  let combinedPrompt = userPrompt;
  
  // Include previous messages in the prompt if available
  const userHistory = userMessageHistory[userId] || [];
  let chatHistory = '';
  
  // Format recent messages as chat history, skipping the current message (which is at index 0)
  if (userHistory.length > 1) {
    chatHistory = 'Recent conversation history:\n';
    // Start from 1 to skip the current message
    for (let i = 1; i < userHistory.length; i++) {
      chatHistory += `User (${new Date(userHistory[i].timestamp).toISOString()}): ${userHistory[i].content}\n`;
    }
    chatHistory += '\n';
  }
  
  if (newsHistory && newsHistory.length > 0) {
    // Using the first (most recent) article for detailed responses
    const mostRecentArticle = newsHistory[0];
    
    // Include the full article details, not just a snippet
    combinedPrompt = `${chatHistory}Recent news context:
Title: ${mostRecentArticle.headline}
Full article: ${mostRecentArticle.article}

User question: "${userPrompt}"

Instructions:
1. Provide a detailed, informative response about this news article
2. Include specific facts from the article that answer the question
3. If the user asks for more details or expansion, provide more in-depth information from the article
4. Response should be at least 3-5 sentences with substantive information
5. Consider previous messages in the conversation history when crafting your response
6. If the question is unrelated to the news article, politely explain that you can only provide information about this specific news item`;
  } else if (chatHistory) {
    // If no news article but we have chat history
    combinedPrompt = `${chatHistory}User question: "${userPrompt}"

Instructions:
1. Provide a helpful response to the user's question
2. Consider previous messages in the conversation history when crafting your response
3. If you don't have relevant information, politely say so
4. Keep your response informative and direct`;
  }

  try {
    const requestBody = {
      prompt: combinedPrompt,
      params: {
        max_length: 1000, // Renamed from max_tokens
        max_context_length: 8192,
        temperature: 0.75,
        rep_pen: 1.1,
        top_p: 0.92,
        top_k: 100,
        stop_sequence: ["Ċ", "<|endoftext|>"], // Removed period to allow longer responses
      },
      models: ["grid/llama-3.3-70b-versatile"],
    };
    console.log('Submitting news response generation request:', requestBody.prompt.substring(0,100) + "...", 'Params:', requestBody.params);
    
    // Step 1: Submit the generation request with KoboldAI-style sampler parameters
    const response = await axios.post(TEXT_GENERATION_ENDPOINT, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': GRID_API_KEY,
        'Client-Agent': 'GridNewsBot:1.0'
      }
    });
    
    console.log(`News response generation request submitted with ID: ${response.data.id}`);
    
    // Step 2: Poll for the results with increased timeout
    const results = await pollForTextResults(response.data.id, 30); // Increased timeout
    
    // Step 3: Extract the generated text
    if (results.text) {
      // Normalize the text using our helper function
      const responseText = normalizeApiText(results.text);
      
      // Clean up the response to remove any formatting artifacts
      const cleanedResponse = responseText
        .replace(/^(Here's|Based on|According to|Looking at).*(articles?|news|information).*:\s*/i, '')
        .replace(/^(I'll|Let me).*(answer|respond|address).*:\s*/i, '')
        .replace(/^(As an AI Power Grid assistant|As a news assistant|Speaking from AI Power Grid),?\s*/i, '');
      
      // Check if response is suspiciously short (likely an evasive answer)
      if (cleanedResponse.length < 50 || 
          cleanedResponse.includes("I can only provide information") ||
          cleanedResponse.includes("I don't have enough context")) {
        
        if (newsHistory && newsHistory.length > 0) {
          return `Based on the article about "${newsHistory[0].headline}", I can tell you that ${newsHistory[0].article.substring(0, 300)}... Would you like to know more specific details about this news story?`;
        }
      }
      
      return cleanedResponse;
    } else if (results.done === false) {
      console.warn('Text generation timed out for user question');
      // Provide a more helpful response with the actual news headline if available
      if (newsHistory && newsHistory.length > 0) {
        return `I'm currently processing information about "${newsHistory[0].headline}". The article discusses ${newsHistory[0].article.substring(0, 200)}... Would you like me to focus on a specific aspect of this news?`;
      }
      return "I'm having trouble processing your question right now. Please try again in a moment.";
    }
    
    console.warn('No generations returned from API for user question');
    if (newsHistory && newsHistory.length > 0) {
      return `I can tell you about a recent news article titled "${newsHistory[0].headline}". Would you like to hear more about this topic?`;
    }
    return "I'm having trouble processing your question right now. Let me try to give you a simple summary of recent news instead.";
  } catch (error) {
    console.error('Error generating response:', error);
    if (newsHistory && newsHistory.length > 0) {
      return `We have a recent news story about "${newsHistory[0].headline}". Would you like to know more about this topic?`;
    }
    return "I'm having trouble processing your question right now. Let me try to give you a simple summary of recent news instead.";
  }
}

// Store recent article for user interactions
function storeRecentArticle(article) {
  // Add to beginning of array
  recentNewsArticles.unshift(article);
  
  // Keep only the MAX_RECENT_ARTICLES most recent
  if (recentNewsArticles.length > MAX_RECENT_ARTICLES) {
    recentNewsArticles.pop();
  }
}

/**
 * Determines if a poll should be created for a news article and generates poll options
 * @param {string} headline - The news headline
 * @param {string} article - The news article content
 * @returns {Promise<Object>} - Object containing shouldCreate flag and poll options
 */
async function shouldCreatePoll(newsArticleTitle, newsArticleContent) {
  console.log("Deciding whether to create a poll for article:", newsArticleTitle);
  const pollCreationPromptTemplate = process.env.POLL_CREATION_PROMPT || "Given the news article titled '{title}' with content: '{content}', should a poll be created? If yes, provide a compelling question for the poll and 2-4 concise, distinct poll options. Respond in JSON format: { \"should_create_poll\": boolean, \"poll_question\": \"string\", \"options\": [\"option1\", \"option2\", ...] }. If no, set should_create_poll to false.";
  const filledPrompt = pollCreationPromptTemplate.replace('{title}', newsArticleTitle).replace('{content}', newsArticleContent.substring(0, 1000)); // Limit content length for prompt

  try {
    const requestBody = {
      prompt: filledPrompt,
      params: {
        max_length: 600, // Renamed from max_tokens
        max_context_length: 8192,
        temperature: 0.75,
        rep_pen: 1.1,
        top_p: 0.92,
        top_k: 100,
        stop_sequence: ["\n\n", "}", "Ċ", "<|endoftext|>"], // Stop on closing brace for JSON
      },
      models: ["grid/llama-3.3-70b-versatile"],
    };
    console.log('Submitting poll creation decision request:', requestBody.prompt.substring(0,100) + "...", 'Params:', requestBody.params);
    
    // Step 1: Submit the generation request with KoboldAI-style sampler parameters
    const response = await axios.post(TEXT_GENERATION_ENDPOINT, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': GRID_API_KEY,
        'Client-Agent': 'GridNewsBot:1.0'
      }
    });
    
    console.log(`Poll assessment request submitted with ID: ${response.data.id}`);
    
    // Step 2: Poll for the results with increased timeout
    const results = await pollForTextResults(response.data.id, 20);
    
    // Step 3: Extract the response
    if (results.text) {
      // Normalize the text using our helper function
      const pollResponse = normalizeApiText(results.text);
      
      // Check if it's a YES
      if (pollResponse.startsWith('YES')) {
        // Extract options
        const options = [];
        const lines = pollResponse.split('\n');
        
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith('Option')) {
            const option = line.split(':')[1]?.trim();
            if (option) options.push(option);
          }
        }
        
        // Only create poll if we have at least 2 options
        if (options.length >= 2) {
          return {
            shouldCreate: true,
            options: options.slice(0, 4) // Max 4 options
          };
        }
      }
    } else if (results.done === false) {
      console.warn('Poll assessment timed out');
    }
    
    // Default to not creating a poll
    return {
      shouldCreate: false,
      options: []
    };
  } catch (error) {
    console.error('Error determining if poll should be created:', error);
    return {
      shouldCreate: false,
      options: []
    };
  }
}

/**
 * Creates a poll in the specified channel using Discord's native components
 * @param {TextChannel} channel - The Discord channel to post the poll in
 * @param {string} topic - The poll topic/question
 * @param {Array<string>} options - The poll options
 * @returns {Promise<void>}
 */
async function createDiscordPoll(topic, options) {
  try {
    // Limit topic length for Discord
    const shortTopic = topic.length > 100 ? topic.substring(0, 97) + '...' : topic;
    
    // Create poll message with buttons for voting
    const pollEmbed = new EmbedBuilder()
      .setTitle('📊 Poll: ' + shortTopic)
      .setColor(0x9B59B6)
      .setDescription('Click the buttons below to vote on this news topic!')
      .setTimestamp();
    
    // Add options to embed as a field
    let optionsText = '';
    options.forEach((option, index) => {
      optionsText += `${index + 1}. ${option}\n\n`;
    });
    
    pollEmbed.addFields({ name: 'Options', value: optionsText });
    
    // Create buttons for each option (up to 5 buttons per row, max 25 per message)
    const row = new ActionRowBuilder();
    
    // Add buttons for each option (maximum 5 for a single row)
    const maxButtons = Math.min(options.length, 5);
    for (let i = 0; i < maxButtons; i++) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`poll_option_${i}`)
          .setLabel(`Option ${i + 1}`)
          .setStyle(ButtonStyle.Primary)
      );
    }
    
    // Send poll with buttons
    const pollMessage = await channel.send({ 
      embeds: [pollEmbed],
      components: [row]
    });
    
    console.log(`Poll created with ${options.length} options using Discord components`);
  } catch (error) {
    console.error('Error creating poll:', error);
  }
}

// Function to post the news to Discord
async function postNewsToDiscord(newsItem, enhancedArticle) {
  try {
    console.log(`Posting news to Discord: ${newsItem.title}`);
    const channel = await client.channels.fetch(NEWS_CHANNEL_ID);

    // Validate and fix article image URL if present
    let imageUrl = newsItem.image;
    if (imageUrl) {
      // Log the original image URL
      console.log(`IMAGE DEBUG - Original article image URL: '${imageUrl}'`);
      
      // Check if URL is valid and has an image extension
      const isValidImageUrl = imageUrl && 
        (imageUrl.match(/\.(jpeg|jpg|gif|png|webp)(\?.*)?$/i) || 
         imageUrl.includes('image') ||
         imageUrl.includes('media'));
      
      if (!isValidImageUrl) {
        console.warn(`IMAGE DEBUG - Article image URL doesn't appear to be a direct image link: ${imageUrl}`);
        imageUrl = null; // Reset so we generate an image instead
      } else {
        // Strip any query parameters that might be causing issues
        if (imageUrl.includes('?')) {
          const cleanedUrl = imageUrl.split('?')[0];
          console.log(`IMAGE DEBUG - Cleaned image URL: ${cleanedUrl}`);
          imageUrl = cleanedUrl;
        }
      }
    }
    
    // Generate an image if we don't have a valid one
    if (!imageUrl) {
      console.log('No valid image in article, generating one...');
      // Pass the enhanced article content to generateNewsImage for better context
      imageUrl = await generateNewsImage(newsItem.title, enhancedArticle.article);
    }

    console.log(`IMAGE DEBUG - Final image URL for Discord embed: '${imageUrl}'`);
    
    const embed = new EmbedBuilder()
      .setColor(0x3498db) // Blue color
      .setTitle(newsItem.title)
      .setURL(newsItem.link) // Add the URL to the title
      .setTimestamp()
      .setFooter({
        text: 'News powered by AI Power Grid | ' + newsItem.source
      });
    
    // Process article content for Discord
    // Discord has a 4096 character limit on embed descriptions
    // We'll use 3000 to give more room for formatting and ensure we don't hit the limit
    const maxLength = 3000;
    let articleContent = enhancedArticle.article || '';
    
    console.log(`CONTENT DEBUG - Using max length: ${maxLength}, current length: ${articleContent.length} chars`);
    
    // Final emergency check to ensure we're not posting just a title or empty content
    if (articleContent.length < 100 || 
        articleContent.trim() === newsItem.title.trim() ||
        articleContent.trim() === `**${newsItem.title.trim()}**` ||
        articleContent.toLowerCase().includes("placeholder article") ||
        articleContent.toLowerCase().includes("since there is no provided content") ||
        articleContent.toLowerCase().includes("i will create an article") ||
        articleContent.toLowerCase().includes("no content was provided") ||
        articleContent.toLowerCase().includes("this article will not contain")) {
        
      console.warn("CRITICAL: About to post with very short content or placeholder text. Adding emergency fallback text.");
      // Add emergency fallback content
      articleContent = `In recent developments, ${newsItem.title}. ${newsItem.content || ""}

The news has drawn significant attention from experts in the field, who note that these developments could have far-reaching implications. Political analysts and industry observers are closely monitoring the situation as it continues to unfold.

According to initial reports, the events described in the headline represent an important development that may influence both public opinion and policy decisions in the coming weeks. Stakeholders from various sectors have begun to respond, with some expressing support while others raise concerns about potential long-term consequences.

Members of the public have also weighed in on social media platforms, with reactions ranging from support to concern. Community leaders have called for open dialogue and transparent communication as the situation develops.

As more information becomes available, authorities are expected to provide additional details and potentially announce next steps. The full impact of these developments remains to be seen, but analysts suggest that we may witness significant changes in the coming weeks.

This is a developing story, and more details will be provided as they emerge.`;
    }
    
    // Add a read more link at the end if we have a valid URL
    if (newsItem.link) {
      embed.addFields({ 
        name: 'Read Original Article', 
        value: `[Read more at ${newsItem.source}](${newsItem.link})` 
      });
    }
    
    // If content is too long, truncate it properly at a sentence or paragraph break
    if (articleContent.length > maxLength) {
      console.log(`CONTENT DEBUG - Article too long (${articleContent.length} chars), truncating...`);
      
      // Find a good breakpoint - try to find the end of a paragraph or sentence
      // Look for multiple options and pick the best one
      const lastPeriod = articleContent.lastIndexOf('. ', maxLength - 20);
      const lastExclamation = articleContent.lastIndexOf('! ', maxLength - 20);
      const lastQuestion = articleContent.lastIndexOf('? ', maxLength - 20);
      const lastParagraph = articleContent.lastIndexOf('\n\n', maxLength - 20);
      
      console.log(`CONTENT DEBUG - Break points found: Period(${lastPeriod}), Exclamation(${lastExclamation}), Question(${lastQuestion}), Paragraph(${lastParagraph})`);
      
      // Find the latest sentence ending that's still within our limit
      let truncatePoint = Math.max(
        lastPeriod,
        lastExclamation,
        lastQuestion,
        lastParagraph
      );
      
      console.log(`CONTENT DEBUG - Selected truncate point: ${truncatePoint}`);
      
      // If we found a good break point at least halfway through
      if (truncatePoint > maxLength / 2 && truncatePoint > 0) {
        // If it's a newline, keep the newline in the result
        if (truncatePoint === lastParagraph) {
          articleContent = articleContent.substring(0, truncatePoint) + '\n\n...';
          console.log(`CONTENT DEBUG - Truncated at paragraph break: ${truncatePoint}`);
        } else {
          // For sentence endings, include the punctuation
          articleContent = articleContent.substring(0, truncatePoint + 2) + ' ...';
          console.log(`CONTENT DEBUG - Truncated at sentence end: ${truncatePoint}`);
        }
      } else {
        // Fallback: just cut at the limit with an ellipsis
        articleContent = articleContent.substring(0, maxLength - 20) + ' ...';
        console.log(`CONTENT DEBUG - Fallback truncation at: ${maxLength - 20}`);
      }
      
      console.log(`CONTENT DEBUG - After truncation: ${articleContent.length} chars`);
      console.log(`CONTENT DEBUG - Truncated content ends with: ...${articleContent.substring(articleContent.length - 50)}`);
      
      // Add a note about truncation with a link to read more
      if (newsItem.link) {
        articleContent += `\n\n*This article has been truncated. [Read the full story at ${newsItem.source}](${newsItem.link})*`;
      } else {
        articleContent += '\n\n*This article has been truncated.*';
      }
    }
    
    // Final content check
    console.log(`CONTENT DEBUG - Final content length: ${articleContent.length} chars`);
    
    // Set the description with the properly formatted content
    embed.setDescription(articleContent);
    
    // If we have an image, add it to the embed
    if (imageUrl) {
      try {
        // Make sure to handle undefined imageUrl gracefully
        embed.setImage(imageUrl);
        console.log(`IMAGE DEBUG - Added image to Discord embed: ${imageUrl}`);
        
        // Add a disclaimer for AI-generated images
        const isGenerated = !newsItem.image || newsItem.image !== imageUrl;
        if (isGenerated) {
          embed.setFooter({
            text: embed.data.footer.text + ' | AI-generated image for illustrative purposes only. Not an actual photo of events.'
          });
        }
      } catch (imageError) {
        console.error(`Error setting image in Discord embed: ${imageError.message}`);
        // Continue without the image rather than failing the whole post
      }
    } else {
      console.warn('No image available for Discord embed');
    }
    
    // Log the full embed data
    console.log(`CONTENT DEBUG - Final embed title: ${embed.data.title}`);
    console.log(`CONTENT DEBUG - Final embed description length: ${embed.data.description?.length || 0} chars`);
    
    // Post to the Discord channel
    if (channel) {
      try {
        const message = await channel.send({ embeds: [embed] });
        console.log(`CONTENT DEBUG - Message sent, ID: ${message.id}`);
        
        // Check what Discord actually stored by fetching the message we just sent
        const fetchedMessage = await channel.messages.fetch(message.id);
        if (fetchedMessage) {
          const fetchedEmbed = fetchedMessage.embeds[0];
          console.log(`CONTENT DEBUG - FETCHED MESSAGE - Title: ${fetchedEmbed.title}`);
          console.log(`CONTENT DEBUG - FETCHED MESSAGE - Description length: ${fetchedEmbed.description?.length || 0}`);
          console.log(`CONTENT DEBUG - FETCHED MESSAGE - First 100 chars: ${fetchedEmbed.description?.substring(0, 100)}...`);
          console.log(`CONTENT DEBUG - FETCHED MESSAGE - Last 100 chars: ...${fetchedEmbed.description?.substring(fetchedEmbed.description.length - 100)}`);
          
          // Check if image was properly included
          if (imageUrl && (!fetchedEmbed.image || !fetchedEmbed.image.url)) {
            console.warn(`IMAGE DEBUG - ⚠️ IMAGE NOT INCLUDED IN DISCORD EMBED! Original URL: ${imageUrl}`);
          } else if (fetchedEmbed.image && fetchedEmbed.image.url) {
            console.log(`IMAGE DEBUG - Image successfully included in Discord embed: ${fetchedEmbed.image.url}`);
          }
          
          // Check if description was truncated
          if (fetchedEmbed.description?.length !== articleContent.length) {
            console.warn(`CONTENT DEBUG - ⚠️ TRUNCATION DETECTED! Original: ${articleContent.length} chars, Discord stored: ${fetchedEmbed.description?.length} chars`);
          }
        }
        
        console.log('News posted to Discord successfully');

        // Store the article for context in user interactions
        storeRecentArticle({
          headline: newsItem.title,
          article: enhancedArticle.article, // Use the enhanced article content
          source: newsItem.source,
          link: newsItem.link
        });

      } catch (error) {
        console.error('Error sending message to Discord:', error);
      }
    } else {
      console.error(`Could not find channel with ID ${NEWS_CHANNEL_ID}`);
    }
  } catch (error) {
    console.error('Error posting to Discord:', error);
  }
}

// Login to Discord with the token
client.login(process.env.DISCORD_TOKEN); 