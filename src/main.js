const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, screen, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Optimize Chromium resource usage and ensure instantaneous window restoration
app.commandLine.appendSwitch('js-flags', '--expose-gc --max-old-space-size=512');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('wm-window-animations-disabled');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,LazyFrameLoading');

const SwapEngine = require('./modules/swapEngine');
const CanarySystem = require('./modules/canarySystem');
const TrackerModule = require('./modules/tracker');
const WorkshopModule = require('./modules/workshop');
const PluginSystem = require('./modules/pluginSystem');
const SettingsManager = require('./modules/settings');
const Logger = require('./modules/logger');
const BakkesPluginsModule = require('./modules/bakkesplugins');
const { tgaToDataUri } = require('./modules/tgaDecoder');
const { spawn } = require('child_process');

const APP_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'Ascend');
const isDev = process.argv.includes('--dev');

// Single instance lock — prevent multiple RocketCroc processes
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to open a second instance — focus the existing window
    restoreAndShowMainWindow();
  });
}

let mainWindow = null;
let overlayWindow = null;
let rosterWindow = null;
let noMatchWindow = null;
let tray = null;
let isOverlayIntendedVisible = true;
let isRosterIntendedVisible = false;

// Ensure app data dirs exist
const dirs = ['Backups/Epic', 'BallPacks', 'DecalPacks', 'HudMeterPacks', 'plugins', 'logs', 'workshop', 'thumbnails', 'assets/IngameRank'];
dirs.forEach(d => fs.mkdirSync(path.join(APP_DATA, d), { recursive: true }));

function copyFolderSync(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from).forEach(element => {
    const f = path.join(from, element);
    const t = path.join(to, element);
    if (fs.lstatSync(f).isDirectory()) {
      copyFolderSync(f, t);
    } else {
      fs.copyFileSync(f, t);
    }
  });
}

const localAssetsSource = path.join(__dirname, '../assets/IngameRank');
const localAssetsDest = path.join(APP_DATA, 'assets/IngameRank');
if (fs.existsSync(localAssetsSource)) {
  copyFolderSync(localAssetsSource, localAssetsDest);
}

const logger = new Logger(APP_DATA);
const settings = new SettingsManager(APP_DATA);
const swapEngine = new SwapEngine(APP_DATA, settings, logger);
const canary = new CanarySystem(APP_DATA, settings, swapEngine, logger);
const tracker = new TrackerModule(APP_DATA, settings, logger);
const workshop = new WorkshopModule(APP_DATA, settings, logger);
const pluginSystem = new PluginSystem(APP_DATA, logger);
const bakkesplugins = new BakkesPluginsModule(APP_DATA, settings, logger);

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: '#080a0f',
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false
    },
    title: 'Ascend'
  });

  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.show();
    logger.info('Main window shown');
    if (tracker.detectedLocalPlayer) {
      mainWindow.webContents.send('local-player-login', tracker.detectedLocalPlayer);
    }
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logger.error(`Renderer crash: reason=${details.reason} exitCode=${details.exitCode}`);
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    logger.info(`[Console] [Level ${level}] ${message} (${path.basename(sourceId)}:${line})`);
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// Helper: carica il config.json del tema RocketStats + converte tutti i .tga in data URI
function loadRocketStatsThemeConfig() {
  const cfg = settings.load();
  const themesDir = path.join(
    os.homedir(), 'AppData', 'Roaming', 'bakkesmod', 'bakkesmod',
    'data', 'RocketStats', 'RocketStats_themes'
  );
  let themeName = cfg.rocketStatsTheme || 'Circle';
  if (!fs.existsSync(path.join(themesDir, themeName))) {
    themeName = 'Circle';
  }
  const themeDir = path.join(themesDir, themeName);
  const cfgPath = path.join(themeDir, 'config.json');

  let themeConfig = null;
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    themeConfig = JSON.parse(raw);
  } catch(e) {
    logger.warn(`[Overlay] Cannot load theme config for "${themeName}": ${e.message}`);
    return { themeDir, themeConfig: null, themeName, images: {}, fonts: {} };
  }

  // Converti tutti i .tga nella cartella images/ del tema in data URI PNG
  const images = {};

  // 1. Carica prima le immagini globali da RocketStats_images
  const globalImagesDir = path.join(
    os.homedir(), 'AppData', 'Roaming', 'bakkesmod', 'bakkesmod',
    'data', 'RocketStats', 'RocketStats_images'
  );
  if (fs.existsSync(globalImagesDir)) {
    for (const file of fs.readdirSync(globalImagesDir)) {
      if (file.toLowerCase().endsWith('.tga')) {
        const fullPath = path.join(globalImagesDir, file);
        const dataUri = tgaToDataUri(fullPath, fs);
        if (dataUri) {
          images[file] = dataUri;
        }
      }
    }
  }

  // 2. Carica le immagini del tema (che sovrascrivono quelle globali se hanno lo stesso nome)
  const imagesDir = path.join(themeDir, 'images');
  if (fs.existsSync(imagesDir)) {
    for (const file of fs.readdirSync(imagesDir)) {
      if (file.toLowerCase().endsWith('.tga')) {
        const fullPath = path.join(imagesDir, file);
        const dataUri = tgaToDataUri(fullPath, fs);
        if (dataUri) {
          images[file] = dataUri;
          logger.info(`[Overlay] Converted theme image ${file} → PNG data URI (${Math.round(dataUri.length / 1024)}KB)`);
        } else {
          logger.warn(`[Overlay] Failed to convert ${file}`);
        }
      }
    }
  }

  // Carica font custom come data URI
  const fonts = {};
  const fontsDir = path.join(themeDir, 'fonts');
  if (fs.existsSync(fontsDir)) {
    for (const file of fs.readdirSync(fontsDir)) {
      const ext = path.extname(file).toLowerCase();
      if (['.ttf', '.otf', '.woff', '.woff2'].includes(ext)) {
        try {
          const fontBuf = fs.readFileSync(path.join(fontsDir, file));
          const mime = ext === '.otf' ? 'font/otf' : ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : 'font/ttf';
          fonts[file] = `data:${mime};base64,${fontBuf.toString('base64')}`;
          logger.info(`[Overlay] Loaded font ${file} as data URI`);
        } catch(e) {}
      }
    }
  }

  const scaleMultiplier = cfg.rocketStatsScaleMultiplier !== undefined ? cfg.rocketStatsScaleMultiplier : 0.70;
  const playlist = cfg.rocketStatsPlaylist || 'current';
  const showMmrDelta = cfg.rocketStatsShowMmrDelta !== undefined ? cfg.rocketStatsShowMmrDelta : true;
  return { themeDir, themeConfig, themeName, images, fonts, scaleMultiplier, playlist, showMmrDelta };
}

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const themeData = loadRocketStatsThemeConfig();
  const cfg = themeData.themeConfig;
  const appCfg = settings.load();

  // Dimensioni window dal config del tema * global scale * user multiplier
  const scaleMultiplier = themeData.scaleMultiplier || 1.0;
  const gs = ((cfg && typeof cfg.scale === 'number') ? cfg.scale : 1.0) * scaleMultiplier;
  const W = (cfg && typeof cfg.width  === 'number') ? Math.min(Math.round((cfg.width + 120) * gs) + 50, 1400) : 240;
  const H = (cfg && typeof cfg.height === 'number') ? Math.min(Math.round(cfg.height * gs) + 20, 900) : 200;

  const offsetX = appCfg.rocketStatsOffsetX !== undefined ? appCfg.rocketStatsOffsetX : 29;
  const offsetY = appCfg.rocketStatsOffsetY !== undefined ? appCfg.rocketStatsOffsetY : 78;

  overlayWindow = new BrowserWindow({
    width: W, height: H,
    x: width  - W - 10 + offsetX,
    y: height - H - 50 + offsetY,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      backgroundThrottling: false
    }
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  overlayWindow.webContents.on('console-message', (_, level, message, line, sourceId) => {
    if (level >= 2) logger.info(`[Overlay] [L${level}] ${message} (${path.basename(sourceId)}:${line})`);
  });

  overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay.html'));

  // Passa config + immagini + font dopo load
  overlayWindow.webContents.on('did-finish-load', () => {
    overlayWindow.webContents.send('overlay-init', themeData);
    overlayWindow.webContents.send('tracker-update', tracker.getSession());
    logger.info(`[Overlay] Sent theme "${themeData.themeName}" with ${Object.keys(themeData.images || {}).length} images, ${Object.keys(themeData.fonts || {}).length} fonts`);
  });

  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
}

function reloadOverlayTheme() {
  if (!overlayWindow) return;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const themeData = loadRocketStatsThemeConfig();
  const cfg = themeData.themeConfig;
  const appCfg = settings.load();
  const scaleMultiplier = themeData.scaleMultiplier || 1.0;
  const gs = ((cfg && typeof cfg.scale === 'number') ? cfg.scale : 1.0) * scaleMultiplier;
  const W = (cfg && typeof cfg.width  === 'number') ? Math.min(Math.round((cfg.width + 120) * gs) + 50, 1400) : 240;
  const H = (cfg && typeof cfg.height === 'number') ? Math.min(Math.round(cfg.height * gs) + 20, 900) : 200;

  const offsetX = appCfg.rocketStatsOffsetX !== undefined ? appCfg.rocketStatsOffsetX : 29;
  const offsetY = appCfg.rocketStatsOffsetY !== undefined ? appCfg.rocketStatsOffsetY : 78;

  overlayWindow.setSize(W, H);
  overlayWindow.setPosition(width - W - 10 + offsetX, height - H - 50 + offsetY);
  overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay.html'));
  overlayWindow.webContents.once('did-finish-load', () => {
    overlayWindow.webContents.send('overlay-init', themeData);
    overlayWindow.webContents.send('tracker-update', tracker.getSession());
    logger.info(`[Overlay] Reloaded theme "${themeData.themeName}"`);
  });
}
function showOverlay() {
  isOverlayIntendedVisible = true;
  if (!overlayWindow) {
    createOverlayWindow();
    return;
  }
  overlayWindow.show();
  overlayWindow.webContents.send('overlay-show');
  overlayWindow.webContents.send('tracker-update', tracker.getSession());
}

function hideOverlay() {
  isOverlayIntendedVisible = false;
  if (!overlayWindow) return;
  overlayWindow.webContents.send('overlay-hide');
  setTimeout(() => {
    if (!isOverlayIntendedVisible && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
    }
  }, 220);
}

function showRoster() {
  isRosterIntendedVisible = true;
  if (rosterWindow && !rosterWindow.isDestroyed()) {
    rosterWindow.webContents.send('overlay-show');
  }
  if (noMatchWindow && !noMatchWindow.isDestroyed()) {
    noMatchWindow.webContents.send('overlay-show');
  }
}

function hideRoster() {
  isRosterIntendedVisible = false;
  if (rosterWindow && !rosterWindow.isDestroyed()) {
    rosterWindow.webContents.send('overlay-hide');
  }
  if (noMatchWindow && !noMatchWindow.isDestroyed()) {
    noMatchWindow.webContents.send('overlay-hide');
  }
}

function restoreAndShowMainWindow() {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/tray.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  const menu = Menu.buildFromTemplate([
    { label: 'Open Ascend', click: () => restoreAndShowMainWindow() },
    { label: 'Toggle Overlay', click: () => {
      if (overlayWindow) {
        if (isOverlayIntendedVisible) {
          hideOverlay();
        } else {
          showOverlay();
        }
      } else {
        createOverlayWindow();
      }
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('Ascend');
  tray.on('double-click', () => restoreAndShowMainWindow());
}

app.whenReady().then(async () => {
  logger.info('=== Ascend launch ===');

  // Periodically clear cache and run garbage collection, but ONLY when not in match
  setInterval(() => {
    try {
      if (tracker && tracker.inMatch) {
        return; // Skip heavy cleanup during an active match to prevent game lag
      }
      const { session } = require('electron');
      if (session && session.defaultSession) {
        session.defaultSession.clearCache().catch(() => {});
      }
      if (global.gc) {
        global.gc();
      }
    } catch (err) {
      logger.warn(`[Memory] Optimizer error: ${err.message}`);
    }
  }, 300000); // Run every 5 minutes and only when out of a match

  // Bypass expired SSL cert for celab.jetfox.ovh (images + API)
  const { session } = require('electron');
  session.defaultSession.setCertificateVerifyProc((req, cb) => {
    if (req.hostname.includes('celab.jetfox.ovh')) { cb(0); return; }
    cb(-3); // use default verification for everything else
  });

  const cfg = settings.load();
  await swapEngine.init(cfg);
  await canary.init();
  await tracker.init(cfg);
  await workshop.init();
  await pluginSystem.init();
  await bakkesplugins.init();

  createMainWindow();
  createOverlayWindow();
  createTray();

  if (cfg.ingameRankEnabled !== false) {
    createRosterWindow();
    createNoMatchWindow();
  }

  const shortcut = cfg.bringToFrontHotkey || 'F2';
  try {
    globalShortcut.register(shortcut, () => {
      toggleOverlayWindow();
    });
    logger.info(`[Shortcut] Registered global shortcut for toggle overlay: ${shortcut}`);
  } catch (err) {
    logger.error(`[Shortcut] Failed to register global shortcut: ${err.message}`);
  }

  // Push tracker events to overlay and main window
  tracker.on('update', (data) => {
    if (overlayWindow) overlayWindow.webContents.send('tracker-update', data);
    if (mainWindow) mainWindow.webContents.send('tracker-update', data);
  });

  tracker.on('match-start', (data) => {
    if (overlayWindow) overlayWindow.webContents.send('match-start', data);
    if (mainWindow) mainWindow.webContents.send('match-start', data);
    pluginSystem.emit('onMatchStart', data);
  });

  tracker.on('match-end', (data) => {
    if (overlayWindow) overlayWindow.webContents.send('match-end', data);
    if (mainWindow) mainWindow.webContents.send('match-end', data);
    pluginSystem.emit('onMatchEnd', data);
  });

  tracker.on('local-player-login', (data) => {
    if (mainWindow) mainWindow.webContents.send('local-player-login', data);
  });

  // Roster overlay events
  tracker.on('roster-update', (data) => {
    if (rosterWindow && !rosterWindow.isDestroyed()) {
      rosterWindow.webContents.send('roster-update', data);
    }
    // Forward inMatch state so noMatchWindow knows when to show/hide itself
    if (noMatchWindow && !noMatchWindow.isDestroyed()) {
      noMatchWindow.webContents.send('roster-update', data);
    }
    if (mainWindow) mainWindow.webContents.send('roster-update', data);
  });
  tracker.on('roster-clear', () => {
    if (rosterWindow && !rosterWindow.isDestroyed()) {
      rosterWindow.webContents.send('roster-clear');
    }
    if (noMatchWindow && !noMatchWindow.isDestroyed()) {
      noMatchWindow.webContents.send('roster-clear');
    }
    if (mainWindow) mainWindow.webContents.send('roster-clear');
  });

  canary.on('drift-detected', (data) => {
    if (mainWindow) mainWindow.webContents.send('canary-drift', data);
  });

  swapEngine.on('thumbnail-resolved', (data) => {
    if (mainWindow) mainWindow.webContents.send('thumbnail-resolved', data);
  });
});

app.on('window-all-closed', (e) => e.preventDefault()); // Keep running in tray
app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  tracker.stop();
  canary.stop();
  stopInputListener();
});

// ─── IPC Handlers ───────────────────────────────────────────────

// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window-close', () => mainWindow?.hide());

// Updates & Reinstall
let latestUpdateInfo = null;

ipcMain.handle('app-check-update', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  // NOTE: simPath simulation kept for dev testing only

  // Use app.getVersion() — always correct in both dev and packaged NSIS installs
  let currentVersion = app.getVersion();

  const simPath = path.join(os.homedir(), '.gemini', 'antigravity', 'update_simulation.json');
  if (fs.existsSync(simPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(simPath, 'utf8'));
      
      const v1 = data.version || '1.0.0';
      const v2 = currentVersion;
      const parts1 = v1.split('.').map(Number);
      const parts2 = v2.split('.').map(Number);
      let isNewer = false;
      for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) { isNewer = true; break; }
        if (p1 < p2) { break; }
      }

      if (isNewer) {
        latestUpdateInfo = {
          version: data.version,
          downloadUrl: data.downloadUrl || ''
        };
        return {
          hasUpdate: true,
          version: data.version,
          releaseNotes: data.releaseNotes || 'Aggiornamento rilevato.',
          downloadUrl: data.downloadUrl || ''
        };
      }
    } catch (err) {
      logger.error(`[Updater] Failed to parse simulation file: ${err.message}`);
    }
  }

  logger.info(`[Updater] check-update requested. currentVersion=${currentVersion}`);

  // Fallback to real GitHub check (includes pre-releases)
  try {
    const res = await fetch('https://api.github.com/repos/WilloTheTuna/Ascend/releases', {
      headers: { 'User-Agent': 'Ascend-Updater' }
    });
    if (res.ok) {
      const releases = await res.json();
      if (releases && releases.length > 0) {
        const release = releases[0];
        const latestVersion = release.tag_name.replace(/^v/, '');
        
        const v1 = latestVersion;
        const v2 = currentVersion;
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);
        let isNewer = false;
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
          const p1 = parts1[i] || 0;
          const p2 = parts2[i] || 0;
          if (p1 > p2) { isNewer = true; break; }
          if (p1 < p2) { break; }
        }

        logger.info(`[Updater] GitHub release check: latestVersion=${latestVersion}, currentVersion=${currentVersion}, isNewer=${isNewer}`);

        if (isNewer) {
          const exeAsset = release.assets.find(a => a.name.endsWith('.exe'));
          if (exeAsset) {
            latestUpdateInfo = {
              version: latestVersion,
              downloadUrl: exeAsset.browser_download_url
            };
            return {
              hasUpdate: true,
              version: latestVersion,
              releaseNotes: release.body || 'New version of Ascend available.',
              downloadUrl: exeAsset.browser_download_url
            };
          }
        }
      }
    }
  } catch (err) {
    logger.error(`[Updater] GitHub update check failed: ${err.message}`);
  }

  return { hasUpdate: false, version: currentVersion };
});

ipcMain.handle('app-install-update', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const simPath = path.join(os.homedir(), '.gemini', 'antigravity', 'update_simulation.json');
  const installedVerPath = path.join(os.homedir(), '.gemini', 'antigravity', 'installed_version.txt');
  
  let downloadUrl = '';
  let version = '';

  if (latestUpdateInfo && latestUpdateInfo.downloadUrl) {
    downloadUrl = latestUpdateInfo.downloadUrl;
    version = latestUpdateInfo.version;
    try {
      fs.writeFileSync(installedVerPath, version, 'utf8');
      logger.info(`[Updater] Upgrade: saved target version ${version} to installed_version.txt`);
    } catch (err) {
      logger.error(`[Updater] Failed to write version: ${err.message}`);
    }
  } else if (fs.existsSync(simPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(simPath, 'utf8'));
      version = data.version;
      downloadUrl = data.downloadUrl;
      if (version) {
        fs.writeFileSync(installedVerPath, version, 'utf8');
        logger.info(`[Updater] Simulated upgrade: saved target version ${version} to installed_version.txt`);
      }
    } catch (err) {
      logger.error(`[Updater] Failed to write target version to installed_version.txt: ${err.message}`);
    }
  }

  if (downloadUrl) {
    try {
      logger.info(`[Updater] Starting download from: ${downloadUrl}`);
      const fetch = require('node-fetch');
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      
      const tempSetup = path.join(os.tmpdir(), `Ascend_Setup_${version || 'latest'}.exe`);
      const fileStream = fs.createWriteStream(tempSetup);
      
      await new Promise((resolve, reject) => {
        res.body.pipe(fileStream);
        res.body.on('error', reject);
        fileStream.on('finish', resolve);
      });
      
      logger.info(`[Updater] Download complete. Executing: ${tempSetup}`);
      const { shell } = require('electron');
      shell.openPath(tempSetup).then(err => {
        if (err) logger.error(`[Updater] shell.openPath failed: ${err}`);
      });
      
      setTimeout(() => {
        app.quit();
      }, 800);
      
      return { ok: true, message: 'Aggiornamento scaricato e in corso di installazione...' };
    } catch (err) {
      logger.error(`[Updater] Download failed: ${err.message}`);
      return { ok: false, error: `Download fallito: ${err.message}` };
    }
  }

  return runDesktopInstaller();
});

ipcMain.handle('app-reinstall-current', async () => {
  return runDesktopInstaller();
});

function runDesktopInstaller() {
  const { shell } = require('electron');
  const path = require('path');
  const fs = require('fs');
  const os = require('os');

  const desktopDir = path.join(os.homedir(), 'Desktop');
  if (fs.existsSync(desktopDir)) {
    const files = fs.readdirSync(desktopDir).filter(f => f.startsWith('Ascend Setup') && f.endsWith('.exe'));
    if (files.length > 0) {
      files.sort((a, b) => b.localeCompare(a));
      const installerPath = path.join(desktopDir, files[0]);
      logger.info(`[Updater] Launching installer: ${installerPath}`);
      
      shell.openPath(installerPath).then(err => {
        if (err) {
          logger.error(`[Updater] shell.openPath failed: ${err}`);
        }
      });

      setTimeout(() => {
        app.quit();
      }, 800);

      return { ok: true, message: `Avvio del setup: ${files[0]}` };
    }
  }
  return { ok: false, error: 'Setup non trovato sul Desktop. Compila prima il progetto!' };
}

// Settings
ipcMain.handle('settings-get', () => settings.load());
ipcMain.handle('settings-set', (_, data) => {
  const result = settings.save(data);
  if (data.bringToFrontHotkey) {
    try {
      globalShortcut.unregisterAll();
      globalShortcut.register(data.bringToFrontHotkey, () => {
        toggleOverlayWindow();
      });
      logger.info(`[Shortcut] Re-registered global shortcut for toggle overlay to: ${data.bringToFrontHotkey}`);
    } catch (err) {
      logger.error(`[Shortcut] Failed to re-register global shortcut: ${err.message}`);
    }
  }
  return result;
});

// Swap engine
ipcMain.handle('swap-list', () => swapEngine.listSwaps());
ipcMain.handle('swap-apply', (_, swap) => swapEngine.applySwap(swap));
ipcMain.handle('swap-revert', (_, swapId) => swapEngine.revertSwap(swapId));
ipcMain.handle('swap-revert-all', () => swapEngine.revertAll());
ipcMain.handle('catalog-get', (_, opts) => swapEngine.getCatalog(opts));
ipcMain.handle('catalog-refresh', async (event) => {
  return swapEngine.refreshCatalog((progressData) => {
    event.sender.send('catalog-refresh-progress', progressData);
  });
});
ipcMain.handle('catalog-check-new', () => swapEngine.checkNewLocalItems());

// Ball packs
ipcMain.handle('ballpacks-list', () => swapEngine.listBallPacks());
ipcMain.handle('ballpack-apply', (_, pack) => swapEngine.applyBallPack(pack));

// Decal packs
ipcMain.handle('decalpacks-list', () => swapEngine.listDecalPacks());
ipcMain.handle('decalpack-apply', (_, pack) => swapEngine.applyDecalPack(pack));

// HUD meter packs
ipcMain.handle('hudpacks-list', () => swapEngine.listHudPacks());
ipcMain.handle('hudpack-apply', (_, pack) => swapEngine.applyHudPack(pack));

// Presets
ipcMain.handle('presets-get', () => swapEngine.getPresets());
ipcMain.handle('preset-save', (_, name) => swapEngine.savePreset(name));
ipcMain.handle('preset-load', (_, name) => swapEngine.loadPreset(name));
ipcMain.handle('preset-delete', (_, name) => swapEngine.deletePreset(name));

// Tracker
ipcMain.handle('tracker-get-profile', (_, username) => tracker.fetchProfile(username));
ipcMain.handle('tracker-get-session', () => tracker.getSession());
ipcMain.handle('tracker-get-roster', () => tracker.getRoster());
ipcMain.handle('tracker-get-roster-init', () => {
  const cfg = settings.load();
  const roster = tracker.getRoster();
  let isCppEnabled = false;
  try {
    isCppEnabled = bakkesplugins.listPlugins().some(p => p.id.toLowerCase() === 'ingamerank' && p.enabled) && tracker.isTcpConnected;
  } catch (e) {}

  return {
    roster: roster.players && roster.players.length > 0 ? roster : null,
    ingameRankPath: path.join(APP_DATA, 'assets/IngameRank'),
    settings: {
      scaleMultiplier:    cfg.ingameRankScaleMultiplier !== undefined ? cfg.ingameRankScaleMultiplier : 1.0,
      showDivision:       cfg.ingameRankShowDivision !== false,
      showPlaylist:       cfg.ingameRankShowPlaylist !== false,
      holdToShow:         cfg.ingameRankHoldToShow !== false,
      calculateUnranked:  cfg.ingameRankCalculateUnranked !== false,
      includeExtramodes:  cfg.ingameRankIncludeExtramodes !== false,
      includeTournaments: cfg.ingameRankIncludeTournaments !== false,
      playlist:           cfg.ingameRankPlaylist || 'current',
      offsetX:            cfg.ingameRankOffsetX !== undefined ? cfg.ingameRankOffsetX : 0,
      offsetY:            cfg.ingameRankOffsetY !== undefined ? cfg.ingameRankOffsetY : 0,
      offsetXBlue:        cfg.ingameRankOffsetXBlue !== undefined ? cfg.ingameRankOffsetXBlue : 0,
      offsetYBlue:        cfg.ingameRankOffsetYBlue !== undefined ? cfg.ingameRankOffsetYBlue : 0,
      offsetXOrange:      cfg.ingameRankOffsetXOrange !== undefined ? cfg.ingameRankOffsetXOrange : 0,
      offsetYOrange:      cfg.ingameRankOffsetYOrange !== undefined ? cfg.ingameRankOffsetYOrange : 0,
      uiScalePercent:     cfg.ingameRankUiScalePercent !== undefined ? cfg.ingameRankUiScalePercent : 100,
      enabled:            isCppEnabled
    }
  };
});
ipcMain.handle('tracker-set-playlist', (_, playlist) => tracker.setPlaylist(playlist));
ipcMain.handle('tracker-set-active-account', (_, index) => tracker.setActiveAccount(index));
ipcMain.handle('tracker-update-usernames', (_, user1, user2) => {
  if (Array.isArray(user1)) {
    return tracker.updateUsernames(user1);
  }
  return tracker.updateUsernames(user1, user2);
});

ipcMain.handle('tracker-reset-stats', () => {
  tracker._resetSession();
  try {
    const cfgPath = path.join(
      os.homedir(), 'AppData', 'Roaming', 'bakkesmod', 'bakkesmod', 'cfg', 'config.cfg'
    );
    const cmd = 'rs_reset_stats\n';
    fs.appendFileSync(cfgPath, cmd, 'utf8');
    logger.info('[tracker-reset] rs_reset_stats written to config.cfg');
  } catch (err) {
    logger.error(`[tracker-reset] BakkesMod reset stats error: ${err.message}`);
  }
  return { ok: true };
});

// Roster overlay window toggle
ipcMain.on('roster-toggle', () => {
  toggleRosterWindow();
});

ipcMain.on('roster-force-show', () => {
  if (rosterWindow && !rosterWindow.isDestroyed()) {
    rosterWindow.webContents.send('force-preview', true);
    showRoster();
  }
});

ipcMain.on('roster-force-hide', () => {
  if (rosterWindow && !rosterWindow.isDestroyed()) {
    rosterWindow.webContents.send('force-preview', false);
    const cfg = settings.load();
    if (cfg.ingameRankHoldToShow !== false) {
      hideRoster();
    }
  }
});

let inputListenerProcess = null;
let inputRecorderProcess = null;

ipcMain.handle('settings-record-input-start', (event) => {
  return new Promise((resolve) => {
    if (inputRecorderProcess) {
      try {
        const { exec } = require('child_process');
        exec(`taskkill /F /T /PID ${inputRecorderProcess.pid}`);
      } catch (e) {}
      inputRecorderProcess = null;
    }

    stopInputListener();

    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Reflection;
using System.Collections;

public class InputRecorderHelper {
    [StructLayout(LayoutKind.Sequential)]
    public struct XINPUT_STATE {
        public uint dwPacketNumber;
        public XINPUT_GAMEPAD Gamepad;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct XINPUT_GAMEPAD {
        public ushort wButtons;
        public byte bLeftTrigger;
        public byte bRightTrigger;
        public short sThumbLX;
        public short sThumbLY;
        public short sThumbRX;
        public short sThumbRY;
    }

    [DllImport("xinput1_4.dll", EntryPoint = "XInputGetState")]
    public static extern uint XInputGetState(uint dwUserIndex, ref XINPUT_STATE pState);
    [DllImport("xinput1_3.dll", EntryPoint = "XInputGetState")]
    public static extern uint XInputGetState13(uint dwUserIndex, ref XINPUT_STATE pState);
    [DllImport("xinput9_1_0.dll", EntryPoint = "XInputGetState")]
    public static extern uint XInputGetState9(uint dwUserIndex, ref XINPUT_STATE pState);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    private static bool useXInput14 = true;
    private static bool useXInput13 = false;
    private static bool useXInput9 = false;

    private static Type rawControllerType;
    private static PropertyInfo rawsProp;
    private static PropertyInfo btnCountProp;
    private static MethodInfo getReading;
    
    private static bool[] cachedButtons;
    private static object[] cachedArgs;

    static InputRecorderHelper() {
        try {
            rawControllerType = Type.GetType("Windows.Gaming.Input.RawGameController, Windows.Gaming.Input, ContentType=WindowsRuntime");
            if (rawControllerType != null) {
                rawsProp = rawControllerType.GetProperty("RawGameControllers");
                btnCountProp = rawControllerType.GetProperty("ButtonCount");
                getReading = rawControllerType.GetMethod("GetCurrentReading");
            }
        } catch {}
    }

    public static int GetPressedXInputButton() {
        XINPUT_STATE state = new XINPUT_STATE();
        ushort[] masks = new ushort[] {
            0x0001, 0x0002, 0x0004, 0x0008,
            0x0010, 0x0020,
            0x0040, 0x0080,
            0x0100, 0x0200,
            0x1000, 0x2000, 0x4000, 0x8000
        };
        for (uint i = 0; i < 4; i++) {
            uint result = 1;
            try {
                if (useXInput14) result = XInputGetState(i, ref state);
            } catch {
                useXInput14 = false;
                useXInput13 = true;
            }
            if (useXInput13) {
                try {
                    result = XInputGetState13(i, ref state);
                } catch {
                    useXInput13 = false;
                    useXInput9 = true;
                }
            }
            if (useXInput9) {
                try {
                    result = XInputGetState9(i, ref state);
                } catch {
                    useXInput9 = false;
                }
            }
            if (result == 0) {
                foreach (ushort mask in masks) {
                    if ((state.Gamepad.wButtons & mask) != 0) {
                        return (int)mask;
                    }
                }
            }
        }
        return -1;
    }

    public static int GetPressedRawControllerButton() {
        if (rawControllerType == null || rawsProp == null || btnCountProp == null || getReading == null) return -1;
        try {
            object list = rawsProp.GetValue(null);
            if (list == null) return -1;
            IEnumerable enumerable = list as IEnumerable;
            if (enumerable == null) return -1;

            foreach (object r in enumerable) {
                int btnCount = (int)btnCountProp.GetValue(r);
                if (cachedButtons == null || cachedButtons.Length != btnCount) {
                    cachedButtons = new bool[btnCount];
                    cachedArgs = new object[] { cachedButtons, null, null };
                }

                Array.Clear(cachedButtons, 0, cachedButtons.Length);

                getReading.Invoke(r, cachedArgs);
                bool[] resButtons = (bool[])cachedArgs[0];
                for (int b = 0; b < resButtons.Length; b++) {
                    if (resButtons[b]) {
                        return b;
                    }
                }
            }
        } catch {}
        return -1;
    }
}
"@

$start = [DateTime]::Now
while (([DateTime]::Now - $start).TotalSeconds -lt 15) {
    for ($vk = 1; $vk -le 254; $vk++) {
        if ($vk -eq 1 -or $vk -eq 2) { continue }
        if (([InputRecorderHelper]::GetAsyncKeyState($vk) -band 0x8000) -ne 0) {
            Write-Output "KEY:$vk"
            exit
        }
    }

    $xBtn = [InputRecorderHelper]::GetPressedXInputButton()
    if ($xBtn -ne -1) {
        Write-Output "XINPUT:$xBtn"
        exit
    }

    $rawBtn = [InputRecorderHelper]::GetPressedRawControllerButton()
    if ($rawBtn -ne -1) {
        Write-Output "RAW:$rawBtn"
        exit
    }

    Start-Sleep -Milliseconds 30
}
Write-Output "TIMEOUT"
`;

    try {
      inputRecorderProcess = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-NonInteractive',
        '-Command',
        script
      ]);

      let resolved = false;

      inputRecorderProcess.stdout.on('data', (data) => {
        const dataStr = data.toString().trim();
        logger.info(`[InputRecorder] STDOUT: ${dataStr}`);
        if (!dataStr) return;

        const lines = dataStr.split(/\r?\n/);
        for (let line of lines) {
          const val = line.trim();
          if (val.startsWith('KEY:')) {
            const vk = parseInt(val.substring(4));
            if (!resolved) {
              resolved = true;
              resolve({ type: 'keyboard', index: vk });
            }
          } else if (val.startsWith('XINPUT:')) {
            const mask = parseInt(val.substring(7));
            if (!resolved) {
              resolved = true;
              resolve({ type: 'controller_xinput', index: mask });
            }
          } else if (val.startsWith('RAW:')) {
            const btnIdx = parseInt(val.substring(4));
            if (!resolved) {
              resolved = true;
              resolve({ type: 'controller_raw', index: btnIdx });
            }
          } else if (val === 'TIMEOUT') {
            if (!resolved) {
              resolved = true;
              resolve({ type: 'timeout' });
            }
          }
        }
      });

      inputRecorderProcess.on('close', () => {
        if (!resolved) {
          resolved = true;
          resolve({ type: 'cancelled' });
        }
        inputRecorderProcess = null;
        startInputListener();
      });

      inputRecorderProcess.on('error', (err) => {
        logger.error(`[InputRecorder] Process error: ${err.message}`);
        if (!resolved) {
          resolved = true;
          resolve({ type: 'error', error: err.message });
        }
        inputRecorderProcess = null;
        startInputListener();
      });
    } catch (err) {
      logger.error(`[InputRecorder] Failed to spawn: ${err.message}`);
      resolve({ type: 'error', error: err.message });
      startInputListener();
    }
  });
});

ipcMain.handle('settings-record-input-stop', () => {
  if (inputRecorderProcess) {
    try {
      const { exec } = require('child_process');
      exec(`taskkill /F /T /PID ${inputRecorderProcess.pid}`);
    } catch (e) {}
    inputRecorderProcess = null;
    return true;
  }
  return false;
});

function compileInputListenerSync() {
  const binDir = path.join(APP_DATA, 'bin');
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  const csCode = `using System;
using System.Runtime.InteropServices;
using System.Reflection;
using System.Collections;
using System.Threading;

public class Program {
    [StructLayout(LayoutKind.Sequential)]
    public struct XINPUT_STATE {
        public uint dwPacketNumber;
        public XINPUT_GAMEPAD Gamepad;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct XINPUT_GAMEPAD {
        public ushort wButtons;
        public byte bLeftTrigger;
        public byte bRightTrigger;
        public short sThumbLX;
        public short sThumbLY;
        public short sThumbRX;
        public short sThumbRY;
    }
    
    [DllImport("xinput1_4.dll", EntryPoint = "XInputGetState")]
    public static extern uint XInputGetState(uint dwUserIndex, ref XINPUT_STATE pState);
    [DllImport("xinput1_3.dll", EntryPoint = "XInputGetState")]
    public static extern uint XInputGetState13(uint dwUserIndex, ref XINPUT_STATE pState);
    [DllImport("xinput9_1_0.dll", EntryPoint = "XInputGetState")]
    public static extern uint XInputGetState9(uint dwUserIndex, ref XINPUT_STATE pState);
    
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    private static bool useXInput14 = true;
    private static bool useXInput13 = false;
    private static bool useXInput9 = false;

    private static Type rawControllerType;
    private static PropertyInfo rawsProp;
    private static PropertyInfo btnCountProp;
    private static MethodInfo getReading;
    private static bool[] cachedButtons;
    private static object[] cachedArgs;

    static void InitializeRawController() {
        try {
            rawControllerType = Type.GetType("Windows.Gaming.Input.RawGameController, Windows.Gaming.Input, ContentType=WindowsRuntime");
            if (rawControllerType != null) {
                rawsProp = rawControllerType.GetProperty("RawGameControllers");
                btnCountProp = rawControllerType.GetProperty("ButtonCount");
                getReading = rawControllerType.GetMethod("GetCurrentReading");
            }
        } catch {}
    }

    public static bool IsButtonPressed(uint buttonMask) {
        XINPUT_STATE state = new XINPUT_STATE();
        for (uint i = 0; i < 4; i++) {
            uint result = 1;
            try {
                if (useXInput14) {
                    result = XInputGetState(i, ref state);
                }
            } catch {
                useXInput14 = false;
                useXInput13 = true;
            }

            if (useXInput13) {
                try {
                    result = XInputGetState13(i, ref state);
                } catch {
                    useXInput13 = false;
                    useXInput9 = true;
                }
            }

            if (useXInput9) {
                try {
                    result = XInputGetState9(i, ref state);
                } catch {
                    useXInput9 = false;
                }
            }

            if (result == 0) {
                if ((state.Gamepad.wButtons & buttonMask) != 0) {
                    return true;
                }
            }
        }
        return false;
    }

    public static bool IsRawButtonPressed(int buttonIndex) {
        if (rawControllerType == null || rawsProp == null || btnCountProp == null || getReading == null) return false;
        try {
            object list = rawsProp.GetValue(null);
            if (list == null) return false;
            IEnumerable enumerable = list as IEnumerable;
            if (enumerable == null) return false;

            foreach (object r in enumerable) {
                int btnCount = (int)btnCountProp.GetValue(r);
                if (buttonIndex >= btnCount) continue;

                if (cachedButtons == null || cachedButtons.Length != btnCount) {
                    cachedButtons = new bool[btnCount];
                    cachedArgs = new object[] { cachedButtons, null, null };
                }

                Array.Clear(cachedButtons, 0, cachedButtons.Length);

                getReading.Invoke(r, cachedArgs);
                bool[] resButtons = (bool[])cachedArgs[0];
                if (buttonIndex < resButtons.Length && resButtons[buttonIndex]) {
                    return true;
                }
            }
        } catch {}
        return false;
    }

    public static void Main(string[] args) {
        string triggerType = "default";
        int triggerIndex = 0;
        int vk = 9;
        int btn = 32;

        if (args.Length >= 1) triggerType = args[0];
        if (args.Length >= 2) int.TryParse(args[1], out triggerIndex);
        if (args.Length >= 3) int.TryParse(args[2], out vk);
        if (args.Length >= 4) int.TryParse(args[3], out btn);

        InitializeRawController();

        bool lastState = false;
        while (true) {
            bool pressed = false;
            if (triggerType == "keyboard") {
                pressed = (GetAsyncKeyState(triggerIndex) & 0x8000) != 0;
            } else if (triggerType == "controller_xinput") {
                pressed = IsButtonPressed((uint)triggerIndex);
            } else if (triggerType == "controller_raw") {
                pressed = IsRawButtonPressed(triggerIndex);
            } else {
                bool keyboardPressed = (GetAsyncKeyState(vk) & 0x8000) != 0;
                bool controllerPressed = false;
                if (btn > 0) {
                    controllerPressed = IsButtonPressed((uint)btn);
                }
                pressed = keyboardPressed || controllerPressed;
            }

            if (pressed != lastState) {
                Console.WriteLine(pressed ? "1" : "0");
                lastState = pressed;
            }
            Thread.Sleep(40);
        }
    }
}`;

  const crypto = require('crypto');
  const codeHash = crypto.createHash('md5').update(csCode).digest('hex').substring(0, 8);
  const exeName = `InputListener_${codeHash}.exe`;
  const exePath = path.join(binDir, exeName);

  if (fs.existsSync(exePath)) {
    return exePath;
  }

  const csPath = path.join(binDir, `InputListener_${codeHash}.cs`);
  fs.writeFileSync(csPath, csCode, 'utf8');

  const cscPath = 'C:\\\\Windows\\\\Microsoft.NET\\\\Framework64\\\\v4.0.30319\\\\csc.exe';
  if (!fs.existsSync(cscPath)) {
    logger.error(`[InputListener] csc.exe not found at ${cscPath}`);
    return null;
  }

  try {
    const { execSync } = require('child_process');
    logger.info(`[InputListener] Compiling InputListener to ${exePath}...`);
    execSync(`"${cscPath}" /nologo /out:"${exePath}" /target:exe "${csPath}"`);
    logger.info('[InputListener] Native C# InputListener compiled successfully.');
    try { fs.unlinkSync(csPath); } catch (e) {}
    return exePath;
  } catch (err) {
    logger.error(`[InputListener] Failed to compile C# listener: ${err.message}`);
    return null;
  }
}

function startInputListener() {
  if (inputListenerProcess) {
    try {
      logger.info(`[InputListener] Stopping existing input listener process (PID: ${inputListenerProcess.pid})...`);
      const { exec } = require('child_process');
      exec(`taskkill /F /T /PID ${inputListenerProcess.pid}`);
    } catch (e) {}
    inputListenerProcess = null;
  }

  const cfg = settings.load();
  if (cfg.ingameRankEnabled === false || cfg.ingameRankHoldToShow === false) {
    logger.info('[InputListener] Listener disabled in settings, skipping start.');
    return;
  }

  const hotkey = cfg.ingameRankHotkey || 'Tab';
  const controllerButton = (cfg.ingameRankControllerButton !== undefined && cfg.ingameRankControllerButton !== null) ? cfg.ingameRankControllerButton : 32;
  const triggerType = cfg.ingameRankTriggerType || 'default';
  const triggerIndex = (cfg.ingameRankTriggerIndex !== undefined && cfg.ingameRankTriggerIndex !== null) ? cfg.ingameRankTriggerIndex : 0;

  // Map hotkey to virtual key code
  let vkCode = 0x09; // Tab
  if (hotkey.toLowerCase() === 'f8') vkCode = 0x77;
  else if (hotkey.toLowerCase() === 'capslock') vkCode = 0x14;
  else if (hotkey.toLowerCase() === 'shift') vkCode = 0x10;
  else if (hotkey.toLowerCase() === 'ctrl') vkCode = 0x11;

  const exePath = compileInputListenerSync();
  if (!exePath) {
    logger.error('[InputListener] Could not compile or find compiled InputListener.exe');
    return;
  }

  logger.info(`[InputListener] Spawning native C# listener with triggerType=${triggerType}, triggerIndex=${triggerIndex}, vkCode=${vkCode}, controllerButton=${controllerButton}`);
  try {
    inputListenerProcess = spawn(exePath, [
      triggerType,
      triggerIndex.toString(),
      vkCode.toString(),
      controllerButton.toString()
    ]);

    inputListenerProcess.stdout.on('data', (data) => {
      const dataStr = data.toString();
      const lines = dataStr.split(/\r?\n/);
      for (let line of lines) {
        const val = line.trim();
        if (val === '1') {
          logger.info('[InputListener] Show key/button pressed');
          showRoster();
        } else if (val === '0') {
          logger.info('[InputListener] Hide key/button released');
          hideRoster();
        }
      }
    });

    inputListenerProcess.stderr.on('data', (data) => {
      logger.error(`[InputListener] Process STDERR: ${data.toString().trim()}`);
    });

    inputListenerProcess.on('error', (err) => {
      logger.error(`[InputListener] Process failed to start or errored: ${err.message}`);
    });

    inputListenerProcess.on('close', (code) => {
      logger.warn(`[InputListener] Process exited with code ${code}`);
      inputListenerProcess = null;
    });

  } catch (err) {
    logger.error(`[InputListener] Failed to spawn native listener: ${err.message}`);
  }
}

function stopInputListener() {
  if (inputListenerProcess) {
    try {
      logger.info(`[InputListener] Stopping input listener process (PID: ${inputListenerProcess.pid})...`);
      const { exec } = require('child_process');
      exec(`taskkill /F /T /PID ${inputListenerProcess.pid}`);
    } catch (e) {}
    inputListenerProcess = null;
  }
}

function createRosterWindow() {
  const cfg = settings.load();
  if (cfg.ingameRankEnabled === false) return;

  const disp = screen.getPrimaryDisplay();
  const sw = disp.size.width;
  const sh = disp.size.height;

  const userScale   = cfg.ingameRankScaleMultiplier !== undefined ? cfg.ingameRankScaleMultiplier : 1.0;

  logger.info(`[Roster] Window: sw=${sw} sh=${sh} (Fullscreen Roster Overlay)`);

  rosterWindow = new BrowserWindow({
    width: sw,
    height: sh,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false
    }
  });

  rosterWindow.setAlwaysOnTop(true, 'screen-saver');
  rosterWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  rosterWindow.setIgnoreMouseEvents(true, { forward: true });

  rosterWindow.webContents.on('console-message', (_, level, message, line, sourceId) => {
    logger.info(`[Roster] [L${level}] ${message} (${path.basename(sourceId)}:${line})`);
  });

  rosterWindow.webContents.once('did-finish-load', () => {
    logger.info('[Roster] Roster window did-finish-load fired');
    try {
      const roster = tracker.getRoster();
      let isCppEnabled = false;
      try {
        isCppEnabled = bakkesplugins.listPlugins().some(p => p.id.toLowerCase() === 'ingamerank' && p.enabled) && tracker.isTcpConnected;
      } catch (e) {}

      rosterWindow.webContents.send('roster-init', {
        roster: roster.players && roster.players.length > 0 ? roster : null,
        ingameRankPath: path.join(APP_DATA, 'assets/IngameRank'),
        settings: {
          scaleMultiplier:    userScale,
          showDivision:       cfg.ingameRankShowDivision !== false,
          showPlaylist:       cfg.ingameRankShowPlaylist !== false,
          holdToShow:         cfg.ingameRankHoldToShow !== false,
          calculateUnranked:  cfg.ingameRankCalculateUnranked !== false,
          includeExtramodes:  cfg.ingameRankIncludeExtramodes !== false,
          includeTournaments: cfg.ingameRankIncludeTournaments !== false,
          playlist:           cfg.ingameRankPlaylist || 'current',
          offsetX:            cfg.ingameRankOffsetX !== undefined ? cfg.ingameRankOffsetX : 0,
          offsetY:            cfg.ingameRankOffsetY !== undefined ? cfg.ingameRankOffsetY : 0,
          offsetXBlue:        cfg.ingameRankOffsetXBlue !== undefined ? cfg.ingameRankOffsetXBlue : 0,
          offsetYBlue:        cfg.ingameRankOffsetYBlue !== undefined ? cfg.ingameRankOffsetYBlue : 0,
          offsetXOrange:      cfg.ingameRankOffsetXOrange !== undefined ? cfg.ingameRankOffsetXOrange : 0,
          offsetYOrange:      cfg.ingameRankOffsetYOrange !== undefined ? cfg.ingameRankOffsetYOrange : 0,
          uiScalePercent:     cfg.ingameRankUiScalePercent !== undefined ? cfg.ingameRankUiScalePercent : 100,
          enabled:            isCppEnabled
        }
      });
      logger.info('[Roster] Sent roster-init to window');

      if (cfg.ingameRankHoldToShow !== false) {
        startInputListener();
      }
    } catch (err) {
      logger.error(`[Roster] Error in did-finish-load handler: ${err.stack || err.message}`);
    }
  });

  rosterWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    logger.error(`[Roster] Failed to load: ${validatedURL}, error: ${errorDescription} (${errorCode})`);
  });

  rosterWindow.webContents.on('did-start-loading', () => {
    logger.info('[Roster] Roster window started loading...');
  });

  rosterWindow.webContents.on('render-process-gone', (event, details) => {
    logger.error(`[Roster] Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`);
  });

  rosterWindow.on('unresponsive', () => {
    logger.error('[Roster] Roster window went unresponsive!');
  });

  rosterWindow.loadFile(path.join(__dirname, '../renderer/roster.html'));
  // Always show the window initially but keep it transparent using CSS opacity.
  // This prevents native OS window show/hide transitions during gameplay.
  rosterWindow.showInactive();

  rosterWindow.on('closed', () => {
    rosterWindow = null;
    stopInputListener();
  });
  logger.info('[Roster] Roster window created');
}

function createNoMatchWindow() {
  if (noMatchWindow && !noMatchWindow.isDestroyed()) return;

  const disp = screen.getPrimaryDisplay();
  const sw = disp.size.width;
  const sh = disp.size.height;

  noMatchWindow = new BrowserWindow({
    width: sw,
    height: sh,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false
    }
  });

  noMatchWindow.setAlwaysOnTop(true, 'screen-saver');
  noMatchWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  noMatchWindow.setIgnoreMouseEvents(true, { forward: true });

  noMatchWindow.webContents.once('did-finish-load', () => {
    logger.info('[NoMatch] No-match window loaded, starting hidden');
  });

  noMatchWindow.loadFile(path.join(__dirname, '../renderer/nomatch.html'));
  noMatchWindow.showInactive();

  noMatchWindow.on('closed', () => { noMatchWindow = null; });
  logger.info('[NoMatch] No-match window created');
}

function toggleRosterWindow() {
  const cfg = settings.load();
  if (rosterWindow && !rosterWindow.isDestroyed()) {
    cfg.ingameRankEnabled = false;
    settings.save(cfg);
    rosterWindow.close();
    rosterWindow = null;
    if (noMatchWindow && !noMatchWindow.isDestroyed()) {
      noMatchWindow.close();
      noMatchWindow = null;
    }
    stopInputListener();
    logger.info('[Roster] Roster window disabled and closed');
  } else {
    cfg.ingameRankEnabled = true;
    settings.save(cfg);
    createRosterWindow();
    createNoMatchWindow();
    logger.info('[Roster] Roster window enabled and opened');
  }
}

function updateRosterWindowFromSettings() {
  const cfg = settings.load();
  
  if (cfg.ingameRankEnabled === false) {
    if (rosterWindow && !rosterWindow.isDestroyed()) rosterWindow.close();
    if (noMatchWindow && !noMatchWindow.isDestroyed()) noMatchWindow.close();
    stopInputListener();
    return;
  }

  if (!rosterWindow || rosterWindow.isDestroyed()) {
    createRosterWindow();
    createNoMatchWindow();
    return;
  }
  if (!noMatchWindow || noMatchWindow.isDestroyed()) createNoMatchWindow();

  const userScale = cfg.ingameRankScaleMultiplier !== undefined ? cfg.ingameRankScaleMultiplier : 1.0;

  let isCppEnabled = false;
  try {
    isCppEnabled = bakkesplugins.listPlugins().some(p => p.id.toLowerCase() === 'ingamerank' && p.enabled) && tracker.isTcpConnected;
  } catch (e) {}

  try {
    rosterWindow.webContents.send('settings-update', {
      scaleMultiplier:      userScale,
      showDivision:         cfg.ingameRankShowDivision !== false,
      showPlaylist:         cfg.ingameRankShowPlaylist !== false,
      holdToShow:           cfg.ingameRankHoldToShow !== false,
      calculateUnranked:    cfg.ingameRankCalculateUnranked !== false,
      includeExtramodes:    cfg.ingameRankIncludeExtramodes !== false,
      includeTournaments:   cfg.ingameRankIncludeTournaments !== false,
      playlist:             cfg.ingameRankPlaylist || 'current',
      offsetX:              cfg.ingameRankOffsetX !== undefined ? cfg.ingameRankOffsetX : 0,
      offsetY:              cfg.ingameRankOffsetY !== undefined ? cfg.ingameRankOffsetY : 0,
      offsetXBlue:          cfg.ingameRankOffsetXBlue !== undefined ? cfg.ingameRankOffsetXBlue : 0,
      offsetYBlue:          cfg.ingameRankOffsetYBlue !== undefined ? cfg.ingameRankOffsetYBlue : 0,
      offsetXOrange:        cfg.ingameRankOffsetXOrange !== undefined ? cfg.ingameRankOffsetXOrange : 0,
      offsetYOrange:        cfg.ingameRankOffsetYOrange !== undefined ? cfg.ingameRankOffsetYOrange : 0,
      uiScalePercent:       cfg.ingameRankUiScalePercent !== undefined ? cfg.ingameRankUiScalePercent : 100,
      enabled:              isCppEnabled
    });
  } catch (err) {}

  if (cfg.ingameRankHoldToShow !== false) {
    startInputListener();
    if (rosterWindow && !rosterWindow.isDestroyed()) {
      hideRoster();
    }
  } else {
    stopInputListener();
    showRoster();
  }
}

function syncIngameRankCVars(cfg) {
  const configPath = path.join(
    os.homedir(), 'AppData', 'Roaming', 'bakkesmod', 'bakkesmod', 'cfg', 'config.cfg'
  );
  if (!fs.existsSync(configPath)) return;
  
  try {
    let content = fs.readFileSync(configPath, 'utf8');
    
    const cvars = {
      'ingamerank_enabled': cfg.ingameRankEnabled ? '1' : '0',
      'ingamerank_playlist': cfg.ingameRankPlaylist === '1v1' ? '10' :
                             cfg.ingameRankPlaylist === '2v2' ? '11' :
                             cfg.ingameRankPlaylist === '3v3' ? '13' :
                             cfg.ingameRankPlaylist === 'quads' ? '61' :
                             cfg.ingameRankPlaylist === 'hoops' ? '27' :
                             cfg.ingameRankPlaylist === 'rumble' ? '28' :
                             cfg.ingameRankPlaylist === 'dropshot' ? '29' :
                             cfg.ingameRankPlaylist === 'snowday' ? '30' :
                             cfg.ingameRankPlaylist === 'heatseeker' ? '63' :
                             cfg.ingameRankPlaylist === 'tournament' ? '34' :
                             cfg.ingameRankPlaylist === 'best' ? '0' : '-1',
      'ingamerank_show_division': cfg.ingameRankShowDivision ? '1' : '0',
      'ingamerank_show_playlist': cfg.ingameRankShowPlaylist ? '1' : '0',
      'ingamerank_calculate_unranked': cfg.ingameRankCalculateUnranked ? '1' : '0',
      'ingamerank_include_extramodes': cfg.ingameRankIncludeExtramodes ? '1' : '0',
      'ingamerank_include_tournaments': cfg.ingameRankIncludeTournaments ? '1' : '0',
      'ranked_showranks': '1',
      'ranked_showranks_casual': '1'
    };
    
    for (const [cvar, value] of Object.entries(cvars)) {
      const regex = new RegExp(`^\\s*${cvar}\\s+\\S+`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${cvar} ${value}`);
      } else {
        content += `\n${cvar} ${value}`;
      }
    }
    
    fs.writeFileSync(configPath, content.trim() + '\n', 'utf8');
  } catch (err) {
    logger.error(`[IngameRank-CVarSync] Failed to sync config.cfg: ${err.message}`);
  }
}

// Workshop
ipcMain.handle('workshop-list', () => workshop.listMaps());
ipcMain.handle('workshop-install', (_, url, metaOverride) => workshop.installMap(url, metaOverride));
ipcMain.handle('workshop-delete', (_, id) => workshop.deleteMap(id));
ipcMain.handle('workshop-launch', (_, id, slotId) => workshop.launchMap(id, slotId));
ipcMain.handle('workshop-restore', (_, slotId) => workshop.restoreOriginal(slotId));
ipcMain.handle('workshop-active-get', () => workshop.getActiveMaps());
ipcMain.handle('workshop-online-list', (_, opts) => workshop.getOnlineMaps(opts));
ipcMain.handle('workshop-online-details', (_, id) => workshop.getOnlineMapDetails(id));

// Celab Workshop API
ipcMain.handle('workshop-celab-search', (_, opts) => workshop.searchCelabMaps(opts));
ipcMain.handle('workshop-celab-download', async (event, projectId, projectName) => {
  return workshop.downloadCelabMap(projectId, projectName, {
    onProgress: (pct) => {
      // Stream progress back to the renderer window
      try { event.sender.send('workshop-celab-progress', { projectId, pct }); } catch (_) {}
    }
  });
});
ipcMain.handle('workshop-select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Seleziona Mappa Workshop (.zip, .udk, .upk)',
    filters: [
      { name: 'Mappe Rocket League (*.zip, *.udk, *.upk)', extensions: ['zip', 'udk', 'upk'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('swap-select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Seleziona File Modded (.upk, .udk)',
    filters: [
      { name: 'File Modded Rocket League (*.upk, *.udk)', extensions: ['upk', 'udk'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});


// BakkesMod Plugins
ipcMain.handle('bakkes-plugins-list', () => bakkesplugins.listPlugins());
ipcMain.handle('bakkes-plugin-toggle', async (_, id) => {
  const res = await bakkesplugins.togglePlugin(id);
  // Se è RocketStats, mostra/nasconde l'overlay in sync col plugin
  if (id.toLowerCase() === 'rocketstats' && overlayWindow) {
    if (res.ok) {
      if (res.enabled) {
        showOverlay();
      } else {
        hideOverlay();
      }
    }
  }
  // Se è IngameRank, mostra/nasconde l'overlay in sync col plugin
  if (id.toLowerCase() === 'ingamerank') {
    if (res.ok) {
      const cfg = settings.load();
      cfg.ingameRankEnabled = res.enabled;
      settings.save(cfg);
      updateRosterWindowFromSettings();
    }
  }
  return res;
});
ipcMain.handle('bakkes-plugin-install', (_, src) => bakkesplugins.installPlugin(src));
ipcMain.handle('bakkes-plugin-uninstall', (_, id) => bakkesplugins.uninstallPlugin(id));
ipcMain.handle('bakkes-launch-injector', () => bakkesplugins.launchInjector());

ipcMain.handle('bakkes-plugin-get-settings', (_, pluginId) => {
  try {
    if (pluginId === 'ingamerank') {
      const cfg = settings.load();
      return {
        ok: true,
        enabled: cfg.ingameRankEnabled !== false,
        playlist: cfg.ingameRankPlaylist || 'current',
        showDivision: cfg.ingameRankShowDivision !== false,
        showPlaylist: cfg.ingameRankShowPlaylist !== false,
        calculateUnranked: cfg.ingameRankCalculateUnranked !== false,
        includeExtramodes: cfg.ingameRankIncludeExtramodes !== false,
        includeTournaments: cfg.ingameRankIncludeTournaments !== false,
        holdToShow: cfg.ingameRankHoldToShow !== false,
        hotkey: cfg.ingameRankHotkey || 'Tab',
        controllerButton: cfg.ingameRankControllerButton !== undefined ? cfg.ingameRankControllerButton : 32,
        scaleMultiplier: cfg.ingameRankScaleMultiplier !== undefined ? cfg.ingameRankScaleMultiplier : 1.0,
        offsetX: cfg.ingameRankOffsetX !== undefined ? cfg.ingameRankOffsetX : 0,
        offsetY: cfg.ingameRankOffsetY !== undefined ? cfg.ingameRankOffsetY : 0,
        offsetXBlue: cfg.ingameRankOffsetXBlue !== undefined ? cfg.ingameRankOffsetXBlue : 0,
        offsetYBlue: cfg.ingameRankOffsetYBlue !== undefined ? cfg.ingameRankOffsetYBlue : 0,
        offsetXOrange: cfg.ingameRankOffsetXOrange !== undefined ? cfg.ingameRankOffsetXOrange : 0,
        offsetYOrange: cfg.ingameRankOffsetYOrange !== undefined ? cfg.ingameRankOffsetYOrange : 0,
        uiScalePercent: cfg.ingameRankUiScalePercent !== undefined ? cfg.ingameRankUiScalePercent : 100,
        triggerType: cfg.ingameRankTriggerType,
        triggerIndex: cfg.ingameRankTriggerIndex
      };
    }
    if (pluginId === 'rocketstats') {
      const themesDir = path.join(
        os.homedir(), 'AppData', 'Roaming', 'bakkesmod', 'bakkesmod',
        'data', 'RocketStats', 'RocketStats_themes'
      );
      if (!fs.existsSync(themesDir)) return { ok: false, error: 'Cartella temi non trovata' };

      const themeFolders = fs.readdirSync(themesDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
          const cfgPath = path.join(themesDir, d.name, 'config.json');
          const imgPath = path.join(themesDir, d.name, 'screenshot.png');
          let meta = {};
          try { meta = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
          return {
            id: d.name,
            name: d.name,
            author: meta.author || 'Unknown',
            version: meta.version || '',
            width: meta.width || 200,
            height: meta.height || 200,
            screenshotPath: fs.existsSync(imgPath) ? imgPath : null,
          };
        });

      // Carica il tema attivo salvato nelle settings dell'app
      const cfg = settings.load();
      let activeTheme = cfg.rocketStatsTheme || 'Circle';
      if (!fs.existsSync(path.join(themesDir, activeTheme))) {
        activeTheme = 'Circle';
      }
      const playlist = cfg.rocketStatsPlaylist || 'current';
      const scaleMultiplier = cfg.rocketStatsScaleMultiplier !== undefined ? cfg.rocketStatsScaleMultiplier : 0.70;
      const offsetX = cfg.rocketStatsOffsetX !== undefined ? cfg.rocketStatsOffsetX : 32;
      const offsetY = cfg.rocketStatsOffsetY !== undefined ? cfg.rocketStatsOffsetY : 78;
      const showMmrDelta = cfg.rocketStatsShowMmrDelta !== undefined ? cfg.rocketStatsShowMmrDelta : true;
      const uiScalePercent = cfg.rocketStatsUiScalePercent !== undefined ? cfg.rocketStatsUiScalePercent : 90;
      return { ok: true, themes: themeFolders, activeTheme, scaleMultiplier, offsetX, offsetY, playlist, showMmrDelta, uiScalePercent };
    }
    return { ok: false, error: 'Plugin non ha impostazioni configurabili' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('bakkes-plugin-set-settings', async (_, pluginId, newSettings) => {
  try {
    if (pluginId === 'ingamerank') {
      const cfg = settings.load();
      if (newSettings.enabled !== undefined) cfg.ingameRankEnabled = newSettings.enabled;
      if (newSettings.playlist !== undefined) cfg.ingameRankPlaylist = newSettings.playlist;
      if (newSettings.showDivision !== undefined) cfg.ingameRankShowDivision = newSettings.showDivision;
      if (newSettings.showPlaylist !== undefined) cfg.ingameRankShowPlaylist = newSettings.showPlaylist;
      if (newSettings.calculateUnranked !== undefined) cfg.ingameRankCalculateUnranked = newSettings.calculateUnranked;
      if (newSettings.includeExtramodes !== undefined) cfg.ingameRankIncludeExtramodes = newSettings.includeExtramodes;
      if (newSettings.includeTournaments !== undefined) cfg.ingameRankIncludeTournaments = newSettings.includeTournaments;
      if (newSettings.holdToShow !== undefined) cfg.ingameRankHoldToShow = newSettings.holdToShow;
      if (newSettings.hotkey !== undefined) cfg.ingameRankHotkey = newSettings.hotkey;
      if (newSettings.controllerButton !== undefined) cfg.ingameRankControllerButton = newSettings.controllerButton;
      if (newSettings.scaleMultiplier !== undefined) cfg.ingameRankScaleMultiplier = newSettings.scaleMultiplier;
      if (newSettings.offsetX !== undefined) cfg.ingameRankOffsetX = newSettings.offsetX;
      if (newSettings.offsetY !== undefined) cfg.ingameRankOffsetY = newSettings.offsetY;
      if (newSettings.offsetXBlue !== undefined) cfg.ingameRankOffsetXBlue = newSettings.offsetXBlue;
      if (newSettings.offsetYBlue !== undefined) cfg.ingameRankOffsetYBlue = newSettings.offsetYBlue;
      if (newSettings.offsetXOrange !== undefined) cfg.ingameRankOffsetXOrange = newSettings.offsetXOrange;
      if (newSettings.offsetYOrange !== undefined) cfg.ingameRankOffsetYOrange = newSettings.offsetYOrange;
      if (newSettings.uiScalePercent !== undefined) cfg.ingameRankUiScalePercent = newSettings.uiScalePercent;
      if (newSettings.triggerType !== undefined) cfg.ingameRankTriggerType = newSettings.triggerType;
      if (newSettings.triggerIndex !== undefined) cfg.ingameRankTriggerIndex = newSettings.triggerIndex;

      settings.save(cfg);
      syncIngameRankCVars(cfg);
      updateRosterWindowFromSettings();
      return { ok: true };
    }
    if (pluginId === 'rocketstats') {
      const cfg = settings.load();
      if (newSettings.theme !== undefined) {
        cfg.rocketStatsTheme = newSettings.theme;
      }
      if (newSettings.scaleMultiplier !== undefined) {
        cfg.rocketStatsScaleMultiplier = newSettings.scaleMultiplier;
      }
      if (newSettings.offsetX !== undefined) {
        cfg.rocketStatsOffsetX = newSettings.offsetX;
      }
      if (newSettings.offsetY !== undefined) {
        cfg.rocketStatsOffsetY = newSettings.offsetY;
      }
      if (newSettings.playlist !== undefined) {
        cfg.rocketStatsPlaylist = newSettings.playlist;
      }
      if (newSettings.showMmrDelta !== undefined) {
        cfg.rocketStatsShowMmrDelta = newSettings.showMmrDelta;
      }
      if (newSettings.uiScalePercent !== undefined) {
        cfg.rocketStatsUiScalePercent = newSettings.uiScalePercent;
      }
      settings.save(cfg);
      logger.info(`[PluginSettings] RocketStats settings updated: theme=${cfg.rocketStatsTheme}, scaleMultiplier=${cfg.rocketStatsScaleMultiplier}, offsetX=${cfg.rocketStatsOffsetX}, offsetY=${cfg.rocketStatsOffsetY}, playlist=${cfg.rocketStatsPlaylist}, showMmrDelta=${cfg.rocketStatsShowMmrDelta}`);

      if (overlayWindow) {
        const themeData = loadRocketStatsThemeConfig();
        const themeCfg = themeData.themeConfig;
        const scaleMultiplier = themeData.scaleMultiplier || 1.0;
        const gs = ((themeCfg && typeof themeCfg.scale === 'number') ? themeCfg.scale : 1.0) * scaleMultiplier;
        const W = (themeCfg && typeof themeCfg.width  === 'number') ? Math.min(Math.round((themeCfg.width + 120) * gs) + 50, 1400) : 240;
        const H = (themeCfg && typeof themeCfg.height === 'number') ? Math.min(Math.round(themeCfg.height * gs) + 20, 900) : 200;

        const { width, height } = screen.getPrimaryDisplay().workAreaSize;
        const offsetX = cfg.rocketStatsOffsetX !== undefined ? cfg.rocketStatsOffsetX : 29;
        const offsetY = cfg.rocketStatsOffsetY !== undefined ? cfg.rocketStatsOffsetY : 78;

        overlayWindow.setPosition(width - W - 10 + offsetX, height - H - 50 + offsetY);
      }

      if (newSettings.theme !== undefined || newSettings.scaleMultiplier !== undefined || newSettings.playlist !== undefined || newSettings.showMmrDelta !== undefined) {
        reloadOverlayTheme();
      }

      return { ok: true };
    }
    return { ok: false, error: 'Plugin non ha impostazioni configurabili' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Plugins
ipcMain.handle('plugins-list', () => pluginSystem.listPlugins());
ipcMain.handle('plugin-toggle', (_, id) => pluginSystem.togglePlugin(id));
ipcMain.handle('plugin-install', (_, src) => pluginSystem.installPlugin(src));
ipcMain.handle('plugin-uninstall', (_, id) => pluginSystem.uninstallPlugin(id));
ipcMain.handle('plugin-get-log', (_, id) => pluginSystem.getPluginLog(id));

// Canary
ipcMain.handle('canary-status', () => canary.getStatus());
ipcMain.handle('canary-reapply', () => canary.forceReapply());

// Open external
ipcMain.on('open-external', (_, url) => shell.openExternal(url));

// Renderer logging
ipcMain.on('renderer-log-error', (_, msg) => logger.error(`[Renderer] ${msg}`));

// RocketStats live update from overlay
ipcMain.on('rocketstats-update', (_, data) => {
  tracker.updateFromRocketStats(data);
});

// RocketStats — reset stats di sessione
// Scrive rs_reset_stats nel config.cfg di BakkesMod; il plugin lo esegue al prossimo tick
ipcMain.handle('bakkes-rocketstats-reset', () => {
  try {
    const cfgPath = path.join(
      os.homedir(), 'AppData', 'Roaming', 'bakkesmod', 'bakkesmod', 'cfg', 'config.cfg'
    );
    // Appende il comando; BakkesMod lo esegue automaticamente se è in esecuzione
    const cmd = 'rs_reset_stats\n';
    fs.appendFileSync(cfgPath, cmd, 'utf8');
    logger.info('[RocketStats] rs_reset_stats scritto in config.cfg');
    return { ok: true };
  } catch (err) {
    logger.error(`[RocketStats] reset stats error: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

function toggleOverlayWindow() {
  if (!overlayWindow) {
    createOverlayWindow();
    return;
  }
  if (isOverlayIntendedVisible) {
    hideOverlay();
    logger.info('[Shortcut] Overlay window hidden');
  } else {
    showOverlay();
    logger.info('[Shortcut] Overlay window shown');
  }
}

// Overlay toggle
ipcMain.on('overlay-toggle', () => {
  toggleOverlayWindow();
});
ipcMain.on('overlay-set-ignore-mouse', (_, ignore) => {
  overlayWindow?.setIgnoreMouseEvents(ignore, { forward: true });
});
