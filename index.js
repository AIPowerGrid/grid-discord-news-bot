require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require('discord.js');
const Parser = require('rss-parser');
const { sanitizeHtmlForDiscord, normalizeApiText } = require('./utils');
const grid = require('./grid');
const db = require('./db');

// ── Logging (leveled; set LOG_LEVEL=debug|info|warn|error) ──────────────────
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 20;
const log = {
  debug: (...a) => MIN <= 10 && console.log('[debug]', ...a),
  info: (...a) => MIN <= 20 && console.log('[info]', ...a),
  warn: (...a) => MIN <= 30 && console.warn('[warn]', ...a),
  error: (...a) => MIN <= 40 && console.error('[error]', ...a),
};

// Drop credentials from axios errors before logging.
function safeError(e) {
  if (e && (e.isAxiosError || e.response)) {
    return { message: e.message, status: e.response?.status, data: e.response?.data };
  }
  return e?.message || e;
}

// ── Config ──────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const NEWS_CHANNEL_ID = process.env.NEWS_CHANNEL_ID;
const UPDATE_FREQUENCY = parseInt(process.env.UPDATE_FREQUENCY || '60', 10); // minutes
const MAX_CANDIDATES = parseInt(process.env.MAX_CANDIDATES || '12', 10); // items to consider per run

// Curated, on-brand feeds (AI / open-source / decentralized compute / crypto).
// Generic world news (BBC/CNN) is intentionally gone — a grid bot posts grid-relevant news.
const DEFAULT_FEEDS = [
  'Hugging Face|https://huggingface.co/blog/feed.xml',
  'VentureBeat AI|https://venturebeat.com/category/ai/feed/',
  'TechCrunch|https://techcrunch.com/feed/',
  'The Verge|https://www.theverge.com/rss/index.xml',
  'MIT Tech Review|https://www.technologyreview.com/feed/',
  'r/LocalLLaMA|https://www.reddit.com/r/LocalLLaMA/.rss',
  'CoinDesk|https://www.coindesk.com/arc/outboundfeeds/rss/',
].join(',');

const NEWS_FEEDS = (process.env.NEWS_FEEDS || DEFAULT_FEEDS)
  .split(',')
  .map((f) => {
    const [name, url] = f.split('|');
    return { name: (name || '').trim(), url: (url || '').trim() };
  })
  .filter((f) => f.url);

const rss = new Parser({ timeout: 15000 });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// ── News pipeline ─────────────────────────────────────────────────────────────

// Pull recent items from all feeds, newest first, capped.
async function fetchCandidates() {
  const items = [];
  for (const feed of NEWS_FEEDS) {
    try {
      const parsed = await rss.parseURL(feed.url);
      for (const it of (parsed.items || []).slice(0, 5)) {
        const id = it.guid || it.link;
        if (!id) continue;
        items.push({
          id,
          title: sanitizeHtmlForDiscord(it.title || ''),
          content: sanitizeHtmlForDiscord(
            it.contentSnippet || it.summary || it.content || it.description || ''
          ),
          link: it.link,
          source: feed.name,
          image: extractImage(it),
          ts: it.isoDate ? Date.parse(it.isoDate) : Date.now(),
        });
      }
    } catch (e) {
      log.warn(`feed ${feed.name} failed:`, e.message);
    }
  }
  // Newest first.
  return items.sort((a, b) => b.ts - a.ts).slice(0, MAX_CANDIDATES);
}

function extractImage(it) {
  let url =
    it.enclosure?.url ||
    it['media:content']?.url ||
    it['media:thumbnail']?.url ||
    (it.content && (it.content.match(/<img[^>]+src="([^">]+)"/i) || [])[1]) ||
    null;
  if (url && url.startsWith('//')) url = 'https:' + url;
  return url && /^https?:\/\//.test(url) ? url.split('?')[0] : null;
}

// The single "editorial" call: honest summary + labeled take + image prompt.
// The system prompt forbids fabrication — that's the whole point of the reframe.
const EDITORIAL_SYSTEM = `You are "AIPG News", the news curator for AI Power Grid — a decentralized network of GPUs running open-source AI.
You summarize tech news HONESTLY. Absolute rules:
- NEVER invent facts, quotes, numbers, names, or events that are not in the provided source text.
- If the source is too thin to summarize without inventing, set "relevant": false.
- "relevant" is true ONLY if the item is genuinely about AI, open-source software/models, GPUs, crypto, or decentralized compute.
Return ONE JSON object and nothing else.`;

function editorialUser(a) {
  return `SOURCE (${a.source})
Title: ${a.title}

${a.content.slice(0, 2500)}

Return exactly this JSON:
{
  "relevant": true | false,
  "summary": "2-4 sentence factual TL;DR using ONLY the source above. No invented detail.",
  "take": "One sentence, clearly an opinion, on why this matters for open / decentralized AI.",
  "image_prompt": "A vivid, non-literal image concept capturing the theme. No text or words in the image."
}`;
}

async function curate(a) {
  const j = await grid.chatJson(
    [
      { role: 'system', content: EDITORIAL_SYSTEM },
      { role: 'user', content: editorialUser(a) },
    ],
    // Reasoning models (qwen3-27b) spend tokens "thinking" before the answer —
    // give enough headroom that the JSON answer survives after the reasoning.
    { maxTokens: 2500 }
  );
  if (!j || typeof j.relevant !== 'boolean') return null;
  return {
    relevant: j.relevant,
    summary: normalizeApiText(j.summary || ''),
    take: normalizeApiText(j.take || ''),
    imagePrompt: (j.image_prompt || '').toString().slice(0, 400),
  };
}

async function postArticle(a, ed) {
  const channel = await client.channels.fetch(NEWS_CHANNEL_ID);
  if (!channel) {
    log.error(`channel ${NEWS_CHANNEL_ID} not found`);
    return;
  }

  // Prefer the article's own image; otherwise generate one (grid showcase).
  let imageUrl = a.image;
  let generated = false;
  if (!imageUrl && ed.imagePrompt) {
    try {
      imageUrl = await grid.generateImage(ed.imagePrompt);
      generated = !!imageUrl;
    } catch (e) {
      log.warn('image gen failed:', safeError(e));
    }
  }

  const description = `${ed.summary}\n\n💡 **AIPG take:** ${ed.take}`.slice(0, 4000);

  const embed = new EmbedBuilder()
    .setColor(0xf8991d) // AIPG orange
    .setTitle(a.title.slice(0, 256))
    .setURL(a.link)
    .setDescription(description)
    .addFields({ name: '​', value: `[Read the original at ${a.source}](${a.link})` })
    .setTimestamp()
    .setFooter({
      text:
        `Curated by AIPG News · ${a.source}` +
        (generated ? ' · image is AI-generated, illustrative only' : ''),
    });

  if (imageUrl) embed.setImage(imageUrl);

  await channel.send({ embeds: [embed] });
  db.saveArticle({
    id: a.id,
    headline: a.title,
    summary: ed.summary,
    take: ed.take,
    source: a.source,
    link: a.link,
  });
  log.info(`posted: "${a.title}" (${a.source})`);
}

// One run: find the freshest unseen, relevant item and post it.
async function runOnce() {
  try {
    const candidates = await fetchCandidates();
    log.debug(`fetched ${candidates.length} candidates`);
    for (const a of candidates) {
      if (db.hasSeen(a.id)) continue;
      if (!a.content || a.content.length < 60) {
        db.markSeen(a.id); // too thin to summarize honestly — skip, don't fabricate
        continue;
      }
      const ed = await curate(a);
      db.markSeen(a.id); // mark regardless so we never re-evaluate the same item
      if (!ed) {
        log.warn(`curate returned nothing for "${a.title}"`);
        continue;
      }
      if (!ed.relevant || ed.summary.length < 40) {
        log.debug(`skipped (not relevant/thin): "${a.title}"`);
        continue;
      }
      await postArticle(a, ed);
      return; // one good post per run
    }
    log.info('no new relevant article this run');
  } catch (e) {
    log.error('runOnce failed:', safeError(e));
  } finally {
    db.pruneSeen();
  }
}

// ── Interactive Q&A about posted news ─────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const isDM = message.channel.type === 1; // ChannelType.DM
  const mentioned = message.mentions.has(client.user);
  if (!(isDM || mentioned || message.channel.id === NEWS_CHANNEL_ID)) return;

  const content = message.content.replace(new RegExp(`<@!?${client.user.id}>`), '').trim();
  if (!content) return;

  try {
    message.channel.sendTyping();

    // Image-on-request (kept — it's a nice grid showcase).
    const imgReq = content.match(/(?:generate|create|make) an image(?: of)?\s*(.*)/i);
    if (imgReq) {
      const topic = imgReq[1].trim() || db.recentArticles(1)[0]?.headline || 'open-source AI';
      await message.reply(`Generating an image for: "${topic}"…`);
      const url = await grid.generateImage(`${topic}. Striking, non-literal concept art. No text.`);
      if (url) {
        await message.channel.send(`${url}\n*AI-generated · illustrative only, not a real photo.*`);
      } else {
        await message.reply("Couldn't generate that image — try again shortly.");
      }
      return;
    }

    // News Q&A grounded in the articles we actually posted.
    const recent = db.recentArticles(6);
    const context = recent
      .map((r, i) => `[${i + 1}] ${r.headline} (${r.source})\n${r.summary}`)
      .join('\n\n');
    const answer = await grid.chat(
      [
        {
          role: 'system',
          content:
            'You are AIPG News. Answer ONLY from the posted articles below. ' +
            'Do not invent facts. If the question is unrelated to them, say so briefly. ' +
            (context ? `\n\nPosted articles:\n${context}` : '\n\nNo articles posted yet.'),
        },
        { role: 'user', content },
      ],
      { maxTokens: 600 }
    );

    const reply = answer || "I don't have anything on that from the recent posts.";
    // Discord 2000-char cap.
    if (reply.length <= 1900) {
      await message.reply(reply);
    } else {
      await message.reply(reply.slice(0, 1900));
      for (let i = 1900; i < reply.length; i += 1900) {
        await message.channel.send(reply.slice(i, i + 1900));
      }
    }
  } catch (e) {
    log.error('Q&A failed:', safeError(e));
    await message.reply('Sorry — I hit an error processing that.');
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
client.once('ready', () => {
  log.info(`logged in as ${client.user.tag}`);
  log.info(`feeds: ${NEWS_FEEDS.map((f) => f.name).join(', ')}`);
  log.info(`text=${grid.TEXT_MODEL} image=${grid.IMAGE_MODEL} base=${grid.BASE}`);
  runOnce();
  setInterval(runOnce, UPDATE_FREQUENCY * 60 * 1000);
});

if (require.main === module) {
  if (!DISCORD_TOKEN || !NEWS_CHANNEL_ID || !process.env.GRID_API_KEY) {
    log.error('Missing DISCORD_TOKEN, NEWS_CHANNEL_ID, or GRID_API_KEY — check .env');
    process.exit(1);
  }
  client.login(DISCORD_TOKEN);
}

module.exports = { fetchCandidates, curate, runOnce }; // for tests
