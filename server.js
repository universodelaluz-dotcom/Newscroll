const express = require('express');
const RSSParser = require('rss-parser');
const cors = require('cors');
const cheerio = require('cheerio');
const path = require('path');
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

const CURATION_CACHE = new Map();
const MAX_CURATIONS = 20;

const CACHE_TTL = 45 * 1000;
let refreshPromise = null;

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

const normalizeUrl = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    return parsed.href;
  } catch (error) {
    return null;
  }
};

const extractParagraphs = ($) => {
  const paragraphs = [];
  $('article, body').find('h1, h2, h3, p').each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (text.length > 20) {
      paragraphs.push(text);
    }
  });
  if (paragraphs.length === 0) {
    $('p').each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text.length > 40) {
        paragraphs.push(text);
      }
    });
  }
  return paragraphs;
};

const curatePage = async (targetUrl) => {
  const normalized = normalizeUrl(targetUrl);
  if (!normalized) {
    throw new Error('URL inválida');
  }

  if (CURATION_CACHE.has(normalized)) {
    return CURATION_CACHE.get(normalized);
  }

  const response = await fetch(normalized, {
    headers: {
      'User-Agent': 'NewsScroll/2.0 (+https://github.com)',
      Accept: 'text/html'
    }
  });

  if (!response.ok) {
    throw new Error(`Falló la descarga (${response.status})`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const title =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('title').text().trim() ||
    normalized;
  const description = $('meta[name="description"]').attr('content')?.trim() || '';
  const paragraphs = extractParagraphs($);
  const summaryHalves = paragraphs.slice(0, 3);
  const highlights = paragraphs.slice(0, 5);
  const summary = summaryHalves.join(' ') || description || 'No se encontró resumen automático.';
  const keywords = Array.from(
    new Set(
      summary
        .slice(0, 120)
        .split(' ')
        .map((word) => word.toLowerCase().replace(/[^a-záéíóúñü]/g, ''))
        .filter((w) => w.length > 3)
        .slice(0, 10)
    )
  );

  const curation = {
    url: normalized,
    title,
    summary,
    highlights,
    description,
    keywords,
    extractedAt: new Date().toISOString()
  };

  if (CURATION_CACHE.size >= MAX_CURATIONS) {
    const firstKey = CURATION_CACHE.keys().next().value;
    CURATION_CACHE.delete(firstKey);
  }
  CURATION_CACHE.set(normalized, curation);

  return curation;
};

const refreshFeeds = async () => {
  try {
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
  } catch (error) {
    console.error('refreshFeeds failed', error);
    cache.updatedAt = new Date().toISOString();
  }
};
const ensureFreshCache = async () => {
  const needsRefresh =
    !cache.updatedAt || Date.now() - new Date(cache.updatedAt).getTime() > CACHE_TTL;

  if (!needsRefresh) {
    return;
  }

  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        await refreshFeeds();
      } finally {
        refreshPromise = null;
      }
    })();
  }

  await refreshPromise;
};

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/news', async (req, res) => {
  await ensureFreshCache();
  res.json({
    updatedAt: cache.updatedAt,
    count: cache.items.length,
    items: cache.items
  });
});

app.get('/api/health', async (req, res) => {
  await ensureFreshCache();
  res.json({
    status: 'ok',
    updatedAt: cache.updatedAt
  });
});

app.post('/api/curate', async (req, res) => {
  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'Se requiere la URL a curar.' });
  }

  try {
    const curated = await curatePage(url);
    return res.json({ curated });
  } catch (error) {
    console.error('Curación fallida:', error.message || error);
    return res
      .status(500)
      .json({ error: error.message || 'No se pudo curar la URL solicitada.' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Ticker server listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
