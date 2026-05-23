// /api/order-edits — surfaces POS orders that were edited after save.
//
// Edit detection rule:
//   write_date > create_date + 30s  (anything closer is just Odoo's normal
//   save round-trip, not a meaningful edit)
//
// Returns one row per edited order, with creator vs editor distinguished
// so a human can spot "Nafees created, Administrator edited" cases.
//
// Usage:
//   GET /api/order-edits?date=2026-05-23
//   GET /api/order-edits?from=2026-05-20&to=2026-05-23
//   GET /api/order-edits?days=7
//   GET /api/order-edits?config=27   (or 28, default both)
//
// Response shape:
// {
//   success: true,
//   range: { from, to },
//   summary: { total, edited, edit_pct, by_cashier: {...}, by_config: {...} },
//   edits: [ {id, name, date_order, create_date, create_user, write_date,
//             write_user, cashier, amount, partner, edit_gap_seconds,
//             edit_severity, config, state} ]
// }

export async function onRequest(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (context.request.method === 'OPTIONS') return new Response(null, { headers: cors });

  const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
  const ODOO_DB = 'main';
  const ODOO_UID = 2;
  const ODOO_API_KEY = context.env.ODOO_API_KEY;

  if (!ODOO_API_KEY) {
    return new Response(JSON.stringify({ success: false, error: 'ODOO_API_KEY not configured' }), { status: 500, headers: cors });
  }

  try {
    const url = new URL(context.request.url);
    const days = parseInt(url.searchParams.get('days') || '1', 10);
    const dateParam = url.searchParams.get('date');
    const fromParam = url.searchParams.get('from');
    const toParam = url.searchParams.get('to');
    const configParam = url.searchParams.get('config'); // '27' | '28' | 'all'

    // Build date range — defaults to today IST
    let fromUTC, toUTC;
    if (fromParam && toParam) {
      fromUTC = new Date(fromParam + 'T00:00:00+05:30');
      toUTC = new Date(toParam + 'T23:59:59+05:30');
    } else if (dateParam) {
      fromUTC = new Date(dateParam + 'T00:00:00+05:30');
      toUTC = new Date(dateParam + 'T23:59:59+05:30');
    } else {
      const now = new Date();
      toUTC = now;
      fromUTC = new Date(now.getTime() - days * 86400000);
    }
    const fromOdoo = fromUTC.toISOString().slice(0, 19).replace('T', ' ');
    const toOdoo = toUTC.toISOString().slice(0, 19).replace('T', ' ');

    // Config filter
    const configIds = configParam === '27' ? [27] : configParam === '28' ? [28] : [27, 28];

    // Pull ALL orders in range — we filter in JS so the response carries
    // both "total" and "edited" counts (useful for the edit % gauge).
    const orders = await odooSearchRead(
      ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY,
      'pos.order',
      [['config_id', 'in', configIds], ['date_order', '>=', fromOdoo], ['date_order', '<=', toOdoo]],
      ['id', 'name', 'date_order', 'create_date', 'create_uid', 'write_date', 'write_uid',
       'employee_id', 'cashier', 'amount_total', 'state', 'config_id', 'partner_id'],
      { limit: 5000, order: 'write_date desc' }
    );

    const EDIT_THRESHOLD_SECONDS = 30;
    const edits = [];
    const byCashier = {};
    const byConfig = {};

    for (const o of orders) {
      const created = new Date(o.create_date.replace(' ', 'T') + 'Z').getTime();
      const written = new Date(o.write_date.replace(' ', 'T') + 'Z').getTime();
      const gapSec = Math.round((written - created) / 1000);
      if (gapSec <= EDIT_THRESHOLD_SECONDS) continue;  // not a real edit

      const cashier = o.cashier || (o.employee_id ? o.employee_id[1] : '—');
      const creator = o.create_uid ? o.create_uid[1] : '—';
      const editor = o.write_uid ? o.write_uid[1] : '—';
      const configName = o.config_id ? o.config_id[1] : '—';

      // Severity heuristic for the human eye:
      // <1 hour: probably during same session, low concern
      // 1-12 hours: moderate, worth a look
      // >12 hours: high — order edited next day or later
      let severity = 'low';
      if (gapSec > 12 * 3600) severity = 'high';
      else if (gapSec > 3600) severity = 'medium';

      // Distinguish system-level edit (Administrator) from cashier edit
      const isSystemEdit = editor === 'Administrator' && creator !== 'Administrator';

      edits.push({
        id: o.id,
        name: o.name,
        date_order: o.date_order,
        create_date: o.create_date,
        create_user: creator,
        write_date: o.write_date,
        write_user: editor,
        cashier,
        amount: o.amount_total,
        partner: o.partner_id ? o.partner_id[1] : null,
        state: o.state,
        config: configName,
        config_id: o.config_id ? o.config_id[0] : null,
        edit_gap_seconds: gapSec,
        edit_severity: severity,
        is_system_edit: isSystemEdit,
      });

      byCashier[cashier] = (byCashier[cashier] || 0) + 1;
      byConfig[configName] = (byConfig[configName] || 0) + 1;
    }

    return new Response(JSON.stringify({
      success: true,
      range: { from: fromUTC.toISOString(), to: toUTC.toISOString() },
      summary: {
        total_orders: orders.length,
        edited: edits.length,
        edit_pct: orders.length > 0 ? Math.round(edits.length / orders.length * 10000) / 100 : 0,
        by_cashier: byCashier,
        by_config: byConfig,
        by_severity: {
          high: edits.filter(e => e.edit_severity === 'high').length,
          medium: edits.filter(e => e.edit_severity === 'medium').length,
          low: edits.filter(e => e.edit_severity === 'low').length,
        },
      },
      edits,
      tracking_enabled_at: '2026-05-23 11:00 IST',
    }), { headers: cors });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message, stack: e.stack }), {
      status: 500, headers: cors,
    });
  }
}

async function odooSearchRead(url, db, uid, apiKey, model, domain, fields, kwargs = {}) {
  const payload = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [db, uid, apiKey, model, 'search_read', [domain, fields]],
      kwargs,
    },
    id: Date.now(),
  };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d = await r.json();
  if (d.error) throw new Error('Odoo error: ' + JSON.stringify(d.error));
  return d.result || [];
}
