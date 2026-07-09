/*
  Copies the repo-root shared/ folder (diagnostics rendering module used by
  both the Electron app and the customer dashboard) into dashboard/shared/.

  Required because the dashboard deploys as a standalone directory (see
  .claude/launch.json — it serves only "dashboard", not the whole repo),
  so dashboard/index.html and customer.html can't reach ../shared/ once
  published. Run this before every dashboard deploy; the Electron app does
  not need it since it references shared/ directly from the repo root.
*/
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'shared');
const dest = path.join(__dirname, 'dashboard', 'shared');

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });

console.log(`Synced ${src} -> ${dest}`);
