const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

/**
 * BakkesPluginsModule — manages installed BakkesMod C++ plugins (.dll).
 * Integrates directly with %APPDATA%/bakkesmod/bakkesmod/cfg/plugins.cfg
 * and the /plugins/ folder.
 */
class BakkesPluginsModule {
  constructor(appData, settings, logger) {
    this.appData = appData;
    this.settings = settings;
    this.logger = logger;
    
    // Resolve standard BakkesMod AppData directory
    this.bakkesDir = path.join(os.homedir(), 'AppData', 'Roaming', 'bakkesmod', 'bakkesmod');
    this.pluginsDir = path.join(this.bakkesDir, 'plugins');
    this.cfgFile = path.join(this.bakkesDir, 'cfg', 'plugins.cfg');
  }

  async init() {
    this.logger.info(`BakkesPluginsModule init: directory=${this.bakkesDir}`);
    
    // Auto-install default plugins if missing
    try {
      const defaultPlugins = [
        {
          id: 'RocketStats',
          zipName: 'RocketStats.zip'
        },
        {
          id: 'IngameRank',
          zipName: 'Bakkesplugin_282-public-20260115-200025.zip'
        }
      ];

      for (const p of defaultPlugins) {
        const dllPath = path.join(this.pluginsDir, `${p.id}.dll`);
        if (!fs.existsSync(dllPath)) {
          this.logger.info(`[auto-install] Plugin ${p.id} is missing. Installing...`);
          const zipPath = path.join(__dirname, '..', '..', 'Mod', p.zipName);
          if (fs.existsSync(zipPath)) {
            const res = await this.installPlugin(zipPath);
            if (res.ok) {
              this.logger.info(`[auto-install] Plugin ${p.id} successfully auto-installed.`);
            } else {
              this.logger.error(`[auto-install] Failed to install ${p.id}: ${res.error}`);
            }
          } else {
            this.logger.warn(`[auto-install] Zip source not found at ${zipPath}`);
          }
        }
      }
    } catch (err) {
      this.logger.error(`[auto-install] Error checking/installing default plugins: ${err.message}`);
    }
  }

  /**
   * List all installed BakkesMod plugins
   */
  listPlugins() {
    try {
      if (!fs.existsSync(this.pluginsDir)) {
        return [];
      }

      // Read all DLL files in plugins folder
      const files = fs.readdirSync(this.pluginsDir).filter(f => f.toLowerCase().endsWith('.dll'));
      
      // Read plugins.cfg to parse load lines
      let loadedPlugins = [];
      if (fs.existsSync(this.cfgFile)) {
        const content = fs.readFileSync(this.cfgFile, 'utf8');
        loadedPlugins = content.split('\n')
          .map(line => line.trim())
          .filter(line => line.toLowerCase().startsWith('plugin load '))
          .map(line => line.substring(12).trim().toLowerCase());
      }

      return files.map(file => {
        const id = path.basename(file, '.dll');
        const idLower = id.toLowerCase();
        const enabled = loadedPlugins.includes(idLower);
        const stats = fs.statSync(path.join(this.pluginsDir, file));

        return {
          id,
          name: id,
          filename: file,
          enabled,
          sizeBytes: stats.size,
          createdAt: stats.birthtime.toISOString()
        };
      });
    } catch (err) {
      this.logger.error(`BakkesMod listPlugins error: ${err.message}`);
      return [];
    }
  }

  /**
   * Toggle plugin enable/disable inside plugins.cfg
   */
  togglePlugin(id) {
    try {
      if (!fs.existsSync(this.cfgFile)) {
        fs.mkdirSync(path.dirname(this.cfgFile), { recursive: true });
        fs.writeFileSync(this.cfgFile, 'writeplugins\n');
      }

      const idLower = id.toLowerCase();
      let lines = fs.readFileSync(this.cfgFile, 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

      // Find load instruction
      const loadIndex = lines.findIndex(line => 
        line.toLowerCase().startsWith('plugin load ') && 
        line.substring(12).trim().toLowerCase() === idLower
      );

      let enabled = false;
      if (loadIndex >= 0) {
        // Disable: remove line
        lines.splice(loadIndex, 1);
        enabled = false;
      } else {
        // Enable: append plugin load statement
        // Put it before writeplugins if writeplugins is at the end
        const writeIndex = lines.findIndex(line => line.toLowerCase() === 'writeplugins');
        if (writeIndex >= 0) {
          lines.splice(writeIndex, 0, `plugin load ${idLower}`);
        } else {
          lines.push(`plugin load ${idLower}`);
          lines.push('writeplugins');
        }
        enabled = true;
      }

      fs.writeFileSync(this.cfgFile, lines.join('\n') + '\n');
      this.logger.info(`BakkesMod plugin toggled: ${id} enabled=${enabled}`);
      return { ok: true, enabled };
    } catch (err) {
      this.logger.error(`BakkesMod togglePlugin error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Install BakkesMod plugin from a zip file
   */
  async installPlugin(src) {
    this.logger.info(`BakkesMod: installing plugin ${src}`);
    try {
      if (!fs.existsSync(src)) {
        throw new Error('File o cartella plugin non trovato.');
      }

      // Ensure directory exists
      fs.mkdirSync(this.pluginsDir, { recursive: true });

      let dllName = '';
      const isDir = fs.statSync(src).isDirectory();

      if (isDir) {
        // Source is a folder (unzipped)
        const pluginsSubDir = path.join(src, 'plugins');
        if (!fs.existsSync(pluginsSubDir)) {
          throw new Error('Nessuna cartella "plugins" trovata all\'interno della cartella specificata.');
        }
        const files = fs.readdirSync(pluginsSubDir).filter(f => f.toLowerCase().endsWith('.dll'));
        if (!files.length) {
          throw new Error('Nessun file DLL per BakkesMod trovato all\'interno della cartella plugins.');
        }
        dllName = path.basename(files[0], '.dll');

        // Function to copy directory recursively
        const copyDirRecursive = (from, to) => {
          fs.mkdirSync(to, { recursive: true });
          fs.readdirSync(from).forEach(element => {
            const f = path.join(from, element);
            const t = path.join(to, element);
            // Skip FIRST_LAUNCH.file
            if (element.toLowerCase() === 'first_launch.file') {
              this.logger.info(`Skipping copy of ${f} to prevent F8 autobind.`);
              return;
            }
            if (fs.lstatSync(f).isDirectory()) {
              copyDirRecursive(f, t);
            } else {
              fs.copyFileSync(f, t);
            }
          });
        };

        // Copy plugins and data folders
        if (fs.existsSync(path.join(src, 'plugins'))) {
          copyDirRecursive(path.join(src, 'plugins'), this.pluginsDir);
        }
        if (fs.existsSync(path.join(src, 'data'))) {
          copyDirRecursive(path.join(src, 'data'), path.join(this.bakkesDir, 'data'));
        }
      } else {
        // Source is a zip file
        let zip;
        if (src.includes('app.asar')) {
          const buffer = fs.readFileSync(src);
          zip = new AdmZip(buffer);
        } else {
          zip = new AdmZip(src);
        }
        const entries = zip.getEntries();
        
        const dllEntry = entries.find(e => e.entryName.toLowerCase().startsWith('plugins/') && e.entryName.toLowerCase().endsWith('.dll'));
        if (!dllEntry) {
          throw new Error('Nessun file DLL per BakkesMod trovato all\'interno della cartella plugins del file ZIP.');
        }

        zip.extractAllTo(this.bakkesDir, true);
        dllName = path.basename(dllEntry.name, '.dll');
      }

      // Delete FIRST_LAUNCH.file from target to be absolutely sure
      const firstLaunchPath = path.join(this.bakkesDir, 'data', 'assets', 'IngameRank', 'FIRST_LAUNCH.file');
      if (fs.existsSync(firstLaunchPath)) {
        try {
          fs.unlinkSync(firstLaunchPath);
          this.logger.info(`Deleted ${firstLaunchPath} to prevent F8 autobind.`);
        } catch (e) {
          this.logger.error(`Failed to delete FIRST_LAUNCH.file: ${e.message}`);
        }
      }

      // Automatically add it to plugins.cfg
      if (fs.existsSync(this.cfgFile)) {
        let content = fs.readFileSync(this.cfgFile, 'utf8');
        const idLower = dllName.toLowerCase();
        
        const isAlreadyAdded = content.split('\n')
          .some(line => line.trim().toLowerCase() === `plugin load ${idLower}`);

        if (!isAlreadyAdded) {
          let lines = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
          const writeIndex = lines.findIndex(line => line.toLowerCase() === 'writeplugins');
          if (writeIndex >= 0) {
            lines.splice(writeIndex, 0, `plugin load ${idLower}`);
          } else {
            lines.push(`plugin load ${idLower}`);
            lines.push('writeplugins');
          }
          fs.writeFileSync(this.cfgFile, lines.join('\n') + '\n');
        }
      } else {
        fs.mkdirSync(path.dirname(this.cfgFile), { recursive: true });
        fs.writeFileSync(this.cfgFile, `plugin load ${dllName.toLowerCase()}\nwriteplugins\n`);
      }

      this.logger.info(`BakkesMod plugin installed: ${dllName}`);
      return { ok: true, id: dllName };
    } catch (err) {
      this.logger.error(`BakkesMod installPlugin error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Uninstall plugin from plugins/ and remove it from plugins.cfg
   */
  uninstallPlugin(id) {
    this.logger.info(`BakkesMod: uninstalling plugin ${id}`);
    try {
      const dllFile = path.join(this.pluginsDir, `${id}.dll`);
      
      // Delete DLL file
      if (fs.existsSync(dllFile)) {
        fs.unlinkSync(dllFile);
      }

      // Remove from plugins.cfg
      if (fs.existsSync(this.cfgFile)) {
        const idLower = id.toLowerCase();
        let lines = fs.readFileSync(this.cfgFile, 'utf8')
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0);

        lines = lines.filter(line => 
          !(line.toLowerCase().startsWith('plugin load ') && 
            line.substring(12).trim().toLowerCase() === idLower)
        );

        fs.writeFileSync(this.cfgFile, lines.join('\n') + '\n');
      }

      this.logger.info(`BakkesMod plugin uninstalled: ${id}`);
      return { ok: true };
    } catch (err) {
      this.logger.error(`BakkesMod uninstallPlugin error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  launchInjector() {
    const { exec } = require('child_process');
    const injectorPath = path.join(this.bakkesDir, '64bitbminjector.exe');
    if (fs.existsSync(injectorPath)) {
      this.logger.info(`Launching BakkesMod Injector: ${injectorPath}`);
      exec(`"${injectorPath}"`, { cwd: this.bakkesDir }, (err) => {
        if (err) {
          this.logger.error(`Failed to launch BakkesMod Injector: ${err.message}`);
        }
      });
      return { ok: true };
    }
    return { ok: false, error: 'BakkesMod Injector non trovato. Assicurati che BakkesMod sia installato.' };
  }
}

module.exports = BakkesPluginsModule;
