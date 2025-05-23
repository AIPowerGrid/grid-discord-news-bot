require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
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
const FALLBACK_TEXT_MODEL = process.env.FALLBACK_TEXT_MODEL || TEXT_MODEL; // Default to same as TEXT_MODEL
const FALLBACK_IMAGE_MODEL = process.env.FALLBACK_IMAGE_MODEL || IMAGE_MODEL; // Default to same as IMAGE_MODEL

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
const GRID_API_URL = 'https://api.aipowergrid.io/api/v2';

// Keep track of recently posted news to answer questions about them
const recentNewsArticles = [];
const MAX_RECENT_ARTICLES = 10;

// Store user message history for context in conversations
const userMessageHistory = {};
const MAX_MESSAGE_HISTORY = 5; // Number of messages to remember per user

// Keep track of posted article URLs to avoid duplicates
const postedArticleUrls = new Set();
const MAX_POSTED_URLS = 100; // Limit the size to prevent memory leaks

// Track the last index used for each feed to cycle through stories
const feedIndexTracker = {};

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
          // Extract the image ID from the URL for a permanent link
          const tempImageUrl = response.data.generations[0].img;
          console.log('Temporary image URL:', tempImageUrl);
          
          // Extract image ID from the URL or response
          let imageId = null;
          
          // Try to extract from the response data first (most reliable)
          if (response.data.id) {
            imageId = response.data.id;
            console.log(`Found image ID from response.data.id: ${imageId}`);
          } 
          // If that fails, try to extract it from the URL
          else if (tempImageUrl) {
            // Try to parse the image ID from the URL
            const urlParts = tempImageUrl.split('/');
            const lastPart = urlParts[urlParts.length - 1];
            
            // Extract image ID before any query parameters
            if (lastPart && lastPart.includes('?')) {
              imageId = lastPart.split('?')[0];
              console.log(`Extracted image ID from URL: ${imageId}`);
            } else if (lastPart) {
              imageId = lastPart;
              console.log(`Using last URL part as image ID: ${imageId}`);
            }
          }
          
          // Create permanent URL if we have an image ID
          if (imageId) {
            // Check if it ends with .webp, if not add it
            if (!imageId.endsWith('.webp')) {
              imageId = `${imageId}.webp`;
            }
            
            // Create the permanent URL
            const permanentUrl = `https://images.aipg.art/${imageId}`;
            console.log(`Created permanent image URL: ${permanentUrl}`);
            
            // Return the response with our permanent URL replacing the temporary one
            response.data.generations[0].permanent_img = permanentUrl;
            return response.data;
          } else {
            console.warn('Unable to extract image ID for permanent URL');
            return response.data;
          }
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
      console.error(`Error polling for image generation (attempt ${attempts}/${maxAttempts}):`, errorMessage);
      
      // If we've had several failed attempts, wait longer before the next try
      if (attempts > 3) {
        await new Promise(resolve => setTimeout(resolve, 20000));
      } else {
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }
  
  console.error(`Polling for image generation timed out after ${maxAttempts} attempts`);
  return { error: 'Polling timed out', done: false };
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
    console.log('Starting news update process...');
    
    // Fetch latest news from feeds
    const newsItem = await fetchLatestNews();
    
    if (!newsItem) {
      console.error('No news items found or all have been posted already.');
      return;
    }
    
    console.log(`Processing news item: "${newsItem.title}" from ${newsItem.source}`);
    
    // Check if content is minimal
    const contentLength = newsItem.content ? newsItem.content.length : 0;
    const isMinimalContent = contentLength < 100 || 
      (!newsItem.content) || 
      (newsItem.title && newsItem.content === newsItem.title);
    
    // Enhance content only if we have substantial content
    let enhancedContent;
    if (isMinimalContent) {
      console.log(`Using original content for minimal article (${contentLength} chars): "${newsItem.title}"`);
      enhancedContent = newsItem.content || newsItem.title;
    } else {
      console.log(`Attempting to enhance content (${contentLength} chars) for: "${newsItem.title}"`);
      // Enhance content with AI
      try {
        enhancedContent = await enhanceNewsContent(newsItem);
        console.log(`Enhanced content received (${enhancedContent ? enhancedContent.length : 0} chars)...`);
      } catch (enhanceError) {
        console.error('Error during content enhancement:', enhanceError);
        enhancedContent = newsItem.content;
        console.log('Falling back to original content due to enhancement error');
      }
    }
    
    // If enhancement failed or returned nothing, use original content
    if (!enhancedContent) {
      console.warn('No enhanced content returned, using original content');
      enhancedContent = newsItem.content || newsItem.title;
    }
    
    // Post the news to Discord
    await postNewsToDiscord(newsItem.title, enhancedContent, newsItem.link, newsItem.source, newsItem.pubDate, newsItem.image);
    
    console.log('News update process completed successfully.');
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
          // Initialize the index tracker for this feed if not exists
          if (!feedIndexTracker[feed.url]) {
            feedIndexTracker[feed.url] = 0;
          }
          
          // Get the next index to use for this feed (cycling through available items)
          let currentIndex = feedIndexTracker[feed.url];
          let itemsChecked = 0;
          
          // Loop through up to 10 items in the feed to find a new article
          while (itemsChecked < Math.min(10, parsedFeed.items.length)) {
            // Get the next item (cycling through the available ones)
            const item = parsedFeed.items[currentIndex];
            
            // Increment checked count
            itemsChecked++;
            
            // Check if this article URL has already been posted
            if (item.link && !postedArticleUrls.has(item.link)) {
              console.log(`Found new item from ${feed.name}: "${item.title}"`);
              
              // Extract content using different possible fields
              let content = item.content || item.contentSnippet || item.summary || item.description || '';
              
              // Print the full item structure for debugging
              console.log('FULL ITEM DEBUG - Keys:', Object.keys(item));
              
              // If item has HTML content, try to extract plain text
              if (typeof content === 'string' && (content.includes('<') && content.includes('>'))) {
                try {
                  const plainText = content
                    .replace(/<p[^>]*>/gi, '\n\n')
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<div[^>]*>/gi, '\n')
                    .replace(/<\/div>/gi, '')
                    .replace(/<\/p>/gi, '')
                    .replace(/<li[^>]*>/gi, '\n• ')
                    .replace(/<\/li>/gi, '')
                    .replace(/<[^>]*>/g, '')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
                    
                  if (plainText.length > content.length / 2) { // Only use if we didn't lose too much content
                    console.log(`HTML parsing extracted ${plainText.length} chars from ${content.length} chars of HTML`);
                    content = plainText;
                  }
                } catch (error) {
                  console.error('Error parsing HTML content:', error);
                }
              }
              
              // For CNN feeds, try to extract full article content
              if (feed.url.includes('cnn.com')) {
                console.log('CNN feed detected - attempting to extract more content');
                try {
                  // Sometimes CNN puts content in content:encoded
                  if (item['content:encoded']) {
                    const contentEncoded = item['content:encoded'];
                    if (typeof contentEncoded === 'string' && contentEncoded.length > content.length) {
                      console.log(`Found content:encoded with ${contentEncoded.length} chars`);
                      // Strip HTML
                      const plainContentEncoded = contentEncoded
                        .replace(/<[^>]*>/g, '')
                        .replace(/\n{3,}/g, '\n\n')
                        .trim();
                      if (plainContentEncoded.length > content.length) {
                        content = plainContentEncoded;
                      }
                    }
                  }
                } catch (cnnError) {
                  console.error('Error extracting CNN content:', cnnError);
                }
              }
              
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
                content = `News item from ${feed.name} with title "${item.title}". Published on ${item.pubDate || 'unknown date'}. Unfortunately, no detailed content was provided in the RSS feed.`;
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
              else if (typeof item.content === 'string' && item.content.includes('<img')) {
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
              
              // Add this URL to the set of posted articles
              if (item.link) {
                postedArticleUrls.add(item.link);
                
                // Limit the size of the set to prevent memory leaks
                if (postedArticleUrls.size > MAX_POSTED_URLS) {
                  // Convert to array, remove the oldest entries, and convert back to Set
                  const urlArray = Array.from(postedArticleUrls);
                  postedArticleUrls.clear();
                  urlArray.slice(-MAX_POSTED_URLS).forEach(url => postedArticleUrls.add(url));
                }
              }
              
              // Update the feed index for next time to the next item
              feedIndexTracker[feed.url] = (currentIndex + 1) % parsedFeed.items.length;
              
              return {
                title: sanitizedTitle,
                link: item.link,
                content: sanitizedContent,
                pubDate: item.pubDate || new Date().toISOString(),
                source: feed.name,
                image: image
              };
            }
            
            // Move to next index (cycling if we reach the end)
            currentIndex = (currentIndex + 1) % parsedFeed.items.length;
            
            // If we've gone through all items without finding a new one, update the index and break
            if (currentIndex === feedIndexTracker[feed.url]) {
              console.warn(`All articles from ${feed.name} have already been posted. Updating index and trying next feed.`);
              feedIndexTracker[feed.url] = 0;
              break;
            }
          }
          
          // If we checked all items but found no new article, update the index and continue to next feed
          feedIndexTracker[feed.url] = (feedIndexTracker[feed.url] + 1) % parsedFeed.items.length;
          console.log(`No new articles found in ${feed.name}, trying next feed.`);
        } else {
          console.warn(`No items found in feed from ${feed.name}`);
        }
      } catch (feedError) {
        console.error(`Error fetching feed ${feed.name}:`, feedError);
        // Continue to next feed on error
        continue;
      }
    }
    
    // If we've gone through all feeds and all articles have been posted,
    // reset the URL tracking to allow re-posting older articles
    if (postedArticleUrls.size > 0) {
      console.log('All available articles have been posted. Clearing some history to allow re-posts.');
      // Clear half of the oldest URLs to allow some articles to be posted again
      const urlArray = Array.from(postedArticleUrls);
      postedArticleUrls.clear();
      // Keep the most recent half
      urlArray.slice(Math.floor(urlArray.length / 2)).forEach(url => postedArticleUrls.add(url));
    }
    
    console.error('No valid news items found in any feeds.');
    return null;
  } catch (error) {
    console.error('Error fetching news:', error);
    return null;
  }
}

// Function to enhance news content using the Grid API
async function enhanceNewsContent(newsItem) {
  if (!newsItem) return null;
  
  console.log(`Enhancing content for "${newsItem.title}"...`);
  
  try {
    // Check if content is minimal or basically just the headline
    const contentLength = newsItem.content ? newsItem.content.length : 0;
    const isMinimalContent = contentLength < 100 || 
      (!newsItem.content) || 
      (newsItem.title && newsItem.content === newsItem.title);
    
    if (isMinimalContent) {
      console.log(`Skipping enhancement for minimal content (${contentLength} chars): "${newsItem.title}"`);
      return newsItem.content || newsItem.title;
    }
    
    const prompt = `You are a Discord news bot helping summarize and enhance news articles. 
Rewrite the following article to be more engaging for a Discord audience. 
Maintain accuracy, but make it more conversational and dramatic.
Original headline: ${newsItem.title}
Original article content: ${newsItem.content}
`;

    // Start generation
    const response = await axios.post(TEXT_GENERATION_ENDPOINT, {
      prompt: prompt,
      params: {
        max_length: 2048,
        temperature: 0.7,
      },
      models: [TEXT_MODEL]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': GRID_API_KEY,
        'Client-Agent': 'GridNewsBot:1.0'
      }
    });

    if (response.data && response.data.id) {
      const generationId = response.data.id;
      console.log(`Generation started with ID: ${generationId}`);
      
      // Poll for results using our existing function
      const results = await pollForTextResults(generationId, 120);
      
      if (results && results.done && results.text) {
        console.log(`Content enhancement complete for "${newsItem.title}"`);
        return results.text;
      } else {
        console.warn('No enhanced text returned or process failed:', results?.error || 'Unknown error');
        return newsItem.content;
      }
    } else {
      console.error('No generation ID received from the API');
      return newsItem.content;
    }
  } catch (error) {
    console.error('Error enhancing news content:', error.message);
    
    // Try with the fallback model if specified and different
    if (FALLBACK_TEXT_MODEL && FALLBACK_TEXT_MODEL !== TEXT_MODEL) {
      console.log(`Trying with fallback model ${FALLBACK_TEXT_MODEL}`);
      try {
        const prompt = `You are a Discord news bot helping summarize and enhance news articles. 
Rewrite the following article to be more engaging for a Discord audience. 
Maintain accuracy, but make it more conversational and dramatic.
Original headline: ${newsItem.title}
Original article content: ${newsItem.content}
`;

        // Start generation with fallback model
        const response = await axios.post(TEXT_GENERATION_ENDPOINT, {
          prompt: prompt,
          params: {
            max_length: 1536,
            temperature: 0.7,
          },
          models: [FALLBACK_TEXT_MODEL]
        }, {
          headers: {
            'Content-Type': 'application/json',
            'apikey': GRID_API_KEY,
            'Client-Agent': 'GridNewsBot:1.0'
          }
        });

        if (response.data && response.data.id) {
          const generationId = response.data.id;
          console.log(`Fallback generation started with ID: ${generationId}`);
          
          // Poll for results using our existing function
          const results = await pollForTextResults(generationId, 120);
          
          if (results && results.done && results.text) {
            console.log(`Fallback content enhancement complete for "${newsItem.title}"`);
            return results.text;
          } else {
            console.warn('No enhanced text returned from fallback model or process failed:', results?.error || 'Unknown error');
            return newsItem.content;
          }
        } else {
          console.error('No generation ID received from the fallback API');
          return newsItem.content;
        }
      } catch (fallbackError) {
        console.error('Error with fallback enhancement:', fallbackError.message);
        return newsItem.content;
      }
    } else {
      // No fallback or fallback is the same as main model
      return newsItem.content;
    }
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
    let generationId;
    let successfulResponse = false;
    
    // First try with the specified model
    try {
      const requestBody = {
        prompt: combinedPrompt,
        params: {
          max_length: 1000,
          max_context_length: 8192,
          temperature: 0.75,
          rep_pen: 1.1,
          top_p: 0.92,
          top_k: 100,
          stop_sequence: ["Ċ", "<|endoftext|>"],
        },
        models: [TEXT_MODEL],
      };
      console.log(`Using model: ${TEXT_MODEL} for news response`);
      
      // Submit the generation request
      const response = await axios.post(TEXT_GENERATION_ENDPOINT, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'apikey': GRID_API_KEY,
          'Client-Agent': 'GridNewsBot:1.0'
        }
      });
      
      generationId = response.data.id;
      console.log(`News response generation request submitted with ID: ${generationId}`);
      successfulResponse = true;
    } catch (modelError) {
      console.error(`Error with specified model ${TEXT_MODEL}:`, modelError.message);
      successfulResponse = false;
    }
    
    // If the first attempt failed, try without specifying a model
    if (!successfulResponse) {
      try {
        console.log('Trying fallback approach: Submitting response request without specifying model');
        
        const fallbackRequestBody = {
          prompt: combinedPrompt,
          params: {
            max_length: 1000,
            max_context_length: 8192,
            temperature: 0.75,
            rep_pen: 1.1,
            top_p: 0.92,
            top_k: 100,
            stop_sequence: ["Ċ", "<|endoftext|>"],
          }
          // No models specified - let the API choose
        };
        
        const fallbackResponse = await axios.post(TEXT_GENERATION_ENDPOINT, fallbackRequestBody, {
          headers: {
            'Content-Type': 'application/json',
            'apikey': GRID_API_KEY,
            'Client-Agent': 'GridNewsBot:1.0'
          }
        });
        
        generationId = fallbackResponse.data.id;
        console.log(`Fallback news response generation request submitted with ID: ${generationId}`);
        successfulResponse = true;
      } catch (fallbackError) {
        console.error('Error with fallback model request:', fallbackError.message);
        
        // Provide a fallback response if everything fails
        if (newsHistory && newsHistory.length > 0) {
          return `I'm having trouble generating a detailed response right now. The article is about "${newsHistory[0].headline}". Would you like me to try again later?`;
        }
        return "I'm having trouble processing your question right now. Please try again in a moment.";
      }
    }
    
    // If we got this far, we have a generation ID to poll
    if (successfulResponse && generationId) {
      // Poll for the results with increased timeout (2 minutes)
      const results = await pollForTextResults(generationId, 120);
      
      if (results.text) {
        // Process the response text
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
      } else {
        console.error('Text generation did not return any content for user query');
        
        // Provide a fallback response if text generation failed
        if (newsHistory && newsHistory.length > 0) {
          return `I'm having trouble generating a detailed response right now. The article is about "${newsHistory[0].headline}". Would you like me to try again later?`;
        }
        return "I'm having trouble processing your question right now. Please try again in a moment.";
      }
    } else {
      console.error('Failed to get a valid generation ID for user query');
      return "I'm sorry, I'm having technical difficulties right now. Please try again later.";
    }
  } catch (error) {
    console.error('Error generating response:', error);
    if (newsHistory && newsHistory.length > 0) {
      return `We have a recent news story about "${newsHistory[0].headline}". Would you like to know more about this topic?`;
    }
    return "I'm having trouble processing your question right now. Let me try to give you a simple summary of recent news instead.";
  }
}

// Function to generate LLM-assisted image prompts
async function generateLlmAssistedImagePrompt(headline, articleSummary) {
  try {
    // Check if we have the prompt template
    if (!LLM_ASSISTED_IMAGE_PROMPT_GENERATION) {
      console.warn("LLM_ASSISTED_IMAGE_PROMPT_GENERATION environment variable not found, using default template");
      // Default template as fallback
      const defaultTemplate = "Based on the news headline: '{{headline}}', generate a concise and abstract image prompt that captures the essence of the news without being too literal. Avoid text, words, and human faces.";
      
      // Fill in the default template
      return defaultTemplate.replace('{{headline}}', headline);
    }
    
    // Create the LLM prompt by replacing placeholders
    const promptTemplate = LLM_ASSISTED_IMAGE_PROMPT_GENERATION;
    const filledPrompt = promptTemplate
      .replace('{{headline}}', headline)
      .replace('{{article_summary}}', articleSummary || 'No article summary available');
    
    console.log(`Generating LLM-assisted image prompt for headline: "${headline}"`);
    
    // Variable to track our generation ID
    let generationId;
    let successfulResponse = false;
    
    // First try with the specified model
    try {
      const requestBody = {
        prompt: filledPrompt,
        params: {
          max_length: 300,
          max_context_length: 4096,
          temperature: 0.7,
          rep_pen: 1.1,
          top_p: 0.92,
          top_k: 100,
          stop_sequence: ["Ċ", "<|endoftext|>"],
        },
        models: [TEXT_MODEL],
      };
      console.log(`Using model: ${TEXT_MODEL} for image prompt generation`);
      
      // Submit the generation request
      const response = await axios.post(TEXT_GENERATION_ENDPOINT, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'apikey': GRID_API_KEY,
          'Client-Agent': 'GridNewsBot:1.0'
        }
      });
      
      generationId = response.data.id;
      console.log(`Image prompt generation request submitted with ID: ${generationId}`);
      successfulResponse = true;
    } catch (modelError) {
      console.error(`Error with specified model ${TEXT_MODEL}:`, modelError.message);
      successfulResponse = false;
    }
    
    // If the first attempt failed, try without specifying a model
    if (!successfulResponse) {
      try {
        console.log('Trying fallback approach: Submitting image prompt request without specifying model');
        
        const fallbackRequestBody = {
          prompt: filledPrompt,
          params: {
            max_length: 300,
            max_context_length: 4096,
            temperature: 0.7,
            rep_pen: 1.1,
            top_p: 0.92,
            top_k: 100,
            stop_sequence: ["Ċ", "<|endoftext|>"],
          }
          // No models specified - let the API choose
        };
        
        const fallbackResponse = await axios.post(TEXT_GENERATION_ENDPOINT, fallbackRequestBody, {
          headers: {
            'Content-Type': 'application/json',
            'apikey': GRID_API_KEY,
            'Client-Agent': 'GridNewsBot:1.0'
          }
        });
        
        generationId = fallbackResponse.data.id;
        console.log(`Fallback image prompt generation request submitted with ID: ${generationId}`);
        successfulResponse = true;
      } catch (fallbackError) {
        console.error('Error with fallback model request for image prompt:', fallbackError.message);
        
        // If both methods fail, return a basic prompt based on the headline
        return `Abstract news concept for: "${headline}". Artistic news image, no text.`;
      }
    }
    
    // If we got this far, we have a generation ID to poll
    if (successfulResponse && generationId) {
      // Poll for the results (use a shorter timeout since this is a smaller generation)
      const results = await pollForTextResults(generationId, 60);
      
      if (results.text) {
        // Clean up the response
        const promptText = normalizeApiText(results.text);
        
        // Remove any instructional preamble 
        const cleanPrompt = promptText
          .replace(/^(here\'s|here is|I will|I have|I've created|I've generated|generating|generated|here's a|for the headline|based on the headline).*?:\s*/i, '')
          .replace(/^image prompt:\s*/i, '')
          .replace(/^prompt:\s*/i, '')
          .trim();
          
        console.log(`Generated image prompt: "${cleanPrompt}"`);
        return cleanPrompt;
      } else {
        console.warn('Failed to generate LLM-assisted image prompt, using fallback');
        // If the API call fails, return a basic prompt based on the headline
        return `Abstract news concept for: "${headline}". Artistic news image, no text.`;
      }
    } else {
      console.error('Failed to get a valid generation ID for image prompt');
      // Return a basic prompt if we couldn't get a generation ID
      return `Abstract news concept for: "${headline}". Artistic news image, no text.`;
    }
  } catch (error) {
    console.error('Error generating LLM-assisted image prompt:', error);
    // Return a basic prompt if there's an overall error
    return `Abstract news concept for: "${headline}". Artistic news image, no text.`;
  }
}

// Function to generate a news image using the API
async function generateNewsImage(title, content) {
  try {
    console.log(`Generating image for news item: "${title}"`);
    
    // Create a prompt for image generation that summarizes the content
    const prompt = `Create a photorealistic news image for the headline: ${title}. 
The image should be eye-catching and appropriate for a news site, with high detail, realistic textures, and professional composition.
Style: Photojournalistic, high definition news photography`;
    
    // Use the flux-photo style template instead of raw parameters
    const response = await axios.post(IMAGE_GENERATION_ENDPOINT, {
      prompt: prompt,
      style: "flux-photo",  // Use the predefined flux-photo style
      // The style template will provide these parameters automatically:
      // - model: "Flux.1-Schnell fp8 (Compact)"
      // - width: 896, height: 1152
      // - steps: 4, cfg_scale: 1, sampler_name: "k_euler"
    }, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': GRID_API_KEY,
        'Client-Agent': 'GridNewsBot:1.0'
      }
    });
    
    if (response.data && response.data.id) {
      const generationId = response.data.id;
      console.log(`Image generation started with ID: ${generationId}`);
      
      // Poll for results using our existing pollForImageResults function
      const results = await pollForImageResults(generationId);
      
      if (results && !results.error) {
        // Check if we have a generations array with an image URL
        if (results.generations && results.generations.length > 0) {
          // Use permanent_img if available, otherwise use the standard img URL
          const imageUrl = results.generations[0].permanent_img || results.generations[0].img;
          console.log(`Generated image URL: ${imageUrl}`);
          return imageUrl;
        } else {
          console.warn('No image URL found in successful response');
          return null;
        }
      } else {
        console.error('Image generation failed or timed out:', results?.error || 'Unknown error');
        return null;
      }
    } else {
      console.error('No generation ID received from the API for image');
      return null;
    }
  } catch (error) {
    console.error('Error generating news image:', error.message);
    
    // Try with the fallback model but still using flux-photo style
    if (FALLBACK_IMAGE_MODEL && FALLBACK_IMAGE_MODEL !== IMAGE_MODEL) {
      console.log(`Trying with fallback image model ${FALLBACK_IMAGE_MODEL}`);
      try {
        const prompt = `Create a photorealistic news image for the headline: ${title}. 
The image should be eye-catching and appropriate for a news site, with high detail, realistic textures, and professional composition.
Style: Photojournalistic, high definition news photography`;
        
        // Submit request to the API with fallback model but still using style template
        const response = await axios.post(IMAGE_GENERATION_ENDPOINT, {
          prompt: prompt,
          style: "flux-photo",
          models: [FALLBACK_IMAGE_MODEL]  // Override just the model but keep the style
        }, {
          headers: {
            'Content-Type': 'application/json',
            'apikey': GRID_API_KEY,
            'Client-Agent': 'GridNewsBot:1.0'
          }
        });
        
        if (response.data && response.data.id) {
          const generationId = response.data.id;
          console.log(`Fallback image generation started with ID: ${generationId}`);
          
          // Poll for results
          const results = await pollForImageResults(generationId);
          
          if (results && !results.error) {
            // Check if we have a generations array with an image URL
            if (results.generations && results.generations.length > 0) {
              // Use permanent_img if available, otherwise use the standard img URL
              const imageUrl = results.generations[0].permanent_img || results.generations[0].img;
              console.log(`Generated fallback image URL: ${imageUrl}`);
              return imageUrl;
            } else {
              console.warn('No image URL found in successful fallback response');
              return null;
            }
          } else {
            console.error('Fallback image generation failed or timed out:', results?.error || 'Unknown error');
            return null;
          }
        } else {
          console.error('No generation ID received from the API for fallback image');
          return null;
        }
      } catch (fallbackError) {
        console.error('Error with fallback image generation:', fallbackError.message);
        return null;
      }
    } else {
      // No fallback model specified or same as main model
      return null;
    }
  }
}

// Helper function to download an image from URL
async function downloadImage(imageUrl) {
  console.log(`Downloading image from: ${imageUrl}`);
  try {
    const response = await axios({
      url: imageUrl,
      method: 'GET',
      responseType: 'arraybuffer'
    });
    
    console.log(`Successfully downloaded image (${response.data.length} bytes)`);
    return Buffer.from(response.data, 'binary');
  } catch (error) {
    console.error(`Failed to download image from ${imageUrl}:`, error.message);
    throw error;
  }
}

// Function to post news to Discord
async function postNewsToDiscord(title, content, link, source, pubDate, imageUrl) {
  try {
    console.log(`Posting news to Discord: "${title}"`);
    
    // Get the channel
    const channel = await client.channels.fetch(NEWS_CHANNEL_ID);
    if (!channel) {
      console.error(`Could not find channel with ID ${NEWS_CHANNEL_ID}`);
      return;
    }
    
    // Format the timestamp from pubDate
    let formattedDate = '';
    try {
      const dateObj = new Date(pubDate);
      formattedDate = dateObj.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (dateError) {
      console.warn(`Error formatting date ${pubDate}:`, dateError.message);
      formattedDate = 'Recently';
    }
    
    // Prepare image attachment if available
    let imageAttachment = null;
    if (imageUrl) {
      try {
        console.log(`Preparing to download and attach image from: ${imageUrl}`);
        const imageBuffer = await downloadImage(imageUrl);
        
        // Create a sanitized filename from the title
        const sanitizedTitle = title.replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 20);
        const imageExtension = imageUrl.split('.').pop().split('?')[0]; // Get file extension
        const filename = `news_${sanitizedTitle}.${imageExtension || 'jpg'}`;
        
        imageAttachment = new AttachmentBuilder(imageBuffer, { name: filename });
        console.log(`Image prepared as attachment: ${filename}`);
      } catch (imgError) {
        console.error(`Error downloading image for attachment:`, imgError.message);
        console.log(`Falling back to image URL: ${imageUrl}`);
        // If download fails, we'll include the URL in the embed
      }
    } else if (content && content.length > 100) {
      // Generate an image if none provided but we have sufficient content
      try {
        console.log('No image URL provided, attempting to generate an image for the news');
        imageUrl = await generateNewsImage(title, content);
        
        if (imageUrl) {
          console.log(`Successfully generated image at: ${imageUrl}`);
          try {
            const imageBuffer = await downloadImage(imageUrl);
            
            // Create a sanitized filename from the title
            const sanitizedTitle = title.replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 20);
            imageAttachment = new AttachmentBuilder(imageBuffer, { name: `news_${sanitizedTitle}.jpg` });
            console.log('Generated image prepared as attachment');
          } catch (downloadError) {
            console.error(`Error downloading generated image:`, downloadError.message);
            console.log(`Will use image URL in embed: ${imageUrl}`);
          }
        }
      } catch (genError) {
        console.error('Error generating news image:', genError.message);
      }
    }
    
    // Build the embed
    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle(title)
      .setURL(link)
      .setDescription(content.length > 4000 ? content.substring(0, 4000) + '...' : content)
      .setTimestamp()
      .setFooter({ text: `Source: ${source} • Published: ${formattedDate}` });
    
    // Add image to embed if we have it as an attachment or URL
    if (imageAttachment) {
      embed.setImage(`attachment://${imageAttachment.name}`);
    } else if (imageUrl) {
      embed.setImage(imageUrl);
    }
    
    // Send the message with embed
    const messageOptions = {
      embeds: [embed]
    };
    
    // Add image attachment if we have one
    if (imageAttachment) {
      messageOptions.files = [imageAttachment];
    }
    
    await channel.send(messageOptions);
    console.log('News successfully posted to Discord');
  } catch (error) {
    console.error('Error posting to Discord:', error.message);
    
    // Simplified fallback attempt if the embed fails
    try {
      const channel = await client.channels.fetch(NEWS_CHANNEL_ID);
      if (!channel) return;
      
      // Prepare a simple text post without embeds
      let simpleMessage = `**${title}**\n\n`;
      simpleMessage += content.length > 1500 ? content.substring(0, 1500) + '...' : content;
      simpleMessage += `\n\n*Source: ${source}*`;
      if (link) simpleMessage += `\n${link}`;
      
      await channel.send({ content: simpleMessage });
      console.log('Sent fallback simple message after embed failure');
    } catch (fallbackError) {
      console.error('Critical error: Both embed and fallback posting failed:', fallbackError);
    }
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

// Add back the messageCreate event handler
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
          try {
            // Download the image
            const imageBuffer = await downloadImage(imageUrl);
            
            if (imageBuffer) {
              // Create a safe filename
              const safeFilename = topic
                .replace(/[^a-z0-9]/gi, '_')
                .toLowerCase()
                .substring(0, 20);
              
              // Send directly as an attachment
              await message.channel.send({
                content: `Generated image for: "${topic}"\n**DISCLAIMER: This image is AI-generated and fictional. It does not represent real events or people.**`,
                files: [{
                  attachment: imageBuffer,
                  name: `${safeFilename}_generated_image.jpg`
                }]
              });
            } else {
              // Fallback to URL if download fails
              await message.channel.send(`Generated image for: "${topic}"\n${imageUrl}\n\n**DISCLAIMER: This image is AI-generated and fictional. It does not represent real events or people.**`);
            }
          } catch (downloadError) {
            console.error('Error downloading image for attachment:', downloadError);
            // Fallback to URL
            await message.channel.send(`Generated image for: "${topic}"\n${imageUrl}\n\n**DISCLAIMER: This image is AI-generated and fictional. It does not represent real events or people.**`);
          }
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

// Login to Discord with the token
client.login(process.env.DISCORD_TOKEN); 