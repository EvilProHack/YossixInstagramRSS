const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { Feed } = require('feed');

async function scrapeInstagramProfile(username) {
  const profileUrl = `https://www.instagram.com/${username}/`;
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    console.log(`Navigating to ${profileUrl}...`);
    await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));

    const data = await page.evaluate(() => {
      try {
        var postLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
        var posts = [];
        var seen = new Set();
        postLinks.forEach(function(a) {
          var href = a.getAttribute('href');
          var match = href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
          if (!match) return;
          var shortcode = match[2];
          if (seen.has(shortcode)) return;
          seen.add(shortcode);
          var img = a.querySelector('img');
          posts.push({
            shortcode: shortcode,
            imageUrl: img ? img.src : '',
            caption: img ? (img.alt || '') : '',
            type: match[1],
          });
        });

        var ogTitle = '';
        var ogDesc = '';
        var ogImage = '';
        var el;
        el = document.querySelector('meta[property="og:title"]');
        if (el) ogTitle = el.content || '';
        el = document.querySelector('meta[property="og:description"], meta[name="description"]');
        if (el) ogDesc = el.content || '';
        el = document.querySelector('meta[property="og:image"]');
        if (el) ogImage = el.content || '';

        var embeddedPosts = [];
        try {
          var scripts = document.querySelectorAll('script[type="application/json"]');
          scripts.forEach(function(s) {
            try {
              var json = JSON.parse(s.textContent);
              var str = JSON.stringify(json);
              if (str.includes('edge_owner_to_timeline_media') || str.includes('taken_at_timestamp')) {
                embeddedPosts.push(json);
              }
            } catch(_) {}
          });
        } catch(_) {}

        return { domPosts: posts, embeddedPosts: embeddedPosts, ogTitle, ogDesc, ogImage };
      } catch(e) {
        return { error: e.message, domPosts: [], embeddedPosts: [] };
      }
    });

    const profileData = buildProfileData(username, data);
    return profileData;
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
  const richPosts = extractPostsFromEmbeddedJson(data.embeddedPosts || []);
  if (richPosts.length > 0) return { username, fullName, biography: data.ogDesc, profilePicUrl: data.ogImage, posts: richPosts.slice(0, 20) };
  
  const posts = (data.domPosts || []).map(p => ({
    id: p.shortcode,
    shortcode: p.shortcode,
    caption: p.caption || '',
    timestamp: new Date().toISOString(), // Fallback
    imageUrl: p.imageUrl || '',
    isVideo: p.type === 'reel',
    permalink: `https://www.instagram.com/p/${p.shortcode}/`,
  }));
  return { username, fullName, biography: data.ogDesc, profilePicUrl: data.ogImage, posts };
}

function extractPostsFromEmbeddedJson(jsonBlobs) {
  const posts = [];
  for (const blob of jsonBlobs) {
    const edges = findEdges(blob);
    for (const edge of edges) {
      const node = edge.node || edge;
      const shortcode = node.shortcode || node.code;
      if (!shortcode) continue;
      posts.push({
        id: node.id || node.pk || shortcode,
        shortcode,
        caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || node.caption?.text || '',
        timestamp: (node.taken_at_timestamp || node.taken_at) ? new Date((node.taken_at_timestamp || node.taken_at) * 1000).toISOString() : new Date().toISOString(),
        imageUrl: node.display_url || node.thumbnail_src || '',
        isVideo: node.is_video || node.media_type === 2,
        permalink: `https://www.instagram.com/p/${shortcode}/`,
      });
    }
    if (posts.length > 0) break;
  }
  return posts;
}

function findEdges(obj, depth = 0) {
  if (depth > 12 || !obj || typeof obj !== 'object') return [];
  if (obj.edge_owner_to_timeline_media?.edges) return obj.edge_owner_to_timeline_media.edges;
  const keys = Array.isArray(obj) ? [...obj.keys()] : Object.keys(obj);
  for (const key of keys) {
    const result = findEdges(obj[key], depth + 1);
    if (result.length > 0) return result;
  }
  return [];
}

async function run() {
  const username = process.argv[2] || 'yossixworld';
  const baseUrl = process.argv[3] || 'https://yossix-instagram-rss.web.app';
  
  try {
    const profileData = await scrapeInstagramProfile(username);
    const siteUrl = `https://www.instagram.com/${username}/`;
    const feed = new Feed({
      title: `${profileData.fullName} (@${username})`,
      description: profileData.biography,
      id: siteUrl,
      link: siteUrl,
      language: 'en',
      updated: new Date(),
      feedLinks: {
        rss: `${baseUrl}/feed/${username}.rss.xml`,
      },
    });

    profileData.posts.forEach(post => {
      feed.addItem({
        title: post.caption.slice(0, 100) || '(no caption)',
        id: post.permalink,
        link: post.permalink,
        description: post.caption,
        content: `<p><img src="${post.imageUrl}" /></p><p>${post.caption}</p>`,
        date: new Date(post.timestamp),
        image: post.imageUrl,
      });
    });

    const feedDir = path.join(__dirname, 'public', 'feed');
    if (!fs.existsSync(feedDir)) fs.mkdirSync(feedDir, { recursive: true });
    
    fs.writeFileSync(path.join(feedDir, `${username}.rss.xml`), feed.rss2());
    console.log(`Feed generated for @${username}`);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

run();
