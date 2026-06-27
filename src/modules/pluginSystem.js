const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * PluginSystem — JS-based plugin framework.
 * Plugins are folders in /plugins/ with an index.js and plugin.json manifest.
 * 
 * Plugin API (exposed to plugins):
 *   - rc.onMatchStart(cb)
 *   - rc.onMatchEnd(cb)
 *   - rc.onSwapApplied(cb)
 *   - rc.log(msg)
 *   - rc.readSetting(key)
 *   - rc.writeSetting(key, value)
 */
class PluginSystem extends EventEmitter {
  constructor(appData, logger) {
    super();
    this.appData = appData;
    this.logger = logger;
    this.pluginsDir = path.join(appData, 'plugins');
    this.plugins = new Map(); // id -> { manifest, instance, logs, enabled }
  }

  async init() {
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    const dirs = fs.readdirSync(this.pluginsDir).filter(d =>
      fs.statSync(path.join(this.pluginsDir, d)).isDirectory()
    );
    for (const dir of dirs) {
      await this._loadPlugin(dir).catch(e =>
        this.logger.error(`plugin load error [${dir}]: ${e.message}`)
      );
    }
    this.logger.info(`PluginSystem init: ${this.plugins.size} plugins`);
  }

  async _loadPlugin(id) {
    const pluginDir = path.join(this.pluginsDir, id);
    const manifestPath = path.join(pluginDir, 'plugin.json');
    const indexPath = path.join(pluginDir, 'index.js');

    if (!fs.existsSync(manifestPath) || !fs.existsSync(indexPath)) return;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const logs = [];

    const api = {
      onMatchStart: (cb) => this.on('onMatchStart', cb),
      onMatchEnd: (cb) => this.on('onMatchEnd', cb),
      onSwapApplied: (cb) => this.on('onSwapApplied', cb),
      log: (msg) => {
        const entry = `[${new Date().toISOString()}] ${msg}`;
        logs.push(entry);
        this.logger.info(`[plugin:${id}] ${msg}`);
      },
      readSetting: (key) => {
        try {
          const f = path.join(pluginDir, 'settings.json');
          return JSON.parse(fs.readFileSync(f, 'utf8'))[key];
        } catch (_) { return null; }
      },
      writeSetting: (key, value) => {
        const f = path.join(pluginDir, 'settings.json');
        let s = {};
        try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
        s[key] = value;
        fs.writeFileSync(f, JSON.stringify(s, null, 2));
      }
    };

    // Sandbox: clear require cache for hot-reload
    delete require.cache[require.resolve(indexPath)];
    const mod = require(indexPath);
    const instance = typeof mod === 'function' ? new mod(api) : mod(api);

    this.plugins.set(id, {
      manifest: { id, ...manifest },
      instance,
      logs,
      enabled: manifest.enabledByDefault !== false
    });

    this.logger.info(`plugin loaded: ${manifest.name || id} v${manifest.version || '?'}`);
  }

  emit(event, data) {
    // Forward to all enabled plugins
    for (const [id, plugin] of this.plugins) {
      if (!plugin.enabled) continue;
      try {
        super.emit(event, data);
      } catch (e) {
        this.logger.error(`plugin [${id}] error on ${event}: ${e.message}`);
      }
    }
    super.emit(event, data);
  }

  listPlugins() {
    return Array.from(this.plugins.values()).map(p => ({
      ...p.manifest,
      enabled: p.enabled,
      logCount: p.logs.length
    }));
  }

  togglePlugin(id) {
    const plugin = this.plugins.get(id);
    if (!plugin) return { ok: false };
    plugin.enabled = !plugin.enabled;
    return { ok: true, enabled: plugin.enabled };
  }

  async installPlugin(src) {
    // src can be a path to a plugin folder or a zip
    try {
      const id = path.basename(src).replace(/\.zip$/, '');
      const dst = path.join(this.pluginsDir, id);
      if (src.endsWith('.zip')) {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(src);
        zip.extractAllTo(dst, true);
      } else {
        fs.cpSync(src, dst, { recursive: true });
      }
      await this._loadPlugin(id);
      return { ok: true, id };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  uninstallPlugin(id) {
    const plugin = this.plugins.get(id);
    if (!plugin) return { ok: false };
    const pluginDir = path.join(this.pluginsDir, id);
    fs.rmSync(pluginDir, { recursive: true, force: true });
    this.plugins.delete(id);
    return { ok: true };
  }

  getPluginLog(id) {
    return this.plugins.get(id)?.logs || [];
  }
}

module.exports = PluginSystem;
