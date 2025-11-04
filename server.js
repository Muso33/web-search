// server.js
// Simple Node/Express server that scrapes DuckDuckGo for images & links and YouTube for videos.
// NOTE: This is a demo/prototype server-side proxy. Use responsibly and respect terms of service of third-party sites.

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.disable('x-powered-by');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117 Safari/537.36';

// Helper: get vqd token from DuckDuckGo landing page
async function getDuckVQD(query) {
  const url = 'https://duckduckgo.com/?q=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  const text = await res.text();
  const m = text.match(/vqd='([^']+)'/);
  return m ? m[1] : null;
}

// Fetch images from DuckDuckGo i.js JSON endpoint
async function fetchDuckImages(query, maxResults = 30) {
  try {
    const vqd = await getDuckVQD(query);
    if (!vqd) return [];

    const results = [];
    let params = `l=en-US&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}`;
    let nextUrl = 'https://duckduckgo.com/i.js?' + params;
    // DuckDuckGo paginates with "next" - loop until enough results or no next
    while (nextUrl && results.length < maxResults) {
      const res = await fetch(nextUrl, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
      if (!res.ok) break;
      const json = await res.json();
      if (!json || !json.results) break;
      for (const it of json.results) {
        results.push({
          type: 'image',
          url: it.image || it.url || null,
          thumbnail: it.thumbnail,
          title: it.title || it.alt,
          source: it.url || it.source || null,
        });
        if (results.length >= maxResults) break;
      }
      nextUrl = json.next ? 'https://duckduckgo.com' + json.next : null;
    }
    return results;
  } catch (err) {
    console.error('fetchDuckImages error', err);
    return [];
  }
}

// Fetch page links from DuckDuckGo HTML (search results)
async function fetchDuckLinks(query, maxResults = 20) {
  try {
    const url = 'https://duckduckgo.com/html/?q=' + encodeURIComponent(query);
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    const html = await res.text();
    const $ = cheerio.load(html);
    const links = [];
    $('.result__a').each((i, el) => {
      if (links.length >= maxResults) return;
      const href = $(el).attr('href');
      const title = $(el).text();
      if (href) {
        links.push({
          type: 'link',
          url: href,
          title: title || href
        });
      }
    });
    return links;
  } catch (err) {
    console.error('fetchDuckLinks error', err);
    return [];
  }
}

// Fetch YouTube video IDs from search results HTML
async function fetchYouTubeVideos(query, maxResults = 12) {
  try {
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    const text = await res.text();

    // YouTube embeds initial data; attempt to extract videoId occurrences.
    const ids = new Set();
    // Try JSON parsing of ytInitialData occurrences
    // Fallback to regex that matches "videoId":"XXXXXXXXXXX"
    const regex = /"videoId"\s*:\s*"([A-Za-z0-9_\-]{11})"/g;
    let m;
    while ((m = regex.exec(text)) !== null && ids.size < maxResults) {
      ids.add(m[1]);
    }
    // If none found, try href="/watch?v=..."
    if (ids.size === 0) {
      const regex2 = /\/watch\?v=([A-Za-z0-9_\-]{11})/g;
      while ((m = regex2.exec(text)) !== null && ids.size < maxResults) {
        ids.add(m[1]);
      }
    }
    const results = Array.from(ids).slice(0, maxResults).map(id => ({
      type: 'video',
      url: 'https://www.youtube.com/watch?v=' + id,
      embed: 'https://www.youtube.com/embed/' + id,
      title: null
    }));
    return results;
  } catch (err) {
    console.error('fetchYouTubeVideos error', err);
    return [];
  }
}

// API endpoint: /api/search?q=...
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

    // Run the scrapers in parallel (images, links, videos)
    const [images, links, videos] = await Promise.all([
      fetchDuckImages(q, 40),
      fetchDuckLinks(q, 20),
      fetchYouTubeVideos(q, 12)
    ]);

    // Merge and shuffle with some weighting so results are mixed
    const merged = [];
    // Add images (most likely)
    for (const it of images) merged.push(it);
    // Interleave videos
    for (let i = 0; i < videos.length; i++) {
      merged.splice(Math.floor((i + 1) * 3), 0, videos[i]); // insert video after a few images
    }
    // Append links at end
    for (const l of links) merged.push(l);

    // Deduplicate by url
    const seen = new Set();
    const dedup = [];
    for (const it of merged) {
      const key = it.url || it.embed || (it.source || '') + (it.title || '');
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(it);
    }

    // If no results, return helpful message
    if (dedup.length === 0) {
      return res.json({ results: [], note: 'No results found from scrapers for this keyword. Try a different keyword.' });
    }

    // Limit to 60 results
    return res.json({ results: dedup.slice(0, 60) });
  } catch (err) {
    console.error('api/search error', err);
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// fallback: serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Keyword Surprise server running on port ${PORT}`);
});
