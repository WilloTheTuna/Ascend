const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const fetch   = require('node-fetch');
const AdmZip  = require('adm-zip');
const { v4: uuidv4 } = require('uuid');

// celab.jetfox.ovh has an expired SSL cert — bypass it
const celabAgent = new https.Agent({ rejectUnauthorized: false });
const celabFetch = (url, opts = {}) => fetch(url, { agent: celabAgent, ...opts });

const MAP_SLOTS = {
  slot1: {
    name: 'Utopia Retro',
    file: 'Labs_Utopia_P.upk',
    conflict: 'Labs_Utopia_P.udk'
  },
  slot2: {
    name: 'Underpass',
    file: 'Labs_Underpass_P.upk',
    conflict: 'Labs_Underpass_P.udk'
  },
  slot3: {
    name: 'Double Goal',
    file: 'Labs_DoubleGoal_V2_P.upk',
    conflict: 'Labs_DoubleGoal_V2_P.udk'
  },
  slot4: {
    name: 'Octagon',
    file: 'Labs_Octagon_02_P.upk',
    conflict: 'Labs_Octagon_02_P.udk'
  }
};

/**
 * WorkshopModule — manage and install workshop maps.
 * Maps are stored as .udk files in the workshop folder.
 * Supports installing from file paths or URLs.
 */
class WorkshopModule {
  constructor(appData, settings, logger) {
    this.appData = appData;
    this.settings = settings;
    this.logger = logger;
    this.workshopDir = path.join(appData, 'workshop');
    this.mapsFile = path.join(appData, 'workshop', 'maps.json');
    this.maps = [];
  }

  async init() {
    fs.mkdirSync(this.workshopDir, { recursive: true });
    try {
      const data = JSON.parse(fs.readFileSync(this.mapsFile, 'utf8'));
      if (Array.isArray(data)) {
        this.maps = data;
        this.activeMaps = { slot1: null, slot2: null, slot3: null, slot4: null };
      } else {
        this.maps = data.maps || [];
        if (data.activeMaps) {
          this.activeMaps = {
            slot1: data.activeMaps.slot1 || null,
            slot2: data.activeMaps.slot2 || null,
            slot3: data.activeMaps.slot3 || null,
            slot4: data.activeMaps.slot4 || null
          };
        } else {
          this.activeMaps = {
            slot1: data.activeMapId || null,
            slot2: null,
            slot3: null,
            slot4: null
          };
        }
      }
    } catch (_) {
      this.maps = [];
      this.activeMaps = { slot1: null, slot2: null, slot3: null, slot4: null };
    }
    this.logger.info(`WorkshopModule init: ${this.maps.length} maps`);
    setTimeout(() => this._repairMissingMetadata(), 1000);
  }

  listMaps() {
    return this.maps.map(m => {
      let bannerData = '';
      if (m.bannerLocalPath && fs.existsSync(m.bannerLocalPath)) {
        try {
          const buf = fs.readFileSync(m.bannerLocalPath);
          bannerData = `data:image/jpeg;base64,${buf.toString('base64')}`;
        } catch (_) {}
      }
      return { ...m, bannerData };
    });
  }

  async installMap(src, metaOverride = {}) {
    this.logger.info(`workshop: install ${src}`);
    try {
      let isRemote = src.startsWith('http');
      const lowerSrc = src.toLowerCase().split(/[?#]/)[0];
      // If it ends with .udk or .upk, it is a raw map file. Otherwise assume it's a zip.
      const isRawMap = lowerSrc.endsWith('.udk') || lowerSrc.endsWith('.upk');
      const isZip = !isRawMap;

      const id = metaOverride.id ? String(metaOverride.id) : uuidv4();
      const mapDir = path.join(this.workshopDir, id);
      fs.mkdirSync(mapDir, { recursive: true });

      let mapFilename = '';
      let bannerLocalPath = '';
      let installedMapPath = '';

      if (isZip) {
        let zipPath = src;
        if (isRemote) {
          if (src.includes('steamcommunity.com')) {
            throw new Error('I link di Steam Workshop non sono supportati. Sfoglia e scarica le mappe dal catalogo online.');
          }
          // Download to temp
          const tmpPath = path.join(this.workshopDir, `_tmp_${Date.now()}.zip`);
          const res = await fetch(src);
          if (!res.ok) throw new Error(`Download fallito: status ${res.status}`);
          
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('text/html')) {
            throw new Error('Il link non punta a un file ZIP valido (ha restituito una pagina web HTML).');
          }

          const buf = await res.buffer();
          fs.writeFileSync(tmpPath, buf);
          zipPath = tmpPath;
        }

        // Extract zip
        const zip = new AdmZip(zipPath);
        const entries = zip.getEntries();
        const mapEntry = entries.find(e => e.name.endsWith('.udk') || e.name.endsWith('.upk'));

        if (!mapEntry) {
          if (isRemote) {
            try { fs.unlinkSync(zipPath); } catch (_) {}
          }
          throw new Error('Nessun file .udk o .upk trovato nell\'archivio');
        }

        zip.extractAllTo(mapDir, true);
        mapFilename = mapEntry.name;
        installedMapPath = path.join(mapDir, mapEntry.entryName);

        // Find any image file in the extracted zip to use as a banner (prioritizing preview/thumbnail/icon/banner)
        const imgEntry = entries.find(e => {
          const nameLower = e.name.toLowerCase();
          return !e.isDirectory && 
                 (nameLower.includes('preview') || nameLower.includes('thumb') || nameLower.includes('icon') || nameLower.includes('banner')) &&
                 (nameLower.endsWith('.jpg') || nameLower.endsWith('.jpeg') || nameLower.endsWith('.png'));
        }) || entries.find(e => {
          const nameLower = e.name.toLowerCase();
          return !e.isDirectory && (nameLower.endsWith('.jpg') || nameLower.endsWith('.jpeg') || nameLower.endsWith('.png'));
        });
        if (imgEntry) {
          bannerLocalPath = path.join(mapDir, imgEntry.entryName);
        }

        // Try to read metadata from zip
        const metaEntry = entries.find(e => e.name === 'info.json' || e.name === 'metadata.json');
        if (metaEntry && !metaOverride.name) {
          try {
            const parsed = JSON.parse(metaEntry.getData().toString('utf8'));
            metaOverride = { ...parsed, ...metaOverride };
          } catch (_) {}
        }

        if (isRemote) {
          try { fs.unlinkSync(zipPath); } catch (_) {}
        }
      } else {
        // Raw map file (.udk or .upk)
        let originalName = path.basename(src).split(/[?#]/)[0];
        if (!originalName || (!originalName.endsWith('.udk') && !originalName.endsWith('.upk'))) {
          originalName = 'map.udk';
        }
        mapFilename = decodeURIComponent(originalName);

        const destPath = path.join(mapDir, mapFilename);
        installedMapPath = destPath;

        if (isRemote) {
          const res = await fetch(src);
          if (!res.ok) throw new Error(`Download fallito: status ${res.status}`);
          const buf = await res.buffer();
          fs.writeFileSync(destPath, buf);
        } else {
          fs.copyFileSync(src, destPath);
        }
      }

      // Download banner if exists
      if (metaOverride.bannerUrl && metaOverride.bannerUrl.startsWith('http')) {
        try {
          const isCelabUrl = metaOverride.bannerUrl.includes('celab.jetfox.ovh');
          const bannerRes = await (isCelabUrl ? celabFetch(metaOverride.bannerUrl) : fetch(metaOverride.bannerUrl));
          if (bannerRes.ok) {
            const bannerBuf = await bannerRes.buffer();
            const localBanner = path.join(mapDir, 'banner.jpg');
            fs.writeFileSync(localBanner, bannerBuf);
            bannerLocalPath = localBanner;
          }
        } catch (err) {
          this.logger.error(`Failed to download banner: ${err.message}`);
        }
      }

      // Merge with override metadata
      let meta = {
        name: metaOverride.name || path.basename(mapFilename, path.extname(mapFilename)),
        author: metaOverride.author || 'Unknown',
        description: metaOverride.description || ''
      };

      meta = { ...meta, ...metaOverride };
      if (bannerLocalPath) {
        meta.bannerLocalPath = bannerLocalPath;
      }

      const entry = {
        id, ...meta,
        filename: mapFilename,
        mapPath: installedMapPath,
        installedAt: new Date().toISOString()
      };

      // Remove duplicate if already exists
      this.maps = this.maps.filter(m => String(m.id) !== String(id));
      this.maps.push(entry);
      this._saveMaps();

      this.logger.info(`workshop: installed ${meta.name} (${id})`);
      return { ok: true, map: entry };
    } catch (e) {
      this.logger.error(`workshop install error: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  // ── Celab GitLab API ─────────────────────────────────────────────
  // Source: celab.jetfox.ovh — every map is a GitLab project with
  // a release containing a .zip with .udk/.upk inside.
  // -----------------------------------------------------------------

  async searchCelabMaps(opts = {}) {
    const page  = opts.page   || 1;
    const query = opts.search || '';
    const PER   = 24;

    const base = 'https://celab.jetfox.ovh/api/v4/projects';
    const url  = `${base}?per_page=${PER}&page=${page}&order_by=last_activity_at&sort=desc`
      + (query ? `&search=${encodeURIComponent(query)}` : '');

    try {
      const res = await celabFetch(url, { headers: { 'User-Agent': 'RocketCroc/1.0' } });
      if (!res.ok) throw new Error(`celab API ${res.status}`);
      const items = await res.json();

      const totalHeader = res.headers.get('x-total') || '0';
      const totalPages  = res.headers.get('x-total-pages') || '1';

      // ── Fetch thumbnails from releases in parallel (max 8 concurrent) ──
      const CONCURRENCY = 8;
      const thumbMap = {};  // projectId → imageUrl

      const fetchThumb = async (p) => {
        // Fast path: project already has an avatar
        if (p.avatar_url) { thumbMap[p.id] = p.avatar_url; return; }
        try {
          const rRes = await celabFetch(
            `https://celab.jetfox.ovh/api/v4/projects/${p.id}/releases?per_page=1`,
            { headers: { 'User-Agent': 'RocketCroc/1.0' } }
          );
          if (!rRes.ok) return;
          const releases = await rRes.json();
          if (!releases || releases.length === 0) return;
          const links = releases[0].assets?.links || [];
          const imgLink = links.find(l => 
            (l.link_type === 'image') || 
            (l.name || '').toLowerCase().match(/\.(jpg|jpeg|png|webp|gif)$/i) || 
            (l.direct_asset_url || l.url || '').toLowerCase().match(/\.(jpg|jpeg|png|webp|gif)/i)
          );
          if (imgLink) thumbMap[p.id] = imgLink.direct_asset_url;
        } catch (_) {}
      };

      // Run in batches of CONCURRENCY
      for (let i = 0; i < items.length; i += CONCURRENCY) {
        await Promise.all(items.slice(i, i + CONCURRENCY).map(fetchThumb));
      }

      return {
        items: items.map(p => ({
          id:          p.id,
          name:        p.name,
          author:      p.namespace?.name || 'Unknown',
          description: (p.description || '').replace(/\r?\n/g, ' ').substring(0, 200),
          avatarUrl:   thumbMap[p.id] || p.avatar_url || null,
          webUrl:      p.web_url,
          updatedAt:   p.last_activity_at
        })),
        total:      parseInt(totalHeader, 10) || items.length,
        totalPages: parseInt(totalPages,  10) || 1,
        page
      };
    } catch (err) {
      this.logger.error(`searchCelabMaps error: ${err.message}`);
      throw err;
    }
  }

  // Download a map from celab by project ID.
  // Finds the latest release, grabs the .zip asset URL, then
  // delegates to the existing installMap() which already handles
  // zip extraction + metadata.
  async downloadCelabMap(projectId, projectName, { onProgress } = {}) {
    const base = 'https://celab.jetfox.ovh/api/v4';
    try {
      // 0. Fetch project info to get author (namespace), description, and avatar
      let author = '';
      let description = '';
      let projectAvatarUrl = '';
      try {
        const pRes = await celabFetch(`${base}/projects/${projectId}`, {
          headers: { 'User-Agent': 'RocketCroc/1.0' }
        });
        if (pRes.ok) {
          const pData = await pRes.json();
          author = pData.namespace?.name || '';
          description = (pData.description || '').replace(/\r?\n/g, ' ').substring(0, 200);
          projectAvatarUrl = pData.avatar_url || '';
        }
      } catch (err) {
        this.logger.error(`[celab] Failed to fetch project metadata: ${err.message}`);
      }

      // 1. Get latest release for this project
      const relRes = await celabFetch(`${base}/projects/${projectId}/releases`, {
        headers: { 'User-Agent': 'RocketCroc/1.0' }
      });
      if (!relRes.ok) throw new Error(`releases API ${relRes.status}`);
      const releases = await relRes.json();

      if (!releases || releases.length === 0) {
        throw new Error(`Nessuna release trovata per "${projectName}"`);
      }

      const latest = releases[0];
      const links  = latest.assets?.links || [];

      // Pick the .zip link (fallback: any link)
      const zipLink = links.find(l => l.name.toLowerCase().endsWith('.zip'))
                   || links.find(l => !l.name.toLowerCase().match(/\.(jpg|png|gif|mp4)$/i))
                   || links[0];

      if (!zipLink) throw new Error(`Nessun file scaricabile in release "${latest.name}"`);

      const downloadUrl = zipLink.direct_asset_url;

      // 2. Find optional banner from release assets (jpg/png)
      const bannerLink = links.find(l => 
        (l.link_type === 'image') ||
        (l.name || '').toLowerCase().match(/\.(jpg|jpeg|png)$/i) ||
        (l.direct_asset_url || l.url || '').toLowerCase().match(/\.(jpg|jpeg|png|webp|gif)/i)
      );
      const bannerUrl  = bannerLink ? bannerLink.direct_asset_url : (projectAvatarUrl || null);

      // 3. Stream download with progress
      this.logger.info(`[celab] Downloading ${projectName} from ${downloadUrl}`);
      const dlRes = await celabFetch(downloadUrl, { headers: { 'User-Agent': 'RocketCroc/1.0' } });
      if (!dlRes.ok) throw new Error(`Download fallito: status ${dlRes.status}`);

      const total = parseInt(dlRes.headers.get('content-length') || '0', 10);
      let received = 0;
      const chunks = [];

      for await (const chunk of dlRes.body) {
        chunks.push(chunk);
        received += chunk.length;
        if (onProgress && total > 0) {
          onProgress(Math.round((received / total) * 100));
        }
      }

      const buf = Buffer.concat(chunks);
      const tmpPath = path.join(this.workshopDir, `_celab_${Date.now()}.zip`);
      fs.writeFileSync(tmpPath, buf);

      // 4. Delegate to installMap — handles extraction, dedup, etc.
      const result = await this.installMap(tmpPath, {
        id:          String(projectId),
        name:        projectName,
        author:      author,
        description: description,
        bannerUrl:   bannerUrl || ''
      });

      try { fs.unlinkSync(tmpPath); } catch (_) {}
      return result;
    } catch (err) {
      this.logger.error(`downloadCelabMap error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  // Legacy — kept for backward compat but now unused
  async getOnlineMaps(opts = {}) { return { items: [], total: 0, totalPages: 1, page: 1 }; }
  async getOnlineMapDetails(id)   { return null; }

  deleteMap(id) {
    const map = this.maps.find(m => String(m.id) === String(id));
    if (!map) return { ok: false, error: 'Mappa non trovata' };

    try {
      const mapDir = path.dirname(map.mapPath);
      fs.rmSync(mapDir, { recursive: true, force: true });
    } catch (_) {}

    this.maps = this.maps.filter(m => String(m.id) !== String(id));
    if (String(this.activeMapId) === String(id)) {
      this.activeMapId = null;
    }
    this._saveMaps();
    this.logger.info(`workshop: deleted ${id}`);
    return { ok: true };
  }

  async launchMap(id, slotId = 'slot1') {
    const map = this.maps.find(m => String(m.id) === String(id));
    if (!map) return { ok: false, error: 'Mappa non trovata' };

    const slot = MAP_SLOTS[slotId];
    if (!slot) return { ok: false, error: 'Slot non valido' };

    const cfg = this.settings.load();
    const cookedDir = cfg.target.cookedDir;
    const backupDir = path.join(this.appData, 'Backups', cfg.target.source);
    fs.mkdirSync(backupDir, { recursive: true });

    const targetSlot = path.join(cookedDir, slot.file);
    const backupSlot = path.join(backupDir, slot.file);
    const conflictSlot = path.join(cookedDir, slot.conflict);

    try {
      // Backup original map on first swap
      if (!fs.existsSync(backupSlot) && fs.existsSync(targetSlot)) {
        fs.copyFileSync(targetSlot, backupSlot);
        this.logger.info(`workshop: backed up original ${slot.file}`);
      }

      // Remove any conflicting .udk file in cookedDir to force RL to load our replaced .upk
      if (fs.existsSync(conflictSlot)) {
        try { fs.unlinkSync(conflictSlot); } catch (_) {}
      }

      fs.copyFileSync(map.mapPath, targetSlot);
      this.activeMaps[slotId] = id;
      this._saveMaps();
      this.logger.info(`workshop: loaded ${map.name} into ${slot.name} slot`);
      return { ok: true };
    } catch (e) {
      this.logger.error(`workshop launch error: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  async restoreOriginal(slotId = null) {
    const cfg = this.settings.load();
    const cookedDir = cfg.target.cookedDir;
    const backupDir = path.join(this.appData, 'Backups', cfg.target.source);

    const restoreSlot = (sId) => {
      const slot = MAP_SLOTS[sId];
      if (!slot) return false;
      const targetSlot = path.join(cookedDir, slot.file);
      const backupSlot = path.join(backupDir, slot.file);
      if (fs.existsSync(backupSlot)) {
        fs.copyFileSync(backupSlot, targetSlot);
        this.activeMaps[sId] = null;
        this.logger.info(`workshop: restored original ${slot.file}`);
        return true;
      }
      return false;
    };

    try {
      let restoredCount = 0;
      if (slotId) {
        if (restoreSlot(slotId)) restoredCount++;
      } else {
        for (const sId of Object.keys(MAP_SLOTS)) {
          if (restoreSlot(sId)) restoredCount++;
        }
      }
      this._saveMaps();
      return { ok: true, restoredCount };
    } catch (e) {
      this.logger.error(`workshop restore error: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  getActiveMapId() {
    return this.activeMaps?.slot1 || null;
  }

  getActiveMaps() {
    return this.activeMaps || { slot1: null, slot2: null, slot3: null, slot4: null };
  }

  _saveMaps() {
    fs.writeFileSync(this.mapsFile, JSON.stringify({
      activeMaps: this.activeMaps,
      maps: this.maps
    }, null, 2));
  }

  async _repairMissingMetadata() {
    let changed = false;
    for (const map of this.maps) {
      if (map.id && /^\d+$/.test(String(map.id))) {
        const needsAuthor = !map.author || map.author === 'Unknown';
        const needsBanner = !map.bannerLocalPath || !fs.existsSync(map.bannerLocalPath);
        
        if (needsAuthor || needsBanner) {
          this.logger.info(`[celab] Repairing metadata for map ${map.name} (${map.id})`);
          try {
            const base = 'https://celab.jetfox.ovh/api/v4';
            const pRes = await celabFetch(`${base}/projects/${map.id}`, {
              headers: { 'User-Agent': 'RocketCroc/1.0' }
            });
            if (pRes.ok) {
              const pData = await pRes.json();
              if (needsAuthor) {
                map.author = pData.namespace?.name || 'Unknown';
                changed = true;
              }
              if (needsBanner) {
                const relRes = await celabFetch(`${base}/projects/${map.id}/releases?per_page=1`, {
                  headers: { 'User-Agent': 'RocketCroc/1.0' }
                });
                let bannerUrl = pData.avatar_url || '';
                if (relRes.ok) {
                  const releases = await relRes.json();
                  if (releases && releases.length > 0) {
                    const links = releases[0].assets?.links || [];
                    const bannerLink = links.find(l => 
                      (l.link_type === 'image') ||
                      (l.name || '').toLowerCase().match(/\.(jpg|jpeg|png)$/i) ||
                      (l.direct_asset_url || l.url || '').toLowerCase().match(/\.(jpg|jpeg|png|webp|gif)/i)
                    );
                    if (bannerLink) bannerUrl = bannerLink.direct_asset_url;
                  }
                }
                if (bannerUrl && bannerUrl.startsWith('http')) {
                  const mapDir = path.dirname(map.mapPath);
                  const bannerRes = await celabFetch(bannerUrl);
                  if (bannerRes.ok) {
                    const bannerBuf = await bannerRes.buffer();
                    const localBanner = path.join(mapDir, 'banner.jpg');
                    fs.writeFileSync(localBanner, bannerBuf);
                    map.bannerLocalPath = localBanner;
                    changed = true;
                  }
                }
              }
            }
          } catch (err) {
            this.logger.error(`[celab] Failed to repair metadata for ${map.name}: ${err.message}`);
          }
        }
      }
    }
    if (changed) {
      this._saveMaps();
      this.logger.info(`[celab] Metadata repair complete. Saved changes.`);
    }
  }
}

module.exports = WorkshopModule;

