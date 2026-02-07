export async function onRequest(context) {
  const corsHeaders = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json'};
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: corsHeaders});

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');
  const DB = context.env.DB;

  // PIN verification — matches Odoo POS employee PINs
  const PINS = {'6890': 'Tanveer', '7115': 'Md Kesmat', '3946': 'Jafar', '0305': 'Nihaf', '2026': 'Zoya', '3697': 'Yashwant'};
  const RUNNERS = {
    'counter': {id: 'counter', name: 'Cash Counter', barcode: 'POS-27'},
    64: {id: 64, name: 'FAROOQ', barcode: 'RUN001'},
    65: {id: 65, name: 'AMIN', barcode: 'RUN002'},
    66: {id: 66, name: 'NCH Runner 03', barcode: 'RUN003'},
    67: {id: 67, name: 'NCH Runner 04', barcode: 'RUN004'},
    68: {id: 68, name: 'NCH Runner 05', barcode: 'RUN005'}
  };

  try {
    if (action === 'verify-pin') {
      const pin = url.searchParams.get('pin');
      if (PINS[pin]) {
        return new Response(JSON.stringify({success: true, user: PINS[pin]}), {headers: corsHeaders});
      }
      return new Response(JSON.stringify({success: false, error: 'Invalid PIN'}), {headers: corsHeaders});
    }

    if (action === 'get-last-settlement') {
      const runnerId = url.searchParams.get('runner_id');
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});
      
      const result = await DB.prepare(`
        SELECT * FROM settlements WHERE runner_id = ? ORDER BY settled_at DESC LIMIT 1
      `).bind(runnerId).first();
      
      const baseline = '2026-02-04T17:00:00+05:30';
      return new Response(JSON.stringify({
        success: true,
        lastSettlement: result || null,
        periodStart: result ? result.settled_at : baseline
      }), {headers: corsHeaders});
    }

    if (action === 'settle' && context.request.method === 'POST') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});
      
      const body = await context.request.json();
      const {runner_id, runner_name, settled_by, period_start, period_end, tokens_amount, sales_amount, upi_amount, cash_settled, notes} = body;
      
      // Validate runner_id (can be 'counter' or numeric runner ID)
      const runner = RUNNERS[runner_id];
      if (!runner) return new Response(JSON.stringify({success: false, error: 'Invalid runner'}), {headers: corsHeaders});

      await DB.prepare(`
        INSERT INTO settlements (runner_id, runner_name, settled_at, settled_by, period_start, period_end, tokens_amount, sales_amount, upi_amount, cash_settled, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        String(runner_id), runner_name || runner.name, new Date().toISOString(), settled_by,
        period_start, period_end, tokens_amount || 0, sales_amount || 0, upi_amount || 0, cash_settled, notes || ''
      ).run();

      return new Response(JSON.stringify({success: true, message: 'Settlement recorded'}), {headers: corsHeaders});
    }

    if (action === 'history') {
      if (!DB) return new Response(JSON.stringify({success: false, error: 'Database not configured'}), {headers: corsHeaders});
      
      const runnerId = url.searchParams.get('runner_id');
      const limit = url.searchParams.get('limit') || 50;
      
      let query = 'SELECT * FROM settlements';
      let params = [];
      if (runnerId) {
        query += ' WHERE runner_id = ?';
        params.push(runnerId);
      }
      query += ' ORDER BY settled_at DESC LIMIT ?';
      params.push(limit);
      
      const results = await DB.prepare(query).bind(...params).all();
      return new Response(JSON.stringify({success: true, settlements: results.results}), {headers: corsHeaders});
    }

    return new Response(JSON.stringify({success: false, error: 'Invalid action'}), {headers: corsHeaders});
  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message}), {status: 500, headers: corsHeaders});
  }
}
