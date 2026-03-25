// NCH Marketing API — Cloudflare Worker
// Handles: weekly post CRUD, image upload to R2, Google reviews tracking, Drive archiving
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

      // ─── GOOGLE DRIVE ───
      case 'upload-to-drive':
        return await uploadToDrive(request, env);
      case 'drive-status':
        return await driveStatus(url, env);

      // ─── GOOGLE AUTH (GMB + Drive) ───
      case 'gmb-performance':
        return await gmbPerformance(url, env);
      case 'google-auth':
      case 'gmb-auth':
        return await googleAuthRedirect(url, env);
      case 'google-callback':
      case 'gmb-callback':
        return await googleCallback(url, env);

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
  const { postId, brand = 'nch', platform, status, platformPostId, errorMessage, imageUrl, driveFileId } = await request.json();

  await env.DB.prepare(
    `INSERT INTO post_publish_log (post_id, brand, platform, status, platform_post_id, error_message, image_url, drive_file_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(postId || null, brand, platform, status, platformPostId || null, errorMessage || null, imageUrl || null, driveFileId || null).run();

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
// GMB ANALYTICS (Google Business Profile Performance)
// ═══════════════════════════════════════════════════

async function gmbPerformance(url, env) {
  const brand = url.searchParams.get('brand') || 'nch';
  const days = parseInt(url.searchParams.get('days') || '7');

  // Check for stored refresh token
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return json({ success: false, needsAuth: true, error: 'GOOGLE_CLIENT_ID/SECRET not configured' });
  }

  const accessToken = await getGoogleAccessToken(brand, env);
  if (!accessToken) {
    return json({ success: false, needsAuth: true, error: 'GMB not connected' });
  }

  // Get location name (cached in D1)
  let locationName;
  try {
    const cached = await env.DB.prepare('SELECT location_name FROM gmb_locations WHERE brand = ?').bind(brand).first();
    if (cached) {
      locationName = cached.location_name;
    } else {
      locationName = await discoverGMBLocation(accessToken, brand, env);
    }
  } catch {
    locationName = await discoverGMBLocation(accessToken, brand, env);
  }

  if (!locationName) {
    return json({ success: false, error: 'Could not find GMB location for ' + brand });
  }

  // Fetch performance metrics
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const perfResp = await fetch(
    `https://businessprofileperformance.googleapis.com/v1/${locationName}:fetchMultiDailyMetricsTimeSeries`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dailyMetrics: [
          'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
          'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
          'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
          'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
          'CALL_CLICKS',
          'WEBSITE_CLICKS',
          'BUSINESS_DIRECTION_REQUESTS',
        ],
        dailyRange: {
          startDate: { year: startDate.getFullYear(), month: startDate.getMonth() + 1, day: startDate.getDate() },
          endDate: { year: endDate.getFullYear(), month: endDate.getMonth() + 1, day: endDate.getDate() },
        },
      }),
    }
  );
  const perfData = await perfResp.json();

  if (perfData.error) {
    return json({ success: false, error: perfData.error.message || 'GMB API error' });
  }

  // Process response into flat metrics
  const metrics = {
    desktop_maps: 0, desktop_search: 0, mobile_maps: 0, mobile_search: 0,
    calls: 0, website_clicks: 0, directions: 0, daily_search: [],
  };

  const metricMap = {
    BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 'desktop_maps',
    BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'desktop_search',
    BUSINESS_IMPRESSIONS_MOBILE_MAPS: 'mobile_maps',
    BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 'mobile_search',
    CALL_CLICKS: 'calls',
    WEBSITE_CLICKS: 'website_clicks',
    BUSINESS_DIRECTION_REQUESTS: 'directions',
  };

  for (const series of (perfData.multiDailyMetricTimeSeries || [])) {
    const metricKey = metricMap[series.dailyMetric];
    if (!metricKey) continue;
    const dailyValues = series.dailySubEntityType?.[0]?.timeSeries?.datedValues || [];
    let total = 0;
    for (const dv of dailyValues) {
      const val = parseInt(dv.value || '0');
      total += val;
      if (metricKey === 'desktop_search' || metricKey === 'mobile_search') {
        const dateStr = `${dv.date.year}-${String(dv.date.month).padStart(2,'0')}-${String(dv.date.day).padStart(2,'0')}`;
        const existing = metrics.daily_search.find(d => d.date === dateStr);
        if (existing) existing.value += val;
        else metrics.daily_search.push({ date: dateStr, value: val });
      }
    }
    metrics[metricKey] = total;
  }

  metrics.daily_search.sort((a, b) => a.date.localeCompare(b.date));

  return json({ success: true, data: metrics });
}

async function discoverGMBLocation(accessToken, brand, env) {
  // Get accounts
  const acctResp = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  const acctData = await acctResp.json();
  if (!acctData.accounts?.length) return null;

  // Try each account for locations
  for (const account of acctData.accounts) {
    const locResp = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const locData = await locResp.json();
    if (locData.locations?.length) {
      const loc = locData.locations[0];
      // Cache it
      try {
        await env.DB.prepare(
          'INSERT OR REPLACE INTO gmb_locations (brand, location_name, account_name, updated_at) VALUES (?, ?, ?, datetime("now"))'
        ).bind(brand, loc.name, account.name).run();
      } catch { /* table might not exist yet */ }
      return loc.name;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════
// GOOGLE AUTH (unified — GMB + Drive)
// ═══════════════════════════════════════════════════

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/business.manage',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

async function googleAuthRedirect(url, env) {
  const brand = url.searchParams.get('brand') || 'nch';
  const returnTo = url.searchParams.get('return') || `/ops/marketing/organic/?brand=${brand}`;
  if (!env.GOOGLE_CLIENT_ID) {
    return json({ success: false, error: 'GOOGLE_CLIENT_ID not configured' }, 400);
  }
  const redirectUri = `${url.origin}/api/marketing?action=google-callback`;
  const state = encodeURIComponent(JSON.stringify({ brand, returnTo }));
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(env.GOOGLE_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(GOOGLE_SCOPES)}&access_type=offline&prompt=consent&state=${state}`;
  return Response.redirect(authUrl, 302);
}

async function googleCallback(url, env) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  let brand = 'nch', returnTo = '/ops/marketing/organic/';

  try {
    const state = JSON.parse(decodeURIComponent(url.searchParams.get('state') || '{}'));
    brand = state.brand || 'nch';
    returnTo = state.returnTo || `/ops/marketing/organic/?brand=${brand}`;
  } catch {}

  if (error) {
    return new Response(`<html><body><h2>Authorization Failed</h2><p>${error}</p><a href="${returnTo}">Back</a></body></html>`, {
      headers: { 'Content-Type': 'text/html', ...CORS },
    });
  }

  if (!code) {
    return json({ success: false, error: 'Missing authorization code' }, 400);
  }

  const redirectUri = `${url.origin}/api/marketing?action=google-callback`;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const tokens = await tokenResp.json();

  if (tokens.error) {
    return new Response(`<html><body><h2>Token Exchange Failed</h2><p>${tokens.error_description || tokens.error}</p><a href="${returnTo}">Back</a></body></html>`, {
      headers: { 'Content-Type': 'text/html', ...CORS },
    });
  }

  if (tokens.refresh_token) {
    try {
      await env.DB.prepare(
        'INSERT OR REPLACE INTO gmb_tokens (brand, refresh_token, access_token, token_expires_at, updated_at) VALUES (?, ?, ?, datetime("now", "+3500 seconds"), datetime("now"))'
      ).bind(brand, tokens.refresh_token, tokens.access_token || null).run();
    } catch (e) {
      return new Response(`<html><body><h2>Database Error</h2><p>${e.message}</p><p>Run the marketing-analytics migration first.</p></body></html>`, {
        headers: { 'Content-Type': 'text/html', ...CORS },
      });
    }
  }

  const sep = returnTo.includes('?') ? '&' : '?';
  return Response.redirect(`${url.origin}${returnTo}${sep}google=connected`, 302);
}

// Helper: get a valid Google access token from stored refresh token
async function getGoogleAccessToken(brand, env) {
  const row = await env.DB.prepare('SELECT refresh_token FROM gmb_tokens WHERE brand = ?').bind(brand).first();
  if (!row) return null;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: row.refresh_token,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const data = await tokenResp.json();
  return data.access_token || null;
}

// ═══════════════════════════════════════════════════
// GOOGLE DRIVE — Asset archiving
// ═══════════════════════════════════════════════════

async function driveStatus(url, env) {
  const brand = url.searchParams.get('brand') || 'nch';
  try {
    const row = await env.DB.prepare('SELECT refresh_token FROM gmb_tokens WHERE brand = ?').bind(brand).first();
    return json({ success: true, connected: !!row });
  } catch {
    return json({ success: true, connected: false });
  }
}

async function uploadToDrive(request, env) {
  const { brand = 'nch', weekStart, postNumber, platform, imageKey } = await request.json();
  if (!weekStart || !postNumber || !platform) {
    return json({ success: false, error: 'Missing weekStart, postNumber, or platform' }, 400);
  }

  // Get access token
  const accessToken = await getGoogleAccessToken(brand, env);
  if (!accessToken) {
    return json({ success: false, needsAuth: true, error: 'Google Drive not connected' });
  }

  // Get image from R2
  const r2Key = imageKey || `${brand}/${weekStart}/post-${String(postNumber).padStart(2, '0')}-${platform}.jpg`;
  const obj = env.MARKETING_IMAGES ? await env.MARKETING_IMAGES.get(r2Key) : null;
  if (!obj) {
    return json({ success: false, error: 'Image not found in R2: ' + r2Key }, 404);
  }

  const brandFolder = brand === 'nch' ? 'NCH Marketing' : 'HE Marketing';

  // Find or create folder hierarchy: brandFolder / Week-YYYY-MM-DD
  const rootFolderId = await findOrCreateFolder(accessToken, brandFolder, 'root', brand, env);
  const weekFolderName = `Week-${weekStart}`;
  const weekFolderId = await findOrCreateFolder(accessToken, weekFolderName, rootFolderId, brand, env);

  // Upload file
  const fileName = `post-${String(postNumber).padStart(2, '0')}-${platform}.${r2Key.split('.').pop() || 'jpg'}`;
  const contentType = obj.httpMetadata?.contentType || 'image/jpeg';
  const imageBytes = await obj.arrayBuffer();

  // Multipart upload to Drive
  const boundary = '---nch-drive-boundary';
  const metadata = JSON.stringify({
    name: fileName,
    parents: [weekFolderId],
  });

  const bodyParts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Transfer-Encoding: base64\r\n\r\n`,
  ];

  // Convert to base64 for multipart
  const base64 = arrayBufferToBase64(imageBytes);

  const multipartBody = bodyParts[0] + bodyParts[1] + base64 + `\r\n--${boundary}--`;

  const uploadResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });
  const fileData = await uploadResp.json();

  if (fileData.error) {
    return json({ success: false, error: fileData.error.message || 'Drive upload failed' });
  }

  // Make file viewable with link
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileData.id}/permissions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });

  const driveUrl = fileData.webViewLink || `https://drive.google.com/file/d/${fileData.id}/view`;
  const thumbnailUrl = `https://drive.google.com/thumbnail?id=${fileData.id}&sz=w200`;

  return json({
    success: true,
    driveFileId: fileData.id,
    driveUrl,
    thumbnailUrl,
  });
}

async function findOrCreateFolder(accessToken, folderName, parentId, brand, env) {
  const folderPath = parentId === 'root' ? folderName : `${parentId}/${folderName}`;

  // Check cache
  try {
    const cached = await env.DB.prepare(
      'SELECT folder_id FROM drive_folders WHERE brand = ? AND folder_path = ?'
    ).bind(brand, folderPath).first();
    if (cached) return cached.folder_id;
  } catch { /* table might not exist yet */ }

  // Search Drive for existing folder
  const q = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const searchResp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  const searchData = await searchResp.json();

  let folderId;
  if (searchData.files?.length) {
    folderId = searchData.files[0].id;
  } else {
    // Create folder
    const createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      }),
    });
    const createData = await createResp.json();
    folderId = createData.id;
  }

  // Cache
  try {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO drive_folders (brand, folder_path, folder_id) VALUES (?, ?, ?)'
    ).bind(brand, folderPath, folderId).run();
  } catch { /* table might not exist */ }

  return folderId;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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
