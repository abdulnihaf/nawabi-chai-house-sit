// Hub API — PIN login, FCM push subscribe, test push
// Used by native app and web hub for centralized authentication

export async function onRequest(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: corsHeaders});

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');
  const DB = context.env.DB;

  // Staff PIN directory — single source of truth for hub login
  // is_admin: sees ALL ops pages | role: determines default page set
  const STAFF = {
    // Admins (4 — full access)
    '0305': {name: 'Nihaf',     role: 'admin',      is_admin: true},
    '3697': {name: 'Yashwant',  role: 'admin',      is_admin: true},
    '3754': {name: 'Naveen',    role: 'admin',      is_admin: true},   // CFO — special dashboard
    '2026': {name: 'Zoya',      role: 'admin',      is_admin: true},
    // Managers (3)
    '8523': {name: 'Basheer',   role: 'manager',    is_admin: false},
    '6890': {name: 'Tanveer',   role: 'manager',    is_admin: false},
    '1234': {name: 'Waseem',    role: 'manager',    is_admin: false},
    // Cashiers (2)
    '7115': {name: 'Kesmat',    role: 'cashier',    is_admin: false},
    '8241': {name: 'Nafees',    role: 'cashier',    is_admin: false},
    // Runners (5)
    '3678': {name: 'Farzaib',   role: 'runner',     is_admin: false},
    '4421': {name: 'Ritiqu',    role: 'runner',     is_admin: false},
    '5503': {name: 'Anshu',     role: 'runner',     is_admin: false},
    '6604': {name: 'Shabeer',   role: 'runner',     is_admin: false},
    '7705': {name: 'Dhanush',   role: 'runner',     is_admin: false},
    // Other staff
    '3946': {name: 'Jafar',     role: 'staff',      is_admin: false}
  };

  // Pages visible per role (non-admin)
  const ROLE_PAGES = {
    runner:     ['runner'],
    cashier:    ['settlement', 'runner', 'runner-intel', 'kitchen-ops', 'chai-counter', 'shift'],
    manager:    ['settlement', 'runner', 'runner-intel', 'kitchen-ops', 'chai-counter', 'daily-pnl', 'inventory', 'live', 'sales', 'token-settlement', 'staffing', 'shift'],
    staff:      ['chai-counter', 'kitchen-ops']
  };

  try {
    // ── PIN Login ──
    if (action === 'login') {
      const pin = url.searchParams.get('pin');
      const staff = STAFF[pin];
      if (!staff) {
        return new Response(JSON.stringify({success: false, error: 'Invalid PIN'}), {headers: corsHeaders});
      }

      // Generate a simple session token
      const sessionToken = crypto.randomUUID();
      const staffId = staff.name.toLowerCase().replace(/\s+/g, '_');

      // Store session in D1 if available
      if (DB) {
        try {
          await DB.prepare(
            `INSERT OR REPLACE INTO hub_sessions (staff_id, name, role, is_admin, session_token, created_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`
          ).bind(staffId, staff.name, staff.role, staff.is_admin ? 1 : 0, sessionToken).run();
        } catch (e) {
          // Table might not exist yet — login still works without persistence
          console.log('hub_sessions insert failed (table may not exist):', e.message);
        }
      }

      const pages = staff.is_admin ? 'all' : (ROLE_PAGES[staff.role] || []);

      return new Response(JSON.stringify({
        success: true,
        name: staff.name,
        role: staff.role,
        is_admin: staff.is_admin,
        pages: pages,
        pin: pin,
        session_token: sessionToken,
        staff_id: staffId
      }), {headers: corsHeaders});
    }

    // ── FCM Push Subscribe ──
    if (action === 'push-subscribe') {
      if (context.request.method !== 'POST') {
        return new Response(JSON.stringify({error: 'POST required'}), {status: 405, headers: corsHeaders});
      }

      const body = await context.request.json();
      const {staff_id, fcm_token} = body;

      if (!staff_id || !fcm_token) {
        return new Response(JSON.stringify({error: 'staff_id and fcm_token required'}), {status: 400, headers: corsHeaders});
      }

      if (DB) {
        try {
          await DB.prepare(
            `INSERT INTO fcm_tokens (staff_id, fcm_token, updated_at)
             VALUES (?, ?, datetime('now'))
             ON CONFLICT(staff_id) DO UPDATE SET fcm_token = ?, updated_at = datetime('now')`
          ).bind(staff_id, fcm_token, fcm_token).run();
        } catch (e) {
          console.log('fcm_tokens insert failed:', e.message);
          return new Response(JSON.stringify({error: 'DB error: ' + e.message}), {status: 500, headers: corsHeaders});
        }
      }

      return new Response(JSON.stringify({success: true}), {headers: corsHeaders});
    }

    // ── Test Push ──
    if (action === 'test-push') {
      if (context.request.method !== 'POST') {
        return new Response(JSON.stringify({error: 'POST required'}), {status: 405, headers: corsHeaders});
      }

      const body = await context.request.json();
      const {fcm_token} = body;

      if (!fcm_token) {
        return new Response(JSON.stringify({error: 'fcm_token required'}), {status: 400, headers: corsHeaders});
      }

      const result = await sendFcmPush(context.env, fcm_token, {
        title: 'NCH Test Push',
        body: 'If you hear an alarm, push notifications are working!',
        tag: 'nch_test',
        url: 'https://nawabichaihouse.com/ops/'
      });

      return new Response(JSON.stringify(result), {headers: corsHeaders});
    }

    // ── Push to Staff (by staff_id) ──
    if (action === 'push-to-staff') {
      if (context.request.method !== 'POST') {
        return new Response(JSON.stringify({error: 'POST required'}), {status: 405, headers: corsHeaders});
      }

      const body = await context.request.json();
      const {staff_id, title, message, tag, url: pushUrl} = body;

      if (!staff_id || !title) {
        return new Response(JSON.stringify({error: 'staff_id and title required'}), {status: 400, headers: corsHeaders});
      }

      if (!DB) {
        return new Response(JSON.stringify({error: 'DB not configured'}), {status: 500, headers: corsHeaders});
      }

      const row = await DB.prepare('SELECT fcm_token FROM fcm_tokens WHERE staff_id = ?').bind(staff_id).first();
      if (!row || !row.fcm_token) {
        return new Response(JSON.stringify({error: 'No FCM token for staff'}), {status: 404, headers: corsHeaders});
      }

      const result = await sendFcmPush(context.env, row.fcm_token, {
        title: title,
        body: message || '',
        tag: tag || 'nch_alert',
        url: pushUrl || 'https://nawabichaihouse.com/ops/'
      });

      return new Response(JSON.stringify(result), {headers: corsHeaders});
    }

    // ── Push to Role (all staff with that role) ──
    if (action === 'push-to-role') {
      if (context.request.method !== 'POST') {
        return new Response(JSON.stringify({error: 'POST required'}), {status: 405, headers: corsHeaders});
      }

      const body = await context.request.json();
      const {role, title, message, tag, url: pushUrl} = body;

      if (!role || !title) {
        return new Response(JSON.stringify({error: 'role and title required'}), {status: 400, headers: corsHeaders});
      }

      // Find all staff IDs with this role
      const staffIds = Object.entries(STAFF)
        .filter(([, s]) => s.role === role)
        .map(([, s]) => s.name.toLowerCase().replace(/\s+/g, '_'));

      if (!DB || staffIds.length === 0) {
        return new Response(JSON.stringify({error: 'No staff for role or DB not configured'}), {status: 404, headers: corsHeaders});
      }

      const placeholders = staffIds.map(() => '?').join(',');
      const rows = await DB.prepare(`SELECT fcm_token FROM fcm_tokens WHERE staff_id IN (${placeholders})`)
        .bind(...staffIds).all();

      const results = [];
      for (const row of (rows.results || [])) {
        if (row.fcm_token) {
          const r = await sendFcmPush(context.env, row.fcm_token, {
            title, body: message || '', tag: tag || 'nch_alert',
            url: pushUrl || 'https://nawabichaihouse.com/ops/'
          });
          results.push(r);
        }
      }

      return new Response(JSON.stringify({success: true, sent: results.length}), {headers: corsHeaders});
    }

    return new Response(JSON.stringify({error: 'Unknown action: ' + action}), {status: 400, headers: corsHeaders});

  } catch (err) {
    return new Response(JSON.stringify({error: err.message}), {status: 500, headers: corsHeaders});
  }
}

// ── FCM v1 API Push ──
async function sendFcmPush(env, fcmToken, payload) {
  try {
    const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
    const projectId = sa.project_id;

    // Create JWT
    const now = Math.floor(Date.now() / 1000);
    const header = btoa(JSON.stringify({alg: 'RS256', typ: 'JWT'}));
    const claims = btoa(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    }));

    const signInput = header + '.' + claims;

    // Import private key and sign
    const pemContents = sa.private_key
      .replace(/-----BEGIN PRIVATE KEY-----/, '')
      .replace(/-----END PRIVATE KEY-----/, '')
      .replace(/\n/g, '');
    const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8', binaryKey, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['sign']
    );

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signInput)
    );

    const jwt = signInput + '.' + btoa(String.fromCharCode(...new Uint8Array(signature)));

    // Exchange JWT for access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return {success: false, error: 'OAuth token exchange failed', details: tokenData};
    }

    // Send FCM message (data-only so onMessageReceived always fires)
    const fcmRes = await fetch(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: {
            token: fcmToken,
            data: {
              title: payload.title || 'NCH',
              body: payload.body || '',
              tag: payload.tag || 'nch_alert',
              url: payload.url || ''
            },
            android: {
              priority: 'high'
            }
          }
        })
      }
    );

    const fcmData = await fcmRes.json();
    return {success: fcmRes.ok, fcm_response: fcmData};

  } catch (e) {
    return {success: false, error: e.message};
  }
}
