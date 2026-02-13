// NCH Daily Settlement API — Cloudflare Worker
// The intelligence layer: staff enters physical counts → system calculates everything
// Settlement period: previous settled_at → now (timestamp-based, not day-fixed)

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

  const PINS = {'6890': 'Tanveer', '7115': 'Md Kesmat', '3946': 'Jafar', '3678': 'Farooq', '9991': 'Mujib', '4759': 'Jahangir', '1002': 'Rarup', '0305': 'Nihaf', '2026': 'Zoya', '3697': 'Yashwant', '3754': 'Naveen', '8241': 'Nafees'};

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
    1102: { // Nawabi Special Coffee (2x chai's boiled milk + coffee + honey)
      name: 'Nawabi Special Coffee', code: 'NCH-NSC', price: 30,
      materials: {
        1095: 0.11484,   // Buffalo Milk (L) — 2x chai's milk (milk poured directly into coffee powder)
        1096: 0.002871,  // SMP (kg) — scaled proportionally with milk
        1112: 0.002297,  // Condensed Milk (kg) — scaled proportionally with milk
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
  // dry_goods: 1.0 = kg/kg (weight IS the quantity, no density conversion)
  const DENSITY = {
    boiled_milk: 1.035,
    tea_decoction: 1.03,
    oil: 0.92,
    raw_milk: 1.032,
    dry_goods: 1.0,
  };

  // ═══════════════════════════════════════════════════════════
  // FIELD_TO_PRODUCTS: Maps input fields → POS products affected by counting gaps
  // Used for timestamp-based gap adjustment: if a field was counted early,
  // we query POS for products sold between count time and submission time
  // ═══════════════════════════════════════════════════════════
  const FIELD_TO_PRODUCTS = {
    'prepared_bun_maska': [1029, 1118],
    'plain_buns': [1029, 1118],
    // Fried items: split by location
    'fried_cutlets_kitchen': [1031], 'fried_cutlets_display': [1031],
    'raw_cutlets': [1031],
    'fried_samosa_kitchen': [1115], 'fried_samosa_display': [1115],
    'raw_samosa': [1115],
    'fried_cheese_balls_kitchen': [1117], 'fried_cheese_balls_display': [1117],
    'raw_cheese_balls': [1117],
    // Vessels: split kitchen/counter
    'boiled_milk_kitchen': [1028, 1102],
    'boiled_milk_counter': [1028, 1102],
    'tea_decoction_kitchen': [1028, 1103],
    'tea_decoction_counter': [1028, 1103],
    // Osmania: split by location
    'osmania_packets_kitchen': [1030, 1033], 'osmania_packets_display': [1030, 1033],
    'osmania_loose_display': [1030, 1033],
    // Water: split by location
    'water_bottles_kitchen': [1094], 'water_bottles_display': [1094],
    // Niloufer: split by location
    'niloufer_kitchen': [1111], 'niloufer_display': [1111],
    // Container weighing (alternative to direct kg)
    'sugar_container': [],      // sugar doesn't affect product sales (slow item)
    'tea_powder_container': [], // tea powder doesn't affect product sales (slow item)
    // Backward compat: old field names
    'fried_cutlets': [1031], 'fried_samosa': [1115], 'fried_cheese_balls': [1117],
    'osmania_packets': [1030, 1033], 'osmania_loose': [1030, 1033],
    'water_bottles': [1094], 'niloufer_storage': [1111],
    'tea_decoction': [1028, 1103],
  };

  // Zone-based gap thresholds (seconds) — replaces single GAP_THRESHOLD_SECONDS
  // Freezer/Kitchen = 10 min (slow items), Display/Tea Counter = 5 min (fast items)
  const ZONE_THRESHOLDS = { freezer: 600, kitchen: 600, display_counter: 300, tea_counter: 300 };
  const FIELD_ZONES = {
    'raw_buffalo_milk': 'freezer', 'raw_cutlets': 'freezer', 'raw_samosa': 'freezer',
    'raw_cheese_balls': 'freezer', 'butter': 'freezer',
    'raw_sugar': 'kitchen', 'raw_milkmaid': 'kitchen', 'raw_smp': 'kitchen',
    'raw_tea_powder': 'kitchen', 'tea_sugar_boxes': 'kitchen', 'coffee_powder': 'kitchen',
    'honey': 'kitchen', 'lemons': 'kitchen', 'oil': 'kitchen', 'plain_buns': 'kitchen',
    'water_bottles_kitchen': 'kitchen', 'niloufer_kitchen': 'kitchen',
    'osmania_packets_kitchen': 'kitchen', 'fried_cutlets_kitchen': 'kitchen',
    'fried_samosa_kitchen': 'kitchen', 'fried_cheese_balls_kitchen': 'kitchen',
    'malai': 'kitchen', 'boiled_milk_kitchen': 'kitchen', 'tea_decoction_kitchen': 'kitchen',
    'water_bottles_display': 'display_counter', 'niloufer_display': 'display_counter',
    'osmania_packets_display': 'display_counter', 'osmania_loose_display': 'display_counter',
    'fried_cutlets_display': 'display_counter', 'fried_samosa_display': 'display_counter',
    'fried_cheese_balls_display': 'display_counter', 'prepared_bun_maska': 'display_counter',
    'boiled_milk_counter': 'tea_counter', 'tea_decoction_counter': 'tea_counter',
  };

  // Default vessel weights (updated from DB if available)
  // These are starting approximations — real values entered after weighing
  const DEFAULT_VESSELS = {
    'KIT-PATILA-1': {name: 'Kitchen Large Patila', liquid_type: 'boiled_milk', location: 'kitchen', empty_weight_kg: 12.9},
    'KIT-MILK-2': {name: 'Kitchen Milk Vessel 2', liquid_type: 'boiled_milk', location: 'kitchen', empty_weight_kg: 3.498},
    'CTR-MILK-1': {name: 'Counter Milk Vessel (Copper Samawar)', liquid_type: 'boiled_milk', location: 'counter', empty_weight_kg: 3.15},
    'CTR-DEC-1': {name: 'Counter Decoction Vessel (Copper)', liquid_type: 'decoction', location: 'counter', empty_weight_kg: 5.05},
    'KIT-DEC-1': {name: 'Kitchen Decoction Prep Vessel', liquid_type: 'decoction', location: 'kitchen', empty_weight_kg: 6.0},
    'KIT-DRY-1': {name: 'Sugar/Tea Powder Container', liquid_type: 'dry_goods', location: 'kitchen', empty_weight_kg: 1.7},
  };

  // ═══════════════════════════════════════════════════════════
  // WASTAGE DECOMPOSITION: item + state → raw material breakdown
  // Used when staff records wastage in its physical state
  // ═══════════════════════════════════════════════════════════
  const WASTAGE_DECOMPOSITION = {
    buffalo_milk: {
      label: 'Buffalo Milk', uom: 'L',
      states: {
        raw: {label: 'Raw', decomp: {1095: 1}},
        boiled: {label: 'Boiled', decomp: {1095: 0.957, 1096: 0.02392, 1112: 0.01914}},
      }
    },
    cutlet: {
      label: 'Cutlet', uom: 'units',
      states: {
        frozen: {label: 'Frozen/Raw', decomp: {1106: 1}},
        fried: {label: 'Fried', decomp: {1106: 1, 1114: 0.03}},
      }
    },
    samosa: {
      label: 'Samosa', uom: 'units',
      states: {
        frozen: {label: 'Frozen/Raw', decomp: {1113: 1}},
        fried: {label: 'Fried', decomp: {1113: 1, 1114: 0.02}},
      }
    },
    cheese_balls: {
      label: 'Cheese Balls', uom: 'units',
      states: {
        frozen: {label: 'Frozen/Raw', decomp: {1116: 1}},
        fried: {label: 'Fried', decomp: {1116: 1, 1114: 0.015}},
      }
    },
    buns: {
      label: 'Buns', uom: 'units',
      states: {
        plain: {label: 'Plain', decomp: {1104: 1}},
        bun_maska: {label: 'Bun Maska (prepared)', decomp: {1104: 1, 1119: 0.05, 1097: 0.004}},
      }
    },
    tea_decoction: {
      label: 'Tea Decoction', uom: 'L',
      states: {
        liquid: {label: 'Liquid', decomp: {1098: 0.005618, 1097: 0.01124, 1101: 0.9831}},
      }
    },
    sugar: {
      label: 'Sugar', uom: 'kg',
      states: { raw: {label: 'Raw', decomp: {1097: 1}} }
    },
    tea_powder: {
      label: 'Tea Powder', uom: 'kg',
      states: { raw: {label: 'Raw', decomp: {1098: 1}} }
    },
    oil: {
      label: 'Oil', uom: 'L',
      states: { waste: {label: 'Used/Waste', decomp: {1114: 1}} }
    },
    condensed_milk: {
      label: 'Condensed Milk', uom: 'kg',
      states: { raw: {label: 'Raw', decomp: {1112: 1}} }
    },
    smp: {
      label: 'SMP (Milk Powder)', uom: 'kg',
      states: { raw: {label: 'Raw', decomp: {1096: 1}} }
    },
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
        wastageItems: WASTAGE_DECOMPOSITION,
      }, corsHeaders);
    }

    // ─── PREPARE: fetch all data needed for settlement ────────
    if (action === 'prepare') {
      const now = istNow();

      // Get previous settlement (for opening stock and period start)
      const previous = DB ? await DB.prepare(
        'SELECT * FROM daily_settlements WHERE status IN (?, ?) ORDER BY settled_at DESC LIMIT 1'
      ).bind('completed', 'bootstrap').first() : null;

      // Period: previous settled_at → now (timestamp-based)
      const periodStartIST = previous ? previous.settled_at : now.toISOString();
      const periodEndIST = now.toISOString();
      const settlementDate = now.toISOString().slice(0, 10); // business date for display

      // Convert to UTC Date objects for Odoo queries
      const periodStartUTC = new Date(periodStartIST);
      const periodEndUTC = new Date(periodEndIST);
      const fromOdoo = periodStartUTC.toISOString().slice(0, 19).replace('T', ' ');
      const toOdoo = periodEndUTC.toISOString().slice(0, 19).replace('T', ' ');

      // Parallel: fetch sales (with channels + complimentary), purchases, expenses, vessels
      const [revenue, purchaseData, vessels, expenseData] = await Promise.all([
        fetchPOSSalesWithChannels(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
        fetchPurchasesReceived(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromOdoo, toOdoo),
        getVessels(DB),
        DB ? DB.prepare('SELECT * FROM counter_expenses WHERE recorded_at >= ? AND recorded_at < ?').bind(periodStartUTC.toISOString(), periodEndUTC.toISOString()).all() : {results: []},
      ]);

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

      // Staff salaries — prorated by period length
      const periodHours = (periodEndUTC - periodStartUTC) / 3600000;
      let periodSalaries = 0;
      const salaryData = [];
      if (DB) {
        const salaries = await DB.prepare('SELECT * FROM staff_salaries WHERE active = 1').all();
        for (const s of (salaries.results || [])) {
          const prorated = round((s.monthly_salary / 30) * (periodHours / 24), 2);
          periodSalaries += prorated;
          salaryData.push({name: s.name, role: s.role, monthly: s.monthly_salary, daily: round(s.monthly_salary / 30, 2), prorated});
        }
      }

      return json({
        success: true,
        settlementDate,
        period: {start: periodStartIST, end: periodEndIST, hours: round(periodHours, 2)},
        needsBootstrap: !previous,
        previousSettlement: previous ? {
          id: previous.id,
          date: previous.settlement_date,
          status: previous.status,
          settledAt: previous.settled_at,
        } : null,
        openingStock,
        revenue,
        complimentaryProducts: revenue.complimentaryProducts || {},
        purchases: purchaseData,
        counterExpenses,
        salaries: {prorated: periodSalaries, daily: salaryData.reduce((s, x) => s + x.daily, 0), staff: salaryData, periodHours: round(periodHours, 2)},
        vessels,
        recipes: RECIPES,
        rawMaterials: RAW_MATERIALS,
      }, corsHeaders);
    }

    // ─── SUBMIT: process settlement with physical counts ──────
    if (action === 'submit' && context.request.method === 'POST') {
      if (!DB) return json({success: false, error: 'Database not configured'}, corsHeaders);

      const body = await context.request.json();
      const {pin, raw_input, wastage_items, runner_tokens, notes, is_bootstrap, field_timestamps, photo_verifications, edit_trail} = body;

      // Validate PIN
      const settledBy = PINS[pin];
      if (!settledBy) return json({success: false, error: 'Invalid PIN'}, corsHeaders);

      // Guard against rapid re-submission (within 2 minutes)
      const lastSettlement = await DB.prepare(
        'SELECT settled_at FROM daily_settlements ORDER BY settled_at DESC LIMIT 1'
      ).first();
      if (lastSettlement) {
        const lastTime = new Date(lastSettlement.settled_at).getTime();
        if (Date.now() - lastTime < 120000) {
          return json({success: false, error: 'A settlement was just submitted. Please wait 2 minutes before submitting another.'}, corsHeaders);
        }
      }

      // Period: previous settled_at → now (timestamp-based)
      const nowUTC = new Date();
      const nowIST = istNow();
      const settlement_date = nowIST.toISOString().slice(0, 10); // business date for display

      // ── Step 1: Decompose raw input into raw materials ──
      const vessels = await getVessels(DB);
      const vesselMap = {};
      for (const v of vessels) vesselMap[v.code] = v;

      const decomposed = decomposeInput(raw_input, vesselMap, DENSITY, BOILED_MILK_RATIO, DECOCTION_RATIO, TEA_SUGAR_BOX_RATIO, FRIED_OIL, BUN_MASKA_RATIO, OSMANIA_PER_PACKET);

      // If bootstrap: just store the count, no P&L
      if (is_bootstrap) {
        const settledAtISO = nowUTC.toISOString();
        await DB.prepare(`INSERT INTO daily_settlements
          (settlement_date, period_start, period_end, settled_by, settled_at, status,
           inventory_raw_input, inventory_decomposed, inventory_closing,
           runner_tokens, runner_tokens_total, notes, edit_trail)
          VALUES (?, ?, ?, ?, ?, 'bootstrap', ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          settlement_date, settledAtISO, settledAtISO, settledBy, settledAtISO,
          JSON.stringify(raw_input), JSON.stringify(decomposed), JSON.stringify(decomposed),
          JSON.stringify(runner_tokens || {}),
          Object.values(runner_tokens || {}).reduce((s, v) => s + v, 0),
          notes || '',
          JSON.stringify(edit_trail || {})
        ).run();

        return json({
          success: true,
          message: 'Bootstrap settlement recorded — baseline inventory established',
          settlementDate: settlement_date,
          settledBy,
          status: 'bootstrap',
          inventory: decomposed,
          rawInput: raw_input,
        }, corsHeaders);
      }

      // ── Step 2: Get previous settlement (opening stock) ──
      const previous = await DB.prepare(
        'SELECT * FROM daily_settlements WHERE status IN (?, ?) ORDER BY settled_at DESC LIMIT 1'
      ).bind('completed', 'bootstrap').first();

      if (!previous) return json({success: false, error: 'No previous settlement found. Please do a bootstrap settlement first.'}, corsHeaders);

      // Period: previous settled_at → now
      const periodStartIST = previous.settled_at;
      const periodEndIST = nowUTC.toISOString();
      const periodStartUTC = new Date(periodStartIST);
      const periodEndUTC = nowUTC;
      const fromOdoo = periodStartUTC.toISOString().slice(0, 19).replace('T', ' ');
      const toOdoo = periodEndUTC.toISOString().slice(0, 19).replace('T', ' ');

      // Use inventory_closing (gap-adjusted) as opening stock, falling back to inventory_decomposed for older records
      const openingStock = JSON.parse(previous.inventory_closing || previous.inventory_decomposed || '{}');
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

      // ── Step 6b: Timestamp gap adjustment ──
      // If staff counted items at different times (e.g., buns at 22:00, vessels at 22:28),
      // items sold between 22:00–22:28 are "phantom stock" in the bun count.
      // We query POS for products sold in each gap and subtract from closing stock.
      const timestampAdjustments = {};
      const closingStock = {...decomposed}; // mutable copy

      if (field_timestamps && typeof field_timestamps === 'object' && Object.keys(field_timestamps).length > 0) {
        // Find the latest timestamp (effective submission time)
        let latestTs = 0;
        let latestField = '';
        for (const [fieldId, isoStr] of Object.entries(field_timestamps)) {
          const t = new Date(isoStr).getTime();
          if (t > latestTs) { latestTs = t; latestField = fieldId; }
        }

        if (latestTs > 0) {
          // Collect unique product IDs and their gap windows
          // Group by gap window to minimize Odoo queries
          const gapQueries = []; // [{fieldId, fromUTC, toUTC, productIds, gapSeconds}]

          for (const [fieldId, isoStr] of Object.entries(field_timestamps)) {
            if (!FIELD_TO_PRODUCTS[fieldId]) continue; // skip fields without product mapping (slow items)
            const fieldTs = new Date(isoStr).getTime();
            const gapSeconds = (latestTs - fieldTs) / 1000;

            const zone = FIELD_ZONES[fieldId] || 'kitchen';
            const threshold = ZONE_THRESHOLDS[zone] || 600;
            if (gapSeconds >= threshold) {
              const fromUTC = new Date(fieldTs).toISOString().slice(0, 19).replace('T', ' ');
              const toUTC = new Date(latestTs).toISOString().slice(0, 19).replace('T', ' ');
              gapQueries.push({
                fieldId,
                fromUTC,
                toUTC,
                productIds: FIELD_TO_PRODUCTS[fieldId],
                gapSeconds: Math.round(gapSeconds),
              });
            }
          }

          // Execute gap queries in parallel (batch by unique time windows to minimize API calls)
          if (gapQueries.length > 0) {
            const gapResults = await Promise.all(
              gapQueries.map(gq =>
                fetchGapSalesForProducts(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, gq.productIds, gq.fromUTC, gq.toUTC)
                  .then(sales => ({...gq, sales}))
                  .catch(e => ({...gq, sales: {}, error: e.message}))
              )
            );

            // Decompose gap sales into raw materials and subtract from closing stock
            for (const gq of gapResults) {
              const fieldAdj = {
                timestamp: field_timestamps[gq.fieldId],
                gapSeconds: gq.gapSeconds,
                productsSold: {},
                rawMaterialsAdjusted: {},
              };

              for (const [pid, salesData] of Object.entries(gq.sales)) {
                const productId = parseInt(pid);
                const recipe = RECIPES[productId];
                if (!recipe || salesData.qty <= 0) continue;

                fieldAdj.productsSold[pid] = {name: salesData.name, qty: salesData.qty};

                // Decompose sold products back to raw materials
                for (const [matId, qtyPerUnit] of Object.entries(recipe.materials)) {
                  const rawQtyUsed = round(salesData.qty * qtyPerUnit, 4);
                  const key = String(matId);

                  // Subtract from closing stock
                  if (closingStock[key] !== undefined) {
                    closingStock[key] = round(closingStock[key] - rawQtyUsed, 4);
                    // Don't go below zero — if closing was already low, something else is off
                    if (closingStock[key] < 0) closingStock[key] = 0;
                  }

                  if (!fieldAdj.rawMaterialsAdjusted[key]) fieldAdj.rawMaterialsAdjusted[key] = 0;
                  fieldAdj.rawMaterialsAdjusted[key] = round(fieldAdj.rawMaterialsAdjusted[key] + rawQtyUsed, 4);
                }
              }

              // Only record adjustment if products were actually sold in the gap
              if (Object.keys(fieldAdj.productsSold).length > 0) {
                timestampAdjustments[gq.fieldId] = fieldAdj;
              }
            }
          }
        }
      }

      // ── Step 7: Calculate ACTUAL consumption ──
      // consumption = opening + purchases - closing (where closing may be adjusted for timestamp gaps)
      // IMPORTANT: Negative consumption is preserved — it signals counting errors or unrecorded purchases
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

      // ── Step 10: Decompose wastage → raw materials, then calculate discrepancy ──
      // Wastage comes in two formats:
      //   New: {item, state, qty, reason} → decompose via WASTAGE_DECOMPOSITION
      //   Old: {material_id, qty, reason} → direct material subtraction (backward compat)
      const wastedRawMaterials = {}; // matId → total wasted qty
      for (const w of (wastage_items || [])) {
        if (w.item && w.state && WASTAGE_DECOMPOSITION[w.item]?.states[w.state]) {
          // New format: decompose by state
          const decomp = WASTAGE_DECOMPOSITION[w.item].states[w.state].decomp;
          for (const [matId, qtyPerUnit] of Object.entries(decomp)) {
            const key = String(matId);
            wastedRawMaterials[key] = round((wastedRawMaterials[key] || 0) + (w.qty || 0) * qtyPerUnit, 4);
          }
        } else if (w.material_id) {
          // Old format: direct material_id
          const key = String(w.material_id);
          wastedRawMaterials[key] = round((wastedRawMaterials[key] || 0) + (w.qty || 0), 4);
        }
      }

      // Calculate discrepancy (= missing) per material
      // discrepancy = actual_consumption - expected_consumption - wastage
      // IMPORTANT: Iterate over BOTH consumption and expectedConsumption keys
      const discrepancy = {};
      let discrepancyValue = 0;
      const allDiscMaterialIds = new Set([
        ...Object.keys(consumption),
        ...Object.keys(expectedConsumption),
      ]);

      for (const matId of allDiscMaterialIds) {
        const actual = consumption[matId] || 0;
        const expected = expectedConsumption[matId] || 0;
        const wastedQty = wastedRawMaterials[matId] || 0;
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

      // ── Step 12: Wastage value (from decomposed raw materials) ──
      let wastageValue = 0;
      for (const [matId, qty] of Object.entries(wastedRawMaterials)) {
        const cost = getCost(matId);
        wastageValue += qty * cost;
      }
      wastageValue = round(wastageValue, 2);

      // ── Step 13: Operating Expenses ──
      let counterExpenses = 0;
      for (const e of (expenseData.results || [])) counterExpenses += e.amount;

      // Salary proration: (monthly/30) × (periodHours/24)
      const periodHours = (periodEndUTC - periodStartUTC) / 3600000;
      let dailySalaries = 0;
      const salaries = await DB.prepare('SELECT * FROM staff_salaries WHERE active = 1').all();
      for (const s of (salaries.results || [])) dailySalaries += round((s.monthly_salary / 30) * (periodHours / 24), 2);

      const opexTotal = round(dailySalaries + counterExpenses, 2);

      // ── Step 14: P&L ──
      const grossProfit = round(revenue.total - cogsActual, 2);
      const netProfit = round(grossProfit - opexTotal, 2);
      const adjustedNetProfit = round(netProfit - discrepancyValue - wastageValue, 2);

      // ── Step 15: Save to DB ──
      const settledAtISO = nowUTC.toISOString();
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
         adjusted_net_profit, notes, previous_settlement_id, timestamp_adjustments, edit_trail)
        VALUES (?, ?, ?, ?, ?, 'completed',
                ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?,
                ?, ?,
                ?, ?, ?, ?, ?)`
      ).bind(
        settlement_date, periodStartIST, periodEndIST, settledBy, settledAtISO,
        revenue.total, revenue.cashCounter, revenue.runnerCounter, revenue.whatsapp,
        JSON.stringify({...revenue.products, __complimentary: revenue.complimentaryProducts || {}}),
        cogsActual, cogsExpected, grossProfit,
        dailySalaries, counterExpenses, opexTotal,
        netProfit,
        JSON.stringify(raw_input), JSON.stringify(decomposed), JSON.stringify(openingStock), JSON.stringify(purchases), JSON.stringify(closingStock),
        JSON.stringify(consumption), JSON.stringify(expectedConsumption), JSON.stringify(discrepancy), discrepancyValue,
        JSON.stringify(wastage_items || []), wastageValue,
        JSON.stringify(currentTokens), currentTokenTotal,
        adjustedNetProfit, notes || '', previous ? previous.id : null,
        JSON.stringify(timestampAdjustments), JSON.stringify(edit_trail || {})
      ).run();

      // ── Step 15b: Sync closing stock to Odoo inventory ──
      let odooSyncResult = null;
      try {
        odooSyncResult = await syncInventoryToOdoo(
          ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, closingStock, 10);
      } catch (syncErr) {
        odooSyncResult = {error: syncErr.message};
      }

      // ── Step 16: WhatsApp summary ──
      const WA_TOKEN = context.env.WA_ACCESS_TOKEN;
      const WA_PHONE_ID = context.env.WA_PHONE_ID || '970365416152029';
      if (WA_TOKEN) {
        const profitEmoji = adjustedNetProfit >= 0 ? '📈' : '📉';
        const warningLines = consumptionWarnings.length > 0
          ? `\n🚨 *${consumptionWarnings.length} Warning(s):*\n` + consumptionWarnings.map(w => `  • ${w.materialName}: negative consumption`).join('\n') + '\n'
          : '';
        const adjCount = Object.keys(timestampAdjustments).length;
        const adjLines = adjCount > 0
          ? `\n⏱️ *${adjCount} Gap Adjustment(s):*\n` + Object.entries(timestampAdjustments).map(([f, a]) => `  • ${f}: ${Math.round(a.gapSeconds/60)}min gap, ${Object.keys(a.productsSold).length} products adjusted`).join('\n') + '\n'
          : '';
        const channelBreakdown = revenue.cashCounter > 0 || revenue.runnerCounter > 0 || revenue.whatsapp > 0
          ? `  Counter: ₹${Math.round(revenue.cashCounter).toLocaleString('en-IN')} | Runner: ₹${Math.round(revenue.runnerCounter).toLocaleString('en-IN')} | Delivery: ₹${Math.round(revenue.whatsapp).toLocaleString('en-IN')}\n`
          : '';
        const pHrs = round((periodEndUTC - periodStartUTC) / 3600000, 1);
        const msg = `☕ *NCH Settlement — ${settlement_date}* (${pHrs}h period)\n\n`
          + `💰 Revenue: ₹${Math.round(revenue.total).toLocaleString('en-IN')}\n`
          + channelBreakdown
          + `📦 COGS: ₹${Math.round(cogsActual).toLocaleString('en-IN')}\n`
          + `📊 Gross Profit: ₹${Math.round(grossProfit).toLocaleString('en-IN')}\n`
          + `💸 Expenses: ₹${Math.round(opexTotal).toLocaleString('en-IN')}\n`
          + (wastageValue > 0 ? `🗑️ Wastage: ₹${Math.round(wastageValue).toLocaleString('en-IN')}\n` : '')
          + (Math.abs(discrepancyValue) > 10 ? `⚠️ Discrepancy: ₹${Math.round(discrepancyValue).toLocaleString('en-IN')}\n` : '')
          + warningLines
          + adjLines
          + `\n${profitEmoji} *Net Profit: ₹${Math.round(adjustedNetProfit).toLocaleString('en-IN')}*\n`
          + `\nSettled by: ${settledBy}`;

        const recipients = ['917010426808', '918073476051'];
        context.waitUntil(Promise.all(recipients.map(to =>
          sendWhatsApp(WA_PHONE_ID, WA_TOKEN, to, msg)
        )).catch(e => console.error('P&L WA alert error:', e.message)));
      }

      // ── Step 17: Photo verification discrepancy check ──
      // Compare AI readings from photos against staff-entered values
      // Send WhatsApp alert ONLY if discrepancy detected
      if (photo_verifications && Object.keys(photo_verifications).length > 0 && WA_TOKEN) {
        const discrepancies = [];
        const THRESHOLDS = {scale: 0.5, count: 1}; // 0.5kg tolerance for scale, 1 unit for counts

        for (const [fieldId, pv] of Object.entries(photo_verifications)) {
          if (pv.confidence === 'low') continue; // skip low-confidence readings

          let staffValue = null;
          const threshold = THRESHOLDS[pv.type] || 1;

          if (pv.type === 'scale') {
            // Vessel fields — staff value is the gross weight from vessel entries
            // The AI reads the scale display which shows gross weight
            const vesselContainers = ['boiled_milk_kitchen', 'boiled_milk_counter', 'tea_decoction'];
            for (const vc of vesselContainers) {
              const entries = raw_input[vc];
              if (Array.isArray(entries)) {
                for (const entry of entries) {
                  // Match by field_id pattern: photo_{container}_{timestamp}
                  if (fieldId.startsWith(`photo_${vc}_`) || fieldId.includes(vc)) {
                    staffValue = entry.weight_kg;
                    break;
                  }
                }
              }
              if (staffValue !== null) break;
            }
          } else {
            // Count fields — direct field name match
            staffValue = raw_input[fieldId];
            if (staffValue === undefined) staffValue = null;
          }

          if (staffValue !== null && pv.ai_reading !== undefined) {
            const diff = Math.abs(staffValue - pv.ai_reading);
            if (diff > threshold) {
              discrepancies.push({
                field: fieldId.replace(/_/g, ' '),
                staffEntered: staffValue,
                aiReading: pv.ai_reading,
                difference: diff,
                type: pv.type,
                confidence: pv.confidence,
              });
            }
          }
        }

        if (discrepancies.length > 0) {
          const alertMsg = `🚨 *INVENTORY PHOTO VERIFICATION ALERT*\n`
            + `📅 Settlement: ${settlement_date}\n`
            + `👤 Settled by: ${settledBy}\n\n`
            + `⚠️ *${discrepancies.length} discrepanc${discrepancies.length === 1 ? 'y' : 'ies'} detected:*\n\n`
            + discrepancies.map(d =>
              `• *${d.field}*\n`
              + `  Staff entered: ${d.staffEntered}${d.type === 'scale' ? ' kg' : ''}\n`
              + `  AI reading: ${d.aiReading}${d.type === 'scale' ? ' kg' : ''}\n`
              + `  Difference: ${d.difference}${d.type === 'scale' ? ' kg' : ' units'}\n`
              + `  Confidence: ${d.confidence}`
            ).join('\n\n')
            + `\n\n_Review immediately — potential data entry error or manipulation._`;

          const WA_PHONE_ID2 = context.env.WA_PHONE_ID || '970365416152029';
          const alertRecipients = ['917010426808']; // Owner only
          context.waitUntil(Promise.all(alertRecipients.map(to =>
            sendWhatsApp(WA_PHONE_ID2, WA_TOKEN, to, alertMsg)
          )).catch(e => console.error('Photo alert WA error:', e.message)));
        }
      }

      return json({
        success: true,
        message: 'Daily settlement completed',
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
        rawInput: raw_input,
        inventory: {
          opening: openingStock,
          purchases,
          closing: closingStock,
          consumption,
          expected: expectedConsumption,
          discrepancy,
          wastedRawMaterials,
        },
        period: {start: periodStartIST, end: periodEndIST, hours: round((periodEndUTC - periodStartUTC) / 3600000, 2)},
        warnings: consumptionWarnings,
        runnerTokens: {current: currentTokens, previous: prevRunnerTokens},
        products: revenue.products,
        complimentaryProducts: revenue.complimentaryProducts || {},
        timestampAdjustments: Object.keys(timestampAdjustments).length > 0 ? timestampAdjustments : null,
        odooSyncResult,
      }, corsHeaders);
    }

    // ─── VERIFY PHOTO: AI-powered verification via Gemini ─────
    if (action === 'verify-photo' && context.request.method === 'POST') {
      const GEMINI_KEY = context.env.GEMINI_API_KEY;
      if (!GEMINI_KEY) return json({success: false, error: 'AI verification not configured'}, corsHeaders);

      const body = await context.request.json();
      const {field_id, type, image_base64} = body;
      if (!image_base64 || !type) return json({success: false, error: 'Missing image or type'}, corsHeaders);

      try {
        const prompt = type === 'scale'
          ? 'You are verifying a weighing scale photo for inventory audit. Read the weight displayed on this digital weighing scale. The display shows a number in kg. Return ONLY the numeric weight value you see on the scale display. If you cannot read the display clearly, set confidence to "low". Do NOT guess — only report what is clearly visible.'
          : `You are verifying an inventory count photo for audit. Count the exact number of ${field_id.replace(/_/g, ' ')} visible in this photo. Count every single item carefully. If items are stacked or partially hidden, estimate based on what is visible and set confidence to "medium". Return the count as an integer.`;

        const schema = type === 'scale'
          ? {type: 'OBJECT', properties: {weight_value: {type: 'NUMBER'}, unit: {type: 'STRING'}, confidence: {type: 'STRING', enum: ['high', 'medium', 'low']}}, required: ['weight_value', 'confidence']}
          : {type: 'OBJECT', properties: {count: {type: 'INTEGER'}, confidence: {type: 'STRING', enum: ['high', 'medium', 'low']}, notes: {type: 'STRING'}}, required: ['count', 'confidence']};

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
          {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              contents: [{parts: [
                {inline_data: {mime_type: 'image/jpeg', data: image_base64}},
                {text: prompt}
              ]}],
              generationConfig: {responseMimeType: 'application/json', responseSchema: schema},
            }),
          }
        );

        const geminiData = await geminiRes.json();
        const aiResult = JSON.parse(geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}');

        const ai_reading = type === 'scale' ? aiResult.weight_value : aiResult.count;
        return json({
          success: true,
          ai_reading,
          confidence: aiResult.confidence || 'low',
          unit: aiResult.unit || (type === 'scale' ? 'kg' : 'units'),
          notes: aiResult.notes || '',
        }, corsHeaders);

      } catch (e) {
        return json({success: false, error: 'AI verification failed: ' + e.message}, corsHeaders);
      }
    }

    // ─── HISTORY: past settlements ────────────────────────────
    if (action === 'history') {
      if (!DB) return json({success: false, error: 'DB not configured'}, corsHeaders);
      const limit = parseInt(url.searchParams.get('limit') || '30');
      const results = await DB.prepare(
        'SELECT id, settlement_date, period_start, period_end, status, settled_by, settled_at, revenue_total, cogs_actual, gross_profit, opex_total, net_profit, adjusted_net_profit, discrepancy_value, wastage_total_value, runner_tokens_total FROM daily_settlements ORDER BY settled_at DESC LIMIT ?'
      ).bind(limit).all();
      return json({success: true, settlements: results.results}, corsHeaders);
    }

    // ─── GET SETTLEMENT: full detail by id or date ──────────
    if (action === 'get-settlement') {
      if (!DB) return json({success: false, error: 'DB not configured'}, corsHeaders);
      const id = url.searchParams.get('id');
      const date = url.searchParams.get('date');
      let result;
      if (id) {
        result = await DB.prepare('SELECT * FROM daily_settlements WHERE id = ?').bind(parseInt(id)).first();
      } else if (date) {
        result = await DB.prepare('SELECT * FROM daily_settlements WHERE settlement_date = ? ORDER BY settled_at DESC LIMIT 1').bind(date).first();
      }
      if (!result) return json({success: false, error: 'Settlement not found'}, corsHeaders);

      // Fetch complimentary data from Odoo for this settlement's period
      let complimentaryProducts = {};
      if (result.period_start && result.period_end && result.status === 'completed') {
        try {
          const fromUTC = new Date(result.period_start).toISOString().slice(0, 19).replace('T', ' ');
          const toUTC = new Date(result.period_end).toISOString().slice(0, 19).replace('T', ' ');
          const salesData = await fetchPOSSalesWithChannels(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, fromUTC, toUTC);
          complimentaryProducts = salesData.complimentaryProducts || {};
        } catch (e) {
          // Non-fatal: comp data is supplementary
          console.error('Failed to fetch complimentary data:', e.message);
        }
      }

      return json({success: true, settlement: result, complimentaryProducts}, corsHeaders);
    }

    // ─── AMEND: correct a completed settlement ──────────────
    if (action === 'amend' && context.request.method === 'POST') {
      if (!DB) return json({success: false, error: 'DB not configured'}, corsHeaders);
      const body = await context.request.json();
      const {pin, id, corrections} = body;

      // Owner-only
      if (pin !== '0305') return json({success: false, error: 'Unauthorized — owner PIN required'}, corsHeaders);
      if (!id || !corrections || !Array.isArray(corrections) || corrections.length === 0) {
        return json({success: false, error: 'id and corrections[] required'}, corsHeaders);
      }

      // Load existing settlement
      const settlement = await DB.prepare('SELECT * FROM daily_settlements WHERE id = ?').bind(parseInt(id)).first();
      if (!settlement) return json({success: false, error: 'Settlement not found'}, corsHeaders);

      // Parse JSON columns
      const opening = JSON.parse(settlement.inventory_opening || '{}');
      const purchases = JSON.parse(settlement.inventory_purchases || '{}');
      const closing = JSON.parse(settlement.inventory_closing || '{}');
      const expectedConsumption = JSON.parse(settlement.inventory_expected || '{}');
      const wastageItems = JSON.parse(settlement.wastage_items || '[]');
      const editTrail = JSON.parse(settlement.edit_trail || '{}');

      // Save previous values for audit
      const previousValues = {
        inventory_purchases: settlement.inventory_purchases,
        inventory_closing: settlement.inventory_closing,
        cogs_actual: settlement.cogs_actual,
        adjusted_net_profit: settlement.adjusted_net_profit,
      };

      // Apply corrections
      const appliedCorrections = [];
      for (const c of corrections) {
        if (c.type === 'purchase' && c.material_id) {
          const matId = String(c.material_id);
          const oldEntry = purchases[matId] || {qty: 0, cost: 0};
          const oldQty = oldEntry.qty || 0;
          const unitCost = oldQty > 0 ? oldEntry.cost / oldQty : 0;
          purchases[matId] = {qty: c.new_qty, cost: round(c.new_qty * unitCost, 2)};
          appliedCorrections.push({type: 'purchase', material_id: matId, old_qty: oldQty, new_qty: c.new_qty, reason: c.reason || ''});
        } else if (c.type === 'closing' && c.material_id) {
          const matId = String(c.material_id);
          const oldVal = closing[matId] || 0;
          closing[matId] = c.new_value;
          appliedCorrections.push({type: 'closing', material_id: matId, old_value: oldVal, new_value: c.new_value, reason: c.reason || ''});
        }
      }

      // Recalculate consumption
      const consumption = {};
      const allMaterialIds = new Set([...Object.keys(opening), ...Object.keys(purchases), ...Object.keys(closing)]);
      for (const mid of allMaterialIds) {
        const matId = String(mid);
        const o = opening[matId] || 0;
        const p = purchases[matId] ? purchases[matId].qty : 0;
        const cl = closing[matId] || 0;
        const used = round(o + p - cl, 4);
        if (used !== 0 || o > 0 || p > 0) consumption[matId] = round(used, 4);
      }

      // Load material costs
      const materialCosts = await getAllMaterialCosts(DB, settlement.settlement_date);
      const getCost = (matId) => materialCosts[String(matId)] || FALLBACK_COSTS[matId] || 0;

      // Recalculate discrepancy
      const discrepancy = {};
      let discrepancyValue = 0;
      const allDiscIds = new Set([...Object.keys(consumption), ...Object.keys(expectedConsumption)]);
      for (const matId of allDiscIds) {
        const actual = consumption[matId] || 0;
        const expected = expectedConsumption[matId] || 0;
        const wastedQty = (wastageItems || []).filter(w => String(w.material_id) === String(matId)).reduce((s, w) => s + (w.qty || 0), 0);
        const disc = round(actual - expected - wastedQty, 4);
        if (Math.abs(disc) > 0.001) {
          const cost = getCost(matId);
          const discVal = round(disc * cost, 2);
          discrepancy[matId] = {qty: disc, value: discVal, uom: RAW_MATERIALS[matId]?.uom || ''};
          discrepancyValue += discVal;
        }
      }

      // Recalculate COGS
      let cogsActual = 0;
      for (const [matId, qty] of Object.entries(consumption)) {
        cogsActual += Math.max(0, qty) * getCost(matId);
      }
      cogsActual = round(cogsActual, 2);

      // Recalculate P&L
      const wastageValue = round((wastageItems || []).reduce((s, w) => s + (w.qty || 0) * getCost(w.material_id), 0), 2);
      const grossProfit = round(settlement.revenue_total - cogsActual, 2);
      const netProfit = round(grossProfit - settlement.opex_total, 2);
      const adjustedNetProfit = round(netProfit - discrepancyValue - wastageValue, 2);

      // Update edit trail
      if (!editTrail.amendments) editTrail.amendments = [];
      editTrail.amendments.push({
        at: new Date().toISOString(),
        by: PINS[pin],
        corrections: appliedCorrections,
        previous: previousValues,
      });

      // Update DB
      await DB.prepare(`UPDATE daily_settlements SET
        inventory_purchases = ?, inventory_closing = ?,
        inventory_consumption = ?, inventory_discrepancy = ?, discrepancy_value = ?,
        cogs_actual = ?, gross_profit = ?, net_profit = ?, adjusted_net_profit = ?,
        edit_trail = ?
        WHERE id = ?`
      ).bind(
        JSON.stringify(purchases), JSON.stringify(closing),
        JSON.stringify(consumption), JSON.stringify(discrepancy), discrepancyValue,
        cogsActual, grossProfit, netProfit, adjustedNetProfit,
        JSON.stringify(editTrail),
        parseInt(id)
      ).run();

      // Sync updated closing stock to Odoo inventory
      let odooSyncResult = null;
      try {
        odooSyncResult = await syncInventoryToOdoo(
          ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, closing, 10);
      } catch (syncErr) {
        odooSyncResult = {error: syncErr.message};
      }

      return json({
        success: true,
        message: `Settlement #${id} amended with ${appliedCorrections.length} correction(s)`,
        corrections: appliedCorrections,
        updated: {cogsActual, grossProfit, netProfit, adjustedNetProfit, discrepancyValue},
        odooSyncResult,
      }, corsHeaders);
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

    // ─── BACKFILL ODOO INVENTORY ─────────────────────────────
    // One-time sync: reads latest D1 closing stock → writes to Odoo stock.quant
    if (action === 'backfill-odoo-inventory') {
      const pin = url.searchParams.get('pin');
      if (pin !== '0305') return json({success: false, error: 'Owner PIN required'}, corsHeaders);
      if (!DB) return json({success: false, error: 'DB not configured'}, corsHeaders);

      const latest = await DB.prepare(
        "SELECT id, settlement_date, settled_at, inventory_closing FROM daily_settlements WHERE status IN ('completed','bootstrap') ORDER BY settled_at DESC LIMIT 1"
      ).first();
      if (!latest) return json({success: false, error: 'No settlement found'}, corsHeaders);

      const closingStock = JSON.parse(latest.inventory_closing || '{}');
      const syncResult = await syncInventoryToOdoo(
        ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, closingStock, 10);

      return json({
        success: true,
        message: `Backfilled Odoo inventory from settlement #${latest.id} (${latest.settlement_date})`,
        settlementId: latest.id,
        settlementDate: latest.settlement_date,
        settledAt: latest.settled_at,
        syncResult,
      }, corsHeaders);
    }

    return json({success: false, error: 'Invalid action. Use: get-config, prepare, submit, amend, history, get-settlement, get-vessels, save-vessel, get-salaries, save-salary, verify-pin, backfill-odoo-inventory'}, corsHeaders);

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
    // Sugar: either direct kg or container weighing (not both)
    if (input.sugar_container && Array.isArray(input.sugar_container) && input.sugar_container.length > 0) {
      const netKg = processVesselEntries(input.sugar_container, vesselMap, density.dry_goods);
      if (netKg > 0) add(1097, netKg);
    } else if (input.raw_sugar) {
      add(1097, input.raw_sugar);
    }
    // Tea Powder: either direct kg or container weighing (not both)
    if (input.tea_powder_container && Array.isArray(input.tea_powder_container) && input.tea_powder_container.length > 0) {
      const netKg = processVesselEntries(input.tea_powder_container, vesselMap, density.dry_goods);
      if (netKg > 0) add(1098, netKg);
    } else if (input.raw_tea_powder) {
      add(1098, input.raw_tea_powder);
    }
    if (input.butter) add(1119, input.butter);
    if (input.coffee_powder) add(1120, input.coffee_powder);
    if (input.honey) add(1123, input.honey);
    if (input.lemons) add(1121, input.lemons);
    if (input.oil) add(1114, input.oil);

    // ── WATER BOTTLES (kitchen + display, backward compat: single field) ──
    const waterTotal = (input.water_bottles_kitchen || 0) + (input.water_bottles_display || 0) + (input.water_bottles || 0);
    if (waterTotal) add(1107, waterTotal);

    // ── BOILED MILK (vessel weight → litres → raw materials) ──
    const boiledMilkLitres = processVesselEntries(input.boiled_milk_kitchen, vesselMap, density.boiled_milk)
      + processVesselEntries(input.boiled_milk_counter, vesselMap, density.boiled_milk);

    if (boiledMilkLitres > 0) {
      for (const [matId, ratioPerL] of Object.entries(boiledMilkRatio)) {
        add(matId, boiledMilkLitres * ratioPerL);
      }
    }

    // ── TEA DECOCTION (kitchen + counter vessels, backward compat: single field) ──
    const decoctionLitres = processVesselEntries(input.tea_decoction_kitchen, vesselMap, density.tea_decoction)
      + processVesselEntries(input.tea_decoction_counter, vesselMap, density.tea_decoction)
      + processVesselEntries(input.tea_decoction, vesselMap, density.tea_decoction);

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

    // ── FRIED ITEMS (kitchen + display, backward compat: single field) ──
    if (input.raw_cutlets) add(1106, input.raw_cutlets);
    const friedCutlets = (input.fried_cutlets_kitchen || 0) + (input.fried_cutlets_display || 0) + (input.fried_cutlets || 0);
    if (friedCutlets) { add(1106, friedCutlets); add(1114, friedCutlets * friedOil[1106]); }

    if (input.raw_samosa) add(1113, input.raw_samosa);
    const friedSamosa = (input.fried_samosa_kitchen || 0) + (input.fried_samosa_display || 0) + (input.fried_samosa || 0);
    if (friedSamosa) { add(1113, friedSamosa); add(1114, friedSamosa * friedOil[1113]); }

    if (input.raw_cheese_balls) add(1116, input.raw_cheese_balls);
    const friedCheese = (input.fried_cheese_balls_kitchen || 0) + (input.fried_cheese_balls_display || 0) + (input.fried_cheese_balls || 0);
    if (friedCheese) { add(1116, friedCheese); add(1114, friedCheese * friedOil[1116]); }

    // ── OSMANIA BISCUITS (kitchen + display, backward compat: single field) ──
    const osmaniaPackets = (input.osmania_packets_kitchen || 0) + (input.osmania_packets_display || 0) + (input.osmania_packets || 0);
    if (osmaniaPackets) add(1105, osmaniaPackets * osmaniaPP);
    const osmaniaLoose = (input.osmania_loose_display || 0) + (input.osmania_loose || 0);
    if (osmaniaLoose) add(1105, osmaniaLoose);

    // ── NILOUFER BOXES (kitchen + display, backward compat: old field names) ──
    const nilouferTotal = (input.niloufer_kitchen || 0) + (input.niloufer_display || 0) + (input.niloufer_storage || 0);
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
    return {total: 0, cashCounter: 0, runnerCounter: 0, whatsapp: 0, products: {}, complimentaryProducts: {}};
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

  // Fetch order lines with order_id for complimentary tracking
  const [lines, compPayments] = await Promise.all([
    odooCall(url, db, uid, apiKey, 'pos.order.line', 'search_read',
      [[['order_id', 'in', orderIds]]],
      {fields: ['product_id', 'qty', 'price_subtotal_incl', 'order_id']}),
    // Identify complimentary orders (payment method 49)
    odooCall(url, db, uid, apiKey, 'pos.payment', 'search_read',
      [[['pos_order_id', 'in', orderIds], ['payment_method_id', '=', 49]]],
      {fields: ['pos_order_id', 'amount']}),
  ]);

  // Build set of complimentary order IDs
  const complimentaryOrderIds = new Set((compPayments || []).map(p => p.pos_order_id[0]));

  const products = {};
  const complimentaryProducts = {};
  let total = 0;
  for (const line of lines) {
    const pid = line.product_id[0];
    const orderId = line.order_id[0];
    if (!products[pid]) products[pid] = {name: line.product_id[1], qty: 0, amount: 0};
    products[pid].qty += line.qty;
    products[pid].amount += line.price_subtotal_incl;
    total += line.price_subtotal_incl;

    // Track complimentary products separately
    if (complimentaryOrderIds.has(orderId)) {
      if (!complimentaryProducts[pid]) complimentaryProducts[pid] = {name: line.product_id[1], qty: 0, amount: 0};
      complimentaryProducts[pid].qty += line.qty;
      complimentaryProducts[pid].amount += line.price_subtotal_incl;
    }
  }

  return {total, cashCounter, runnerCounter, whatsapp, products, complimentaryProducts};
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
// ODOO: Fetch POS sales for specific products in a time window (for gap adjustment)
// Returns: {productId: {name, qty, amount}} for all products sold in [from, to)
// ═══════════════════════════════════════════════════════════════
async function fetchGapSalesForProducts(url, db, uid, apiKey, productIds, fromUTC, toUTC) {
  if (!productIds || productIds.length === 0) return {};

  // Find orders in the time window
  const orderIds = await odooCall(url, db, uid, apiKey, 'pos.order', 'search',
    [[['config_id', 'in', [27, 28, 29]],
      ['date_order', '>=', fromUTC],
      ['date_order', '<', toUTC],
      ['state', 'in', ['paid', 'done', 'invoiced', 'posted']]]]);

  if (!orderIds || orderIds.length === 0) return {};

  // Get lines for those orders filtered by product
  const lines = await odooCall(url, db, uid, apiKey, 'pos.order.line', 'search_read',
    [[['order_id', 'in', orderIds], ['product_id', 'in', productIds]]],
    {fields: ['product_id', 'qty', 'price_subtotal_incl']});

  const result = {};
  for (const line of lines) {
    const pid = line.product_id[0];
    if (!result[pid]) result[pid] = {name: line.product_id[1], qty: 0, amount: 0};
    result[pid].qty += line.qty;
    result[pid].amount += line.price_subtotal_incl;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// SYNC CLOSING STOCK → ODOO INVENTORY (stock.quant)
// ═══════════════════════════════════════════════════════════════
async function syncInventoryToOdoo(url, db, uid, apiKey, closingStock, companyId) {
  // Find NCH's internal stock location from incoming picking type
  const pickTypes = await odooCall(url, db, uid, apiKey,
    'stock.picking.type', 'search_read',
    [[['code', '=', 'incoming'], ['company_id', '=', companyId]]],
    {fields: ['default_location_dest_id'], limit: 1});
  const locationId = pickTypes[0]?.default_location_dest_id?.[0];
  if (!locationId) throw new Error('NCH stock location not found');

  const results = [];
  for (const [productId, targetQty] of Object.entries(closingStock)) {
    try {
      const pid = parseInt(productId);
      // Search existing quant at this location
      const quants = await odooCall(url, db, uid, apiKey, 'stock.quant', 'search_read', [[
        ['product_id', '=', pid],
        ['location_id', '=', locationId],
        ['company_id', '=', companyId]
      ]], {fields: ['id', 'quantity']});

      if (quants.length > 0 && Math.abs(quants[0].quantity - targetQty) > 0.001) {
        // Update existing quant
        await odooCall(url, db, uid, apiKey, 'stock.quant', 'write', [[quants[0].id], {inventory_quantity: targetQty}]);
        await odooCall(url, db, uid, apiKey, 'stock.quant', 'action_apply_inventory', [[quants[0].id]]);
        results.push({productId: pid, from: quants[0].quantity, to: targetQty, action: 'adjusted'});
      } else if (quants.length === 0) {
        // Create new quant
        const newId = await odooCall(url, db, uid, apiKey, 'stock.quant', 'create', [{
          product_id: pid, location_id: locationId,
          company_id: companyId, inventory_quantity: targetQty,
        }]);
        await odooCall(url, db, uid, apiKey, 'stock.quant', 'action_apply_inventory', [[newId]]);
        results.push({productId: pid, qty: targetQty, action: 'created'});
      } else {
        results.push({productId: pid, qty: targetQty, action: 'unchanged'});
      }
    } catch (err) {
      results.push({productId: parseInt(productId), error: err.message});
      // Continue with other products — don't fail entire sync
    }
  }
  return results;
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
