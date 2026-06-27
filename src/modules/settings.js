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
  configVersion: 3,
  rocketStatsTheme: 'Circle',
  rocketStatsScaleMultiplier: 0.7,
  rocketStatsOffsetX: 29,
  rocketStatsOffsetY: 78,
  rocketStatsPlaylist: 'current',
  rocketStatsShowMmrDelta: true,
  rocketStatsUiScalePercent: 90,
  
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
  ingameRankScaleMultiplier: 0.93,
  ingameRankOffsetX: -60,
  ingameRankOffsetY: 0,
  ingameRankOffsetXBlue: 0,
  ingameRankOffsetYBlue: 3,
  ingameRankOffsetXOrange: 0,
  ingameRankOffsetYOrange: -2,
  ingameRankUiScalePercent: 90
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
        // Migration v3: Force-recalibrate all positions and scales to exact values
        if (!saved.configVersion || saved.configVersion < 3) {
          saved.configVersion = 3;
          saved.ingameRankOffsetX = DEFAULTS.ingameRankOffsetX;
          saved.ingameRankOffsetY = DEFAULTS.ingameRankOffsetY;
          saved.ingameRankOffsetXBlue = DEFAULTS.ingameRankOffsetXBlue;
          saved.ingameRankOffsetYBlue = DEFAULTS.ingameRankOffsetYBlue;
          saved.ingameRankOffsetXOrange = DEFAULTS.ingameRankOffsetXOrange;
          saved.ingameRankOffsetYOrange = DEFAULTS.ingameRankOffsetYOrange;
          saved.ingameRankScaleMultiplier = DEFAULTS.ingameRankScaleMultiplier;
          saved.ingameRankUiScalePercent = DEFAULTS.ingameRankUiScalePercent;
          saved.rocketStatsScaleMultiplier = DEFAULTS.rocketStatsScaleMultiplier;
          saved.rocketStatsOffsetX = DEFAULTS.rocketStatsOffsetX;
          saved.rocketStatsOffsetY = DEFAULTS.rocketStatsOffsetY;
          saved.rocketStatsUiScalePercent = DEFAULTS.rocketStatsUiScalePercent;
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
