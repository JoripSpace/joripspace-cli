const fs = require('node:fs');
const path = require('node:path');

const TEMPLATES_DIR = path.join(__dirname, 'templates');

function listTemplates() {
  return fs
    .readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readManifest(entry.name))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function getTemplate(id) {
  const safeId = assertTemplateId(id);
  const templateDir = path.join(TEMPLATES_DIR, safeId);
  if (!fs.existsSync(templateDir)) {
    return null;
  }

  return readManifest(safeId);
}

function buildTemplateDeployRequest(id, vars = {}) {
  const manifest = getTemplate(id);
  if (!manifest) {
    throw new Error(`Unknown template: ${id}`);
  }

  const variableValues = templateVariables(manifest, vars);
  const filesDir = path.join(TEMPLATES_DIR, manifest.id, 'files');
  const files = {};
  for (const filePath of walkFiles(filesDir)) {
    const relative = toPosix(path.relative(filesDir, filePath));
    files[relative] = renderTemplate(fs.readFileSync(filePath, 'utf8'), variableValues);
  }

  if (!Object.prototype.hasOwnProperty.call(files, manifest.entrypoint)) {
    throw new Error(`Template entrypoint not found: ${manifest.entrypoint}`);
  }

  return {
    manifest,
    deployRequest: {
      entrypoint: manifest.entrypoint,
      files,
    },
  };
}

function readManifest(id) {
  const safeId = assertTemplateId(id);
  return JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, safeId, 'manifest.json'), 'utf8'));
}

function templateVariables(manifest, vars) {
  const values = {};
  for (const variable of manifest.variables ?? []) {
    if (vars[variable.name] !== undefined) {
      values[variable.name] = String(vars[variable.name]);
    } else if (variable.default !== undefined) {
      values[variable.name] = String(variable.default);
    } else if (variable.required) {
      throw new Error(`Missing template variable: ${variable.name}`);
    }
  }
  return values;
}

function renderTemplate(source, vars) {
  return source.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (match, name) =>
    vars[name] === undefined ? match : vars[name]
  );
}

function walkFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function assertTemplateId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) {
    throw new Error('Template id must contain only lowercase letters, numbers, and hyphens.');
  }
  return id;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

module.exports = {
  buildTemplateDeployRequest,
  getTemplate,
  listTemplates,
};
