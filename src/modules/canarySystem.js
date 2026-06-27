const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const chokidar = require('chokidar');

/**
 * CanarySystem — watches for game updates and detects if RL overwrote our swapped files.
 * Same logic as Shift's canary. Stores hash baselines in game_sig.json.
 */
class CanarySystem extends EventEmitter {
  constructor(appData, settings, swapEngine, logger) {
    super();
    this.appData = appData;
    this.settings = settings;
    this.swapEngine = swapEngine;
    this.logger = logger;
    this.sigFile = path.join(appData, 'game_sig.json');
    this.sigs = {};
    this.watcher = null;
  }

  async init() {
    try { this.sigs = JSON.parse(fs.readFileSync(this.sigFile, 'utf8')); } catch (_) { this.sigs = {}; }
    await this._checkDrift();
    this.logger.info('CanarySystem init complete');
  }

  async _checkDrift() {
    const swaps = this.swapEngine.getSwaps();
    if (swaps.length === 0) {
      this.logger.info('canary: no mods active, skipping detection');
      return;
    }

    this.logger.info(`canary: checking ${swaps.length} active swaps`);
    const cfg = this.settings.load();
    const key = cfg.target.cookedDir;

    for (const swap of swaps) {
      const currentHash = await this.swapEngine.hashFile(swap.targetFile);
      const storedHash = this.sigs[key]?.[swap.targetFile];

      if (storedHash && currentHash !== storedHash) {
        this.logger.warn(`canary: DRIFT on ${swap.targetFile} stored=${storedHash} current=${currentHash}`);
        this.emit('drift-detected', { filename: swap.targetFile, swap });
      } else {
        this.logger.info(`canary: ${swap.targetFile} matches baseline`);
      }
    }
  }

  async recordBaseline(filename) {
    const cfg = this.settings.load();
    const key = cfg.target.cookedDir;
    if (!this.sigs[key]) this.sigs[key] = {};
    const hash = await this.swapEngine.hashFile(filename);
    if (hash) {
      this.sigs[key][filename] = hash;
      fs.writeFileSync(this.sigFile, JSON.stringify(this.sigs, null, 2));
      this.logger.info(`canary: recorded baseline for ${filename} = ${hash}`);
    }
  }

  async forceReapply() {
    const swaps = this.swapEngine.getSwaps();
    for (const swap of swaps) {
      await this.swapEngine.applySwap(swap);
      await this.recordBaseline(swap.targetFile);
    }
    return { ok: true, reapplied: swaps.length };
  }

  getStatus() {
    return { sigs: this.sigs, watching: false };
  }

  stop() {
    // Watcher removed
  }
}

module.exports = CanarySystem;
