const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const fetch = require('node-fetch');
const WebSocket = require('ws');
const net = require('net');

const { BrowserWindow } = require('electron');

/**
 * TrackerModule — pulls MMR from tracker.gg public API,
 * watches RL's Launch.log to detect match start/end.
 * Same approach as Shift's [tracker] and [psynet] systems.
 */
class TrackerModule extends EventEmitter {
  constructor(appData, settings, logger) {
    super();
    this.appData = appData;
    this.settings = settings;
    this.logger = logger;
    this.sessions = {};
    this.activeAccount = 1;
    this.username1 = '';
    this.username2 = '';
    this.usernames = [];
    this.activeAccountIndex = 0;
    this.playerIds = {};
    this.inMatch = false;
    this.matchGuid = null;
    this.profile = null;
    this.roster = [];
    this.playlist = '2v2';
    this.detectedPlaylist = '2v2';
    this._pollInterval = null;
    this._launchLogPath = this._findLaunchLog();
    this._lastLogSize = 0;
    this._logPollingStarted = false;
    this.isWsConnected = false;
    this._ws = null;
    this._wsReconnectTimeout = null;
    this.hiddenWindow = null;
    this._lastTempBrowserSpawnTime = {};
    this._lastMatchEndTimestamp = 0;
    this._lastMatchStartGuid = null;
    this.isTcpConnected = false;
    this._hasStatsApiData = false;
    this._tcpClient = null;
    this._tcpReconnectTimeout = null;
    // Roster overlay state
    this._rosterMap = {};           // playerId -> { name, mmr, tier, division, rankName, divisionName, peak, team, isLocal }
    this._pendingPlayerIds = [];    // queue of Uncached PlatformIds waiting for UpdatePlayerName
    this._priIndexToId = {};        // 'PRI_TA_X' -> platformId (persists across match for cached players)
    this._nameToIdMap = {};         // playerName.toLowerCase().trim() -> platformId
    this._rosterFetching = new Set(); // prevent duplicate fetches
    this._rosterCache = {};           // playerId -> { skills, timestamp }
    this._localPlayerSkills = null; // cached skills for local player
    this.isReplaying = false;       // replay state
    this._memoryCleanupTimeout = null;
    this._hiddenWindowLoaded = null;
    this._loadLocalRankIcons();
  }

  _loadLocalRankIcons() {
    this._localRankIconsBase64 = {};
    const tiersDir = path.join(this.appData, 'assets', 'IngameRank', 'Tiers');
    for (let i = 0; i <= 23; i++) {
      try {
        const filePath = path.join(tiersDir, `${i}.png`);
        if (fs.existsSync(filePath)) {
          const data = fs.readFileSync(filePath);
          this._localRankIconsBase64[i] = `data:image/png;base64,${data.toString('base64')}`;
        } else {
          this.logger.warn(`[tracker] Local rank icon not found: ${filePath}`);
        }
      } catch (err) {
        this.logger.error(`[tracker] Failed to load local rank icon ${i}: ${err.message}`);
      }
    }
    try {
      const casualPath = path.join(tiersDir, 'casual.png');
      if (fs.existsSync(casualPath)) {
        const data = fs.readFileSync(casualPath);
        this._localRankIconsBase64['casual'] = `data:image/png;base64,${data.toString('base64')}`;
      }
    } catch (err) {
      this.logger.error(`[tracker] Failed to load casual local rank icon: ${err.message}`);
    }
    try {
      const overlayPath = path.join(tiersDir, 'unranked_overlay.png');
      if (fs.existsSync(overlayPath)) {
        const data = fs.readFileSync(overlayPath);
        this._localRankIconsBase64['unranked_overlay'] = `data:image/png;base64,${data.toString('base64')}`;
      }
    } catch (err) {
      this.logger.error(`[tracker] Failed to load unranked_overlay local rank icon: ${err.message}`);
    }
  }

  getRankIcon(tierNum) {
    if (tierNum === 'casual') {
      if (this._localRankIconsBase64 && this._localRankIconsBase64['casual']) {
        return this._localRankIconsBase64['casual'];
      }
      return '';
    }
    if (tierNum === 'unranked_overlay') {
      if (this._localRankIconsBase64 && this._localRankIconsBase64['unranked_overlay']) {
        return this._localRankIconsBase64['unranked_overlay'];
      }
      return '';
    }
    const t = (tierNum !== undefined && tierNum !== null && !isNaN(tierNum)) ? parseInt(tierNum, 10) : 23;
    const resolvedTier = (t >= 0 && t <= 23) ? t : 23;
    if (this._localRankIconsBase64 && this._localRankIconsBase64[resolvedTier]) {
      return this._localRankIconsBase64[resolvedTier];
    }
    return resolvedTier > 0 ? `https://trackercdn.com/cdn/tracker.gg/rocket-league/ranks/s4-${resolvedTier}.png` : '';
  }

  get session() {
    const activeUsername = (this.usernames[this.activeAccountIndex] || 'default').trim().toLowerCase();
    if (!this.sessions[activeUsername]) {
      this.sessions[activeUsername] = {
        wins: 0, losses: 0, streak: 0,
        startMmr: {}, currentMmr: {},
        rankIcons: {}, rankNames: {},
        divisions: {}, matchesPlayed: {}
      };
    }
    return this.sessions[activeUsername];
  }

  _findLaunchLog() {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const home = os.homedir();
    
    let registryDocuments = '';
    try {
      const { execSync } = require('child_process');
      const cmd = '[Environment]::GetFolderPath("MyDocuments")';
      registryDocuments = execSync(`powershell.exe -NoProfile -NonInteractive -Command "${cmd}"`, { encoding: 'utf8' }).trim();
    } catch (e) {}

    const candidates = [];
    if (registryDocuments) {
      candidates.push(path.join(registryDocuments, 'My Games', 'Rocket League', 'TAGame', 'Logs', 'Launch.log'));
    }
    candidates.push(
      path.join(home, 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Logs', 'Launch.log'),
      path.join(home, 'OneDrive', 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Logs', 'Launch.log'),
      path.join(home, 'OneDrive - Personal', 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Logs', 'Launch.log'),
      path.join(process.env.LOCALAPPDATA || '', 'Rocket League', 'Saved', 'Logs', 'Launch.log'),
      path.join(process.env.APPDATA || '', '..', 'Local', 'Rocket League', 'Saved', 'Logs', 'Launch.log')
    );
    
    const found = candidates.find(p => fs.existsSync(p));
    if (found) return found;

    try {
      const oneDriveRoot = path.join(home, 'OneDrive');
      if (fs.existsSync(oneDriveRoot)) {
        const dirs = fs.readdirSync(oneDriveRoot);
        for (const dir of dirs) {
          const p = path.join(oneDriveRoot, dir, 'My Games', 'Rocket League', 'TAGame', 'Logs', 'Launch.log');
          if (fs.existsSync(p)) return p;
        }
      }
    } catch (e) {}

    return candidates[0] || path.join(home, 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Logs', 'Launch.log');
  }

  _getOrCreateHiddenWindow() {
    if (!this.hiddenWindow || this.hiddenWindow.isDestroyed()) {
      this.logger.info('[tracker] Creating memory-optimized hiddenWindow');
      this.hiddenWindow = new BrowserWindow({
        show: false,
        width: 100,
        height: 100,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false,
          backgroundThrottling: false,
          images: false,
          webgl: false
        }
      });
      this.hiddenWindow.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      this.hiddenWindow.webContents.setAudioMuted(true);
      this._hiddenWindowLoaded = this.hiddenWindow.loadURL('https://rocketleague.tracker.network/robots.txt').catch(err => {
        this.logger.error(`[tracker] Failed to load initial context URL in hiddenWindow: ${err.message}`);
      });
    }
    return this.hiddenWindow;
  }

  _cleanMemory() {
    this.logger.info('[tracker] Executing periodic memory cleanup...');
    // We keep the hiddenWindow alive to avoid the huge overhead of repeatedly destroying and recreating it.
    
    try {
      const now = Date.now();
      const CACHE_TTL = 3 * 60 * 60 * 1000;
      let cleanedCount = 0;
      for (const key in this._rosterCache) {
        if (now - this._rosterCache[key].timestamp > CACHE_TTL) {
          delete this._rosterCache[key];
          cleanedCount++;
        }
      }
      if (cleanedCount > 0) {
        this.logger.info(`[tracker] Cleaned ${cleanedCount} expired entries from roster cache`);
      }
    } catch (err) {
      this.logger.warn(`[tracker] Error cleaning roster cache: ${err.message}`);
    }

    try {
      const { session } = require('electron');
      if (session && session.defaultSession) {
        session.defaultSession.clearCache().then(() => {
          this.logger.info('[tracker] Electron default session cache cleared');
        }).catch(err => {
          this.logger.warn(`[tracker] failed to clear session cache async: ${err.message}`);
        });
      }
    } catch (err) {
      this.logger.warn(`[tracker] Error clearing session cache: ${err.message}`);
    }
    if (global.gc && !this.inMatch) {
      global.gc();
    }
  }

  _checkAndScheduleMemoryCleanup() {
    if (this._memoryCleanupTimeout) {
      clearTimeout(this._memoryCleanupTimeout);
      this._memoryCleanupTimeout = null;
    }
    // Only schedule memory cleanup when not in match
    if (this._rosterFetching.size === 0 && !this.inMatch) {
      this.logger.info('[tracker] No active roster fetches. Scheduling memory cleanup in 60s...');
      this._memoryCleanupTimeout = setTimeout(() => {
        this._cleanMemory();
        this._memoryCleanupTimeout = null;
      }, 60000);
    }
  }

  async init(cfg) {
    this._activateStatsApi(cfg);
    this._getOrCreateHiddenWindow();

    this.playlist = cfg.tracker?.selectedPlaylist || '2v2';
    if (this.playlist === 'casual') {
      this.playlist = '2v2';
    }
    
    this.playerIds = cfg.tracker?.playerIds || {};
    // Pre-populate known player IDs if missing
    if (!this.playerIds['wrc090909']) {
      this.playerIds['wrc090909'] = 'Epic|cf061acd265c470481766e4d76ba3e95|0';
    }
    if (!this.playerIds['willo_on_200hz']) {
      this.playerIds['willo_on_200hz'] = 'Epic|a31c295072b14e2b917dd5a6666d6cd2|0';
    }

    // Load accounts list
    this.usernames = cfg.tracker?.usernames || [];
    if (this.usernames.length === 0) {
      if (cfg.tracker?.username) this.usernames.push(cfg.tracker.username);
      if (cfg.tracker?.username2) this.usernames.push(cfg.tracker.username2);
    }
    this.usernames = [...new Set(this.usernames.filter(Boolean))];
    if (this.usernames.length === 0) {
      this.usernames.push('');
    }

    const legacyActiveAccount = cfg.tracker?.activeAccount || 1;
    this.activeAccountIndex = cfg.tracker?.activeAccountIndex !== undefined 
      ? cfg.tracker.activeAccountIndex 
      : (legacyActiveAccount === 2 ? 1 : 0);

    // Scan Launch.log at startup for existing player name and active match
    if (fs.existsSync(this._launchLogPath)) {
      const detected = this._scanLogForLocalPlayer();
      if (detected) {
        this.detectedLocalPlayer = detected;
        const idx = this.usernames.findIndex(u => u.trim().toLowerCase() === detected.name.trim().toLowerCase());
        if (idx !== -1) {
          this.activeAccountIndex = idx;
          if (this.usernames[idx] !== detected.name) {
            this.logger.info(`[tracker] Startup correcting username case from "${this.usernames[idx]}" to "${detected.name}"`);
            this.usernames[idx] = detected.name;
            this.updateUsernames(this.usernames);
          }
          this.logger.info(`[tracker] Startup auto-switch active account to detected player: ${detected.name} (index: ${idx})`);
        } else {
          // Account switched: auto-register the new username
          this.logger.info(`[tracker] Startup: new account detected ("${detected.name}"), auto-registering and setting as active.`);
          this.usernames.push(detected.name);
          this.activeAccountIndex = this.usernames.length - 1;
          this.updateUsernames(this.usernames);
        }
      }
      await this._scanLogForActiveMatch().catch(() => {});
    }

    if (this.activeAccountIndex >= this.usernames.length) {
      this.activeAccountIndex = 0;
    }

    // Keep legacy fields in sync for compatibility
    this.username1 = this.usernames[0] || '';
    this.username2 = this.usernames[1] || '';
    this.activeAccount = this.activeAccountIndex === 1 ? 2 : 1;
    
    const activeUsername = this.usernames[this.activeAccountIndex];
    if (activeUsername) {
      this.fetchProfile(activeUsername).then(p => { this.profile = p; }).catch(() => {});
      this._spawnTempHiddenBrowser(activeUsername);
    }
    if (fs.existsSync(this._launchLogPath)) {
      this._lastLogSize = fs.statSync(this._launchLogPath).size;
      this._logPollingStarted = true;
    } else {
      this._logPollingStarted = false;
    }
    this._startPolling();
    this._connectWebSocket();
    this._connectLocalStatsApi();
    this.logger.info(`TrackerModule init: playlist=${this.playlist}, lastLogSize=${this._lastLogSize}`);
  }

  _startPolling() {
    this._pollInterval = setInterval(() => this._pollLaunchLog(), 2000);

    // Auto-refresh del profilo tracker.gg ogni 60 secondi
    this._profileRefreshInterval = setInterval(async () => {
      if (this.inMatch) {
        this.logger.info('[tracker] Auto-refresh skipped because player is in match');
        return;
      }
      const activeUsername = this.usernames[this.activeAccountIndex];
      if (!activeUsername) return;
      try {
        await this.fetchProfile(activeUsername);
        this.emit('update', this._buildUpdate());
        this.logger.info('[tracker] Auto-refresh profilo completato');
      } catch(e) {
        this.logger.warn(`[tracker] Auto-refresh fallito: ${e.message}`);
      }
    }, 60000);
  }

  async _pollLaunchLog() {
    if (!fs.existsSync(this._launchLogPath)) return;
    try {
      const stat = fs.statSync(this._launchLogPath);
      
      if (!this._logPollingStarted) {
        this._logPollingStarted = true;
        this._lastLogSize = stat.size;
        this.logger.info(`[tracker] Launch.log polling started. Initialized pointer to ${stat.size}`);
        return;
      }

      // Handle log truncation / rotation
      if (stat.size < this._lastLogSize) {
        this.logger.info('[tracker] Launch.log truncated — resetting log size pointer');
        this._lastLogSize = 0;
      }
      
      if (stat.size === this._lastLogSize) return;

      const fd = fs.openSync(this._launchLogPath, 'r');
      const buf = Buffer.alloc(stat.size - this._lastLogSize);
      fs.readSync(fd, buf, 0, buf.length, this._lastLogSize);
      fs.closeSync(fd);
      this._lastLogSize = stat.size;

      const lines = buf.toString('utf8').split('\n');
      for (const line of lines) {
        await this._parseLine(line.trim());
      }
    } catch (e) {
      this.logger.error(`LaunchLog poll error: ${e.message}`);
    }
  }

  _scanLogForLocalPlayer() {
    if (!fs.existsSync(this._launchLogPath)) return null;
    try {
      const content = fs.readFileSync(this._launchLogPath, 'utf8');
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        const loginMatch = line.match(/PlayerName=(.*?)\s+PlayerID=([^ \n\r\t]+)/);
        if (loginMatch) {
          const name = loginMatch[1];
          const fullId = loginMatch[2];
          this.logger.info(`[tracker] Scanned historical login from Launch.log: Name=${name}, ID=${fullId}`);
          
          const lowerName = name.toLowerCase().trim();
          if (!this.playerIds[lowerName] || this.playerIds[lowerName] !== fullId) {
            this.playerIds[lowerName] = fullId;
            this.settings.save({
              tracker: {
                ...this.settings.load().tracker,
                playerIds: this.playerIds
              }
            });
          }

          return { name, fullId };
        }
      }
    } catch (err) {
      this.logger.error(`[tracker] Error scanning historical Launch.log: ${err.message}`);
    }
    return null;
  }

  async _scanLogForActiveMatch() {
    if (!fs.existsSync(this._launchLogPath)) return;
    try {
      const content = fs.readFileSync(this._launchLogPath, 'utf8');
      const lines = content.split('\n');
      
      let lastMatchStartIdx = -1;
      let lastMatchEndIdx = -1;
      let matchGuid = null;
      
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        
        if (lastMatchEndIdx === -1 && (
          line.includes('XPProgression: SaveData_TA.HandleRewardDropNotification') || 
          line.includes('Total XP Earned') || 
          line.includes('MatchEnded') || 
          line.includes('LoadMap: MENU_Main_p')
        )) {
          lastMatchEndIdx = i;
        }
        
        if (lastMatchStartIdx === -1) {
          const guidMatch = line.match(/MatchGUID:\s*([A-F0-9]{32})/i) || line.match(/MatchInitialized.*guid="([A-F0-9]{32})"/i);
          if (guidMatch) {
            lastMatchStartIdx = i;
            matchGuid = guidMatch[1];
          }
        }
        
        if (lastMatchStartIdx !== -1 && lastMatchEndIdx !== -1) {
          break;
        }
      }
      
      if (lastMatchStartIdx !== -1 && (lastMatchEndIdx === -1 || lastMatchStartIdx > lastMatchEndIdx)) {
        this.logger.info(`[tracker] Retroactive match start detected in Launch.log at line ${lastMatchStartIdx + 1} with GUID: ${matchGuid}`);
        
        let detectedPlaylist = '2v2';
        for (let i = lastMatchStartIdx; i >= 0; i--) {
          const line = lines[i].trim();
          if (line.includes('PlaylistId=') || line.includes('Playlist=')) {
            const playlistMatch = line.match(/PlaylistId=\((\d+)\)/) || line.match(/Playlist=(\d+)/);
            if (playlistMatch) {
              const plId = parseInt(playlistMatch[1], 10);
              const PLAYLIST_ID_MAP = {
                1: 'casual', 2: 'casual', 3: 'casual', 4: 'casual',
                10: '1v1', 11: '2v2', 13: '3v3',
                27: 'hoops', 28: 'rumble', 29: 'dropshot', 30: 'snowday',
                34: 'tournament', 38: 'tournament', 40: 'tournament'
              };
              if (PLAYLIST_ID_MAP[plId]) {
                detectedPlaylist = PLAYLIST_ID_MAP[plId];
                this.logger.info(`[tracker] Retroactive match playlist detected: ${detectedPlaylist} (ID: ${plId})`);
                break;
              }
            }
          }
          if (lastMatchStartIdx - i > 500) {
            break;
          }
        }
        
        this.detectedPlaylist = detectedPlaylist;
        await this._onMatchStart(matchGuid);
        this.logger.info(`[tracker] Parsing retroactive log lines from match start (line ${lastMatchStartIdx + 1}) to end of file...`);
        for (let i = lastMatchStartIdx; i < lines.length; i++) {
          await this._parseLine(lines[i].trim());
        }
      } else {
        this.logger.info('[tracker] No active match detected in historical Launch.log scan');
      }
    } catch (err) {
      this.logger.error(`[tracker] Error scanning Launch.log for active match: ${err.message}`);
    }
  }

  async _parseLine(line) {
    // Parse local player login to auto-resolve usernames
    const loginMatch = line.match(/PlayerName=(.*?)\s+PlayerID=([^ \n\r\t]+)/);
    if (loginMatch) {
      const name = loginMatch[1];
      const fullId = loginMatch[2];
      
      const lowerName = name.toLowerCase().trim();
      if (!this.playerIds[lowerName] || this.playerIds[lowerName] !== fullId) {
        this.playerIds[lowerName] = fullId;
        this.settings.save({
          tracker: {
            ...this.settings.load().tracker,
            playerIds: this.playerIds
          }
        });
      }

      if (!this.detectedLocalPlayer || this.detectedLocalPlayer.name !== name) {
        this.detectedLocalPlayer = { name, fullId };
        this.logger.info(`[tracker] Detected login via Launch.log: Name=${name}, ID=${fullId}`);
        const idx = this.usernames.findIndex(u => u.trim().toLowerCase() === name.trim().toLowerCase());
        if (idx !== -1) {
          // Already known: fix case and switch to it
          if (this.usernames[idx] !== name) {
            this.logger.info(`[tracker] Correcting username case from "${this.usernames[idx]}" to "${name}"`);
            this.usernames[idx] = name;
            this.updateUsernames(this.usernames);
          }
          if (this.activeAccountIndex !== idx) {
            this.logger.info(`[tracker] Auto-switching active account to "${name}" (index: ${idx})`);
            this.activeAccountIndex = idx;
            this.username1 = this.usernames[0] || '';
            this.username2 = this.usernames[1] || '';
            this.activeAccount = this.activeAccountIndex === 1 ? 2 : 1;
            this.emit('account-switched', { name, index: idx });
          }
        } else {
          // New account never seen before: auto-register it
          this.logger.info(`[tracker] New account detected ("${name}"), auto-registering and switching to it.`);
          this.usernames.push(name);
          this.activeAccountIndex = this.usernames.length - 1;
          this.username1 = this.usernames[0] || '';
          this.username2 = this.usernames[1] || '';
          this.activeAccount = this.activeAccountIndex === 1 ? 2 : 1;
          this.updateUsernames(this.usernames);
          this.emit('account-switched', { name, index: this.activeAccountIndex });
        }
        this.emit('local-player-login', { name, fullId });
      }
    }

    // Parse playlist id from matchmaking/server join log entries
    if (line.includes('PlaylistId=') || line.includes('Playlist=')) {
      const playlistMatch = line.match(/PlaylistId=\((\d+)\)/) || line.match(/Playlist=(\d+)/);
      if (playlistMatch) {
        const plId = parseInt(playlistMatch[1], 10);
        const PLAYLIST_ID_MAP = {
          // Casual
          1: 'casual',
          2: 'casual',
          3: 'casual',
          4: 'casual',
          // Ranked
          10: '1v1',
          11: '2v2',
          13: '3v3',
          // Extra Modes
          27: 'hoops',
          28: 'rumble',
          29: 'dropshot',
          30: 'snowday',
          // Tournaments
          34: 'tournament',
          38: 'tournament',
          40: 'tournament'
        };
        if (PLAYLIST_ID_MAP[plId]) {
          const detected = PLAYLIST_ID_MAP[plId];
          if (this.detectedPlaylist !== detected) {
            this.detectedPlaylist = detected;
            this.logger.info(`[tracker] Detected playlist in-game: ${detected} (ID: ${plId})`);
            
            // If active playlist is set to auto-detect 'current', trigger update immediately
            if (this.playlist === 'current') {
              this.emit('update', this._buildUpdate());
            }
          }
        }
      }
    }

    // ── Roster: log parsing ────────────────────────────
    if (!this.isTcpConnected && !this._hasStatsApiData) {
      // Step 1: "ScriptLog: Uncached PlatformId for Epic|abc|0" — push to queue
      const uncachedMatch = line.match(/Uncached PlatformId for ([A-Za-z0-9]+\|[^|\s]+\|\d+)/);
      if (uncachedMatch) {
        this._pendingPlayerIds.push(uncachedMatch[1]);
        // Keep queue small (max 8 entries) to avoid memory leak
        if (this._pendingPlayerIds.length > 8) this._pendingPlayerIds.shift();
      }
      // Step 2: "HideName: UpdatePlayerName PRI=PRI_TA_X <PlayerName> ViewerPRI=..."
      if (line.includes('UpdatePlayerName')) {
        const nameMatch = line.match(/UpdatePlayerName\s+PRI=(\S+)\s+(.*?)\s+ViewerPRI=/);
        if (nameMatch) {
          const priKey = nameMatch[1].trim();   // e.g. 'PRI_TA_2'
          const playerName = nameMatch[2].trim();
          if (!playerName || priKey === 'None') return;

          let playerId = null;
          if (this._pendingPlayerIds.length > 0) {
            // Fresh Uncached PlatformId available — pop and store PRI mapping
            playerId = this._pendingPlayerIds.shift();
            this._priIndexToId[priKey] = playerId;
            this._nameToIdMap[playerName.toLowerCase().trim()] = playerId;
            this.logger.info(`[roster] PRI map: ${priKey} -> ${playerId} (name cache saved)`);
          } else if (this._priIndexToId[priKey]) {
            // Player ID is cached by RL (no new Uncached line) — reuse known mapping
            playerId = this._priIndexToId[priKey];
            this._nameToIdMap[playerName.toLowerCase().trim()] = playerId;
          } else if (this._nameToIdMap[playerName.toLowerCase().trim()]) {
            // Fallback: Resolve via name-to-ID map
            playerId = this._nameToIdMap[playerName.toLowerCase().trim()];
            this._priIndexToId[priKey] = playerId;
            this.logger.info(`[roster] PRI map from name cache: ${priKey} -> ${playerId}`);
          } else {
            // Fallback 2: Generate fallback epic|Name platform ID for uncached/console players
            playerId = `epic|${playerName.toLowerCase().trim()}`;
            this._priIndexToId[priKey] = playerId;
            this.logger.info(`[roster] PRI map fallback (generated): ${priKey} -> ${playerId}`);
          }

          if (!playerId) return; // ID unknown, skip

          const activeUsername = this.usernames[this.activeAccountIndex] || '';
          const lowerActiveUser = activeUsername.toLowerCase().trim();
          const isOurs = (this.detectedLocalPlayer && this.detectedLocalPlayer.fullId === playerId) ||
                         (this.detectedLocalPlayer && this.detectedLocalPlayer.name.toLowerCase().trim() === playerName.toLowerCase().trim()) ||
                         (lowerActiveUser && playerName.toLowerCase().trim() === lowerActiveUser) ||
                         (this.playerIds[lowerActiveUser] === playerId);

          // Extract PRI number
          const priMatch = priKey.match(/\d+/);
          const priNum = priMatch ? parseInt(priMatch[0], 10) : 999;

          if (isOurs) {
            this._addLocalPlayerToRoster(playerName, this._localPlayerSkills, priNum);
          } else if (!this._rosterMap[playerId]) {
            // Only add on first encounter to avoid spamming fetches
            this.logger.info(`[roster] Detected player: ${playerName} (${playerId})`);
            const team = 1; // opponents
            this._rosterMap[playerId] = { name: playerName, playerId, team, priNum };
            this._fetchRosterPlayer(playerId, playerName);
          }
        }
      }
    }

    // Match created
    if (line.includes('MatchCreated')) {
      this.inMatch = false;
      this.matchGuid = null;
    }
    // Match initialized with real GUID (handles both C++ and newer log lines)
    const guidMatch = line.match(/MatchGUID:\s*([A-F0-9]{32})/i) || line.match(/MatchInitialized.*guid="([A-F0-9]{32})"/i);
    if (guidMatch) {
      const guid = guidMatch[1];
      if (guid && guid !== this.matchGuid) {
        this.matchGuid = guid;
        this.inMatch = true;
        this.logger.info(`[tracker] MatchGUID detected: "${guid}"`);
        await this._onMatchStart(guid);
      }
    }
    // Match ended (handles C++, newer XPProgression/Reward drop events, and returning to main menu / quitting)
    if (line.includes('XPProgression: SaveData_TA.HandleRewardDropNotification') || 
        line.includes('Total XP Earned') || 
        line.includes('MatchEnded') || 
        line.includes('Match Ended') || 
        line.includes('LoadMap: MENU_Main_p')) {
      if (this.inMatch) {
        this.inMatch = false;
        this.logger.info('[tracker] Match end / quit event detected in Launch.log');
        await this._onMatchEnd();
      }
    }
    // RL closed
    if (line.includes('WindowSizeChanged') && line.includes('0x0')) {
      this.logger.info('[tracker] Rocket League closed — resetting session');
      this._resetSession();
    }
  }

  async _fetchUrlViaBrowser(url) {
    const isNew = !this.hiddenWindow || this.hiddenWindow.isDestroyed();
    const hw = this._getOrCreateHiddenWindow();
    if (isNew && this._hiddenWindowLoaded) {
      await this._hiddenWindowLoaded;
    }

    try {
      const escapedUrl = url.replace(/'/g, "\\'");
      const js = `
        fetch('${escapedUrl}')
          .then(r => {
            if (r.status === 200) return r.json().then(data => ({ status: 200, data }));
            return r.text().then(text => ({ status: r.status, error: text.substring(0, 500) }));
          })
          .catch(err => ({ status: -1, error: err.message }))
      `;
      const result = await this.hiddenWindow.webContents.executeJavaScript(js);
      return result;
    } catch (err) {
      this.logger.error(`[tracker] _fetchUrlViaBrowser failed for ${url}: ${err.message}`);
      return { status: -1, error: err.message };
    }
  }

  async _fetchRosterPlayer(playerId, playerName) {
    if (this._memoryCleanupTimeout) {
      clearTimeout(this._memoryCleanupTimeout);
      this._memoryCleanupTimeout = null;
    }
    if (this._rosterFetching.has(playerId)) return;
    this._rosterFetching.add(playerId);

    // 1. Cache lookup
    const cached = this._rosterCache[playerId];
    const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours cache TTL
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      this.logger.info(`[roster] Cache hit for ${playerName} (${playerId})`);
      if (this._rosterMap[playerId]) {
        this._rosterMap[playerId].allSkills = cached.skills;
        this._updateRosterPlayerFromSkills(playerId);
        this.emit('roster-update', this._buildRoster());
      }
      this._rosterFetching.delete(playerId);
      this._checkAndScheduleMemoryCleanup();
      return;
    }

    // Bypass suspended bridge server and go directly to tracker.gg using the hidden browser to bypass Cloudflare
    const parts = playerId.split('|');
    const platform = parts[0].toLowerCase();
    const platformMap = {
      'epic': 'epic',
      'steam': 'steam',
      'ps4': 'psn',
      'ps5': 'psn',
      'playstation': 'psn',
      'psn': 'psn',
      'xbox': 'xbl',
      'xboxone': 'xbl',
      'xboxseries': 'xbl',
      'xbl': 'xbl',
      'switch': 'switch',
      'nintendo': 'switch'
    };
    const trackerPlatform = platformMap[platform];

    if (trackerPlatform) {
      let queryIdentifier = playerName;
      if (platform === 'steam') {
        queryIdentifier = parts[1] || playerName;
      }
      // If playerName is censored/asterisks, try using platform account ID (parts[1])
      if (queryIdentifier.includes('*') || !queryIdentifier.trim()) {
        if (parts[1] && !parts[1].includes('*') && parts[1] !== '0') {
          queryIdentifier = parts[1];
        }
      }

      // Detect censored / private profiles if queryIdentifier is STILL asterisks or empty
      const strippedAsterisks = queryIdentifier.replace(/\*/g, '').trim();
      if (!strippedAsterisks || queryIdentifier.replace(/\s/g,'') === '') {
        this.logger.info(`[roster] Skipping fetch for censored/private player: "${playerName}" (${playerId})`);
        this._rosterCache[playerId] = { skills: {}, timestamp: Date.now() };
        if (this._rosterMap[playerId]) {
          this._rosterMap[playerId].privateProfile = true;
          this._rosterMap[playerId].allSkills = {}; // Mark as resolved-but-private
          this._updateRosterPlayerFromSkills(playerId);
          this.emit('roster-update', this._buildRoster());
        }
        this._rosterFetching.delete(playerId);
        this._checkAndScheduleMemoryCleanup();
        return;
      }

      // Stagger requests to avoid Cloudflare rate limit bursts
      const delay = Math.random() * 2000;
      await new Promise(resolve => setTimeout(resolve, delay));

      this.logger.info(`[roster] Fallback to tracker.gg via browser for ${playerName} (${trackerPlatform}/${queryIdentifier})`);

      // Eseguiamo un fetch veloce per l'overview HTML nella hidden window per forzare tracker.gg a interrogare PsyNet in background (come fa Shift)
      const overviewUrl = `https://rocketleague.tracker.network/rocket-league/profile/${trackerPlatform}/${encodeURIComponent(queryIdentifier)}/overview`;
      this.logger.info(`[roster] Refreshing database for ${playerName} via overview page: ${overviewUrl}`);
      try {
        const escapedOverviewUrl = overviewUrl.replace(/'/g, "\\'");
        const triggerJs = `
          fetch('${escapedOverviewUrl}')
            .then(r => r.status)
            .catch(() => -1)
        `;
        await this.hiddenWindow.webContents.executeJavaScript(triggerJs);
      } catch (err) {
        this.logger.warn(`[roster] Failed to trigger overview page fetch for ${playerName}: ${err.message}`);
      }

      // Aspettiamo 800ms affinché tracker.gg finisca la sincronizzazione con PsyNet in background
      await new Promise(resolve => setTimeout(resolve, 800));

      const url = `https://api.tracker.gg/api/v2/rocket-league/standard/profile/${trackerPlatform}/${encodeURIComponent(queryIdentifier)}?t=${Date.now()}`;
      
      try {
        const res = await this._fetchUrlViaBrowser(url);
        if (res.status === 200 && res.data?.data?.segments) {
          const skills = this._parseTrackerGgSegmentsToSkills(res.data.data.segments);
          this._rosterCache[playerId] = { skills, timestamp: Date.now() };
          if (this._rosterMap[playerId]) {
            this._rosterMap[playerId].allSkills = skills;
            this._updateRosterPlayerFromSkills(playerId);
            this.logger.info(`[roster] ${playerName} (${playerId}) fetched via tracker.gg`);
            this.emit('roster-update', this._buildRoster());
          }
        } else {
          this.logger.warn(`[roster] Tracker.gg fallback returned error or no segments for ${playerName}: status=${res.status} error=${res.error || 'no segments'}`);
          this._rosterCache[playerId] = { skills: {}, timestamp: Date.now() };
          if (this._rosterMap[playerId]) {
            this._rosterMap[playerId].allSkills = {};
            this._rosterMap[playerId].privateProfile = true;
            this._updateRosterPlayerFromSkills(playerId);
            this.emit('roster-update', this._buildRoster());
          }
        }
      } catch (err) {
        this.logger.error(`[roster] Tracker.gg fallback failed for ${playerName}: ${err.message}`);
        this._rosterCache[playerId] = { skills: {}, timestamp: Date.now() };
        if (this._rosterMap[playerId]) {
          this._rosterMap[playerId].allSkills = {};
          this._rosterMap[playerId].privateProfile = true;
          this._updateRosterPlayerFromSkills(playerId);
          this.emit('roster-update', this._buildRoster());
        }
      }
    } else {
      this.logger.warn(`[roster] Tracker.gg fallback skipped for ${playerName}: unknown platform ${platform}`);
      this._rosterCache[playerId] = { skills: {}, timestamp: Date.now() };
      if (this._rosterMap[playerId]) {
        this._rosterMap[playerId].allSkills = {};
        this._rosterMap[playerId].privateProfile = true;
        this._updateRosterPlayerFromSkills(playerId);
        this.emit('roster-update', this._buildRoster());
      }
    }

    this._rosterFetching.delete(playerId);
    this._checkAndScheduleMemoryCleanup();
  }

  _parseTrackerGgSegmentsToSkills(segments) {
    const skills = {};
    for (const seg of segments) {
      const playlist = seg.metadata?.name?.toLowerCase().replace(/\s+/g, '') || '';
      const rating = seg.stats?.rating;
      if (rating && rating.value !== undefined) {
        const key = this._normalizePlaylist(playlist);
        if (key) {
          const mmr = rating.value;
          const matches = seg.stats?.matchesPlayed?.value || 0;
          const rawIconUrl = rating.metadata?.iconUrl || '';
          let tierNum = 23;
          let calculatedRankName = rating.metadata?.tierName || '';
          let calculatedDivisionName = seg.stats?.division?.metadata?.name || '';
          const isUnranked = (seg.stats?.tier?.value === 0 || calculatedRankName.toLowerCase() === 'unranked');
          if (isUnranked && mmr > 0) {
            const est = this._estimateUnrankedRank(mmr, key);
            tierNum = est.tier;
            calculatedRankName = est.rankName;
            calculatedDivisionName = est.divisionName;
          } else if (seg.stats?.tier?.value !== undefined && seg.stats?.tier?.value !== null) {
            tierNum = parseInt(seg.stats.tier.value, 10);
          } else if (rawIconUrl) {
            const match = rawIconUrl.match(/s4-(\d+)\.png/);
            if (match) {
              tierNum = parseInt(match[1], 10);
            }
          }
          skills[key] = {
            mmr,
            tier: tierNum,
            division: seg.stats?.division?.value || 0,
            rankName: calculatedRankName,
            divisionName: calculatedDivisionName,
            peak: mmr,
            matchesPlayed: matches
          };
        }
      }
    }
    return skills;
  }

  _buildRoster() {
    const cfg = this.settings.load();
    const playlistOption = cfg.ingameRankPlaylist || 'current';
    const calculateUnranked = cfg.ingameRankCalculateUnranked !== false;
    const includeExtramodes = cfg.ingameRankIncludeExtramodes !== false;
    const includeTournaments = cfg.ingameRankIncludeTournaments !== false;

    // Resolve what playlist we show
    let plKey = '2v2';
    if (playlistOption === 'current') {
      plKey = this.detectedPlaylist || '2v2';
      if (plKey === 'casual') {
        plKey = 'best';
      }
    } else if (playlistOption === 'best') {
      plKey = 'best'; // handled per-player below
    } else {
      plKey = playlistOption;
    }

    // Filter playlist based on extra modes / tournaments configurations
    const isExtra = ['hoops', 'rumble', 'dropshot', 'snowday'].includes(plKey);
    const isTournament = plKey === 'tournament';
    if (isExtra && !includeExtramodes) {
      plKey = '2v2';
    }
    // When tournaments are excluded, hide the overlay entirely (inMatch=false)
    if (isTournament && !includeTournaments) {
      return { players: [], inMatch: false, playlist: 'tournament' };
    }

    // If Stats API is not connected, dynamically balance the teams (e.g. 2v2 or 3v3)
    // to prevent imbalanced team layouts (e.g. 1 vs 3) that break scoreboard alignment.
    if (!this.isTcpConnected && !this._hasStatsApiData) {
      const players = Object.values(this._rosterMap);
      if (players.length > 1) {
        const locals = players.filter(p => p.isLocal);
        const opponents = players.filter(p => !p.isLocal);
        
        // Imposta i locali nel team 0 (Blue) e gli avversari nel team 1 (Orange)
        locals.forEach(p => { p.team = 0; });
        opponents.forEach(p => { p.team = 1; });
      }
    }

    const playersList = Object.values(this._rosterMap).map(p => {
      // Ensure team assignment: local player = 0 (blue), opponents = 1 (orange)
      if (p.isLocal && p.team === undefined) p.team = 0;
      if (!p.isLocal && p.team === undefined) p.team = 1;
      let activePl = plKey;
      
      // If playlistOption is 'best', find the playlist with the highest MMR for this player
      if (playlistOption === 'best' && p.allSkills) {
        let maxMmr = -1;
        let bestPl = '2v2';
        for (const [mode, skill] of Object.entries(p.allSkills)) {
          if (mode === 'casual') continue; // Exclude casual from best rank selection
          const isModeExtra = ['hoops', 'rumble', 'dropshot', 'snowday'].includes(mode);
          if (isModeExtra && !includeExtramodes) continue;
          if (mode === 'tournament' && !includeTournaments) continue;

          if (skill && skill.mmr > maxMmr) {
            maxMmr = skill.mmr;
            bestPl = mode;
          }
        }
        activePl = bestPl;
      }

      let skill = p.allSkills?.[activePl];
      
      // Fallback: se il giocatore è Unranked nella modalità corrente, cerchiamo il suo rank competitivo migliore
      const isSkillUnrankedOrEmpty = !skill || skill.tier === 0 || (skill.rankName && skill.rankName.toLowerCase() === 'unranked') || (skill.mmr || 0) === 0;
      if (isSkillUnrankedOrEmpty && p.allSkills) {
        let maxMmrForFallback = -1;
        let fallbackSkill = null;
        const playlistsToCheck = ['2v2', '3v3', '1v1', 'tournament', 'rumble', 'hoops', 'dropshot', 'snowday'];
        for (const plCode of playlistsToCheck) {
          const s = p.allSkills[plCode];
          if (s && s.tier > 0 && s.mmr > maxMmrForFallback && s.rankName && s.rankName.toLowerCase() !== 'unranked') {
            maxMmrForFallback = s.mmr;
            fallbackSkill = s;
          }
        }
        if (fallbackSkill) {
          skill = fallbackSkill;
        }
      }

      if (!skill && activePl !== 'best') {
        skill = {
          mmr: p.mmr ?? 0,
          tier: p.tier ?? 0,
          division: p.division ?? 0,
          rankName: p.rankName ?? 'Unranked',
          divisionName: p.divisionName ?? '',
          peak: p.peak ?? 0
        };
      } else if (!skill) {
        skill = { mmr: 0, tier: 0, division: 0, rankName: 'Unranked', divisionName: '', peak: 0 };
      }

      let mmr = skill.mmr ?? 0;
      let tier = skill.tier ?? 0;
      let division = skill.division ?? 0;
      let rankName = skill.rankName ?? 'Unranked';
      let divisionName = skill.divisionName ?? '';
      let peak = skill.peak ?? mmr;

      // Estimate unranked rank from MMR (always translate unranked MMR to rank)
      const isUnranked = (tier === 0 || rankName.toLowerCase() === 'unranked');
      if (isUnranked && mmr > 0) {
        const est = this._estimateUnrankedRank(mmr, activePl);
        tier = est.tier;
        rankName = est.rankName;
        division = est.division;
        divisionName = est.divisionName;
      }

      const PLAYLIST_KEY_TO_ID = {
        '1v1': 10,
        '2v2': 11,
        '3v3': 13,
        'hoops': 27,
        'rumble': 28,
        'dropshot': 29,
        'snowday': 30,
        'tournament': 34,
        'quads': 61,
        'heatseeker': 63
      };

      return {
        name: p.name,
        playerId: p.playerId,
        mmr,
        tier,
        division,
        rankName,
        divisionName,
        peak,
        team: p.team,
        isLocal: !!p.isLocal,
        isUnranked: isUnranked,
        privateProfile: !!p.privateProfile,
        score: p.score ?? 0,
        goals: p.goals ?? 0,
        assists: p.assists ?? 0,
        saves: p.saves ?? 0,
        shots: p.shots ?? 0,
        playlistId: PLAYLIST_KEY_TO_ID[activePl] || 11,
        priNum: p.priNum ?? 999
      };
    });

    return {
      playlist: plKey === 'best' ? 'best' : plKey,
      players: playersList,
      inMatch: this.inMatch,
      isReplaying: !!this.isReplaying
    };
  }

  _estimateUnrankedRank(mmr, playlist) {
    const mmrVal = Math.round(mmr);
    const RANKS = [
      { tier: 1, name: 'Bronze I', minMmr: 0 },
      { tier: 2, name: 'Bronze II', minMmr: 150 },
      { tier: 3, name: 'Bronze III', minMmr: 210 },
      { tier: 4, name: 'Silver I', minMmr: 270 },
      { tier: 5, name: 'Silver II', minMmr: 330 },
      { tier: 6, name: 'Silver III', minMmr: 390 },
      { tier: 7, name: 'Gold I', minMmr: 450 },
      { tier: 8, name: 'Gold II', minMmr: 510 },
      { tier: 9, name: 'Gold III', minMmr: 570 },
      { tier: 10, name: 'Platinum I', minMmr: 630 },
      { tier: 11, name: 'Platinum II', minMmr: 690 },
      { tier: 12, name: 'Platinum III', minMmr: 750 },
      { tier: 13, name: 'Diamond I', minMmr: 810 },
      { tier: 14, name: 'Diamond II', minMmr: 890 },
      { tier: 15, name: 'Diamond III', minMmr: 970 },
      { tier: 16, name: 'Champion I', minMmr: 1050 },
      { tier: 17, name: 'Champion II', minMmr: 1175 },
      { tier: 18, name: 'Champion III', minMmr: 1300 },
      { tier: 19, name: 'Grand Champion I', minMmr: 1425 },
      { tier: 20, name: 'Grand Champion II', minMmr: 1560 },
      { tier: 21, name: 'Grand Champion III', minMmr: 1700 },
      { tier: 22, name: 'Supersonic Legend', minMmr: 1850 }
    ];

    const RANKS_1V1 = [
      { tier: 1, name: 'Bronze I', minMmr: 0 },
      { tier: 2, name: 'Bronze II', minMmr: 140 },
      { tier: 3, name: 'Bronze III', minMmr: 190 },
      { tier: 4, name: 'Silver I', minMmr: 240 },
      { tier: 5, name: 'Silver II', minMmr: 290 },
      { tier: 6, name: 'Silver III', minMmr: 340 },
      { tier: 7, name: 'Gold I', minMmr: 390 },
      { tier: 8, name: 'Gold II', minMmr: 440 },
      { tier: 9, name: 'Gold III', minMmr: 490 },
      { tier: 10, name: 'Platinum I', minMmr: 540 },
      { tier: 11, name: 'Platinum II', minMmr: 590 },
      { tier: 12, name: 'Platinum III', minMmr: 640 },
      { tier: 13, name: 'Diamond I', minMmr: 700 },
      { tier: 14, name: 'Diamond II', minMmr: 770 },
      { tier: 15, name: 'Diamond III', minMmr: 840 },
      { tier: 16, name: 'Champion I', minMmr: 920 },
      { tier: 17, name: 'Champion II', minMmr: 1000 },
      { tier: 18, name: 'Champion III', minMmr: 1080 },
      { tier: 19, name: 'Grand Champion I', minMmr: 1170 },
      { tier: 20, name: 'Grand Champion II', minMmr: 1270 },
      { tier: 21, name: 'Grand Champion III', minMmr: 1370 },
      { tier: 22, name: 'Supersonic Legend', minMmr: 1470 }
    ];

    const list = (playlist === '1v1') ? RANKS_1V1 : RANKS;
    let matched = list[0];
    let nextMin = 150;

    for (let i = 0; i < list.length; i++) {
      if (mmrVal >= list[i].minMmr) {
        matched = list[i];
        nextMin = (i < list.length - 1) ? list[i+1].minMmr : (list[i].minMmr + 150);
      } else {
        break;
      }
    }

    const range = nextMin - matched.minMmr;
    const diff = mmrVal - matched.minMmr;
    let division = 1;
    let divisionName = 'Division I';

    if (matched.tier < 22) {
      if (diff >= range * 0.75) {
        division = 4;
        divisionName = 'Division IV';
      } else if (diff >= range * 0.5) {
        division = 3;
        divisionName = 'Division III';
      } else if (diff >= range * 0.25) {
        division = 2;
        divisionName = 'Division II';
      }
    } else {
      division = 0;
      divisionName = '';
    }

    return {
      tier: matched.tier,
      rankName: matched.name,
      division,
      divisionName
    };
  }

  getRoster() {
    return this._buildRoster();
  }

  async _onMatchStart(guid) {
    if (guid && guid === this._lastMatchStartGuid) {
      this.logger.info(`[tracker] _onMatchStart throttled (already started for GUID: ${guid})`);
      return;
    }
    this._lastMatchStartGuid = guid;
    this.inMatch = true;
    this.isReplaying = false;

    // Clear roster for new match
    this._rosterMap = {};
    this._pendingPlayerIds = [];
    this._priIndexToId = {};
    this._rosterFetching.clear();
    this._hasStatsApiData = false;
    this.emit('roster-clear');
    this.logger.info('[roster] Cleared roster for new match');

    // Force fast reconnect to Stats API at match start to get all players quickly
    if (!this.isTcpConnected) {
      if (this._tcpReconnectTimeout) clearTimeout(this._tcpReconnectTimeout);
      this._tcpReconnectTimeout = setTimeout(() => this._connectLocalStatsApi(), 500);
    }

    // Track when this match started for stale-cleanup grace period
    this._matchStartTime = Date.now();
    const activeUsername = this.usernames[this.activeAccountIndex];
    if (activeUsername && this._localPlayerSkills) {
      this._addLocalPlayerToRoster(activeUsername, this._localPlayerSkills, 0);
    }

    this.logger.info(`[tracker] real match started — guid: ${guid}`);
    this.emit('match-start', {
      guid,
      playlist: this.playlist,
      ourMmr: this.session.currentMmr[this.playlist],
      profile: this.profile
    });
    this.emit('update', this._buildUpdate());
  }

  async _onMatchEnd() {
    const now = Date.now();
    if (now - this._lastMatchEndTimestamp < 5000) {
      this.logger.info('[tracker] _onMatchEnd throttled (called within 5 seconds)');
      return;
    }
    this._lastMatchEndTimestamp = now;
    this.inMatch = false;
    this.isReplaying = false;

    this.logger.info('[tracker] MatchEnded — scheduling rapid poll to detect MMR change');

    // Snapshot ALL ranked playlists before polling so we can detect ANY change
    const ALL_RANKED = ['1v1', '2v2', '3v3', 'rumble', 'hoops', 'dropshot', 'snowday', 'tournament'];
    const snapshotMmr     = {};
    const snapshotMatches = {};
    for (const key of ALL_RANKED) {
      snapshotMmr[key]     = this.session.currentMmr?.[key];
      snapshotMatches[key] = this.session.matchesPlayed?.[key] || 0;
    }

    let pollCount = 0;
    const maxPolls = 12; // 12 * 2s = 24s max
    const activeUsername = this.usernames[this.activeAccountIndex];

    if (activeUsername) {
      this.triggerProfileRefresh(activeUsername).catch(() => {});
    }

    const poll = async () => {
      if (!activeUsername) return;
      pollCount++;
      try {
        await this.fetchProfile(activeUsername);

        // Check every ranked playlist for any change
        for (const key of ALL_RANKED) {
          const curMmr     = this.session.currentMmr?.[key];
          const curMatches = this.session.matchesPlayed?.[key] || 0;

          if (curMatches > snapshotMatches[key]) {
            this.logger.info(`[tracker] Rapid poll: matchesPlayed advanced on ${key} (${snapshotMatches[key]} -> ${curMatches}). MMR: ${snapshotMmr[key]} -> ${curMmr}. Stopping.`);
            this.detectedPlaylist = key; // fix playlist detection for next _buildUpdate
            this.emit('update', this._buildUpdate());
            this._checkAndScheduleMemoryCleanup();
            return;
          }

          if (snapshotMmr[key] !== undefined && curMmr !== undefined && curMmr !== snapshotMmr[key]) {
            this.logger.info(`[tracker] Rapid poll: MMR changed on ${key}: ${snapshotMmr[key]} -> ${curMmr}. Stopping.`);
            this.detectedPlaylist = key;
            this.emit('update', this._buildUpdate());
            this._checkAndScheduleMemoryCleanup();
            return;
          }
        }
      } catch (err) {
        this.logger.error(`[tracker] Rapid poll error: ${err.message}`);
      }

      if (pollCount === 3) {
        this.logger.info('[tracker] MMR change not detected yet, re-triggering HTML refresh');
        this.triggerProfileRefresh(activeUsername).catch(() => {});
      }

      if (pollCount < maxPolls) {
        setTimeout(poll, 2000);
      } else {
        this.logger.info('[tracker] Rapid poll finished after reaching maxPolls.');
        this._checkAndScheduleMemoryCleanup();
      }
    };

    // Start first poll after 500ms (immediate reactivity)
    setTimeout(poll, 500);

    this.emit('match-end', this._buildUpdate());
  }

  async triggerProfileRefresh(username) {
    // Send a direct fetch to the HTML page instantly to start refreshing tracker.gg database from Psynet
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0';
    const triggerUrl = `https://rocketleague.tracker.network/rocket-league/profile/epic/${encodeURIComponent(username)}/overview`;
    this.logger.info(`[tracker] Triggering fast HTTP fetch refresh: ${triggerUrl}`);
    fetch(triggerUrl, { headers: { 'User-Agent': ua } }).catch((err) => {
      this.logger.warn(`[tracker] Fast HTTP fetch failed: ${err.message}`);
    });

    this._spawnTempHiddenBrowser(username);
  }

  _spawnTempHiddenBrowser(username) {
    if (!username) return;
    const now = Date.now();
    const lastSpawn = this._lastTempBrowserSpawnTime[username] || 0;
    if (now - lastSpawn < 15000) {
      this.logger.info(`[tracker] Throttle temp hidden browser spawn for ${username} (last spawn was ${Math.round((now - lastSpawn)/1000)}s ago)`);
      return;
    }
    this._lastTempBrowserSpawnTime[username] = now;

    const url = `https://rocketleague.tracker.network/rocket-league/profile/epic/${encodeURIComponent(username)}/overview`;
    this.logger.info(`[tracker] Creating temporary hidden browser to refresh: ${username}`);
    try {
      const tempWindow = new BrowserWindow({
        width: 1024,
        height: 768,
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false,
          backgroundThrottling: true,
          images: false,
          webgl: false
        }
      });
      
      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      tempWindow.webContents.setUserAgent(userAgent);
      tempWindow.webContents.setAudioMuted(true);
      
      tempWindow.loadURL(url).catch(e => {
        this.logger.error(`[tracker] Temp hidden browser load error: ${e.message}`);
      });
      
      let destroyed = false;
      const destroyWindow = () => {
        if (destroyed) return;
        destroyed = true;
        try {
          if (!tempWindow.isDestroyed()) {
            this.logger.info('[tracker] Destroying temporary hidden browser');
            tempWindow.destroy();
          }
        } catch (err) {
          this.logger.warn(`[tracker] Error destroying temp hidden browser: ${err.message}`);
        }
      };

      tempWindow.webContents.on('did-finish-load', () => {
        this.logger.info(`[tracker] Temp hidden browser finished loading: ${url}`);
        // Let it run for 15 seconds to execute JS/refresh, then destroy
        setTimeout(destroyWindow, 15000);
      });
      
      tempWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        this.logger.warn(`[tracker] Temp hidden browser failed to load: ${errorDescription} (${errorCode})`);
        setTimeout(destroyWindow, 5000);
      });
      
      // Safety backup timeout
      setTimeout(destroyWindow, 30000);

    } catch (err) {
      this.logger.error(`[tracker] Failed to create temp hidden browser: ${err.message}`);
    }
  }

  _activateStatsApi(cfg) {
    try {
      const fs = require('fs');
      const path = require('path');
      
      const content = `[IniVersion]\n0=1782409967.000000\n\n[TAGame.MatchStatsExporter_TA]\nPort=49123\nPacketSendRate=10\n`;

      // 1. Attivazione in TAStatsAPI.ini (Documenti utente)
      const os = require('os');
      const docCandidates = [
        path.join(os.homedir(), 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Config', 'TAStatsAPI.ini'),
        path.join(os.homedir(), 'OneDrive', 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Config', 'TAStatsAPI.ini')
      ];
      
      for (const iniPath of docCandidates) {
        const dir = path.dirname(iniPath);
        if (fs.existsSync(dir)) {
          let needsWrite = true;
          if (fs.existsSync(iniPath)) {
            try {
              const current = fs.readFileSync(iniPath, 'utf8');
              if (current.includes('[TAGame.MatchStatsExporter_TA]') && current.includes('PacketSendRate=10') && current.includes('Port=49123') && !current.includes('TAGame\\.')) {
                needsWrite = false;
              }
            } catch (e) {}
          }
          if (needsWrite) {
            fs.writeFileSync(iniPath, content, 'utf-8');
            this.logger.info(`[tracker] Stats API auto-activated in user config: ${iniPath}`);
          }
        }
      }

      // 2. Attivazione in DefaultStatsAPI.ini (Cartella installazione gioco)
      const cookedDir = cfg.target?.cookedDir || this.settings.load()?.target?.cookedDir;
      if (cookedDir) {
        const defaultIniPath = path.join(cookedDir, '..', 'Config', 'DefaultStatsAPI.ini');
        const defaultDir = path.dirname(defaultIniPath);
        if (fs.existsSync(defaultDir)) {
          let needsWrite = true;
          if (fs.existsSync(defaultIniPath)) {
            try {
              const current = fs.readFileSync(defaultIniPath, 'utf8');
              if (current.includes('[TAGame.MatchStatsExporter_TA]') && current.includes('PacketSendRate=10') && current.includes('Port=49123') && !current.includes('TAGame\\.')) {
                needsWrite = false;
              }
            } catch (e) {}
          }
          if (needsWrite) {
            fs.writeFileSync(defaultIniPath, content, 'utf-8');
            this.logger.info(`[tracker] Stats API auto-activated in default config: ${defaultIniPath}`);
          }
        }
      }
    } catch (err) {
      this.logger.error(`[tracker] Failed to auto-activate Stats API: ${err.message}`);
    }
  }

  _resetSession() {
    this.session.wins = 0;
    this.session.losses = 0;
    this.session.streak = 0;
    if (this.session.currentMmr && this.session.startMmr) {
      for (const key in this.session.currentMmr) {
        this.session.startMmr[key] = this.session.currentMmr[key];
      }
    }
    this.inMatch = false;
    this.matchGuid = null;
    this._lastLogSize = 0;
    this._hasStatsApiData = false;
    this.emit('update', this._buildUpdate());
  }

  // ── Add local player to roster (team 0 = blue) ────────────────────
  _addLocalPlayerToRoster(username, skills, priNum) {
    if (!username || !skills) return;
    const lowerName = username.toLowerCase().trim();
    const playerId = this.playerIds[lowerName] || `local|${username}`;

    const cfg = this.settings.load();
    const playlistOption = cfg.ingameRankPlaylist || 'current';
    let plKey = playlistOption === 'current' ? (this.detectedPlaylist || '2v2') : playlistOption;
    if (plKey === 'best') {
      let maxMmr = -1;
      for (const [mode, skill] of Object.entries(skills)) {
        if (mode === 'casual') continue; // Exclude casual from best rank selection
        if ((skill.mmr ?? 0) > maxMmr) { maxMmr = skill.mmr; plKey = mode; }
      }
    }

    const skill = skills[plKey] || skills['2v2'] || skills['1v1'] || Object.values(skills)[0] || {};
    const existing = this._rosterMap[playerId];
    const existingLocal = Object.values(this._rosterMap).find(entry => entry.isLocal);
    const team = (existingLocal && existingLocal.team !== undefined)
      ? existingLocal.team
      : ((existing && existing.team !== undefined) ? existing.team : 0);
    this._rosterMap[playerId] = {
      name: username,
      playerId,
      isLocal: true,
      team: team,
      mmr: skill.mmr ?? 0,
      tier: skill.tier ?? 0,
      division: skill.division ?? 0,
      rankName: skill.rankName ?? 'Unranked',
      divisionName: skill.divisionName ?? '',
      peak: skill.peak ?? skill.mmr ?? 0,
      allSkills: skills,
      priNum: priNum !== undefined ? priNum : (existing?.priNum ?? 0)
    };
    this.logger.info(`[roster] Local player added: ${username} tier=${skill.tier} mmr=${skill.mmr} rankName=${skill.rankName} team=${team} priNum=${this._rosterMap[playerId].priNum}`);
    this.emit('roster-update', this._buildRoster());
  }

  async fetchProfile(username) {
    if (this._memoryCleanupTimeout) {
      clearTimeout(this._memoryCleanupTimeout);
      this._memoryCleanupTimeout = null;
    }
    // Bypass bridge server completely and go directly to tracker.gg via browser to bypass Cloudflare
    const url = `https://api.tracker.gg/api/v2/rocket-league/standard/profile/epic/${encodeURIComponent(username)}?t=${Date.now()}`;
    this.logger.info(`[tracker] fetchProfile (tracker.gg via browser): ${username}`);
    try {
      const res = await this._fetchUrlViaBrowser(url);
      if (res.status === 200 && res.data?.data) {
        const data = res.data;
        this.profile = this._parseProfile(data.data, username);
        this._updateMmr(data.data);
        this.logger.info(`[tracker] profile fetched (tracker.gg via browser): ${username}`);
        this.emit('update', this._buildUpdate());
        this._checkAndScheduleMemoryCleanup();
        return this.profile;
      } else {
        this.logger.error(`[tracker] fetchProfile (tracker.gg via browser) failed: status=${res.status} error=${res.error}`);
      }
    } catch (e) {
      this.logger.error(`[tracker] fetchProfile error: ${e.message}`);
    }
    this._checkAndScheduleMemoryCleanup();
    return this.profile;
  }

  _parseProfile(data, username) {
    return {
      platformUserHandle: username,
      platformSlug: 'epic',
      avatarUrl: data.platformInfo?.avatarUrl || '',
      playerId: data.platformInfo?.platformUserId || ''
    };
  }

  _updateMmr(data) {
    const segments = data.segments || [];
    if (!this.session.rankIcons) this.session.rankIcons = {};
    if (!this.session.rankNames) this.session.rankNames = {};
    if (!this.session.divisions) this.session.divisions = {};
    if (!this.session.matchesPlayed) this.session.matchesPlayed = {};
    if (!this.session.isUnranked) this.session.isUnranked = {};

    const skills = this._parseTrackerGgSegmentsToSkills(segments);

    for (const [key, skill] of Object.entries(skills)) {
      const mmr = skill.mmr;
      const matches = skill.matchesPlayed;
      const tierNum = skill.tier;
      const iconUrl = this.getRankIcon(tierNum);
      const isUnranked = (tierNum === 0 || skill.rankName.toLowerCase() === 'unranked');

      if (!this.session.startMmr[key]) this.session.startMmr[key] = mmr;
      if (!this.session.matchesPlayed[key]) this.session.matchesPlayed[key] = matches;
      
      if (this.session.currentMmr[key] !== undefined && this.session.currentMmr[key] !== mmr) {
        const diff = mmr - this.session.currentMmr[key];
        if (diff > 0) {
          this.session.wins = (this.session.wins || 0) + 1;
          this.session.streak = this.session.streak >= 0 ? this.session.streak + 1 : 1;
        } else if (diff < 0) {
          this.session.losses = (this.session.losses || 0) + 1;
          this.session.streak = this.session.streak <= 0 ? this.session.streak - 1 : -1;
        }
      }
      this.session.currentMmr[key] = mmr;
      this.session.matchesPlayed[key] = matches;
      this.session.rankIcons[key] = iconUrl;
      this.session.rankNames[key] = skill.rankName;
      this.session.divisions[key] = skill.divisionName;
      this.session.isUnranked[key] = isUnranked;
    }

    this._localPlayerSkills = skills;
    const activeUsername = this.usernames[this.activeAccountIndex];
    if (activeUsername) {
      this._addLocalPlayerToRoster(activeUsername, skills);
    }
  }

  _updateMmrFromBridge(skills) {
    if (!this.session.rankIcons) this.session.rankIcons = {};
    if (!this.session.rankNames) this.session.rankNames = {};
    if (!this.session.divisions) this.session.divisions = {};
    if (!this.session.matchesPlayed) this.session.matchesPlayed = {};
    if (!this.session.isUnranked) this.session.isUnranked = {};

    const modeMap = {
      '1v1': '1v1',
      '2v2': '2v2',
      '3v3': '3v3',
      'rumble': 'rumble',
      'hoops': 'hoops',
      'dropshot': 'dropshot',
      'snowday': 'snowday',
      'tournament': 'tournament',
      'un-ranked': 'casual',
      'unranked': 'casual',
      'casual': 'casual'
    };

    for (const [key, skill] of Object.entries(skills)) {
      const plKey = modeMap[key];
      if (plKey) {
        const mmr = skill.mmr;
        const matches = skill.matchesPlayed || 0;
        let calculatedRankName = skill.rankName || '';
        let calculatedDivisionName = skill.divisionName || '';
        let tierNum = skill.tier !== undefined ? skill.tier : 0;
        const isUnranked = (tierNum === 0 || calculatedRankName.toLowerCase() === 'unranked');
        if (isUnranked && mmr > 0) {
          const est = this._estimateUnrankedRank(mmr, plKey);
          tierNum = est.tier;
          calculatedRankName = est.rankName;
          calculatedDivisionName = est.divisionName;
        }
        const iconUrl = this.getRankIcon(tierNum);

        if (!this.session.startMmr[plKey]) this.session.startMmr[plKey] = mmr;
        if (!this.session.matchesPlayed[plKey]) this.session.matchesPlayed[plKey] = matches;

        if (this.session.currentMmr[plKey] !== undefined && this.session.currentMmr[plKey] !== mmr) {
          const diff = mmr - this.session.currentMmr[plKey];
          this.logger.info(`[tracker] MMR changed on ${plKey} (bridge): ${this.session.currentMmr[plKey]} -> ${mmr} (diff: ${diff >= 0 ? '+' : ''}${diff})`);
          if (diff > 0) {
            this.session.wins = (this.session.wins || 0) + 1;
            this.session.streak = this.session.streak >= 0 ? this.session.streak + 1 : 1;
          } else if (diff < 0) {
            this.session.losses = (this.session.losses || 0) + 1;
            this.session.streak = this.session.streak <= 0 ? this.session.streak - 1 : -1;
          }
        }
        this.session.currentMmr[plKey] = mmr;
        this.session.matchesPlayed[plKey] = matches;
        this.session.rankIcons[plKey] = iconUrl;
        this.session.rankNames[plKey] = calculatedRankName;
        this.session.divisions[plKey] = calculatedDivisionName;
        this.session.isUnranked[plKey] = isUnranked;
      }
    }
  }

  _normalizePlaylist(raw) {
    if (!raw) return null;
    const clean = raw.toLowerCase().trim();
    if (clean.includes('tournament')) return 'tournament';
    if (clean.includes('3v3') || clean.includes('standard')) return '3v3';
    if (clean.includes('2v2') || clean.includes('doubles')) return '2v2';
    if (clean.includes('1v1') || clean.includes('solo') || clean.includes('duel')) return '1v1';
    if (clean.includes('rumble')) return 'rumble';
    if (clean.includes('dropshot')) return 'dropshot';
    if (clean.includes('hoops')) return 'hoops';
    if (clean.includes('snowday') || clean.includes('snow') || clean.includes('hockey')) return 'snowday';
    if (clean.includes('casual') || clean.includes('unranked') || clean.includes('un-ranked')) return 'casual';
    return null;
  }

  _buildUpdate() {
    let pl = this.playlist;
    if (pl === 'current') {
      pl = this.detectedPlaylist || '2v2';
      if (pl === 'casual') {
        pl = 'best';
      }
    } else if (pl === 'best') {
      let maxMmr = -1;
      let bestPl = '2v2';
      const playlists = ['1v1', '2v2', '3v3', 'rumble', 'hoops', 'dropshot', 'snowday'];
      for (const plKey of playlists) {
        const mmr = this.session.currentMmr[plKey];
        if (mmr !== undefined && mmr > maxMmr) {
          maxMmr = mmr;
          bestPl = plKey;
        }
      }
      pl = bestPl;
    }
    const start = this.session.startMmr[pl] || 0;
    const current = this.session.currentMmr[pl] || 0;
    const rankIcon = this.session.rankIcons?.[pl] || '';
    const rankName = this.session.rankNames?.[pl] || '';
    const divisionName = this.session.divisions?.[pl] || '';
    const isUnranked = !!this.session.isUnranked?.[pl];
    const unrankedIcon = this.getRankIcon('unranked_overlay');
    return {
      profile: this.profile,
      session: { ...this.session },
      playlist: this.playlist,
      resolvedPlaylist: pl,
      detectedPlaylist: this.detectedPlaylist,
      mmr: current,
      mmrDelta: current - start,
      rankIcon,
      rankName,
      divisionName,
      isUnranked,
      unrankedIcon,
      inMatch: this.inMatch,
      usernames: this.usernames,
      activeAccountIndex: this.activeAccountIndex,
      // Legacy
      activeAccount: this.activeAccountIndex === 1 ? 2 : 1,
      username1: this.usernames[0] || '',
      username2: this.usernames[1] || '',
      isWsConnected: !!this.isWsConnected
    };
  }

  getSession() { return this._buildUpdate(); }

  setPlaylist(pl) {
    this.playlist = pl;
    this.settings.save({ tracker: { ...this.settings.load().tracker, selectedPlaylist: pl } });
    this.emit('update', this._buildUpdate());
  }

  setActiveAccount(index) {
    this.activeAccountIndex = index;
    if (this.activeAccountIndex < 0 || this.activeAccountIndex >= this.usernames.length) {
      this.activeAccountIndex = 0;
    }
    this.activeAccount = this.activeAccountIndex === 1 ? 2 : 1;

    const activeUsername = this.usernames[this.activeAccountIndex];
    this.profile = null;
    if (activeUsername) {
      this.fetchProfile(activeUsername).catch(() => {});
      this._spawnTempHiddenBrowser(activeUsername);
    } else {
      this.emit('update', this._buildUpdate());
    }

    this.settings.save({
      tracker: {
        ...this.settings.load().tracker,
        activeAccount: this.activeAccount,
        activeAccountIndex: this.activeAccountIndex
      }
    });
  }

  updateUsernames(user1, user2) {
    let list = [];
    if (Array.isArray(user1)) {
      list = user1;
    } else {
      list = [user1 || '', user2 || ''];
    }
    this.usernames = [...new Set(list.filter(Boolean))];
    if (this.usernames.length === 0) {
      this.usernames.push('');
    }

    if (this.activeAccountIndex >= this.usernames.length) {
      this.activeAccountIndex = 0;
    }
    this.username1 = this.usernames[0] || '';
    this.username2 = this.usernames[1] || '';
    this.activeAccount = this.activeAccountIndex === 1 ? 2 : 1;

    const activeUsername = this.usernames[this.activeAccountIndex];
    this.profile = null;
    if (activeUsername) {
      this.fetchProfile(activeUsername).catch(() => {});
      this._spawnTempHiddenBrowser(activeUsername);
    } else {
      this.emit('update', this._buildUpdate());
    }

    this.settings.save({
      tracker: {
        ...this.settings.load().tracker,
        username: this.username1,
        username2: this.username2,
        usernames: this.usernames,
        activeAccount: this.activeAccount,
        activeAccountIndex: this.activeAccountIndex
      }
    });
  }

  updateFromRocketStats(data) {
    const pl = data.playlist;
    const username = (this.usernames[this.activeAccountIndex] || 'default').trim().toLowerCase();
    
    let changed = false;
    let shouldTriggerFetch = false;
    
    if (pl && this.detectedPlaylist !== pl) {
      this.detectedPlaylist = pl;
      changed = true;
      this.logger.info(`[tracker] Detected playlist from RocketStats memory: ${pl}`);
    }
    
    if (!this.sessions[username]) {
      this.sessions[username] = {
        wins: 0, losses: 0, streak: 0,
        startMmr: {}, currentMmr: {},
        rankIcons: {}, rankNames: {},
        divisions: {}, matchesPlayed: {}
      };
      changed = true;
    }
    
    const session = this.sessions[username];
    if (pl && data.mmr != null && session.currentMmr[pl] !== data.mmr) {
      this.logger.info(`[tracker] MMR changed from ${session.currentMmr[pl]} to ${data.mmr} in memory — triggering immediate tracker.gg refresh`);
      session.currentMmr[pl] = data.mmr;
      changed = true;
      shouldTriggerFetch = true;
    }
    if (data.session) {
      const wins = data.session.wins ?? 0;
      const losses = data.session.losses ?? 0;
      const streak = data.session.streak ?? 0;
      if (session.wins !== wins || session.losses !== losses || session.streak !== streak) {
        session.wins = wins;
        session.losses = losses;
        session.streak = streak;
        changed = true;
        shouldTriggerFetch = true;
      }
    }

    if (changed) {
      this.emit('update', this._buildUpdate());
    }

    if (shouldTriggerFetch) {
      const activeUsername = this.usernames[this.activeAccountIndex];
      if (activeUsername) {
        this.triggerProfileRefresh(activeUsername).catch(() => {});
      }
    }
  }

  stop() {
    if (this._pollInterval) clearInterval(this._pollInterval);
    if (this._profileRefreshInterval) clearInterval(this._profileRefreshInterval);
    if (this._wsReconnectTimeout) clearTimeout(this._wsReconnectTimeout);
    if (this._ws) {
      try { this._ws.close(); } catch(e) {}
    }
    if (this._tcpReconnectTimeout) clearTimeout(this._tcpReconnectTimeout);
    if (this._tcpClient) {
      try { this._tcpClient.destroy(); } catch(e) {}
    }
    if (this.hiddenWindow) {
      try { this.hiddenWindow.destroy(); } catch(e) {}
      this.hiddenWindow = null;
    }
  }

  _connectWebSocket() {
    if (this._wsReconnectTimeout) clearTimeout(this._wsReconnectTimeout);
    if (this._ws) {
      try { this._ws.close(); } catch(e) {}
    }
    
    const ws = new WebSocket('ws://localhost:8085');
    this._ws = ws;
    
    ws.on('open', () => {
      this.logger.info('[tracker] Connected to RocketStats WebSocket server!');
      this.isWsConnected = true;
      this.emit('update', this._buildUpdate());
    });
    
    ws.on('message', (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());
        // RocketStats uses msg.name; some versions use msg.type — handle both
        const msgName = msg.name || msg.type || '';

        if ((msgName === 'State' || msgName === 'state') && (msg.data === 'Disconnected' || msg.data?.state === 'Disconnected')) {
          this.logger.info('[tracker] WebSocket received Disconnected state');
          return;
        }

        if (msgName === 'GameState' || msgName === 'gamestate') {
          // Handle both nested {Stats: {...}} and flat data structures
          const Stats = msg.data?.Stats || msg.data;
          if (!Stats) return;

          const detectedPl = this._normalizeGameMode(Stats.GameMode || Stats.gameMode || Stats.game_mode);
          if (!detectedPl) return;

          const mmr = parseFloat(Stats.MMR ?? Stats.mmr ?? Stats.CurrentMMR ?? 0);
          const wins    = parseInt(Stats.Win   ?? Stats.Wins   ?? Stats.wins   ?? 0, 10);
          const losses  = parseInt(Stats.Loss  ?? Stats.Losses ?? Stats.losses ?? 0, 10);
          const streak  = parseInt(Stats.Streak ?? Stats.streak ?? 0, 10);

          this.logger.info(`[tracker] RocketStats WS: pl=${detectedPl} mmr=${mmr} W=${wins} L=${losses} streak=${streak}`);

          this.updateFromRocketStats({
            playlist: detectedPl,
            mmr,
            session: { wins, losses, streak }
          });
        }
      } catch (e) {
        this.logger.error(`[tracker] WS message parse error: ${e.message}`);
      }
    });
    
    ws.on('close', () => {
      if (this.isWsConnected) {
        this.logger.info('[tracker] RocketStats WebSocket connection closed');
      }
      this.isWsConnected = false;
      this.emit('update', this._buildUpdate());
      this._wsReconnectTimeout = setTimeout(() => this._connectWebSocket(), 10000);
    });
    
    ws.on('error', (err) => {
      if (err.code !== 'ECONNREFUSED') {
        this.logger.warn(`[tracker] WebSocket error: ${err.message}`);
      }
      this.isWsConnected = false;
      this.emit('update', this._buildUpdate());
      ws.close();
    });
  }

  _normalizeGameMode(mode) {
    if (!mode) return null;
    const m = String(mode).toLowerCase();
    if (m.includes('1v1') || m.includes('1vs1') || m.includes('duel') || m.includes('solo')) return '1v1';
    if (m.includes('2v2') || m.includes('2vs2') || m.includes('double')) return '2v2';
    if (m.includes('3v3') || m.includes('3vs3') || m.includes('standard')) return '3v3';
    if (m.includes('hoops') || m.includes('canestro') || m.includes('canestri')) return 'hoops';
    if (m.includes('rumble') || m.includes('gloria')) return 'rumble';
    if (m.includes('dropshot') || m.includes('calamità')) return 'dropshot';
    if (m.includes('snow') || m.includes('giorno di neve') || m.includes('hockey')) return 'snowday';
    if (m.includes('tournament') || m.includes('torneo') || m.includes('tornei')) return 'tournament';
    return null;
  }

  _findStatsApiPort() {
    const os = require('os');
    const candidates = [
      path.join(os.homedir(), 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Config', 'TAStatsAPI.ini'),
      path.join(os.homedir(), 'OneDrive', 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Config', 'TAStatsAPI.ini'),
      path.join(os.homedir(), 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Config', 'DefaultStatsAPI.ini'),
      path.join(os.homedir(), 'OneDrive', 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Config', 'DefaultStatsAPI.ini')
    ];
    const iniPath = candidates.find(p => fs.existsSync(p));
    if (iniPath) {
      try {
        const content = fs.readFileSync(iniPath, 'utf8');
        const match = content.match(/Port=(\d+)/i);
        if (match) {
          const parsed = parseInt(match[1], 10);
          if (parsed > 0) return parsed;
        }
      } catch (err) {
        this.logger.error(`[tracker] Error reading Stats API port from ini: ${err.message}`);
      }
    }
    return 49123; // fallback default
  }

  _connectLocalStatsApi() {
    if (this._tcpReconnectTimeout) clearTimeout(this._tcpReconnectTimeout);
    if (this._tcpClient) {
      try { this._tcpClient.destroy(); } catch (e) {}
    }

    const port = this._findStatsApiPort();
    if (!this._hasLoggedTcpConnecting) {
      this.logger.info(`[tracker] Connecting to Rocket League Stats API on TCP port ${port}...`);
      this._hasLoggedTcpConnecting = true;
    }

    const client = new net.Socket();
    this._tcpClient = client;

    let buffer = '';
    let braceCount = 0;
    let inString = false;
    let escapeNext = false;
    let startIdx = -1;

    client.connect(port, '127.0.0.1', () => {
      this.logger.info(`[tracker] Connected to Rocket League Stats API on port ${port}!`);
      this.isTcpConnected = true;
      this._hasLoggedTcpConnecting = false;
    });

    client.on('data', async (data) => {
      buffer += data.toString('utf8');
      
      for (let i = 0; i < buffer.length; i++) {
        const char = buffer[i];
        
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        
        if (char === '\\') {
          escapeNext = true;
          continue;
        }
        
        if (char === '"') {
          inString = !inString;
          continue;
        }
        
        if (!inString) {
          if (char === '{') {
            if (braceCount === 0) {
              startIdx = i;
            }
            braceCount++;
          } else if (char === '}') {
            braceCount--;
            if (braceCount === 0 && startIdx !== -1) {
              const jsonStr = buffer.substring(startIdx, i + 1);
              try {
                const obj = JSON.parse(jsonStr);
                await this._handleStatsApiEvent(obj);
              } catch (err) {
                this.logger.error(`[tracker] Stats API JSON parse error: ${err.message}. Raw string: ${jsonStr}`);
              }
              buffer = buffer.substring(i + 1);
              i = -1;
              startIdx = -1;
            }
          }
        }
      }
    });

    client.on('close', () => {
      if (this.isTcpConnected) {
        this.logger.info('[tracker] Rocket League Stats API connection closed');
      }
      this.isTcpConnected = false;
      this._tcpReconnectTimeout = setTimeout(() => this._connectLocalStatsApi(), 2000);
    });

    client.on('error', (err) => {
      if (err.code !== 'ECONNREFUSED') {
        this.logger.warn(`[tracker] Rocket League Stats API connection error: ${err.message}`);
      }
      this.isTcpConnected = false;
      client.destroy();
    });
  }

  async _handleStatsApiEvent(obj) {
    if (!obj) return;
    const eventName = obj.event || obj.Event;
    const rawData = obj.data || obj.Data;
    if (!eventName) return;
    
    // Only log significant events to prevent log spamming (UpdateState, ClockUpdatedSeconds, BallHit happen constantly)
    if (eventName !== 'UpdateState' && eventName !== 'ClockUpdatedSeconds' && eventName !== 'BallHit') {
      this.logger.info(`[tracker] Stats API parsed event: ${eventName}`);
    }

    let data = rawData;
    if (typeof rawData === 'string') {
      try {
        data = JSON.parse(rawData);
      } catch (err) {
        this.logger.error(`[tracker] Failed to parse Stats API inner Data string: ${err.message}`);
      }
    }

    if (eventName === 'MatchCreated') {
      const guid = data?.MatchGuid || data?.MatchGUID || data?.guid;
      if (guid) {
        this.logger.info(`[tracker] MatchCreated event from Stats API, GUID: "${guid}"`);
        await this._onMatchStart(guid);
      }
    } else if (eventName === 'MatchEnded') {
      this.logger.info('[tracker] MatchEnded event from Stats API');
      await this._onMatchEnd();
    } else if (eventName === 'MatchDestroyed') {
      this.logger.info('[tracker] MatchDestroyed event from Stats API');
      this.inMatch = false;
      this.isReplaying = false;
      this.emit('roster-clear');
    } else if (eventName === 'GoalReplayStart') {
      this.logger.info('[tracker] GoalReplayStart event from Stats API');
      this.isReplaying = true;
      this.emit('roster-update', this._buildRoster());
    } else if (eventName === 'GoalReplayEnd') {
      this.logger.info(`[tracker] ${eventName} event from Stats API`);
      this.isReplaying = false;
      this.emit('roster-update', this._buildRoster());
    } else if (eventName === 'UpdateState') {
      await this._handleUpdateState(data);
    }
  }

  async _handleUpdateState(data) {
    if (!data) return;

    // Detect match GUID and trigger match start if needed
    const guid = data.MatchGuid || data.guid;
    if (guid && guid !== this.matchGuid) {
      this.matchGuid = guid;
      this.inMatch = true;
      this.logger.info(`[tracker] MatchGUID detected via UpdateState: "${guid}"`);
      await this._onMatchStart(guid);
    }

    // Detect playlist ID from Stats API
    const plId = data.PlaylistId ?? data.Playlist ?? data.playlistId ?? data.playlist;
    if (plId !== undefined && plId !== null) {
      const PLAYLIST_ID_MAP = {
        1: 'casual', 2: 'casual', 3: 'casual', 4: 'casual',
        10: '1v1', 11: '2v2', 13: '3v3',
        27: 'hoops', 28: 'rumble', 29: 'dropshot', 30: 'snowday',
        34: 'tournament', 38: 'tournament', 40: 'tournament'
      };
      const detected = PLAYLIST_ID_MAP[plId];
      if (detected && this.detectedPlaylist !== detected) {
        this.detectedPlaylist = detected;
        this.logger.info(`[tracker] Detected playlist from Stats API UpdateState: ${detected} (ID: ${plId})`);
        if (this.playlist === 'current') {
          this.emit('update', this._buildUpdate());
        }
      }
    }

    if (!data.Players || !Array.isArray(data.Players)) return;
    this._hasStatsApiData = true;

    const activeUsername = this.usernames[this.activeAccountIndex] || '';
    const lowerActiveUser = activeUsername.toLowerCase().trim();

    let rosterChanged = false;
    const currentPacketPlayerIds = new Set();

    for (let idx = 0; idx < data.Players.length; idx++) {
      const p = data.Players[idx];
      const playerName = p.Name;
      let playerId = p.PrimaryId;
      if (!playerId && playerName) {
        playerId = `bot|${playerName.toLowerCase().trim()}`;
      }
      const team = p.TeamNum;
      const score = p.Score ?? 0;
      const goals = p.Goals ?? 0;
      const assists = p.Assists ?? 0;
      const saves = p.Saves ?? 0;
      const shots = p.Shots ?? 0;

      if (!playerName || !playerId) continue;

      currentPacketPlayerIds.add(playerId);

      const isOurs = (this.detectedLocalPlayer && this.detectedLocalPlayer.fullId === playerId) ||
                     (this.detectedLocalPlayer && this.detectedLocalPlayer.name.toLowerCase().trim() === playerName.toLowerCase().trim()) ||
                     (lowerActiveUser && playerName.toLowerCase().trim() === lowerActiveUser) || 
                     (this.playerIds[lowerActiveUser] === playerId);

      let existing = this._rosterMap[playerId];
      if (!existing) {
        // If this is the local player, purge any stale isLocal entry with a different ID
        if (isOurs) {
          for (const [id, entry] of Object.entries(this._rosterMap)) {
            if (id !== playerId && entry.isLocal) {
              this.logger.info(`[roster] Removing stale local player entry: ${entry.name} (${id})`);
              delete this._rosterMap[id];
            }
          }
        }
        existing = {
          name: playerName,
          playerId,
          team,
          score,
          goals,
          assists,
          saves,
          shots,
          isLocal: isOurs,
          mmr: 0,
          tier: 0,
          division: 0,
          rankName: 'Unranked',
          divisionName: '',
          peak: 0,
          priNum: idx
        };
        this._rosterMap[playerId] = existing;
        rosterChanged = true;

        this.logger.info(`[roster] Added player from UpdateState: ${playerName} (${playerId}) team=${team} score=${score} isLocal=${isOurs} priNum=${idx}`);

        // Fetch their skills
        if (isOurs) {
          if (this._localPlayerSkills) {
            existing.allSkills = this._localPlayerSkills;
            this._updateRosterPlayerFromSkills(playerId);
          } else {
            this._fetchRosterPlayer(playerId, playerName);
          }
        } else {
          const isBot = playerId.startsWith('bot|');
          if (!isBot) {
            this._fetchRosterPlayer(playerId, playerName);
          }
        }
      } else {
        if (
          existing.score !== score ||
          existing.team !== team ||
          existing.name !== playerName ||
          existing.goals !== goals ||
          existing.assists !== assists ||
          existing.saves !== saves ||
          existing.shots !== shots ||
          existing.priNum !== idx
        ) {
          existing.score = score;
          existing.team = team;
          existing.name = playerName;
          existing.goals = goals;
          existing.assists = assists;
          existing.saves = saves;
          existing.shots = shots;
          existing.priNum = idx;
          rosterChanged = true;
        }

        // Stagger retry for players whose skills didn't load
        const isBot = playerId.startsWith('bot|');
        if (!isBot && !existing.allSkills && !this._rosterFetching.has(playerId)) {
          this._lastFetchAttempt = this._lastFetchAttempt || {};
          const lastAttempt = this._lastFetchAttempt[playerId] || 0;
          if (Date.now() - lastAttempt > 15000) {
            this._lastFetchAttempt[playerId] = Date.now();
            this.logger.info(`[roster] Retrying skill fetch for ${playerName} (${playerId})`);
            this._fetchRosterPlayer(playerId, playerName);
          }
        }
      }
    }

    // Clean up players who are no longer in the current game packet.
    for (const id of Object.keys(this._rosterMap)) {
      if (!currentPacketPlayerIds.has(id)) {
        const player = this._rosterMap[id];
        if (player) {
          this.logger.info(`[roster] Removing stale player: ${player.name} (${id}) isLocal=${!!player.isLocal}`);
          delete this._rosterMap[id];
          rosterChanged = true;
        }
      }
    }

    if (rosterChanged) {
      this.emit('roster-update', this._buildRoster());
    }
  }

  _updateRosterPlayerFromSkills(playerId) {
    const p = this._rosterMap[playerId];
    if (!p || !p.allSkills) return;

    const pl = this.detectedPlaylist || this.playlist || '2v2';
    const plKey = (pl === 'current' || pl === 'best') ? '2v2' : pl;
    let skill = p.allSkills[plKey] || p.allSkills['2v2'] || p.allSkills['1v1'] || Object.values(p.allSkills)[0];

    // Fallback: se il giocatore è Unranked nella modalità corrente, cerchiamo il suo rank competitivo migliore
    const isSkillUnrankedOrEmpty = !skill || skill.tier === 0 || (skill.rankName && skill.rankName.toLowerCase() === 'unranked') || (skill.mmr || 0) === 0;
    if (isSkillUnrankedOrEmpty && p.allSkills) {
      let maxMmrForFallback = -1;
      let fallbackSkill = null;
      const playlistsToCheck = ['2v2', '3v3', '1v1', 'tournament', 'rumble', 'hoops', 'dropshot', 'snowday'];
      for (const plCode of playlistsToCheck) {
        const s = p.allSkills[plCode];
        if (s && s.tier > 0 && s.mmr > maxMmrForFallback && s.rankName && s.rankName.toLowerCase() !== 'unranked') {
          maxMmrForFallback = s.mmr;
          fallbackSkill = s;
        }
      }
      if (fallbackSkill) {
        skill = fallbackSkill;
      }
    }

    p.mmr = skill?.mmr ?? 0;
    p.tier = skill?.tier ?? 0;
    p.division = skill?.division ?? 0;
    p.rankName = skill?.rankName ?? 'Unranked';
    p.divisionName = skill?.divisionName ?? '';
    p.peak = skill?.peak ?? skill?.mmr ?? 0;
  }
}

module.exports = TrackerModule;
