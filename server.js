const express = require('express');
const RSSParser = require('rss-parser');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
const parser = new RSSParser({ timeout: 10000 });
const PORT = process.env.PORT || 3000;

const FEEDS = [
  {
    url: 'https://www.reuters.com/rssFeed/topNews',
    label: 'Reuters'
  },
  {
    url: 'https://www.elmundo.es/rss/elpais/portada.xml',
    label: 'El País'
  },
  {
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    label: 'BBC Mundo'
  },
  {
    url: 'https://www.infobae.com/feeds/noticias.xml',
    label: 'Infobae'
  }
];

const HOT_KEYWORDS = ['breaking', 'urgent', 'exclusive', 'live', 'alert', 'breaking news'];

const cache = {
  updatedAt: null,
  items: []
};

const normalizeArticle = (article, sourceLabel) => {
  const title = article.title?.trim() || 'Sin título';
  const summary = (article.contentSnippet || article.summary || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
  const link = article.link || article.guid || null;
  const publishedDate = new Date(article.isoDate || article.pubDate || Date.now());
  const timestamp = isNaN(publishedDate.getTime()) ? Date.now() : publishedDate.getTime();

  return {
    title,
    summary,
    link,
    source: sourceLabel,
    publishedAt: new Date(timestamp).toISOString()
  };
};

const calculateScore = (article) => {
  const now = Date.now();
  const published = new Date(article.publishedAt).getTime();
  const minutesAgo = Math.min(120, Math.max(0, Math.round((now - published) / 60000)));
  // More recent -> higher score.
  let score = Math.max(0, 120 - minutesAgo);

  const lowered = article.title.toLowerCase();
  HOT_KEYWORDS.forEach((word) => {
    if (lowered.includes(word)) {
      score += 12;
    }
  });

  if (article.summary.length > 0) {
    score += 4;
  }

  return score;
};

const refreshFeeds = async () => {
  const articlesByLink = new Map();

  await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const parsed = await parser.parseURL(feed.url);
        (parsed.items || []).forEach((item) => {
          const normalized = normalizeArticle(item, feed.label);
          if (!normalized.link) return;
          if (articlesByLink.has(normalized.link)) {
            return;
          }
          articlesByLink.set(normalized.link, normalized);
        });
      } catch (error) {
        console.error(`Error refrescando ${feed.label}:`, error.message || error);
      }
    })
  );

  const items = Array.from(articlesByLink.values())
    .map((article) => ({ ...article, score: calculateScore(article) }))
    .sort((a, b) => {
      if (b.score === a.score) {
        return new Date(b.publishedAt) - new Date(a.publishedAt);
      }
      return b.score - a.score;
    })
    .slice(0, 40);

  cache.items = items;
  cache.updatedAt = new Date().toISOString();
};

app.use(cors());
app.use(express.static('public'));

app.get('/api/news', (req, res) => {
  res.json({
    updatedAt: cache.updatedAt,
    count: cache.items.length,
    items: cache.items
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    updatedAt: cache.updatedAt
  });
});

cron.schedule('*/1 * * * *', refreshFeeds, {
  scheduled: true
});

(async () => {
  await refreshFeeds();
  app.listen(PORT, () => {
    console.log(`Ticker server listening on http://localhost:${PORT}`);
  });
})();
