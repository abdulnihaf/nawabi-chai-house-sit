// NCH Ops Cockpit — Basheer's live discrepancy-hunting dashboard API
// One endpoint, seven actions. Every call pulls fresh from Odoo + Razorpay + D1.
//
// Actions:
//   summary       — totals + health flags for a time window
//   orders        — every pos.order with line items + payment breakdown
//   razorpay      — every QR payment with Odoo match status
//   runners       — per-runner settlement trail
//   discrepancies — 7 auto-detected issue types with evidence
//   drilldown     — single order deep dive
//   gaps          — silent-gap detector (no POS27 activity > N min)
//
// Every action accepts: ?from=ISO&to=ISO (UTC timestamps)
// Optional filters: &pos_ids=27,28&pm_ids=37,38

const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
const ODOO_DB = 'main';
const ODOO_UID = 2;

const COUNTER_QR = 'qr_SBdtUCLSHVfRtT';
const RUNNER_COUNTER_QR = 'qr_SBuDBQDKrC8Bch';
const RUNNER_QRS = [
  {qr_id: 'qr_SPTqwgC6ssVDDb', code: 'RUN001', partner_id: 64},
  {qr_id: 'qr_SPTrTvvh9AKsW0', code: 'RUN002', partner_id: 65},
  {qr_id: 'qr_SBgTo2a39kYmET', code: 'RUN003', partner_id: 66},
  {qr_id: 'qr_SBgTtFrfddY4AW', code: 'RUN004', partner_id: 67},
  {qr_id: 'qr_SBgTyFKUsdwLe1', code: 'RUN005', partner_id: 68},
];

const PM_NAMES = {37:'Cash', 38:'UPI', 39:'Card', 40:'RunnerLedger', 46:'Swiggy', 47:'Zomato', 48:'TokenIssue', 49:'Comp', 50:'WABA-COD', 51:'WABA-UPI'};
const POS_NAMES = {27:'CashCounter', 28:'RunnerCounter', 29:'Delivery'};

// 15 valid MWR tuples (method:pos:runner) — anything outside is invalid
const VALID_MWR = new Set([
  '37:27:0','38:27:0','39:27:0','49:27:0',
  '48:27:64','48:27:65','48:27:66','48:27:67','48:27:68',
  '40:28:64','40:28:65','40:28:66','40:28:67','40:28:68',
  '38:28:0',
]);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: corsHeaders});

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action') || 'summary';
  const fromISO = url.searchParams.get('from');
  const toISO = url.searchParams.get('to') || new Date().toISOString();

  if (!fromISO) return json({success:false, error:'from required'}, 400);

  const from = new Date(fromISO);
  const to = new Date(toISO);
  if (isNaN(from) || isNaN(to)) return json({success:false, error:'invalid timestamps'}, 400);

  const posIds = (url.searchParams.get('pos_ids') || '27,28,29').split(',').map(Number);
  const pmIds = (url.searchParams.get('pm_ids') || '37,38,39,40,48,49').split(',').map(Number);

  const env = {
    ODOO_API_KEY: context.env.ODOO_API_KEY,
    RAZORPAY_KEY: context.env.RAZORPAY_KEY,
    RAZORPAY_SECRET: context.env.RAZORPAY_SECRET,
    DB: context.env.DB,
  };

  try {
    let result;
    switch (action) {
      case 'summary':       result = await getSummary(env, from, to, posIds); break;
      case 'orders':        result = await getOrders(env, from, to, posIds, pmIds); break;
      case 'razorpay':      result = await getRazorpay(env, from, to); break;
      case 'runners':       result = await getRunners(env, from, to); break;
      case 'discrepancies': result = await getDiscrepancies(env, from, to, posIds); break;
      case 'drilldown':     result = await getDrilldown(env, url.searchParams.get('order_id')); break;
      case 'gaps':          result = await getGaps(env, from, to, parseInt(url.searchParams.get('threshold_min') || '10')); break;
      default:              return json({success:false, error:'unknown action'}, 400);
    }
    return json({success:true, action, from:from.toISOString(), to:to.toISOString(), ...result});
  } catch (e) {
    return json({success:false, error: e.message, stack: e.stack}, 500);
  }
}

function json(obj, status=200) { return new Response(JSON.stringify(obj), {status, headers: corsHeaders}); }

// ═══════════════════════════════════════════════════════════════
// ODOO HELPERS
// ═══════════════════════════════════════════════════════════════

async function odooCall(apiKey, model, method, args, kwargs = {}) {
  const r = await fetch(ODOO_URL, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0', method:'call', id: Date.now(), params:{
      service:'object', method:'execute_kw',
      args:[ODOO_DB, ODOO_UID, apiKey, model, method, args, kwargs],
    }})
  });
  const d = await r.json();
  if (d.error) throw new Error(`Odoo ${model}.${method}: ${d.error.data?.message || JSON.stringify(d.error)}`);
  return d.result;
}

function fmtOdoo(iso) { return new Date(iso).toISOString().slice(0,19).replace('T',' '); }

async function fetchOrdersWithPayments(apiKey, fromISO, toISO, posIds) {
  const orders = await odooCall(apiKey, 'pos.order', 'search_read',
    [[['config_id','in',posIds],['date_order','>=',fmtOdoo(fromISO)],['date_order','<=',fmtOdoo(toISO)],['state','in',['paid','done','invoiced','posted']]]],
    {fields:['id','name','date_order','amount_total','amount_paid','partner_id','config_id','payment_ids','session_id','pos_reference','user_id','employee_id','lines'], order:'date_order asc', limit: 2000});

  const paymentIds = orders.flatMap(o => o.payment_ids || []);
  let payments = [];
  if (paymentIds.length) {
    payments = await odooCall(apiKey, 'pos.payment', 'search_read',
      [[['id','in',paymentIds]]],
      {fields:['id','amount','payment_date','payment_method_id','pos_order_id'], limit: 5000});
  }
  return {orders, payments};
}

// ═══════════════════════════════════════════════════════════════
// RAZORPAY HELPERS
// ═══════════════════════════════════════════════════════════════

async function fetchQrPayments(key, secret, qrId, fromUnix, toUnix) {
  const auth = btoa(key + ':' + secret);
  const out = [];
  let skip = 0;
  for (let page = 0; page < 10; page++) {
    const r = await fetch(`https://api.razorpay.com/v1/payments/qr_codes/${qrId}/payments?count=100&skip=${skip}&from=${fromUnix}&to=${toUnix}`,
      {headers:{'Authorization':'Basic ' + auth}});
    const d = await r.json();
    if (d.error || !d.items?.length) break;
    out.push(...d.items.filter(p => p.status === 'captured'));
    if (d.items.length < 100) break;
    skip += 100;
  }
  return out;
}

async function fetchAllRzp(key, secret, from, to) {
  if (!key || !secret) return {counter:[], runnerCounter:[], runners:{}};
  const fromUnix = Math.floor(from.getTime()/1000);
  const toUnix = Math.floor(to.getTime()/1000);
  const [counter, runnerCounter, ...runners] = await Promise.all([
    fetchQrPayments(key, secret, COUNTER_QR, fromUnix, toUnix),
    fetchQrPayments(key, secret, RUNNER_COUNTER_QR, fromUnix, toUnix),
    ...RUNNER_QRS.map(r => fetchQrPayments(key, secret, r.qr_id, fromUnix, toUnix)),
  ]);
  const runnerMap = {};
  RUNNER_QRS.forEach((r, i) => { runnerMap[r.code] = runners[i]; });
  return {counter, runnerCounter, runners: runnerMap};
}

// ═══════════════════════════════════════════════════════════════
// ACTION: summary
// ═══════════════════════════════════════════════════════════════

async function getSummary(env, from, to, posIds) {
  const [{orders, payments}, rzp, d1Data] = await Promise.all([
    fetchOrdersWithPayments(env.ODOO_API_KEY, from.toISOString(), to.toISOString(), posIds),
    fetchAllRzp(env.RAZORPAY_KEY, env.RAZORPAY_SECRET, from, to),
    fetchD1Summary(env.DB, from, to),
  ]);

  // PM totals across selected POS
  const pmTotals = {};
  const posPmTotals = {};
  for (const p of payments) {
    const pm = p.payment_method_id?.[0];
    const orderId = p.pos_order_id?.[0];
    const order = orders.find(o => o.id === orderId);
    if (!order) continue;
    const pos = order.config_id?.[0];
    pmTotals[pm] = (pmTotals[pm] || 0) + (p.amount || 0);
    const key = `${pos}:${pm}`;
    posPmTotals[key] = (posPmTotals[key] || 0) + (p.amount || 0);
  }

  const grandSales = Math.round(orders.reduce((s, o) => s + (o.amount_total || 0), 0));
  const orderCount = orders.length;

  // Razorpay totals
  const rzpCounterSum = Math.round(rzp.counter.reduce((s, p) => s + p.amount/100, 0));
  const rzpRunnerCounterSum = Math.round(rzp.runnerCounter.reduce((s, p) => s + p.amount/100, 0));
  const rzpRunnerSum = Object.fromEntries(Object.entries(rzp.runners).map(([k, v]) => [k, Math.round(v.reduce((s, p) => s + p.amount/100, 0))]));

  // UPI cross-check (counter QR vs Odoo PM38 on POS27)
  const odooPm38Pos27 = Math.round(posPmTotals['27:38'] || 0);
  const upiVariance = rzpCounterSum - odooPm38Pos27;

  return {
    totals: {
      grand_sales: grandSales,
      order_count: orderCount,
      pm_breakdown: Object.fromEntries(Object.entries(pmTotals).map(([k,v]) => [k, Math.round(v)])),
      pos_pm_matrix: Object.fromEntries(Object.entries(posPmTotals).map(([k,v]) => [k, Math.round(v)])),
    },
    razorpay: {
      counter: rzpCounterSum,
      counter_count: rzp.counter.length,
      runner_counter: rzpRunnerCounterSum,
      runner_counter_count: rzp.runnerCounter.length,
      runners: rzpRunnerSum,
    },
    upi_cross_check: {
      odoo_pm38_pos27: odooPm38Pos27,
      rzp_counter: rzpCounterSum,
      variance: upiVariance,
      flag: Math.abs(upiVariance) > 100,
    },
    d1: d1Data,
  };
}

async function fetchD1Summary(DB, from, to) {
  if (!DB) return null;
  const fromISO = from.toISOString();
  const toISO = to.toISOString();
  const [settlements, collections, shifts, audits] = await Promise.all([
    DB.prepare('SELECT COUNT(*) as n, COALESCE(SUM(cash_settled),0) as cash FROM settlements WHERE settled_at BETWEEN ? AND ?').bind(fromISO, toISO).first(),
    DB.prepare('SELECT COUNT(*) as n, COALESCE(SUM(amount),0) as total FROM cash_collections WHERE collected_at BETWEEN ? AND ?').bind(fromISO, toISO).first(),
    DB.prepare('SELECT COUNT(*) as n FROM cashier_shifts WHERE settled_at BETWEEN ? AND ?').bind(fromISO, toISO).first(),
    DB.prepare("SELECT COUNT(*) as n FROM audit_logs WHERE created_at BETWEEN ? AND ? AND severity IN ('critical','high')").bind(fromISO, toISO).first(),
  ]);
  return {
    settlements: settlements?.n || 0,
    settlements_cash: Math.round(settlements?.cash || 0),
    collections: collections?.n || 0,
    collections_total: Math.round(collections?.total || 0),
    shifts_ended: shifts?.n || 0,
    critical_audits: audits?.n || 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// ACTION: orders
// ═══════════════════════════════════════════════════════════════

async function getOrders(env, from, to, posIds, pmIds) {
  const {orders, payments} = await fetchOrdersWithPayments(env.ODOO_API_KEY, from.toISOString(), to.toISOString(), posIds);
  const pmMap = new Map();
  for (const p of payments) {
    const oid = p.pos_order_id?.[0];
    if (!pmMap.has(oid)) pmMap.set(oid, []);
    pmMap.get(oid).push({
      pm_id: p.payment_method_id?.[0],
      pm_name: PM_NAMES[p.payment_method_id?.[0]] || 'Unknown',
      amount: p.amount,
      payment_date: p.payment_date,
    });
  }

  const rows = orders
    .filter(o => {
      const pmsForOrder = pmMap.get(o.id) || [];
      return pmsForOrder.length === 0 || pmsForOrder.some(p => pmIds.includes(p.pm_id));
    })
    .map(o => ({
      id: o.id,
      name: o.name,
      pos_reference: o.pos_reference,
      date_order: o.date_order,
      amount_total: o.amount_total,
      pos_id: o.config_id?.[0],
      pos_name: POS_NAMES[o.config_id?.[0]] || 'Unknown',
      session_id: o.session_id?.[0],
      partner_id: o.partner_id?.[0] || 0,
      partner_name: o.partner_id?.[1] || '',
      cashier: o.user_id?.[1] || o.employee_id?.[1] || '',
      line_count: (o.lines || []).length,
      payments: pmMap.get(o.id) || [],
    }));

  return {count: rows.length, orders: rows};
}

// ═══════════════════════════════════════════════════════════════
// ACTION: razorpay — raw feed with Odoo match status
// ═══════════════════════════════════════════════════════════════

async function getRazorpay(env, from, to) {
  const [{orders, payments}, rzp] = await Promise.all([
    fetchOrdersWithPayments(env.ODOO_API_KEY, from.toISOString(), to.toISOString(), [27, 28]),
    fetchAllRzp(env.RAZORPAY_KEY, env.RAZORPAY_SECRET, from, to),
  ]);

  // Index Odoo PM38 payments for fast matching: by (amount in paise, time bucket)
  const pm38 = payments.filter(p => p.payment_method_id?.[0] === 38);
  const pm38ByAmount = new Map();
  for (const p of pm38) {
    const amtPaise = Math.round(p.amount * 100);
    if (!pm38ByAmount.has(amtPaise)) pm38ByAmount.set(amtPaise, []);
    pm38ByAmount.get(amtPaise).push(p);
  }
  const orderById = new Map(orders.map(o => [o.id, o]));

  const allRzp = [
    ...rzp.counter.map(p => ({...p, qr_label: 'COUNTER', qr_id: COUNTER_QR})),
    ...rzp.runnerCounter.map(p => ({...p, qr_label: 'RUNNER_COUNTER', qr_id: RUNNER_COUNTER_QR})),
    ...Object.entries(rzp.runners).flatMap(([code, pmts]) => pmts.map(p => ({...p, qr_label: code, qr_id: RUNNER_QRS.find(r => r.code === code)?.qr_id}))),
  ];

  // Only COUNTER + RUNNER_COUNTER QRs are expected to match Odoo PM38.
  // Runner-specific QRs (RUN001-005) offset runner ledger, not PM38 → match_status='not_applicable'.
  const COUNTER_LABELS = new Set(['COUNTER', 'RUNNER_COUNTER']);

  const rows = allRzp.map(p => {
    const rzpTime = new Date(p.created_at * 1000);
    const isCounter = COUNTER_LABELS.has(p.qr_label);
    let match_status = 'not_applicable';
    let matched = null;
    let closestDiff = Infinity;

    if (isCounter) {
      const candidates = pm38ByAmount.get(p.amount) || [];
      for (const c of candidates) {
        const odooTime = new Date(c.payment_date + 'Z');
        const diffMin = Math.abs((odooTime - rzpTime) / 60000);
        if (diffMin < closestDiff && diffMin <= 10) { closestDiff = diffMin; matched = c; }
      }
      match_status = matched ? 'matched' : 'unmatched';
    }
    const order = matched ? orderById.get(matched.pos_order_id?.[0]) : null;

    return {
      rzp_id: p.id,
      qr_label: p.qr_label,
      qr_id: p.qr_id,
      amount: p.amount / 100,
      created_at: new Date(p.created_at * 1000).toISOString(),
      payer_vpa: p.vpa || p.method || '',
      match_status,
      matched: match_status === 'matched',
      match_diff_min: matched ? Math.round(closestDiff) : null,
      odoo_payment_id: matched?.id || null,
      odoo_order_id: order?.id || null,
      odoo_order_name: order?.name || null,
      odoo_order_pos: order ? POS_NAMES[order.config_id?.[0]] : null,
    };
  }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const counterRows = rows.filter(r => COUNTER_LABELS.has(r.qr_label));
  const unmatchedCount = counterRows.filter(r => r.match_status === 'unmatched').length;
  const unmatchedSum = Math.round(counterRows.filter(r => r.match_status === 'unmatched').reduce((s, r) => s + r.amount, 0));

  return {
    count: rows.length,
    counter_count: counterRows.length,
    unmatched: unmatchedCount,
    unmatched_sum: unmatchedSum,
    payments: rows,
  };
}

// ═══════════════════════════════════════════════════════════════
// ACTION: runners
// ═══════════════════════════════════════════════════════════════

async function getRunners(env, from, to) {
  const [{orders, payments}, rzp, settlements] = await Promise.all([
    fetchOrdersWithPayments(env.ODOO_API_KEY, from.toISOString(), to.toISOString(), [27, 28]),
    fetchAllRzp(env.RAZORPAY_KEY, env.RAZORPAY_SECRET, from, to),
    env.DB ? env.DB.prepare('SELECT * FROM settlements WHERE settled_at BETWEEN ? AND ? ORDER BY settled_at DESC').bind(from.toISOString(), to.toISOString()).all().then(r => r.results || []) : Promise.resolve([]),
  ]);

  const rows = RUNNER_QRS.map(r => {
    // Odoo PM48 tokens for this runner on POS27
    const tokens = payments.filter(p => {
      if (p.payment_method_id?.[0] !== 48) return false;
      const o = orders.find(x => x.id === p.pos_order_id?.[0]);
      return o && o.config_id?.[0] === 27 && o.partner_id?.[0] === r.partner_id;
    }).reduce((s, p) => s + (p.amount || 0), 0);

    // Odoo PM40 runner ledger on POS28
    const sales = payments.filter(p => {
      if (p.payment_method_id?.[0] !== 40) return false;
      const o = orders.find(x => x.id === p.pos_order_id?.[0]);
      return o && o.config_id?.[0] === 28 && o.partner_id?.[0] === r.partner_id;
    }).reduce((s, p) => s + (p.amount || 0), 0);

    // Razorpay UPI on this runner's QR
    const upi = Math.round((rzp.runners[r.code] || []).reduce((s, p) => s + p.amount/100, 0));
    const upiCount = (rzp.runners[r.code] || []).length;

    const expectedCash = Math.round(tokens + sales - upi);

    // D1 settlements for this runner
    const runnerSettlements = settlements.filter(s => s.runner_id === r.partner_id);
    const actualSettled = Math.round(runnerSettlements.reduce((s, x) => s + (x.cash_settled || 0), 0));
    const variance = actualSettled - expectedCash;

    return {
      code: r.code,
      partner_id: r.partner_id,
      qr_id: r.qr_id,
      tokens: Math.round(tokens),
      sales: Math.round(sales),
      upi,
      upi_count: upiCount,
      expected_cash: expectedCash,
      actual_settled: actualSettled,
      variance,
      settlement_count: runnerSettlements.length,
      settlements: runnerSettlements.map(s => ({
        id: s.id,
        settled_at: s.settled_at,
        tokens: s.tokens_amount,
        sales: s.sales_amount,
        upi: s.upi_amount,
        cash: s.cash_settled,
        settled_by: s.settled_by,
        period_start: s.period_start,
        period_end: s.period_end,
      })),
    };
  });

  return {runners: rows};
}

// ═══════════════════════════════════════════════════════════════
// ACTION: discrepancies — 7 auto-detected types
// ═══════════════════════════════════════════════════════════════

async function getDiscrepancies(env, from, to, posIds) {
  const [{orders, payments}, rzp, d1Audits] = await Promise.all([
    fetchOrdersWithPayments(env.ODOO_API_KEY, from.toISOString(), to.toISOString(), posIds),
    fetchAllRzp(env.RAZORPAY_KEY, env.RAZORPAY_SECRET, from, to),
    env.DB ? env.DB.prepare("SELECT * FROM audit_logs WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 50").bind(from.toISOString(), to.toISOString()).all().then(r => r.results || []) : Promise.resolve([]),
  ]);

  const issues = [];
  const orderById = new Map(orders.map(o => [o.id, o]));

  // ── Type 1: UPI mismatch — Razorpay counter QR payments with no Odoo PM38 match
  const pm38Pos27 = payments.filter(p => {
    const o = orderById.get(p.pos_order_id?.[0]);
    return p.payment_method_id?.[0] === 38 && o?.config_id?.[0] === 27;
  });
  const pm38ByAmount = new Map();
  for (const p of pm38Pos27) {
    const amt = Math.round(p.amount * 100);
    if (!pm38ByAmount.has(amt)) pm38ByAmount.set(amt, []);
    pm38ByAmount.get(amt).push(p);
  }
  const unmatchedRzp = [];
  for (const p of rzp.counter) {
    const candidates = pm38ByAmount.get(p.amount) || [];
    const rzpTime = new Date(p.created_at * 1000);
    const match = candidates.find(c => Math.abs(new Date(c.payment_date + 'Z') - rzpTime) <= 10 * 60000);
    if (!match) unmatchedRzp.push(p);
  }
  if (unmatchedRzp.length) {
    issues.push({
      type: 'upi_mismatch',
      severity: 'high',
      title: `${unmatchedRzp.length} Razorpay UPI payments with no Odoo PM38 match`,
      amount: Math.round(unmatchedRzp.reduce((s, p) => s + p.amount/100, 0)),
      count: unmatchedRzp.length,
      evidence: unmatchedRzp.map(p => ({
        rzp_id: p.id,
        amount: p.amount/100,
        time: new Date(p.created_at * 1000).toISOString(),
        vpa: p.vpa || p.method,
      })),
    });
  }

  // ── Type 2: Silent gaps on POS27 (>10 min during 6AM-2AM IST)
  const pos27 = orders.filter(o => o.config_id?.[0] === 27).sort((a, b) => new Date(a.date_order) - new Date(b.date_order));
  const gaps = [];
  for (let i = 1; i < pos27.length; i++) {
    const prev = new Date(pos27[i-1].date_order + 'Z');
    const curr = new Date(pos27[i].date_order + 'Z');
    const gapMin = (curr - prev) / 60000;
    if (gapMin > 10) {
      // Check if gap is during active hours (6AM-2AM IST = 00:30-20:30 UTC)
      const istHour = (prev.getUTCHours() + 5.5) % 24;
      if (istHour >= 6 || istHour < 2) {
        gaps.push({
          from: prev.toISOString(),
          to: curr.toISOString(),
          minutes: Math.round(gapMin),
          prev_order: pos27[i-1].name,
          next_order: pos27[i].name,
        });
      }
    }
  }
  if (gaps.length) {
    issues.push({
      type: 'silent_gaps',
      severity: gaps.some(g => g.minutes > 30) ? 'high' : 'warning',
      title: `${gaps.length} silent gaps on POS27 (> 10 min with no orders)`,
      total_minutes: gaps.reduce((s, g) => s + g.minutes, 0),
      count: gaps.length,
      evidence: gaps.slice(0, 20),
    });
  }

  // ── Type 3: Late batch entries (payment_date − date_order > 60 min)
  const lateEntries = [];
  for (const p of payments) {
    const o = orderById.get(p.pos_order_id?.[0]);
    if (!o) continue;
    const diffMin = (new Date(p.payment_date + 'Z') - new Date(o.date_order + 'Z')) / 60000;
    if (diffMin > 60) {
      lateEntries.push({
        order_id: o.id,
        order_name: o.name,
        pm: PM_NAMES[p.payment_method_id?.[0]] || p.payment_method_id?.[0],
        amount: p.amount,
        date_order: o.date_order,
        payment_date: p.payment_date,
        lag_min: Math.round(diffMin),
      });
    }
  }
  if (lateEntries.length) {
    issues.push({
      type: 'late_batch',
      severity: 'warning',
      title: `${lateEntries.length} payments entered > 60 min after order`,
      count: lateEntries.length,
      evidence: lateEntries.slice(0, 20),
    });
  }

  // ── Type 4: Invalid MWR tuples (method:pos:runner combinations not in 15 valid)
  const invalidMwr = [];
  for (const p of payments) {
    const o = orderById.get(p.pos_order_id?.[0]);
    if (!o) continue;
    const pm = p.payment_method_id?.[0];
    const pos = o.config_id?.[0];
    const runner = o.partner_id?.[0] || 0;
    // Only check POS27/POS28 (POS29 is delivery, different rules)
    if (pos !== 27 && pos !== 28) continue;
    const key = `${pm}:${pos}:${runner}`;
    // Allow runner for PM48/PM40; allow 0 for others
    const lookupKey = [48, 40].includes(pm) ? key : `${pm}:${pos}:0`;
    if (!VALID_MWR.has(lookupKey)) {
      invalidMwr.push({
        order_id: o.id,
        order_name: o.name,
        pos, pm, runner,
        amount: p.amount,
        tuple: key,
      });
    }
  }
  if (invalidMwr.length) {
    issues.push({
      type: 'invalid_mwr',
      severity: 'critical',
      title: `${invalidMwr.length} orders with invalid Method:POS:Runner combination`,
      count: invalidMwr.length,
      evidence: invalidMwr.slice(0, 20),
    });
  }

  // ── Type 5: Orphan orders (no payment_ids)
  const orphans = orders.filter(o => !(o.payment_ids || []).length);
  if (orphans.length) {
    issues.push({
      type: 'orphan_orders',
      severity: 'high',
      title: `${orphans.length} orders with no payment records`,
      amount: Math.round(orphans.reduce((s, o) => s + o.amount_total, 0)),
      count: orphans.length,
      evidence: orphans.slice(0, 20).map(o => ({id:o.id, name:o.name, date:o.date_order, amount:o.amount_total, pos:POS_NAMES[o.config_id?.[0]]})),
    });
  }

  // ── Type 6: Wrong PM (RZP UPI matched by amount+time but Odoo shows PM37 cash)
  const pm37Pos27 = payments.filter(p => {
    const o = orderById.get(p.pos_order_id?.[0]);
    return p.payment_method_id?.[0] === 37 && o?.config_id?.[0] === 27;
  });
  const pm37ByAmount = new Map();
  for (const p of pm37Pos27) {
    const amt = Math.round(p.amount * 100);
    if (!pm37ByAmount.has(amt)) pm37ByAmount.set(amt, []);
    pm37ByAmount.get(amt).push(p);
  }
  const wrongPm = [];
  for (const p of rzp.counter) {
    const rzpTime = new Date(p.created_at * 1000);
    const cashMatches = pm37ByAmount.get(p.amount) || [];
    const upiMatches = pm38ByAmount.get(p.amount) || [];
    const cashHit = cashMatches.find(c => Math.abs(new Date(c.payment_date + 'Z') - rzpTime) <= 10 * 60000);
    const upiHit = upiMatches.find(c => Math.abs(new Date(c.payment_date + 'Z') - rzpTime) <= 10 * 60000);
    if (cashHit && !upiHit) {
      const order = orderById.get(cashHit.pos_order_id?.[0]);
      wrongPm.push({
        rzp_id: p.id,
        amount: p.amount/100,
        rzp_time: rzpTime.toISOString(),
        odoo_order: order?.name,
        odoo_pm: 'Cash (should be UPI)',
      });
    }
  }
  if (wrongPm.length) {
    issues.push({
      type: 'wrong_pm',
      severity: 'high',
      title: `${wrongPm.length} Razorpay UPI payments recorded as Cash in Odoo`,
      amount: Math.round(wrongPm.reduce((s, e) => s + e.amount, 0)),
      count: wrongPm.length,
      evidence: wrongPm.slice(0, 20),
    });
  }

  // ── Type 7: D1 audit logs with severity critical/high
  if (d1Audits.length) {
    issues.push({
      type: 'd1_audits',
      severity: 'info',
      title: `${d1Audits.length} prior audit alerts in this window`,
      count: d1Audits.length,
      evidence: d1Audits.slice(0, 20).map(a => ({
        type: a.check_type,
        severity: a.severity,
        message: a.message,
        created_at: a.created_at,
      })),
    });
  }

  return {count: issues.length, issues};
}

// ═══════════════════════════════════════════════════════════════
// ACTION: drilldown — single order deep dive
// ═══════════════════════════════════════════════════════════════

async function getDrilldown(env, orderId) {
  if (!orderId) throw new Error('order_id required');
  const id = parseInt(orderId);
  const [[order], lines, payments] = await Promise.all([
    odooCall(env.ODOO_API_KEY, 'pos.order', 'search_read',
      [[['id','=',id]]],
      {fields:['id','name','date_order','amount_total','amount_paid','amount_tax','partner_id','config_id','payment_ids','session_id','pos_reference','user_id','employee_id','state','lines','note']}),
    odooCall(env.ODOO_API_KEY, 'pos.order.line', 'search_read',
      [[['order_id','=',id]]],
      {fields:['id','product_id','qty','price_unit','price_subtotal','price_subtotal_incl','discount','note','customer_note']}),
    odooCall(env.ODOO_API_KEY, 'pos.payment', 'search_read',
      [[['pos_order_id','=',id]]],
      {fields:['id','amount','payment_date','payment_method_id','card_type','transaction_id','name']}),
  ]);
  if (!order) throw new Error('order not found');
  return {
    order: {
      id: order.id, name: order.name, pos_reference: order.pos_reference,
      date_order: order.date_order, amount_total: order.amount_total, amount_paid: order.amount_paid, amount_tax: order.amount_tax,
      state: order.state, pos: POS_NAMES[order.config_id?.[0]] || order.config_id?.[1],
      pos_id: order.config_id?.[0], session_id: order.session_id?.[0],
      partner_id: order.partner_id?.[0] || 0, partner_name: order.partner_id?.[1] || '',
      cashier: order.user_id?.[1] || '', employee: order.employee_id?.[1] || '',
      note: order.note,
    },
    lines: lines.map(l => ({
      id: l.id, product: l.product_id?.[1], product_id: l.product_id?.[0],
      qty: l.qty, price_unit: l.price_unit, subtotal: l.price_subtotal, subtotal_incl_tax: l.price_subtotal_incl,
      discount: l.discount, note: l.note || l.customer_note || '',
    })),
    payments: payments.map(p => ({
      id: p.id, amount: p.amount, payment_date: p.payment_date,
      pm_id: p.payment_method_id?.[0], pm_name: PM_NAMES[p.payment_method_id?.[0]] || p.payment_method_id?.[1],
      card_type: p.card_type, transaction_id: p.transaction_id,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════
// ACTION: gaps — silent-gap detector
// ═══════════════════════════════════════════════════════════════

async function getGaps(env, from, to, thresholdMin) {
  const orders = await odooCall(env.ODOO_API_KEY, 'pos.order', 'search_read',
    [[['config_id','=',27],['date_order','>=',fmtOdoo(from.toISOString())],['date_order','<=',fmtOdoo(to.toISOString())],['state','in',['paid','done','invoiced','posted']]]],
    {fields:['id','name','date_order','amount_total'], order:'date_order asc', limit: 2000});

  const gaps = [];
  for (let i = 1; i < orders.length; i++) {
    const prevTime = new Date(orders[i-1].date_order + 'Z');
    const currTime = new Date(orders[i].date_order + 'Z');
    const gapMin = Math.round((currTime - prevTime) / 60000);
    if (gapMin >= thresholdMin) {
      gaps.push({
        from_iso: prevTime.toISOString(),
        to_iso: currTime.toISOString(),
        minutes: gapMin,
        prev_order: orders[i-1].name,
        next_order: orders[i].name,
      });
    }
  }
  return {count: gaps.length, threshold_min: thresholdMin, gaps, order_count: orders.length};
}
