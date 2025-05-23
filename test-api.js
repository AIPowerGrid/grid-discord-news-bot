require('dotenv').config();
const axios = require('axios');
const Parser = require('rss-parser');

// Create RSS parser instance
const rssParser = new Parser();

const GRID_API_KEY = process.env.GRID_API_KEY;
const TEXT_MODEL = process.env.TEXT_MODEL || 'aphrodite/Qwen/Qwen2.5-Coder-7B-Instruct'; // Default text model
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'Flux.1-Schnell fp8 (Compact)'; // Default image model

// AI Power Grid API URLs - Updated based on grid-chat example
const GRID_API_BASE_URL = 'https://api.aipowergrid.io/api';
const TEXT_GENERATION_ENDPOINT = `${GRID_API_BASE_URL}/v2/generate/text/async`;
const TEXT_STATUS_ENDPOINT = `${GRID_API_BASE_URL}/v2/generate/text/status/`;
const IMAGE_GENERATION_ENDPOINT = `${GRID_API_BASE_URL}/v2/generate/async`;
const IMAGE_STATUS_ENDPOINT = `${GRID_API_BASE_URL}/v2/generate/status/`;

// List of news RSS feeds to test
const TEST_FEEDS = [
  { name: 'BBC News', url: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' }
];

// Sleep function for polling
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Poll for text generation results
async function pollForTextResults(id, maxAttempts = 10) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await axios.get(`${TEXT_STATUS_ENDPOINT}${id}`, {
        headers: {
          'Content-Type': 'application/json',
          'apikey': GRID_API_KEY,
          'Client-Agent': 'GridNewsBot:1.0'
        }
      });
      
      if (response.data.done) {
        console.log('Generation complete!');
        return response.data;
      }
      
      console.log(`Waiting for generation... (Attempt ${attempt + 1}/${maxAttempts})`);
      await sleep(2000); // Wait 2 seconds between polls
    } catch (error) {
      console.error('Error polling for results:', error.message);
      await sleep(2000);
    }
  }
  
  throw new Error('Max polling attempts reached');
}

// Poll for image generation results
async function pollForImageResults(id, maxAttempts = 15) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await axios.get(`${IMAGE_STATUS_ENDPOINT}${id}`, {
        headers: {
          'Content-Type': 'application/json',
          'apikey': GRID_API_KEY,
          'Client-Agent': 'GridNewsBot:1.0'
        }
      });
      
      if (response.data.done) {
        console.log('Image generation complete!');
        return response.data;
      }
      
      console.log(`Waiting for image... (Attempt ${attempt + 1}/${maxAttempts})`);
      await sleep(3000); // Wait 3 seconds between polls for images (they take longer)
    } catch (error) {
      console.error('Error polling for image results:', error.message);
      await sleep(3000);
    }
  }
  
  throw new Error('Max polling attempts reached');
}

// Test text generation
async function testTextGeneration() {
  try {
    console.log('Testing text generation...');
    const response = await axios.post(TEXT_GENERATION_ENDPOINT, {
      prompt: "Create a short news headline about technology",
      max_tokens: 100,
      temperature: 0.7,
      models: [TEXT_MODEL]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': GRID_API_KEY,
        'Client-Agent': 'GridNewsBot:1.0'
      }
    });
    
    console.log('Text Generation Request ID:', response.data.id);
    
    // Poll for results
    const results = await pollForTextResults(response.data.id);
    console.log('Text Generation Results:', results);
    
    return true;
  } catch (error) {
    console.error('Text Generation Error:', error.response?.data || error.message);
    return false;
  }
}

// Test image generation
async function testImageGeneration() {
  try {
    console.log('\nTesting image generation...');
    
    // Prepare prompt for image generation
    const prompt = "A futuristic city skyline with flying vehicles, photorealistic, 4k, detailed";
    
    // Use the exact same configuration as grid-discord-bot
    const generation_data = {
      prompt,
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
    
    // Step 1: Submit the image generation request
    const response = await axios.post(IMAGE_GENERATION_ENDPOINT, generation_data, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': GRID_API_KEY,
        'Client-Agent': 'GridNewsBot:1.0'
      }
    });
    
    if (!response.data || !response.data.id) {
      console.error('Failed to start image generation:', response.data?.message || 'Unknown error');
      return false;
    }
    
    const generationId = response.data.id;
    console.log('Image generation started with ID:', generationId);
    
    // Step 2: Poll for the results (using a direct implementation instead of the helper function)
    let imageUrl = null;
    let attempts = 0;
    const maxAttempts = 30; // 5 minutes max wait time with 10-second intervals
    
    while (attempts < maxAttempts) {
      attempts++;
      
      try {
        console.log(`Checking image generation status (attempt ${attempts}/${maxAttempts})...`);
        const statusResponse = await axios.get(`${IMAGE_STATUS_ENDPOINT}${generationId}`, {
          headers: {
            'Content-Type': 'application/json',
            'apikey': GRID_API_KEY,
            'Client-Agent': 'GridNewsBot:1.0'
          }
        });
        
        const status = statusResponse.data;
        
        if (status.done) {
          console.log('Image generation complete!');
          
          if (status.generations && status.generations.length > 0) {
            console.log('Image successfully generated!');
            imageUrl = status.generations[0].img;
            break;
          } else {
            console.warn('No image generations returned');
            break;
          }
        }
        
        // Wait before checking again
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10 second intervals
        
      } catch (error) {
        console.error('Error checking generation status:', error.message);
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
    
    if (!imageUrl) {
      console.error('Failed to generate image after maximum attempts');
      return false;
    }
    
    console.log('Image URL or data available (truncated):', imageUrl.substring(0, 100) + '...');
    return true;
  } catch (error) {
    console.error('Image Generation Error:', error.response?.data || error.message);
    return false;
  }
}

// Test RSS feed parsing
async function testRssFeeds() {
  try {
    console.log('\nTesting RSS feed parsing...');
    
    for (const feed of TEST_FEEDS) {
      try {
        console.log(`\nFetching from ${feed.name} (${feed.url})...`);
        const parsedFeed = await rssParser.parseURL(feed.url);
        
        if (parsedFeed.items && parsedFeed.items.length > 0) {
          console.log(`Success! Found ${parsedFeed.items.length} items.`);
          
          // Display info about the first item
          const item = parsedFeed.items[0];
          console.log('First item:');
          console.log(`- Title: ${item.title}`);
          console.log(`- Link: ${item.link}`);
          console.log(`- Date: ${item.pubDate}`);
          
          // Check if there's an image
          if (item.enclosure && item.enclosure.url) {
            console.log(`- Image: ${item.enclosure.url}`);
          } else if (item.content && item.content.match(/<img[^>]+src="([^">]+)"/)) {
            const match = item.content.match(/<img[^>]+src="([^">]+)"/);
            console.log(`- Image found in content: ${match[1]}`);
          } else {
            console.log('- No image found in feed item');
          }
        } else {
          console.log('No items found in feed');
        }
      } catch (feedError) {
        console.error(`Error with feed ${feed.name}:`, feedError.message);
      }
    }
    
    return true;
  } catch (error) {
    console.error('RSS Feed Error:', error.message);
    return false;
  }
}

// Test news content enhancement
async function testNewsEnhancement() {
  try {
    console.log('\nTesting news content enhancement...');
    
    // Get a real news article first
    for (const feed of TEST_FEEDS) {
      try {
        const parsedFeed = await rssParser.parseURL(feed.url);
        
        if (parsedFeed.items && parsedFeed.items.length > 0) {
          const item = parsedFeed.items[0];
          
          // Use the AI to enhance the content
          const prompt = `
You are a professional news writer. Rewrite the following news article in a more engaging way.
Keep the core facts accurate but make it more compelling to read.

Original Title: ${item.title}
Original Source: ${feed.name}
Original Content: ${item.content || item.contentSnippet || ''}

Provide your response in the following format:
1. A catchy headline (one line)
2. A well-written 2-3 paragraph article that summarizes and expands on the original content
`;

          console.log('Enhancing news content...');
          
          const response = await axios.post(TEXT_GENERATION_ENDPOINT, {
            prompt: prompt,
            max_tokens: 500,
            temperature: 0.7,
            models: [TEXT_MODEL]
          }, {
            headers: {
              'Content-Type': 'application/json',
              'apikey': GRID_API_KEY,
              'Client-Agent': 'GridNewsBot:1.0'
            }
          });
          
          console.log('Enhancement Request ID:', response.data.id);
          
          // Poll for results
          const results = await pollForTextResults(response.data.id);
          
          if (results.generations && results.generations.length > 0) {
            console.log('Enhanced Content:');
            console.log(results.generations[0].text);
          } else {
            console.log('No enhanced content returned');
          }
          
          return true;
        }
      } catch (feedError) {
        console.error(`Error with feed ${feed.name}:`, feedError.message);
        continue;
      }
    }
    
    console.log('Could not find any news articles to enhance.');
    return false;
  } catch (error) {
    console.error('News Enhancement Error:', error.response?.data || error.message);
    return false;
  }
}

// Run tests
async function runTests() {
  console.log('=== AI Power Grid API Tests ===');
  console.log(`Using API Key: ${GRID_API_KEY}`);
  
  const textSuccess = await testTextGeneration();
  
  // Run image generation test with the working code from grid-discord-bot
  console.log('\nRunning image generation test...');
  const imageSuccess = await testImageGeneration();
  
  const rssSuccess = await testRssFeeds();
  const enhancementSuccess = await testNewsEnhancement();
  
  console.log('\n=== Test Results ===');
  console.log(`Text Generation: ${textSuccess ? 'SUCCESS ✅' : 'FAILED ❌'}`);
  console.log(`Image Generation: ${imageSuccess ? 'SUCCESS ✅' : 'FAILED ❌'}`);
  console.log(`RSS Feed Parsing: ${rssSuccess ? 'SUCCESS ✅' : 'FAILED ❌'}`);
  console.log(`News Enhancement: ${enhancementSuccess ? 'SUCCESS ✅' : 'FAILED ❌'}`);
}

runTests(); 