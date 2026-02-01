import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';

const agent = await createAgent({
  name: 'tech-signals-agent',
  version: '1.0.0',
  description: 'Aggregated tech signals from HN, GitHub, and Lobsters for AI agents needing real-time tech context',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER: Fetch JSON ===
async function fetchJSON(url: string, timeout = 10000): Promise<any> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { 
      signal: controller.signal,
      headers: { 'User-Agent': 'tech-signals-agent/1.0' }
    });
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

// === DATA FETCHERS ===
async function fetchHNTop(limit: number = 10) {
  const ids = await fetchJSON('https://hacker-news.firebaseio.com/v0/topstories.json');
  const topIds = ids.slice(0, Math.min(limit, 30));
  const stories = await Promise.all(
    topIds.map((id: number) => fetchJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`))
  );
  return stories.map((s: any) => ({
    id: s.id,
    title: s.title,
    url: s.url,
    score: s.score,
    author: s.by,
    comments: s.descendants || 0,
    hnUrl: `https://news.ycombinator.com/item?id=${s.id}`,
    time: new Date(s.time * 1000).toISOString()
  }));
}

async function fetchHNSearch(query: string, limit: number = 10) {
  const data = await fetchJSON(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`
  );
  return data.hits.map((h: any) => ({
    id: h.objectID,
    title: h.title,
    url: h.url,
    score: h.points,
    author: h.author,
    comments: h.num_comments,
    hnUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
    time: h.created_at
  }));
}

async function fetchGitHubTrending(language: string = '', since: string = 'daily', limit: number = 10) {
  // Use GitHub search API to find recently popular repos
  const dateFrom = new Date();
  if (since === 'weekly') dateFrom.setDate(dateFrom.getDate() - 7);
  else if (since === 'monthly') dateFrom.setDate(dateFrom.getDate() - 30);
  else dateFrom.setDate(dateFrom.getDate() - 1);
  
  const dateStr = dateFrom.toISOString().split('T')[0];
  let query = `created:>${dateStr}`;
  if (language) query += `+language:${language}`;
  
  const data = await fetchJSON(
    `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=${limit}`
  );
  
  return data.items.map((r: any) => ({
    name: r.full_name,
    description: r.description,
    stars: r.stargazers_count,
    forks: r.forks_count,
    language: r.language,
    url: r.html_url,
    topics: r.topics?.slice(0, 5) || [],
    createdAt: r.created_at
  }));
}

async function fetchLobstersHot(limit: number = 10) {
  const data = await fetchJSON('https://lobste.rs/hottest.json');
  return data.slice(0, limit).map((a: any) => ({
    title: a.title,
    url: a.url,
    score: a.score,
    author: a.submitter_user?.username || a.submitter,
    comments: a.comment_count,
    tags: a.tags,
    lobstersUrl: a.short_id_url,
    time: a.created_at
  }));
}

async function fetchLobstersNewest(limit: number = 10) {
  const data = await fetchJSON('https://lobste.rs/newest.json');
  return data.slice(0, limit).map((a: any) => ({
    title: a.title,
    url: a.url,
    score: a.score,
    author: a.submitter_user?.username || a.submitter,
    comments: a.comment_count,
    tags: a.tags,
    lobstersUrl: a.short_id_url,
    time: a.created_at
  }));
}

// === FREE ENDPOINT ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview - top 3 items from each platform (HN, GitHub, Lobsters)',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const [hn, github, lobsters] = await Promise.all([
      fetchHNTop(3),
      fetchGitHubTrending('', 'daily', 3),
      fetchLobstersHot(3)
    ]);
    return {
      output: {
        hackerNews: hn,
        github: github,
        lobsters: lobsters,
        fetchedAt: new Date().toISOString(),
        sources: ['Hacker News API', 'GitHub API', 'Lobsters API']
      }
    };
  },
});

// === PAID ENDPOINT 1: HN Top Stories ($0.001) ===
addEntrypoint({
  key: 'hn-top',
  description: 'Top Hacker News stories with scores, comments, and metadata',
  input: z.object({
    limit: z.number().min(1).max(30).optional().default(10)
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const stories = await fetchHNTop(ctx.input.limit);
    return {
      output: {
        stories,
        count: stories.length,
        source: 'Hacker News Official API',
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 2: GitHub Trending ($0.002) ===
addEntrypoint({
  key: 'github-trending',
  description: 'Trending GitHub repositories by language and timeframe',
  input: z.object({
    language: z.string().optional().default(''),
    since: z.enum(['daily', 'weekly', 'monthly']).optional().default('daily'),
    limit: z.number().min(1).max(25).optional().default(10)
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const repos = await fetchGitHubTrending(ctx.input.language, ctx.input.since, ctx.input.limit);
    return {
      output: {
        repos,
        count: repos.length,
        filters: { language: ctx.input.language || 'all', since: ctx.input.since },
        source: 'GitHub Search API',
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 3: Lobsters Hot ($0.001) ===
addEntrypoint({
  key: 'lobsters-hot',
  description: 'Hot articles from Lobste.rs tech community',
  input: z.object({
    limit: z.number().min(1).max(25).optional().default(10)
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const articles = await fetchLobstersHot(ctx.input.limit);
    return {
      output: {
        articles,
        count: articles.length,
        source: 'Lobsters API',
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 4: Combined Tech Feed ($0.003) ===
addEntrypoint({
  key: 'tech-feed',
  description: 'Combined tech feed from all sources, sorted by recency',
  input: z.object({
    limit: z.number().min(1).max(50).optional().default(20)
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const perSource = Math.ceil(ctx.input.limit / 3);
    const [hn, github, lobsters] = await Promise.all([
      fetchHNTop(perSource),
      fetchGitHubTrending('', 'daily', perSource),
      fetchLobstersHot(perSource)
    ]);

    const feed = [
      ...hn.map((s: any) => ({ ...s, source: 'hackernews', type: 'story' })),
      ...github.map((r: any) => ({ ...r, source: 'github', type: 'repo' })),
      ...lobsters.map((a: any) => ({ ...a, source: 'lobsters', type: 'article' }))
    ].sort((a: any, b: any) => new Date(b.time || b.createdAt).getTime() - new Date(a.time || a.createdAt).getTime())
     .slice(0, ctx.input.limit);

    return {
      output: {
        feed,
        count: feed.length,
        sources: { hackernews: hn.length, github: github.length, lobsters: lobsters.length },
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 5: Topic Search ($0.002) ===
addEntrypoint({
  key: 'topic-search',
  description: 'Search HN stories and GitHub repos for a specific topic',
  input: z.object({
    query: z.string().min(1).max(100),
    limit: z.number().min(1).max(20).optional().default(10)
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const [hnResults, githubResults] = await Promise.all([
      fetchHNSearch(ctx.input.query, ctx.input.limit),
      fetchGitHubTrending(ctx.input.query, 'monthly', ctx.input.limit)
    ]);
    return {
      output: {
        query: ctx.input.query,
        hackerNews: hnResults,
        github: githubResults,
        totalResults: hnResults.length + githubResults.length,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === Serve icon ===
app.get('/icon.png', async (c) => {
  try {
    if (existsSync('./icon.png')) {
      const icon = readFileSync('./icon.png');
      return new Response(icon, { headers: { 'Content-Type': 'image/png' } });
    }
  } catch {}
  return c.text('Icon not found', 404);
});

// === ERC-8004 Registration ===
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "tech-signals-agent",
    description: "Aggregated tech signals from HN, GitHub, and Lobsters. 1 free + 5 paid endpoints via x402.",
    image: `${baseUrl}/icon.png`,
    services: [
      { name: "web", endpoint: baseUrl },
      { name: "A2A", endpoint: `${baseUrl}/.well-known/agent.json`, version: "0.3.0" }
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ["reputation"]
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`Tech Signals Agent running on port ${port}`);

export default { port, fetch: app.fetch };
