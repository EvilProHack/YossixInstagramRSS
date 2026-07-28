const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const MAX_FEED_ITEMS = 50;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeInstagramProfile(username, options = {}) {
  const attempts = options.attempts || 3;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const profile = await scrapeInstagramOnce(username);
      if (profile.posts.length === 0) {
        throw new Error('Instagram returned no posts (login wall, rate limit, or incomplete page)');
      }
      return profile;
    } catch (error) {
      lastError = error;
      console.warn(`Instagram attempt ${attempt}/${attempts} failed: ${error.message}`);
      if (attempt < attempts) await delay(attempt * 4000);
    }
  }

  lastError.code = 'INSTAGRAM_UNAVAILABLE';
  throw lastError;
}

async function scrapeInstagramOnce(username) {
  const profileUrl = `https://www.instagram.com/${username}/`;
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1600 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'accept-language': 'es-ES,es;q=0.9,en;q=0.8' });

    if (process.env.INSTAGRAM_SESSIONID) {
      await page.setCookie({
        name: 'sessionid',
        value: process.env.INSTAGRAM_SESSIONID,
        domain: '.instagram.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None'
      });
    }

    const responsePromises = [];
    page.on('response', response => {
      const url = response.url();
      if (url.includes('/graphql/query') || url.includes('/api/v1/feed/user/')) {
        responsePromises.push(response.json().catch(() => null));
      }
    });

    console.log(`Navigating to ${profileUrl}...`);
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('a[href*="/p/"], a[href*="/reel/"]', { timeout: 15000 }).catch(() => {});
    await delay(3000);

    const data = await page.evaluate(() => {
      const postLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
      const posts = [];
      const seen = new Set();

      postLinks.forEach(a => {
        const href = a.getAttribute('href') || '';
        const match = href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
        if (!match || seen.has(match[2])) return;
        seen.add(match[2]);
        const img = a.querySelector('img');
        posts.push({
          shortcode: match[2],
          imageUrl: img ? img.src : '',
          caption: img ? (img.alt || '') : '',
          type: match[1]
        });
      });

      const getMeta = selector => document.querySelector(selector)?.content || '';
      const embeddedPosts = [];
      document.querySelectorAll('script[type="application/json"]').forEach(script => {
        try {
          const parsed = JSON.parse(script.textContent);
          const serialized = JSON.stringify(parsed);
          if (
            serialized.includes('edge_owner_to_timeline_media') ||
            serialized.includes('taken_at_timestamp') ||
            serialized.includes('xdt_api__v1__feed__user_timeline')
          ) {
            embeddedPosts.push(parsed);
          }
        } catch (_) {}
      });

      return {
        domPosts: posts,
        embeddedPosts,
        ogTitle: getMeta('meta[property="og:title"]'),
        ogDesc: getMeta('meta[property="og:description"], meta[name="description"]'),
        ogImage: getMeta('meta[property="og:image"]')
      };
    });

    const networkJson = (await Promise.all(responsePromises)).filter(Boolean);
    data.embeddedPosts.push(...networkJson);
    return buildProfileData(username, data);
  } finally {
    await browser.close();
  }
}

function buildProfileData(username, data) {
  let fullName = username;
  if (data.ogTitle) {
    const nameMatch = data.ogTitle.match(/^(.+?)(?:\s*\(@)/);
    fullName = nameMatch ? nameMatch[1].trim() : data.ogTitle.split('•')[0].trim();
  }
  if (fullName.toLowerCase() === 'instagram') fullName = username;

  const richPosts = extractPostsFromEmbeddedJson(data.embeddedPosts || [], username);
  const byShortcode = new Map(richPosts.map(post => [post.shortcode, post]));

  // Authenticated profile pages contain recommended posts from other users.
  // DOM links have no reliable owner metadata, so use them only when Instagram
  // did not provide any structured profile posts at all.
  if (richPosts.length === 0) {
    for (const domPost of data.domPosts || []) {
      if (byShortcode.has(domPost.shortcode)) continue;
      byShortcode.set(domPost.shortcode, {
        id: domPost.shortcode,
        shortcode: domPost.shortcode,
        caption: domPost.caption || '',
        timestamp: null,
        imageUrl: domPost.imageUrl || '',
        isVideo: domPost.type === 'reel',
        permalink: canonicalPermalink(domPost.shortcode)
      });
    }
  }

  return {
    username,
    fullName,
    biography: data.ogDesc || '',
    profilePicUrl: data.ogImage || '',
    posts: [...byShortcode.values()].slice(0, 30)
  };
}

function extractPostsFromEmbeddedJson(jsonBlobs, expectedUsername = '') {
  const nodes = [];
  for (const blob of jsonBlobs) collectPostNodes(blob, nodes);

  const posts = [];
  const seen = new Set();
  for (const node of nodes) {
    const shortcode = node.shortcode || node.code;
    if (!shortcode || seen.has(shortcode)) continue;
    const ownerUsername = node.owner?.username || node.user?.username || node.owner_username || '';
    if (
      expectedUsername && ownerUsername &&
      ownerUsername.toLowerCase() !== expectedUsername.toLowerCase()
    ) continue;
    seen.add(shortcode);

    const rawTimestamp = node.taken_at_timestamp || node.taken_at;
    posts.push({
      id: String(node.id || node.pk || shortcode),
      shortcode,
      caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || node.caption?.text || node.caption || '',
      timestamp: rawTimestamp ? new Date(Number(rawTimestamp) * 1000).toISOString() : null,
      imageUrl: node.display_url || node.thumbnail_src || node.image_versions2?.candidates?.[0]?.url || '',
      isVideo: Boolean(node.is_video || node.media_type === 2),
      permalink: canonicalPermalink(shortcode)
    });
  }
  return posts;
}

function collectPostNodes(value, result, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 14) return;

  if (Array.isArray(value)) {
    for (const child of value) collectPostNodes(child, result, depth + 1);
    return;
  }

  if ((value.shortcode || value.code) && (value.id || value.pk || value.taken_at || value.taken_at_timestamp)) {
    result.push(value);
  }

  for (const child of Object.values(value)) collectPostNodes(child, result, depth + 1);
}

function canonicalPermalink(shortcode) {
  // Keep /p/ for both posts and reels. This was the historical GUID format and
  // changing it would make RSS clients announce every existing reel again.
  return `https://www.instagram.com/p/${shortcode}/`;
}

function shortcodeFromUrl(value) {
  const match = String(value || '').match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : '';
}

function escapeXml(value) {
  return String(value || '').replace(/[<>&"']/g, character => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;'
  })[character]);
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function cdata(value) {
  return `<![CDATA[${String(value || '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function tagValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) return '';
  const value = match[1].trim();
  const cdataMatch = value.match(/^<!\[CDATA\[([\s\S]*)]]>$/);
  return decodeXml(cdataMatch ? cdataMatch[1].replace(/]]]]><!\[CDATA\[>/g, ']]>') : value);
}

function parsePreviousFeed(xml) {
  if (!xml || !xml.includes('<rss')) return { posts: [], lastBuildDate: null };
  const posts = [];
  const seen = new Set();
  const itemMatches = xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi);

  for (const match of itemMatches) {
    const item = match[1];
    const link = tagValue(item, 'link');
    const guid = tagValue(item, 'guid');
    const shortcode = shortcodeFromUrl(link) || shortcodeFromUrl(guid);
    if (!shortcode || seen.has(shortcode)) continue;
    seen.add(shortcode);
    const enclosure = item.match(/<enclosure\b[^>]*\burl=(?:"([^"]*)"|'([^']*)')[^>]*>/i);
    const pubDate = tagValue(item, 'pubDate');
    const parsedDate = Date.parse(pubDate);

    posts.push({
      id: shortcode,
      shortcode,
      caption: tagValue(item, 'description'),
      timestamp: Number.isNaN(parsedDate) ? null : new Date(parsedDate).toISOString(),
      imageUrl: decodeXml(enclosure?.[1] || enclosure?.[2] || ''),
      isVideo: false,
      permalink: canonicalPermalink(shortcode)
    });
  }

  const buildDateText = tagValue(xml.split(/<item\b/i)[0], 'lastBuildDate');
  const buildDate = Date.parse(buildDateText);
  return {
    posts,
    lastBuildDate: Number.isNaN(buildDate) ? null : new Date(buildDate).toISOString()
  };
}

function combinePreviousFeeds(previousFeeds) {
  const posts = [];
  const seen = new Set();
  let lastBuildDate = null;

  for (const feed of previousFeeds) {
    if (!feed) continue;
    if (feed.lastBuildDate && (!lastBuildDate || feed.lastBuildDate > lastBuildDate)) {
      lastBuildDate = feed.lastBuildDate;
    }
    for (const post of feed.posts || []) {
      if (!post.shortcode || seen.has(post.shortcode)) continue;
      seen.add(post.shortcode);
      posts.push(post);
    }
  }
  return { posts, lastBuildDate };
}

function mergePosts(scrapedPosts, previousPosts, discoveredAt = new Date().toISOString()) {
  const previousByShortcode = new Map(previousPosts.map(post => [post.shortcode, post]));
  const merged = [];
  const seen = new Set();
  let newPosts = 0;

  for (const scraped of scrapedPosts) {
    if (!scraped.shortcode || seen.has(scraped.shortcode)) continue;
    seen.add(scraped.shortcode);
    const previous = previousByShortcode.get(scraped.shortcode);
    if (previous) {
      // RSS entries are immutable once published. In particular, never replace
      // their pubDate with the time of a later scrape.
      merged.push({
        ...scraped,
        caption: previous.caption || scraped.caption,
        imageUrl: previous.imageUrl || scraped.imageUrl,
        timestamp: previous.timestamp || scraped.timestamp || discoveredAt,
        permalink: canonicalPermalink(scraped.shortcode)
      });
    } else {
      newPosts += 1;
      merged.push({
        ...scraped,
        timestamp: scraped.timestamp || discoveredAt,
        permalink: canonicalPermalink(scraped.shortcode)
      });
    }
  }

  // Posts missing from one Instagram response remain in the feed, preventing
  // disappear/reappear cycles from becoming duplicate Discord notifications.
  for (const previous of previousPosts) {
    if (!previous.shortcode || seen.has(previous.shortcode)) continue;
    seen.add(previous.shortcode);
    merged.push(previous);
  }

  // Instagram keeps pinned posts at the top of the profile even when they are
  // years older than the latest upload. RSS readers expect reverse
  // chronological order and some only inspect the first item in each poll.
  // Keep the feed ordered by the immutable publication date, not profile order.
  merged.sort((left, right) => {
    const leftTime = Date.parse(left.timestamp || '');
    const rightTime = Date.parse(right.timestamp || '');
    const safeLeftTime = Number.isNaN(leftTime) ? 0 : leftTime;
    const safeRightTime = Number.isNaN(rightTime) ? 0 : rightTime;
    return safeRightTime - safeLeftTime;
  });

  return { posts: merged.slice(0, MAX_FEED_ITEMS), newPosts };
}

function loadSuppressedShortcodes(username, stateDir = path.join(__dirname, 'state')) {
  const statePath = path.join(stateDir, `${username}-seen.json`);
  if (!fs.existsSync(statePath)) return new Set();
  const values = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!Array.isArray(values)) throw new Error(`Invalid seen-shortcode state: ${statePath}`);
  return new Set(values.map(String));
}

function excludeSuppressedPosts(posts, suppressedShortcodes) {
  return posts.filter(post => !suppressedShortcodes.has(post.shortcode));
}

function generateRssXml(profileData, posts, options = {}) {
  const username = profileData.username;
  const baseUrl = options.baseUrl || 'https://yossix-instagram-rss.web.app';
  const buildDate = new Date(options.buildDate || Date.now());
  const siteUrl = `https://www.instagram.com/${username}/`;

  let xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(profileData.fullName)} (@${escapeXml(username)})</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>${escapeXml(profileData.biography)}</description>
    <lastBuildDate>${buildDate.toUTCString()}</lastBuildDate>
    <language>es</language>
    <ttl>5</ttl>
    <atom:link href="${escapeXml(baseUrl)}/feed/${escapeXml(username)}.rss.xml" rel="self" type="application/rss+xml"/>
`;

  for (const post of posts) {
    const title = truncate(post.caption, 100) || '(sin texto)';
    const description = post.caption || '';
    const imageUrl = post.imageUrl || '';
    const permalink = canonicalPermalink(post.shortcode);
    const pubDate = new Date(post.timestamp).toUTCString();
    const content = `${imageUrl ? `<p><img src="${escapeXml(imageUrl)}" /></p>` : ''}<p>${escapeXml(description).replace(/\n/g, '<br/>')}</p>`;

    xml += `    <item>
      <title>${cdata(title)}</title>
      <link>${escapeXml(permalink)}</link>
      <guid isPermaLink="true">${escapeXml(permalink)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${cdata(description)}</description>
      <content:encoded>${cdata(content)}</content:encoded>
${imageUrl ? `      <enclosure url="${escapeXml(imageUrl)}" length="0" type="image/jpeg" />\n` : ''}    </item>
`;
  }

  return `${xml}  </channel>\n</rss>\n`;
}

async function fetchPreviousFeed(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parsePreviousFeed(await response.text());
    console.log(`Loaded ${parsed.posts.length} previous item(s) from the deployed feed`);
    return parsed;
  } catch (error) {
    console.warn(`Could not load deployed feed: ${error.message}`);
    return null;
  }
}

async function run(options = {}) {
  const username = options.username || process.argv[2] || 'yossixworld';
  const baseUrl = options.baseUrl || process.argv[3] || 'https://yossix-instagram-rss.web.app';
  const feedDir = options.feedDir || path.join(__dirname, 'public', 'feed');
  const outputPath = path.join(feedDir, `${username}.rss.xml`);
  const previousFeeds = [];

  if (fs.existsSync(outputPath)) {
    const localPrevious = parsePreviousFeed(fs.readFileSync(outputPath, 'utf8'));
    console.log(`Loaded ${localPrevious.posts.length} previous item(s) from local state`);
    previousFeeds.push(localPrevious);
  }

  if (!options.skipRemotePrevious && process.env.SKIP_REMOTE_PREVIOUS !== '1') {
    const previousUrl = options.previousFeedUrl || process.env.PREVIOUS_FEED_URL ||
      `${baseUrl}/feed/${username}.rss.xml`;
    previousFeeds.push(await fetchPreviousFeed(previousUrl));
  }

  const previous = combinePreviousFeeds(previousFeeds);
  const profileData = options.profileData || await scrapeInstagramProfile(username, options.scrapeOptions);
  if (!profileData.posts || profileData.posts.length === 0) {
    throw new Error('Refusing to replace the RSS feed with an empty Instagram response');
  }

  // This migration baseline contains entries already announced before stateful
  // deduplication was introduced. They must not re-enter the repaired feed and
  // trigger one final Discord notification after the currently empty live feed.
  const suppressedShortcodes = options.suppressedShortcodes || loadSuppressedShortcodes(username);
  const visibleScrapedPosts = excludeSuppressedPosts(profileData.posts, suppressedShortcodes);
  const visiblePreviousPosts = excludeSuppressedPosts(previous.posts, suppressedShortcodes);
  const now = new Date().toISOString();
  const merged = mergePosts(visibleScrapedPosts, visiblePreviousPosts, now);

  const buildDate = merged.newPosts > 0 || !previous.lastBuildDate ? now : previous.lastBuildDate;
  const xml = generateRssXml(profileData, merged.posts, { baseUrl, buildDate });
  fs.mkdirSync(feedDir, { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  fs.writeFileSync(temporaryPath, xml, 'utf8');
  fs.renameSync(temporaryPath, outputPath);

  console.log(
    `Feed generated for @${username}: ${merged.posts.length} item(s), ` +
    `${merged.newPosts} genuinely new, ${profileData.posts.length - visibleScrapedPosts.length} suppressed as already seen`
  );
  return { outputPath, posts: merged.posts, newPosts: merged.newPosts };
}

if (require.main === module) {
  run()
    .then(() => writeGitHubOutput('feed_ready', 'true'))
    .catch(error => {
      if (error.code === 'INSTAGRAM_UNAVAILABLE') {
        console.warn(`No update: ${error.message}. The deployed feed was left untouched.`);
        writeGitHubOutput('feed_ready', 'false');
        return;
      }
      console.error('Error:', error.message);
      process.exitCode = 1;
    });
}

function writeGitHubOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8');
}

module.exports = {
  buildProfileData,
  canonicalPermalink,
  combinePreviousFeeds,
  extractPostsFromEmbeddedJson,
  excludeSuppressedPosts,
  generateRssXml,
  loadSuppressedShortcodes,
  mergePosts,
  parsePreviousFeed,
  run,
  scrapeInstagramProfile,
  shortcodeFromUrl
};
