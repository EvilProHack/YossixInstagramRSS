const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProfileData,
  excludeSuppressedPosts,
  extractPostsFromEmbeddedJson,
  generateRssXml,
  mergePosts,
  parsePreviousFeed,
  run
} = require('../generate-rss');

const oldPost = {
  id: '123',
  shortcode: 'STABLE_123',
  caption: 'Original caption',
  timestamp: '2026-07-21T10:00:00.000Z',
  imageUrl: 'https://example.com/original.jpg',
  isVideo: false,
  permalink: 'https://www.instagram.com/p/STABLE_123/'
};

test('DOM fallback does not invent a changing publication date', () => {
  const profile = buildProfileData('yossixworld', {
    domPosts: [{ shortcode: 'ABC', caption: 'Post', imageUrl: '', type: 'reel' }],
    embeddedPosts: [],
    ogTitle: 'YossixWorld (@yossixworld)',
    ogDesc: 'Profile'
  });

  assert.equal(profile.posts[0].timestamp, null);
  assert.equal(profile.posts[0].permalink, 'https://www.instagram.com/p/ABC/');
});

test('authenticated responses exclude recommendations owned by other accounts', () => {
  const posts = extractPostsFromEmbeddedJson([{
    items: [
      { pk: '1', code: 'OWN_POST', taken_at: 1780000000, user: { username: 'yossixworld' } },
      { pk: '2', code: 'RECOMMENDATION', taken_at: 1780000001, user: { username: 'other_account' } }
    ]
  }], 'yossixworld');

  assert.deepEqual(posts.map(post => post.shortcode), ['OWN_POST']);
});

test('an existing shortcode keeps its immutable date and content', () => {
  const scrapedAgain = {
    ...oldPost,
    caption: 'Caption changed by Instagram',
    timestamp: null,
    imageUrl: 'https://example.com/new-signed-url.jpg'
  };
  const result = mergePosts([scrapedAgain], [oldPost], '2026-07-22T12:59:00.000Z');

  assert.equal(result.newPosts, 0);
  assert.equal(result.posts[0].timestamp, oldPost.timestamp);
  assert.equal(result.posts[0].caption, oldPost.caption);
  assert.equal(result.posts[0].imageUrl, oldPost.imageUrl);
});

test('a temporarily missing post remains in the feed and cannot reappear as new', () => {
  const firstRefresh = mergePosts([], [oldPost], '2026-07-22T12:00:00.000Z');
  assert.deepEqual(firstRefresh.posts, [oldPost]);

  const secondRefresh = mergePosts([{ ...oldPost, timestamp: null }], firstRefresh.posts);
  assert.equal(secondRefresh.newPosts, 0);
  assert.equal(secondRefresh.posts[0].timestamp, oldPost.timestamp);
});

test('pinned old posts cannot appear before the newest publication', () => {
  const newestPost = {
    ...oldPost,
    shortcode: 'NEWEST_POST',
    timestamp: '2026-07-28T21:24:42.000Z'
  };
  const pinnedOldPost = {
    ...oldPost,
    shortcode: 'PINNED_OLD_POST',
    timestamp: '2025-04-24T15:05:29.000Z'
  };

  const result = mergePosts([pinnedOldPost, newestPost], []);

  assert.deepEqual(
    result.posts.map(post => post.shortcode),
    ['NEWEST_POST', 'PINNED_OLD_POST']
  );
});

test('migration baseline suppresses posts that Discord has already announced', () => {
  const visible = excludeSuppressedPosts(
    [oldPost, { ...oldPost, shortcode: 'FUTURE_POST' }],
    new Set([oldPost.shortcode])
  );

  assert.deepEqual(visible.map(post => post.shortcode), ['FUTURE_POST']);
});

test('RSS round-trip preserves shortcode, GUID and pubDate', () => {
  const xml = generateRssXml(
    { username: 'yossixworld', fullName: 'YossixWorld', biography: 'Bio' },
    [oldPost],
    { buildDate: '2026-07-21T10:05:00.000Z' }
  );
  const parsed = parsePreviousFeed(xml);

  assert.equal(parsed.posts.length, 1);
  assert.equal(parsed.posts[0].shortcode, oldPost.shortcode);
  assert.equal(parsed.posts[0].timestamp, oldPost.timestamp);
  assert.equal(parsed.formatVersion, 2);
  assert.match(xml, /<guid isPermaLink="true">https:\/\/www\.instagram\.com\/p\/STABLE_123\/<\/guid>/);
});

test('generator refuses to overwrite a good feed with an empty scrape', async () => {
  await assert.rejects(
    run({
      username: 'yossixworld',
      feedDir: process.cwd(),
      skipRemotePrevious: true,
      profileData: {
        username: 'yossixworld',
        fullName: 'YossixWorld',
        biography: '',
        posts: []
      }
    }),
    /Refusing to replace the RSS feed with an empty Instagram response/
  );
});
