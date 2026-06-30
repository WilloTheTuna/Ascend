const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const CODENAME_MAP = {
  // Bodies
  'bodies:future': 'Hatsune Miku',
  'bodies:future t': 'Hatsune Miku',
  
  // Boosts
  'boosts:animesmoke': 'Anime Smoke',
  'boosts:animesmoke smh': 'Anime Smoke',
  'boosts:animesmoke smh t': 'Anime Smoke',
  'boosts:animesmoke t': 'Anime Smoke',
  'boosts:anime': 'Leek Beam',
  'boosts:anime t': 'Leek Beam',
  'boosts:future': 'Leek Beam',
  'boosts:future t': 'Leek Beam',
  
  // Goal Explosions
  'goalexplosions:anime': 'Miku Pop',
  'goalexplosions:anime t': 'Miku Pop',
  'goalexplosions:animesmoke': 'Miku Pop',
  'goalexplosions:animesmoke t': 'Miku Pop',
  
  // Toppers
  'toppers:futureglasses': 'Hatsune Miku Glasses',
  'toppers:futureglasses t': 'Hatsune Miku Glasses',
  'toppers:futureglasses psplus': 'Hatsune Miku Glasses',
  'toppers:futureglasses psplus t': 'Hatsune Miku Glasses',
  'toppers:futurepigeon': 'Miku Pigeon',
  'toppers:futurepigeon t': 'Miku Pigeon',
  'toppers:future baja': 'Leek',
  'toppers:future baja t': 'Leek',
  
  // Player Banners
  'playerbanners:animepattern': 'Miku Pattern',
  'playerbanners:animepattern t': 'Miku Pattern',
  'playerbanners:animewind': 'Miku Wind',
  'playerbanners:animewind t': 'Miku Wind',
  'playerbanners:anime': 'Hatsune Miku',
  'playerbanners:anime t': 'Hatsune Miku',
  'playerbanners:futurewave': 'Futurewave',
  'playerbanners:futurewave t': 'Futurewave',
  
  // Trails
  'trails:animesmoke': 'Miku Miku',
  'trails:animesmoke t': 'Miku Miku',
  'trails:anime': 'Miku Miku',
  'trails:anime t': 'Miku Miku',
  
  // Wheels
  'wheels:futurewave': 'Rolled Leek',
  'wheels:futurewave t': 'Rolled Leek',
  
  // Decals
  'decals:future baja': 'Miku Rider Dark',
  'decals:future baja t': 'Miku Rider Dark',
  'decals:future camo': 'Miku Camo',
  'decals:future camo t': 'Miku Camo',
  'decals:future matteblack': 'Miku Matte Black',
  'decals:future matteblack t': 'Miku Matte Black',
  'decals:future stainless buster': 'Miku Stainless Buster',
  'decals:future stainless buster t': 'Miku Stainless Buster',
  'decals:future': 'Miku Rider Dark',
  'decals:future t': 'Miku Rider Dark'
};

/**
 * SwapEngine — Reads .upk files from CookedPCConsole, backs them up,
 * and swaps them on disk before the game reads them.
 * No injection. EAC-safe.
 */
class SwapEngine extends EventEmitter {
  constructor(appData, settings, logger) {
    super();
    this.appData = appData;
    this.settings = settings;
    this.logger = logger;
    this.cookedDir = '';
    this.backupDir = '';
    this.swapsFile = path.join(appData, 'swaps.json');
    this.presetsFile = path.join(appData, 'presets.json');
    this.catalogFile = path.join(appData, 'catalog.json');
    this.swaps = [];
    this.presets = { currentPreset: 'Default', presets: [{ name: 'Default', swaps: [] }] };
    this.catalog = [];

    // Load item names map for auto-translation of all codenames
    try {
      const namesFile = path.join(__dirname, 'item_names.json');
      if (fs.existsSync(namesFile)) {
        this.itemNamesMap = JSON.parse(fs.readFileSync(namesFile, 'utf8'));
        this.logger.info(`SwapEngine: Loaded ${Object.keys(this.itemNamesMap).length} item name mappings.`);
      } else {
        this.itemNamesMap = {};
      }
    } catch (err) {
      this.itemNamesMap = {};
      this.logger.error(`SwapEngine: Failed to load item name mappings: ${err.message}`);
    }
  }

  getRealItemName(item) {
    if (!item) return 'Unknown';
    let code = (item.code || item.id || '').toLowerCase().replace(/_sf$/i, '');
    let isPaintedT = false;
    
    if (code.endsWith('_t')) {
      code = code.slice(0, -2);
      isPaintedT = true;
    }
    
    let displayName = null;
    if (this.itemNamesMap && this.itemNamesMap[code]) {
      displayName = this.itemNamesMap[code];
    } else {
      // Local fallback override mappings if not in JSON database
      const type = item.category || item.type || '';
      const fallbackKey = `${type.toLowerCase()}:${(item.label || item.name || '').toLowerCase()}`;
      if (CODENAME_MAP[fallbackKey]) {
        displayName = CODENAME_MAP[fallbackKey];
      } else {
        displayName = item.label || item.name || 'Unknown';
      }
    }
    
    if (isPaintedT && displayName && !displayName.endsWith(' T')) {
      if (!displayName.toLowerCase().endsWith(' t')) {
        displayName = `${displayName} T`;
      }
    }
    
    return displayName;
  }

  async init(cfg) {
    this.cookedDir = cfg.target.cookedDir.replace(/\\/g, '/');
    this.backupDir = path.join(this.appData, 'Backups', cfg.target.source);
    fs.mkdirSync(this.backupDir, { recursive: true });

    // Load swaps & presets (tiny files, sync is fine)
    try { this.swaps = JSON.parse(fs.readFileSync(this.swapsFile, 'utf8')); } catch (_) { this.swaps = []; }
    try { this.presets = JSON.parse(fs.readFileSync(this.presetsFile, 'utf8')); } catch (_) {}

    // Load catalog SYNC — 1.6MB is tiny and loads in a few milliseconds, preventing any async timing freeze
    try {
      const raw = fs.readFileSync(this.catalogFile, 'utf8');
      const parsed = JSON.parse(raw);
      this.catalog = parsed.items || parsed;
      this._catalogReady = true;
      this.logger.info(`SwapEngine: catalog loaded synchronously (${this.catalog.length} items)`);
    } catch (err) {
      this.catalog = [];
      this._catalogReady = true;
      this.logger.error(`SwapEngine: failed to load catalog: ${err.message}`);
    }

    this.logger.info(`SwapEngine init: cookedDir=${this.cookedDir}`);
    await this.initThumbnailsMap();
    this.scanLocalCookedPCForNewItems();
  }

  scanLocalCookedPCForNewItems() {
    if (!this.cookedDir || !fs.existsSync(this.cookedDir)) return 0;

    try {
      this.logger.info("SwapEngine: Scanning CookedPCConsole for new untracked items...");
      const files = fs.readdirSync(this.cookedDir);
      const upkFiles = files.filter(f => f.toLowerCase().endsWith('.upk'));

      // Create a set of existing catalog filenames for O(1) lookup
      const existingFiles = new Set(this.catalog.map(item => item.file.toLowerCase()));
      let addedCount = 0;

      const PREFIX_MAPPINGS = [
        { prefix: 'album_anthem_', category: 'Anthems' },
        { prefix: 'anthem_', category: 'Anthems' },
        { prefix: 'antenna_', category: 'Antennas' },
        { prefix: 'flag_', category: 'Antennas' },
        { prefix: 'countryflag_', category: 'Antennas' },
        { prefix: 'streamerflag_', category: 'Antennas' },
        { prefix: 'at_', category: 'Antennas' },
        { prefix: 'avatarborder_', category: 'AvatarBorders' },
        { prefix: 'body_', category: 'Bodies' },
        { prefix: 'boost_', category: 'Boosts' },
        { prefix: 'decal_', category: 'Decals' },
        { prefix: 'skin_', category: 'Decals' },
        { prefix: 'skins_', category: 'Decals' },
        { prefix: 'esportsteam_', category: 'Decals' },
        { prefix: 'engineaudio_', category: 'EngineSounds' },
        { prefix: 'explosion_', category: 'GoalExplosions' },
        { prefix: 'hat_', category: 'Toppers' },
        { prefix: 'paintfinish_', category: 'PaintFinishes' },
        { prefix: 'playerbanner_', category: 'PlayerBanners' },
        { prefix: 'ss_', category: 'Trails' },
        { prefix: 'trail_', category: 'Trails' },
        { prefix: 'wheel_', category: 'Wheels' }
      ];

      for (const file of upkFiles) {
        const fileLower = file.toLowerCase();
        if (existingFiles.has(fileLower)) continue;

        // Determine category
        let category = null;
        let matchedPrefix = '';
        for (const item of PREFIX_MAPPINGS) {
          if (fileLower.startsWith(item.prefix)) {
            category = item.category;
            matchedPrefix = item.prefix;
            break;
          }
        }

        // Treat as Decal if it doesn't match other categories but is a skin file
        if (!category) {
          if (fileLower.includes('_skins')) {
            category = 'Decals';
          } else {
            // Skip unrecognized files (maps, startup files, UI packages)
            continue;
          }
        }

        const baseName = file.substring(0, file.lastIndexOf('.')); // remove .upk
        const code = baseName;
        
        let label = baseName;
        let cleanName = baseName.replace(/_SF$/i, '');
        if (matchedPrefix) {
          cleanName = cleanName.substring(matchedPrefix.length);
        }
        
        // Capitalize words
        label = cleanName.split('_')
          .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(' ');

        // Add to catalog
        this.catalog.push({
          category,
          code,
          file,
          label,
          validation: 'supported'
        });
        existingFiles.add(fileLower);
        addedCount++;
      }

      if (addedCount > 0) {
        this.logger.info(`SwapEngine: Added ${addedCount} new local items to catalog.`);
        fs.writeFileSync(this.catalogFile, JSON.stringify({ items: this.catalog }, null, 2));
      }
      return addedCount;
    } catch (err) {
      this.logger.error(`SwapEngine: Error scanning CookedPCConsole: ${err.message}`);
      return 0;
    }
  }

  // ── Hash helper ─────────────────────────────
  _hashFile(filePath) {
    try {
      const buf = fs.readFileSync(filePath);
      const h = crypto.createHash('sha256').update(buf).digest('hex');
      return `${buf.length}:${h.slice(0, 16)}`;
    } catch (_) { return null; }
  }

  // ── Backup an original file ──────────────────
  _backup(filename) {
    const src = path.join(this.cookedDir, filename);
    const dst = path.join(this.backupDir, filename);
    if (!fs.existsSync(dst) && fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      this.logger.info(`backup: ${filename}`);
    }
  }

  // ── Restore from backup ──────────────────────
  _restore(filename) {
    const src = path.join(this.backupDir, filename);
    const dst = path.join(this.cookedDir, filename);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      this.logger.info(`restore: ${filename}`);
      try {
        fs.unlinkSync(src);
      } catch (err) {
        this.logger.error(`Failed to delete backup file: ${err.message}`);
      }
      return true;
    }
    return false;
  }

  // ── Apply a single swap ──────────────────────
  async applySwap(swap) {
    // Redirect custom boost swaps targeting default Standard/Flamethrower boosts to Thermal (Propulsion) to prevent crash
    const isCustomBoost = (src) => {
      if (!src) return false;
      const isLegacy = src.match(/^Boost_(Standard|Flamethrower)/i);
      return !isLegacy;
    };

    if (swap.targetFile && (swap.targetFile.toLowerCase() === 'boost_standard_sf.upk' || swap.targetFile.toLowerCase() === 'boost_flamethrower_sf.upk')) {
      if (isCustomBoost(swap.sourceFile)) {
        this.logger.info(`SwapEngine: custom boost on default target detected. Redirecting swap target to Thermal Boost (Boost_Propulsion_SF.upk) to prevent crash.`);
        swap.targetFile = 'Boost_Propulsion_SF.upk';
        swap.targetLabel = 'Thermal Boost';
      }
    }

    // Redirect legacy colored boost swaps (e.g. Standard Purple -> Standard) to paint-only mode to prevent crash
    const getLegacyBoostColor = (src, tgt) => {
      if (!src || !tgt) return null;
      const srcMatch = src.match(/^Boost_(Standard|Flamethrower)(?:_([a-zA-Z]+))?_SF\.upk$/i);
      const tgtMatch = tgt.match(/^Boost_(Standard|Flamethrower)_SF\.upk$/i);
      if (srcMatch && tgtMatch && srcMatch[1].toLowerCase() === tgtMatch[1].toLowerCase()) {
        const color = srcMatch[2] ? srcMatch[2].toLowerCase() : null;
        if (color) return color;
      }
      return null;
    };

    const legacyColor = getLegacyBoostColor(swap.sourceFile, swap.targetFile);
    if (legacyColor) {
      this.logger.info(`SwapEngine: legacy boost detected. Redirecting to paint-only mode. Color: ${legacyColor}`);
      const colorMap = {
        'blue': 'cobalt',
        'green': 'forest_green',
        'yellow': 'saffron',
        'pink': 'pink',
        'purple': 'purple',
        'red': 'crimson'
      };
      swap.paintColor = colorMap[legacyColor] || legacyColor;
      swap.sourceFile = swap.targetFile;
    }

    const { targetFile, sourceFile, sourceLabel, targetLabel } = swap;
    this.logger.info(`Swap requested: ${sourceLabel} -> ${targetLabel}`);

    try {
      const targetPath = path.isAbsolute(targetFile) ? targetFile : path.join(this.cookedDir, targetFile);
      const targetFilename = path.isAbsolute(targetFile) ? path.basename(targetFile) : targetFile;
      const backupPath = path.join(this.backupDir, targetFilename).replace(/\\/g, '/');

      if (!fs.existsSync(targetPath)) throw new Error(`Target not found: ${targetFile}`);

      // --- PAINT-ONLY MODE ---
      // If paintColor is set and no actual file swap is needed (sourceFile === targetFile,
      // or sourceFile is empty/missing), skip the file copy entirely.
      // Always restore from backup first so we paint the original, unmodified file.
      const isSameFile = !sourceFile || path.basename(sourceFile) === path.basename(targetFile);
      const isPaintOnly = isSameFile && swap.paintColor && swap.paintColor !== 'none';

      // Backup original target before any modification
      this._backup(targetFilename);

      // Texture companion helper
      const getTextureCompanion = (filename) => {
        if (filename.toLowerCase().endsWith('_sf.upk')) {
          return filename.slice(0, -7) + '_T_SF.upk';
        }
        return null;
      };

      const targetTexFilename = getTextureCompanion(targetFilename);
      if (targetTexFilename) {
        this._backup(targetTexFilename);
      }

      if (!isSameFile) {
        // Shift method: decrypt source with its key, re-encrypt with target key from backup
        const sourcePath = path.isAbsolute(sourceFile) ? sourceFile : path.join(this.cookedDir, sourceFile);
        if (!fs.existsSync(sourcePath)) throw new Error(`Source not found: ${sourceFile}`);

        // Swap main file
        fs.copyFileSync(sourcePath, targetPath);

        const { execSync } = require('child_process');
        const swapScriptPath = path.join(__dirname, '..', 'python', 'swap_package_names.py').replace('app.asar', 'app.asar.unpacked');
        const srcBase = path.basename(sourceFile, '.upk');
        const tgtBase = path.basename(targetFile, '.upk');

        const swapCmd = `python "${swapScriptPath}" "${targetPath}" "${srcBase}" "${tgtBase}" "${backupPath}" "${sourcePath}"`;
        this.logger.info(`Running swap: ${swapCmd}`);
        try {
          const stdout = execSync(swapCmd, { encoding: 'utf8' });
          this.logger.info(`Swap output: ${stdout}`);
        } catch (swapErr) {
          this.logger.error(`SwapEngine: swap failed: ${swapErr.message}`);
          if (swapErr.stdout) this.logger.error(`Stdout: ${swapErr.stdout.toString()}`);
          if (swapErr.stderr) this.logger.error(`Stderr: ${swapErr.stderr.toString()}`);
          throw new Error(`Swap failed: ${swapErr.stdout || swapErr.message}`);
        }

        // Swap texture companion if it exists
        if (targetTexFilename) {
          const sourceTexFilename = getTextureCompanion(path.basename(sourceFile));
          if (sourceTexFilename) {
            const sourceTexPath = path.join(path.dirname(sourcePath), sourceTexFilename);
            const targetTexPath = path.join(this.cookedDir, targetTexFilename);
            const backupTexPath = path.join(this.backupDir, targetTexFilename).replace(/\\/g, '/');

            if (fs.existsSync(sourceTexPath)) {
              this.logger.info(`SwapEngine: texture companion detected — swapping ${sourceTexFilename} -> ${targetTexFilename}`);
              fs.copyFileSync(sourceTexPath, targetTexPath);
              
              const srcTexBase = path.basename(sourceTexFilename, '.upk');
              const tgtTexBase = path.basename(targetTexFilename, '.upk');
              const swapTexCmd = `python "${swapScriptPath}" "${targetTexPath}" "${srcTexBase}" "${tgtTexBase}" "${backupTexPath}" "${sourceTexPath}"`;
              this.logger.info(`Running texture swap: ${swapTexCmd}`);
              try {
                const stdout = execSync(swapTexCmd, { encoding: 'utf8' });
                this.logger.info(`Texture swap output: ${stdout}`);
              } catch (swapTexErr) {
                this.logger.error(`SwapEngine: texture swap failed: ${swapTexErr.message}`);
                if (swapTexErr.stdout) this.logger.error(`Stdout: ${swapTexErr.stdout.toString()}`);
                if (swapTexErr.stderr) this.logger.error(`Stderr: ${swapTexErr.stderr.toString()}`);
              }
            } else {
              this.logger.info(`SwapEngine: texture companion ${sourceTexFilename} not found on disk, skipping texture swap`);
            }
          }
        }

      } else if (isPaintOnly) {
        // Paint-only: restore original from backup so we always paint the vanilla file
        if (fs.existsSync(backupPath)) {
          this.logger.info(`SwapEngine: paint-only mode — restoring original from backup before painting`);
          fs.copyFileSync(backupPath, targetPath);
        } else {
          this.logger.info(`SwapEngine: paint-only mode — no backup yet, painting current file`);
        }
        // Also restore texture companion if it exists
        if (targetTexFilename) {
          const backupTexPath = path.join(this.backupDir, targetTexFilename).replace(/\\/g, '/');
          const targetTexPath = path.join(this.cookedDir, targetTexFilename);
          if (fs.existsSync(backupTexPath)) {
            this.logger.info(`SwapEngine: paint-only mode — restoring texture companion original from backup`);
            fs.copyFileSync(backupTexPath, targetTexPath);
          }
        }
      }

      // --- AUTOMATIC ITEM PAINTING ---
      if (swap.paintColor && swap.paintColor !== 'none') {
        this.logger.info(`SwapEngine: item painting requested (${swap.paintColor})`);
        try {
          const { execSync } = require('child_process');
          const scriptPath = path.join(__dirname, '..', 'python', 'paint_item.py').replace('app.asar', 'app.asar.unpacked');
          const cmd = `python "${scriptPath}" "${targetPath}" "${swap.paintColor}" "${backupPath}"`;
          this.logger.info(`Running paint command: ${cmd}`);
          const stdout = execSync(cmd, { encoding: 'utf8' });
          this.logger.info(`Paint output: ${stdout}`);
        } catch (paintErr) {
          this.logger.error(`SwapEngine: painting failed: ${paintErr.message}`);
          if (paintErr.stdout) this.logger.error(`Stdout: ${paintErr.stdout.toString()}`);
          if (paintErr.stderr) this.logger.error(`Stderr: ${paintErr.stderr.toString()}`);
          throw new Error(`Painting failed: ${paintErr.stderr || paintErr.message}`);
        }
      }

      const entry = {
        id: `${targetFile}_${Date.now()}`,
        installCookedDir: this.cookedDir,
        installSource: this.settings.get('target').source,
        sourceFile,
        sourceLabel,
        targetFile,
        targetLabel,
        paintColor: swap.paintColor || 'none',
        timestamp: new Date().toISOString()
      };

      // Remove duplicate if same targetFile already swapped
      this.swaps = this.swaps.filter(s => s.targetFile !== targetFile);
      this.swaps.push(entry);
      this._saveSwaps();

      this.logger.info(`Swap applied: ${sourceFile} -> ${targetFile}`);
      return { ok: true, entry };
    } catch (err) {
      this.logger.error(`Swap failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  // ── Revert a single swap ─────────────────────
  async revertSwap(swapId) {
    const swap = this.swaps.find(s => s.id === swapId);
    if (!swap) return { ok: false, error: 'Swap not found' };

    const targetFilename = path.isAbsolute(swap.targetFile) ? path.basename(swap.targetFile) : swap.targetFile;
    const ok = this._restore(targetFilename);
    if (ok) {
      // Also restore texture companion if it exists
      const getTextureCompanion = (filename) => {
        if (filename.endsWith('_SF.upk')) {
          return filename.slice(0, -7) + '_T_SF.upk';
        }
        return null;
      };
      const targetTexFile = getTextureCompanion(targetFilename);
      if (targetTexFile) {
        this._restore(targetTexFile);
      }

      this.swaps = this.swaps.filter(s => s.id !== swapId);
      this._saveSwaps();
      this.logger.info(`Reverted swap: ${swap.targetFile}`);
      return { ok: true };
    }
    return { ok: false, error: 'Backup not found' };
  }

  // ── Revert all swaps ─────────────────────────
  async revertAll() {
    const results = [];
    for (const swap of [...this.swaps]) {
      results.push(await this.revertSwap(swap.id));
    }
    return results;
  }

  // ── Apply ball pack ──────────────────────────
  async applyBallPack(pack) {
    const packDir = path.join(this.appData, 'BallPacks', pack.name);
    if (!fs.existsSync(packDir)) return { ok: false, error: 'Pack not found' };

    const files = fs.readdirSync(packDir).filter(f => f.endsWith('.upk'));
    const results = [];
    for (const file of files) {
      const src = path.join(packDir, file);
      const dst = path.join(this.cookedDir, file);
      if (fs.existsSync(dst)) {
        this._backup(file);
        fs.copyFileSync(src, dst);
        this.logger.info(`ball-pack: applied ${file}`);
        results.push(file);
      }
    }
    return { ok: true, applied: results };
  }

  // ── Apply decal pack ─────────────────────────
  async applyDecalPack(pack) {
    const packDir = path.join(this.appData, 'DecalPacks', pack.name);
    if (!fs.existsSync(packDir)) return { ok: false, error: 'Pack not found' };

    const files = fs.readdirSync(packDir).filter(f => f.endsWith('.upk'));
    const results = [];
    for (const file of files) {
      const src = path.join(packDir, file);
      const dst = path.join(this.cookedDir, file);
      if (fs.existsSync(dst)) {
        this._backup(file);
        fs.copyFileSync(src, dst);
        results.push(file);
      }
    }
    return { ok: true, applied: results };
  }

  // ── Apply HUD meter pack ─────────────────────
  async applyHudPack(pack) {
    const packDir = path.join(this.appData, 'HudMeterPacks', pack.name);
    if (!fs.existsSync(packDir)) return { ok: false, error: 'Pack not found' };

    const files = fs.readdirSync(packDir).filter(f => f.endsWith('.upk'));
    const results = [];
    for (const file of files) {
      const src = path.join(packDir, file);
      const dst = path.join(this.cookedDir, file);
      if (fs.existsSync(dst)) {
        this._backup(file);
        fs.copyFileSync(src, dst);
        results.push(file);
      }
    }
    return { ok: true, applied: results };
  }

  // ── List active swaps ─────────────────────────
  listSwaps() { return this.swaps; }
  getCatalog(opts = {}) {
    const DEFAULTS_BY_CATEGORY = {
      'Anthems': 'album_anthem_monstercatgeneral_SF.upk',
      'Antennas': 'antenna_classic_SF.upk',
      'AvatarBorders': 'AvatarBorder_Default_SF.upk',
      'Bodies': 'Body_Octane_SF.upk',
      'Decals': 'body_octane_premium_skins_SF.upk',
      'Boosts': 'Boost_Propulsion_SF.upk',
      'EngineSounds': 'EngineAudio_Car01_OE_SF.upk',
      'GoalExplosions': 'Explosion_Default_SF.upk',
      'Toppers': 'hat_halo_SF.upk',
      'PaintFinishes': 'PaintFinish_Default_SF.upk',
      'PlayerBanners': 'playerbanner_classicpickup_SF.upk',
      'Trails': 'ss_default_SF.upk',
      'Wheels': 'wheel_7spoke_SF.upk'
    };

    let list = this.catalog;

    if (opts.category && opts.category !== 'All') {
      list = list.filter(item => {
        const type = item.category || item.type || '';
        return type.toLowerCase() === opts.category.toLowerCase();
      });
    }

    if (opts.search) {
      const query = opts.search.toLowerCase().trim();
      const ALIASES = {
        'miku': ['miku', 'future', 'vocaloid', 'hatsune', 'animesmoke', 'anime', 'futureutopia', 'futureglasses', 'futurewave'],
        'hatsune': ['miku', 'future', 'vocaloid', 'hatsune', 'animesmoke', 'anime'],
        'vocaloid': ['miku', 'future', 'vocaloid', 'hatsune', 'animesmoke', 'anime'],
        'mcqueen': ['kachow', 'mcqueen', 'rusteze', '95'],
        'lightning': ['kachow', 'mcqueen', 'rusteze', '95'],
        'nissan': ['skyline', 'nissan', 'gtr'],
        'skyline': ['skyline', 'nissan', 'gtr'],
        'porsche': ['porsche', 'germansports', '911'],
        'lambo': ['lambo', 'lamborghini', 'bull', 'huracan', 'countach'],
        'lamborghini': ['lambo', 'lamborghini', 'bull', 'huracan', 'countach'],
        'ferrari': ['ferrari', 'redsports', '296'],
        'bmw': ['bmw', 'bavaria', 'm2', 'i4'],
        'cybertruck': ['cyber', 'cybertruck', 'tesla'],
        'tesla': ['cyber', 'cybertruck', 'tesla']
      };

      const searchTerms = ALIASES[query] || [query];

      list = list.filter(item => {
        const realName = this.getRealItemName(item).toLowerCase();
        const code = (item.code || item.id || '').toLowerCase();
        return searchTerms.some(term => realName.includes(term) || code.includes(term));
      });
    }

    const limit = opts.limit || 150;
    const sliced = list.slice(0, limit);

    return sliced.map(item => {
      const type = item.category || item.type || 'Item';
      const targetFile = DEFAULTS_BY_CATEGORY[type] || item.file || item.targetFile || '';
      const name = this.getRealItemName(item);
      let image = this.thumbnailsMap ? (this.thumbnailsMap[name.toLowerCase()] || '') : '';
      if (!image) {
        if (type === 'Decals' && name.includes(':')) {
          const decalName = name.split(':')[1].trim().toLowerCase();
          image = this.thumbnailsMap ? (this.thumbnailsMap[decalName] || '') : '';
          if (image) {
            this.thumbnailsMap[name.toLowerCase()] = image;
          }
        }
      }
      // Fallback for painted variants: "Fennec T" -> use "Fennec" image
      if (!image && name.endsWith(' T')) {
        const baseName = name.slice(0, -2).trim().toLowerCase();
        image = this.thumbnailsMap ? (this.thumbnailsMap[baseName] || '') : '';
        if (image) {
          this.thumbnailsMap[name.toLowerCase()] = image; // cache alias
        }
      }
      // Fallback for Decals of specific car bodies: "Fennec: Distortion" -> use "Fennec" body image
      if (!image && type === 'Decals' && name.includes(':')) {
        const bodyName = name.split(':')[0].trim().toLowerCase();
        image = this.thumbnailsMap ? (this.thumbnailsMap[bodyName] || '') : '';
        if (image) {
          this.thumbnailsMap[name.toLowerCase()] = image; // cache alias
        }
      }
      if (!image) {
        this.queueThumbnailResolution(name, type);
      }
      return {
        id: item.code || item.id,
        name,
        type,
        targetFile,
        sourceFile: item.file || item.sourceFile || '',
        validation: item.validation || 'supported',
        image
      };
    });
  }

  listBallPacks() {
    const dir = path.join(this.appData, 'BallPacks');
    return this._listPacks(dir);
  }

  listDecalPacks() {
    const dir = path.join(this.appData, 'DecalPacks');
    return this._listPacks(dir);
  }

  listHudPacks() {
    const dir = path.join(this.appData, 'HudMeterPacks');
    return this._listPacks(dir);
  }

  _listPacks(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => fs.statSync(path.join(dir, f)).isDirectory())
      .map(name => {
        const infoPath = path.join(dir, name, 'info.json');
        let info = { name, description: '', author: '', version: '1.0' };
        try { info = { ...info, ...JSON.parse(fs.readFileSync(infoPath, 'utf8')) }; } catch (_) {}
        return info;
      });
  }

  // ── Presets ───────────────────────────────────
  getPresets() { return this.presets; }

  savePreset(name) {
    const existing = this.presets.presets.findIndex(p => p.name === name);
    const preset = { name, swaps: [...this.swaps] };
    if (existing >= 0) this.presets.presets[existing] = preset;
    else this.presets.presets.push(preset);
    this.presets.currentPreset = name;
    this._savePresets();
    return this.presets;
  }

  async loadPreset(name) {
    const preset = this.presets.presets.find(p => p.name === name);
    if (!preset) return { ok: false, error: 'Preset not found' };
    await this.revertAll();
    for (const swap of preset.swaps) await this.applySwap(swap);
    this.presets.currentPreset = name;
    this._savePresets();
    return { ok: true };
  }

  deletePreset(name) {
    this.presets.presets = this.presets.presets.filter(p => p.name !== name);
    this._savePresets();
    return this.presets;
  }

  _saveSwaps() { fs.writeFileSync(this.swapsFile, JSON.stringify(this.swaps, null, 2)); }
  _savePresets() { fs.writeFileSync(this.presetsFile, JSON.stringify(this.presets, null, 2)); }

  // Expose hash for canary
  async hashFile(filename) {
    const filePath = path.join(this.cookedDir, filename);
    return new Promise((resolve) => {
      try {
        if (!fs.existsSync(filePath)) {
          resolve(null);
          return;
        }
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        let size = 0;
        stream.on('data', (chunk) => {
          size += chunk.length;
          hash.update(chunk);
        });
        stream.on('end', () => {
          const h = hash.digest('hex');
          resolve(`${size}:${h.slice(0, 16)}`);
        });
        stream.on('error', () => {
          resolve(null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }
  async initThumbnailsMap() {
    const mapFile = path.join(this.appData, 'thumbnails_map.json');
    if (fs.existsSync(mapFile)) {
      try {
        this.thumbnailsMap = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
        if (this.thumbnailsMap) {
          delete this.thumbnailsMap[""];
          delete this.thumbnailsMap["undefined"];
          // Self-heal cache: delete any generic question marks or wrong engine.png matches
          let changed = false;
          for (const [k, v] of Object.entries(this.thumbnailsMap)) {
            if (v && (v.includes('bd07f7dd801478026052') || v.includes('engine.png'))) {
              delete this.thumbnailsMap[k];
              changed = true;
            }
          }
          if (changed) {
            try {
              fs.writeFileSync(mapFile, JSON.stringify(this.thumbnailsMap, null, 2));
              this.logger.info(`SwapEngine: Cleaned up placeholder and failed painted thumbnails in thumbnails_map.json`);
            } catch (_) {}
          }
        }
        this.logger.info(`SwapEngine: Loaded thumbnails map from cache (${Object.keys(this.thumbnailsMap).length} items)`);
        return;
      } catch (err) {
        this.logger.error(`SwapEngine: Failed to load cached thumbnails map: ${err.message}`);
      }
    }

    this.logger.info(`SwapEngine: Downloading thumbnails map from GitHub...`);
    try {
      const fetch = require('node-fetch');
      const res = await fetch('https://cdn.jsdelivr.net/gh/kaiserdj/rl-garage-assets@main/output/data.json');
      const rawData = await res.json();
      
      const map = {};
      if (Array.isArray(rawData)) {
        for (const item of rawData) {
          if (item.name && item.src) {
            map[item.name.toLowerCase()] = item.src;
          }
        }
      }

      fs.writeFileSync(mapFile, JSON.stringify(map, null, 2));
      this.thumbnailsMap = map;
      this.logger.info(`SwapEngine: Created and cached thumbnails map (${Object.keys(this.thumbnailsMap).length} items)`);
    } catch (err) {
      this.thumbnailsMap = {};
      this.logger.error(`SwapEngine: Failed to fetch thumbnails map: ${err.message}`);
    }
  }

  async refreshCatalog(onProgress) {
    if (onProgress) onProgress({ phase: 'scan', progress: 0 });
    const addedCount = this.scanLocalCookedPCForNewItems() || 0;
    if (onProgress) onProgress({ phase: 'scan', progress: 100 });

    if (onProgress) onProgress({ phase: 'download', progress: 0 });
    const mapFile = path.join(this.appData, 'thumbnails_map.json');
    try {
      const fetch = require('node-fetch');
      const url = 'https://cdn.jsdelivr.net/gh/kaiserdj/rl-garage-assets@main/output/data.json';
      
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 RocketCroc' },
        timeout: 15000
      });
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);

      const total = parseInt(res.headers.get('content-length'), 10) || 0;
      let loaded = 0;
      const chunks = [];

      for await (const chunk of res.body) {
        chunks.push(chunk);
        loaded += chunk.length;
        if (total > 0 && onProgress) {
          const progress = Math.min(100, Math.round((loaded / total) * 100));
          onProgress({ phase: 'download', progress });
        }
      }

      const buffer = Buffer.concat(chunks);
      const rawData = JSON.parse(buffer.toString('utf8'));

      const map = {};
      if (Array.isArray(rawData)) {
        for (const item of rawData) {
          if (item.name && item.src) {
            map[item.name.toLowerCase()] = item.src;
          }
        }
      }

      fs.writeFileSync(mapFile, JSON.stringify(map, null, 2));
      this.thumbnailsMap = map;
      this.logger.info(`SwapEngine: Catalog refresh complete, updated thumbnails map (${Object.keys(this.thumbnailsMap).length} items)`);
      if (onProgress) onProgress({ phase: 'complete', progress: 100, count: Object.keys(this.thumbnailsMap).length, addedCount });
      return { ok: true, count: Object.keys(this.thumbnailsMap).length, addedCount };
    } catch (err) {
      this.logger.error(`SwapEngine: Catalog refresh failed: ${err.message}`);
      if (onProgress) onProgress({ phase: 'failed', progress: 0, error: err.message });
      return { ok: false, error: err.message };
    }
  }

  isThumbnailPresent(name, category, allowFailed = false) {
    if (!this.thumbnailsMap) return false;
    const key = name.toLowerCase();
    const val = this.thumbnailsMap[key];
    if (val !== undefined && (allowFailed || val !== '')) return true;

    // Fallback for painted variants: "Fennec T" -> try "Fennec"
    if (key.endsWith(' t')) {
      const baseKey = key.slice(0, -2).trim();
      const baseVal = this.thumbnailsMap[baseKey];
      if (baseVal !== undefined && (allowFailed || baseVal !== '')) return true;
    }

    // Split fallback for decals (e.g. "Octane: Distortion" -> use "Distortion" icon)
    if (category === 'Decals' && name.includes(':')) {
      const decalName = name.split(':')[1].trim().toLowerCase();
      const decalVal = this.thumbnailsMap[decalName];
      if (decalVal !== undefined && (allowFailed || decalVal !== '')) {
        return true;
      }
      // Fallback to car body image: "Fennec: Distortion" -> try "Fennec"
      const bodyName = name.split(':')[0].trim().toLowerCase();
      const bodyVal = this.thumbnailsMap[bodyName];
      if (bodyVal !== undefined && (allowFailed || bodyVal !== '')) {
        return true;
      }
    }
    return false;
  }

  getMissingThumbnailsInfo() {
    this.scanLocalCookedPCForNewItems();
    if (!this.thumbnailsMap) this.thumbnailsMap = {};
    const SKIP_CATEGORIES = new Set(['Anthems']);
    let downloadedCount = 0;
    const missing = [];

    for (const item of this.catalog) {
      if (SKIP_CATEGORIES.has(item.category)) continue;
      const name = this.getRealItemName(item);
      if (this.isThumbnailPresent(name, item.category, false)) {
        downloadedCount++;
      } else {
        if (!this.isThumbnailPresent(name, item.category, true)) {
          missing.push(item);
        }
      }
    }

    const missingCount = missing.length;
    const weightMB = (missingCount * 0.025).toFixed(1);
    return {
      downloadedCount,
      missingCount,
      weightMB,
      totalCatalog: this.catalog.length
    };
  }

  async downloadMissingThumbnails(onProgress, force = false) {
    if (!this.thumbnailsMap) this.thumbnailsMap = {};

    const SKIP_CATEGORIES = new Set(['Anthems']);
    const missing = this.catalog.filter(item => {
      if (SKIP_CATEGORIES.has(item.category)) return false;
      const name = this.getRealItemName(item);
      return force || !this.isThumbnailPresent(name, item.category, true);
    });

    const total = missing.length;
    if (total === 0) {
      if (onProgress) onProgress({ phase: 'thumbnails-complete', progress: 100, resolved: 0, total: 0 });
      return { ok: true, resolved: 0, total: 0 };
    }

    this.logger.info(`SwapEngine: Downloading thumbnails for ${total} missing items with parallel batching...`);
    let resolved = 0;
    let processed = 0;
    const mapFile = path.join(this.appData, 'thumbnails_map.json');

    // High-speed concurrent worker pool (15 parallel requests)
    const CONCURRENCY = 15;
    const queue = [...missing];

    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        const name = this.getRealItemName(item);
        if (!force && this.isThumbnailPresent(name, item.category, true)) {
          processed++;
          continue;
        }
        const nameLower = name.toLowerCase();

        try {
          const url = this.getRlgUrl(name, item.category);
          if (url) {
            const imageUri = await this.scrapeRlgImage(url);
            this.thumbnailsMap[nameLower] = imageUri || '';
            if (imageUri) {
              resolved++;
              this.emit('thumbnail-resolved', { name: name, image: imageUri });
            }
          } else {
            this.thumbnailsMap[nameLower] = '';
          }
        } catch (err) {
          this.thumbnailsMap[nameLower] = '';
        }

        processed++;
        const progress = Math.round((resolved / total) * 100);
        if (onProgress && processed % 5 === 0) {
          onProgress({ phase: 'thumbnails', progress, resolved, total, current: name });
        }
      }
    };

    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // Final save
    try { fs.writeFileSync(mapFile, JSON.stringify(this.thumbnailsMap, null, 2)); } catch (_) {}
    if (onProgress) onProgress({ phase: 'thumbnails-complete', progress: 100, resolved, total });
    this.logger.info(`SwapEngine: Downloaded ${resolved}/${total} missing thumbnails.`);
    return { ok: true, resolved, total };
  }


  checkNewLocalItems() {
    if (!this.cookedDir || !fs.existsSync(this.cookedDir)) return 0;
    try {
      const files = fs.readdirSync(this.cookedDir);
      const upkFiles = files.filter(f => f.toLowerCase().endsWith('.upk'));
      const existingFiles = new Set(this.catalog.map(item => item.file.toLowerCase()));
      
      let count = 0;
      const prefixes = [
        'album_anthem_', 'antenna_', 'avatarborder_', 'body_', 'boost_', 'decal_',
        'engineaudio_', 'explosion_', 'hat_', 'paintfinish_', 'playerbanner_', 'ss_', 'trail_', 'wheel_'
      ];

      for (const file of upkFiles) {
        const fileLower = file.toLowerCase();
        if (existingFiles.has(fileLower)) continue;

        let matches = false;
        for (const p of prefixes) {
          if (fileLower.startsWith(p)) { matches = true; break; }
        }
        if (!matches && fileLower.includes('_skins')) {
          matches = true;
        }
        if (matches) count++;
      }
      return count;
    } catch (err) {
      this.logger.error(`SwapEngine: Error checking for new local items: ${err.message}`);
      return 0;
    }
  }

  getSwaps() { return this.swaps; }

  async queueThumbnailResolution(name, category) {
    if (category === 'Anthems') return; // Anthems have no images

    const nameLower = name.toLowerCase();
    if (this.thumbnailsMap && this.thumbnailsMap[nameLower] !== undefined) return; // already resolved or failed

    if (category === 'Decals' && name.includes(':')) {
      const decalName = name.split(':')[1].trim().toLowerCase();
      if (this.thumbnailsMap && this.thumbnailsMap[decalName] !== undefined && this.thumbnailsMap[decalName] !== '') {
        const imageUri = this.thumbnailsMap[decalName];
        this.thumbnailsMap[nameLower] = imageUri;
        const mapFile = path.join(this.appData, 'thumbnails_map.json');
        try {
          fs.writeFileSync(mapFile, JSON.stringify(this.thumbnailsMap, null, 2));
        } catch (_) {}
        this.emit('thumbnail-resolved', { name, image: imageUri });
        return;
      }
    }

    if (!this._resolveQueueSet) this._resolveQueueSet = new Set();
    if (!this._resolveQueue) this._resolveQueue = [];

    if (this._resolveQueueSet.has(nameLower)) return;

    this._resolveQueueSet.add(nameLower);
    this._resolveQueue.push({ name, category });

    this.processResolveQueue();
  }

  async processResolveQueue() {
    if (this._isResolving) return;
    this._isResolving = true;

    while (this._resolveQueue && this._resolveQueue.length > 0) {
      const { name, category } = this._resolveQueue.shift();
      const nameLower = name.toLowerCase();
      
      try {
        const url = this.getRlgUrl(name, category);
        if (url) {
          const imageUri = await this.scrapeRlgImage(url);
          
          // Store either the resolved URI or empty string (failed/not found) to prevent retry loops
          this.thumbnailsMap[nameLower] = imageUri || '';
          
          // Save thumbnails map to cache file
          const mapFile = path.join(this.appData, 'thumbnails_map.json');
          fs.writeFileSync(mapFile, JSON.stringify(this.thumbnailsMap, null, 2));

          if (imageUri) {
            this.logger.info(`Resolved and cached thumbnail for ${name} (${category}): ${imageUri}`);
            this.emit('thumbnail-resolved', { name, image: imageUri });
          } else {
            this.logger.info(`No thumbnail found for ${name} (${category}), cached empty fallback`);
          }
        } else {
          // No URL for this category - mark as empty immediately to prevent re-queuing
          this.thumbnailsMap[nameLower] = '';
        }
      } catch (err) {
        this.logger.error(`Failed to resolve thumbnail for ${name} (${category}): ${err.message}`);
        this.thumbnailsMap[nameLower] = '';
      }

      this._resolveQueueSet.delete(nameLower);
      // Rate limit to avoid getting blocked (reduced from 800ms)
      await new Promise(resolve => setTimeout(resolve, 150));
    }

    this._isResolving = false;
  }

  getRlgUrl(name, category) {
    let cleanName = name;
    // Strip painted ' T' suffix so we query the base item URL (rocket-league.com hosts all paints on the base page)
    if (cleanName.toLowerCase().endsWith(' t')) {
      cleanName = cleanName.slice(0, -2).trim();
    }

    const getSlug = (str) => {
      return str.toLowerCase()
        .replace(/[àáâãäå]/g, 'a')
        .replace(/[èéêë]/g, 'e')
        .replace(/[ìíîï]/g, 'i')
        .replace(/[òóôõö]/g, 'o')
        .replace(/[ùúûü]/g, 'u')
        .replace(/[ç]/g, 'c')
        .replace(/[ñ]/g, 'n')
        .replace(/\./g, '')
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    };

    const mapping = {
      'Antennas': 'antennas',
      'Bodies': 'bodies',
      'Decals': 'decals',
      'Boosts': 'boosts',
      'EngineSounds': 'engine-sounds',
      'GoalExplosions': 'goal-explosions',
      'Toppers': 'toppers',
      'PaintFinishes': 'paint-finishes',
      'PlayerBanners': 'player-banners',
      'Trails': 'trails',
      'Wheels': 'wheels',
      'AvatarBorders': 'avatar-borders'
    };

    const catSlug = mapping[category];
    if (!catSlug) return null;

    if (category === 'Decals' && cleanName.includes(':')) {
      const parts = cleanName.split(':');
      const bodySlug = getSlug(parts[0].trim());
      const decalSlug = getSlug(parts[1].trim());
      return `https://rocket-league.com/items/decals/${bodySlug}/${decalSlug}`;
    }

    const itemSlug = getSlug(cleanName);
    return `https://rocket-league.com/items/${catSlug}/${itemSlug}`;
  }

  async scrapeRlgImage(url) {
    // Known generic placeholder image hashes - treat as "not found"
    const PLACEHOLDER_HASHES = [
      'bd07f7dd801478026052',
      'engine',
    ];
    const fetch = require('node-fetch');
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 10000
      });
      if (res.status === 301 || res.status === 302 || res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`Status ${res.status}`);
      }
      const data = await res.text();
      // Match the main item image via og:image or twitter:image meta tags
      const match = data.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) || 
                    data.match(/<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i);
      if (match) {
        let imgUrl = match[1];
        if (!imgUrl.startsWith('http')) {
          imgUrl = 'https://rocket-league.com' + imgUrl;
        }
        // Filter out known generic placeholder images
        if (PLACEHOLDER_HASHES.some(h => imgUrl.includes(h))) {
          return null;
        }
        return imgUrl;
      }
    } catch (err) {
      this.logger.error(`scrapeRlgImage error for ${url}: ${err.message}`);
    }
    return null;
  }
}

module.exports = SwapEngine;
