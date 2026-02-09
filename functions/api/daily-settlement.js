// NCH Daily P&L Settlement API — Cloudflare Worker
// The intelligence layer: staff enters physical counts → system calculates everything
// Settlement at midnight: covers one calendar day's P&L

export async function onRequest(context) {
  const corsHeaders = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json'};
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: corsHeaders});

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');
  const DB = context.env.DB;

  const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
  const ODOO_DB = 'main';
  const ODOO_UID = 2;
  const ODOO_API_KEY = context.env.ODOO_API_KEY;

  const PINS = {'6890': 'Tanveer', '7115': 'Md Kesmat', '3946': 'Jafar', '3678': 'Farooq', '9991': 'Mujib', '4759': 'Jahangir', '1002': 'Rarup', '0305': 'Nihaf', '2026': 'Zoya', '3697': 'Yashwant', '3754': 'Naveen'};

  // ═══════════════════════════════════════════════════════════
  // POS Product → Raw Material RECIPES (qty per 1 unit sold)
  // ═══════════════════════════════════════════════════════════
  const RECIPES = {
    1028: { // Irani Chai (80ml: 60ml boiled milk + 20ml decoction)
      name: 'Irani Chai', code: 'NCH-IC', price: 20,
      materials: {
        1095: 0.05742,   // Buffalo Milk (L) — from boiled milk portion
        1096: 0.001435,  // SMP (kg) — from boiled milk
        1112: 0.001148,  // Condensed Milk (kg) — from boiled milk
        1098: 0.000112,  // Tea Powder (kg) — from decoction
        1097: 0.000225,  // Sugar (kg) — from decoction
        1101: 0.01966,   // Filter Water (L) — from decoction
      }
    },
    1102: { // Nawabi Special Coffee (90ml boiled milk + coffee + honey)
      name: 'Nawabi Special Coffee', code: 'NCH-NSC', price: 30,
      materials: {
        1095: 0.08613,   // Buffalo Milk (L)
        1096: 0.002153,  // SMP (kg)
        1112: 0.001723,  // Condensed Milk (kg)
        1120: 0.002,     // Coffee Powder (kg) — 2g per cup
        1123: 0.005,     // Honey (kg) — 5g per cup
      }
    },
    1103: { // Lemon Tea (80ml decoction + half lemon)
      name: 'Lemon Tea', code: 'LT', price: 20,
      materials: {
        1098: 0.000449,  // Tea Powder (kg)
        1097: 0.000899,  // Sugar (kg)
        1101: 0.07865,   // Filter Water (L)
        1121: 0.5,       // Lemon (units) — half lemon per cup
      }
    },
    1029: { // Bun Maska
      name: 'Bun Maska', code: 'NCH-BM', price: 40,
      materials: {
        1104: 1,      // Buns (units)
        1119: 0.05,   // Butter (kg) — 50g
        1097: 0.004,  // Sugar (kg) — 4g powdered sugar from same sugar
      }
    },
    1118: { // Malai Bun
      name: 'Malai Bun', code: 'NCH-MB', price: 30,
      materials: {
        1104: 1, // Buns (units) — malai is byproduct, not costed
      }
    },
    1031: { // Chicken Cutlet
      name: 'Chicken Cutlet', code: 'NCH-CC', price: 25,
      materials: {
        1106: 1,     // Cutlet Unfried (units)
        1114: 0.03,  // Oil (L) — 30ml deep fry
      }
    },
    1115: { // Pyaaz Samosa
      name: 'Pyaaz Samosa', code: 'NCH-PS', price: 15,
      materials: {
        1113: 1,     // Samosa Raw (units)
        1114: 0.02,  // Oil (L) — 20ml deep fry
      }
    },
    1117: { // Cheese Balls
      name: 'Cheese Balls', code: 'NCH-CB', price: 50,
      materials: {
        1116: 1,      // Cheese Balls Raw (units)
        1114: 0.015,  // Oil (L) — 15ml deep fry
      }
    },
    1030: { // Osmania Biscuit (single)
      name: 'Osmania Biscuit', code: 'NCH-OB', price: 8,
      materials: { 1105: 1 } // 1 loose biscuit
    },
    1033: { // Osmania Biscuit Pack of 3
      name: 'Osmania Biscuit Pack of 3', code: 'NCH-OB3', price: 20,
      materials: { 1105: 3 } // 3 loose biscuits
    },
    1111: { // Niloufer Osmania Box 500g
      name: 'Niloufer Osmania 500g', code: 'NCH-OBBOX', price: 250,
      materials: { 1110: 1 } // 1 box
    },
    1094: { // Water
      name: 'Water', code: 'NCH-WTR', price: 10,
      materials: { 1107: 1 } // 1 bottle
    },
  };

  // ═══════════════════════════════════════════════════════════
  // RAW MATERIALS reference
  // ═══════════════════════════════════════════════════════════
  const RAW_MATERIALS = {
    1095: {name: 'Buffalo Milk', code: 'RM-BFM', uom: 'L'},
    1096: {name: 'Skimmed Milk Powder', code: 'RM-SMP', uom: 'kg'},
    1097: {name: 'Sugar', code: 'RM-SUG', uom: 'kg'},
    1098: {name: 'Tea Powder', code: 'RM-TEA', uom: 'kg'},
    1101: {name: 'Filter Water', code: 'RM-WTR', uom: 'L'},
    1104: {name: 'Buns', code: 'RM-BUN', uom: 'Units'},
    1105: {name: 'Osmania Biscuit (Loose)', code: 'RM-OSMG', uom: 'Units'},
    1106: {name: 'Chicken Cutlet (Unfried)', code: 'RM-CCT', uom: 'Units'},
    1107: {name: 'Bottled Water', code: 'RM-BWR', uom: 'Units'},
    1110: {name: 'Osmania Biscuit Box', code: 'RM-OSMN', uom: 'Units'},
    1112: {name: 'Condensed Milk', code: 'RM-CM', uom: 'kg'},
    1113: {name: 'Samosa Raw', code: 'RM-SAM', uom: 'Units'},
    1114: {name: 'Oil', code: 'RM-OIL', uom: 'L'},
    1116: {name: 'Cheese Balls Raw', code: 'RM-CHB', uom: 'Units'},
    1119: {name: 'Butter', code: 'RM-BTR', uom: 'kg'},
    1120: {name: 'Coffee Powder', code: 'RM-COF', uom: 'kg'},
    1121: {name: 'Lemon', code: 'RM-LMN', uom: 'Units'},
    1123: {name: 'Honey', code: 'RM-HNY', uom: 'kg'},
  };

  // ═══════════════════════════════════════════════════════════
  // SETTLEMENT STATES: physical forms staff sees during count
  // Each state decomposes into raw materials via ratios
  // ═══════════════════════════════════════════════════════════

  // Boiled Milk ratio: 10L buffalo milk + 0.2kg milkmaid + 0.25kg SMP
  // Total volume ≈ 10.45L → per litre of mixture:
  const BOILED_MILK_RATIO = {1095: 0.957, 1096: 0.02392, 1112: 0.01914};

  // Tea Decoction ratio: 70L water + 0.4kg tea + 0.8kg sugar
  // Total volume ≈ 71.2L → per litre of decoction:
  const DECOCTION_RATIO = {1098: 0.005618, 1097: 0.01124, 1101: 0.9831};

  // Tea-Sugar Box: 1 box = 400g tea + 800g sugar
  const TEA_SUGAR_BOX_RATIO = {1098: 0.4, 1097: 0.8};

  // Fried item oil: per unit
  const FRIED_OIL = {1106: 0.03, 1113: 0.02, 1116: 0.015}; // cutlet, samosa, cheese ball

  // Bun Maska prepared: per unit
  const BUN_MASKA_RATIO = {1104: 1, 1119: 0.05, 1097: 0.004};

  // Osmania packet: 24 biscuits per packet
  const OSMANIA_PER_PACKET = 24;

  // Density constants: kg per litre (for vessel weight → volume)
  const DENSITY = {
    boiled_milk: 1.035,
    tea_decoction: 1.03,
    oil: 0.92,
    raw_milk: 1.032,
  };

  // Default vessel weights (updated from DB if available)
  // These are starting approximations — real values entered after weighing
  const DEFAULT_VESSELS = {
    'KIT-PATILA-1': {name: 'Kitchen Large Patila', liquid_type: 'boiled_milk', location: 'kitchen', empty_weight_kg: 13.28},
    'CTR-MILK-1': {name: 'Counter Milk Vessel (Copper Samawar)', liquid_type: 'boiled_milk', location: 'counter', empty_weight_kg: 10.0},
    'CTR-DEC-1': {name: 'Counter Decoction Vessel 1 (Copper)', liquid_type: 'decoction', location: 'counter', empty_weight_kg: 13.0},
    'CTR-DEC-2': {name: 'Counter Decoction Vessel 2 (Copper)', liquid_type: 'decoction', location: 'counter', empty_weight_kg: 11.0},
    'KIT-DEC-1': {name: 'Kitchen Decoction Prep Vessel', liquid_type: 'decoction', location: 'kitchen', empty_weight_kg: 11.0},
  };

  const round = (v, d = 4) => Math.round(v * Math.pow(10, d)) / Math.pow(10, d);

  try {
    // ─── GET CONFIG: vessels, states, recipes ─────────────────
    if (action === 'get-config') {
      const vessels = await getVessels(DB);
      return json({
        success: true,
        vessels,
        recipes: RECIPES,
        rawMaterials: RAW_MATERIALS,
        density: DENSITY,
        defaultVessels: DEFAULT_VESSELS,
      }, corsHeaders);
    }

    // ─── PREPARE: fetch all data needed for settlement ────────
    if (action === 'prepare') {
      const dateParam = url.searchParams.get('date'); // YYYY-MM-DD
      const now = istNow();
      const settlementDate = dateParam || now.toISOString().slice(0, 10);

      // Period: midnight IST to next midnight IST (exclusive end)
      // IST strings for display/DB storage
      const periodStartIST = `${settlementDate}T00:00:00+05:30`;
      const periodEndIST = `${settlementDate}T23:59:59+05:30`; // Display only
      // Convert to UTC Date objects — new Date() correctly handles the +05:30 offset
      const periodStartUTC = new Date(periodStartIST); // midnight IST in UTC
      const periodEndUTC = new Date(periodStartUTC.getTime() + 86400000); // next midnight IST in UTC
      // Odoo expects UTC datetime strings (without timezone)
      const fromOdoo = periodStartUTC.toISOString().slice(0, 19).replace('T', ' ');
      const toOdoo = periodEndUTC.toISOString().slice(0, 19).replace('T', ' ');

      // Check if settlement already exists for this date
      const existing = DB ? await DB.prepare('SELECT * FROM daily_settlements WHERE settlement_date = ?').bind(settlementDate).first() : null;

      // Get previous settlement (for opening stock)
      const previous = DB ? await DB.prepare('SELECT * FROM daily_settlements WHERE settlement_date < ? AND status IN (?, ?) ORDER BY settlement_date DESC LIMIT 1').bind(settlementDate, 'completed', 'bootstrap').first() : null;

      // Parallel: fetch sales, purchases, expenses, vessels
      const [salesData, purchaseData, vessels, expenseData] = await Promise.all([
        fetchPOSSales(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
        fetchPurchasesReceived(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
        getVessels(DB),
        DB ? DB.prepare('SELECT * FROM counter_expenses WHERE recorded_at >= ? AND recorded_at < ?').bind(periodStartUTC.toISOString(), periodEndUTC.toISOString()).all() : {results: []},
      ]);

      // Calculate revenue
      const revenue = {total: 0, cashCounter: 0, runnerCounter: 0, whatsapp: 0, products: []};
      for (const item of salesData) {
        revenue.total += item.amount;
        revenue.products.push(item);
      }

      // Get opening stock from previous settlement
      let openingStock = {};
      if (previous) {
        openingStock = JSON.parse(previous.inventory_decomposed || '{}');
      }

      // Counter expenses
      let counterExpenses = 0;
      for (const e of (expenseData.results || [])) {
        counterExpenses += e.amount;
      }

      // Staff salaries
      let dailySalaries = 0;
      const salaryData = [];
      if (DB) {
        const salaries = await DB.prepare('SELECT * FROM staff_salaries WHERE active = 1').all();
        for (const s of (salaries.results || [])) {
          const daily = round(s.monthly_salary / 30, 2);
          dailySalaries += daily;
          salaryData.push({name: s.name, role: s.role, monthly: s.monthly_salary, daily});
        }
      }

      return json({
        success: true,
        settlementDate,
        period: {start: periodStartIST, end: periodEndIST},
        existing: existing || null,
        needsBootstrap: !previous,
        previousSettlement: previous ? {
          id: previous.id,
          date: previous.settlement_date,
          status: previous.status,
        } : null,
        openingStock,
        revenue,
        purchases: purchaseData,
        counterExpenses,
        salaries: {daily: dailySalaries, staff: salaryData},
        vessels,
        recipes: RECIPES,
        rawMaterials: RAW_MATERIALS,
      }, corsHeaders);
    }

    // ─── SUBMIT: process settlement with physical counts ──────
    if (action === 'submit' && context.request.method === 'POST') {
      if (!DB) return json({success: false, error: 'Database not configured'}, corsHeaders);

      const body = await context.request.json();
      const {pin, settlement_date, raw_input, wastage_items, runner_tokens, notes, is_bootstrap} = body;

      // Validate PIN
      const settledBy = PINS[pin];
      if (!settledBy) return json({success: false, error: 'Invalid PIN'}, corsHeaders);

      // Check duplicate
      const existing = await DB.prepare('SELECT id FROM daily_settlements WHERE settlement_date = ?').bind(settlement_date).first();
      if (existing) return json({success: false, error: `Settlement already exists for ${settlement_date}. Cannot overwrite.`}, corsHeaders);

      // Period: midnight IST to next midnight IST (exclusive end)
      const periodStartIST = `${settlement_date}T00:00:00+05:30`;
      const periodEndIST = `${settlement_date}T23:59:59+05:30`; // Display only
      const periodStartUTC = new Date(periodStartIST);
      const periodEndUTC = new Date(periodStartUTC.getTime() + 86400000);
      const fromOdoo = periodStartUTC.toISOString().slice(0, 19).replace('T', ' ');
      const toOdoo = periodEndUTC.toISOString().slice(0, 19).replace('T', ' ');

      // ── Step 1: Decompose raw input into raw materials ──
      const vessels = await getVessels(DB);
      const vesselMap = {};
      for (const v of vessels) vesselMap[v.code] = v;

      const decomposed = decomposeInput(raw_input, vesselMap, DENSITY, BOILED_MILK_RATIO, DECOCTION_RATIO, TEA_SUGAR_BOX_RATIO, FRIED_OIL, BUN_MASKA_RATIO, OSMANIA_PER_PACKET);

      // If bootstrap: just store the count, no P&L
      if (is_bootstrap) {
        await DB.prepare(`INSERT INTO daily_settlements
          (settlement_date, period_start, period_end, settled_by, settled_at, status,
           inventory_raw_input, inventory_decomposed, inventory_closing,
           runner_tokens, runner_tokens_total, notes)
          VALUES (?, ?, ?, ?, ?, 'bootstrap', ?, ?, ?, ?, ?, ?)`
        ).bind(
          settlement_date, periodStartIST, periodEndIST, settledBy, new Date().toISOString(),
          JSON.stringify(raw_input), JSON.stringify(decomposed), JSON.stringify(decomposed),
          JSON.stringify(runner_tokens || {}),
          Object.values(runner_tokens || {}).reduce((s, v) => s + v, 0),
          notes || ''
        ).run();

        return json({
          success: true,
          message: 'Bootstrap settlement recorded — baseline inventory established',
          settlementDate: settlement_date,
          settledBy,
          status: 'bootstrap',
          inventory: decomposed,
        }, corsHeaders);
      }

      // ── Step 2: Get previous settlement (opening stock) ──
      const previous = await DB.prepare(
        'SELECT * FROM daily_settlements WHERE settlement_date < ? AND status IN (?, ?) ORDER BY settlement_date DESC LIMIT 1'
      ).bind(settlement_date, 'completed', 'bootstrap').first();

      if (!previous) return json({success: false, error: 'No previous settlement found. Please do a bootstrap settlement first.'}, corsHeaders);

      const openingStock = JSON.parse(previous.inventory_decomposed || '{}');
      const prevRunnerTokens = JSON.parse(previous.runner_tokens || '{}');

      // ── Step 3: Fetch Odoo data for the period ──
      const [salesResult, purchaseData, expenseData] = await Promise.all([
        fetchPOSSalesWithChannels(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
        fetchPurchasesReceived(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
        DB.prepare('SELECT * FROM counter_expenses WHERE recorded_at >= ? AND recorded_at < ?').bind(periodStartUTC.toISOString(), periodEndUTC.toISOString()).all(),
      ]);

      // ── Step 4: Calculate Revenue ──
      const revenue = {
        total: salesResult.total,
        cashCounter: salesResult.cashCounter,
        runnerCounter: salesResult.runnerCounter,
        whatsapp: salesResult.whatsapp,
        products: salesResult.products,
      };

      // ── Step 5: Adjust sales for runner tokens ──
      // Unsold tokens at end = POS recorded these sales but tea not made yet
      // Unsold tokens at start = were counted in previous settlement
      const currentTokens = runner_tokens || {};
      const currentTokenTotal = Object.values(currentTokens).reduce((s, v) => s + v, 0);
      const prevTokenTotal = Object.values(prevRunnerTokens).reduce((s, v) => s + v, 0);
      // Net token adjustment: tokens consumed this period = prev unsold - current unsold
      // If prev had 5 unsold and current has 3 unsold, then 2 tokens were consumed (tea made)
      // that WEREN'T in this period's POS sales (they were in a previous period's POS)
      // effective_chai_made = POS_chai_sold_this_period - current_unsold + prev_unsold
      // But for consumption calculation, we use physical count which already reflects actual usage
      // Token adjustment is for EXPECTED consumption calculation only

      // ── Step 6: Build purchases map ──
      const purchases = {};
      for (const p of purchaseData) {
        if (!purchases[p.materialId]) purchases[p.materialId] = {qty: 0, cost: 0};
        purchases[p.materialId].qty += p.qty;
        purchases[p.materialId].cost += p.cost;
      }

      // ── Step 7: Calculate ACTUAL consumption ──
      // consumption = opening + purchases - closing
      // IMPORTANT: Negative consumption is preserved — it signals counting errors or unrecorded purchases
      const closingStock = decomposed;
      const consumption = {};
      const consumptionWarnings = [];
      const allMaterialIds = new Set([
        ...Object.keys(openingStock),
        ...Object.keys(purchases),
        ...Object.keys(closingStock)
      ]);

      for (const mid of allMaterialIds) {
        const matId = String(mid);
        const opening = openingStock[matId] || 0;
        const purchased = purchases[matId] ? purchases[matId].qty : 0;
        const closing = closingStock[matId] || 0;
        const used = round(opening + purchased - closing, 4);
        if (used !== 0 || opening > 0 || purchased > 0) {
          consumption[matId] = round(used, 4);
          // Flag negative consumption — means closing > opening + purchases
          if (used < -0.001) {
            consumptionWarnings.push({
              materialId: matId,
              materialName: RAW_MATERIALS[matId]?.name || matId,
              opening, purchased, closing, used,
              message: `Negative consumption: closing (${closing}) > opening (${opening}) + purchased (${purchased}). Possible unrecorded delivery or counting error.`
            });
          }
        }
      }

      // ── Step 8: Calculate EXPECTED consumption from recipes ──
      const expectedConsumption = {};
      for (const [productId, product] of Object.entries(RECIPES)) {
        const salesItem = revenue.products[productId];
        if (!salesItem) continue;
        let qtySold = salesItem.qty;

        // Token adjustment for Irani Chai (product 1028)
        if (String(productId) === '1028') {
          // Effective chai consumption = POS sales - current unsold tokens + prev unsold tokens
          qtySold = qtySold - currentTokenTotal + prevTokenTotal;
        }

        for (const [matId, qtyPerUnit] of Object.entries(product.materials)) {
          if (!expectedConsumption[matId]) expectedConsumption[matId] = 0;
          expectedConsumption[matId] = round(expectedConsumption[matId] + qtySold * qtyPerUnit, 4);
        }
      }

      // ── Step 9: Batch-load all material costs (single DB query) ──
      const materialCosts = await getAllMaterialCosts(DB, settlement_date);
      const getCost = (matId) => materialCosts[String(matId)] || FALLBACK_COSTS[matId] || 0;

      // ── Step 10: Calculate discrepancy per material ──
      // IMPORTANT: Iterate over BOTH consumption and expectedConsumption keys
      // to catch materials expected but not consumed (e.g., not in any stock category)
      const discrepancy = {};
      let discrepancyValue = 0;
      const allDiscMaterialIds = new Set([
        ...Object.keys(consumption),
        ...Object.keys(expectedConsumption),
      ]);

      for (const matId of allDiscMaterialIds) {
        const actual = consumption[matId] || 0;
        const expected = expectedConsumption[matId] || 0;
        // Subtract recorded wastage
        const wastedQty = (wastage_items || [])
          .filter(w => String(w.material_id) === String(matId))
          .reduce((s, w) => s + (w.qty || 0), 0);
        const disc = round(actual - expected - wastedQty, 4);
        if (Math.abs(disc) > 0.001) {
          const materialCost = getCost(matId);
          const discValue = round(disc * materialCost, 2);
          discrepancy[matId] = {qty: disc, value: discValue, uom: RAW_MATERIALS[matId]?.uom || ''};
          discrepancyValue += discValue;
        }
      }

      // ── Step 11: Calculate COGS ──
      // For actual COGS, only count positive consumption (negative = counting error, not a cost)
      let cogsActual = 0;
      for (const [matId, qty] of Object.entries(consumption)) {
        const cost = getCost(matId);
        cogsActual += Math.max(0, qty) * cost; // Only positive consumption is actual cost
      }
      cogsActual = round(cogsActual, 2);

      let cogsExpected = 0;
      for (const [matId, qty] of Object.entries(expectedConsumption)) {
        const cost = getCost(matId);
        cogsExpected += qty * cost;
      }
      cogsExpected = round(cogsExpected, 2);

      // ── Step 12: Wastage value ──
      let wastageValue = 0;
      for (const w of (wastage_items || [])) {
        const cost = getCost(w.material_id);
        wastageValue += (w.qty || 0) * cost;
      }
      wastageValue = round(wastageValue, 2);

      // ── Step 13: Operating Expenses ──
      let counterExpenses = 0;
      for (const e of (expenseData.results || [])) counterExpenses += e.amount;

      let dailySalaries = 0;
      const salaries = await DB.prepare('SELECT * FROM staff_salaries WHERE active = 1').all();
      for (const s of (salaries.results || [])) dailySalaries += round(s.monthly_salary / 30, 2);

      const opexTotal = round(dailySalaries + counterExpenses, 2);

      // ── Step 14: P&L ──
      const grossProfit = round(revenue.total - cogsActual, 2);
      const netProfit = round(grossProfit - opexTotal, 2);
      const adjustedNetProfit = round(netProfit - discrepancyValue - wastageValue, 2);

      // ── Step 15: Save to DB ──
      await DB.prepare(`INSERT INTO daily_settlements
        (settlement_date, period_start, period_end, settled_by, settled_at, status,
         revenue_total, revenue_cash_counter, revenue_runner_counter, revenue_whatsapp, revenue_breakdown,
         cogs_actual, cogs_expected, gross_profit,
         opex_salaries, opex_counter_expenses, opex_total,
         net_profit,
         inventory_raw_input, inventory_decomposed, inventory_opening, inventory_purchases, inventory_closing,
         inventory_consumption, inventory_expected, inventory_discrepancy, discrepancy_value,
         wastage_items, wastage_total_value,
         runner_tokens, runner_tokens_total,
         adjusted_net_profit, notes, previous_settlement_id)
        VALUES (?, ?, ?, ?, ?, 'completed',
                ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?,
                ?, ?,
                ?, ?, ?)`
      ).bind(
        settlement_date, periodStartIST, periodEndIST, settledBy, new Date().toISOString(),
        revenue.total, revenue.cashCounter, revenue.runnerCounter, revenue.whatsapp, JSON.stringify(revenue.products),
        cogsActual, cogsExpected, grossProfit,
        dailySalaries, counterExpenses, opexTotal,
        netProfit,
        JSON.stringify(raw_input), JSON.stringify(decomposed), JSON.stringify(openingStock), JSON.stringify(purchases), JSON.stringify(closingStock),
        JSON.stringify(consumption), JSON.stringify(expectedConsumption), JSON.stringify(discrepancy), discrepancyValue,
        JSON.stringify(wastage_items || []), wastageValue,
        JSON.stringify(currentTokens), currentTokenTotal,
        adjustedNetProfit, notes || '', previous ? previous.id : null
      ).run();

      // ── Step 16: WhatsApp summary ──
      const WA_TOKEN = context.env.WA_ACCESS_TOKEN;
      const WA_PHONE_ID = context.env.WA_PHONE_ID || '970365416152029';
      if (WA_TOKEN) {
        const profitEmoji = adjustedNetProfit >= 0 ? '📈' : '📉';
        const warningLines = consumptionWarnings.length > 0
          ? `\n🚨 *${consumptionWarnings.length} Warning(s):*\n` + consumptionWarnings.map(w => `  • ${w.materialName}: negative consumption`).join('\n') + '\n'
          : '';
        const channelBreakdown = revenue.cashCounter > 0 || revenue.runnerCounter > 0 || revenue.whatsapp > 0
          ? `  Counter: ₹${Math.round(revenue.cashCounter).toLocaleString('en-IN')} | Runner: ₹${Math.round(revenue.runnerCounter).toLocaleString('en-IN')} | Delivery: ₹${Math.round(revenue.whatsapp).toLocaleString('en-IN')}\n`
          : '';
        const msg = `☕ *NCH Daily P&L — ${settlement_date}*\n\n`
          + `💰 Revenue: ₹${Math.round(revenue.total).toLocaleString('en-IN')}\n`
          + channelBreakdown
          + `📦 COGS: ₹${Math.round(cogsActual).toLocaleString('en-IN')}\n`
          + `📊 Gross Profit: ₹${Math.round(grossProfit).toLocaleString('en-IN')}\n`
          + `💸 Expenses: ₹${Math.round(opexTotal).toLocaleString('en-IN')}\n`
          + (wastageValue > 0 ? `🗑️ Wastage: ₹${Math.round(wastageValue).toLocaleString('en-IN')}\n` : '')
          + (Math.abs(discrepancyValue) > 10 ? `⚠️ Discrepancy: ₹${Math.round(discrepancyValue).toLocaleString('en-IN')}\n` : '')
          + warningLines
          + `\n${profitEmoji} *Net Profit: ₹${Math.round(adjustedNetProfit).toLocaleString('en-IN')}*\n`
          + `\nSettled by: ${settledBy}`;

        const recipients = ['917010426808', '918073476051'];
        context.waitUntil(Promise.all(recipients.map(to =>
          sendWhatsApp(WA_PHONE_ID, WA_TOKEN, to, msg)
        )).catch(e => console.error('P&L WA alert error:', e.message)));
      }

      return json({
        success: true,
        message: 'Daily P&L settlement completed',
        settlementDate: settlement_date,
        settledBy,
        pnl: {
          revenue: revenue.total,
          revenueBreakdown: {cashCounter: revenue.cashCounter, runnerCounter: revenue.runnerCounter, whatsapp: revenue.whatsapp},
          cogs: cogsActual,
          cogsExpected,
          grossProfit,
          opex: opexTotal,
          opexBreakdown: {salaries: dailySalaries, counterExpenses},
          netProfit,
          wastage: wastageValue,
          discrepancy: discrepancyValue,
          adjustedNetProfit,
        },
        inventory: {
          opening: openingStock,
          purchases,
          closing: closingStock,
          consumption,
          expected: expectedConsumption,
          discrepancy,
        },
        warnings: consumptionWarnings,
        runnerTokens: {current: currentTokens, previous: prevRunnerTokens},
      }, corsHeaders);
    }

    // ─── HISTORY: past settlements ────────────────────────────
    if (action === 'history') {
      if (!DB) return json({success: false, error: 'DB not configured'}, corsHeaders);
      const limit = parseInt(url.searchParams.get('limit') || '30');
      const results = await DB.prepare(
        'SELECT id, settlement_date, status, settled_by, settled_at, revenue_total, cogs_actual, gross_profit, opex_total, net_profit, adjusted_net_profit, discrepancy_value, wastage_total_value, runner_tokens_total FROM daily_settlements ORDER BY settlement_date DESC LIMIT ?'
      ).bind(limit).all();
      return json({success: true, settlements: results.results}, corsHeaders);
    }

    // ─── GET SETTLEMENT: full detail for a specific date ──────
    if (action === 'get-settlement') {
      if (!DB) return json({success: false, error: 'DB not configured'}, corsHeaders);
      const date = url.searchParams.get('date');
      if (!date) return json({success: false, error: 'date parameter required'}, corsHeaders);
      const result = await DB.prepare('SELECT * FROM daily_settlements WHERE settlement_date = ?').bind(date).first();
      if (!result) return json({success: false, error: 'No settlement found for ' + date}, corsHeaders);
      return json({success: true, settlement: result}, corsHeaders);
    }

    // ─── VESSELS: manage vessel weights ──────────────────────
    if (action === 'get-vessels') {
      const vessels = await getVessels(DB);
      return json({success: true, vessels}, corsHeaders);
    }

    if (action === 'save-vessel' && context.request.method === 'POST') {
      if (!DB) return json({success: false, error: 'DB not configured'}, corsHeaders);
      const body = await context.request.json();
      const {code, name, liquid_type, location, empty_weight_kg, notes} = body;
      if (!code || !name || !liquid_type || empty_weight_kg === undefined) {
        return json({success: false, error: 'Missing required fields'}, corsHeaders);
      }
      const now = new Date().toISOString();
      await DB.prepare(
        `INSERT INTO vessels (code, name, liquid_type, location, empty_weight_kg, notes, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(code) DO UPDATE SET name=?, liquid_type=?, location=?, empty_weight_kg=?, notes=?, updated_at=?`
      ).bind(code, name, liquid_type, location || '', empty_weight_kg, notes || '', now, now,
             name, liquid_type, location || '', empty_weight_kg, notes || '', now).run();
      return json({success: true, message: 'Vessel saved'}, corsHeaders);
    }

    // ─── SALARIES: manage staff salaries ─────────────────────
    if (action === 'get-salaries') {
      if (!DB) return json({success: false, error: 'DB not configured'}, corsHeaders);
      const results = await DB.prepare('SELECT * FROM staff_salaries WHERE active = 1 ORDER BY name').all();
      return json({success: true, salaries: results.results}, corsHeaders);
    }

    if (action === 'save-salary' && context.request.method === 'POST') {
      if (!DB) return json({success: false, error: 'DB not configured'}, corsHeaders);
      const body = await context.request.json();
      const {name, role, monthly_salary} = body;
      if (!name || !monthly_salary) return json({success: false, error: 'Name and salary required'}, corsHeaders);
      const now = new Date().toISOString();
      await DB.prepare(
        'INSERT INTO staff_salaries (name, role, monthly_salary, effective_from, active, updated_at) VALUES (?, ?, ?, ?, 1, ?)'
      ).bind(name, role || '', monthly_salary, now, now).run();
      return json({success: true, message: 'Salary saved'}, corsHeaders);
    }

    // ─── VERIFY PIN ──────────────────────────────────────────
    if (action === 'verify-pin') {
      const pin = url.searchParams.get('pin');
      if (PINS[pin]) return json({success: true, user: PINS[pin]}, corsHeaders);
      return json({success: false, error: 'Invalid PIN'}, corsHeaders);
    }

    return json({success: false, error: 'Invalid action. Use: get-config, prepare, submit, history, get-settlement, get-vessels, save-vessel, get-salaries, save-salary, verify-pin'}, corsHeaders);

  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message, stack: error.stack}), {status: 500, headers: corsHeaders});
  }

  // ═══════════════════════════════════════════════════════════
  // DECOMPOSE: Convert staff input → raw material totals
  // This is the core intelligence function
  // ═══════════════════════════════════════════════════════════
  function decomposeInput(input, vesselMap, density, boiledMilkRatio, decoctionRatio, teaSugarBoxRatio, friedOil, bunMaskaRatio, osmaniaPP) {
    const totals = {};
    const add = (matId, qty) => {
      const key = String(matId);
      totals[key] = round((totals[key] || 0) + qty, 4);
    };

    // ── RAW MATERIALS (direct) ──
    if (input.raw_buffalo_milk) add(1095, input.raw_buffalo_milk);
    if (input.raw_milkmaid) add(1112, input.raw_milkmaid);
    if (input.raw_smp) add(1096, input.raw_smp);
    if (input.raw_sugar) add(1097, input.raw_sugar);
    if (input.raw_tea_powder) add(1098, input.raw_tea_powder);
    if (input.butter) add(1119, input.butter);
    if (input.coffee_powder) add(1120, input.coffee_powder);
    if (input.honey) add(1123, input.honey);
    if (input.lemons) add(1121, input.lemons);
    if (input.oil) add(1114, input.oil);
    if (input.water_bottles) add(1107, input.water_bottles);

    // ── BOILED MILK (vessel weight → litres → raw materials) ──
    const boiledMilkLitres = processVesselEntries(input.boiled_milk_kitchen, vesselMap, density.boiled_milk)
      + processVesselEntries(input.boiled_milk_counter, vesselMap, density.boiled_milk);

    if (boiledMilkLitres > 0) {
      for (const [matId, ratioPerL] of Object.entries(boiledMilkRatio)) {
        add(matId, boiledMilkLitres * ratioPerL);
      }
    }

    // ── TEA DECOCTION (vessel weight → litres → raw materials) ──
    const decoctionLitres = processVesselEntries(input.tea_decoction, vesselMap, density.tea_decoction);

    if (decoctionLitres > 0) {
      for (const [matId, ratioPerL] of Object.entries(decoctionRatio)) {
        add(matId, decoctionLitres * ratioPerL);
      }
    }

    // ── TEA-SUGAR BOXES (count → raw materials) ──
    if (input.tea_sugar_boxes) {
      for (const [matId, qtyPerBox] of Object.entries(teaSugarBoxRatio)) {
        add(matId, input.tea_sugar_boxes * qtyPerBox);
      }
    }

    // ── PLAIN BUNS ──
    if (input.plain_buns) add(1104, input.plain_buns);

    // ── PREPARED BUN MASKA (count → bun + butter + sugar) ──
    if (input.prepared_bun_maska) {
      for (const [matId, qtyPerUnit] of Object.entries(bunMaskaRatio)) {
        add(matId, input.prepared_bun_maska * qtyPerUnit);
      }
    }

    // ── FRIED ITEMS (count → raw item + oil) ──
    if (input.raw_cutlets) add(1106, input.raw_cutlets);
    if (input.fried_cutlets) {
      add(1106, input.fried_cutlets);
      add(1114, input.fried_cutlets * friedOil[1106]);
    }
    if (input.raw_samosa) add(1113, input.raw_samosa);
    if (input.fried_samosa) {
      add(1113, input.fried_samosa);
      add(1114, input.fried_samosa * friedOil[1113]);
    }
    if (input.raw_cheese_balls) add(1116, input.raw_cheese_balls);
    if (input.fried_cheese_balls) {
      add(1116, input.fried_cheese_balls);
      add(1114, input.fried_cheese_balls * friedOil[1116]);
    }

    // ── OSMANIA BISCUITS ──
    if (input.osmania_packets) add(1105, input.osmania_packets * osmaniaPP);
    if (input.osmania_loose) add(1105, input.osmania_loose);

    // ── NILOUFER BOXES ──
    const nilouferTotal = (input.niloufer_storage || 0) + (input.niloufer_display || 0);
    if (nilouferTotal) add(1110, nilouferTotal);

    // ── MALAI (byproduct — tracked but not decomposed to raw materials) ──
    // Stored in raw_input for reference, not in decomposed totals

    return totals;
  }

  // Process vessel weight entries: [{vessel_code, weight_kg}] → total litres
  function processVesselEntries(entries, vesselMap, densityKgPerL) {
    if (!entries || !Array.isArray(entries) || entries.length === 0) return 0;
    let totalLitres = 0;
    for (const entry of entries) {
      const vessel = vesselMap[entry.vessel_code] || DEFAULT_VESSELS[entry.vessel_code];
      const tare = vessel ? vessel.empty_weight_kg : 0;
      const netKg = Math.max(0, (entry.weight_kg || 0) - tare);
      const litres = netKg / densityKgPerL;
      totalLitres += litres;
    }
    return round(totalLitres, 4);
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Get vessels from DB or defaults
// ═══════════════════════════════════════════════════════════════
async function getVessels(DB) {
  if (!DB) return [];
  try {
    const result = await DB.prepare('SELECT * FROM vessels WHERE active = 1 ORDER BY location, name').all();
    return result.results || [];
  } catch (e) {
    return []; // Table may not exist yet
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Get material cost (latest from DB or from Odoo standard_price)
// ═══════════════════════════════════════════════════════════════
// Hardcoded fallback costs from Odoo (last known purchase prices)
const FALLBACK_COSTS = {
  1095: 80,    // Buffalo Milk ₹80/L
  1096: 310,   // SMP ₹310/kg
  1097: 44,    // Sugar ₹44/kg
  1098: 500,   // Tea Powder ₹500/kg
  1101: 1.5,   // Filter Water ₹1.5/L
  1104: 8,     // Buns ₹8/unit
  1105: 6.65,  // Osmania Loose ₹6.65/unit
  1106: 15,    // Cutlet ₹15/unit
  1107: 6.7,   // Water Bottle ₹6.7/unit
  1110: 173,   // Osmania Box ₹173/unit
  1112: 326,   // Condensed Milk ₹326/kg
  1113: 8,     // Samosa ₹8/unit
  1114: 120,   // Oil ₹120/L (estimated)
  1116: 10,    // Cheese Balls ₹10/unit (estimated)
  1119: 500,   // Butter ₹500/kg (estimated)
  1120: 1200,  // Coffee Powder ₹1200/kg (estimated)
  1121: 5,     // Lemon ₹5/unit (estimated)
  1123: 400,   // Honey ₹400/kg (estimated)
};

// Batch-load all material costs up to a given date in one query
// Returns a map: materialId → cost_per_unit
async function getAllMaterialCosts(DB, asOfDate) {
  const costs = {};
  // Start with fallbacks
  for (const [id, cost] of Object.entries(FALLBACK_COSTS)) {
    costs[String(id)] = cost;
  }

  if (DB) {
    try {
      // Get the latest cost per material where effective_from <= settlement date
      // Uses a subquery to get the max effective_from per material
      const rows = await DB.prepare(`
        SELECT mc.material_id, mc.cost_per_unit FROM material_costs mc
        INNER JOIN (
          SELECT material_id, MAX(effective_from) as max_date
          FROM material_costs
          WHERE effective_from <= ?
          GROUP BY material_id
        ) latest ON mc.material_id = latest.material_id AND mc.effective_from = latest.max_date
      `).bind(asOfDate || '9999-12-31').all();

      for (const row of (rows.results || [])) {
        costs[String(row.material_id)] = row.cost_per_unit;
      }
    } catch (e) { /* table may not exist yet */ }
  }

  return costs;
}

// Single material cost lookup (used for individual queries)
async function getMaterialCost(DB, materialId, asOfDate) {
  if (DB) {
    try {
      const row = await DB.prepare(
        'SELECT cost_per_unit FROM material_costs WHERE material_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1'
      ).bind(String(materialId), asOfDate || '9999-12-31').first();
      if (row) return row.cost_per_unit;
    } catch (e) { /* table may not exist */ }
  }

  return FALLBACK_COSTS[materialId] || 0;
}

// ═══════════════════════════════════════════════════════════════
// ODOO: Fetch POS sales for the period (basic — for prepare endpoint)
// ═══════════════════════════════════════════════════════════════
async function fetchPOSSales(url, db, uid, apiKey, from, to) {
  const orderIds = await odooCall(url, db, uid, apiKey, 'pos.order', 'search',
    [[['config_id', 'in', [27, 28, 29]], ['date_order', '>=', from], ['date_order', '<', to],
      ['state', 'in', ['paid', 'done', 'invoiced', 'posted']]]]);
  if (!orderIds || orderIds.length === 0) return [];

  const lines = await odooCall(url, db, uid, apiKey, 'pos.order.line', 'search_read',
    [[['order_id', 'in', orderIds]]],
    {fields: ['product_id', 'qty', 'price_subtotal_incl']});

  const grouped = {};
  for (const line of lines) {
    const pid = line.product_id[0];
    if (!grouped[pid]) grouped[pid] = {productId: pid, productName: line.product_id[1], qtySold: 0, amount: 0};
    grouped[pid].qtySold += line.qty;
    grouped[pid].amount += line.price_subtotal_incl;
  }
  return Object.values(grouped).sort((a, b) => b.amount - a.amount);
}

// ═══════════════════════════════════════════════════════════════
// ODOO: Fetch POS sales WITH channel breakdown (for submit endpoint)
// Returns: {total, cashCounter, runnerCounter, whatsapp, products: {pid: {name, qty, amount}}}
// ═══════════════════════════════════════════════════════════════
async function fetchPOSSalesWithChannels(url, db, uid, apiKey, from, to) {
  // Fetch orders with config_id for channel breakdown
  const orders = await odooCall(url, db, uid, apiKey, 'pos.order', 'search_read',
    [[['config_id', 'in', [27, 28, 29]], ['date_order', '>=', from], ['date_order', '<', to],
      ['state', 'in', ['paid', 'done', 'invoiced', 'posted']]]],
    {fields: ['id', 'config_id', 'amount_total']});

  if (!orders || orders.length === 0) {
    return {total: 0, cashCounter: 0, runnerCounter: 0, whatsapp: 0, products: {}};
  }

  // Channel breakdown from config_id
  // 27 = Cash Counter, 28 = Runner Counter, 29 = Delivery (WhatsApp/Swiggy/Zomato)
  let cashCounter = 0, runnerCounter = 0, whatsapp = 0;
  for (const order of orders) {
    const configId = order.config_id?.[0] || 0;
    if (configId === 27) cashCounter += order.amount_total;
    else if (configId === 28) runnerCounter += order.amount_total;
    else if (configId === 29) whatsapp += order.amount_total;
  }

  const orderIds = orders.map(o => o.id);
  const lines = await odooCall(url, db, uid, apiKey, 'pos.order.line', 'search_read',
    [[['order_id', 'in', orderIds]]],
    {fields: ['product_id', 'qty', 'price_subtotal_incl']});

  const products = {};
  let total = 0;
  for (const line of lines) {
    const pid = line.product_id[0];
    if (!products[pid]) products[pid] = {name: line.product_id[1], qty: 0, amount: 0};
    products[pid].qty += line.qty;
    products[pid].amount += line.price_subtotal_incl;
    total += line.price_subtotal_incl;
  }

  return {total, cashCounter, runnerCounter, whatsapp, products};
}

// ═══════════════════════════════════════════════════════════════
// ODOO: Fetch purchases received in the period
// ═══════════════════════════════════════════════════════════════
async function fetchPurchasesReceived(url, db, uid, apiKey, from, to) {
  // Get completed incoming pickings for NCH
  const pickings = await odooCall(url, db, uid, apiKey, 'stock.picking', 'search_read',
    [[['state', '=', 'done'], ['picking_type_id.code', '=', 'incoming'],
      ['date_done', '>=', from], ['date_done', '<', to], ['company_id', '=', 10]]],
    {fields: ['id', 'origin', 'move_ids']});

  if (!pickings || pickings.length === 0) return [];

  // Get all moves
  const allMoveIds = pickings.flatMap(p => p.move_ids || []);
  if (allMoveIds.length === 0) return [];

  const moves = await odooCall(url, db, uid, apiKey, 'stock.move', 'read',
    [allMoveIds], {fields: ['product_id', 'quantity']});

  // Get PO lines for cost data — weighted average per product across all POs
  const poNames = [...new Set(pickings.map(p => p.origin).filter(Boolean))];
  // Map product_id → [{price_unit, product_qty}] for weighted average
  let poLineCostData = {};
  if (poNames.length > 0) {
    const poLines = await odooCall(url, db, uid, apiKey, 'purchase.order.line', 'search_read',
      [[['order_id.name', 'in', poNames]]], {fields: ['product_id', 'price_unit', 'product_qty']});
    for (const pl of poLines) {
      const pid = pl.product_id[0];
      if (!poLineCostData[pid]) poLineCostData[pid] = [];
      poLineCostData[pid].push({price: pl.price_unit, qty: pl.product_qty});
    }
  }

  // Calculate weighted average cost per product
  const poLineCosts = {};
  for (const [pid, entries] of Object.entries(poLineCostData)) {
    const totalQty = entries.reduce((s, e) => s + e.qty, 0);
    if (totalQty > 0) {
      const totalCost = entries.reduce((s, e) => s + e.price * e.qty, 0);
      poLineCosts[pid] = totalCost / totalQty; // Weighted average
    } else if (entries.length > 0) {
      poLineCosts[pid] = entries[0].price; // Fallback: first PO line price
    }
  }

  // Build result — if no PO cost found, use FALLBACK_COSTS as safety net
  const result = [];
  for (const move of moves) {
    const pid = move.product_id[0];
    const qty = move.quantity || 0;
    const unitCost = poLineCosts[pid] || FALLBACK_COSTS[pid] || 0;
    result.push({
      materialId: pid,
      materialName: move.product_id[1],
      qty,
      unitCost,
      cost: qty * unitCost,
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// ODOO JSON-RPC
// ═══════════════════════════════════════════════════════════════
async function odooCall(url, db, uid, apiKey, model, method, positionalArgs, kwargs) {
  const payload = {
    jsonrpc: '2.0', method: 'call',
    params: {service: 'object', method: 'execute_kw',
      args: [db, uid, apiKey, model, method, positionalArgs, kwargs || {}]},
    id: Date.now(),
  };
  const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  const data = await response.json();
  if (data.error) throw new Error(`Odoo ${model}.${method}: ${data.error.message || JSON.stringify(data.error)}`);
  return data.result;
}

// IST now
function istNow() {
  return new Date(Date.now() + 5.5 * 3600000);
}

// JSON response helper
function json(data, headers) {
  return new Response(JSON.stringify(data), {headers});
}

// WhatsApp helper
async function sendWhatsApp(phoneId, token, to, message) {
  try {
    await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({messaging_product: 'whatsapp', to, type: 'text', text: {body: message}})
    });
  } catch (e) { console.error('WA error:', e.message); }
}
