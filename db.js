// Tiny persistent store (better-sqlite3). Replaces the in-memory arrays that
// lost all state on restart — the source of duplicate re-posting.
const Database = require('better-sqlite3');

const db = new Database(process.env.DB_PATH || 'newsbot.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS seen (
    id        TEXT PRIMARY KEY,   -- feed item guid/link, so we never re-post
    seen_at   INTEGER
  );
  CREATE TABLE IF NOT EXISTS articles (
    id        TEXT PRIMARY KEY,
    headline  TEXT,
    summary   TEXT,
    take      TEXT,
    source    TEXT,
    link      TEXT,
    posted_at INTEGER
  );
`);

const _hasSeen = db.prepare('SELECT 1 FROM seen WHERE id = ?');
const _markSeen = db.prepare('INSERT OR IGNORE INTO seen (id, seen_at) VALUES (?, ?)');
const _saveArticle = db.prepare(`
  INSERT OR REPLACE INTO articles (id, headline, summary, take, source, link, posted_at)
  VALUES (@id, @headline, @summary, @take, @source, @link, @posted_at)
`);
const _recent = db.prepare('SELECT headline, summary, take, source, link FROM articles ORDER BY posted_at DESC LIMIT ?');

// Keep the seen-table from growing forever.
const _prune = db.prepare("DELETE FROM seen WHERE seen_at < ?");

function hasSeen(id) {
  return !!id && !!_hasSeen.get(id);
}
function markSeen(id) {
  if (id) _markSeen.run(id, Date.now());
}
function saveArticle(a) {
  _saveArticle.run({ ...a, posted_at: Date.now() });
}
function recentArticles(n = 8) {
  return _recent.all(n);
}
function pruneSeen(maxAgeDays = 30) {
  _prune.run(Date.now() - maxAgeDays * 86400 * 1000);
}

module.exports = { hasSeen, markSeen, saveArticle, recentArticles, pruneSeen };
