const path = require('node:path');

function installerFlags(args) {
  const values = Array.isArray(args) ? args : [];
  return {
    wantsHelp: values.includes('--help') || values.includes('-h'),
    wantsJson: values.includes('--json'),
    wantsQuiet: values.includes('--quiet') || values.includes('-quiet'),
    wantsVersion: values.includes('--version') || values.includes('-v'),
  };
}

function normalizeWindowsPathEntry(value, env = process.env) {
  const variables = new Map(
    Object.entries(env || {}).map(([name, nested]) => [name.toLowerCase(), String(nested || '')])
  );
  const expanded = String(value || '')
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/%([^%]+)%/g, (match, name) => variables.get(String(name).toLowerCase()) || match);
  if (!expanded) return '';
  return path.win32
    .normalize(expanded)
    .replace(/[\\/]+$/u, '')
    .toLowerCase();
}

module.exports = { installerFlags, normalizeWindowsPathEntry };
