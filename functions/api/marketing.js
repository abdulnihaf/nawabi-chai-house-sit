// NCH Marketing API — Cloudflare Worker
// Handles: weekly post CRUD, image upload to R2, Google reviews tracking
// Bindings: DB (D1), MARKETING_IMAGES (R2), GOOGLE_PLACES_API_KEY (secret)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  try {
    switch (action) {
      // ─── WEEKLY POSTS ───
      case 'get-week':
        return await getWeek(url, env);
      case 'save-week':
        return await saveWeek(request, env);
      case 'update-post-status':
        return await updatePostStatus(request, env);

      // ─── IMAGE UPLOAD ───
      case 'upload-image':
        return await uploadImage(request, env);
      case 'get-image':
        return await getImage(url, env);

      // ─── GOOGLE REVIEWS ───
      case 'get-reviews':
        return await getReviews(url, env);
      case 'get-review-log':
        return await getReviewLog(url, env);

      // ─── POST LOG ───
      case 'log-publish':
        return await logPublish(request, env);
      case 'get-publish-log':
        return await getPublishLog(url, env);

      default:
        return json({ success: false, error: 'Unknown action' }, 400);
    }
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}

// ═══════════════════════════════════════════════════
// WEEKLY POSTS
// ═══════════════════════════════════════════════════

async function getWeek(url, env) {
  const weekStart = url.searchParams.get('week');
  const brand = url.searchParams.get('brand') || 'nch';
  if (!weekStart) return json({ success: false, error: 'Missing week param' }, 400);

  const posts = await env.DB.prepare(
    'SELECT * FROM marketing_posts WHERE brand = ? AND week_start = ? ORDER BY post_number'
  ).bind(brand, weekStart).all();

  return json({ success: true, posts: posts.results || [] });
}

async function saveWeek(request, env) {
  const body = await request.json();
  const { brand = 'nch', weekStart, posts } = body;
  if (!weekStart || !posts || !Array.isArray(posts)) {
    return json({ success: false, error: 'Missing weekStart or posts array' }, 400);
  }

  // Upsert each post
  const stmt = env.DB.prepare(`
    INSERT INTO marketing_posts (brand, week_start, post_number, post_date, time_slot, title, objective,
      prompt_ig, prompt_fb, prompt_google, caption_ig, caption_fb, caption_google,
      status_ig, status_fb, status_google, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(brand, week_start, post_number) DO UPDATE SET
      post_date=excluded.post_date, time_slot=excluded.time_slot, title=excluded.title,
      objective=excluded.objective, prompt_ig=excluded.prompt_ig, prompt_fb=excluded.prompt_fb,
      prompt_google=excluded.prompt_google, caption_ig=excluded.caption_ig, caption_fb=excluded.caption_fb,
      caption_google=excluded.caption_google, status_ig=excluded.status_ig, status_fb=excluded.status_fb,
      status_google=excluded.status_google, updated_at=datetime('now')
  `);

  const batch = posts.map(p => stmt.bind(
    brand, weekStart, p.post_number, p.post_date, p.time_slot, p.title, p.objective,
    p.prompt_ig || null, p.prompt_fb || null, p.prompt_google || null,
    p.caption_ig || null, p.caption_fb || null, p.caption_google || null,
    p.status_ig || 'pending', p.status_fb || 'pending', p.status_google || 'pending'
  ));

  await env.DB.batch(batch);
  return json({ success: true, saved: posts.length });
}

async function updatePostStatus(request, env) {
  const { brand = 'nch', weekStart, postNumber, platform, status } = await request.json();
  if (!weekStart || !postNumber || !platform || !status) {
    return json({ success: false, error: 'Missing required fields' }, 400);
  }

  const col = `status_${platform}`;
  const validCols = ['status_ig', 'status_fb', 'status_google'];
  if (!validCols.includes(col)) return json({ success: false, error: 'Invalid platform' }, 400);

  await env.DB.prepare(
    `UPDATE marketing_posts SET ${col} = ?, updated_at = datetime('now') WHERE brand = ? AND week_start = ? AND post_number = ?`
  ).bind(status, brand, weekStart, postNumber).run();

  return json({ success: true });
}

// ═══════════════════════════════════════════════════
// IMAGE UPLOAD (R2)
// ═══════════════════════════════════════════════════

async function uploadImage(request, env) {
  if (!env.MARKETING_IMAGES) {
    return json({ success: false, error: 'R2 bucket MARKETING_IMAGES not bound' }, 500);
  }

  const formData = await request.formData();
  const file = formData.get('image');
  const brand = formData.get('brand') || 'nch';
  const weekStart = formData.get('weekStart');
  const postNumber = formData.get('postNumber');
  const platform = formData.get('platform'); // ig, fb, google

  if (!file || !weekStart || !postNumber || !platform) {
    return json({ success: false, error: 'Missing image, weekStart, postNumber, or platform' }, 400);
  }

  // Key: nch/2026-03-25/post-01-ig.jpg
  const ext = file.name?.split('.').pop() || 'jpg';
  const key = `${brand}/${weekStart}/post-${String(postNumber).padStart(2, '0')}-${platform}.${ext}`;

  const arrayBuffer = await file.arrayBuffer();
  await env.MARKETING_IMAGES.put(key, arrayBuffer, {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
  });

  // Update the image_key in D1
  const colMap = { ig: 'image_key_ig', fb: 'image_key_fb', google: 'image_key_google' };
  const col = colMap[platform];
  if (col) {
    await env.DB.prepare(
      `UPDATE marketing_posts SET ${col} = ?, updated_at = datetime('now') WHERE brand = ? AND week_start = ? AND post_number = ?`
    ).bind(key, brand, weekStart, postNumber).run();
  }

  return json({ success: true, key, url: `/api/marketing?action=get-image&key=${encodeURIComponent(key)}` });
}

async function getImage(url, env) {
  if (!env.MARKETING_IMAGES) {
    return new Response('R2 not bound', { status: 500, headers: CORS });
  }

  const key = url.searchParams.get('key');
  if (!key) return new Response('Missing key', { status: 400, headers: CORS });

  const obj = await env.MARKETING_IMAGES.get(key);
  if (!obj) return new Response('Not found', { status: 404, headers: CORS });

  const headers = new Headers(CORS);
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=86400');

  return new Response(obj.body, { headers });
}

// ═══════════════════════════════════════════════════
// GOOGLE REVIEWS
// ═══════════════════════════════════════════════════

// NCH Google Place ID — resolved from coordinates/name
const NCH_PLACE_ID = 'ChIJq-hENv8XrjsRCjNPpTGIogY'; // Verified — 5.0★, 22 reviews

// IST date helpers (UTC+5:30)
function istNow() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}
function istDateStr(d) {
  return d.toISOString().slice(0, 10);
}
function istToday() {
  return istDateStr(istNow());
}

async function getReviews(url, env) {
  const brand = url.searchParams.get('brand') || 'nch';
  const forceRefresh = url.searchParams.get('refresh') === '1';
  const today = istToday();

  if (!env.GOOGLE_PLACES_KEY_MARKETING) {
    return json({ success: true, rating: '--', totalReviews: '--', newToday: '--', thisWeek: '--', note: 'Google API key not configured' });
  }

  // Always fetch live from Google Places API
  let liveRating = null, liveCount = null, lastUpdated = null;
  try {
    const placeId = brand === 'nch' ? NCH_PLACE_ID : NCH_PLACE_ID;
    const resp = await fetch(
      `https://places.googleapis.com/v1/places/${placeId}?fields=rating,userRatingCount&key=${env.GOOGLE_PLACES_KEY_MARKETING}`
    );
    const data = await resp.json();
    if (data.rating) {
      liveRating = data.rating;
      liveCount = data.userRatingCount || 0;
      lastUpdated = new Date().toISOString();

      // Save/update today's snapshot (IST day boundary)
      await env.DB.prepare(
        `INSERT OR REPLACE INTO review_snapshots (brand, snapshot_date, total_reviews, average_rating) VALUES (?, ?, ?, ?)`
      ).bind(brand, today, liveCount, liveRating).run();
    }
  } catch (e) {
    // If live fetch fails, fall back to today's cached snapshot
    const existing = await env.DB.prepare(
      'SELECT * FROM review_snapshots WHERE brand = ? AND snapshot_date = ? LIMIT 1'
    ).bind(brand, today).first();
    if (existing) {
      liveRating = existing.average_rating;
      liveCount = existing.total_reviews;
      lastUpdated = existing.snapshot_date + 'T00:00:00+05:30';
    }
  }

  if (liveRating === null) {
    return json({ success: true, rating: '--', totalReviews: '--', newToday: '--', thisWeek: '--', note: 'Could not fetch reviews' });
  }

  // "New Today": compare live count vs end-of-yesterday snapshot (IST 12am boundary)
  const yesterdayIST = istDateStr(new Date(istNow().getTime() - 86400000));
  const yesterdaySnap = await env.DB.prepare(
    'SELECT total_reviews FROM review_snapshots WHERE brand = ? AND snapshot_date = ? LIMIT 1'
  ).bind(brand, yesterdayIST).first();
  const newToday = yesterdaySnap ? liveCount - yesterdaySnap.total_reviews : 0;

  // "This Week": compare live count vs Monday's snapshot
  const istD = istNow();
  const day = istD.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(istD);
  monday.setUTCDate(monday.getUTCDate() + mondayOffset);
  const mondayStr = istDateStr(monday);
  const weekSnap = await env.DB.prepare(
    'SELECT total_reviews FROM review_snapshots WHERE brand = ? AND snapshot_date <= ? ORDER BY snapshot_date DESC LIMIT 1'
  ).bind(brand, mondayStr).first();
  const thisWeek = weekSnap ? liveCount - weekSnap.total_reviews : 0;

  return json({
    success: true,
    rating: liveRating,
    totalReviews: liveCount,
    newToday,
    thisWeek,
    lastUpdated,
  });
}

async function getReviewLog(url, env) {
  const brand = url.searchParams.get('brand') || 'nch';
  const limit = parseInt(url.searchParams.get('limit') || '30');

  const rows = await env.DB.prepare(
    'SELECT * FROM review_snapshots WHERE brand = ? ORDER BY snapshot_date DESC LIMIT ?'
  ).bind(brand, limit).all();

  return json({ success: true, snapshots: rows.results || [] });
}

// ═══════════════════════════════════════════════════
// PUBLISH LOG
// ═══════════════════════════════════════════════════

async function logPublish(request, env) {
  const { postId, brand = 'nch', platform, status, platformPostId, errorMessage } = await request.json();

  await env.DB.prepare(
    `INSERT INTO post_publish_log (post_id, brand, platform, status, platform_post_id, error_message) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(postId || null, brand, platform, status, platformPostId || null, errorMessage || null).run();

  return json({ success: true });
}

async function getPublishLog(url, env) {
  const brand = url.searchParams.get('brand') || 'nch';
  const limit = parseInt(url.searchParams.get('limit') || '50');

  const rows = await env.DB.prepare(
    'SELECT * FROM post_publish_log WHERE brand = ? ORDER BY published_at DESC LIMIT ?'
  ).bind(brand, limit).all();

  return json({ success: true, log: rows.results || [] });
}

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════

function getMonday(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  const diff = dt.getDate() - day + (day === 0 ? -6 : 1);
  dt.setDate(diff);
  dt.setHours(0, 0, 0, 0);
  return dt;
}
