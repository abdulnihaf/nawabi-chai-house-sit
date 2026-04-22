#!/usr/bin/env node
// Upload product photos to NCH POS products on ops.hamzahotel.com
// Writes to product.template.image_1920 (Odoo resizes to multiple sizes automatically)
// Idempotent: skips products that already have a photo
// Run: ODOO_API_KEY=xxx node scripts/upload-nch-pos-photos-2026-04-22.js
// Or:  ODOO_API_KEY=xxx node scripts/upload-nch-pos-photos-2026-04-22.js --dry

const { readFileSync } = require('fs');
const { join } = require('path');

const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
const ODOO_DB  = 'main';
const ODOO_UID = 2;
const KEY = process.env.ODOO_API_KEY;
if (!KEY) { console.error('Set ODOO_API_KEY'); process.exit(1); }
const DRY = process.argv.includes('--dry');

const PHOTOS_DIR = '/tmp/nawabi-photos/Nawabi Menu Photos';

// template_id → image filename
const MAPPING = [
  // Beverages (categ 48 — Chai)
  { tmpl: 1028, name: 'Irani Chai',            file: 'Irani Chai 250ml - 1.jpg' },
  { tmpl: 1084, name: 'Nawabi Special Coffee', file: 'Milk Coffee.jpg' },
  { tmpl: 1085, name: 'Lemon Tea',             file: 'Lemon Tea - 1.jpg' },
  { tmpl: 1632, name: 'Kadak Chai',            file: 'Karak Chai.jpg' },
  { tmpl: 1633, name: 'Zafrani Chai',          file: 'Zafran Chai.jpg' },
  { tmpl: 1634, name: 'Irani Ginger Tea',      file: 'Irani Ginger Chai - 2.jpg' },
  { tmpl: 1635, name: 'Irani Black Tea',       file: 'Irani Black Chai - 1.jpg' },
  { tmpl: 1636, name: 'Irani Chocolate Tea',   file: 'Irani Chocolate Tea.jpg.jpg' },
  { tmpl: 1637, name: 'Irani Horlicks',        file: 'Irani Horlicks.jpg' },
  { tmpl: 1638, name: 'Irani Boost',           file: 'Irani Boost Milk.jpg' },
  { tmpl: 1639, name: 'Black Coffee',          file: 'Irani Black Chai - 1.jpg' },
  { tmpl: 1640, name: 'Irani Badam Milk',      file: 'Irani Badam Milk.jpg' },
  { tmpl: 1641, name: 'Irani Milk',            file: 'Irani Milk.jpg' },
  { tmpl: 1642, name: 'Zafrani Coffee',        file: 'Zafrani Coffee.jpg' },
  // Snacks (categ 47)
  { tmpl: 1029, name: 'Bun Maska',            file: 'Maska Bun.jpg' },
  { tmpl: 1435, name: 'Khajor',               file: 'Kajoor.jpg' },
  { tmpl: 1643, name: 'Nutella Bun',          file: 'Nutella Bun.jpg' },
  { tmpl: 1644, name: 'Bun Muska Jam',        file: 'Bun Maska Jam.jpg' },
  { tmpl: 1645, name: 'Cream Bun',            file: 'Cream Bun.jpg' },
  // Osmania / Niloufer biscuits — all use same Osmania photo
  { tmpl: 1030, name: 'Osmania Biscuit',               file: 'Osmania Biscuits.jpg' },
  { tmpl: 1033, name: 'Osmania Biscuit - Pack of 3',   file: 'Osmania Biscuits.jpg' },
  { tmpl: 1093, name: 'Niloufer Osmania 500g',         file: 'Osmania Biscuits.jpg' },
  { tmpl: 1405, name: 'Niloufer Osmania 100g',         file: 'Osmania Biscuits.jpg' },
  { tmpl: 1383, name: 'Niloufer DCC 75g',              file: 'Dry Fruit Biscuits.jpg' },
  { tmpl: 1384, name: 'Niloufer Fruit 100g',           file: 'Fruit Biscuits.jpg' },
  { tmpl: 1385, name: 'Niloufer Fruit 200g',           file: 'Fruit Biscuits.jpg' },
];

async function rpc(model, method, args = [], kwargs = {}) {
  const payload = { jsonrpc:'2.0', method:'call', id:Date.now(),
    params:{ service:'object', method:'execute_kw',
      args:[ODOO_DB, ODOO_UID, KEY, model, method, args, kwargs] } };
  const r = await fetch(ODOO_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  const j = await r.json();
  if (j.error) throw new Error(`${model}.${method}: ${JSON.stringify(j.error.data?.message || j.error)}`);
  return j.result;
}

(async () => {
  console.log(`[${DRY ? 'DRY' : 'LIVE'}] uploading ${MAPPING.length} product photos to ops.hamzahotel.com`);

  // Pre-check: fetch current image state for all templates
  const tmplIds = [...new Set(MAPPING.map(m => m.tmpl))];
  const current = await rpc('product.template', 'read', [tmplIds], { fields: ['id', 'name', 'image_128'] });
  const hasPhoto = new Map(current.map(p => [p.id, !!(p.image_128)]));

  let uploaded = 0, skipped = 0, failed = 0;

  for (const item of MAPPING) {
    const imgPath = join(PHOTOS_DIR, item.file);
    let imgData;
    try {
      imgData = readFileSync(imgPath);
    } catch {
      console.log(`MISSING  tmpl=${item.tmpl} ${item.name} — file not found: ${item.file}`);
      failed++;
      continue;
    }

    if (hasPhoto.get(item.tmpl)) {
      console.log(`SKIP     tmpl=${item.tmpl} ${item.name} — already has photo`);
      skipped++;
      continue;
    }

    const b64 = imgData.toString('base64');
    const sizeMB = (imgData.length / 1024 / 1024).toFixed(1);

    if (DRY) {
      console.log(`DRY      tmpl=${item.tmpl} ${item.name.padEnd(30)} ← ${item.file} (${sizeMB}MB)`);
      uploaded++;
      continue;
    }

    try {
      await rpc('product.template', 'write', [[item.tmpl], { image_1920: b64 }]);
      console.log(`OK       tmpl=${item.tmpl} ${item.name.padEnd(30)} ← ${item.file} (${sizeMB}MB)`);
      uploaded++;
      // Small pause to avoid hammering Odoo
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.log(`FAILED   tmpl=${item.tmpl} ${item.name} — ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDone: ${uploaded} uploaded, ${skipped} skipped (already had photo), ${failed} failed`);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
