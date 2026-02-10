// NCH Staffing Cost API — Cloudflare Worker
// Manages staff salary data from D1 and syncs with Odoo hr.employee

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
  const NCH_COMPANY = 10;

  // Outlet opened Feb 3, 2026 at 8pm IST = Feb 3 14:30 UTC
  const OUTLET_OPEN_DATE = '2026-02-03';

  const json = (data, headers) => new Response(JSON.stringify(data), {headers});
  const round = (v, d = 2) => Math.round(v * Math.pow(10, d)) / Math.pow(10, d);

  try {
    // ─── GET DAILY COSTS ────────────────────────────────────
    if (action === 'get-daily-costs') {
      if (!DB) return json({success: false, error: 'Database not configured'}, corsHeaders);

      const dateParam = url.searchParams.get('date');
      const date = dateParam || new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

      const salaries = await DB.prepare('SELECT * FROM staff_salaries ORDER BY category, name').all();
      const staff = salaries.results || [];

      const nchDirect = [];
      const office = [];
      let nchTotal = 0;
      let officeTotal = 0;

      for (const s of staff) {
        const daily = round(s.monthly_salary / 30);
        const startDate = s.start_date || s.effective_from;

        // Not yet hired on this date
        if (date < startDate) continue;

        // Not active
        if (!s.active) continue;

        // Pre-opening: 50% salary for employees who started before outlet opened
        let adjustedDaily = daily;
        let halfPay = false;
        if (date < OUTLET_OPEN_DATE && startDate < OUTLET_OPEN_DATE) {
          adjustedDaily = round(daily * 0.5);
          halfPay = true;
        }

        const entry = {
          id: s.id,
          name: s.name,
          role: s.role,
          monthly: s.monthly_salary,
          daily: adjustedDaily,
          fullDaily: daily,
          startDate,
          category: s.category || 'nch_direct',
          odooEmployeeId: s.odoo_employee_id,
          halfPay,
          active: !!s.active,
        };

        if (entry.category === 'office') {
          office.push(entry);
          officeTotal += adjustedDaily;
        } else {
          nchDirect.push(entry);
          nchTotal += adjustedDaily;
        }
      }

      return json({
        success: true,
        date,
        nchDirect,
        office,
        inactive: staff.filter(s => !s.active).map(s => ({
          name: s.name, role: s.role, monthly: s.monthly_salary,
          startDate: s.start_date || s.effective_from, category: s.category,
        })),
        totals: {nch: round(nchTotal), office: round(officeTotal), grand: round(nchTotal + officeTotal)},
      }, corsHeaders);
    }

    // ─── GET ALL STAFF (for config/edit) ────────────────────
    if (action === 'get-staff') {
      if (!DB) return json({success: false, error: 'Database not configured'}, corsHeaders);
      const salaries = await DB.prepare('SELECT * FROM staff_salaries ORDER BY category, name').all();
      return json({success: true, staff: salaries.results || []}, corsHeaders);
    }

    // ─── SAVE STAFF (add/update) ────────────────────────────
    if (action === 'save-staff' && context.request.method === 'POST') {
      if (!DB) return json({success: false, error: 'Database not configured'}, corsHeaders);
      const body = await context.request.json();
      const {id, name, role, monthly_salary, category, start_date, active} = body;
      const now = new Date().toISOString();

      if (!name || !monthly_salary) return json({success: false, error: 'Name and salary required'}, corsHeaders);

      if (id) {
        // Update existing
        await DB.prepare(
          'UPDATE staff_salaries SET name=?, role=?, monthly_salary=?, category=?, start_date=?, active=?, updated_at=? WHERE id=?'
        ).bind(name, role || '', monthly_salary, category || 'nch_direct', start_date || '', active !== undefined ? (active ? 1 : 0) : 1, now, id).run();
        return json({success: true, message: 'Staff updated', id}, corsHeaders);
      } else {
        // Insert new
        const result = await DB.prepare(
          'INSERT INTO staff_salaries (name, role, monthly_salary, effective_from, active, updated_at, category, start_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(name, role || '', monthly_salary, start_date || now.slice(0, 10), active !== undefined ? (active ? 1 : 0) : 1, now, category || 'nch_direct', start_date || '').run();
        return json({success: true, message: 'Staff added', id: result.meta.last_row_id}, corsHeaders);
      }
    }

    // ─── SYNC TO ODOO ───────────────────────────────────────
    if (action === 'sync-odoo' && context.request.method === 'POST') {
      if (!ODOO_API_KEY) return json({success: false, error: 'Odoo API key not configured'}, corsHeaders);
      if (!DB) return json({success: false, error: 'Database not configured'}, corsHeaders);

      const staff = (await DB.prepare('SELECT * FROM staff_salaries').all()).results || [];
      const results = [];

      for (const s of staff) {
        try {
          if (s.odoo_employee_id) {
            // Update existing Odoo employee
            await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, 'hr.employee', 'write',
              [[s.odoo_employee_id], {job_title: s.role, wage: s.monthly_salary}]);
            results.push({name: s.name, action: 'updated', odooId: s.odoo_employee_id});
          } else {
            // Create in Odoo
            const newId = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, 'hr.employee', 'create',
              [{name: s.name, job_title: s.role, company_id: NCH_COMPANY, employee_type: 'employee', wage: s.monthly_salary, active: !!s.active}]);
            await DB.prepare('UPDATE staff_salaries SET odoo_employee_id=?, updated_at=? WHERE id=?')
              .bind(newId, new Date().toISOString(), s.id).run();
            results.push({name: s.name, action: 'created', odooId: newId});
          }
        } catch (e) {
          results.push({name: s.name, action: 'error', error: e.message});
        }
      }

      return json({success: true, results}, corsHeaders);
    }

    // ─── GET ODOO EMPLOYEES ─────────────────────────────────
    if (action === 'get-odoo-employees') {
      if (!ODOO_API_KEY) return json({success: false, error: 'Odoo API key not configured'}, corsHeaders);

      const employees = await odooCall(ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, 'hr.employee', 'search_read',
        [[['company_id', '=', NCH_COMPANY]]],
        {fields: ['id', 'name', 'job_title', 'department_id', 'wage', 'active']});

      return json({success: true, employees}, corsHeaders);
    }

    return json({success: false, error: 'Invalid action. Use: get-daily-costs, get-staff, save-staff, sync-odoo, get-odoo-employees'}, corsHeaders);

  } catch (err) {
    return json({success: false, error: err.message || 'Internal server error'}, corsHeaders);
  }
}

async function odooCall(url, db, uid, apiKey, model, method, positionalArgs, kwargs) {
  const payload = {
    jsonrpc: '2.0', method: 'call',
    params: { service: 'object', method: 'execute_kw',
      args: [db, uid, apiKey, model, method, positionalArgs, kwargs || {}] },
    id: Date.now(),
  };
  const response = await fetch(url, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
  const data = await response.json();
  if (data.error) throw new Error(`Odoo ${model}.${method}: ${data.error.message || JSON.stringify(data.error)}`);
  return data.result;
}
