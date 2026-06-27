const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rc', {
  // Window
  minimize:              () => ipcRenderer.send('window-minimize'),
  maximize:              () => ipcRenderer.send('window-maximize'),
  close:                 () => ipcRenderer.send('window-close'),
  openExternal:          (url) => ipcRenderer.send('open-external', url),

  // Settings
  getSettings:           () => ipcRenderer.invoke('settings-get'),
  saveSettings:          (data) => ipcRenderer.invoke('settings-set', data),
  recordInputStart:      () => ipcRenderer.invoke('settings-record-input-start'),
  recordInputStop:       () => ipcRenderer.invoke('settings-record-input-stop'),

  // Swaps
  listSwaps:             () => ipcRenderer.invoke('swap-list'),
  applySwap:             (swap) => ipcRenderer.invoke('swap-apply', swap),
  revertSwap:            (id) => ipcRenderer.invoke('swap-revert', id),
  revertAll:             () => ipcRenderer.invoke('swap-revert-all'),
  getCatalog:            (opts) => ipcRenderer.invoke('catalog-get', opts),
  refreshCatalog:         () => ipcRenderer.invoke('catalog-refresh'),
  checkNewLocalItems:     () => ipcRenderer.invoke('catalog-check-new'),
  downloadMissingThumbnails: () => ipcRenderer.invoke('catalog-download-missing'),

  // Catalog — backward compatibility fallback
  readCatalogJSON:       () => '[]',
  readCatalog:           () => '[]',

  // Ball packs
  listBallPacks:         () => ipcRenderer.invoke('ballpacks-list'),
  applyBallPack:         (pack) => ipcRenderer.invoke('ballpack-apply', pack),

  // Decal packs
  listDecalPacks:        () => ipcRenderer.invoke('decalpacks-list'),
  applyDecalPack:        (pack) => ipcRenderer.invoke('decalpack-apply', pack),

  // HUD meter packs
  listHudPacks:          () => ipcRenderer.invoke('hudpacks-list'),
  applyHudPack:          (pack) => ipcRenderer.invoke('hudpack-apply', pack),

  // Presets
  getPresets:            () => ipcRenderer.invoke('presets-get'),
  savePreset:            (name) => ipcRenderer.invoke('preset-save', name),
  loadPreset:            (name) => ipcRenderer.invoke('preset-load', name),
  deletePreset:          (name) => ipcRenderer.invoke('preset-delete', name),

  // Tracker
  getProfile:            (username) => ipcRenderer.invoke('tracker-get-profile', username),
  getSession:            () => ipcRenderer.invoke('tracker-get-session'),
  getRoster:             () => ipcRenderer.invoke('tracker-get-roster'),
  getRosterInit:         () => ipcRenderer.invoke('tracker-get-roster-init'),
  setPlaylist:           (pl) => ipcRenderer.invoke('tracker-set-playlist', pl),
  setActiveAccount:      (index) => ipcRenderer.invoke('tracker-set-active-account', index),
  updateUsernames:       (user1, user2) => ipcRenderer.invoke('tracker-update-usernames', user1, user2),
  resetTrackerStats:      () => ipcRenderer.invoke('tracker-reset-stats'),

  // Roster overlay
  toggleRoster:          () => ipcRenderer.send('roster-toggle'),
  forceShowRoster:       () => ipcRenderer.send('roster-force-show'),
  forceHideRoster:       () => ipcRenderer.send('roster-force-hide'),

  // Workshop
  listMaps:              () => ipcRenderer.invoke('workshop-list'),
  installMap:            (url, metaOverride) => ipcRenderer.invoke('workshop-install', url, metaOverride),
  deleteMap:             (id) => ipcRenderer.invoke('workshop-delete', id),
  launchMap:             (id, slotId) => ipcRenderer.invoke('workshop-launch', id, slotId),
  restoreOriginalMap:    (slotId) => ipcRenderer.invoke('workshop-restore', slotId),
  getActiveMap:          () => ipcRenderer.invoke('workshop-active-get'),
  getOnlineMaps:         (opts) => ipcRenderer.invoke('workshop-online-list', opts),
  getOnlineMapDetails:   (id) => ipcRenderer.invoke('workshop-online-details', id),
  selectWorkshopZip:     () => ipcRenderer.invoke('workshop-select-file'),
  selectCustomSwapFile:  () => ipcRenderer.invoke('swap-select-file'),

  // BakkesMod Plugins
  listBakkesPlugins:     () => ipcRenderer.invoke('bakkes-plugins-list'),
  toggleBakkesPlugin:    (id) => ipcRenderer.invoke('bakkes-plugin-toggle', id),
  installBakkesPlugin:   (src) => ipcRenderer.invoke('bakkes-plugin-install', src),
  uninstallBakkesPlugin: (id) => ipcRenderer.invoke('bakkes-plugin-uninstall', id),
  launchBakkesMod:       () => ipcRenderer.invoke('bakkes-launch-injector'),
  getBakkesPluginSettings: (id) => ipcRenderer.invoke('bakkes-plugin-get-settings', id),
  setBakkesPluginSettings: (id, s) => ipcRenderer.invoke('bakkes-plugin-set-settings', id, s),

  // Plugins
  listPlugins:           () => ipcRenderer.invoke('plugins-list'),
  togglePlugin:          (id) => ipcRenderer.invoke('plugin-toggle', id),
  installPlugin:         (src) => ipcRenderer.invoke('plugin-install', src),
  uninstallPlugin:       (id) => ipcRenderer.invoke('plugin-uninstall', id),
  getPluginLog:          (id) => ipcRenderer.invoke('plugin-get-log', id),

  // Canary
  canaryStatus:          () => ipcRenderer.invoke('canary-status'),
  canaryReapply:         () => ipcRenderer.invoke('canary-reapply'),

  // Overlay
  toggleOverlay:         () => ipcRenderer.send('overlay-toggle'),
  setOverlayMouseIgnore: (ignore) => ipcRenderer.send('overlay-set-ignore-mouse', ignore),

  // Renderer logging
  logError:              (msg) => ipcRenderer.send('renderer-log-error', msg),

  // RocketStats live sync
  sendRocketStatsUpdate: (data) => ipcRenderer.send('rocketstats-update', data),
  resetRocketStats:      () => ipcRenderer.invoke('bakkes-rocketstats-reset'),

  // Celab Workshop
  searchCelabMaps:       (opts) => ipcRenderer.invoke('workshop-celab-search', opts),
  downloadCelabMap:      (id, name) => ipcRenderer.invoke('workshop-celab-download', id, name),
  onCelabProgress:       (cb) => {
    ipcRenderer.on('workshop-celab-progress', (_, data) => cb(data));
    return () => ipcRenderer.removeAllListeners('workshop-celab-progress');
  },

  // Updates
  checkUpdate:           () => ipcRenderer.invoke('app-check-update'),
  installUpdate:         () => ipcRenderer.invoke('app-install-update'),
  reinstallCurrent:      () => ipcRenderer.invoke('app-reinstall-current'),

  // Events (main → renderer)
  on: (event, cb) => {
    ipcRenderer.on(event, (_, data) => cb(data));
    return () => ipcRenderer.removeAllListeners(event);
  }
});
