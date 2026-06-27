const fs   = require('fs');
const path = require('path');

const distDir   = path.join(__dirname, '..', 'dist');
const desktop   = 'C:/Users/Willo/Desktop';
const backupDir = path.join(desktop, 'Ascend_Backups');

if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

// 1. Find the new installer .exe in dist/
const files = fs.readdirSync(distDir).filter(f => f.endsWith('.exe') && !f.endsWith('.blockmap'));
if (!files.length) {
  console.error('[copy-setup] No .exe found in dist/');
  process.exit(1);
}

const newSetupName = files[0];
const src = path.join(distDir, newSetupName);
const dest = path.join(desktop, newSetupName);

// 2. Find existing Ascend setups on Desktop
const desktopFiles = fs.readdirSync(desktop).filter(f => f.startsWith('Ascend Setup') && f.endsWith('.exe') && f !== newSetupName);

if (desktopFiles.length > 0) {
  // Clear out old backups in Ascend_Backups
  const oldBackups = fs.readdirSync(backupDir).filter(f => f.startsWith('Ascend Setup') && f.endsWith('.exe'));
  for (const old of oldBackups) {
    try {
      fs.unlinkSync(path.join(backupDir, old));
      console.log(`[copy-setup] 🗑️ Removed older backup: ${old}`);
    } catch (_) {}
  }

  // Move the latest previous setup to backupDir
  const prevSetup = desktopFiles[0];
  const prevSrc = path.join(desktop, prevSetup);
  const prevDest = path.join(backupDir, prevSetup);
  try {
    fs.renameSync(prevSrc, prevDest);
    console.log(`[copy-setup] 📦 Backed up previous version "${prevSetup}" → Ascend_Backups/`);
  } catch (e) {
    console.error(`[copy-setup] Failed to backup ${prevSetup}:`, e.message);
  }

  // Remove any remaining old setups on Desktop
  for (let i = 1; i < desktopFiles.length; i++) {
    try {
      fs.unlinkSync(path.join(desktop, desktopFiles[i]));
      console.log(`[copy-setup] 🗑️ Cleaned up old setup from Desktop: ${desktopFiles[i]}`);
    } catch (_) {}
  }
}

// 3. Copy new setup to Desktop
fs.copyFileSync(src, dest);
console.log(`[copy-setup] ✓ Copied "${newSetupName}" → Desktop`);
