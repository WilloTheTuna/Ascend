/* ── Ascend Renderer ── */

// rc is exposed globally by contextBridge in preload.js, so we don't declare it here.
let settings = {};
let swaps = [];
let catalog = [];
let currentSearch = '';
let currentCategory = 'All';
let searchTimeout = null;
let currentLimit = 48;
let hasMore = true;
const CATALOG_PAGE = 48;



// Workshop Explorer State
let workshopPage = 1;
let workshopSearch = '';
let workshopSort = 'downloads';
let showDownloadedOnly = false;
let activeMapId = null;
let workshopSearchTimeout = null;
let currentPluginsTab = 'bm';

// Multi-slot custom maps configuration
const MAP_SLOTS = {
  slot1: { name: 'Utopia Retro' },
  slot2: { name: 'Underpass' },
  slot3: { name: 'Double Goal' },
  slot4: { name: 'Octagon' }
};
let currentModalMapId = null;

// ─── Global error capture ────────────────────────────────────────
window.addEventListener('error', (e) => {
  rc?.logError?.(e.error ? e.error.stack : e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  rc?.logError?.('Unhandled: ' + (e.reason?.stack || e.reason));
});

// ─── Boot sequence ───────────────────────────────────────────────
async function initApp() {
  try {
    // 1. Fetch swaps + settings in parallel (tiny IPC calls)
    [swaps, settings] = await Promise.all([rc.listSwaps(), rc.getSettings()]);

    // 2. Paint UI
    setupSettings();
    updateActiveSwapsBar();
    await fetchAndRenderCatalog(true);
    updateMissingItemsBadge();



    // 3. Deferred secondary tabs — staggered to prevent CPU/IO spikes and lag
    setTimeout(async () => {
      try {
        await loadTrackerSession();
        await loadPlugins();
        await loadBakkesPlugins();
        setupWorkshopListeners();
        setupPluginsListeners();

        setTimeout(() => loadWorkshopMaps().catch(() => {}), 80);
        setTimeout(() => loadPresets().catch(() => {}), 160);
        setTimeout(() => {
          loadBallPacks().catch(() => {});
          loadDecalPacks().catch(() => {});
          loadHudPacks().catch(() => {});
        }, 240);
      } catch (e) {
        rc?.logError?.(String(e));
      }
    }, 100);

  } catch (err) {
    showCatalogError(err.message);
    rc?.logError?.(err.stack || String(err));
  }
}

// ─── Window controls setup ───────────────────────────────────────
function setupWindowControls() {
  document.getElementById('btn-overlay') ?.addEventListener('click', () => rc.toggleOverlay());
  document.getElementById('btn-minimize')?.addEventListener('click', () => rc.minimize());
  document.getElementById('btn-maximize')?.addEventListener('click', () => rc.maximize());
  document.getElementById('btn-close')   ?.addEventListener('click', () => rc.close());
}

// Boot handling: runs immediately if DOM already interactive/complete
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initApp();
    setupWindowControls();
    setupPluginSettingsModal();
    setupUpdaterControls();
  });
} else {
  initApp();
  setupWindowControls();
  setupPluginSettingsModal();
  setupUpdaterControls();
}

// ─── Navigation ──────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const tab = document.getElementById(`tab-${btn.dataset.tab}`);
    if (tab) tab.classList.add('active');
    // Refresh swap pills quando si entra nel tab swaps
    if (btn.dataset.tab === 'swaps') {
      refreshSwaps();
      updateMissingItemsBadge();
    }
  });
});

async function updateMissingItemsBadge() {
  try {
    const info = await rc.getMissingThumbnailsInfo();
    const popup = document.getElementById('swaps-refresh-popup');
    const badgeText = document.getElementById('missing-count');
    const btn = document.getElementById('btn-swaps-refresh');
    if (info && info.missingCount > 0) {
      if (badgeText) badgeText.textContent = info.missingCount;
      if (popup) popup.style.display = 'block';
      if (btn) btn.classList.add('pulse');
    } else {
      if (popup) popup.style.display = 'none';
      if (btn) btn.classList.remove('pulse');
    }
  } catch (err) {
    rc?.logError?.(`Error checking new items: ${err.message}`);
  }
}


// ─── Search / Filter ─────────────────────────────────────────────
document.getElementById('swaps-search-input')?.addEventListener('input', e => {
  currentSearch = e.target.value;
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(filterAndRender, 280);
});
document.getElementById('swaps-category-select')?.addEventListener('change', e => {
  currentCategory = e.target.value;
  filterAndRender();
});

document.getElementById('btn-swaps-refresh')?.addEventListener('click', async () => {
  const popup = document.getElementById('swaps-refresh-popup');
  if (popup) popup.style.display = 'none';

  try {
    const info = await rc.getMissingThumbnailsInfo();
    if (!info || info.missingCount === 0) {
      toast('All game items and icons are already up to date! ✅', 'success');
      return;
    }

    const msg = `Found ${info.missingCount} missing items/icons in the catalog.\n\nEstimated total file size: ${info.weightMB} MB.\n\nDo you want to start the download now?`;
    if (!confirm(msg)) return;

    const bar = document.getElementById('swaps-download-progress-bar');
    const fill = document.getElementById('swaps-progress-fill');
    const text = document.getElementById('swaps-progress-text');
    const pct = document.getElementById('swaps-progress-pct');
    const btn = document.getElementById('btn-swaps-refresh');

    if (bar) bar.style.display = 'flex';
    if (fill) fill.style.width = '0%';
    if (text) text.textContent = 'Updating catalog...';
    if (pct) pct.textContent = '0%';
    if (btn) btn.disabled = true;

    await rc.refreshCatalog();
  } catch (err) {
    toast(`Error during refresh: ${err.message}`, 'error');
  }
});

rc.on('catalog-refresh-progress', (data) => {
  const bar = document.getElementById('swaps-download-progress-bar');
  const fill = document.getElementById('swaps-progress-fill');
  const text = document.getElementById('swaps-progress-text');
  const pct = document.getElementById('swaps-progress-pct');
  const btn = document.getElementById('btn-swaps-refresh');

  if (!bar) return;

  bar.style.display = 'flex';
  if (data.phase === 'scan') {
    text.textContent = 'Scanning local game files...';
    fill.style.width = `${data.progress}%`;
    pct.textContent = `${data.progress}%`;
  } else if (data.phase === 'download') {
    text.textContent = 'Downloading item database...';
    fill.style.width = `${data.progress}%`;
    pct.textContent = `${data.progress}%`;
  } else if (data.phase === 'complete') {
    const addedText = data.addedCount > 0 ? ` (+${data.addedCount} new)` : '';
    text.textContent = `Database updated${addedText}. Downloading missing items...`;
    fill.style.width = '100%';
    pct.textContent = '100%';
    filterAndRender();
    updateMissingItemsBadge();
    // Auto-download missing thumbnails
    setTimeout(async () => {
      fill.style.width = '0%';
      pct.textContent = '0%';
      try {
        await rc.downloadMissingThumbnails();
      } catch (e) {
        text.textContent = `Item download error: ${e.message}`;
        if (btn) btn.disabled = false;
        setTimeout(() => { bar.style.display = 'none'; }, 4000);
      }
    }, 800);
  } else if (data.phase === 'thumbnails') {
    const label = data.current ? `Downloading: ${data.current}` : 'Downloading items...';
    text.textContent = `${label} (${data.resolved}/${data.total})`;
    fill.style.width = `${data.progress}%`;
    pct.textContent = `${data.progress}%`;
  } else if (data.phase === 'thumbnails-complete') {
    const msg = data.total === 0
      ? 'All items up to date!'
      : `Downloaded ${data.resolved}/${data.total} items!`;
    text.textContent = msg;
    fill.style.width = '100%';
    pct.textContent = '100%';
    if (btn) btn.disabled = false;
    filterAndRender();
    updateMissingItemsBadge();
    setTimeout(() => { bar.style.display = 'none'; }, 2000);
  } else if (data.phase === 'failed') {
    text.textContent = `Error: ${data.error || 'failed'}`;
    fill.style.width = '0%';
    pct.textContent = '0%';
    if (btn) btn.disabled = false;
    setTimeout(() => {
      bar.style.display = 'none';
    }, 4000);
  }
});



function filterAndRender() {
  fetchAndRenderCatalog(true);
}

// ─── Catalog Rendering ───────────────────────────────────────────
async function fetchAndRenderCatalog(resetLimit = false) {
  if (resetLimit) {
    currentLimit = CATALOG_PAGE;
  }
  try {
    const items = await rc.getCatalog({
      category: currentCategory,
      search: currentSearch,
      limit: currentLimit + 1
    });

    const grid = document.getElementById('catalog-grid');
    if (!grid) return;

    if (!items || items.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <p>No catalog items found</p>
        </div>`;
      return;
    }

    hasMore = items.length > currentLimit;
    const newItems = items.slice(0, currentLimit);
    catalog = newItems;

    const countText = document.getElementById('swaps-count-text');
    if (countText) {
      rc.getMissingThumbnailsInfo().then(info => {
        if (info && info.totalCatalog) {
          countText.textContent = `${info.downloadedCount.toLocaleString('it-IT')} / ${info.totalCatalog.toLocaleString('it-IT')}`;
          
          // Keep the missing items badge perfectly synchronized
          const popup = document.getElementById('swaps-refresh-popup');
          const badgeText = document.getElementById('missing-count');
          const btn = document.getElementById('btn-swaps-refresh');
          if (info.missingCount > 0) {
            if (badgeText) badgeText.textContent = info.missingCount;
            if (popup) popup.style.display = 'block';
            if (btn) btn.classList.add('pulse');
          } else {
            if (popup) popup.style.display = 'none';
            if (btn) btn.classList.remove('pulse');
          }
        } else {
          countText.textContent = `0 / 0`;
        }
      }).catch(() => {
        countText.textContent = `0 / 0`;
      });
    }

    const existingBtn = document.getElementById('catalog-load-more');
    if (existingBtn) existingBtn.remove();

    if (resetLimit) {
      grid.innerHTML = catalog.map(itemCard).join('');
      attachCardListeners(grid);
    } else {
      // Incremental append for fast performance
      const existingCardCount = grid.querySelectorAll('.catalog-card').length;
      const appendItems = catalog.slice(existingCardCount);
      if (appendItems.length > 0) {
        const temp = document.createElement('div');
        temp.innerHTML = appendItems.map(itemCard).join('');
        while (temp.firstChild) {
          grid.appendChild(temp.firstChild);
        }
        attachCardListeners(grid, appendItems.length);
      }
    }

    if (hasMore) {
      appendLoadMore(grid);
    }
  } catch (err) {
    showCatalogError(err.message);
    rc?.logError?.(err.stack || String(err));
  }
}

function showCatalogError(msg) {
  const grid = document.getElementById('catalog-grid');
  if (grid) grid.innerHTML = `
    <div class="empty-state" style="grid-column:1/-1">
      <p style="color:#f43f5e">Catalog error</p>
      <span>${escapeHtml(msg)}</span>
    </div>`;
}

function getCategoryFallbackEmoji(category) {
  const fallbackEmojis = {
    'Anthems': '🎵',
    'Antennas': '📡',
    'AvatarBorders': '🖼️',
    'Bodies': '🚗',
    'Decals': '🎨',
    'Boosts': '🔥',
    'EngineSounds': '🔊',
    'GoalExplosions': '💥',
    'Toppers': '🎩',
    'PaintFinishes': '🖌️',
    'PlayerBanners': '🚩',
    'Trails': '⚡',
    'Wheels': '🛞',
    'Anthems': '🎵'
  };
  return fallbackEmojis[category] || '📦';
}

function itemCard(item) {
  const swapped = swaps.some(s => s.sourceFile === item.sourceFile);
  const imgUrl = item.image || '';
  const fallbackEmoji = getCategoryFallbackEmoji(item.type);
  return `<div class="catalog-card${swapped ? ' swapped' : ''}"
       data-target-file="${escapeHtml(item.targetFile || '')}"
       data-source-file="${escapeHtml(item.sourceFile || '')}"
       data-label="${escapeHtml(item.name || '')}">
    <div class="card-img-container">
      ${imgUrl 
        ? `<img src="${imgUrl}" loading="lazy" alt="${escapeHtml(item.name)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" style="width:100%; height:100%; object-fit:contain;"/>
           <div class="card-img-fallback" style="display:none;">${fallbackEmoji}</div>`
        : `<div class="card-img-fallback">${fallbackEmoji}</div>`
      }
    </div>
    <div class="card-content">
      <div class="card-type">${escapeHtml(item.type || '')}</div>
      <div class="card-name">${escapeHtml(item.name || 'Unknown')}</div>
      <div class="card-file">${escapeHtml(item.id || '')}</div>
    </div>
    <div class="card-badge" style="display:${swapped ? 'block' : 'none'}">Active</div>
  </div>`;
}

function appendLoadMore(grid) {
  const existing = document.getElementById('catalog-load-more');
  if (existing) existing.remove();

  const btn = document.createElement('button');
  btn.id = 'catalog-load-more';
  btn.className = 'btn btn-ghost';
  btn.style.cssText = 'grid-column:1/-1;margin:16px auto;display:block;padding:10px 24px;font-size:14px;font-weight:600;cursor:pointer;';
  btn.textContent = `Load more`;
  btn.addEventListener('click', () => {
    currentLimit += CATALOG_PAGE;
    fetchAndRenderCatalog(false);
  });
  grid.appendChild(btn);
}

function attachCardListeners(grid, last = null) {
  const DEFAULTS_BY_CATEGORY = {
    'Anthems': 'album_anthem_monstercatgeneral_SF.upk',
    'Antennas': 'antenna_classic_SF.upk',
    'AvatarBorders': 'AvatarBorder_Default_SF.upk',
    'Bodies': 'Body_Octane_SF.upk',
    'Decals': 'body_octane_premium_skins_SF.upk',
    'Boosts': 'Boost_Standard_SF.upk',
    'EngineSounds': 'EngineAudio_Car01_OE_SF.upk',
    'GoalExplosions': 'Explosion_Default_SF.upk',
    'Toppers': 'hat_halo_SF.upk',
    'PaintFinishes': 'PaintFinish_Default_SF.upk',
    'PlayerBanners': 'playerbanner_classicpickup_SF.upk',
    'Trails': 'ss_default_SF.upk',
    'Wheels': 'wheel_7spoke_SF.upk'
  };

  const DEFAULTS_LABELS = {
    'Anthems': 'Monstercat General',
    'Antennas': 'Classic Antenna',
    'AvatarBorders': 'Bordo Avatar di Default',
    'Bodies': 'Octane',
    'Decals': 'Octane: Standard Decal',
    'Boosts': 'Standard Boost',
    'EngineSounds': 'OEM Engine',
    'GoalExplosions': 'Classica',
    'Toppers': 'Halo',
    'PaintFinishes': 'Finitura Standard',
    'PlayerBanners': 'Classic Banner',
    'Trails': 'Classica',
    'Wheels': 'OEM (7Spoke)'
  };

  const cards = grid.querySelectorAll('.catalog-card');
  const targets = last ? [...cards].slice(-last) : [...cards];
  targets.forEach(card => {
    card.addEventListener('click', async () => {
      const isSwapped = card.classList.contains('swapped');
      if (isSwapped) {
        const swap = swaps.find(s => s.sourceFile === card.dataset.sourceFile);
        if (swap) {
          const res = await rc.revertSwap(swap.id);
          if (res.ok) { toast('Swap reverted', 'success'); await refreshSwaps(); }
          else toast(res.error || 'Revert failed', 'error');
        }
      } else {
        const cardType = card.querySelector('.card-type')?.textContent?.trim() || '';
        const cardName = card.querySelector('.card-name')?.textContent?.trim() || '';
        const sourceFile = card.dataset.sourceFile;
        const cardImage = card.querySelector('.card-img-container img')?.src || '';

        showSwapTargetModal({
          name: cardName,
          type: cardType,
          sourceFile: sourceFile,
          image: cardImage
        });
      }
    });
  });
}

async function refreshSwaps() {
  swaps = await rc.listSwaps();
  updateActiveSwapsBar();
}

function updateActiveSwapsBar() {
  const bar   = document.getElementById('active-swaps-bar');
  const count = document.getElementById('active-swaps-count');
  const list  = document.getElementById('active-swaps-list');
  if (!bar || !count) return;
  if (swaps.length > 0) {
    bar.style.display = 'flex';
    count.textContent = `${swaps.length} swap${swaps.length !== 1 ? 's' : ''} attiv${swaps.length !== 1 ? 'i' : 'o'}`;
    if (list) {
      list.innerHTML = swaps.map(s => {
        const srcLabel  = s.sourceLabel  || s.sourceFile  || s.source  || '?';
        const tgtLabel  = s.targetLabel  || s.targetFile  || s.target  || 'Standard';
        return `<span class="swap-pill">
          <span class="swap-pill-target">${escapeHtml(tgtLabel)}</span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="swap-pill-source">${escapeHtml(srcLabel)}</span>
          <button class="swap-pill-revert" data-swap-id="${escapeHtml(String(s.id))}" title="Rimuovi questo swap">✕</button>
        </span>`;
      }).join('');
      list.querySelectorAll('.swap-pill-revert').forEach(btn => {
        btn.addEventListener('click', async () => {
          const res = await rc.revertSwap(btn.dataset.swapId);
          if (res.ok) { toast('Swap rimosso', 'success'); await refreshSwaps(); }
          else toast(res.error || 'Errore', 'error');
        });
      });
    }
  } else {
    bar.style.display = 'none';
    if (list) list.innerHTML = '';
  }
  document.querySelectorAll('.catalog-card').forEach(card => {
    const isSwapped = swaps.some(s => s.sourceFile === card.dataset.sourceFile);
    card.classList.toggle('swapped', isSwapped);
    const badge = card.querySelector('.card-badge');
    if (badge) badge.style.display = isSwapped ? 'block' : 'none';
  });
}

document.getElementById('btn-revert-all')?.addEventListener('click', async () => {
  await rc.revertAll();
  swaps = [];
  updateActiveSwapsBar();
  toast('All swaps reverted', 'success');
});

// ─── Ball Packs ──────────────────────────────────────────────────
async function loadBallPacks() {
  const packs = await rc.listBallPacks();
  const grid  = document.getElementById('ballpacks-grid');
  if (!grid) return;
  if (!packs.length) {
    grid.innerHTML = `<div class="empty-state"><p>No ball packs installed</p><span>Drop a pack folder above</span></div>`;
    return;
  }
  grid.innerHTML = packs.map(p => `
    <div class="pack-card" data-pack-id="${escapeHtml(p.name)}">
      <div class="pack-name">${escapeHtml(p.name)}</div>
      <div class="pack-author">${escapeHtml(p.author || 'Unknown')}</div>
      <button class="pack-apply-btn">Apply Pack</button>
    </div>`).join('');
  grid.querySelectorAll('.pack-apply-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.closest('.pack-card').dataset.packId;
      const res  = await rc.applyBallPack({ name });
      toast(res.ok ? `Ball pack applied: ${name}` : res.error, res.ok ? 'success' : 'error');
    });
  });
}

// ─── Decal Packs ─────────────────────────────────────────────────
async function loadDecalPacks() {
  const packs = await rc.listDecalPacks();
  const grid  = document.getElementById('decalpacks-grid');
  if (!grid) return;
  if (!packs.length) {
    grid.innerHTML = `<div class="empty-state"><p>No decal packs installed</p><span>Drop a pack folder above</span></div>`;
    return;
  }
  grid.innerHTML = packs.map(p => `
    <div class="pack-card" data-pack-id="${escapeHtml(p.name)}">
      <div class="pack-name">${escapeHtml(p.name)}</div>
      <div class="pack-author">${escapeHtml(p.author || 'Unknown')}</div>
      <button class="pack-apply-btn">Apply Pack</button>
    </div>`).join('');
  grid.querySelectorAll('.pack-apply-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.closest('.pack-card').dataset.packId;
      const res  = await rc.applyDecalPack({ name });
      toast(res.ok ? `Decal pack applied: ${name}` : res.error, res.ok ? 'success' : 'error');
    });
  });
}

// ─── HUD Packs ───────────────────────────────────────────────────
async function loadHudPacks() {
  const packs = await rc.listHudPacks();
  const grid  = document.getElementById('hudpacks-grid');
  if (!grid) return;
  if (!packs.length) {
    grid.innerHTML = `<div class="empty-state"><p>No HUD meter packs installed</p><span>Drop a pack folder above</span></div>`;
    return;
  }
  grid.innerHTML = packs.map(p => `
    <div class="pack-card">
      <div class="pack-name">${escapeHtml(p.name)}</div>
      <div class="pack-author">${escapeHtml(p.author || 'Unknown')}</div>
      <button class="pack-apply-btn" data-pack="${escapeHtml(p.name)}">Apply Pack</button>
    </div>`).join('');
}

// ─── Presets ─────────────────────────────────────────────────────
async function loadPresets() {
  const data = await rc.getPresets();
  const list = document.getElementById('presets-list');
  if (!list) return;
  if (!data.presets?.length) {
    list.innerHTML = `<div class="empty-state"><p>No presets saved</p><span>Save your current swaps as a preset above</span></div>`;
    return;
  }
  list.innerHTML = data.presets.map(p => `
    <div class="preset-item${p.name === data.currentPreset ? ' active' : ''}">
      <div>
        <div class="preset-name">${escapeHtml(p.name)}${p.name === data.currentPreset ? ' ✓' : ''}</div>
        <div class="preset-meta">${p.swaps.length} swaps</div>
      </div>
      <div class="preset-actions-right">
        <button class="btn btn-ghost btn-sm" data-preset-load="${escapeHtml(p.name)}">Load</button>
        <button class="btn btn-danger btn-sm" data-preset-delete="${escapeHtml(p.name)}">Delete</button>
      </div>
    </div>`).join('');

  list.querySelectorAll('[data-preset-load]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await rc.loadPreset(btn.dataset.presetLoad);
      toast(`Preset loaded: ${btn.dataset.presetLoad}`, 'success');
      await loadPresets(); await refreshSwaps();
    });
  });
  list.querySelectorAll('[data-preset-delete]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await rc.deletePreset(btn.dataset.presetDelete);
      toast('Preset deleted', 'success');
      await loadPresets();
    });
  });
}

document.getElementById('btn-save-preset')?.addEventListener('click', async () => {
  const name = document.getElementById('preset-name-input')?.value.trim();
  if (!name) return toast('Enter a preset name', 'warning');
  await rc.savePreset(name);
  document.getElementById('preset-name-input').value = '';
  toast(`Preset saved: ${name}`, 'success');
  await loadPresets();
});

// ─── Workshop ────────────────────────────────────────────────────
async function loadWorkshopMaps() {
  const grid = document.getElementById('maps-grid');
  if (!grid) return;

  try {
    // 1. Get active maps and list of local maps
    const [activeMaps, localMaps] = await Promise.all([
      rc.getActiveMap(),
      rc.listMaps()
    ]);
    activeMapId = activeMaps.slot1;

    // Render the 4-slot status grid dynamically
    const statusGrid = document.getElementById('workshop-status-grid');
    const restoreBtnGlobal = document.getElementById('btn-workshop-restore');
    
    if (statusGrid) {
      let hasAnyActive = false;
      let html = '';
      
      for (const slotId of Object.keys(MAP_SLOTS)) {
        const slot = MAP_SLOTS[slotId];
        const activeIdInSlot = activeMaps[slotId];
        const activeMapInSlot = activeIdInSlot ? localMaps.find(m => String(m.id) === String(activeIdInSlot)) : null;
        
        if (activeIdInSlot) hasAnyActive = true;
        
        html += `
          <div class="slot-card" data-slot="${slotId}" style="display: flex; align-items: center; justify-content: space-between; background: var(--glass-bg); padding: 10px 14px; border-radius: 8px; border: 1px solid var(--glass-border); font-size: 12px; backdrop-filter: blur(8px);">
            <div>
              <div style="font-weight: 700; color: var(--accent); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;">${escapeHtml(slot.name)}</div>
              <div style="font-size: 12.5px; margin-top: 3px; color: ${activeMapInSlot ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.4)'}; font-weight: ${activeMapInSlot ? '600' : 'normal'};">
                ${activeMapInSlot ? escapeHtml(activeMapInSlot.name) : 'Originale / Default'}
              </div>
            </div>
            ${activeMapInSlot ? `
              <button class="btn btn-ghost btn-sm btn-slot-restore" data-slot="${slotId}" style="padding: 4px 8px; font-size: 11px; height: auto; border: none; color: var(--danger); font-weight: 600;" title="Ripristina originale">Ripristina</button>
            ` : ''}
          </div>
        `;
      }
      
      statusGrid.innerHTML = html;
      
      if (restoreBtnGlobal) {
        restoreBtnGlobal.style.display = hasAnyActive ? 'inline-flex' : 'none';
      }
      
      // Attach click listeners to slot cards to select a map
      statusGrid.querySelectorAll('.slot-card').forEach(card => {
        card.addEventListener('click', () => {
          const slotId = card.dataset.slot;
          openMapSelectModal(slotId);
        });
      });

      // Attach single slot restore listeners
      statusGrid.querySelectorAll('.btn-slot-restore').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const slotId = btn.dataset.slot;
          const slotName = MAP_SLOTS[slotId].name;
          btn.disabled = true;
          btn.textContent = 'Ripristino...';
          const res = await rc.restoreOriginalMap(slotId);
          if (res.ok) {
            toast(`Ripristinata mappa originale per ${slotName}`, 'success');
            await loadWorkshopMaps();
          } else {
            btn.disabled = false;
            btn.textContent = 'Ripristina';
            toast(res.error || 'Ripristino fallito', 'error');
          }
        });
      });
    }

    if (showDownloadedOnly) {
      // ─── Local Mode ───
      // Hide pagination
      document.querySelectorAll('.workshop-pagination').forEach(el => el.style.display = 'none');

      // Filter locally
      const filtered = localMaps.filter(m => {
        const term = workshopSearch.toLowerCase();
        return (m.name || '').toLowerCase().includes(term) || (m.author || '').toLowerCase().includes(term);
      });

      const countLabel = document.getElementById('workshop-maps-count');
      if (countLabel) countLabel.textContent = `${filtered.length} maps`;

      if (!filtered.length) {
        grid.innerHTML = `<div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><path d="M24 6l4 10h10l-8 6 3 10-9-6-9 6 3-10-8-6h10L24 6z" stroke="rgba(255,255,255,0.2)" stroke-width="2" stroke-linejoin="round"/></svg>
          <p>No workshop maps found offline</p><span>Turn off "Downloaded only" to browse online maps</span></div>`;
        return;
      }

      grid.innerHTML = filtered.map(m => mapCardHtml(m, true, Object.values(activeMaps).some(id => String(id) === String(m.id)), activeMaps)).join('');
      attachMapCardListeners(grid);
    } else {
      // ─── Online Mode — celab.jetfox.ovh ───────────────────────────
      grid.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Connessione a celab.jetfox.ovh...</span></div>`;

      try {
        const res = await rc.searchCelabMaps({
          page:   workshopPage,
          search: workshopSearch
        });

        const countLabel  = document.getElementById('workshop-maps-count');
        if (countLabel) countLabel.textContent = `${res.total} mappe`;

        const paginationBars = document.querySelectorAll('.workshop-pagination');
        if (res.totalPages > 1) {
          paginationBars.forEach(el => {
            el.style.display = 'flex';
            const pageInfoEl = el.querySelector('.workshop-page-info');
            const prevBtn    = el.querySelector('.btn-workshop-prev');
            const nextBtn    = el.querySelector('.btn-workshop-next');
            if (pageInfoEl) pageInfoEl.textContent = `Pagina ${res.page} di ${res.totalPages}`;
            if (prevBtn)    prevBtn.disabled = res.page <= 1;
            if (nextBtn)    nextBtn.disabled = res.page >= res.totalPages;
          });
        } else {
          paginationBars.forEach(el => el.style.display = 'none');
        }

        if (!res.items || res.items.length === 0) {
          grid.innerHTML = `<div class="empty-state">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><path d="M24 6l4 10h10l-8 6 3 10-9-6-9 6 3-10-8-6h10L24 6z" stroke="rgba(255,255,255,0.2)" stroke-width="2" stroke-linejoin="round"/></svg>
            <p>Nessuna mappa trovata</p></div>`;
          return;
        }

        // Register progress listener once per load cycle
        if (window.__celabProgressOff) window.__celabProgressOff();
        const downloadingIds = {};   // projectId → pct

        window.__celabProgressOff = rc.onCelabProgress(({ projectId, pct }) => {
          downloadingIds[projectId] = pct;
          const bar = document.getElementById(`celab-progress-${projectId}`);
          if (bar) {
            bar.style.width = `${pct}%`;
            bar.parentElement.style.display = 'block';
          }
          const btn = document.getElementById(`celab-dl-btn-${projectId}`);
          if (btn) btn.textContent = `⬇ ${pct}%`;
        });

        grid.innerHTML = res.items.map(m => {
          const isLocal    = localMaps.some(loc => String(loc.id) === String(m.id));
          const isActive   = Object.values(activeMaps).some(id => String(id) === String(m.id));
          const thumb      = `
            <div class="map-card-banner">
              <div class="map-card-banner-fallback">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(191,90,242,0.45)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="12 2 2 7 12 12 22 7 12 2"/>
                  <polyline points="2 17 12 22 22 17"/>
                  <polyline points="2 12 12 17 22 12"/>
                </svg>
              </div>
              ${m.avatarUrl ? `<img src="${escapeHtml(m.avatarUrl)}" alt="${escapeHtml(m.name)}" loading="lazy" decoding="async" style="position:absolute; top:0; left:0; width:100%; height:100%; object-fit:cover;" onerror="this.remove()"/>` : ''}
            </div>
          `;

          const updated = m.updatedAt ? new Date(m.updatedAt).toLocaleDateString('it-IT') : '';

          return `
          <div class="map-card" data-id="${escapeHtml(String(m.id))}"
               style="display:flex; flex-direction:column; background:var(--glass-bg); border:1px solid var(--glass-border); border-radius:8px; overflow:hidden; transition:border-color .2s; position:relative; ${isActive ? 'border-color:var(--accent);' : ''}">
            ${isActive ? `<div style="position:absolute; top:8px; left:8px; background:var(--accent); border-radius:50px; padding:2px 8px; font-size:10px; font-weight:700; z-index:2; color:#fff;">🎮 ATTIVA</div>` : ''}
            ${thumb}

            <!-- Progress bar -->
            <div id="celab-progress-wrap-${m.id}" style="display:none; height:3px; background:rgba(255,255,255,0.06);">
              <div id="celab-progress-${m.id}" style="height:3px; width:0%; background:var(--accent); transition:width .15s;"></div>
            </div>

            <div style="padding:10px 12px; flex:1; display:flex; flex-direction:column; gap:6px;">
              <div style="font-weight:700; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
              <div style="font-size:11px; color:var(--text-muted);">by ${escapeHtml(m.author)}</div>
              ${m.description ? `<div style="font-size:11px; color:rgba(255,255,255,0.5); line-height:1.4; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;">${escapeHtml(m.description)}</div>` : ''}
              ${updated ? `<div style="font-size:10px; color:rgba(255,255,255,0.3); margin-top:auto;">Aggiornata: ${updated}</div>` : ''}
            </div>

            <div style="padding:8px 12px; border-top:1px solid var(--glass-border); display:flex; gap:6px; align-items:center;">
              ${isLocal
                ? `<span style="font-size:11px; color:var(--accent); font-weight:600;">✅ Scaricata</span>
                   <button class="btn btn-ghost btn-sm map-card-launch" data-id="${escapeHtml(String(m.id))}" style="margin-left:auto; font-size:11px; padding:4px 10px;">Installa 🗺️</button>
                   <button class="btn btn-danger-sm map-card-delete" data-id="${escapeHtml(String(m.id))}" style="font-size:11px; padding:4px 8px;">🗑</button>`
                : `<button class="btn btn-primary btn-sm celab-download-btn" id="celab-dl-btn-${m.id}"
                           data-project-id="${m.id}" data-project-name="${escapeHtml(m.name)}"
                           style="font-size:11px; padding:4px 12px; width:100%;">⬇ Scarica</button>`
              }
            </div>
          </div>`;
        }).join('');

        // Attach local map listeners (launch/delete on already-downloaded cards)
        attachMapCardListeners(grid);

        // Attach celab download buttons
        grid.querySelectorAll('.celab-download-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const pid  = parseInt(btn.dataset.projectId, 10);
            const name = btn.dataset.projectName;
            btn.disabled  = true;
            btn.textContent = '⏳ Connessione...';

            // Show progress bar
            const wrap = document.getElementById(`celab-progress-wrap-${pid}`);
            if (wrap) wrap.style.display = 'block';

            const result = await rc.downloadCelabMap(pid, name);
            if (result.ok) {
              toast(`"${name}" scaricata! ✅`, 'success');
              await loadWorkshopMaps();
            } else {
              toast(result.error || 'Download fallito', 'error');
              btn.disabled = false;
              btn.textContent = '⬇ Scarica';
              if (wrap) wrap.style.display = 'none';
            }
          });
        });

      } catch (err) {
        grid.innerHTML = `<div class="empty-state">
          <p style="color:var(--danger)">Errore connessione</p>
          <span>Impossibile raggiungere celab.jetfox.ovh. Controlla la connessione.</span>
          <button class="btn btn-ghost btn-sm" id="btn-workshop-fallback-offline" style="margin-top:12px">Vai alle mappe offline</button>
        </div>`;
        document.getElementById('btn-workshop-fallback-offline')?.addEventListener('click', () => {
          const toggle = document.getElementById('workshop-local-toggle');
          if (toggle) { toggle.checked = true; showDownloadedOnly = true; loadWorkshopMaps(); }
        });
      }
    }
  } catch (e) {
    rc?.logError?.(String(e));
  }
}

function mapCardHtml(m, isLocal, isActive, activeMaps) {
  const imageSrc = m.bannerData || m.bannerUrl || '';
  const downloadsStr = m.downloadCount !== undefined ? `${m.downloadCount.toLocaleString()} downloads` : '';
  
  let activeSlots = [];
  if (activeMaps) {
    activeSlots = Object.keys(MAP_SLOTS).filter(sId => String(activeMaps[sId]) === String(m.id));
  }
  const isCurrentlyActive = activeSlots.length > 0;
  const activeSlotsStr = activeSlots.map(sId => MAP_SLOTS[sId].name).join(', ');

  return `
    <div class="map-card" data-map-id="${escapeHtml(m.id)}" data-map-name="${escapeHtml(m.name)}" data-map-author="${escapeHtml(m.author)}" data-map-banner="${escapeHtml(m.bannerUrl)}">
      <div class="map-card-banner">
        <div class="map-card-banner-fallback">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(191,90,242,0.45)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 2 7 12 12 22 7 12 2"/>
            <polyline points="2 17 12 22 22 17"/>
            <polyline points="2 12 12 17 22 12"/>
          </svg>
        </div>
        ${imageSrc ? `<img src="${imageSrc}" alt="${escapeHtml(m.name)}" style="position:absolute; top:0; left:0; width:100%; height:100%; object-fit:cover;" onerror="this.remove()"/>` : ''}
        ${isCurrentlyActive ? `
          <div class="map-card-active-overlay">
            <span class="active-badge" style="font-size: 10px; padding: 4px 8px; text-transform: uppercase;">Attiva: ${escapeHtml(activeSlotsStr)}</span>
          </div>
        ` : ''}
      </div>
      <div class="map-card-info">
        <div class="map-card-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
        <div class="map-card-author">by ${escapeHtml(m.author || 'Unknown')}</div>
        <div class="map-card-footer">
          <div class="map-downloads">${downloadsStr}</div>
          <div class="map-card-actions">
            ${isLocal ? `
              <button class="btn btn-primary btn-sm btn-map-launch-modal">Carica</button>
              <button class="btn btn-danger btn-sm btn-map-delete">✕</button>
            ` : `
              <button class="btn btn-ghost btn-sm btn-map-download">Download</button>
            `}
          </div>
        </div>
      </div>
    </div>
  `;
}

function attachMapCardListeners(grid) {
  // Launch (Open destination selection modal)
  grid.querySelectorAll('.btn-map-launch-modal').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.map-card');
      const id = card.dataset.mapId;
      const name = card.dataset.mapName;
      
      openSlotModal(id, name);
    });
  });

  // Delete
  grid.querySelectorAll('.btn-map-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.map-card');
      const id = card.dataset.mapId;
      const name = card.dataset.mapName;
      if (confirm(`Vedi che cancelli "${name}". Sicuro?`)) {
        await rc.deleteMap(id);
        toast('Mappa eliminata con successo', 'success');
        await loadWorkshopMaps();
      }
    });
  });

  // Download
  grid.querySelectorAll('.btn-map-download').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.map-card');
      const id = card.dataset.mapId;
      const name = card.dataset.mapName;
      const author = card.dataset.mapAuthor;
      const bannerUrl = card.dataset.mapBanner;

      btn.disabled = true;
      btn.textContent = 'Connecting...';
      toast(`Downloading: ${name}...`, 'success');

      try {
        const details = await rc.getOnlineMapDetails(id);
        if (!details.files || details.files.length === 0) {
          throw new Error('Nessun file scaricabile trovato per questa mappa.');
        }
        
        btn.textContent = 'Downloading...';
        const edgeUrl = details.files[0].edgeUrl;
        
        const res = await rc.installMap(edgeUrl, { id, name, author, bannerUrl });
        if (res.ok) {
          toast(`Mappa installata: ${name}`, 'success');
          await loadWorkshopMaps();
        } else {
          btn.disabled = false;
          btn.textContent = 'Download';
          toast(res.error || 'Download fallito', 'error');
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Download';
        toast(err.message, 'error');
      }
    });
  });
}

async function openSlotModal(mapId, mapName) {
  currentModalMapId = mapId;
  const modal = document.getElementById('slot-modal');
  const container = document.getElementById('slot-options-container');
  if (!modal || !container) return;

  modal.style.display = 'flex';

  try {
    const [activeMaps, localMaps] = await Promise.all([
      rc.getActiveMap(),
      rc.listMaps()
    ]);

    let html = '';
    for (const slotId of Object.keys(MAP_SLOTS)) {
      const slot = MAP_SLOTS[slotId];
      const activeIdInSlot = activeMaps[slotId];
      const activeMapInSlot = activeIdInSlot ? localMaps.find(m => String(m.id) === String(activeIdInSlot)) : null;

      html += `
        <button class="btn btn-ghost btn-slot-select" data-slot="${slotId}" style="display: flex; flex-direction: column; align-items: flex-start; justify-content: center; width: 100%; padding: 12px 16px; border: 1px solid var(--glass-border); border-radius: 8px; text-align: left; background: rgba(255,255,255,0.02); transition: all var(--fast); height: auto;">
          <span style="font-weight: 700; color: var(--accent); font-size: 11px; text-transform: uppercase;">${escapeHtml(slot.name)}</span>
          <span style="font-size: 12.5px; color: rgba(255,255,255,0.6); font-weight: normal; margin-top: 2px;">
            Mappa attiva: <strong style="color: ${activeMapInSlot ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)'};">${activeMapInSlot ? escapeHtml(activeMapInSlot.name) : 'Originale / Default'}</strong>
          </span>
        </button>
      `;
    }

    container.innerHTML = html;

    container.querySelectorAll('.btn-slot-select').forEach(slotBtn => {
      slotBtn.addEventListener('click', async () => {
        const slotId = slotBtn.dataset.slot;
        const slotName = MAP_SLOTS[slotId].name;
        
        slotBtn.disabled = true;
        slotBtn.textContent = 'Caricamento...';
        
        const res = await rc.launchMap(currentModalMapId, slotId);
        if (res.ok) {
          toast(`Mappa caricata con successo in ${slotName}`, 'success');
          closeSlotModal();
          await loadWorkshopMaps();
        } else {
          slotBtn.disabled = false;
          toast(res.error || 'Errore nel caricamento', 'error');
        }
      });
    });

  } catch (err) {
    toast('Error loading slots', 'error');
  }
}

function closeSlotModal() {
  const modal = document.getElementById('slot-modal');
  if (modal) modal.style.display = 'none';
  currentModalMapId = null;
}

async function openMapSelectModal(slotId) {
  const modal = document.getElementById('map-select-modal');
  const container = document.getElementById('map-select-options-container');
  const slotNameEl = document.getElementById('map-select-slot-name');
  if (!modal || !container || !slotNameEl) return;

  const slotName = MAP_SLOTS[slotId]?.name || slotId;
  slotNameEl.textContent = slotName;
  modal.style.display = 'flex';

  try {
    const localMaps = await rc.listMaps();
    if (!localMaps || localMaps.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding:20px 0;">
          <p>No downloaded maps found</p>
          <span style="font-size:12px; color:var(--text-muted);">Download some maps from the online Workshop first!</span>
        </div>`;
      return;
    }

    let html = '';
    for (const map of localMaps) {
      const thumbSrc = map.bannerData || map.bannerUrl || '';
      const thumbHtml = thumbSrc
        ? `<img src="${thumbSrc}" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.remove()"/>`
        : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-size:16px;">🗺️</div>`;

      html += `
        <button class="btn btn-ghost map-select-option-row" data-map-id="${escapeHtml(String(map.id))}" style="display: flex; align-items: center; gap: 12px; width: 100%; padding: 8px 12px; border: 1px solid var(--glass-border); border-radius: 8px; text-align: left; background: rgba(255,255,255,0.02); height: auto; transition: background .15s; margin: 0;">
          <div style="width: 56px; aspect-ratio: 16/9; background: #0c0f16; border-radius: 4px; overflow: hidden; position: relative; flex-shrink: 0; display: flex; align-items: center; justify-content: center;">
            ${thumbHtml}
          </div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 700; font-size: 13px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(map.name)}">${escapeHtml(map.name)}</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">by ${escapeHtml(map.author || 'Unknown')}</div>
          </div>
        </button>
      `;
    }

    container.innerHTML = html;

    container.querySelectorAll('.map-select-option-row').forEach(row => {
      row.addEventListener('click', async () => {
        const mapId = row.dataset.mapId;
        row.disabled = true;
        row.style.opacity = '0.5';

        const res = await rc.launchMap(mapId, slotId);
        if (res.ok) {
          toast(`Map loaded successfully in ${slotName}`, 'success');
          closeMapSelectModal();
          await loadWorkshopMaps();
        } else {
          row.disabled = false;
          row.style.opacity = '1';
          toast(res.error || 'Error loading map', 'error');
        }
      });
    });

  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger)">Error loading maps</p>`;
  }
}

function closeMapSelectModal() {
  const modal = document.getElementById('map-select-modal');
  if (modal) modal.style.display = 'none';
}

function setupWorkshopListeners() {

  // Import (.zip, .udk, .upk)
  document.getElementById('btn-workshop-import')?.addEventListener('click', async () => {
    try {
      const filePath = await rc.selectWorkshopZip();
      if (!filePath) return;
      
      toast('Importing map...', 'success');
      const baseName = filePath.split(/[/\\]/).pop().replace(/\.(zip|udk|upk)$/i, '');
      const mapName = baseName.replace(/[-_]/g, ' ');
      
      const res = await rc.installMap(filePath, {
        name: mapName,
        author: 'Locale',
        description: 'Mappa importata localmente.'
      });
      if (res.ok) {
        toast(`Mappa importata con successo: ${res.map.name}`, 'success');
        await loadWorkshopMaps();
      } else {
        toast(res.error || 'Import failed', 'error');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Restore original
  document.getElementById('btn-workshop-restore')?.addEventListener('click', async () => {
    const res = await rc.restoreOriginalMap();
    if (res.ok) {
      toast('Ripristinata la mappa originale di Rocket League!', 'success');
      await loadWorkshopMaps();
    } else {
      toast(res.error, 'error');
    }
  });

  // Refresh
  document.getElementById('btn-workshop-refresh')?.addEventListener('click', async () => {
    await loadWorkshopMaps();
  });

  // Cancel slot modal
  document.getElementById('btn-slot-cancel')?.addEventListener('click', closeSlotModal);
  document.getElementById('btn-map-select-cancel')?.addEventListener('click', closeMapSelectModal);

  // Search
  const searchInput = document.getElementById('workshop-search-input');
  if (searchInput) {
    searchInput.value = workshopSearch;
    searchInput.addEventListener('input', e => {
      workshopSearch = e.target.value;
      workshopPage = 1;
      clearTimeout(workshopSearchTimeout);
      workshopSearchTimeout = setTimeout(loadWorkshopMaps, 300);
    });
  }

  // Sort Toggle
  const sortBtn = document.getElementById('btn-workshop-sort');
  if (sortBtn) {
    sortBtn.addEventListener('click', () => {
      if (workshopSort === 'downloads') {
        workshopSort = '';
        sortBtn.textContent = 'Latest';
        sortBtn.setAttribute('data-sort', 'latest');
      } else {
        workshopSort = 'downloads';
        sortBtn.textContent = 'Most Downloaded';
        sortBtn.setAttribute('data-sort', 'downloads');
      }
      workshopPage = 1;
      loadWorkshopMaps();
    });
  }

  // Local Toggle
  const localToggle = document.getElementById('workshop-local-toggle');
  if (localToggle) {
    localToggle.checked = showDownloadedOnly;
    localToggle.addEventListener('change', e => {
      showDownloadedOnly = e.target.checked;
      workshopPage = 1;
      loadWorkshopMaps();
    });
  }

  // Pagination Prev / Next — con debounce per evitare click multipli
  let workshopPageTimeout = null;
  function goWorkshopPage(delta) {
    clearTimeout(workshopPageTimeout);
    workshopPage += delta;
    if (workshopPage < 1) workshopPage = 1;
    // Disabilita tutti i bottoni subito
    document.querySelectorAll('.btn-workshop-prev, .btn-workshop-next').forEach(b => b.disabled = true);
    workshopPageTimeout = setTimeout(() => loadWorkshopMaps(), 150);
  }
  document.querySelectorAll('.btn-workshop-prev').forEach(btn => {
    btn.addEventListener('click', () => { if (workshopPage > 1) goWorkshopPage(-1); });
  });
  document.querySelectorAll('.btn-workshop-next').forEach(btn => {
    btn.addEventListener('click', () => goWorkshopPage(1));
  });
}

// ─── BakkesMod Plugins ───────────────────────────────────────────
// Plugin IDs che hanno impostazioni configurabili
const CONFIGURABLE_PLUGINS = ['rocketstats', 'ingamerank'];

async function loadBakkesPlugins() {
  const list = document.getElementById('bakkes-plugins-list');
  if (!list) return;

  try {
    const plugins = await rc.listBakkesPlugins();
    if (!plugins.length) {
      list.innerHTML = `<div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><path d="M28 4v12M20 4v12M8 20h32M16 40h16a6 6 0 006-6V18a6 6 0 00-6-6H16a6 6 0 00-6 6v16a6 6 0 006 6z" stroke="rgba(255,255,255,0.2)" stroke-width="2" stroke-linecap="round"/></svg>
        <p>No BakkesMod plugins installed</p>
        <span>Drag a plugin ZIP file or select a file to install</span>
      </div>`;
      return;
    }

    list.innerHTML = plugins.map(p => {
      const sizeMB = (p.sizeBytes / (1024 * 1024)).toFixed(2);
      const hasSettings = CONFIGURABLE_PLUGINS.includes(p.id.toLowerCase());
      return `
        <div class="plugin-card" data-plugin-id="${escapeHtml(p.id)}">
          <div>
            <div class="plugin-name">${escapeHtml(p.name)}</div>
            <div class="plugin-desc">BakkesMod C++ Plugin (${sizeMB} MB)</div>
            <div class="plugin-version" style="font-family:monospace;color:var(--text-muted)">plugins/${escapeHtml(p.filename)}</div>
          </div>
          <div class="plugin-right">
            ${hasSettings ? `<button class="btn btn-sm btn-settings-plugin" title="Plugin Settings" data-plugin-settings="${escapeHtml(p.id)}" style="padding:6px 10px; background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.12); border-radius:6px; cursor:pointer; color:var(--text-muted); transition:all 0.2s;">⚙️</button>` : ''}
            <button class="btn btn-sm btn-restart-plugin" title="Riavvia plugin" data-plugin-restart="${escapeHtml(p.id)}" style="padding:6px 10px; background:rgba(255,200,0,0.10); border:1px solid rgba(255,200,0,0.20); border-radius:6px; cursor:pointer; color:#f5c400; transition:all 0.2s;">↺</button>
            <div class="toggle${p.enabled ? ' on' : ''}" data-bakkes-toggle="${escapeHtml(p.id)}"></div>
            <button class="btn btn-danger btn-sm btn-bakkes-uninstall">Remove</button>
          </div>
        </div>
      `;
    }).join('');

    // Toggle logic
    list.querySelectorAll('[data-bakkes-toggle]').forEach(el => {
      el.addEventListener('click', async () => {
        const id = el.dataset.bakkesToggle;
        const res = await rc.toggleBakkesPlugin(id);
        if (res.ok) {
          el.classList.toggle('on', res.enabled);
          toast(`Plugin ${id} ${res.enabled ? 'enabled' : 'disabled'}!`, 'success');
        } else {
          toast(res.error, 'error');
        }
      });
    });

    // Uninstall logic
    list.querySelectorAll('.btn-bakkes-uninstall').forEach(btn => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.plugin-card');
        const id = card.dataset.pluginId;
        if (confirm(`Are you sure you want to remove plugin ${id}?`)) {
          const res = await rc.uninstallBakkesPlugin(id);
          if (res.ok) {
            toast(`Plugin rimosso con successo`, 'success');
            await loadBakkesPlugins();
          } else {
            toast(res.error, 'error');
          }
        }
      });
    });

    // Settings button logic
    list.querySelectorAll('.btn-settings-plugin').forEach(btn => {
      btn.addEventListener('click', () => {
        openPluginSettings(btn.dataset.pluginSettings);
      });
      btn.addEventListener('mouseenter', () => {
        btn.style.background = 'rgba(255,255,255,0.13)';
        btn.style.color = '#fff';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'rgba(255,255,255,0.07)';
        btn.style.color = 'var(--text-muted)';
      });
    });

    // Restart button logic
    list.querySelectorAll('.btn-restart-plugin').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.pluginRestart;
        btn.disabled = true;
        btn.textContent = '...';
        try {
          // Disable
          await rc.toggleBakkesPlugin(id);
          await new Promise(r => setTimeout(r, 600));
          // Re-enable
          await rc.toggleBakkesPlugin(id);
          toast(`Plugin ${id} riavviato!`, 'success');
          await loadBakkesPlugins();
        } catch (e) {
          toast('Error restarting plugin', 'error');
          btn.disabled = false;
          btn.textContent = '↺';
        }
      });
      btn.addEventListener('mouseenter', () => {
        btn.style.background = 'rgba(255,200,0,0.22)';
        btn.style.color = '#ffe066';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'rgba(255,200,0,0.10)';
        btn.style.color = '#f5c400';
      });
    });

  } catch (err) {
    rc?.logError?.(String(err));
  }
}

// ─── Plugin Settings Modal ───────────────────────────────────────
async function openPluginSettings(pluginId) {
  const modal = document.getElementById('plugin-settings-modal');
  const title = document.getElementById('plugin-settings-modal-title');
  const subtitle = document.getElementById('plugin-settings-modal-subtitle');
  const rsSection = document.getElementById('plugin-settings-rocketstats');
  const igrSection = document.getElementById('plugin-settings-ingamerank');
  const themeGrid = document.getElementById('theme-grid');

  if (!modal) return;

  // Reset
  rsSection.style.display = 'none';
  if (igrSection) igrSection.style.display = 'none';
  themeGrid.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Loading themes...</div>';

  title.textContent = `${pluginId} — Settings`;
  subtitle.textContent = 'Configure plugin options';
  modal.style.display = 'flex';

  if (pluginId.toLowerCase() === 'rocketstats') {
    rsSection.style.display = 'block';
    subtitle.textContent = 'Seleziona il tema dell\'overlay RocketStats';
    if (window.rc && window.rc.forceShowOverlay) window.rc.forceShowOverlay();

    const res = await rc.getBakkesPluginSettings('rocketstats');
    if (!res.ok) {
      themeGrid.innerHTML = `<p style="color:#f87171;">${res.error}</p>`;
      return;
    }

    // Configura il selettore playlist dell'overlay
    const plSelect = document.getElementById('rocketstats-playlist-select');
    if (plSelect) {
      plSelect.value = res.playlist || '2v2';
      plSelect.onchange = async (e) => {
        await rc.setBakkesPluginSettings('rocketstats', { playlist: e.target.value });
      };
    }

    // Configura il checkbox mostra guadagno MMR
    const deltaCheckbox = document.getElementById('rocketstats-delta-checkbox');
    if (deltaCheckbox) {
      deltaCheckbox.checked = res.showMmrDelta !== false;
      deltaCheckbox.onchange = async (e) => {
        await rc.setBakkesPluginSettings('rocketstats', { showMmrDelta: e.target.checked });
      };
    }


    // Configura lo slider della scala dell'interfaccia Rocket League
    const uiScaleSlider = document.getElementById('rocketstats-uiscale-slider');
    const uiScaleInput = document.getElementById('rocketstats-uiscale-input');
    if (uiScaleSlider && uiScaleInput) {
      const uiScalePercent = res.uiScalePercent !== undefined ? res.uiScalePercent : 100;
      uiScaleSlider.value = uiScalePercent;
      uiScaleInput.value = uiScalePercent;

      const getBaseX = (p) => Math.round(-0.1 * p + 38);
      const getBaseY = (p) => Math.round(0.1 * p + 69);

      // Expose current baseline offsets
      window._rsBaseX = getBaseX(uiScalePercent);
      window._rsBaseY = getBaseY(uiScalePercent);

      const updateAllFromUiScale = async (percentVal) => {
        const factor = percentVal / 100;
        const scaleMultiplier = parseFloat((0.70 * (percentVal / 90)).toFixed(2));
        const actualOffsetX = getBaseX(percentVal);
        const actualOffsetY = getBaseY(percentVal);

        // Update exposed base offsets
        window._rsBaseX = actualOffsetX;
        window._rsBaseY = actualOffsetY;

        // Reset displayed offsets to 0 on UI scale change
        const displayX = 0;
        const displayY = 0;

        const xSlider = document.getElementById('rocketstats-x-slider');
        const xInput = document.getElementById('rocketstats-x-input');
        if (xSlider && xInput) {
          xSlider.value = displayX;
          xInput.value = displayX;
        }
        const ySlider = document.getElementById('rocketstats-y-slider');
        const yInput = document.getElementById('rocketstats-y-input');
        if (ySlider && yInput) {
          ySlider.value = displayY;
          yInput.value = displayY;
        }

        // Salva i valori REALI
        await rc.setBakkesPluginSettings('rocketstats', {
          uiScalePercent: percentVal,
          scaleMultiplier: scaleMultiplier,
          offsetX: actualOffsetX,
          offsetY: actualOffsetY
        });
      };

      uiScaleSlider.oninput = (e) => {
        uiScaleInput.value = parseInt(e.target.value);
      };

      uiScaleSlider.onchange = async (e) => {
        const val = parseInt(e.target.value);
        await updateAllFromUiScale(val);
      };

      uiScaleInput.oninput = async (e) => {
        let val = parseInt(e.target.value);
        if (isNaN(val)) return;
        if (val < 50) val = 50;
        if (val > 100) val = 100;
        uiScaleSlider.value = val;
        await updateAllFromUiScale(val);
      };
    }


    // Configura lo slider di scaling
    const slider = document.getElementById('rocketstats-scale-slider');
    const scaleInput = document.getElementById('rocketstats-scale-input');
    if (slider && scaleInput) {
      const scaleMultiplier = res.scaleMultiplier !== undefined ? res.scaleMultiplier : 1.0;
      slider.value = scaleMultiplier;
      scaleInput.value = parseFloat(scaleMultiplier).toFixed(2);

      // Evento input: aggiorna l'input di testo per massima reattività
      slider.oninput = (e) => {
        scaleInput.value = parseFloat(e.target.value).toFixed(2);
      };

      // Evento change: salva nelle impostazioni e rinfresca la finestra solo quando l'utente rilascia il mouse
      slider.onchange = async (e) => {
        const val = parseFloat(e.target.value);
        await rc.setBakkesPluginSettings('rocketstats', { scaleMultiplier: val });
      };

      // Evento input dell'input di testo: aggiorna il range slider e salva
      scaleInput.oninput = async (e) => {
        let val = parseFloat(e.target.value);
        if (isNaN(val)) return;
        if (val < 0.5) val = 0.5;
        if (val > 3.0) val = 3.0;
        slider.value = val;
        await rc.setBakkesPluginSettings('rocketstats', { scaleMultiplier: val });
      };
    }

    // Configura lo slider dell'offset X (spostamento orizzontale)
    // Mostra valore RELATIVO: 0 = posizione base
    const xSlider = document.getElementById('rocketstats-x-slider');
    const xInput = document.getElementById('rocketstats-x-input');
    if (xSlider && xInput) {
      const BASE_X = window._rsBaseX !== undefined ? window._rsBaseX : 30;
      const rawX = res.offsetX !== undefined ? res.offsetX : BASE_X;
      const displayX = rawX - BASE_X;
      xSlider.value = displayX;
      xInput.value = displayX;

      xSlider.oninput = async (e) => {
        const display = parseInt(e.target.value);
        xInput.value = display;
        const currentBaseX = window._rsBaseX !== undefined ? window._rsBaseX : 30;
        await rc.setBakkesPluginSettings('rocketstats', { offsetX: display + currentBaseX });
      };

      xInput.oninput = async (e) => {
        let display = parseInt(e.target.value);
        if (isNaN(display)) return;
        if (display < -2000) display = -2000;
        if (display > 2000) display = 2000;
        xSlider.value = display;
        const currentBaseX = window._rsBaseX !== undefined ? window._rsBaseX : 30;
        await rc.setBakkesPluginSettings('rocketstats', { offsetX: display + currentBaseX });
      };
    }

    // Configura lo slider dell'offset Y (spostamento verticale)
    // Mostra valore RELATIVO: 0 = posizione base
    const ySlider = document.getElementById('rocketstats-y-slider');
    const yInput = document.getElementById('rocketstats-y-input');
    if (ySlider && yInput) {
      const BASE_Y = window._rsBaseY !== undefined ? window._rsBaseY : 87;
      const rawY = res.offsetY !== undefined ? res.offsetY : BASE_Y;
      const displayY = rawY - BASE_Y;
      ySlider.value = displayY;
      yInput.value = displayY;

      ySlider.oninput = async (e) => {
        const display = parseInt(e.target.value);
        yInput.value = display;
        const currentBaseY = window._rsBaseY !== undefined ? window._rsBaseY : 87;
        await rc.setBakkesPluginSettings('rocketstats', { offsetY: display + currentBaseY });
      };

      yInput.oninput = async (e) => {
        let display = parseInt(e.target.value);
        if (isNaN(display)) return;
        if (display < -2000) display = -2000;
        if (display > 2000) display = 2000;
        ySlider.value = display;
        const currentBaseY = window._rsBaseY !== undefined ? window._rsBaseY : 87;
        await rc.setBakkesPluginSettings('rocketstats', { offsetY: display + currentBaseY });
      };
    }

    themeGrid.innerHTML = res.themes.map(t => `
      <div class="theme-card ${t.id === res.activeTheme ? 'theme-card--active' : ''}"
           data-theme-id="${escapeHtml(t.id)}"
           style="
             border-radius: 10px;
             border: 2px solid ${t.id === res.activeTheme ? 'var(--accent)' : 'rgba(255,255,255,0.1)'};
             background: ${t.id === res.activeTheme ? 'rgba(var(--accent-rgb, 59,130,246),0.12)' : 'rgba(255,255,255,0.04)'};
             cursor: pointer;
             overflow: hidden;
             transition: all 0.2s;
             position: relative;
           ">
        ${t.screenshotPath
          ? `<img src="file://${t.screenshotPath.replace(/\\/g, '/')}" alt="${escapeHtml(t.name)}" style="width:100%; aspect-ratio:16/10; object-fit:cover; display:block;" onerror="this.style.display='none'">`
          : `<div style="width:100%; aspect-ratio:16/10; background:rgba(255,255,255,0.05); display:flex; align-items:center; justify-content:center; font-size:28px;">🎨</div>`
        }
        <div style="padding:10px 12px;">
          <div style="font-weight:600; font-size:13px; color:${t.id === res.activeTheme ? 'var(--accent)' : '#fff'};">${escapeHtml(t.name)}</div>
          ${t.author ? `<div style="font-size:11px; color:var(--text-muted); margin-top:2px;">by ${escapeHtml(t.author)}</div>` : ''}
          ${t.version ? `<div style="font-size:10px; color:rgba(255,255,255,0.3); margin-top:1px;">${escapeHtml(t.version)}</div>` : ''}
        </div>
        ${t.id === res.activeTheme ? `<div class="theme-badge-active" style="position:absolute; top:8px; right:8px; background:var(--accent); border-radius:50px; padding:2px 8px; font-size:10px; font-weight:700; color:#fff;">ATTIVO</div>` : ''}
      </div>
    `).join('');

    // Selezione tema
    themeGrid.querySelectorAll('.theme-card').forEach(card => {
      card.addEventListener('mouseenter', () => {
        if (!card.classList.contains('theme-card--active')) {
          card.style.border = '2px solid rgba(255,255,255,0.25)';
          card.style.background = 'rgba(255,255,255,0.08)';
        }
      });
      card.addEventListener('mouseleave', () => {
        if (!card.classList.contains('theme-card--active')) {
          card.style.border = '2px solid rgba(255,255,255,0.1)';
          card.style.background = 'rgba(255,255,255,0.04)';
        }
      });
      card.addEventListener('click', async () => {
        const themeId = card.dataset.themeId;
        const res2 = await rc.setBakkesPluginSettings('rocketstats', { theme: themeId });
        if (res2.ok) {
          toast(`Tema "${themeId}" applicato!`, 'success');
          // Aggiorna visivamente senza chiudere il modal
          themeGrid.querySelectorAll('.theme-card').forEach(c => {
            const isActive = c.dataset.themeId === themeId;
            c.classList.toggle('theme-card--active', isActive);
            c.style.border = isActive ? '2px solid var(--accent)' : '2px solid rgba(255,255,255,0.1)';
            c.style.background = isActive ? 'rgba(59,130,246,0.12)' : 'rgba(255,255,255,0.04)';
            const nameEl = c.querySelector('div[style*="font-weight:600"]');
            if (nameEl) nameEl.style.color = isActive ? 'var(--accent)' : '#fff';
            // Rimuove il badge dai non-attivi, aggiunge all'attivo
            const existingBadge = c.querySelector('.theme-badge-active');
            if (existingBadge && !isActive) existingBadge.remove();
            if (isActive && !c.querySelector('.theme-badge-active')) {
              const badge2 = document.createElement('div');
              badge2.className = 'theme-badge-active';
              badge2.style.cssText = 'position:absolute; top:8px; right:8px; background:var(--accent); border-radius:50px; padding:2px 8px; font-size:10px; font-weight:700; color:#fff;';
              badge2.textContent = 'ATTIVO';
              c.appendChild(badge2);
            }
          });
        } else {
          toast(res2.error || 'Errore applicazione tema', 'error');
        }
      });
    });
  }

  if (pluginId.toLowerCase() === 'ingamerank') {
    if (igrSection) igrSection.style.display = 'block';
    subtitle.textContent = "Configure IngameRank overlay parameters";
    themeGrid.innerHTML = '';

    rc.forceShowRoster();

    const res = await rc.getBakkesPluginSettings('ingamerank');
    if (!res.ok) {
      themeGrid.innerHTML = `<p style="color:#f87171; padding: 10px;">${res.error}</p>`;
      return;
    }

    const getTriggerLabel = (type, index) => {
      if (!type) return 'No custom input';
      if (type === 'keyboard') {
        const VK_MAP = {
          9: 'Tab', 13: 'Invio', 16: 'Shift', 17: 'Ctrl', 18: 'Alt', 20: 'CapsLock', 27: 'Escape', 32: 'Spazio',
          112: 'F1', 113: 'F2', 114: 'F3', 115: 'F4', 116: 'F5', 117: 'F6', 118: 'F7', 119: 'F8', 120: 'F9', 121: 'F10', 122: 'F11', 123: 'F12'
        };
        return VK_MAP[index] || `Tastiera (VK ${index})`;
      }
      if (type === 'controller_xinput') {
        const XINPUT_MAP = {
          0x0001: 'D-Pad Su', 0x0002: 'D-Pad Giù', 0x0004: 'D-Pad Sinistra', 0x0008: 'D-Pad Destra',
          0x0010: 'Start / Menu', 0x0020: 'Back / Select', 0x0040: 'L3 (Stick SX)', 0x0080: 'R3 (Stick DX)',
          0x0100: 'LB', 0x0200: 'RB', 0x1000: 'A', 0x2000: 'B', 0x4000: 'X', 0x8000: 'Y'
        };
        return XINPUT_MAP[index] || `Controller XInput (Mask ${index})`;
      }
      if (type === 'controller_raw') {
        return `Pulsante Raw Controller: ${index}`;
      }
      return 'No custom input';
    };

    const customLabel = document.getElementById('ingamerank-custom-input-label');
    const recordBtn = document.getElementById('ingamerank-btn-record-input');
    const clearBtn = document.getElementById('ingamerank-btn-clear-input');

    const updateLabel = (type, index) => {
      if (customLabel) {
        customLabel.textContent = getTriggerLabel(type, index);
      }
    };

    updateLabel(res.triggerType, res.triggerIndex);

    let isRecording = false;

    if (recordBtn) {
      recordBtn.onclick = async () => {
        if (isRecording) {
          isRecording = false;
          recordBtn.textContent = 'Registra';
          await rc.recordInputStop();
          return;
        }

        isRecording = true;
        recordBtn.textContent = 'Ferma';
        if (customLabel) {
          customLabel.textContent = 'In ascolto... Premi un tasto';
        }

        const recordRes = await rc.recordInputStart();
        isRecording = false;
        recordBtn.textContent = 'Registra';

        if (recordRes && (recordRes.type === 'keyboard' || recordRes.type === 'controller_xinput' || recordRes.type === 'controller_raw')) {
          await rc.setBakkesPluginSettings('ingamerank', {
            triggerType: recordRes.type,
            triggerIndex: recordRes.index
          });
          updateLabel(recordRes.type, recordRes.index);
          toast('Custom input registered successfully!', 'success');
        } else if (recordRes && recordRes.type === 'timeout') {
          updateLabel(res.triggerType, res.triggerIndex);
          toast('Timed out. No key pressed.', 'warning');
        } else if (recordRes && recordRes.type === 'cancelled') {
          updateLabel(res.triggerType, res.triggerIndex);
        } else if (recordRes && recordRes.type === 'error') {
          updateLabel(res.triggerType, res.triggerIndex);
          toast(`Recording error: ${recordRes.error}`, 'error');
        }
      };
    }

    if (clearBtn) {
      clearBtn.onclick = async () => {
        await rc.setBakkesPluginSettings('ingamerank', {
          triggerType: null,
          triggerIndex: null
        });
        updateLabel(null, null);
        toast('Custom input removed.', 'info');
      };
    }

    const enabledChk = document.getElementById('ingamerank-enabled-checkbox');
    if (enabledChk) {
      enabledChk.checked = res.enabled ?? true;
      enabledChk.onchange = async (e) => {
        await rc.setBakkesPluginSettings('ingamerank', { enabled: e.target.checked });
      };
    }

    const holdChk = document.getElementById('ingamerank-hold-checkbox');
    if (holdChk) {
      holdChk.checked = res.holdToShow ?? true;
      holdChk.onchange = async (e) => {
        await rc.setBakkesPluginSettings('ingamerank', { holdToShow: e.target.checked });
      };
    }

    const hotkeySel = document.getElementById('ingamerank-hotkey-select');
    if (hotkeySel) {
      hotkeySel.value = res.hotkey || 'Tab';
      hotkeySel.onchange = async (e) => {
        await rc.setBakkesPluginSettings('ingamerank', { hotkey: e.target.value });
      };
    }

    const controllerSel = document.getElementById('ingamerank-controller-select');
    if (controllerSel) {
      controllerSel.value = res.controllerButton !== undefined ? String(res.controllerButton) : '32';
      controllerSel.onchange = async (e) => {
        await rc.setBakkesPluginSettings('ingamerank', { controllerButton: parseInt(e.target.value, 10) });
      };
    }

    const playlistSel = document.getElementById('ingamerank-playlist-select');
    if (playlistSel) {
      playlistSel.value = res.playlist || 'current';
      playlistSel.onchange = async (e) => {
        await rc.setBakkesPluginSettings('ingamerank', { playlist: e.target.value });
      };
    }

    const divisionChk = document.getElementById('ingamerank-division-checkbox');
    if (divisionChk) {
      divisionChk.checked = res.showDivision ?? true;
      divisionChk.onchange = async (e) => {
        await rc.setBakkesPluginSettings('ingamerank', { showDivision: e.target.checked });
      };
    }

    const showPlChk = document.getElementById('ingamerank-showplaylist-checkbox');
    if (showPlChk) {
      showPlChk.checked = res.showPlaylist ?? true;
      showPlChk.onchange = async (e) => {
        await rc.setBakkesPluginSettings('ingamerank', { showPlaylist: e.target.checked });
      };
    }

    const unrankedChk = document.getElementById('ingamerank-unranked-checkbox');
    if (unrankedChk) {
      unrankedChk.checked = res.calculateUnranked ?? true;
      unrankedChk.onchange = async (e) => {
        await rc.setBakkesPluginSettings('ingamerank', { calculateUnranked: e.target.checked });
      };
    }

    const extramodesChk = document.getElementById('ingamerank-extramodes-checkbox');
    if (extramodesChk) {
      extramodesChk.checked = res.includeExtramodes ?? true;
      extramodesChk.onchange = async (e) => {
        await rc.setBakkesPluginSettings('ingamerank', { includeExtramodes: e.target.checked });
      };
    }



    const getCalibratedDefault = (scalePercent, key) => {
      // All offsets are constant across scales (verified at 90% and 100%)
      if (key === 'offsetX') return -80;
      if (key === 'offsetYBlue') return -2;
      if (key === 'offsetYOrange') return 3;
      return 0;
    };

    let currentScalePercent = res.uiScalePercent !== undefined ? res.uiScalePercent : 100;

    const uiScaleSlider = document.getElementById('ingamerank-uiscale-slider');
    const uiScaleInput = document.getElementById('ingamerank-uiscale-input');
    
    const xSlider = document.getElementById('ingamerank-x-slider');
    const xInput = document.getElementById('ingamerank-x-input');
    const ySlider = document.getElementById('ingamerank-y-slider');
    const yInput = document.getElementById('ingamerank-y-input');
    
    const xbSlider = document.getElementById('ingamerank-x-blue-slider');
    const xbInput = document.getElementById('ingamerank-x-blue-input');
    const ybSlider = document.getElementById('ingamerank-y-blue-slider');
    const ybInput = document.getElementById('ingamerank-y-blue-input');
    
    const xoSlider = document.getElementById('ingamerank-x-orange-slider');
    const xoInput = document.getElementById('ingamerank-x-orange-input');
    const yoSlider = document.getElementById('ingamerank-y-orange-slider');
    const yoInput = document.getElementById('ingamerank-y-orange-input');

    if (uiScaleSlider && uiScaleInput) {
      uiScaleSlider.value = currentScalePercent;
      uiScaleInput.value = currentScalePercent;

      const BASE_SCALE = 1.00;

      const updateAllFromUiScale = async (percentVal) => {
        currentScalePercent = percentVal;
        const factor = percentVal / 100;
        const scaleMultiplier = parseFloat((BASE_SCALE * factor).toFixed(2));
        
        const x_ui = xSlider ? parseInt(xSlider.value, 10) : 0;
        const y_ui = ySlider ? parseInt(ySlider.value, 10) : 0;
        const xb_ui = xbSlider ? parseInt(xbSlider.value, 10) : 0;
        const yb_ui = ybSlider ? parseInt(ybSlider.value, 10) : 0;
        const xo_ui = xoSlider ? parseInt(xoSlider.value, 10) : 0;
        const yo_ui = yoSlider ? parseInt(yoSlider.value, 10) : 0;

        await rc.setBakkesPluginSettings('ingamerank', {
          uiScalePercent: percentVal,
          scaleMultiplier: scaleMultiplier,
          offsetX: x_ui + getCalibratedDefault(percentVal, 'offsetX'),
          offsetY: y_ui + getCalibratedDefault(percentVal, 'offsetY'),
          offsetXBlue: xb_ui + getCalibratedDefault(percentVal, 'offsetXBlue'),
          offsetYBlue: yb_ui + getCalibratedDefault(percentVal, 'offsetYBlue'),
          offsetXOrange: xo_ui + getCalibratedDefault(percentVal, 'offsetXOrange'),
          offsetYOrange: yo_ui + getCalibratedDefault(percentVal, 'offsetYOrange')
        });
      };

      uiScaleSlider.oninput = (e) => {
        uiScaleInput.value = parseInt(e.target.value);
      };

      uiScaleSlider.onchange = async (e) => {
        const val = parseInt(e.target.value);
        await updateAllFromUiScale(val);
      };

      uiScaleInput.oninput = async (e) => {
        let val = parseInt(e.target.value);
        if (isNaN(val)) return;
        if (val < 50) val = 50;
        if (val > 100) val = 100;
        uiScaleSlider.value = val;
        await updateAllFromUiScale(val);
      };
    }

    // X Offset
    if (xSlider && xInput) {
      const displayX = res.offsetX !== undefined ? (res.offsetX - getCalibratedDefault(currentScalePercent, 'offsetX')) : 0;
      xSlider.value = displayX;
      xInput.value = displayX;
      
      xSlider.oninput = async (e) => {
        const display = parseInt(e.target.value, 10);
        xInput.value = display;
        const internalVal = display + getCalibratedDefault(currentScalePercent, 'offsetX');
        await rc.setBakkesPluginSettings('ingamerank', { offsetX: internalVal });
      };
      
      xInput.oninput = async (e) => {
        let display = parseInt(e.target.value, 10);
        if (isNaN(display)) return;
        if (display < -2000) display = -2000;
        if (display > 2000) display = 2000;
        xSlider.value = display;
        const internalVal = display + getCalibratedDefault(currentScalePercent, 'offsetX');
        await rc.setBakkesPluginSettings('ingamerank', { offsetX: internalVal });
      };
    }

    // Y Offset
    if (ySlider && yInput) {
      const displayY = res.offsetY !== undefined ? (res.offsetY - getCalibratedDefault(currentScalePercent, 'offsetY')) : 0;
      ySlider.value = displayY;
      yInput.value = displayY;
      
      ySlider.oninput = async (e) => {
        const display = parseInt(e.target.value, 10);
        yInput.value = display;
        const internalVal = display + getCalibratedDefault(currentScalePercent, 'offsetY');
        await rc.setBakkesPluginSettings('ingamerank', { offsetY: internalVal });
      };
      
      yInput.oninput = async (e) => {
        let display = parseInt(e.target.value, 10);
        if (isNaN(display)) return;
        if (display < -2000) display = -2000;
        if (display > 2000) display = 2000;
        ySlider.value = display;
        const internalVal = display + getCalibratedDefault(currentScalePercent, 'offsetY');
        await rc.setBakkesPluginSettings('ingamerank', { offsetY: internalVal });
      };
    }

    // Blue X Offset
    if (xbSlider && xbInput) {
      const displayX = res.offsetXBlue !== undefined ? (res.offsetXBlue - getCalibratedDefault(currentScalePercent, 'offsetXBlue')) : 0;
      xbSlider.value = displayX;
      xbInput.value = displayX;
      
      xbSlider.oninput = async (e) => {
        const display = parseInt(e.target.value, 10);
        xbInput.value = display;
        const internalVal = display + getCalibratedDefault(currentScalePercent, 'offsetXBlue');
        await rc.setBakkesPluginSettings('ingamerank', { offsetXBlue: internalVal });
      };
      
      xbInput.oninput = async (e) => {
        let display = parseInt(e.target.value, 10);
        if (isNaN(display)) return;
        if (display < -2000) display = -2000;
        if (display > 2000) display = 2000;
        xbSlider.value = display;
        const internalVal = display + getCalibratedDefault(currentScalePercent, 'offsetXBlue');
        await rc.setBakkesPluginSettings('ingamerank', { offsetXBlue: internalVal });
      };
    }

    // Blue Y Offset
    if (ybSlider && ybInput) {
      const displayY = res.offsetYBlue !== undefined ? (res.offsetYBlue - getCalibratedDefault(currentScalePercent, 'offsetYBlue')) : 0;
      ybSlider.value = displayY;
      ybInput.value = displayY;
      
      ybSlider.oninput = async (e) => {
        const display = parseInt(e.target.value, 10);
        ybInput.value = display;
        const internalVal = display + getCalibratedDefault(currentScalePercent, 'offsetYBlue');
        await rc.setBakkesPluginSettings('ingamerank', { offsetYBlue: internalVal });
      };
      
      ybInput.oninput = async (e) => {
        let display = parseInt(e.target.value, 10);
        if (isNaN(display)) return;
        if (display < -2000) display = -2000;
        if (display > 2000) display = 2000;
        ybSlider.value = display;
        const internalVal = display + getCalibratedDefault(currentScalePercent, 'offsetYBlue');
        await rc.setBakkesPluginSettings('ingamerank', { offsetYBlue: internalVal });
      };
    }

    // Orange X Offset
    if (xoSlider && xoInput) {
      const displayX = res.offsetXOrange !== undefined ? (res.offsetXOrange - getCalibratedDefault(currentScalePercent, 'offsetXOrange')) : 0;
      xoSlider.value = displayX;
      xoInput.value = displayX;
      
      xoSlider.oninput = async (e) => {
        const display = parseInt(e.target.value, 10);
        xoInput.value = display;
        const internalVal = display + getCalibratedDefault(currentScalePercent, 'offsetXOrange');
        await rc.setBakkesPluginSettings('ingamerank', { offsetXOrange: internalVal });
      };
      
      xoInput.oninput = async (e) => {
        let display = parseInt(e.target.value, 10);
        if (isNaN(display)) return;
        if (display < -2000) display = -2000;
        if (display > 2000) display = 2000;
        xoSlider.value = display;
        const internalVal = display + getCalibratedDefault(currentScalePercent, 'offsetXOrange');
        await rc.setBakkesPluginSettings('ingamerank', { offsetXOrange: internalVal });
      };
    }

    // Orange Y Offset
    if (yoSlider && yoInput) {
      const displayY = res.offsetYOrange !== undefined ? (res.offsetYOrange - getCalibratedDefault(currentScalePercent, 'offsetYOrange')) : 0;
      yoSlider.value = displayY;
      yoInput.value = displayY;
      
      yoSlider.oninput = async (e) => {
        const display = parseInt(e.target.value, 10);
        yoInput.value = display;
        const internalVal = display + getCalibratedDefault(currentScalePercent, 'offsetYOrange');
        await rc.setBakkesPluginSettings('ingamerank', { offsetYOrange: internalVal });
      };
      
      yoInput.oninput = async (e) => {
        let display = parseInt(e.target.value, 10);
        if (isNaN(display)) return;
        if (display < -2000) display = -2000;
        if (display > 2000) display = 2000;
        yoSlider.value = display;
        const internalVal = display + getCalibratedDefault(currentScalePercent, 'offsetYOrange');
        await rc.setBakkesPluginSettings('ingamerank', { offsetYOrange: internalVal });
      };
    }
  }
}

function setupPluginSettingsModal() {
  const closeBtn = document.getElementById('btn-plugin-settings-close');
  const modal = document.getElementById('plugin-settings-modal');
  if (closeBtn) closeBtn.addEventListener('click', () => { 
    modal.style.display = 'none'; 
    if (window.rc && window.rc.forceHideRoster) window.rc.forceHideRoster();
    if (window.rc && window.rc.forceHideOverlay) window.rc.forceHideOverlay();
  });
  if (modal) modal.addEventListener('click', (e) => { 
    if (e.target === modal) {
      modal.style.display = 'none'; 
      if (window.rc && window.rc.forceHideRoster) window.rc.forceHideRoster();
      if (window.rc && window.rc.forceHideOverlay) window.rc.forceHideOverlay();
    }
  });

  // Reset Stats button
  const resetBtn = document.getElementById('btn-rocketstats-reset-stats');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      resetBtn.disabled = true;
      resetBtn.textContent = '⏳ Resetting...';
      try {
        const res = await rc.resetRocketStats();
        if (res.ok) {
          toast('Stats reset! ✅ BakkesMod will run rs_reset_stats on next update.', 'success');
        } else {
          toast(res.error || 'Error resetting stats', 'error');
        }
      } catch (e) {
        toast('Error: ' + e.message, 'error');
      } finally {
        resetBtn.disabled = false;
        resetBtn.innerHTML = '🗑️ Reset Stats';
      }
    });
  }
}



function setupPluginsListeners() {
  const btnRc = document.getElementById('btn-subnav-rc');
  const btnBm = document.getElementById('btn-subnav-bm');
  const secRc = document.getElementById('section-plugins-rc');
  const secBm = document.getElementById('section-plugins-bm');

  if (btnRc && btnBm && secRc && secBm) {
    btnRc.addEventListener('click', () => {
      btnRc.classList.add('active');
      btnBm.classList.remove('active');
      secRc.style.display = 'block';
      secBm.style.display = 'none';
      currentPluginsTab = 'rc';
      loadPlugins();
    });

    btnBm.addEventListener('click', () => {
      btnBm.classList.add('active');
      btnRc.classList.remove('active');
      secBm.style.display = 'block';
      secRc.style.display = 'none';
      currentPluginsTab = 'bm';
      loadBakkesPlugins();
    });
  }

  // Install button
  const installBtn = document.getElementById('btn-install-bakkes-plugin');
  const pathInput = document.getElementById('bakkes-plugin-path-input');

  if (installBtn && pathInput) {
    installBtn.addEventListener('click', async () => {
      const val = pathInput.value.trim();
      if (!val) return toast('Specifica il percorso di un file ZIP', 'warning');
      toast('Installing...', 'success');
      const res = await rc.installBakkesPlugin(val);
      if (res.ok) {
        toast(`Plugin ${res.id} installato con successo!`, 'success');
        pathInput.value = '';
        await loadBakkesPlugins();
      } else {
        toast(res.error, 'error');
      }
    });
  }


  // Drag-and-drop to BakkesMod section
  if (secBm) {
    secBm.addEventListener('dragover', e => { e.preventDefault(); secBm.classList.add('drag-over'); });
    secBm.addEventListener('dragleave', () => secBm.classList.remove('drag-over'));
    secBm.addEventListener('drop', e => {
      e.preventDefault();
      secBm.classList.remove('drag-over');
      if (e.dataTransfer.files.length) {
        const file = e.dataTransfer.files[0];
        if (file.name.toLowerCase().endsWith('.zip')) {
          pathInput.value = file.path;
          toast(`File trascinato: ${file.name}. Clicca su installa!`, 'success');
        } else {
          toast('Trascina solo file ZIP di BakkesMod', 'warning');
        }
      }
    });
  }

  // ── Global UI Scale slider ──────────────────────────────────────
  const globalSlider = document.getElementById('global-uiscale-slider');
  const globalInput  = document.getElementById('global-uiscale-input');

  async function applyGlobalScale(percent) {
    const val = Math.max(50, Math.min(100, parseInt(percent, 10) || 100));
    if (globalSlider) globalSlider.value = val;
    if (globalInput)  globalInput.value  = val;

    // 1. Aggiorna RocketStats
    try {
      const getBaseX = (p) => Math.round(-0.1 * p + 38);
      const getBaseY = (p) => Math.round(0.1 * p + 69);
      const rsScaleMultiplier = parseFloat((0.70 * (val / 90)).toFixed(2));
      const rsOffsetX = getBaseX(val);
      const rsOffsetY = getBaseY(val);

      window._rsBaseX = rsOffsetX;
      window._rsBaseY = rsOffsetY;

      const rsXSlider = document.getElementById('rocketstats-x-slider');
      const rsXInput = document.getElementById('rocketstats-x-input');
      if (rsXSlider && rsXInput) {
        rsXSlider.value = 0;
        rsXInput.value = 0;
      }
      const rsYSlider = document.getElementById('rocketstats-y-slider');
      const rsYInput = document.getElementById('rocketstats-y-input');
      if (rsYSlider && rsYInput) {
        rsYSlider.value = 0;
        rsYInput.value = 0;
      }
      const rsUiSlider = document.getElementById('rocketstats-uiscale-slider');
      const rsUiInput = document.getElementById('rocketstats-uiscale-input');
      if (rsUiSlider) rsUiSlider.value = val;
      if (rsUiInput) rsUiInput.value = val;

      await rc.setBakkesPluginSettings('rocketstats', {
        uiScalePercent: val,
        scaleMultiplier: rsScaleMultiplier,
        offsetX: rsOffsetX,
        offsetY: rsOffsetY
      });
    } catch (e) {
      console.error('Errore global scale rocketstats:', e);
    }

    // 2. Aggiorna IngameRank
    try {
      const getCalibratedDefault = (scalePercent, key) => {
        // All offsets are constant across scales (verified at 90% and 100%)
        if (key === 'offsetX') return -80;
        if (key === 'offsetYBlue') return -2;
        if (key === 'offsetYOrange') return 3;
        return 0;
      };

      const res = await rc.getBakkesPluginSettings('ingamerank');
      const prevScale = (res && res.uiScalePercent !== undefined) ? res.uiScalePercent : 100;
      
      const prevOffsetX = res.offsetX !== undefined ? res.offsetX : getCalibratedDefault(prevScale, 'offsetX');
      const prevOffsetY = res.offsetY !== undefined ? res.offsetY : getCalibratedDefault(prevScale, 'offsetY');
      const prevOffsetXBlue = res.offsetXBlue !== undefined ? res.offsetXBlue : getCalibratedDefault(prevScale, 'offsetXBlue');
      const prevOffsetYBlue = res.offsetYBlue !== undefined ? res.offsetYBlue : getCalibratedDefault(prevScale, 'offsetYBlue');
      const prevOffsetXOrange = res.offsetXOrange !== undefined ? res.offsetXOrange : getCalibratedDefault(prevScale, 'offsetXOrange');
      const prevOffsetYOrange = res.offsetYOrange !== undefined ? res.offsetYOrange : getCalibratedDefault(prevScale, 'offsetYOrange');

      const displayX = prevOffsetX - getCalibratedDefault(prevScale, 'offsetX');
      const displayY = prevOffsetY - getCalibratedDefault(prevScale, 'offsetY');
      const displayXBlue = prevOffsetXBlue - getCalibratedDefault(prevScale, 'offsetXBlue');
      const displayYBlue = prevOffsetYBlue - getCalibratedDefault(prevScale, 'offsetYBlue');
      const displayXOrange = prevOffsetXOrange - getCalibratedDefault(prevScale, 'offsetXOrange');
      const displayYOrange = prevOffsetYOrange - getCalibratedDefault(prevScale, 'offsetYOrange');

      const igScaleMultiplier = parseFloat((1.00 * (val / 100)).toFixed(2));
      const newOffsetX = displayX + getCalibratedDefault(val, 'offsetX');
      const newOffsetY = displayY + getCalibratedDefault(val, 'offsetY');
      const newOffsetXBlue = displayXBlue + getCalibratedDefault(val, 'offsetXBlue');
      const newOffsetYBlue = displayYBlue + getCalibratedDefault(val, 'offsetYBlue');
      const newOffsetXOrange = displayXOrange + getCalibratedDefault(val, 'offsetXOrange');
      const newOffsetYOrange = displayYOrange + getCalibratedDefault(val, 'offsetYOrange');

      const igUiSlider = document.getElementById('ingamerank-uiscale-slider');
      const igUiInput = document.getElementById('ingamerank-uiscale-input');
      if (igUiSlider) igUiSlider.value = val;
      if (igUiInput) igUiInput.value = val;

      await rc.setBakkesPluginSettings('ingamerank', {
        uiScalePercent: val,
        scaleMultiplier: igScaleMultiplier,
        offsetX: newOffsetX,
        offsetY: newOffsetY,
        offsetXBlue: newOffsetXBlue,
        offsetYBlue: newOffsetYBlue,
        offsetXOrange: newOffsetXOrange,
        offsetYOrange: newOffsetYOrange
      });
    } catch (e) {
      console.error('Errore global scale ingamerank:', e);
    }

    toast(`Scala UI impostata su ${val}%`, 'success');
  }

  // Load current value (async, non-blocking)
  ;(async () => {
    try {
      const res = await rc.getBakkesPluginSettings('ingamerank');
      if (res && res.uiScalePercent !== undefined) {
        const cur = parseInt(res.uiScalePercent, 10) || 100;
        if (globalSlider) globalSlider.value = cur;
        if (globalInput)  globalInput.value  = cur;
      }
    } catch (e) {}
  })();

  if (globalSlider) {
    globalSlider.addEventListener('input', () => { if (globalInput) globalInput.value = globalSlider.value; });
    globalSlider.addEventListener('change', () => applyGlobalScale(globalSlider.value));
  }
  if (globalInput) {
    globalInput.addEventListener('change', () => applyGlobalScale(globalInput.value));
    globalInput.addEventListener('keydown', e => { if (e.key === 'Enter') applyGlobalScale(globalInput.value); });
  }
}

// ─── Tracker ─────────────────────────────────────────────────────
async function loadTrackerSession() {
  const session = await rc.getSession();
  if (session?.usernames && session.usernames.length > 0 && session.usernames[0]) {
    showTrackerDashboard(session);
  } else if (session?.username1) {
    showTrackerDashboard(session);
  } else {
    showTrackerSetup();
  }
}

// Local login auto-resolution
rc.on('local-player-login', async (data) => {
  const hint = document.getElementById('local-login-hint');
  const userSpan = document.getElementById('detected-username');
  if (hint && userSpan && data?.name) {
    userSpan.textContent = data.name;
    hint.style.display = 'block';
    
    // Auto-switch active account if the logged in player name is in the accounts list
    try {
      const session = await rc.getSession();
      if (session?.usernames) {
        const idx = session.usernames.findIndex(u => u.trim().toLowerCase() === data.name.trim().toLowerCase());
        if (idx !== -1 && idx !== session.activeAccountIndex) {
          console.log(`[app] Auto-switching active account to detected player: ${data.name} (index: ${idx})`);
          await rc.setActiveAccount(idx);
          const newSession = await rc.getSession();
          updateTrackerUI(newSession);
        }
      }
    } catch (err) {
      console.warn('[app] Error during auto-switch login account:', err);
    }
  }
});

document.getElementById('btn-use-detected')?.addEventListener('click', () => {
  const detected = document.getElementById('detected-username')?.textContent;
  if (!detected) return;

  const container = document.getElementById('tracker-usernames-container');
  if (!container) return;

  const inputs = container.querySelectorAll('.username-input-row input');
  let filled = false;
  for (const input of inputs) {
    if (!input.value.trim()) {
      input.value = detected;
      filled = true;
      break;
    }
  }
  if (!filled) {
    addUsernameInputField(detected);
  }
  toast(`Username inserito: ${detected}`, 'success');
});

function addUsernameInputField(value = '') {
  const container = document.getElementById('tracker-usernames-container');
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'username-input-row';
  row.style.cssText = 'display: flex; gap: 8px; align-items: center; width: 100%;';

  const input = document.createElement('input');
  input.className = 'input';
  input.placeholder = 'Epic Username...';
  input.value = value;
  input.style.flex = '1';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn btn-danger-sm';
  removeBtn.style.cssText = 'padding: 8px 12px; height: 38px; display: flex; align-items: center; justify-content: center; width: 38px; flex-shrink: 0;';
  removeBtn.innerHTML = '✕';
  removeBtn.addEventListener('click', () => {
    const rows = container.querySelectorAll('.username-input-row');
    if (rows.length > 1) {
      row.remove();
    } else {
      input.value = '';
    }
  });

  row.appendChild(input);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

document.getElementById('btn-tracker-add-field')?.addEventListener('click', () => {
  addUsernameInputField('');
});

document.getElementById('btn-tracker-connect')?.addEventListener('click', async () => {
  const container = document.getElementById('tracker-usernames-container');
  if (!container) return;

  const inputs = container.querySelectorAll('.username-input-row input');
  const usernamesList = Array.from(inputs).map(inp => inp.value.trim()).filter(Boolean);

  if (usernamesList.length === 0) {
    return toast('Specifica almeno un Epic username', 'warning');
  }

  toast('Connecting...', 'success');

  const activeIndex = settings.tracker?.activeAccountIndex || 0;
  const activeUsername = usernamesList[activeIndex] || usernamesList[0];

  const profile = await rc.getProfile(activeUsername);
  if (profile) {
    await rc.updateUsernames(usernamesList);
    settings = await rc.getSettings();
    const session = await rc.getSession();
    showTrackerDashboard(session);
    toast(`Connesso con successo!`, 'success');
  } else {
    toast(`Profilo non trovato per: ${activeUsername}`, 'error');
  }
});

function showTrackerDashboard(data) {
  const setup = document.getElementById('tracker-setup');
  const dash  = document.getElementById('tracker-dashboard');
  if (setup) setup.style.display = 'none';
  if (dash)  dash.style.display  = 'block';
  updateTrackerUI(data);
}

function showTrackerSetup() {
  const setup = document.getElementById('tracker-setup');
  const dash  = document.getElementById('tracker-dashboard');
  if (setup) setup.style.display = 'block';
  if (dash)  dash.style.display  = 'none';

  let usernamesList = settings.tracker?.usernames || [];
  if (usernamesList.length === 0) {
    if (settings.tracker?.username) usernamesList.push(settings.tracker.username);
    if (settings.tracker?.username2) usernamesList.push(settings.tracker.username2);
  }
  usernamesList = usernamesList.filter(Boolean);
  if (usernamesList.length === 0) {
    usernamesList.push('');
  }

  const container = document.getElementById('tracker-usernames-container');
  if (container) {
    container.innerHTML = '';
    usernamesList.forEach(username => {
      addUsernameInputField(username);
    });
  }
}

document.getElementById('btn-tracker-edit')?.addEventListener('click', () => {
  showTrackerSetup();
});

document.getElementById('btn-tracker-reset-stats')?.addEventListener('click', async () => {
  if (confirm('Are you sure you want to reset session stats (MMR, Win, Loss, Streak)?')) {
    try {
      const res = await rc.resetTrackerStats();
      if (res.ok) {
        toast('Stats reset! ✅', 'success');
        const session = await rc.getSession();
        updateTrackerUI(session);
      } else {
        toast(res.error || 'Error resetting stats', 'error');
      }
    } catch (e) {
      toast('Error: ' + e.message, 'error');
    }
  }
});

let rosterOverlayActive = false;
document.getElementById('btn-roster-toggle')?.addEventListener('click', () => {
  rc.toggleRoster?.();
  rosterOverlayActive = !rosterOverlayActive;
  const btn = document.getElementById('btn-roster-toggle');
  if (btn) {
    btn.style.borderColor = rosterOverlayActive ? 'rgba(120,180,255,0.7)' : 'rgba(120,180,255,0.25)';
    btn.style.color = rosterOverlayActive ? 'rgba(120,200,255,1)' : 'rgba(120,180,255,0.8)';
    btn.style.boxShadow = rosterOverlayActive ? '0 0 10px rgba(80,160,255,0.3)' : 'none';
  }
  toast(rosterOverlayActive ? '👥 Roster overlay attivo' : '👥 Roster overlay chiuso', 'success');
});

function getDivisionNumber(divisionName) {
  if (!divisionName) return 0;
  const name = divisionName.toLowerCase().replace('division', '').trim();
  if (name.includes('iv') || name.includes('4')) return 4;
  if (name.includes('iii') || name.includes('3')) return 3;
  if (name.includes('ii') || name.includes('2')) return 2;
  if (name.includes('i') || name.includes('1')) return 1;
  return 0;
}

function getRankColor(rankName) {
  if (!rankName) return '#94a3b8';
  const name = rankName.toLowerCase();
  if (name.includes('bronze')) return '#8b5a2b';
  if (name.includes('silver')) return '#a1a1a1';
  if (name.includes('gold')) return '#eab308';
  if (name.includes('platinum')) return '#38bdf8';
  if (name.includes('diamond')) return '#2563eb';
  if (name.includes('champion') && !name.includes('grand')) return '#c084fc';
  if (name.includes('grand') || name.includes('gc')) return '#ef4444';
  if (name.includes('supersonic') || name.includes('legend') || name.includes('ssl')) return '#ffffff';
  return '#94a3b8';
}

function updateTrackerUI(data) {
  if (!data) return;
  const { profile, mmr, mmrDelta, session, playlist, resolvedPlaylist, inMatch, activeAccount, username1, username2, usernames, activeAccountIndex, rankIcon, rankName, divisionName, isWsConnected, isUnranked, unrankedIcon } = data;
  
  const avatarPlaceholder = `
    <svg width="100%" height="100%" viewBox="0 0 28 28" fill="none" style="display: block;">
      <circle cx="14" cy="14" r="12" fill="url(#gradBlackHoleAvatar)" stroke="rgba(191,90,242,0.3)" stroke-width="1"/>
      <ellipse cx="14" cy="14" rx="14" ry="3.5" transform="rotate(-30 14 14)" fill="url(#gradDiskAvatar)" />
      <circle cx="14" cy="14" r="7.5" fill="#000000" stroke="#bf5af2" stroke-width="0.5"/>
      <path d="M 3 20 C 10 16, 18 12, 25 8" stroke="url(#gradDiskFrontAvatar)" stroke-width="3" stroke-linecap="round" />
      <defs>
        <linearGradient id="gradBlackHoleAvatar" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#0a0518"/>
          <stop offset="100%" stop-color="#240b36"/>
        </linearGradient>
        <linearGradient id="gradDiskAvatar" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#bf5af2" stop-opacity="0.8"/>
          <stop offset="100%" stop-color="#8e2de2" stop-opacity="0.1"/>
        </linearGradient>
        <linearGradient id="gradDiskFrontAvatar" x1="3" y1="20" x2="25" y2="8" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#bf5af2"/>
          <stop offset="50%" stop-color="#ffffff"/>
          <stop offset="100%" stop-color="#8e2de2"/>
        </linearGradient>
      </defs>
    </svg>
  `;
  
  const color = getRankColor(rankName);


  
  if (profile) {
    const nameEl = document.getElementById('profile-name');
    const avatarEl = document.getElementById('profile-avatar');
    if (nameEl) nameEl.textContent = profile.platformUserHandle || '';
    if (avatarEl) {
      avatarEl.style.borderColor = color ? `${color}66` : 'rgba(255,255,255,0.08)';
      avatarEl.style.boxShadow = color ? `0 0 14px ${color}33` : '0 0 14px rgba(255,255,255,0.05)';
      avatarEl.style.position = 'relative';
      avatarEl.style.overflow = isUnranked ? 'visible' : 'hidden';
      if (rankIcon) {
        let overlayHtml = '';
        if (isUnranked && unrankedIcon) {
          overlayHtml = `<img class="profile-unranked-overlay" src="${unrankedIcon}" style="position: absolute; top: -4px; right: -4px; width: 18px; height: 18px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.85)); z-index: 10;" />`;
        }
        avatarEl.innerHTML = `<img src="${rankIcon}" alt="${rankName || 'rank'}" title="${rankName || 'rank'}"/>${overlayHtml}`;
      } else if (profile.avatarUrl) {
        avatarEl.innerHTML = `<img src="${profile.avatarUrl}" alt="avatar"/>`;
      } else {
        avatarEl.innerHTML = avatarPlaceholder;
      }
    }
  } else {
    const nameEl = document.getElementById('profile-name');
    const avatarEl = document.getElementById('profile-avatar');
    if (nameEl) nameEl.textContent = (usernames && usernames[activeAccountIndex]) || username1 || '';
    if (avatarEl) {
      avatarEl.style.borderColor = color ? `${color}66` : 'rgba(255,255,255,0.08)';
      avatarEl.style.boxShadow = color ? `0 0 14px ${color}33` : '0 0 14px rgba(255,255,255,0.05)';
      avatarEl.style.position = 'relative';
      avatarEl.style.overflow = isUnranked ? 'visible' : 'hidden';
      if (rankIcon) {
        let overlayHtml = '';
        if (isUnranked && unrankedIcon) {
          overlayHtml = `<img class="profile-unranked-overlay" src="${unrankedIcon}" style="position: absolute; top: -4px; right: -4px; width: 18px; height: 18px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.85)); z-index: 10;" />`;
        }
        avatarEl.innerHTML = `<img src="${rankIcon}" alt="${rankName || 'rank'}" title="${rankName || 'rank'}"/>${overlayHtml}`;
      } else {
        avatarEl.innerHTML = avatarPlaceholder;
      }
    }
  }

  // Update Rank + Division display
  const platformEl = document.getElementById('profile-platform');
  if (platformEl) {
    const modeNames = {
      '1v1': 'Duel (1v1)',
      '2v2': 'Doubles (2v2)',
      '3v3': 'Standard (3v3)',
      'rumble': 'Rumble',
      'hoops': 'Hoops',
      'dropshot': 'Dropshot',
      'snowday': 'Snow Day',
      'casual': 'Casual',
      'tournament': 'Tournament 🏆'
    };
    const resolvedMode = (playlist === 'best' || playlist === 'current') ? (modeNames[resolvedPlaylist] || resolvedPlaylist) : '';
    const fullRank = [resolvedMode, rankName, divisionName].filter(Boolean).join(' • ');
    platformEl.textContent = fullRank ? `Epic Games • ${fullRank}` : 'Epic Games';
  }

  // Update Division indicator bars
  const divIndicator = document.getElementById('profile-division-indicator');
  if (divIndicator) {
    if (divisionName) {
      divIndicator.style.display = 'flex';
      const divNum = getDivisionNumber(divisionName);
      const bars = divIndicator.querySelectorAll('.div-bar');
      for (let i = 0; i < 4; i++) {
        const barNumber = 4 - i; // stacked 4, 3, 2, 1
        if (barNumber <= divNum) {
          bars[i].style.backgroundColor = color;
          bars[i].style.boxShadow = `0 0 6px ${color}80`;
        } else {
          bars[i].style.backgroundColor = 'rgba(255, 255, 255, 0.15)';
          bars[i].style.boxShadow = 'none';
        }
      }
    } else {
      divIndicator.style.display = 'none';
    }
  }

  const switcherContainer = document.getElementById('account-buttons-container');
  if (switcherContainer && usernames) {
    switcherContainer.innerHTML = usernames.map((username, idx) => {
      const isActive = idx === activeAccountIndex;
      return `<button class="acc-btn${isActive ? ' active' : ''}" data-acc-index="${idx}">${escapeHtml(username)}</button>`;
    }).join('');

    switcherContainer.querySelectorAll('.acc-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.accIndex);
        toast('Loading account...', 'success');
        await rc.setActiveAccount(idx);
        settings = await rc.getSettings();
        const newSession = await rc.getSession();
        updateTrackerUI(newSession);
      });
    });
  }

  const mmrEl = document.getElementById('mmr-current');
  if (mmrEl) mmrEl.textContent = mmr ? Math.round(mmr) : '—';
  const deltaEl = document.getElementById('mmr-delta');
  if (deltaEl && mmrDelta !== undefined) {
    deltaEl.textContent = (mmrDelta >= 0 ? '+' : '') + Math.round(mmrDelta);
    deltaEl.className = `mmr-value delta ${mmrDelta >= 0 ? 'positive' : 'negative'}`;
  }
  const wlEl = document.getElementById('wl-display');
  if (wlEl) wlEl.textContent = `${session?.wins ?? 0} / ${session?.losses ?? 0}`;
  const streakEl = document.getElementById('streak-display');
  const streak = session?.streak ?? 0;
  if (streakEl) streakEl.textContent = streak !== 0 ? (streak > 0 ? `W${streak}` : `L${Math.abs(streak)}`) : '—';
  const bannerEl = document.getElementById('in-match-banner');
  if (bannerEl) bannerEl.style.display = inMatch ? 'flex' : 'none';
  document.querySelectorAll('.pl-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.pl === playlist));
}

document.querySelectorAll('.pl-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    await rc.setPlaylist(btn.dataset.pl);
    const session = await rc.getSession();
    updateTrackerUI(session);
  });
});


// ─── Plugins ─────────────────────────────────────────────────────
async function loadPlugins() {
  const plugins = await rc.listPlugins();
  const list    = document.getElementById('plugins-list');
  if (!list) return;
  if (!plugins.length) {
    list.innerHTML = `<div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><path d="M28 4v12M20 4v12M8 20h32M16 40h16a6 6 0 006-6V18a6 6 0 00-6-6H16a6 6 0 00-6 6v16a6 6 0 006 6z" stroke="rgba(255,255,255,0.2)" stroke-width="2" stroke-linecap="round"/></svg>
      <p>No plugins installed</p><span>Drop a plugin folder in <code>AppData/Ascend/plugins/</code></span></div>`;
    return;
  }
  list.innerHTML = plugins.map(p => `
    <div class="plugin-card">
      <div>
        <div class="plugin-name">${escapeHtml(p.name || p.id)}</div>
        <div class="plugin-desc">${escapeHtml(p.description || '')}</div>
        <div class="plugin-version">v${escapeHtml(p.version || '1.0')}</div>
      </div>
      <div class="plugin-right">
        <div class="toggle${p.enabled ? ' on' : ''}" data-plugin-toggle="${escapeHtml(p.id)}"></div>
        <button class="btn btn-danger btn-sm" data-plugin-uninstall="${escapeHtml(p.id)}">Remove</button>
      </div>
    </div>`).join('');

  list.querySelectorAll('[data-plugin-toggle]').forEach(el => {
    el.addEventListener('click', async () => {
      const res = await rc.togglePlugin(el.dataset.pluginToggle);
      el.classList.toggle('on', res.enabled);
    });
  });
  list.querySelectorAll('[data-plugin-uninstall]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await rc.uninstallPlugin(btn.dataset.pluginUninstall);
      toast('Plugin removed', 'success');
      await loadPlugins();
    });
  });
}

// ─── Settings ────────────────────────────────────────────────────
function setupSettings() {
  const s = settings;
  const platEl = document.getElementById('setting-platform');
  const dirEl  = document.getElementById('setting-cooked-dir');
  const hkEl   = document.getElementById('setting-hotkey');
  const osEl   = document.getElementById('setting-overlay-style');
  if (platEl) platEl.value = s.target?.source || 'Epic';
  if (dirEl)  dirEl.value  = s.target?.cookedDir || '';
  if (hkEl)   hkEl.value   = s.bringToFrontHotkey || 'F2';
  if (osEl)   osEl.value   = s.overlayStyle || 'glassmorphism';
}

document.getElementById('btn-save-settings')?.addEventListener('click', async () => {
  await rc.saveSettings({
    bringToFrontHotkey: document.getElementById('setting-hotkey')?.value,
    overlayStyle: document.getElementById('setting-overlay-style')?.value,
    target: {
      source: document.getElementById('setting-platform')?.value,
      cookedDir: document.getElementById('setting-cooked-dir')?.value
    }
  });
  toast('Settings saved', 'success');
});

document.getElementById('btn-revert-all-settings')?.addEventListener('click', async () => {
  await rc.revertAll();
  swaps = [];
  updateActiveSwapsBar();
  toast('All swaps reverted', 'success');
});

// ─── Drop Zones ──────────────────────────────────────────────────
['ball-drop-zone', 'decal-drop-zone', 'hud-drop-zone'].forEach(id => {
  const zone = document.getElementById(id);
  if (!zone) return;
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    toast('Drop pack folder manually into AppData/Ascend/BallPacks or DecalPacks', 'warning');
  });
});

// ─── Canary modal ────────────────────────────────────────────────
rc.on('canary-drift', () => {
  const modal = document.getElementById('canary-modal');
  if (modal) modal.style.display = 'flex';
});
document.getElementById('btn-canary-reapply')?.addEventListener('click', async () => {
  const res = await rc.canaryReapply();
  const modal = document.getElementById('canary-modal');
  if (modal) modal.style.display = 'none';
  toast(`Re-applied ${res.reapplied} swaps`, 'success');
});
document.getElementById('btn-canary-dismiss')?.addEventListener('click', () => {
  const modal = document.getElementById('canary-modal');
  if (modal) modal.style.display = 'none';
});

// ─── Custom Swap Modal Actions ───────────────────────────────────
document.getElementById('btn-custom-swap-open')?.addEventListener('click', () => {
  const modal = document.getElementById('custom-swap-modal');
  if (modal) modal.style.display = 'flex';
  
  // Resetta i campi di ricerca al caricamento
  const searchInput = document.getElementById('custom-swap-search-catalog');
  const resultsDiv = document.getElementById('custom-swap-catalog-results');
  const targetInput = document.getElementById('custom-swap-target-input');
  const previewEl = document.getElementById('custom-swap-selected-preview');
  
  if (searchInput) searchInput.value = 'Octane';
  if (targetInput) targetInput.value = 'Body_Octane_SF.upk';
  if (previewEl) previewEl.textContent = 'Oggetto: Octane (Bodies)';
  if (resultsDiv) {
    resultsDiv.style.display = 'none';
    resultsDiv.innerHTML = '';
  }
});

document.getElementById('btn-custom-swap-cancel')?.addEventListener('click', () => {
  const modal = document.getElementById('custom-swap-modal');
  if (modal) modal.style.display = 'none';
});

// Autocomplete ricerca catalogo standard
const customSwapSearchInput = document.getElementById('custom-swap-search-catalog');
const customSwapResultsDiv = document.getElementById('custom-swap-catalog-results');

customSwapSearchInput?.addEventListener('input', async (e) => {
  const query = e.target.value.trim();
  if (query.length < 2) {
    customSwapResultsDiv.style.display = 'none';
    customSwapResultsDiv.innerHTML = '';
    return;
  }

  try {
    const items = await rc.getCatalog({ search: query, limit: 30 });
    if (!items || items.length === 0) {
      customSwapResultsDiv.innerHTML = '<div style="padding: 8px 12px; color: var(--text-sub); font-size: 12px; background: rgba(0,0,0,0.4);">No items found</div>';
      customSwapResultsDiv.style.display = 'block';
      return;
    }

    customSwapResultsDiv.innerHTML = items.map(item => `
      <div class="catalog-search-item" data-target-file="${item.targetFile}" data-item-name="${item.name}" data-item-type="${item.type}" data-image="${item.image || ''}" style="display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.04); transition: background 0.15s;">
        <div style="width: 32px; height: 32px; border-radius: 4px; background: rgba(255,255,255,0.04); display: flex; align-items: center; justify-content: center; flex-shrink: 0; overflow: hidden; border: 1px solid rgba(255,255,255,0.05);">
          ${item.image ? `<img src="${item.image}" alt="" style="width:100%; height:100%; object-fit:contain;"/>` : '📦'}
        </div>
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; font-size: 12.5px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.name}</div>
          <div style="font-size: 11px; color: var(--text-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.type} • <span style="font-family: monospace;">${item.targetFile}</span></div>
        </div>
      </div>
    `).join('');
    
    customSwapResultsDiv.style.display = 'block';

    // Click listener sui risultati della ricerca
    customSwapResultsDiv.querySelectorAll('.catalog-search-item').forEach(el => {
      el.addEventListener('click', () => {
        const targetFile = el.dataset.targetFile;
        const itemName = el.dataset.itemName;
        const itemType = el.dataset.itemType;

        const targetInput = document.getElementById('custom-swap-target-input');
        const previewEl = document.getElementById('custom-swap-selected-preview');

        if (targetInput) targetInput.value = targetFile;
        if (previewEl) previewEl.textContent = `Oggetto: ${itemName} (${itemType})`;

        customSwapSearchInput.value = itemName;
        customSwapResultsDiv.style.display = 'none';
      });
    });
  } catch (err) {
    console.error('[tracker] Errore catalogo autocomplete:', err);
  }
});

// Nascondi i risultati della ricerca se si clicca fuori
document.addEventListener('click', (e) => {
  if (customSwapSearchInput && customSwapResultsDiv && !customSwapSearchInput.contains(e.target) && !customSwapResultsDiv.contains(e.target)) {
    customSwapResultsDiv.style.display = 'none';
  }
});



document.getElementById('btn-custom-swap-browse')?.addEventListener('click', async () => {
  const filePath = await rc.selectCustomSwapFile();
  if (filePath) {
    const input = document.getElementById('custom-swap-source-input');
    if (input) input.value = filePath;
  }
});

document.getElementById('btn-custom-swap-apply')?.addEventListener('click', async () => {
  const targetFile = document.getElementById('custom-swap-target-input')?.value.trim();
  const sourceFile = document.getElementById('custom-swap-source-input')?.value.trim();

  if (!targetFile) {
    toast('Seleziona o inserisci il file di gioco da sostituire', 'error');
    return;
  }
  if (!sourceFile) {
    toast('Seleziona il file modded da caricare (.upk / .udk)', 'error');
    return;
  }

  // Costruisci etichette descrittive
  const targetLabel = targetFile;
  const sourceLabel = sourceFile.split(/[/\\]/).pop() || 'Custom Mod';

  const res = await rc.applySwap({
    targetFile,
    sourceFile,
    targetLabel,
    sourceLabel
  });

  if (res.ok) {
    toast('Custom swap applied successfully!', 'success');
    const modal = document.getElementById('custom-swap-modal');
    if (modal) modal.style.display = 'none';
    
    // Pulisci i campi
    const sourceInput = document.getElementById('custom-swap-source-input');
    if (sourceInput) sourceInput.value = '';

    await refreshSwaps();
  } else {
    toast(res.error || 'Error applying swap', 'error');
  }
});

// ─── Tracker IPC events ──────────────────────────────────────────
rc.on('tracker-update', updateTrackerUI);
rc.on('match-start',   data => { updateTrackerUI(data); toast('Match started!', 'success'); });

// ─── Thumbnail resolved event ────────────────────────────────────
rc.on('thumbnail-resolved', ({ name, image }) => {
  // 1. Update matching cards in catalog-grid
  document.querySelectorAll('.catalog-card').forEach(card => {
    if (card.dataset.label.toLowerCase() === name.toLowerCase()) {
      const imgContainer = card.querySelector('.card-img-container');
      const cardType = card.querySelector('.card-type')?.textContent?.trim() || '';
      const fallbackEmoji = getCategoryFallbackEmoji(cardType);
      if (imgContainer) {
        imgContainer.innerHTML = `<img src="${image}" loading="lazy" alt="${escapeHtml(name)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" style="width:100%; height:100%; object-fit:contain;"/>
           <div class="card-img-fallback" style="display:none;">${fallbackEmoji}</div>`;
      }
    }
  });
});

// ─── Toast ───────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const icons = { success: '✓', error: '✕', warning: '⚠' };
  const container = document.getElementById('toasts');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || '•'}</span>${escapeHtml(msg)}`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(28px)';
    el.style.transition = '0.2s ease';
    setTimeout(() => el.remove(), 200);
  }, 3200);
}



// ─── Utils ───────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// ─── Swap Target Modal Actions ───────────────────────────────────
let activeCatalogItemToSwap = null;

function showSwapTargetModal(item) {
  activeCatalogItemToSwap = item;
  
  const modal = document.getElementById('swap-target-modal');
  const nameEl = document.getElementById('swap-target-source-name');
  const imgEl = document.getElementById('swap-target-source-img');
  const labelEl = document.getElementById('swap-target-source-label');
  const catEl = document.getElementById('swap-target-source-category');
  const select = document.getElementById('swap-target-select');
  const customContainer = document.getElementById('swap-target-custom-file-container');
  const DEFAULTS_BY_CATEGORY = {
    'Anthems': 'album_anthem_monstercatgeneral_SF.upk',
    'Antennas': 'antenna_classic_SF.upk',
    'AvatarBorders': 'AvatarBorder_Default_SF.upk',
    'Bodies': 'Body_Octane_SF.upk',
    'Decals': 'body_octane_premium_skins_SF.upk',
    'Boosts': 'Boost_Standard_SF.upk',
    'EngineSounds': 'EngineAudio_Car01_OE_SF.upk',
    'GoalExplosions': 'Explosion_Default_SF.upk',
    'Toppers': 'hat_halo_SF.upk',
    'PaintFinishes': 'PaintFinish_Default_SF.upk',
    'PlayerBanners': 'playerbanner_classicpickup_SF.upk',
    'Trails': 'ss_default_SF.upk',
    'Wheels': 'wheel_7spoke_SF.upk'
  };

  const DEFAULTS_LABELS = {
    'Anthems': 'Monstercat General',
    'Antennas': 'Classic Antenna',
    'AvatarBorders': 'Bordo Avatar di Default',
    'Bodies': 'Octane',
    'Decals': 'Octane: Standard Decal',
    'Boosts': 'Standard Boost',
    'EngineSounds': 'OEM Engine',
    'GoalExplosions': 'Classica',
    'Toppers': 'Halo',
    'PaintFinishes': 'Finitura Standard',
    'PlayerBanners': 'Classic Banner',
    'Trails': 'Classica',
    'Wheels': 'OEM (7Spoke)'
  };

  if (nameEl) nameEl.textContent = item.name;
  if (labelEl) labelEl.textContent = item.name;
  if (catEl) catEl.textContent = item.type;
  if (imgEl) {
    if (item.image) {
      imgEl.innerHTML = `<img src="${item.image}" alt="" style="width:100%; height:100%; object-fit:contain;"/>`;
    } else {
      imgEl.innerHTML = `<span style="font-size: 24px;">${getCategoryFallbackEmoji(item.type)}</span>`;
    }
  }

  // Populate options
  let options = [];
  if (item.type === 'Bodies') {
    options = [
      { label: 'Octane', file: 'Body_Octane_SF.upk' },
      { label: 'Fennec', file: 'Body_Fennec_SF.upk' },
      { label: 'Dominus', file: 'Body_Dominus_SF.upk' },
      { label: 'Breakout', file: 'Body_Breakout_SF.upk' },
      { label: 'Merc', file: 'Body_Merc_SF.upk' }
    ];
  } else if (item.type === 'Wheels') {
    options = [
      { label: 'OEM (7Spoke)', file: 'wheel_7spoke_SF.upk' },
      { label: 'Cristiano', file: 'wheel_cristiano_SF.upk' },
      { label: 'Stern', file: 'wheel_stern_SF.upk' },
      { label: 'Veloce', file: 'wheel_veloce_SF.upk' }
    ];
  } else {
    // For other categories, get the default
    const defFile = DEFAULTS_BY_CATEGORY[item.type] || '';
    const defLabel = DEFAULTS_LABELS[item.type] || 'Default';
    if (defFile) {
      options.push({ label: defLabel, file: defFile });
    }
  }

  // Add custom option
  options.push({ label: 'File personalizzato...', file: 'custom' });

  if (select) {
    select.innerHTML = options.map(opt => `<option value="${opt.file}">${opt.label}</option>`).join('');
    select.value = options[0].file;
    if (customContainer) customContainer.style.display = 'none';
    
    // Reset autocomplete fields
    const customSearch = document.getElementById('swap-target-custom-search');
    const customResults = document.getElementById('swap-target-custom-results');
    const customFileValue = document.getElementById('swap-target-custom-file-value');
    const customLabelValue = document.getElementById('swap-target-custom-label-value');
    const customPreview = document.getElementById('swap-target-custom-selected-preview');

    if (customSearch) customSearch.value = '';
    if (customResults) {
      customResults.style.display = 'none';
      customResults.innerHTML = '';
    }
    if (customFileValue) customFileValue.value = '';
    if (customLabelValue) customLabelValue.value = '';
    if (customPreview) customPreview.textContent = 'No item selected';
  }

  const paintContainer = document.getElementById('swap-target-paint-container');
  const paintSelect = document.getElementById('swap-target-paint-select');
  if (paintContainer) {
    paintContainer.style.display = ['Boosts', 'Bodies', 'Wheels', 'Decals'].includes(item.type) ? 'block' : 'none';
  }
  if (paintSelect) {
    paintSelect.value = 'none';
  }

  if (modal) modal.style.display = 'flex';
}

document.getElementById('swap-target-select')?.addEventListener('change', (e) => {
  const customContainer = document.getElementById('swap-target-custom-file-container');
  if (customContainer) {
    customContainer.style.display = e.target.value === 'custom' ? 'block' : 'none';
  }
});

// Autocomplete ricerca catalogo per swap target
const swapTargetCustomSearch = document.getElementById('swap-target-custom-search');
const swapTargetCustomResults = document.getElementById('swap-target-custom-results');

swapTargetCustomSearch?.addEventListener('input', async (e) => {
  const query = e.target.value.trim();
  if (query.length < 2) {
    if (swapTargetCustomResults) {
      swapTargetCustomResults.style.display = 'none';
      swapTargetCustomResults.innerHTML = '';
    }
    return;
  }

  if (!activeCatalogItemToSwap) return;

  try {
    const items = await rc.getCatalog({
      search: query,
      category: activeCatalogItemToSwap.type,
      limit: 30
    });

    if (!swapTargetCustomResults) return;

    if (!items || items.length === 0) {
      swapTargetCustomResults.innerHTML = '<div style="padding: 8px 12px; color: var(--text-sub); font-size: 12px; background: rgba(0,0,0,0.4);">No items found</div>';
      swapTargetCustomResults.style.display = 'block';
      return;
    }

    swapTargetCustomResults.innerHTML = items.map(item => `
      <div class="catalog-search-item" data-target-file="${item.targetFile}" data-item-name="${item.name}" style="display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.04); transition: background 0.15s;">
        <div style="width: 32px; height: 32px; border-radius: 4px; background: rgba(255,255,255,0.04); display: flex; align-items: center; justify-content: center; flex-shrink: 0; overflow: hidden; border: 1px solid rgba(255,255,255,0.05);">
          ${item.image ? `<img src="${item.image}" alt="" style="width:100%; height:100%; object-fit:contain;"/>` : '📦'}
        </div>
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; font-size: 12.5px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.name}</div>
          <div style="font-size: 11px; color: var(--text-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"><span style="font-family: monospace;">${item.targetFile}</span></div>
        </div>
      </div>
    `).join('');

    swapTargetCustomResults.style.display = 'block';

    swapTargetCustomResults.querySelectorAll('.catalog-search-item').forEach(el => {
      el.addEventListener('click', () => {
        const targetFile = el.dataset.targetFile;
        const itemName = el.dataset.itemName;

        const fileValueInput = document.getElementById('swap-target-custom-file-value');
        const labelValueInput = document.getElementById('swap-target-custom-label-value');
        const previewEl = document.getElementById('swap-target-custom-selected-preview');

        if (fileValueInput) fileValueInput.value = targetFile;
        if (labelValueInput) labelValueInput.value = itemName;
        if (previewEl) previewEl.textContent = `Oggetto selezionato: ${itemName} (${targetFile})`;

        swapTargetCustomSearch.value = itemName;
        swapTargetCustomResults.style.display = 'none';
      });
    });

  } catch (err) {
    console.error('Errore autocomplete target swap:', err);
  }
});

// Nascondi i risultati se si clicca fuori
document.addEventListener('click', (e) => {
  if (swapTargetCustomSearch && swapTargetCustomResults && !swapTargetCustomSearch.contains(e.target) && !swapTargetCustomResults.contains(e.target)) {
    swapTargetCustomResults.style.display = 'none';
  }
});

document.getElementById('btn-swap-target-cancel')?.addEventListener('click', () => {
  const modal = document.getElementById('swap-target-modal');
  if (modal) modal.style.display = 'none';
  activeCatalogItemToSwap = null;
});

document.getElementById('btn-swap-target-apply')?.addEventListener('click', async () => {
  if (!activeCatalogItemToSwap) return;
  const select = document.getElementById('swap-target-select');
  
  let targetFile = select?.value;
  let targetLabel = select?.options[select.selectedIndex]?.text;
  
  if (targetFile === 'custom') {
    const fileValueInput = document.getElementById('swap-target-custom-file-value');
    const labelValueInput = document.getElementById('swap-target-custom-label-value');
    
    targetFile = fileValueInput?.value.trim();
    targetLabel = labelValueInput?.value.trim();
    
    if (!targetFile) {
      toast('Seleziona un oggetto dal catalogo da sostituire', 'error');
      return;
    }
  }

  const paintSelect = document.getElementById('swap-target-paint-select');
  const paintColor = paintSelect ? paintSelect.value : 'none';

  const modal = document.getElementById('swap-target-modal');
  if (modal) modal.style.display = 'none';

  const res = await rc.applySwap({
    targetFile: targetFile,
    sourceFile: activeCatalogItemToSwap.sourceFile || '',
    targetLabel: targetLabel,
    sourceLabel: activeCatalogItemToSwap.name,
    paintColor: paintColor
  });

  if (res.ok) {
    toast(`Swapped: ${targetLabel} ➔ ${activeCatalogItemToSwap.name}`, 'success');
    await refreshSwaps();
  } else {
    toast(res.error || 'Swap failed', 'error');
  }
  activeCatalogItemToSwap = null;
});

function setupUpdaterControls() {
  const btnUpdate = document.getElementById('btn-update');
  const badge = document.getElementById('update-badge');
  const modal = document.getElementById('update-modal');
  const modalInfo = document.getElementById('update-modal-info');
  const btnCancel = document.getElementById('btn-update-cancel');
  const btnReinstall = document.getElementById('btn-update-reinstall');
  const btnCheck = document.getElementById('btn-update-check');
  const btnApply = document.getElementById('btn-update-apply');

  if (!btnUpdate || !modal) return;

  // Auto-check on boot
  rc.checkUpdate().then(res => {
    if (res && res.hasUpdate) {
      btnUpdate.classList.add('pulse');
      if (badge) badge.style.display = 'block';
    }
  }).catch(() => {});

  btnUpdate.addEventListener('click', async () => {
    modal.style.display = 'flex';
    modalInfo.style.display = 'block';
    modalInfo.textContent = 'Checking for updates...';
    try {
      const res = await rc.checkUpdate();
      if (res && res.hasUpdate) {
        modalInfo.innerHTML = `
          <div style="font-weight: 600; color: #fbbf24; margin-bottom: 4px;">New version available: v${res.version}</div>
          <div style="color: var(--text-sub); font-size: 12px; margin-bottom: 6px;">${res.releaseNotes || ''}</div>
        `;
        btnApply.style.display = 'inline-block';
        btnCheck.style.display = 'none';
        btnUpdate.classList.add('pulse');
        if (badge) badge.style.display = 'block';
      } else {
        modalInfo.innerHTML = `
          <div style="color: var(--text-sub); font-size: 12.5px;">✓ You are using the latest version of Ascend.</div>
        `;
        btnApply.style.display = 'none';
        btnCheck.style.display = 'inline-block';
        btnUpdate.classList.remove('pulse');
        if (badge) badge.style.display = 'none';
      }
    } catch (err) {
      modalInfo.textContent = `Check failed: ${err.message}`;
    }
  });

  btnCancel.addEventListener('click', () => {
    modal.style.display = 'none';
  });

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal && !btnCancel.disabled) {
        modal.style.display = 'none';
      }
    });
  }

  btnCheck.addEventListener('click', async () => {
    modalInfo.style.display = 'block';
    modalInfo.textContent = 'Checking for updates...';
    try {
      const res = await rc.checkUpdate();
      if (res && res.hasUpdate) {
        modalInfo.innerHTML = `
          <div style="font-weight: 600; color: #fbbf24; margin-bottom: 4px;">New version available: v${res.version}</div>
          <div style="color: var(--text-sub); font-size: 12px; margin-bottom: 6px;">${res.releaseNotes || ''}</div>
        `;
        btnApply.style.display = 'inline-block';
        btnCheck.style.display = 'none';
        btnUpdate.classList.add('pulse');
        if (badge) badge.style.display = 'block';
        toast('New update found!', 'success');
      } else {
        modalInfo.innerHTML = `
          <div style="color: var(--text-sub); font-size: 12.5px;">✓ You are using the latest version of Ascend.</div>
        `;
        btnApply.style.display = 'none';
        btnCheck.style.display = 'inline-block';
        btnUpdate.classList.remove('pulse');
        if (badge) badge.style.display = 'none';
        toast('You are on the latest version.', 'success');
      }
    } catch (err) {
      modalInfo.textContent = `Check failed: ${err.message}`;
      toast('Check failed', 'error');
    }
  });

  btnReinstall.addEventListener('click', async () => {
    toast('Starting reinstallation...', 'success');
    try {
      const res = await rc.reinstallCurrent();
      if (res && res.ok) {
        modal.style.display = 'none';
      } else {
        toast(res.error || 'Reinstallation failed', 'error');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Real progress listener from main process
  if (window.rc && window.rc.on) {
    window.rc.on('updater-progress', (data) => {
      const progressBar = document.getElementById('update-progress-bar');
      const progressPct = document.getElementById('update-progress-pct');
      const progressLabel = document.getElementById('update-progress-label');
      if (data.percent !== undefined) {
        if (progressBar) progressBar.style.width = data.percent + '%';
        if (progressPct) progressPct.textContent = data.percent + '%';
      }
      if (data.phase === 'installing') {
        if (progressLabel) progressLabel.textContent = 'Installing... The app will restart.';
      } else if (data.downloaded && data.total) {
        const mb = (data.downloaded / (1024 * 1024)).toFixed(1);
        const totalMb = (data.total / (1024 * 1024)).toFixed(1);
        if (progressLabel) progressLabel.textContent = `Downloading update... (${mb} / ${totalMb} MB)`;
      }
    });
  }

  btnApply.addEventListener('click', async () => {
    const progressWrap = document.getElementById('update-progress-wrap');
    const progressBar = document.getElementById('update-progress-bar');
    const progressPct = document.getElementById('update-progress-pct');
    const progressLabel = document.getElementById('update-progress-label');

    // Show progress bar, hide action buttons
    btnApply.style.display = 'none';
    btnCheck.style.display = 'none';
    btnReinstall.style.display = 'none';
    btnCancel.disabled = true;
    if (progressWrap) progressWrap.style.display = 'block';
    if (progressBar) progressBar.style.width = '0%';
    if (progressPct) progressPct.textContent = '0%';
    if (progressLabel) progressLabel.textContent = 'Starting update download...';

    try {
      const res = await rc.installUpdate();
      if (res && res.ok) {
        if (progressBar) progressBar.style.width = '100%';
        if (progressPct) progressPct.textContent = '100%';
        if (progressLabel) progressLabel.textContent = 'Installing... The app will restart.';
      } else {
        if (progressWrap) progressWrap.style.display = 'none';
        btnApply.style.display = 'inline-block';
        btnReinstall.style.display = 'inline-block';
        btnCancel.disabled = false;
        toast(res?.error || 'Installation failed', 'error');
      }
    } catch (err) {
      if (progressWrap) progressWrap.style.display = 'none';
      btnApply.style.display = 'inline-block';
      btnReinstall.style.display = 'inline-block';
      btnCancel.disabled = false;
      toast(err.message, 'error');
    }
  });
}
