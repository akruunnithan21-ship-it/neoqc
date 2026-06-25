---
name: push-ota-updates
description: Compiles, builds, and publishes OTA auto-updates for the NeoQC Admin and Client applications on GitHub.
---

# Pushing OTA Updates for NeoQC

Use this skill whenever the user requests to push or publish an update, release, or OTA update for the NeoQC project.

## Workflow Steps

### 1. Ensure `allowPrerelease = false` in `main.js`
- Verify that `autoUpdater.allowPrerelease = false` in [main.js](file:///c:/Users/Aladeen/Desktop/Aladeen/neoqc-main/main.js) so that the updater searches for the latest stable release.

### 2. Update Version in `package.json`
- Determine the new stable version number (e.g. `1.0.8`).
- Update the `"version"` field in [package.json](file:///c:/Users/Aladeen/Desktop/Aladeen/neoqc-main/package.json) to this version.

### 3. Run the Builds and Publish to GitHub (as Drafts)
- Use `cmd.exe` to bypass PowerShell script execution policy locks on Windows.
- Define `GH_TOKEN` with the repository token (retrieved from the current environment/credentials).
- Run the build scripts:
  - **Admin App**:
    ```cmd
    cmd.exe /c "set GH_TOKEN=%GH_TOKEN% && npm run build:admin -- --publish always"
    ```
  - **Client App**:
    ```cmd
    cmd.exe /c "set GH_TOKEN=%GH_TOKEN% && npm run build:client -- --publish always"
    ```

### 4. Transition Drafts to Published Releases
- Write and run a script to fetch the draft releases from GitHub and patch them to `draft: false` and `prerelease: false` using the GitHub API.
- Node script format:
  ```javascript
  const https = require('https');
  const token = process.env.GH_TOKEN; // Read token from environment
  const owner = 'akruunnithan21-ship-it';
  const repo = 'neoqc';

  function request(path, method = 'GET', data = null) {
    return new Promise((resolve) => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${owner}/${repo}${path}`,
        method,
        headers: {
          'User-Agent': 'NodeJS',
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      };
      const req = https.request(options, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body || '{}') }));
      });
      if (data) req.write(JSON.stringify(data));
      req.end();
    });
  }

  async function publish(tag) {
    const res = await request('/releases');
    const rel = res.data.find(r => r.tag_name === tag);
    if (rel && rel.draft) {
      await request(`/releases/${rel.id}`, 'PATCH', { draft: false, prerelease: false });
      console.log(`Published ${tag}`);
    }
  }
  ```

### 5. Commit and Push Code
- Commit changes to Git and push to the remote repository.
