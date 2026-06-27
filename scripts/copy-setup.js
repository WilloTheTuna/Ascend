const fs   = require('fs');
const path = require('path');

const distDir  = path.join(__dirname, '..', 'dist');
const desktop  = 'C:/Users/Willo/Desktop';

// Find the installer .exe in dist/
const files = fs.readdirSync(distDir).filter(f => f.endsWith('.exe') && !f.endsWith('.blockmap'));

if (!files.length) {
  console.error('[copy-setup] No .exe found in dist/');
  process.exit(1);
}

const src  = path.join(distDir, files[0]);
const dest = path.join(desktop, files[0]);

fs.copyFileSync(src, dest);
console.log(`[copy-setup] ✓ Copied "${files[0]}" → Desktop`);
