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
    url: 'https://feeds.bbci.co.uk/mundo/rss.xml',
    label: 'BBC Mundo'
  },
  {
    url: 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/ultimas-noticias/portada',
    label: 'El País'
  },
  {
    url: 'https://www.elmundo.es/rss/portada.xml',
    label: 'El Mundo'
  },
  {
    url: 'https://rss.dw.com/xml/rss-sp-all',
    label: 'DW Español'
  },
  {
    url: 'https://www.europapress.es/rss/rss.aspx',
    label: 'Europa Press'
  }
];

const PUBLISHER_LABELS = FEEDS.map((feed) => feed.label.toLowerCase());
const TITLE_SEPARATORS = ['|', ' - ', ' – ', ' — ', '//', ': '];

const sanitizeTitle = (title = '') => {
  let cleaned = title.trim();
  if (!cleaned) {
    return cleaned;
  }

  for (const separator of TITLE_SEPARATORS) {
    const separatorIndex = cleaned.indexOf(separator);
    if (separatorIndex === -1) continue;

    const prefix = cleaned.slice(0, separatorIndex).trim();
    if (!prefix) {
      continue;
    }

    const normalizedPrefix = prefix.replace(/[·•]/g, '').toLowerCase();
    if (PUBLISHER_LABELS.includes(normalizedPrefix)) {
      cleaned = cleaned.slice(separatorIndex + separator.length).trim();
      break;
    }
  }

  return cleaned || title.trim();
};

const HOT_KEYWORDS = ['breaking', 'urgent', 'exclusive', 'live', 'alert', 'breaking news'];

const cache = {
  updatedAt: null,
  items: []
};

let curatedTickerItems = [];

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
          'Eres un curador editorial. Analiza la web provista y extrae titulares breves, el resumen mÃ¡s relevante, etiquetas, puntos clave y urgencia.'
      },
      {
        role: 'user',
        content: `URL: ${url}\n\nTexto para analizar:\n${snippet}\n\nDevuelve Ãºnicamente JSON con las claves "headline" (titular principal breve), "headlines" (array de 3 a 6 titulares breves e importantes en espaÃ±ol), "summary" (texto en espaÃ±ol), "highlights" (array de frases cortas), "tags" (array de palabras clave) y "urgency" ("alta", "media" o "baja").`
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
    throw new Error(`Grok API respondiÃ³ con ${response.status}: ${body}`);
  }

  const data = await response.json();
  const output = (data.output || []).slice(-1)[0];
  const parsed = parseGrokJson(output?.content || '');
  if (!parsed) {
    return null;
  }

  return {
    headline: parsed.headline,
    headlines: parsed.headlines,
    summary: parsed.summary,
    highlights: parsed.highlights,
    tags: parsed.tags,
    urgency: parsed.urgency,
    raw: output?.content || ''
  };
};

const CURATION_CACHE = new Map();
const MAX_CURATIONS = 100;

const buildCurationTickerItems = (curation) => {
  if (!curation || !curation.url) {
    return [];
  }

  const candidateTitles = [...(curation.headlines || []), ...(curation.highlights || [])]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const includePrimaryTitle = candidateTitles.length === 0;

  const titlePool = [...(includePrimaryTitle ? [curation.title] : []), ...candidateTitles]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const uniqueTitles = [...new Set(titlePool)].slice(0, 6);
  return uniqueTitles.map((title, index) => ({
    title,
    summary: curation.summary,
    source: curation.source || 'Curaci?n manual',
    isExtracted: true,
    publishedAt: curation.publishedAt || curation.extractedAt || new Date().toISOString(),
    link: `${curation.url}#curation-${index}`,
    score: 999 - index,
    urgency: curation.urgency,
    tags: curation.tags || []
  }));
};

const pushCurationToCache = (curation) => {
  if (!curation || !curation.url) return;
  const nextItems = buildCurationTickerItems(curation);
  curatedTickerItems = [
    ...nextItems,
    ...curatedTickerItems.filter((item) => !item.link.startsWith(`${curation.url}#curation-`))
  ].slice(0, 120);
};

const removeCurationFromCache = (targetUrl) => {
  const normalized = normalizeUrl(targetUrl);
  if (!normalized) {
    return false;
  }

  CURATION_CACHE.delete(normalized);
  curatedTickerItems = curatedTickerItems.filter(
    (item) => !String(item.link || '').startsWith(`${normalized}#curation-`)
  );
  return true;
};

const listCurations = () =>
  Array.from(CURATION_CACHE.values())
    .sort((a, b) => new Date(b.extractedAt || 0) - new Date(a.extractedAt || 0))
    .map((curation) => ({
      url: curation.url,
      title: curation.title,
      source: curation.source,
      extractedAt: curation.extractedAt,
      headlines: (curation.headlines || []).slice(0, 4),
      highlights: (curation.highlights || []).slice(0, 4)
    }));

const setNoStore = (res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
};

const CACHE_TTL = 45 * 1000;
let refreshPromise = null;

const normalizeArticle = (article, sourceLabel) => {
  const title = article.title?.trim() || 'Sin tÃ­tulo';
  const summary = (article.contentSnippet || article.summary || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
  const link = article.link || article.guid || null;
  const publishedDate = new Date(article.isoDate || article.pubDate || Date.now());
  const timestamp = isNaN(publishedDate.getTime()) ? Date.now() : publishedDate.getTime();

  return {
    title: sanitizeTitle(title),
    summary,
    link,
    source: sourceLabel,
    publishedAt: new Date(timestamp).toISOString(),
    isExtracted: false
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
    throw new Error('URL invÃ¡lida');
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
    throw new Error(`FallÃ³ la descarga (${response.status})`);
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
  const baseSummary = summaryHalves.join(' ') || description || 'No se encontrÃ³ resumen automÃ¡tico.';
  const keywords = Array.from(
    new Set(
      baseSummary
        .slice(0, 120)
        .split(' ')
        .map((word) => word.toLowerCase().replace(/[^a-zÃ¡Ã©Ã­Ã³ÃºÃ±Ã¼]/g, ''))
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
    headlines: [],
    description,
    keywords,
    source: 'CuraciÃ³n manual',
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
      if (grok.headlines?.length) {
        curation.headlines = grok.headlines;
      }
      if (grok.headline) {
        curation.title = grok.headline;
      }
      curation.source = 'CuraciÃ³n Grok';
      curation.grok = grok;
    }
  } catch (error) {
    console.warn('No se pudo usar Grok para refinar la curaciÃ³n', error.message || error);
  }

  if (CURATION_CACHE.size >= MAX_CURATIONS) {
    const firstKey = CURATION_CACHE.keys().next().value;
    CURATION_CACHE.delete(firstKey);
  }
  CURATION_CACHE.set(normalized, curation);
  pushCurationToCache(curation);

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
  const items = [...curatedTickerItems, ...cache.items].slice(0, 80);
  setNoStore(res);
  res.json({
    updatedAt: cache.updatedAt,
    count: items.length,
    items
  });
});

app.get('/api/health', async (req, res) => {
  await ensureFreshCache();
  setNoStore(res);
  res.json({
    status: 'ok',
    updatedAt: cache.updatedAt
  });
});


app.get('/api/curations', (req, res) => {
  setNoStore(res);
  res.json({
    count: CURATION_CACHE.size,
    items: listCurations()
  });
});

app.post('/api/curate', async (req, res) => {
  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'Se requiere la URL a curar.' });
  }

  try {
    const curated = await curatePage(url);
    setNoStore(res);
    return res.json({ curated });
  } catch (error) {
    console.error('CuraciÃ³n fallida:', error.message || error);
    return res
      .status(500)
      .json({ error: error.message || 'No se pudo curar la URL solicitada.' });
  }
});

app.delete('/api/curate', (req, res) => {
  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'Se requiere la URL a quitar.' });
  }

  if (!removeCurationFromCache(url)) {
    return res.status(400).json({ error: 'La URL no es v?lida.' });
  }

  setNoStore(res);
  return res.json({ ok: true, items: listCurations() });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Ticker server listening on http://localhost:${PORT}`);
  });
}

module.exports = app;

