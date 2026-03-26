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

const GROK_API_KEY = process.env.GROK_API_KEY;

const limitText = (text, limit = 4200) => text.length <= limit ? text : `${text.slice(0, limit)}...`;

const parseGrokJson = (content) => {
  if (!content) return null;
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (error) {
    console.warn('No se pudo parsear JSON de Grok', error.message);
    return null;
  }
};

const runGrokCurator = async ({ title, url, summary, highlights }) => {
  if (!GROK_API_KEY) {
    return null;
  }

  const snippet = limitText([title, summary, ...highlights].join('\n'), 4200);
  const payload = {
    model: 'grok-4-1-fast',
    input: [
      {
        role: 'system',
        content:
          'Eres un curador editorial. Analiza la web provista y extrae un titular breve, el resumen más relevante, etiquetas, puntos clave y urgencia.'
      },
      {
        role: 'user',
        content: `URL: ${url}\n\nTexto para analizar:\n${snippet}\n\nDevuelve únicamente JSON con las claves "headline" (titular breve), "summary" (texto en español), "highlights" (array de frases cortas), "tags" (array de palabras clave) y "urgency" ("alta", "media" o "baja").`
      }
    ],
    max_output_tokens: 512,
    temperature: 0.3
  };

  const response = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROK_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Grok API respondió con ${response.status}: ${body}`);
  }

  const data = await response.json();
  const output = (data.output || []).slice(-1)[0];
  const parsed = parseGrokJson(output?.content || '');
  if (!parsed) {
    return null;
  }

  return {
    headline: parsed.headline,
    summary: parsed.summary,
    highlights: parsed.highlights,
    tags: parsed.tags,
    urgency: parsed.urgency,
    raw: output?.content || ''
  };
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
  const baseSummary = summaryHalves.join(' ') || description || 'No se encontró resumen automático.';
  const keywords = Array.from(
    new Set(
      baseSummary
        .slice(0, 120)
        .split(' ')
        .map((word) => word.toLowerCase().replace(/[^a-záéíóúñü]/g, ''))
        .filter((w) => w.length > 3)
        .slice(0, 10)
    )
  );

  const timestamp = new Date().toISOString();
  const curation = {
    url: normalized,
    title,
    summary: baseSummary,
    highlights,
    description,
    keywords,
    source: 'Curación manual',
    publishedAt: timestamp,
    extractedAt: timestamp
  };

  try {
    const grok = await runGrokCurator({ title, url: normalized, summary: baseSummary, highlights });
    if (grok) {
      curation.summary = grok.summary || curation.summary;
      curation.highlights = grok.highlights?.length ? grok.highlights : curation.highlights;
      if (grok.tags?.length) {
        curation.tags = grok.tags;
      }
      if (grok.urgency) {
        curation.urgency = grok.urgency;
      }
      if (grok.headline) {
        curation.title = grok.headline;
      }
      curation.source = 'Curación Grok';
      curation.grok = grok;
    }
  } catch (error) {
    console.warn('No se pudo usar Grok para refinar la curación', error.message || error);
  }

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
