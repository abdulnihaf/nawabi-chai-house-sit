#!/usr/bin/env node
// One-shot: add 14 POS items (11 beverages + 3 snacks) to NCH on ops.hamzahotel.com
// Mirrors the shape of the NEWEST existing product in each POS category (taxes, type, uom, invoice_policy, etc).
// Idempotent: skips any default_code that already exists. Read-only for existing rows.
// Run: ODOO_API_KEY=xxx node scripts/add-nch-pos-items-2026-04-22.js
// Or:  ODOO_API_KEY=xxx node scripts/add-nch-pos-items-2026-04-22.js --dry

const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
const ODOO_DB  = 'main';
const ODOO_UID = 2;
const KEY = process.env.ODOO_API_KEY;
if (!KEY) { console.error('Set ODOO_API_KEY'); process.exit(1); }
const DRY = process.argv.includes('--dry');

const COMPANY_ID   = 10;   // NCH
const CATEG_CHAI   = 48;   // pos.category (beverages bucket on ops.hamzahotel.com)
const CATEG_SNACKS = 47;   // pos.category (snacks)

const ITEMS = [
  { code: 'NCH-KC',  name: 'Kadak Chai',         price: 20, categ: CATEG_CHAI,   kind: 'beverage' },
  { code: 'NCH-ZC',  name: 'Zafrani Chai',       price: 50, categ: CATEG_CHAI,   kind: 'beverage' },
  { code: 'NCH-IGT', name: 'Irani Ginger Tea',   price: 20, categ: CATEG_CHAI,   kind: 'beverage' },
  { code: 'NCH-IBT', name: 'Irani Black Tea',    price: 20, categ: CATEG_CHAI,   kind: 'beverage' },
  { code: 'NCH-ICT', name: 'Irani Chocolate Tea',price: 30, categ: CATEG_CHAI,   kind: 'beverage' },
  { code: 'NCH-IH',  name: 'Irani Horlicks',     price: 30, categ: CATEG_CHAI,   kind: 'beverage' },
  { code: 'NCH-IB',  name: 'Irani Boost',        price: 30, categ: CATEG_CHAI,   kind: 'beverage' },
  { code: 'NCH-BC',  name: 'Black Coffee',       price: 30, categ: CATEG_CHAI,   kind: 'beverage' },
  { code: 'NCH-IBM', name: 'Irani Badam Milk',   price: 30, categ: CATEG_CHAI,   kind: 'beverage' },
  { code: 'NCH-IM',  name: 'Irani Milk',         price: 20, categ: CATEG_CHAI,   kind: 'beverage' },
  { code: 'NCH-ZCF', name: 'Zafrani Coffee',     price: 60, categ: CATEG_CHAI,   kind: 'beverage' },
  { code: 'NCH-CRB', name: 'Cream Bun',          price: 50, categ: CATEG_SNACKS, kind: 'snack'    }, // NCH-CB taken by Cheese Balls
  { code: 'NCH-NB',  name: 'Nutella Bun',        price: 60, categ: CATEG_SNACKS, kind: 'snack'    },
  { code: 'NCH-BMJ', name: 'Bun Muska Jam',      price: 50, categ: CATEG_SNACKS, kind: 'snack'    },
];

async function rpc(model, method, args = [], kwargs = {}) {
  const payload = { jsonrpc:'2.0', method:'call', id:Date.now(),
    params: { service:'object', method:'execute_kw',
      args: [ODOO_DB, ODOO_UID, KEY, model, method, args, kwargs] } };
  const r = await fetch(ODOO_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  const j = await r.json();
  if (j.error) throw new Error(`${model}.${method}: ${JSON.stringify(j.error.data?.message || j.error)}`);
  return j.result;
}

// Find newest template that is on-POS in the given pos.category and belongs to NCH,
// and use its taxes_id / type / uom_id / uom_po_id / invoice_policy / is_storable as the template shape.
async function fetchReference(categId) {
  const ids = await rpc('product.template', 'search', [[
    ['available_in_pos','=',true],
    ['pos_categ_ids','in',[categId]],
    ['company_id','=',COMPANY_ID],
  ]], { order:'id desc', limit:1 });
  if (!ids.length) throw new Error(`No reference product in pos.category ${categId}`);
  const [ref] = await rpc('product.template','read',[ids],{ fields:[
    'id','name','default_code','list_price','taxes_id','type','is_storable',
    'uom_id','invoice_policy','categ_id','pos_categ_ids','available_in_pos','company_id'
  ]});
  return ref;
}

(async () => {
  console.log(`[${DRY?'DRY':'LIVE'}] connecting to ${ODOO_URL} as uid=${ODOO_UID}, company=${COMPANY_ID}`);
  const refBev   = await fetchReference(CATEG_CHAI);
  const refSnack = await fetchReference(CATEG_SNACKS);
  console.log('Reference beverage:', { id:refBev.id, name:refBev.name, code:refBev.default_code, taxes:refBev.taxes_id, type:refBev.type, is_storable:refBev.is_storable, uom:refBev.uom_id, inv:refBev.invoice_policy, categ:refBev.categ_id });
  console.log('Reference snack:   ', { id:refSnack.id, name:refSnack.name, code:refSnack.default_code, taxes:refSnack.taxes_id, type:refSnack.type, is_storable:refSnack.is_storable, uom:refSnack.uom_id, inv:refSnack.invoice_policy, categ:refSnack.categ_id });

  const results = [];
  for (const item of ITEMS) {
    const ref = item.kind === 'beverage' ? refBev : refSnack;
    // Dedup by default_code (scoped to company)
    const existing = await rpc('product.template','search_read',[[
      ['default_code','=',item.code], ['company_id','=',COMPANY_ID]
    ]], { fields:['id','name'], limit:1 });
    if (existing.length) {
      console.log(`SKIP  ${item.code.padEnd(8)} — exists (template ${existing[0].id}: ${existing[0].name})`);
      results.push({ ...item, template_id: existing[0].id, product_id: null, skipped:true });
      continue;
    }
    // Also dedup by name within company+POS to avoid phantom dupes
    const byName = await rpc('product.template','search_read',[[
      ['name','=',item.name], ['company_id','=',COMPANY_ID], ['available_in_pos','=',true]
    ]], { fields:['id','default_code'], limit:1 });
    if (byName.length) {
      console.log(`SKIP  ${item.code.padEnd(8)} — name already used by template ${byName[0].id} (code ${byName[0].default_code})`);
      results.push({ ...item, template_id: byName[0].id, product_id: null, skipped:true, reason:'name-match' });
      continue;
    }

    const vals = {
      name: item.name,
      default_code: item.code,
      list_price: item.price,
      available_in_pos: true,
      pos_categ_ids: [[6, 0, [item.categ]]],
      taxes_id: [[6, 0, ref.taxes_id]],
      type: ref.type,
      is_storable: ref.is_storable,
      uom_id: ref.uom_id?.[0] ?? ref.uom_id,
      invoice_policy: ref.invoice_policy,
      categ_id: ref.categ_id?.[0] ?? ref.categ_id,
      company_id: COMPANY_ID,
    };
    if (DRY) {
      console.log(`DRY   ${item.code.padEnd(8)} would create:`, vals);
      results.push({ ...item, template_id:null, product_id:null, dry:true });
      continue;
    }
    const tmplId = await rpc('product.template','create',[[vals]]);
    const tmplIdSingle = Array.isArray(tmplId) ? tmplId[0] : tmplId;
    // Fetch the variant product.product id
    const variant = await rpc('product.product','search_read',[[
      ['product_tmpl_id','=',tmplIdSingle]
    ]], { fields:['id','default_code','name'], limit:1 });
    const pid = variant[0]?.id;
    console.log(`CREATE ${item.code.padEnd(8)} tmpl=${tmplIdSingle} product=${pid} (${item.name}, ₹${item.price}, categ ${item.categ})`);
    results.push({ ...item, template_id: tmplIdSingle, product_id: pid });
  }

  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    console.log(`${r.code.padEnd(8)} ${String(r.template_id||'-').padEnd(6)} ${String(r.product_id||'-').padEnd(6)} ${r.kind.padEnd(8)} ${r.name}${r.skipped?' [skipped]':''}${r.dry?' [dry]':''}`);
  }

  const bev = results.filter(r => r.kind==='beverage' && r.product_id);
  if (bev.length) {
    console.log('\n=== NCH code change — paste into functions/api/token-settlement.js (lines 42-43) ===');
    const idsArr = [1028, 1102, 1103, ...bev.map(r=>r.product_id)];
    const namesMap = { 1028:'chai', 1102:'coffee', 1103:'lemon_tea',
      ...Object.fromEntries(bev.map(r => [r.product_id, r.name.toLowerCase().replace(/\s+/g,'_')]))
    };
    console.log(`  const BEVERAGE_IDS = ${JSON.stringify(idsArr)};`);
    console.log(`  const BEVERAGE_NAMES = ${JSON.stringify(namesMap)};`);
  }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
