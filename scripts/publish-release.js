const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const fetch = require('node-fetch');

async function main() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    const version = pkg.version;
    const tagName = `v${version}`;
    
    // 1. Get token from git credential fill
    let token = '';
    try {
      const credOutput = execSync('echo url=https://github.com/WilloTheTuna/Ascend.git | git credential fill', { encoding: 'utf8' });
      const match = credOutput.match(/password=(.*)/);
      if (match) token = match[1].trim();
    } catch (e) {
      console.error('[auto-release] Could not fetch git credentials:', e.message);
    }

    if (!token) {
      console.log('[auto-release] No token found, skipping GitHub Release upload.');
      return;
    }

    const headers = {
      'Authorization': `token ${token}`,
      'User-Agent': 'Ascend-Release-Bot',
      'Accept': 'application/vnd.github.v3+json'
    };

    // 2. Check if release already exists
    let release = null;
    const getRelRes = await fetch(`https://api.github.com/repos/WilloTheTuna/Ascend/releases/tags/${tagName}`, { headers });
    const releasePayload = {
      tag_name: tagName,
      name: `${tagName} - Early Demo`,
      body: `Automated pre-release build for Ascend v${version}. Includes performance optimizations and latest feature updates.`,
      draft: false,
      prerelease: true
    };

    if (getRelRes.ok) {
      release = await getRelRes.json();
      console.log(`[auto-release] Updating existing release for ${tagName} to English pre-release...`);
      const patchRes = await fetch(release.url, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(releasePayload)
      });
      if (patchRes.ok) {
        release = await patchRes.json();
      }
    } else {
      console.log(`[auto-release] Creating new English pre-release for ${tagName}...`);
      const createRes = await fetch('https://api.github.com/repos/WilloTheTuna/Ascend/releases', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(releasePayload)
      });
      if (!createRes.ok) {
        const errText = await createRes.text();
        console.error(`[auto-release] Failed to create release: ${createRes.status} ${errText}`);
        return;
      }
      release = await createRes.json();
      console.log(`[auto-release] ✓ Created release ${release.html_url}`);
    }

    // 3. Find setup file in dist/
    const distDir = path.join(__dirname, '..', 'dist');
    const files = fs.readdirSync(distDir).filter(f => f.endsWith('.exe') && !f.endsWith('.blockmap'));
    if (!files.length) {
      console.error('[auto-release] No .exe setup file found in dist/');
      return;
    }

    const setupFile = files[0];
    const filePath = path.join(distDir, setupFile);
    const fileStats = fs.statSync(filePath);
    const assetName = setupFile.replace(/\s+/g, '.'); // Ascend.Setup.1.0.1.exe

    // 4. Delete existing asset if it has the same name
    if (release.assets && release.assets.length) {
      for (const asset of release.assets) {
        if (asset.name === assetName || asset.name === setupFile) {
          console.log(`[auto-release] Deleting existing asset ${asset.name}...`);
          await fetch(asset.url, { method: 'DELETE', headers });
        }
      }
    }

    // 5. Upload asset
    const uploadUrlRaw = release.upload_url.split('{')[0];
    const uploadUrl = `${uploadUrlRaw}?name=${encodeURIComponent(assetName)}`;
    console.log(`[auto-release] Uploading ${assetName} (${Math.round(fileStats.size / 1024 / 1024)}MB)...`);

    const fileBuffer = fs.readFileSync(filePath);
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileStats.size
      },
      body: fileBuffer
    });

    if (uploadRes.ok) {
      console.log(`[auto-release] 🎉 Successfully published asset ${assetName} to GitHub Releases!`);
    } else {
      const errText = await uploadRes.text();
      console.error(`[auto-release] Upload failed: ${uploadRes.status} ${errText}`);
    }

  } catch (err) {
    console.error('[auto-release] Unexpected error:', err.message);
  }
}

main();
