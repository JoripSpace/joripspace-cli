const fs = require('node:fs');
const path = require('node:path');
const { resolveProjectFileTarget } = require('./project-paths');
const { parse: parseJsonc } = require('jsonc-parser');
const { parse: parseToml } = require('smol-toml');

function deploymentCompatibilityFlags(flags = {}) {
  let values = flags['compatibility-flag'];
  if (values === undefined) {
    const root = path.resolve(String(flags.cwd || process.cwd()));
    for (const name of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
      const location = resolveProjectFileTarget(root, name);
      if (location.blockers.length) throw new Error('Wrangler configuration path is blocked');
      if (!fs.existsSync(location.target)) continue;
      const text = fs.readFileSync(location.target, 'utf8');
      const errors = [];
      const config = name.endsWith('.toml') ? parseToml(text) : parseJsonc(text, errors, { allowTrailingComma: true });
      if (errors.length) throw new Error('Wrangler configuration is invalid');
      values = config?.compatibility_flags || [];
      break;
    }
  }
  values = values === undefined ? [] : Array.isArray(values) ? values : [values];
  if (values.some((flag) => flag !== 'nodejs_compat')) {
    throw new Error('Supported compatibility flags: nodejs_compat');
  }
  return [...new Set(values)];
}

module.exports = { deploymentCompatibilityFlags };
