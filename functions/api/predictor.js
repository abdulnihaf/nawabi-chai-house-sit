// NCH Inventory Predictor API — Cloudflare Worker
// Purchase prediction + hourly consumption forecast from historical POS data
// Uses weighted moving averages with period segmentation + manual intelligence multipliers

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

  const PINS = {'0305': 'Nihaf', '2026': 'Zoya', '8523': 'Basheer'};
  const BUSINESS_START = '2026-02-03';

  // ═══════════════════════════════════════════════════════════
  // THEORETICAL RECIPES — reference only, NOT used directly for purchase prediction.
  // These are the lab-condition ratios from daily-settlement.js (e.g., 57.42ml milk per chai cup).
  // ACTUAL consumption differs due to evaporation, spillage, and operating conditions.
  // The purchase predictor applies EVAPORATION_ADJUSTMENT (calibrated from 23 real settlements)
  // on top of these ratios to match real-world consumption.
  // For unit-based items (cutlet, bun, samosa) → 1:1 = same as actual (no evaporation).
  // For milk-based items → theoretical × evapMultiplier = actual consumption.
  // ═══════════════════════════════════════════════════════════
  const RECIPES = {
    // ─── BEVERAGES ───
    1028: {name: 'Irani Chai', code: 'NCH-IC', price: 20, category: 'beverage',
      materials: {1095: 0.05742, 1096: 0.001435, 1112: 0.001148, 1098: 0.000112, 1097: 0.000225, 1101: 0.01966}},
    1102: {name: 'Nawabi Special Coffee', code: 'NCH-NSC', price: 30, category: 'beverage',
      materials: {1095: 0.11484, 1096: 0.002871, 1112: 0.002297, 1120: 0.002, 1123: 0.005}},
    1103: {name: 'Lemon Tea', code: 'LT', price: 20, category: 'beverage',
      materials: {1098: 0.000449, 1097: 0.000899, 1101: 0.07865, 1121: 0.5}},
    // ─── SNACKS ───
    1029: {name: 'Bun Maska', code: 'NCH-BM', price: 40, category: 'snack',
      materials: {1104: 1, 1119: 0.05, 1097: 0.004}},
    1118: {name: 'Malai Bun', code: 'NCH-MB', price: 30, category: 'snack',
      materials: {1104: 1}},
    1031: {name: 'Chicken Cutlet', code: 'NCH-CC', price: 25, category: 'snack',
      materials: {1106: 1, 1114: 0.03}},
    1115: {name: 'Pyaaz Samosa', code: 'NCH-PS', price: 15, category: 'snack',
      materials: {1113: 1, 1114: 0.02}},
    1117: {name: 'Cheese Balls', code: 'NCH-CB', price: 50, category: 'snack',
      materials: {1116: 1, 1114: 0.015}},
    1030: {name: 'Osmania Biscuit', code: 'NCH-OB', price: 8, category: 'snack',
      materials: {1105: 1}},
    1033: {name: 'Osmania Biscuit Pack of 3', code: 'NCH-OB3', price: 20, category: 'snack',
      materials: {1105: 3}},
    1111: {name: 'Niloufer Osmania 500g', code: 'NCH-OBBOX', price: 250, category: 'snack',
      materials: {1110: 1}},
    1392: {name: 'Chicken Roll', code: 'NCH-CMR', price: 50, category: 'snack',
      materials: {1393: 1}},
    // ─── NILOUFER VARIANTS (packed, no raw materials — counted as units) ───
    1423: {name: 'Niloufer Osmania 100g', code: 'NCH-NIL100', price: 60, category: 'snack',
      materials: {1424: 1}},
    1401: {name: 'Niloufer DCC 75g', code: 'NCH-NIL-DCC', price: 120, category: 'snack',
      materials: {1401: 1}},
    1402: {name: 'Niloufer Fruit 100g', code: 'NCH-NIL-FB1', price: 70, category: 'snack',
      materials: {1402: 1}},
    1403: {name: 'Niloufer Fruit 200g', code: 'NCH-NIL-FB2', price: 150, category: 'snack',
      materials: {1403: 1}},
    // ─── HALEEM (Ramadan seasonal — no raw material decomposition, tracked as ready units) ───
    1395: {name: 'Haleem Quarter 250g', code: 'NCH-HQ', price: 100, category: 'haleem',
      materials: {1395: 1}},
    1396: {name: 'Haleem Half 500g', code: 'NCH-HH', price: 200, category: 'haleem',
      materials: {1396: 1}},
    1397: {name: 'Haleem Full 750g', code: 'NCH-HF', price: 319, category: 'haleem',
      materials: {1397: 1}},
    1400: {name: 'Haleem Mutton 300g', code: 'NCH-HM', price: 250, category: 'haleem',
      materials: {1400: 1}},
    // ─── OTHER ───
    1094: {name: 'Water', code: 'NCH-WTR', price: 10, category: 'other',
      materials: {1107: 1}},
  };

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
    // ─── NEW: Haleem (ready units from supplier), Chicken Roll, Niloufer packs ───
    1393: {name: 'Chicken Roll Raw', code: 'RM-CMR', uom: 'Units'},
    1395: {name: 'Haleem Quarter 250g', code: 'RM-HQ', uom: 'Units'},
    1396: {name: 'Haleem Half 500g', code: 'RM-HH', uom: 'Units'},
    1397: {name: 'Haleem Full 750g', code: 'RM-HF', uom: 'Units'},
    1400: {name: 'Haleem Mutton 300g', code: 'RM-HM', uom: 'Units'},
    1401: {name: 'Niloufer DCC 75g', code: 'RM-NIL-DCC', uom: 'Units'},
    1402: {name: 'Niloufer Fruit 100g', code: 'RM-NIL-FB1', uom: 'Units'},
    1403: {name: 'Niloufer Fruit 200g', code: 'RM-NIL-FB2', uom: 'Units'},
    1424: {name: 'Niloufer Osmania 100g', code: 'RM-NIL-100', uom: 'Units'},
  };

  const FALLBACK_COSTS = {
    1095: 80, 1096: 310, 1097: 44, 1098: 500, 1101: 1.5, 1104: 8, 1105: 6.65,
    1106: 15, 1107: 6.7, 1110: 173, 1112: 326, 1113: 8, 1114: 120, 1116: 10,
    1119: 500, 1120: 1200, 1121: 5, 1123: 400,
    // Finished goods — cost TBD (costing module separate)
    1393: 0, 1395: 0, 1396: 0, 1397: 0, 1400: 0,
    1401: 0, 1402: 0, 1403: 0, 1424: 0,
  };

  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const round2 = n => Math.round(n * 100) / 100;

  try {
    // ─── PIN VERIFICATION ───────────────────────────
    if (action === 'verify-pin') {
      const pin = url.searchParams.get('pin');
      if (PINS[pin]) return json({success: true, name: PINS[pin]});
      return json({success: false, error: 'Invalid PIN'});
    }

    // ─── LIST PERIODS ───────────────────────────────
    if (action === 'periods') {
      const periods = await DB.prepare('SELECT * FROM prediction_periods ORDER BY start_date').all();
      return json({success: true, periods: periods.results});
    }

    // ─── SAVE PERIOD ────────────────────────────────
    if (action === 'save-period' && context.request.method === 'POST') {
      const body = await context.request.json();
      const {code, name, start_date, end_date, operating_hours, notes, pin} = body;
      if (!PINS[pin]) return json({success: false, error: 'Invalid PIN'});
      const now = nowIST();

      await DB.prepare(`INSERT INTO prediction_periods (code, name, start_date, end_date, operating_hours, notes, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET name=excluded.name, start_date=excluded.start_date, end_date=excluded.end_date,
        operating_hours=excluded.operating_hours, notes=excluded.notes, updated_at=excluded.updated_at`)
        .bind(code, name, start_date, end_date || null, JSON.stringify(operating_hours), notes || '', PINS[pin], now, now).run();

      return json({success: true});
    }

    // ─── LIST MULTIPLIERS ───────────────────────────
    if (action === 'multipliers') {
      const periodCode = url.searchParams.get('period_code');
      let q = 'SELECT * FROM prediction_multipliers';
      let params = [];
      if (periodCode) { q += ' WHERE period_code = ?'; params.push(periodCode); }
      q += ' ORDER BY created_at DESC';
      const mults = await DB.prepare(q).bind(...params).all();
      return json({success: true, multipliers: mults.results});
    }

    // ─── SAVE MULTIPLIER ────────────────────────────
    if (action === 'save-multiplier' && context.request.method === 'POST') {
      const body = await context.request.json();
      const {period_code, scope, scope_id, day_of_week, multiplier, reason, pin} = body;
      if (!PINS[pin]) return json({success: false, error: 'Invalid PIN'});

      await DB.prepare(`INSERT INTO prediction_multipliers (period_code, scope, scope_id, day_of_week, multiplier, reason, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(period_code, scope || 'all', scope_id || null, day_of_week ?? null, multiplier, reason || '', PINS[pin], nowIST()).run();

      return json({success: true});
    }

    // ─── DELETE MULTIPLIER ──────────────────────────
    if (action === 'delete-multiplier' && context.request.method === 'POST') {
      const body = await context.request.json();
      if (!PINS[body.pin]) return json({success: false, error: 'Invalid PIN'});
      await DB.prepare('DELETE FROM prediction_multipliers WHERE id = ?').bind(body.id).run();
      return json({success: true});
    }

    // ─── REBUILD CACHE ──────────────────────────────
    if (action === 'rebuild-cache') {
      const forceAll = url.searchParams.get('force') === 'true';
      const result = await rebuildCache(DB, ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, forceAll);
      return json({success: true, ...result});
    }

    // ─── CURRENT STOCK ──────────────────────────────
    if (action === 'current-stock') {
      const stock = await fetchCurrentStock(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY);
      return json({success: true, stock, materials: RAW_MATERIALS});
    }

    // ─── PURCHASE FORECAST ──────────────────────────
    // Pipeline: Predict sales → theoretical recipe → ACTUAL consumption adjustment → buffer → subtract stock → purchase qty
    // Step 1: Predict product sales (weighted avg + DOW + trend from POS history)
    // Step 2: Decompose via theoretical recipes (starting point only)
    // Step 3: Apply evaporation multiplier (converts theoretical → actual, calibrated from 23 settlements)
    // Step 4: Apply safety buffer (10% default — covers wastage, spillage, unexpected crowd)
    // Step 5: Subtract current stock (live from Odoo)
    // Step 6: = What to purchase (rounded up for unit items)
    if (action === 'forecast') {
      const days = parseInt(url.searchParams.get('days') || '1');
      const dateParam = url.searchParams.get('date');
      const bufferParam = parseFloat(url.searchParams.get('buffer') || '1.10');

      // Ensure cache is up to date
      await ensureCacheUpToDate(DB, ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY);

      // Load periods and multipliers
      const periods = (await DB.prepare('SELECT * FROM prediction_periods ORDER BY start_date').all()).results;
      const multipliers = (await DB.prepare('SELECT * FROM prediction_multipliers').all()).results;

      // Build target dates
      const startDate = dateParam ? new Date(dateParam + 'T00:00:00+05:30') : nextDay();
      const targetDates = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(startDate);
        d.setDate(d.getDate() + i);
        targetDates.push(formatDateIST(d));
      }

      // Load all cached daily data
      const cache = (await DB.prepare('SELECT * FROM prediction_daily_cache ORDER BY date').all()).results;

      // Compute product predictions for each target day
      const dailyPredictions = {};
      const allProductPredictions = {};

      for (const targetDate of targetDates) {
        const dow = new Date(targetDate + 'T12:00:00+05:30').getDay(); // 0=Sun
        const segment = findSegment(targetDate, periods);
        const segmentCode = segment ? segment.code : 'unknown';

        // Get historical data for this segment
        const segmentCache = cache.filter(c => c.period_code === segmentCode);

        // If segment has no data, try using most recent segment's data
        const dataSource = segmentCache.length >= 3 ? segmentCache :
          cache.filter(c => c.date < targetDate).slice(-21); // last 3 weeks as fallback

        // Compute weighted average per product
        const productPredictions = computeWeightedAverage(dataSource, dow, targetDate);

        // Apply multipliers
        applyMultipliers(productPredictions, multipliers, segmentCode, dow);

        // Apply safety buffer
        for (const pid of Object.keys(productPredictions)) {
          productPredictions[pid].buffered = round2(productPredictions[pid].predicted * bufferParam);
        }

        dailyPredictions[targetDate] = {dow, segment: segmentCode, products: productPredictions};

        // Aggregate across days
        for (const [pid, data] of Object.entries(productPredictions)) {
          if (!allProductPredictions[pid]) allProductPredictions[pid] = {name: data.name, total: 0, daily: {}};
          allProductPredictions[pid].total += data.buffered;
          allProductPredictions[pid].daily[targetDate] = data.buffered;
        }
      }

      // Convert products → raw materials
      const materialNeeds = {};
      const unmatchedProducts = []; // Products without recipes (can't decompose)
      for (const [pid, data] of Object.entries(allProductPredictions)) {
        const recipe = RECIPES[pid];
        if (!recipe) {
          unmatchedProducts.push({productId: parseInt(pid), name: data.name, qty: round2(data.total)});
          continue;
        }
        for (const [mid, ratio] of Object.entries(recipe.materials)) {
          if (!materialNeeds[mid]) materialNeeds[mid] = {name: RAW_MATERIALS[mid]?.name || `Material ${mid}`, uom: RAW_MATERIALS[mid]?.uom || '?', needed: 0, sources: []};
          materialNeeds[mid].needed += data.total * ratio;
          materialNeeds[mid].sources.push({product: data.name, qty: data.total, ratio});
        }
      }

      // ─── EVAPORATION ADJUSTMENT ────────────────────
      // Beverage raw materials (milk, SMP, condensed milk) evaporate during continuous boiling.
      // Calibrated from 23 actual daily settlements (Feb 12 - Mar 10, 2026):
      //   24hr operation: actual 106.3ml/cup vs recipe 57.42ml = 1.85x multiplier
      //   12-13hr Ramadan: actual 80.3ml/cup vs recipe 57.42ml = 1.40x multiplier
      // These are ingredients in the boiled milk mixture (10L milk + 0.25kg SMP + 0.2kg condensed milk).
      // When water evaporates from boiling, you need MORE batches → more of ALL three ingredients.
      // The multiplier scales linearly with operating hours (more hours = more evaporation time).
      const EVAP_MATERIALS = new Set(['1095', '1096', '1112']); // milk, SMP, condensed milk
      const segmentForEvap = findSegment(targetDates[0], periods);
      const opHoursForEvap = segmentForEvap ? JSON.parse(segmentForEvap.operating_hours).length : 24;
      // Linear interpolation: 12hr → 1.40x, 24hr → 1.85x
      const evapMultiplier = round2(1.40 + Math.max(0, opHoursForEvap - 12) * 0.0375);

      for (const [mid, data] of Object.entries(materialNeeds)) {
        if (EVAP_MATERIALS.has(String(mid))) {
          data.preEvapNeeded = round2(data.needed); // Store pre-adjustment for transparency
          data.needed = round2(data.needed * evapMultiplier);
          data.evaporationFactor = evapMultiplier;
        }
      }

      // Fetch current stock
      const stock = await fetchCurrentStock(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY);

      // Compute purchase list
      let totalCost = 0;
      const purchaseList = [];
      for (const [mid, data] of Object.entries(materialNeeds)) {
        const needed = round2(data.needed);
        const currentStock = stock[mid] || 0;
        let toPurchase = round2(Math.max(0, needed - currentStock));

        // Round UP for unit-based materials (can't buy 0.3 of a cutlet or 0.7 of a bun)
        if (RAW_MATERIALS[mid]?.uom === 'Units' && toPurchase > 0) {
          toPurchase = Math.ceil(toPurchase);
        }

        const unitCost = FALLBACK_COSTS[mid] || 0;
        const cost = round2(toPurchase * unitCost);
        totalCost += cost;

        const stockPct = needed > 0 ? round2(currentStock / needed * 100) : 100;
        const status = stockPct >= 100 ? 'sufficient' : stockPct >= 50 ? 'low' : 'critical';

        purchaseList.push({
          materialId: parseInt(mid), name: data.name, uom: data.uom,
          needed, currentStock: round2(currentStock), toPurchase, unitCost, cost, status, stockPct,
          ...(data.evaporationFactor ? {evaporationFactor: data.evaporationFactor, preEvapNeeded: data.preEvapNeeded} : {})
        });
      }

      purchaseList.sort((a, b) => b.cost - a.cost);

      // Determine overall confidence
      const segmentForFirstDay = dailyPredictions[targetDates[0]]?.segment;
      const dataPoints = cache.filter(c => c.period_code === segmentForFirstDay).length;
      const uniqueDays = new Set(cache.filter(c => c.period_code === segmentForFirstDay).map(c => c.date)).size;
      const confidence = uniqueDays >= 14 ? 'high' : uniqueDays >= 7 ? 'medium' : 'low';

      // Active multipliers for display
      const activeMultipliers = multipliers.filter(m =>
        m.period_code === segmentForFirstDay || m.period_code === '_global'
      );

      return json({
        success: true,
        prediction: {
          targetDates,
          days,
          safetyBuffer: bufferParam,
          segment: segmentForFirstDay,
          confidence,
          dataPoints: uniqueDays,
          products: allProductPredictions,
          materials: purchaseList,
          totalPurchaseCost: round2(totalCost),
          appliedMultipliers: activeMultipliers,
          dailyBreakdown: dailyPredictions,
          evaporation: {factor: evapMultiplier, operatingHours: opHoursForEvap, affectedMaterials: ['Buffalo Milk', 'SMP', 'Condensed Milk']},
          unmatchedProducts,
        }
      });
    }

    // ─── HOURLY CONSUMPTION FORECAST ────────────────
    if (action === 'hourly') {
      const dateParam = url.searchParams.get('date');
      const targetDate = dateParam || formatDateIST(nextDay());
      const bufferParam = parseFloat(url.searchParams.get('buffer') || '1.10');

      await ensureCacheUpToDate(DB, ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY);

      const periods = (await DB.prepare('SELECT * FROM prediction_periods ORDER BY start_date').all()).results;
      const multipliers = (await DB.prepare('SELECT * FROM prediction_multipliers').all()).results;
      const cache = (await DB.prepare('SELECT * FROM prediction_daily_cache ORDER BY date').all()).results;

      const dow = new Date(targetDate + 'T12:00:00+05:30').getDay();
      const segment = findSegment(targetDate, periods);
      const segmentCode = segment ? segment.code : 'unknown';
      const opHours = segment ? JSON.parse(segment.operating_hours) : Array.from({length: 24}, (_, i) => i);

      // Get segment data for hourly curves
      const segmentCache = cache.filter(c => c.period_code === segmentCode);
      const dataSource = segmentCache.length >= 3 ? segmentCache :
        cache.filter(c => c.date < targetDate).slice(-21);

      // Compute daily predictions
      const productPredictions = computeWeightedAverage(dataSource, dow, targetDate);
      applyMultipliers(productPredictions, multipliers, segmentCode, dow);
      for (const pid of Object.keys(productPredictions)) {
        productPredictions[pid].buffered = round2(productPredictions[pid].predicted * bufferParam);
      }

      // Build hourly distribution curves from historical data (DOW-weighted)
      const hourlyCurves = buildHourlyCurves(dataSource, dow);

      // Apply curves to predictions
      const products = {};
      for (const [pid, pred] of Object.entries(productPredictions)) {
        const curve = hourlyCurves[pid] || buildFlatCurve(opHours);
        const hours = [];
        for (let h = 0; h < 24; h++) {
          const pct = curve[h] || 0;
          const predicted = round2(pred.buffered * pct);
          const isOperating = opHours.includes(h);
          hours.push({
            hour: h,
            label: formatHourLabel(h),
            predicted: isOperating ? Math.round(predicted) : 0,
            pctOfDay: round2(pct * 100),
            isOperating
          });
        }
        products[pid] = {
          name: pred.name, category: RECIPES[pid]?.category || 'other',
          totalPredicted: Math.round(pred.buffered), hours
        };
      }

      // Generate kitchen prep notes (2-hour windows)
      const kitchen = generatePrepSchedule(products, opHours, RECIPES);

      const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

      return json({
        success: true,
        date: targetDate,
        dayName: dowNames[dow],
        segment: segmentCode,
        operatingHours: opHours,
        products,
        kitchen,
        dataPoints: new Set(dataSource.map(c => c.date)).size
      });
    }

    // ─── STAFF ROSTERING ─────────────────────────────
    if (action === 'staffing') {
      const dateParam = url.searchParams.get('date');
      const targetDate = dateParam || formatDateIST(nextDay());
      const bufferParam = parseFloat(url.searchParams.get('buffer') || '1.10');

      await ensureCacheUpToDate(DB, ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY);

      const periods = (await DB.prepare('SELECT * FROM prediction_periods ORDER BY start_date').all()).results;
      const multipliers = (await DB.prepare('SELECT * FROM prediction_multipliers').all()).results;
      const cache = (await DB.prepare('SELECT * FROM prediction_daily_cache ORDER BY date').all()).results;

      const dow = new Date(targetDate + 'T12:00:00+05:30').getDay();
      const segment = findSegment(targetDate, periods);
      const segmentCode = segment ? segment.code : 'unknown';
      const opHours = segment ? JSON.parse(segment.operating_hours) : Array.from({length: 24}, (_, i) => i);

      const segmentCache = cache.filter(c => c.period_code === segmentCode);
      const dataSource = segmentCache.length >= 3 ? segmentCache : cache.filter(c => c.date < targetDate).slice(-21);

      // Get product predictions
      const productPredictions = computeWeightedAverage(dataSource, dow, targetDate);
      applyMultipliers(productPredictions, multipliers, segmentCode, dow);
      for (const pid of Object.keys(productPredictions)) {
        productPredictions[pid].buffered = round2(productPredictions[pid].predicted * bufferParam);
      }

      // Build hourly curves (DOW-weighted)
      const hourlyCurves = buildHourlyCurves(dataSource, dow);

      // Compute hourly ORDER count from item predictions
      // Real data: avg 3.27 items/order (from 12,412 orders / 40,567 items)
      // Varies by hour: 1.80 (8AM) to 4.12 (6PM Iftar), but use overall avg for stability
      const ITEMS_PER_ORDER = 3.27;
      const hourlyItems = Array(24).fill(0);
      const hourlyBeverages = Array(24).fill(0);
      const hourlySnacks = Array(24).fill(0);

      for (const [pid, pred] of Object.entries(productPredictions)) {
        const curve = hourlyCurves[pid] || buildFlatCurve(opHours);
        const recipe = RECIPES[pid];
        for (let h = 0; h < 24; h++) {
          const qty = Math.round(pred.buffered * (curve[h] || 0));
          hourlyItems[h] += qty;
          if (recipe?.category === 'beverage') hourlyBeverages[h] += qty;
          if (recipe?.category === 'snack') hourlySnacks[h] += qty;
        }
      }

      const hourlyOrders = hourlyItems.map(i => Math.round(i / ITEMS_PER_ORDER));

      // Staff roles and requirements per crowd level
      // Crowd thresholds calibrated from actual Ramadan data:
      //   Avg hourly orders during Ramadan: 5AM=12, 4PM=4, 6PM=15, 7PM=35, 8PM=30,
      //   9PM=33, 10PM=44, 11PM=57, 12AM=59, 1AM=53, 2AM=47, 3AM=25, 4AM=21
      //   Peak hour (12AM) averages 59 orders. Weekend peaks can hit 80+.
      const CROWD_THRESHOLDS = {quiet: 10, moderate: 25, busy: 45, peak: 65};

      // Staff roles available at NCH
      const STAFF_ROLES = {
        tea_master: {label: 'Tea Master', description: 'Makes chai, coffee, lemon tea', monthlyCost: 20000},
        cashier: {label: 'Cashier', description: 'Takes orders at POS counter', monthlyCost: 19000},
        captain: {label: 'Captain/Runner', description: 'Delivery & floor management', monthlyCost: 25000},
        kitchen: {label: 'Kitchen Staff', description: 'Frying, bun prep, food assembly', monthlyCost: 16000},
        washer: {label: 'Washing', description: 'Utensil & cup washing', monthlyCost: 14000},
        cleaner: {label: 'Cleaner', description: 'Floor & table cleaning', monthlyCost: 12000},
      };

      // Minimum staff per role at each crowd level
      const STAFFING_MATRIX = {
        closed:   {tea_master: 0, cashier: 0, captain: 0, kitchen: 0, washer: 0, cleaner: 0},
        quiet:    {tea_master: 1, cashier: 1, captain: 1, kitchen: 0, washer: 1, cleaner: 0},
        moderate: {tea_master: 1, cashier: 1, captain: 1, kitchen: 1, washer: 1, cleaner: 1},
        busy:     {tea_master: 1, cashier: 1, captain: 2, kitchen: 1, washer: 1, cleaner: 1},
        peak:     {tea_master: 2, cashier: 2, captain: 2, kitchen: 1, washer: 2, cleaner: 1},
      };

      // Compute hourly staffing needs
      const hourlyStaffing = [];
      for (let h = 0; h < 24; h++) {
        const isOp = opHours.includes(h);
        const orders = hourlyOrders[h];
        let level = 'closed';
        if (isOp) {
          if (orders >= CROWD_THRESHOLDS.peak) level = 'peak';
          else if (orders >= CROWD_THRESHOLDS.busy) level = 'busy';
          else if (orders >= CROWD_THRESHOLDS.moderate) level = 'moderate';
          else level = 'quiet';
        }
        const staffNeeds = STAFFING_MATRIX[level];
        const totalStaff = Object.values(staffNeeds).reduce((a, b) => a + b, 0);

        hourlyStaffing.push({
          hour: h, label: formatHourLabel(h), isOperating: isOp,
          orders, items: hourlyItems[h], beverages: hourlyBeverages[h], snacks: hourlySnacks[h],
          crowdLevel: level, staff: staffNeeds, totalStaff
        });
      }

      // Suggest shift blocks
      const shifts = computeShiftBlocks(hourlyStaffing, opHours, STAFF_ROLES);

      // Daily staff cost estimate
      const totalStaffHours = {};
      for (const role of Object.keys(STAFF_ROLES)) {
        totalStaffHours[role] = hourlyStaffing.reduce((sum, h) => sum + (h.staff[role] || 0), 0);
      }
      let dailyStaffCost = 0;
      const roleSummary = [];
      for (const [role, info] of Object.entries(STAFF_ROLES)) {
        const hours = totalStaffHours[role];
        const dailyCost = round2(info.monthlyCost / 30 * (hours / opHours.length));
        // Peak count = max staff needed for this role at any hour
        const peakCount = Math.max(...hourlyStaffing.filter(h => h.isOperating).map(h => h.staff[role] || 0));
        dailyStaffCost += info.monthlyCost / 30 * peakCount; // Cost based on people hired, not hours
        roleSummary.push({role, label: info.label, peakCount, totalHoursNeeded: hours, dailyCostPerPerson: round2(info.monthlyCost / 30)});
      }

      const peakHour = hourlyStaffing.filter(h => h.isOperating).sort((a, b) => b.orders - a.orders)[0];
      const totalPeakStaff = peakHour ? peakHour.totalStaff : 0;
      const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

      return json({
        success: true,
        date: targetDate,
        dayName: dowNames[dow],
        segment: segmentCode,
        operatingHours: opHours,
        crowdThresholds: CROWD_THRESHOLDS,
        staffRoles: STAFF_ROLES,
        hourlyStaffing,
        shifts,
        roleSummary,
        peakHour: peakHour ? {hour: peakHour.hour, label: peakHour.label, orders: peakHour.orders, totalStaff: peakHour.totalStaff} : null,
        totalPeakStaff,
        estimatedDailyStaffCost: round2(dailyStaffCost),
        dataPoints: new Set(dataSource.map(c => c.date)).size
      });
    }

    // ─── ACCURACY CHECK ─────────────────────────────
    if (action === 'accuracy') {
      const dateParam = url.searchParams.get('date');
      if (!dateParam) return json({success: false, error: 'date parameter required'});

      await ensureCacheUpToDate(DB, ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY);

      const cache = (await DB.prepare('SELECT * FROM prediction_daily_cache WHERE date = ?').bind(dateParam).all()).results;
      const periods = (await DB.prepare('SELECT * FROM prediction_periods ORDER BY start_date').all()).results;
      const multipliers = (await DB.prepare('SELECT * FROM prediction_multipliers').all()).results;
      const allCache = (await DB.prepare('SELECT * FROM prediction_daily_cache WHERE date < ? ORDER BY date').bind(dateParam).all()).results;

      if (!cache.length) return json({success: false, error: 'No actual data for this date yet'});

      // What we would have predicted
      const dow = new Date(dateParam + 'T12:00:00+05:30').getDay();
      const segment = findSegment(dateParam, periods);
      const segmentCode = segment ? segment.code : 'unknown';
      const segmentCache = allCache.filter(c => c.period_code === segmentCode);
      const dataSource = segmentCache.length >= 3 ? segmentCache : allCache.slice(-21);

      const predicted = computeWeightedAverage(dataSource, dow, dateParam);
      applyMultipliers(predicted, multipliers, segmentCode, dow);

      // Actuals from cache
      const actuals = {};
      for (const row of cache) {
        actuals[row.product_id] = {name: row.product_name, qty: row.qty_sold};
      }

      // Compare
      const comparison = [];
      const allPids = new Set([...Object.keys(predicted), ...Object.keys(actuals)]);
      let totalPredicted = 0, totalActual = 0;
      for (const pid of allPids) {
        const predQty = predicted[pid]?.predicted || 0;
        const actQty = actuals[pid]?.qty || 0;
        const diff = predQty - actQty;
        const pctError = actQty > 0 ? round2(Math.abs(diff) / actQty * 100) : predQty > 0 ? 100 : 0;
        comparison.push({
          productId: parseInt(pid),
          name: predicted[pid]?.name || actuals[pid]?.name || `Product ${pid}`,
          predicted: round2(predQty), actual: round2(actQty), diff: round2(diff), pctError
        });
        totalPredicted += predQty;
        totalActual += actQty;
      }

      comparison.sort((a, b) => b.actual - a.actual);
      const overallError = totalActual > 0 ? round2(Math.abs(totalPredicted - totalActual) / totalActual * 100) : 0;

      return json({
        success: true, date: dateParam, segment: segmentCode,
        overallAccuracy: round2(100 - overallError),
        totalPredicted: round2(totalPredicted), totalActual: round2(totalActual),
        comparison
      });
    }

    return json({success: false, error: `Unknown action: ${action}`});

  } catch (error) {
    return new Response(JSON.stringify({success: false, error: error.message, stack: error.stack}),
      {status: 500, headers: corsHeaders});
  }

  // ═══════════════════════════════════════════════════════════
  // HELPER FUNCTIONS
  // ═══════════════════════════════════════════════════════════

  function json(data) {
    return new Response(JSON.stringify(data), {headers: corsHeaders});
  }

  function nowIST() {
    return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 19);
  }

  function nextDay() {
    const d = new Date(Date.now() + IST_OFFSET_MS);
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function formatDateIST(d) {
    return d.toISOString().slice(0, 10);
  }

  function formatHourLabel(h) {
    if (h === 0) return '12 AM';
    if (h === 12) return '12 PM';
    return h > 12 ? `${h - 12} PM` : `${h} AM`;
  }

  function findSegment(dateStr, periods) {
    for (let i = periods.length - 1; i >= 0; i--) {
      const p = periods[i];
      if (dateStr >= p.start_date && (!p.end_date || dateStr <= p.end_date)) return p;
    }
    return periods[periods.length - 1] || null;
  }

  // ─── DATA-CALIBRATED PREDICTION ENGINE ──────────────
  // Calibrated from 12,412 orders / 15,499 line items (Feb 3 - Mar 10, 2026)
  //
  // Real data insights baked in:
  //   Items/order: 3.27 overall (varies 1.80-4.12 by hour)
  //   DOW spread: Sun avg 1555 items vs Tue avg 829 (1.88x)
  //   Growth: Pre-Ramadan avg 780 → Ramadan avg 1404 (1.8x jump)
  //   Within-Ramadan daily growth: ~19 items/day (weak but present)
  //   Chai = 72% of all items sold
  //
  // Algorithm: Weighted average + linear trend projection + DOW normalization
  //   1. Compute weighted average (recent data weighted more)
  //   2. Detect linear trend within segment (slope per day)
  //   3. Project forward: prediction = avg + slope × days_ahead
  //   4. DOW normalization: scale by real DOW factor from data
  //   5. Apply manual multipliers on top
  //
  // DOW factors (from actual data — Sun=6, Mon=0, ..., Sat=5):
  // Calculated as: DOW avg daily items / overall avg daily items
  const DOW_FACTORS = {
    0: 1.08,  // Sun — 1555 / 1127 = 1.38, but adjusted for segment mixing
    1: 0.78,  // Mon
    2: 0.74,  // Tue — weakest day
    3: 0.92,  // Wed
    4: 0.90,  // Thu
    5: 0.94,  // Fri
    6: 1.12,  // Sat
  };

  function computeWeightedAverage(cacheData, targetDow, targetDate) {
    const DECAY_FACTOR = 0.80; // per week decay — slightly more aggressive (data is only 5 weeks)
    const DOW_BONUS = 2.5; // same day-of-week gets 2.5x weight (with only 2-3 same-DOW points, need strong signal)
    const productAgg = {};

    // Phase 1: Collect weighted averages per product
    for (const row of cacheData) {
      const pid = String(row.product_id);
      const rowDate = row.date;
      const daysAgo = Math.max(0, (new Date(targetDate) - new Date(rowDate)) / (24 * 60 * 60 * 1000));
      const weeksAgo = daysAgo / 7;

      let weight = Math.pow(DECAY_FACTOR, weeksAgo);

      // Day-of-week bonus
      const rowDow = new Date(rowDate + 'T12:00:00+05:30').getDay();
      if (rowDow === targetDow) weight *= DOW_BONUS;

      if (!productAgg[pid]) productAgg[pid] = {
        name: row.product_name, weightedSum: 0, weightTotal: 0, rawDays: 0,
        // For trend detection: store (daysAgo, qty) pairs
        trend: []
      };
      productAgg[pid].weightedSum += row.qty_sold * weight;
      productAgg[pid].weightTotal += weight;
      productAgg[pid].rawDays++;
      productAgg[pid].trend.push({daysAgo, qty: row.qty_sold, dow: rowDow});
    }

    const result = {};
    for (const [pid, agg] of Object.entries(productAgg)) {
      let predicted = agg.weightTotal > 0 ? agg.weightedSum / agg.weightTotal : 0;

      // Phase 2: Detect trend within segment using simple linear regression
      // Only apply trend if we have enough data points (5+)
      if (agg.trend.length >= 5) {
        const n = agg.trend.length;
        // x = -daysAgo (so more recent = higher x), y = qty
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        for (const t of agg.trend) {
          const x = -t.daysAgo;
          sumX += x; sumY += t.qty; sumXY += x * t.qty; sumX2 += x * x;
        }
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const avgY = sumY / n;

        // Only apply positive trend (growth) — ignore decline signals for safety
        if (slope > 0 && isFinite(slope)) {
          // Project: how much higher would today be vs the average date?
          const avgDaysAgo = -sumX / n;
          const trendBoost = slope * avgDaysAgo; // boost = slope × distance from avg to today
          // Cap trend boost at 30% of predicted to avoid runaway
          const cappedBoost = Math.min(trendBoost, predicted * 0.30);
          predicted += cappedBoost;
        }
      }

      // Phase 3: DOW normalization
      // If the weighted average was computed mostly from mixed DOW data,
      // normalize to the target DOW's factor
      const dowFactor = DOW_FACTORS[targetDow] || 1.0;
      // Only apply DOW factor if we DON'T have enough same-DOW data
      const sameDowCount = agg.trend.filter(t => t.dow === targetDow).length;
      if (sameDowCount < 3) {
        // Not enough same-DOW data — apply DOW factor to normalize
        predicted *= dowFactor;
      }

      const confidence = agg.rawDays >= 14 ? 'high' : agg.rawDays >= 7 ? 'medium' : 'low';
      result[pid] = {name: agg.name, predicted: round2(Math.max(0, predicted)), confidence, dataPoints: agg.rawDays, multiplier: 1.0};
    }
    return result;
  }

  // ─── APPLY MANUAL MULTIPLIERS ─────────────────────
  function applyMultipliers(predictions, multipliers, segmentCode, dow) {
    for (const m of multipliers) {
      if (m.period_code !== segmentCode && m.period_code !== '_global') continue;
      if (m.day_of_week !== null && m.day_of_week !== dow) continue;

      if (m.scope === 'all') {
        for (const pid of Object.keys(predictions)) {
          predictions[pid].predicted = round2(predictions[pid].predicted * m.multiplier);
          predictions[pid].multiplier = round2((predictions[pid].multiplier || 1) * m.multiplier);
        }
      } else if (m.scope === 'product' && m.scope_id) {
        const pid = String(m.scope_id);
        if (predictions[pid]) {
          predictions[pid].predicted = round2(predictions[pid].predicted * m.multiplier);
          predictions[pid].multiplier = round2((predictions[pid].multiplier || 1) * m.multiplier);
        }
      } else if (m.scope === 'category' && m.scope_id) {
        const cat = String(m.scope_id);
        for (const [pid, data] of Object.entries(predictions)) {
          if (RECIPES[pid]?.category === cat) {
            data.predicted = round2(data.predicted * m.multiplier);
            data.multiplier = round2((data.multiplier || 1) * m.multiplier);
          }
        }
      }
    }
  }

  // ─── HOURLY DISTRIBUTION CURVES ───────────────────
  // Builds normalized hourly distribution from historical data
  // With DOW-aware weighting: same-DOW data counts more for hourly shape
  function buildHourlyCurves(cacheData, targetDow) {
    const curves = {}; // {pid: {hour: weightedQty}}
    const totals = {}; // {pid: totalWeightedQty}

    for (const row of cacheData) {
      const pid = String(row.product_id);
      const hourly = JSON.parse(row.hourly_breakdown || '{}');
      const rowDow = row.day_of_week;

      // Weight same-DOW data higher for hourly shape
      const weight = (targetDow !== undefined && rowDow === targetDow) ? 2.0 : 1.0;

      if (!curves[pid]) { curves[pid] = {}; totals[pid] = 0; }
      for (const [h, qty] of Object.entries(hourly)) {
        const hour = parseInt(h);
        curves[pid][hour] = (curves[pid][hour] || 0) + qty * weight;
        totals[pid] += qty * weight;
      }
    }

    // Normalize to percentages (0-1)
    const normalized = {};
    for (const [pid, hourData] of Object.entries(curves)) {
      normalized[pid] = {};
      const total = totals[pid] || 1;
      for (let h = 0; h < 24; h++) {
        normalized[pid][h] = (hourData[h] || 0) / total;
      }
    }
    return normalized;
  }

  function buildFlatCurve(opHours) {
    const curve = {};
    const pct = 1 / (opHours.length || 1);
    for (let h = 0; h < 24; h++) curve[h] = opHours.includes(h) ? pct : 0;
    return curve;
  }

  // ─── KITCHEN PREP SCHEDULE ────────────────────────
  function generatePrepSchedule(products, opHours, recipes) {
    if (!opHours.length) return [];

    // Group into 2-hour windows
    const sortedHours = [...opHours].sort((a, b) => {
      // Sort by "distance from first operating hour" for continuous display
      const first = opHours[0];
      const aOff = (a - first + 24) % 24;
      const bOff = (b - first + 24) % 24;
      return aOff - bOff;
    });

    const windows = [];
    for (let i = 0; i < sortedHours.length; i += 2) {
      const windowHours = sortedHours.slice(i, i + 2);
      const items = [];

      for (const [pid, prod] of Object.entries(products)) {
        let windowQty = 0;
        for (const h of windowHours) {
          const hourData = prod.hours.find(hr => hr.hour === h);
          windowQty += hourData?.predicted || 0;
        }
        if (windowQty > 0) {
          const recipe = recipes[parseInt(pid)];
          items.push({
            product: prod.name, qty: Math.round(windowQty),
            category: recipe?.category || 'other',
            prepNote: generatePrepNote(parseInt(pid), windowQty, recipes)
          });
        }
      }

      items.sort((a, b) => b.qty - a.qty);

      windows.push({
        label: `${formatHourLabel(windowHours[0])}${windowHours.length > 1 ? ' - ' + formatHourLabel((windowHours[windowHours.length - 1] + 1) % 24) : ''}`,
        startHour: windowHours[0],
        items
      });
    }

    return windows;
  }

  function generatePrepNote(pid, qty, recipes) {
    const recipe = recipes[pid];
    if (!recipe) return '';

    if (pid === 1028) {
      const milkL = round2(qty * 0.05742);
      return `Boil ~${Math.ceil(milkL)}L milk`;
    }
    if (pid === 1102) return `Prepare ${Math.round(qty)} coffee`;
    if (pid === 1029) return `Butter ${Math.round(qty)} buns`;
    if (pid === 1118) return `Prep ${Math.round(qty)} malai buns`;
    if (pid === 1031) return `Fry ${Math.round(qty)} cutlets`;
    if (pid === 1115) return `Fry ${Math.round(qty)} samosa`;
    if (pid === 1117) return `Fry ${Math.round(qty)} cheese balls`;
    return `Prep ${Math.round(qty)} ${recipe.name}`;
  }

  // ─── SHIFT BLOCK COMPUTATION ────────────────────
  function computeShiftBlocks(hourlyStaffing, opHours, staffRoles) {
    if (!opHours.length) return [];

    // Sort operating hours for continuous block detection
    // Handle wrap-around (e.g., 17-5 spans midnight)
    const sorted = [...opHours].sort((a, b) => a - b);
    const firstHour = sorted[0];

    // Split into 2 or 3 shifts based on operating hours count
    const shiftCount = opHours.length <= 10 ? 2 : 3;
    const hoursPerShift = Math.ceil(opHours.length / shiftCount);

    // Order hours by operational sequence (handle midnight wrap)
    const orderedHours = [];
    // Find the first hour that starts the operating day
    // For Ramadan (17-5): start at 17, wrap through midnight
    let startIdx = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (i === 0 || sorted[i] - sorted[i - 1] > 1) {
        // Found a gap — this is the start of the operating day
        startIdx = i;
      }
    }
    for (let i = 0; i < sorted.length; i++) {
      orderedHours.push(sorted[(startIdx + i) % sorted.length]);
    }

    const shifts = [];
    for (let s = 0; s < shiftCount; s++) {
      const shiftHours = orderedHours.slice(s * hoursPerShift, (s + 1) * hoursPerShift);
      if (!shiftHours.length) continue;

      // Compute peak staff needs for this shift
      const shiftStaffing = hourlyStaffing.filter(h => shiftHours.includes(h.hour));
      const peakOrders = Math.max(...shiftStaffing.map(h => h.orders), 0);
      const peakLevel = shiftStaffing.reduce((best, h) => {
        const levels = ['closed', 'quiet', 'moderate', 'busy', 'peak'];
        return levels.indexOf(h.crowdLevel) > levels.indexOf(best) ? h.crowdLevel : best;
      }, 'closed');

      // Staff needed = max of each role across this shift's hours
      const staffNeeded = {};
      for (const role of Object.keys(staffRoles)) {
        staffNeeded[role] = Math.max(...shiftStaffing.map(h => h.staff[role] || 0));
      }
      const totalStaff = Object.values(staffNeeded).reduce((a, b) => a + b, 0);

      shifts.push({
        name: `Shift ${String.fromCharCode(65 + s)}`,
        startHour: shiftHours[0],
        endHour: (shiftHours[shiftHours.length - 1] + 1) % 24,
        startLabel: formatHourLabel(shiftHours[0]),
        endLabel: formatHourLabel((shiftHours[shiftHours.length - 1] + 1) % 24),
        hours: shiftHours.length,
        peakOrders,
        peakLevel,
        staffNeeded,
        totalStaff
      });
    }

    return shifts;
  }

  // ─── CACHE MANAGEMENT ────────────────────────────
  async function ensureCacheUpToDate(DB, odooUrl, db, uid, apiKey) {
    const yesterday = formatDateIST(new Date(Date.now() + IST_OFFSET_MS - 24 * 60 * 60 * 1000));
    const lastCached = await DB.prepare('SELECT MAX(date) as last_date FROM prediction_daily_cache').first();
    if (!lastCached?.last_date || lastCached.last_date < yesterday) {
      await rebuildCache(DB, odooUrl, db, uid, apiKey, false);
    }
  }

  async function rebuildCache(DB, odooUrl, db, uid, apiKey, forceAll) {
    const periods = (await DB.prepare('SELECT * FROM prediction_periods ORDER BY start_date').all()).results;

    // Determine date range to cache
    let fromDate = BUSINESS_START;
    if (!forceAll) {
      const lastCached = await DB.prepare('SELECT MAX(date) as last_date FROM prediction_daily_cache').first();
      if (lastCached?.last_date) fromDate = lastCached.last_date;
    }

    const yesterday = formatDateIST(new Date(Date.now() + IST_OFFSET_MS - 24 * 60 * 60 * 1000));
    if (fromDate > yesterday) return {cached: 0, message: 'Cache is up to date'};

    // Convert to UTC for Odoo
    const fromUTC = new Date(new Date(fromDate + 'T00:00:00+05:30').getTime()).toISOString().slice(0, 19).replace('T', ' ');
    const toUTC = new Date(new Date(yesterday + 'T23:59:59+05:30').getTime()).toISOString().slice(0, 19).replace('T', ' ');

    // Fetch orders
    const orderIds = await odooCall(odooUrl, db, uid, apiKey, 'pos.order', 'search',
      [[['config_id', 'in', [27, 28]], ['date_order', '>=', fromUTC], ['date_order', '<=', toUTC],
        ['state', 'in', ['paid', 'done', 'invoiced', 'posted']]]]);

    if (!orderIds.length) return {cached: 0, message: 'No orders in range'};

    // Fetch order timestamps in batches
    const orders = {};
    for (let i = 0; i < orderIds.length; i += 500) {
      const batch = orderIds.slice(i, i + 500);
      const result = await odooCall(odooUrl, db, uid, apiKey, 'pos.order', 'read', [batch], {fields: ['id', 'date_order']});
      for (const o of result) orders[o.id] = o.date_order;
    }

    // Fetch order lines in batches
    const lines = [];
    for (let i = 0; i < orderIds.length; i += 2000) {
      const batch = orderIds.slice(i, i + 2000);
      const result = await odooCall(odooUrl, db, uid, apiKey, 'pos.order.line', 'search_read',
        [[['order_id', 'in', batch]]], {fields: ['order_id', 'product_id', 'qty', 'price_subtotal_incl']});
      lines.push(...result);
    }

    // Aggregate by date + product
    const daily = {}; // {date: {pid: {name, qty, revenue, hours: {h: qty}}}}
    for (const line of lines) {
      const oid = line.order_id[0];
      const orderDate = orders[oid];
      if (!orderDate) continue;

      const utcDt = new Date(orderDate.replace(' ', 'T') + 'Z');
      const istDt = new Date(utcDt.getTime() + IST_OFFSET_MS);
      const dateStr = istDt.toISOString().slice(0, 10);
      const hour = istDt.getHours();
      const pid = line.product_id[0];
      const pname = line.product_id[1];

      if (!daily[dateStr]) daily[dateStr] = {};
      if (!daily[dateStr][pid]) daily[dateStr][pid] = {name: pname, qty: 0, revenue: 0, hours: {}};
      daily[dateStr][pid].qty += line.qty;
      daily[dateStr][pid].revenue += line.price_subtotal_incl;
      daily[dateStr][pid].hours[hour] = (daily[dateStr][pid].hours[hour] || 0) + line.qty;
    }

    // Write to D1
    let cached = 0;
    for (const [dateStr, products] of Object.entries(daily)) {
      const dow = new Date(dateStr + 'T12:00:00+05:30').getDay();
      const segment = findSegment(dateStr, periods);
      const segmentCode = segment ? segment.code : 'unknown';

      for (const [pid, data] of Object.entries(products)) {
        await DB.prepare(`INSERT INTO prediction_daily_cache (date, day_of_week, period_code, product_id, product_name, qty_sold, revenue, hourly_breakdown, cached_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(date, product_id) DO UPDATE SET qty_sold=excluded.qty_sold, revenue=excluded.revenue,
          hourly_breakdown=excluded.hourly_breakdown, period_code=excluded.period_code, cached_at=excluded.cached_at`)
          .bind(dateStr, dow, segmentCode, parseInt(pid), data.name, round2(data.qty), round2(data.revenue), JSON.stringify(data.hours), nowIST()).run();
        cached++;
      }
    }

    return {cached, datesProcessed: Object.keys(daily).length, ordersProcessed: orderIds.length, linesProcessed: lines.length};
  }

  // ─── FETCH CURRENT STOCK FROM ODOO ────────────────
  async function fetchCurrentStock(odooUrl, db, uid, apiKey) {
    const quants = await odooCall(odooUrl, db, uid, apiKey, 'stock.quant', 'search_read',
      [[['location_id', 'in', [39, 40, 41]], ['quantity', '>', 0], ['company_id', '=', 10]]],
      {fields: ['product_id', 'quantity', 'location_id']});

    const stock = {};
    for (const q of quants) {
      const pid = q.product_id[0];
      stock[pid] = (stock[pid] || 0) + q.quantity;
    }
    return stock;
  }
}

// ─── ODOO JSON-RPC HELPER ──────────────────────────────────
async function odooCall(url, db, uid, apiKey, model, method, positionalArgs, kwargs) {
  const payload = {
    jsonrpc: '2.0', method: 'call',
    params: {service: 'object', method: 'execute_kw',
      args: [db, uid, apiKey, model, method, positionalArgs, kwargs || {}]},
    id: Date.now(),
  };
  const response = await fetch(url, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (data.error) throw new Error(`Odoo ${model}.${method}: ${data.error.message || JSON.stringify(data.error)}`);
  return data.result;
}
