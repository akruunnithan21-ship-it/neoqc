const fs = require('fs');
const path = require('path');
const mode = process.argv[2] || 'client';

const configPath = path.join(__dirname, 'app-config.json');
fs.writeFileSync(configPath, JSON.stringify({ mode }, null, 2), 'utf-8');
console.log(`Successfully configured app-config.json for: ${mode} mode`);
