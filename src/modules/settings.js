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
        // Migration: apply calibrated defaults for fields that are missing
        // or still at the old uncalibrated defaults
        if (saved.ingameRankOffsetX === undefined) saved.ingameRankOffsetX = DEFAULTS.ingameRankOffsetX;
        if (saved.ingameRankOffsetY === undefined) saved.ingameRankOffsetY = DEFAULTS.ingameRankOffsetY;
        if (saved.ingameRankOffsetYBlue === undefined || saved.ingameRankOffsetYBlue === 0) saved.ingameRankOffsetYBlue = DEFAULTS.ingameRankOffsetYBlue;
        if (saved.ingameRankOffsetYOrange === undefined || saved.ingameRankOffsetYOrange === 0) saved.ingameRankOffsetYOrange = DEFAULTS.ingameRankOffsetYOrange;
        if (saved.ingameRankOffsetXBlue === undefined) saved.ingameRankOffsetXBlue = DEFAULTS.ingameRankOffsetXBlue;
        if (saved.ingameRankOffsetXOrange === undefined) saved.ingameRankOffsetXOrange = DEFAULTS.ingameRankOffsetXOrange;
        if (saved.ingameRankScaleMultiplier === undefined || saved.ingameRankScaleMultiplier >= 1.0) {
          saved.ingameRankScaleMultiplier = DEFAULTS.ingameRankScaleMultiplier;
        }
        if (saved.ingameRankUiScalePercent === undefined || saved.ingameRankUiScalePercent >= 100) {
          saved.ingameRankUiScalePercent = DEFAULTS.ingameRankUiScalePercent;
        }
        if (saved.rocketStatsScaleMultiplier === undefined || saved.rocketStatsScaleMultiplier >= 0.75) {
          saved.rocketStatsScaleMultiplier = DEFAULTS.rocketStatsScaleMultiplier;
        }
        if (saved.rocketStatsUiScalePercent === undefined || saved.rocketStatsUiScalePercent >= 100) {
          saved.rocketStatsUiScalePercent = DEFAULTS.rocketStatsUiScalePercent;
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
