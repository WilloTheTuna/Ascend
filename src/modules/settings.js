const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  firstRunComplete: false,
  language: 'en',
  theme: 'dark',
  bringToFrontHotkey: 'F2',
  overlayEnabled: true,
  overlayStyle: 'glassmorphism',
  target: {
    source: 'Epic',
    cookedDir: 'C:/Program Files/Epic Games/rocketleague/TAGame/CookedPCConsole'
  },
  tracker: {
    username: '',
    username2: '',
    activeAccount: 1,
    playerId: '',
    playerId2: '',
    selectedPlaylist: '2v2',
    overlayPos: { x: 1650, y: 39 }
  },
  configVersion: 4,
  rocketStatsTheme: 'Circle',
  rocketStatsScaleMultiplier: 0.7,
  rocketStatsOffsetX: 29,
  rocketStatsOffsetY: 78,
  rocketStatsPlaylist: 'current',
  rocketStatsShowMmrDelta: true,
  rocketStatsUiScalePercent: 100,
  
  // IngameRank configuration defaults (calibrated)
  ingameRankEnabled: true,
  ingameRankPlaylist: 'best',
  ingameRankShowDivision: true,
  ingameRankShowPlaylist: true,
  ingameRankCalculateUnranked: true,
  ingameRankIncludeExtramodes: true,
  ingameRankIncludeTournaments: false,
  ingameRankHoldToShow: true,
  ingameRankHotkey: 'Tab',
  ingameRankControllerButton: 32, // Back button (Scoreboard default on controller)
  ingameRankScaleMultiplier: 1.00,
  ingameRankOffsetX: -80,
  ingameRankOffsetY: 0,
  ingameRankOffsetXBlue: 0,
  ingameRankOffsetYBlue: 8,
  ingameRankOffsetXOrange: 0,
  ingameRankOffsetYOrange: 3,
  ingameRankUiScalePercent: 100
};

class SettingsManager {
  constructor(appData) {
    this.file = path.join(appData, 'settings.json');
    this._data = null;
  }

  load() {
    if (!this._data) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        // Migration v10: Recalibrate IngameRank offsets using correct baselines from user screenshots
        // 90%: X=-80, YBlue=3, YOrange=3 | 100%: X=-80, YBlue=8, YOrange=3
        if (!saved.configVersion || saved.configVersion < 10) {
          saved.configVersion = 10;
          const s = saved.ingameRankUiScalePercent !== undefined ? saved.ingameRankUiScalePercent : 100;
          saved.ingameRankOffsetX = -80;
          saved.ingameRankOffsetYBlue = Math.round(3 + ((s - 90) / 10) * (8 - 3));
          saved.ingameRankOffsetYOrange = 3;
          saved.ingameRankScaleMultiplier = parseFloat((1.00 * (s / 100)).toFixed(2));
          try {
            fs.writeFileSync(this.file, JSON.stringify({ ...DEFAULTS, ...saved }, null, 2));
          } catch (_) {}
        }
        if (saved.ingameRankTriggerType === undefined) saved.ingameRankTriggerType = '';
        if (saved.ingameRankTriggerIndex === undefined) saved.ingameRankTriggerIndex = '';
        this._data = { ...DEFAULTS, ...saved };
      } catch (_) {
        this._data = { ...DEFAULTS };
      }
    }
    return this._data;
  }

  save(partial) {
    this._data = { ...this.load(), ...partial };
    fs.writeFileSync(this.file, JSON.stringify(this._data, null, 2));
    return this._data;
  }

  get(key) {
    return this.load()[key];
  }
}

module.exports = SettingsManager;
