/**
 * install-icons.js  v3
 * Uses the SAME getRealItemName logic as the app (loads item_names.json)
 * so the thumbnails_map keys match exactly what the app looks up.
 *
 * Steps:
 * 1. CDN bulk load
 * 2. T-variants inherit base icon
 * 3. RLG scraping only for esports decals + body-specific decals + other mapped categories
 *
 * Usage: node scripts/install-icons.js
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const os = require('os');

const APP_DATA       = path.join(os.homedir(), 'AppData', 'Roaming', 'ascend');
const CATALOG_FILE   = path.join(APP_DATA, 'catalog.json');
const MAP_FILE       = path.join(APP_DATA, 'thumbnails_map.json');
const NAMES_FILE     = path.join(__dirname, '..', 'src', 'modules', 'item_names.json');

// ── Verified esports decal paths on RLG ────────────────────────────────────
const ESPORTS_DECAL_URLS = {
  'alpine':              'octane/alpine-esports',
  'cloud9':              'octane/cloud9',
  'complexity':          'octane/complexity',
  'dignitas':            'octane/dignitas',
  'elevate':             'fennec/elevate-2024',
  'evilgeniuses':        'octane/evil-geniuses',
  'fazeclan':            'fennec/faze-clan',
  'furia':               'octane/furia',
  'g2':                  'octane/g2-esports',
  'ghostgaming':         'octane/ghost-gaming',
  'giants':              'octane/giants',
  'groundzerogaming':    'octane/ground-zero-gaming',
  'karminecorp':         'fennec/karmine-corp',
  'mousesports':         'octane/mousesports',
  'nrg':                 'octane/nrg-esports',
  'psg':                 'octane/psg-esports',
  'pwr':                 'octane/pwr',
  'rebellion':           'octane/rebellion',
  'renegades':           'octane/renegades',
  'rogue':               'octane/rogue',
  'skgaming':            'octane/sk-gaming',
  'semperesports':       'octane/semper-esports',
  'spacestationgaming':  'octane/spacestation-gaming',
  'tsm':                 'octane/tsm',
  'teamqueso':           'octane/team-queso',
  'teamsingularity':     'octane/team-singularity',
  'torrent':             'octane/torrent',
  'trueneutral':         'octane/true-neutral',
  'version1':            'octane/version1',
  'xset':                'octane/xset',
  'renaultvitality':     'octane/team-vitality',
  'resolve':             'octane/resolve-2024',
  'splyce':              'octane/splyce',
  'endpoint':            'octane/endpoint',
  'eunited':             'octane/eunited',
  'guild':               'octane/guild-esports',
  'oxygen':              'octane/oxygen-esports',
  'pittsburghknights':   'octane/pittsburgh-knights',
  'reciprocity':         'octane/reciprocity',
  'solary':              'octane/solary',
  'susquehannasoniqs':   'octane/susquehanna-soniqs',
  'teambds':             'octane/team-bds',
  'teamenvy':            'octane/team-envy',
  'teamliquid':          'octane/team-liquid',
};

const PLACEHOLDER_HASHES = ['bd07f7dd801478026052', 'engine'];
const SKIP_CATEGORIES    = new Set(['Anthems']);
const CAT_MAP = {
  'Antennas':'antennas','Bodies':'bodies','Decals':'decals','Boosts':'boosts',
  'EngineSounds':'engine-sounds','GoalExplosions':'goal-explosions','Toppers':'toppers',
  'PaintFinishes':'paint-finishes','PlayerBanners':'player-banners','Trails':'trails',
  'Wheels':'wheels','AvatarBorders':'avatar-borders'
};
const CONCURRENCY = 25;

// ── Replicate app's getRealItemName ─────────────────────────────────────────
let itemNamesMap = {};
function getRealItemName(item) {
  let code = (item.code || '').toLowerCase().replace(/_sf$/i, '');
  let isPaintedT = false;
  if (code.endsWith('_t')) { code = code.slice(0, -2); isPaintedT = true; }

  let displayName = null;
  if (itemNamesMap[code]) {
    displayName = itemNamesMap[code];
  } else {
    displayName = item.label || item.name || 'Unknown';
  }

  if (isPaintedT && displayName && !displayName.toLowerCase().endsWith(' t')) {
    displayName = `${displayName} T`;
  }
  return displayName;
}

function getSlug(str) {
  return str.toLowerCase()
    .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u').replace(/[ç]/g, 'c')
    .replace(/[ñ]/g, 'n').replace(/\./g, '')
    .replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getRlgUrl(displayName, category) {
  const catSlug = CAT_MAP[category];
  if (!catSlug) return null;
  let name = displayName;
  if (name.toLowerCase().endsWith(' t')) name = name.slice(0, -2).trim();

  if (category === 'Decals') {
    if (name.includes(':')) {
      const [body, decal] = name.split(':');
      return `https://rocket-league.com/items/decals/${getSlug(body.trim())}/${getSlug(decal.trim())}`;
    }
    const labelKey = getSlug(name).replace(/-/g, '');
    if (ESPORTS_DECAL_URLS[labelKey]) {
      return `https://rocket-league.com/items/decals/${ESPORTS_DECAL_URLS[labelKey]}`;
    }
    return null; // Unknown standalone decal – skip
  }
  return `https://rocket-league.com/items/${catSlug}/${getSlug(name)}`;
}

async function scrapeUrl(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 12000, redirect: 'follow'
    });
    if (!res.ok) return null;
    if (res.url && (res.url.endsWith('/items') || res.url.endsWith('/items/'))) return null;
    const html = await res.text();
    const m = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)
           || html.match(/<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i);
    if (!m) return null;
    let img = m[1];
    if (!img.startsWith('http')) img = 'https://rocket-league.com' + img;
    if (PLACEHOLDER_HASHES.some(h => img.includes(h))) return null;
    return img;
  } catch { return null; }
}

async function runPool(tasks, concurrency, onTask) {
  let idx = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (idx < tasks.length) await onTask(tasks[idx++]);
  }));
}

async function main() {
  console.log('=== Ascend Icon Installer v3 ===\n');

  // Load item_names.json (same as app)
  if (fs.existsSync(NAMES_FILE)) {
    itemNamesMap = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'));
    console.log(`Loaded ${Object.keys(itemNamesMap).length} name mappings from item_names.json`);
  } else {
    console.warn('⚠ item_names.json not found, falling back to catalog labels');
  }

  const { items: catalog } = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  const items = catalog.filter(i => !SKIP_CATEGORIES.has(i.category));
  console.log(`Catalog: ${items.length} items\n`);

  // ── Step 1: CDN bulk load ──────────────────────────────────────────────────
  console.log('Step 1/3: CDN bulk load...');
  const cdnMap = {};
  try {
    const res = await fetch('https://cdn.jsdelivr.net/gh/kaiserdj/rl-garage-assets@main/output/data.json', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000
    });
    const cdnData = await res.json();
    for (const e of cdnData) if (e.name && e.src) cdnMap[e.name.toLowerCase()] = e.src;
    console.log(`  ✓ ${Object.keys(cdnMap).length} from CDN\n`);
  } catch (e) { console.warn('  ⚠ CDN failed:', e.message, '\n'); }

  // ── Step 2: Build map using correct display names ─────────────────────────
  const map = {};
  const rlgQueue = [];
  let cdnHits = 0, tHits = 0;

  for (const item of items) {
    const name = getRealItemName(item);
    const key  = name.toLowerCase();

    // Check CDN with display name
    if (cdnMap[key]) {
      map[key] = cdnMap[key];
      cdnHits++;
      continue;
    }

    // T-variants: try base icon
    if (key.endsWith(' t')) {
      const baseKey = key.slice(0, -2).trim();
      if (cdnMap[baseKey]) { map[key] = cdnMap[baseKey]; tHits++; continue; }
      if (map[baseKey])    { map[key] = map[baseKey];    tHits++; continue; }
    }

    // Try RLG for known categories
    if (CAT_MAP[item.category]) {
      const url = getRlgUrl(name, item.category);
      if (url) {
        rlgQueue.push({ key, url });
        continue;
      }
    }

    // No source – mark as failed
    map[key] = '';
  }

  console.log(`Step 2 summary: ${cdnHits} from CDN | ${tHits} T-variants inherited`);
  console.log(`\nStep 3/3: Scraping RLG for ${rlgQueue.length} items with known URLs...`);

  let found = 0, notFound = 0;
  const t0 = Date.now();
  await runPool(rlgQueue, CONCURRENCY, async ({ key, url }) => {
    const img = await scrapeUrl(url);
    map[key] = img || '';
    if (img) found++; else notFound++;
    const done = found + notFound;
    if (done % 20 === 0 || done === rlgQueue.length) {
      process.stdout.write(`\r  ${done}/${rlgQueue.length} | ✓${found} | ✗${notFound} | ${((Date.now()-t0)/1000).toFixed(0)}s`);
    }
  });
  console.log('\n');

  // ── T-variants pass 2: inherit from newly scraped RLG results ─────────────
  let tHits2 = 0;
  for (const item of items) {
    const name = getRealItemName(item);
    const key  = name.toLowerCase();
    if (!key.endsWith(' t')) continue;
    if (map[key] && map[key] !== '') continue;
    const baseKey = key.slice(0, -2).trim();
    if (map[baseKey] && map[baseKey] !== '') { map[key] = map[baseKey]; tHits2++; }
  }
  if (tHits2 > 0) console.log(`  + ${tHits2} T-variants resolved from RLG scraped icons`);

  // ── Save ───────────────────────────────────────────────────────────────────
  fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
  const withIcon = Object.values(map).filter(v => v && v !== '').length;
  const noIcon   = Object.values(map).filter(v => v === '').length;

  console.log('\n=== DONE ===');
  console.log(`  Total entries : ${Object.keys(map).length}`);
  console.log(`  ✓ With icon   : ${withIcon}`);
  console.log(`  ✗ No icon     : ${noIcon}`);
  console.log(`  File          : ${MAP_FILE}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
