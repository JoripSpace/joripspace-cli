const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { applyEdits, getNodeValue, modify, parseTree, printParseErrorCode } = require('jsonc-parser');
const { parse: parseToml, stringify: stringifyToml } = require('smol-toml');

const JORIPSPACE_MCP_URL = 'https://api.joripspace.com/mcp';
const JORIPSPACE_SERVER_ID = 'joripspace';

const JSON_AGENT_PROFILES = Object.freeze({
  claude: { containerKey: 'mcpServers', allowJsonc: false },
  cursor: { containerKey: 'mcpServers', allowJsonc: false },
  antigravity: { containerKey: 'mcpServers', allowJsonc: false },
});

const MCP_AGENT_ADAPTERS = Object.freeze([
  {
    id: 'codex',
    surfaces: ['desktop', 'cli', 'ide'],
    resolveConfig: ({ homeDir }) => ({ path: path.join(homeDir, '.codex', 'config.toml') }),
    detect: ({ homeDir, existsSync, commandExists }) =>
      existsSync(path.join(homeDir, '.codex')) || commandExists('codex'),
    merge: mergeCodexConfig,
    nextAction: { kind: 'command', argv: ['codex', 'mcp', 'login', JORIPSPACE_SERVER_ID] },
  },
  {
    id: 'claude-code',
    surfaces: ['desktop-code-tab', 'cli'],
    resolveConfig: ({ homeDir }) => ({ path: path.join(homeDir, '.claude.json') }),
    detect: ({ homeDir, existsSync, commandExists }) =>
      existsSync(path.join(homeDir, '.claude.json')) ||
      existsSync(path.join(homeDir, '.claude')) ||
      commandExists('claude'),
    merge: (filePath) => mergeJsonMcpConfig(filePath, 'claude'),
    nextAction: { kind: 'in-app-command', command: '/mcp' },
  },
  {
    id: 'cursor',
    surfaces: ['ide', 'cli'],
    resolveConfig: ({ homeDir }) => ({ path: path.join(homeDir, '.cursor', 'mcp.json') }),
    detect: ({ homeDir, existsSync, commandExists }) =>
      existsSync(path.join(homeDir, '.cursor')) || commandExists('cursor') || commandExists('cursor-agent'),
    merge: (filePath) => mergeJsonMcpConfig(filePath, 'cursor'),
    nextAction: {
      kind: 'in-app-navigation',
      instruction: 'Open Customize > MCPs and complete authentication for the JoripSpace server.',
    },
  },
  {
    id: 'antigravity',
    surfaces: ['ide', 'cli'],
    resolveConfig: ({ homeDir }) => ({
      path: path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
    }),
    detect: ({ homeDir, existsSync, commandExists }) =>
      existsSync(path.join(homeDir, '.gemini', 'config', 'mcp_config.json')) ||
      existsSync(path.join(homeDir, '.gemini', 'antigravity')) ||
      existsSync(path.join(homeDir, '.gemini', 'antigravity-cli')) ||
      commandExists('agy'),
    merge: (filePath) => mergeJsonMcpConfig(filePath, 'antigravity'),
    nextAction: {
      kind: 'in-app-navigation',
      instruction: 'Open Agent Settings > Customizations and authenticate the JoripSpace server.',
    },
  },
  {
    id: 'opencode',
    surfaces: ['desktop', 'cli'],
    resolveConfig: resolveOpenCodeConfig,
    detect: ({ selection, existsSync, commandExists }) =>
      existsSync(path.dirname(selection.path)) || commandExists('opencode'),
    merge: mergeOpenCodeConfig,
    nextAction: {
      kind: 'command',
      argv: ['opencode', 'mcp', 'auth', JORIPSPACE_SERVER_ID],
    },
  },
]);

function configureUserMcpServers(options = {}) {
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const env = options.env || process.env;
  const existsSync = options.existsSync || fs.existsSync;
  const commandExists = options.commandExists || ((command) => defaultCommandExists(command, env));
  const context = { homeDir, env, existsSync, commandExists };

  return MCP_AGENT_ADAPTERS.map((adapter) => {
    let selection;
    try {
      selection = adapter.resolveConfig(context);
    } catch (error) {
      return agentErrorResult(adapter, null, error, false);
    }

    let detected;
    try {
      detected = Boolean(adapter.detect({ ...context, selection }));
    } catch (error) {
      return agentErrorResult(adapter, selection.path, error, false);
    }

    const common = {
      id: adapter.id,
      detected,
      path: selection.path,
      surfaces: [...adapter.surfaces],
      next_action: cloneSerializable(adapter.nextAction),
    };
    if (!detected) {
      return {
        ...common,
        status: 'not_detected',
        registration: 'not_detected',
        changed: false,
        auth_status: 'not_applicable',
        activation: 'not_registered',
      };
    }
    if (selection.error) {
      return {
        ...common,
        status: 'skipped',
        registration: 'skipped',
        changed: false,
        auth_status: 'not_applicable',
        activation: 'not_registered',
        error: selection.error,
        error_code: selection.errorCode || 'ambiguous_config',
      };
    }

    try {
      const result = adapter.merge(selection.path);
      return {
        ...common,
        ...result,
        registration:
          result.registration ||
          (result.status === 'configured' ? (result.changed ? 'updated' : 'unchanged') : result.status),
        auth_status: result.status === 'configured' ? 'not_checked' : 'not_applicable',
        activation: result.status === 'configured' ? 'next_session' : 'not_registered',
      };
    } catch (error) {
      return agentErrorResult(adapter, selection.path, error, true);
    }
  });
}

function agentErrorResult(adapter, filePath, error, detected) {
  return {
    id: adapter.id,
    detected,
    status: 'error',
    registration: 'error',
    changed: false,
    path: filePath,
    surfaces: [...adapter.surfaces],
    auth_status: 'not_applicable',
    activation: 'not_registered',
    next_action: cloneSerializable(adapter.nextAction),
    error: error instanceof Error ? error.message : String(error),
    ...(error && typeof error === 'object' && error.code ? { error_code: String(error.code) } : {}),
  };
}

function resolveOpenCodeConfig({ homeDir, env, existsSync }) {
  const xdgConfigHome = String(env?.XDG_CONFIG_HOME || '').trim();
  const directory = path.join(
    xdgConfigHome ? path.resolve(xdgConfigHome) : path.join(homeDir, '.config'),
    'opencode'
  );
  const jsonPath = path.join(directory, 'opencode.json');
  const jsoncPath = path.join(directory, 'opencode.jsonc');
  const hasJson = existsSync(jsonPath);
  const hasJsonc = existsSync(jsoncPath);
  if (hasJson && hasJsonc) {
    return {
      path: jsonPath,
      error:
        'both OpenCode global config files exist; neither was changed because their precedence is ambiguous',
      errorCode: 'ambiguous_opencode_config',
    };
  }
  return { path: hasJsonc ? jsoncPath : jsonPath };
}

function mergeJsonMcpConfig(filePath, agent = 'claude') {
  if (agent === 'opencode') return mergeOpenCodeConfig(filePath);
  const profile = JSON_AGENT_PROFILES[agent];
  if (!profile) throw new Error(`unsupported MCP JSON adapter: ${agent}`);
  const existed = fs.existsSync(filePath);
  const source = existed ? fs.readFileSync(filePath, 'utf8') : '';
  const allowJsonc = profile.allowJsonc && path.extname(filePath).toLowerCase() === '.jsonc';
  let config = {};

  if (existed) {
    const parsed = parseJsonConfigSource(source, { allowJsonc });
    if (!parsed.ok) return skippedConfig(filePath, parsed.error, parsed.errorCode);
    config = parsed.value;
  }
  if (!isPlainObject(config)) {
    return skippedConfig(
      filePath,
      'existing MCP configuration must be a JSON object; it was left unchanged',
      'invalid_json_root'
    );
  }
  const container = config[profile.containerKey];
  if (container !== undefined && !isPlainObject(container)) {
    return skippedConfig(
      filePath,
      `existing ${profile.containerKey} value is not an object; it was left unchanged`,
      'invalid_mcp_container'
    );
  }

  const existingServer = isPlainObject(container?.[JORIPSPACE_SERVER_ID])
    ? container[JORIPSPACE_SERVER_ID]
    : {};
  const server = buildJsonServer(agent, existingServer);
  if (isDeepStrictEqual(existingServer, server)) {
    return {
      status: 'configured',
      registration: 'unchanged',
      changed: false,
      path: filePath,
    };
  }

  let nextSource;
  if (!existed) {
    nextSource = `${JSON.stringify(
      { [profile.containerKey]: { [JORIPSPACE_SERVER_ID]: server } },
      null,
      2
    )}\n`;
  } else {
    const edits = modify(source, [profile.containerKey, JORIPSPACE_SERVER_ID], server, {
      formattingOptions: jsonFormattingOptions(source),
    });
    nextSource = applyEdits(source, edits);
  }

  const candidate = parseJsonConfigSource(nextSource, { allowJsonc });
  if (!candidate.ok) {
    throw codedError(
      'MCP_CONFIG_GENERATION_FAILED',
      'generated MCP configuration did not pass JSON validation'
    );
  }
  if (
    !isDeepStrictEqual(candidate.value?.[profile.containerKey]?.[JORIPSPACE_SERVER_ID], server) ||
    !isDeepStrictEqual(
      withoutJsonServer(config, profile.containerKey),
      withoutJsonServer(candidate.value, profile.containerKey)
    )
  ) {
    throw codedError(
      'MCP_CONFIG_GENERATION_FAILED',
      'generated MCP configuration did not preserve unrelated settings'
    );
  }

  writeTextAtomically(filePath, nextSource, { expectedSource: existed ? source : null });
  return {
    status: 'configured',
    registration: existed ? 'updated' : 'created',
    changed: true,
    path: filePath,
  };
}

function mergeOpenCodeConfig(filePath) {
  const existed = fs.existsSync(filePath);
  const source = existed ? fs.readFileSync(filePath, 'utf8') : '';
  const allowJsonc = path.extname(filePath).toLowerCase() === '.jsonc';
  let config = {};

  if (existed) {
    const parsed = parseJsonConfigSource(source, { allowJsonc });
    if (!parsed.ok) return skippedConfig(filePath, parsed.error, parsed.errorCode);
    config = parsed.value;
  }
  if (!isPlainObject(config)) {
    return skippedConfig(
      filePath,
      'existing OpenCode configuration must be a JSON object; it was left unchanged',
      'invalid_json_root'
    );
  }

  if (config.mcp !== undefined && !isPlainObject(config.mcp)) {
    return skippedConfig(
      filePath,
      'existing OpenCode mcp value is not an object; it was left unchanged',
      'invalid_mcp_container'
    );
  }

  const serverPath = ['mcp', JORIPSPACE_SERVER_ID];
  const existingServer = getJsonPath(config, serverPath);
  if (existingServer !== undefined && !isPlainObject(existingServer)) {
    return skippedConfig(
      filePath,
      'existing OpenCode JoripSpace configuration is not an object; it was left unchanged',
      'invalid_joripspace_server'
    );
  }

  const server = buildOpenCodeServer(existingServer || {});
  if (isDeepStrictEqual(existingServer, server)) {
    return {
      status: 'configured',
      registration: 'unchanged',
      changed: false,
      path: filePath,
    };
  }

  let nextSource;
  if (!existed) {
    nextSource = `${JSON.stringify({ mcp: { [JORIPSPACE_SERVER_ID]: server } }, null, 2)}\n`;
  } else {
    const edits = modify(source, serverPath, server, {
      formattingOptions: jsonFormattingOptions(source),
    });
    nextSource = applyEdits(source, edits);
  }

  const candidate = parseJsonConfigSource(nextSource, { allowJsonc });
  if (!candidate.ok) {
    throw codedError(
      'MCP_CONFIG_GENERATION_FAILED',
      'generated OpenCode MCP configuration did not pass JSON validation'
    );
  }
  if (
    !isDeepStrictEqual(getJsonPath(candidate.value, serverPath), server) ||
    !isDeepStrictEqual(withoutJsonPath(config, serverPath), withoutJsonPath(candidate.value, serverPath))
  ) {
    throw codedError(
      'MCP_CONFIG_GENERATION_FAILED',
      'generated OpenCode MCP configuration did not preserve unrelated settings'
    );
  }

  writeTextAtomically(filePath, nextSource, { expectedSource: existed ? source : null });
  return {
    status: 'configured',
    registration: existed ? 'updated' : 'created',
    changed: true,
    path: filePath,
  };
}

function buildOpenCodeServer(value) {
  const existing = isPlainObject(value) ? value : {};
  const safe = {};
  if (isFiniteNonNegativeNumber(existing.timeout)) safe.timeout = existing.timeout;
  return { type: 'remote', url: JORIPSPACE_MCP_URL, enabled: true, ...safe };
}

function buildJsonServer(agent, value) {
  const existing = isPlainObject(value) ? value : {};
  const safe = {};
  if (isFiniteNonNegativeNumber(existing.timeout)) safe.timeout = existing.timeout;
  if (agent === 'claude' && typeof existing.alwaysLoad === 'boolean') {
    safe.alwaysLoad = existing.alwaysLoad;
  }
  if (agent === 'antigravity') {
    if (typeof existing.disabled === 'boolean') safe.disabled = existing.disabled;
    if (isStringArray(existing.disabledTools)) safe.disabledTools = [...existing.disabledTools];
  }

  if (agent === 'antigravity') return { serverUrl: JORIPSPACE_MCP_URL, ...safe };
  if (agent === 'cursor') return { url: JORIPSPACE_MCP_URL, ...safe };
  return { type: 'http', url: JORIPSPACE_MCP_URL, ...safe };
}

function mergeCodexConfig(filePath) {
  const existed = fs.existsSync(filePath);
  const source = existed ? fs.readFileSync(filePath, 'utf8') : '';
  const parsed = parseTomlConfigSource(source);
  if (!parsed.ok) return skippedConfig(filePath, parsed.error, parsed.errorCode);
  const config = parsed.value;
  if (config.mcp_servers !== undefined && !isPlainObject(config.mcp_servers)) {
    return skippedConfig(
      filePath,
      'existing mcp_servers value is not a TOML table; it was left unchanged',
      'invalid_mcp_container'
    );
  }
  const existingServer = config.mcp_servers?.[JORIPSPACE_SERVER_ID];
  if (existingServer !== undefined && !isPlainObject(existingServer)) {
    return skippedConfig(
      filePath,
      'existing Codex JoripSpace configuration is not a TOML table; it was left unchanged',
      'invalid_joripspace_server'
    );
  }

  const removed = removeTomlTableTree(source, ['mcp_servers', JORIPSPACE_SERVER_ID]);
  if (existingServer !== undefined && !removed.found) {
    return skippedConfig(
      filePath,
      'existing Codex JoripSpace configuration uses a TOML representation that cannot be edited safely; it was left unchanged',
      'unsupported_toml_representation'
    );
  }
  const base = parseTomlConfigSource(removed.source);
  if (!base.ok || base.value.mcp_servers?.[JORIPSPACE_SERVER_ID] !== undefined) {
    return skippedConfig(
      filePath,
      'existing Codex JoripSpace configuration could not be isolated safely; it was left unchanged',
      'unsupported_toml_representation'
    );
  }

  const server = buildCodexServer(existingServer || {});
  const block = stringifyToml({ mcp_servers: { [JORIPSPACE_SERVER_ID]: server } }).trimEnd();
  const nextSource = appendTomlBlock(removed.source, block, detectEol(source));
  const candidate = parseTomlConfigSource(nextSource);
  if (!candidate.ok) {
    throw codedError(
      'MCP_CONFIG_GENERATION_FAILED',
      'generated Codex MCP configuration did not pass TOML validation'
    );
  }
  if (
    !isDeepStrictEqual(candidate.value.mcp_servers?.[JORIPSPACE_SERVER_ID], server) ||
    !isDeepStrictEqual(withoutTomlServer(config), withoutTomlServer(candidate.value))
  ) {
    throw codedError(
      'MCP_CONFIG_GENERATION_FAILED',
      'generated Codex MCP configuration did not preserve unrelated settings'
    );
  }
  if (nextSource === source) {
    return {
      status: 'configured',
      registration: 'unchanged',
      changed: false,
      path: filePath,
    };
  }

  writeTextAtomically(filePath, nextSource, { expectedSource: existed ? source : null });
  return {
    status: 'configured',
    registration: existed ? 'updated' : 'created',
    changed: true,
    path: filePath,
  };
}

function buildCodexServer(value) {
  const safe = isPlainObject(value) ? value : {};
  const server = {
    url: JORIPSPACE_MCP_URL,
    auth: 'oauth',
    enabled: true,
    required: false,
  };
  for (const key of ['startup_timeout_ms', 'startup_timeout_sec', 'tool_timeout_sec']) {
    if (isFiniteNonNegativeNumber(safe[key])) server[key] = safe[key];
  }
  for (const key of ['enabled_tools', 'disabled_tools']) {
    if (isStringArray(safe[key])) server[key] = [...safe[key]];
  }
  if (
    typeof safe.default_tools_approval_mode === 'string' &&
    ['auto', 'prompt', 'writes', 'approve'].includes(safe.default_tools_approval_mode)
  ) {
    server.default_tools_approval_mode = safe.default_tools_approval_mode;
  }
  if (isPlainObject(safe.tools)) {
    const tools = {};
    for (const [toolName, toolConfig] of Object.entries(safe.tools)) {
      if (
        isPlainObject(toolConfig) &&
        typeof toolConfig.approval_mode === 'string' &&
        ['auto', 'prompt', 'writes', 'approve'].includes(toolConfig.approval_mode)
      ) {
        tools[toolName] = { approval_mode: toolConfig.approval_mode };
      }
    }
    if (Object.keys(tools).length) server.tools = tools;
  }
  return server;
}

function sanitizeJoripspaceServer(value) {
  const blockedExactKeys = new Set([
    '__proto__',
    'args',
    'auth',
    'authprovidertype',
    'binary',
    'callback',
    'clientid',
    'command',
    'constructor',
    'cwd',
    'env',
    'environment',
    'executable',
    'helper',
    'oauth',
    'process',
    'prototype',
    'script',
    'workingdirectory',
  ]);
  const scrub = (input) => {
    if (Array.isArray(input)) return input.map(scrub);
    if (!isPlainObject(input)) return input;
    const output = {};
    for (const [key, nested] of Object.entries(input)) {
      const normalized = normalizeConfigKey(key);
      if (
        blockedExactKeys.has(normalized) ||
        normalized.startsWith('auth') ||
        normalized.includes('oauth') ||
        normalized.includes('header') ||
        normalized.includes('callback') ||
        normalized.includes('helper') ||
        /(token|secret|password|authorization|cookie|apikey|credential|bearer)/.test(normalized)
      ) {
        continue;
      }
      output[key] = scrub(nested);
    }
    return output;
  };
  return scrub(value);
}

function parseJsonConfigSource(source, { allowJsonc }) {
  const errors = [];
  const root = parseTree(source, errors, {
    allowTrailingComma: allowJsonc,
    disallowComments: !allowJsonc,
  });
  if (errors.length || !root) {
    const code = errors[0] ? printParseErrorCode(errors[0].error) : 'InvalidSymbol';
    return {
      ok: false,
      value: null,
      error: `existing MCP configuration is not valid ${allowJsonc ? 'JSONC' : 'JSON'} (${code}); it was left unchanged`,
      errorCode: allowJsonc ? 'invalid_jsonc' : 'invalid_json',
    };
  }
  const duplicate = findDuplicateJsonProperty(root);
  if (duplicate) {
    return {
      ok: false,
      value: null,
      error: `existing MCP configuration contains duplicate key ${duplicate}; it was left unchanged`,
      errorCode: 'duplicate_json_key',
    };
  }
  return { ok: true, value: toPlainJsonValue(getNodeValue(root)) };
}

function findDuplicateJsonProperty(node, currentPath = []) {
  if (node.type === 'object') {
    const seen = new Set();
    for (const property of node.children || []) {
      const key = property.children?.[0]?.value;
      const valueNode = property.children?.[1];
      if (typeof key !== 'string') continue;
      const nextPath = [...currentPath, key];
      if (seen.has(key)) return JSON.stringify(nextPath.join('.'));
      seen.add(key);
      const nested = valueNode ? findDuplicateJsonProperty(valueNode, nextPath) : null;
      if (nested) return nested;
    }
  } else if (node.type === 'array') {
    for (let index = 0; index < (node.children || []).length; index += 1) {
      const nested = findDuplicateJsonProperty(node.children[index], [...currentPath, String(index)]);
      if (nested) return nested;
    }
  }
  return null;
}

function parseTomlConfigSource(source) {
  try {
    const value = parseToml(String(source || ''));
    if (!isPlainObject(value)) throw new Error('root is not a table');
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      value: null,
      error: 'existing Codex configuration is not valid TOML; it was left unchanged',
      errorCode: 'invalid_toml',
    };
  }
}

function removeTomlTableTree(source, targetPath) {
  const lines = String(source || '').match(/[^\n]*\n|[^\n]+$/g) || [];
  const kept = [];
  let multilineState = null;
  let skipping = false;
  let found = false;

  for (const line of lines) {
    if (!multilineState && /^\s*\[/.test(line)) {
      const headerPath = parseTomlHeaderPath(line);
      if (headerPath) {
        skipping = pathStartsWith(headerPath, targetPath);
        if (skipping) found = true;
      } else if (/^\s*\[\[?/.test(line)) {
        skipping = false;
      }
    }
    if (!skipping) kept.push(line);
    multilineState = advanceTomlMultilineState(line, multilineState);
  }
  return { source: kept.join(''), found };
}

function parseTomlHeaderPath(line) {
  const header = String(line || '').replace(/\r?\n$/, '');
  try {
    const parsed = parseToml(`${header}\n__joripspace_header_probe__ = true\n`);
    return findTomlProbePath(parsed);
  } catch {
    return null;
  }
}

function findTomlProbePath(value, currentPath = []) {
  if (isPlainObject(value)) {
    if (value.__joripspace_header_probe__ === true) return currentPath;
    for (const [key, nested] of Object.entries(value)) {
      const found = findTomlProbePath(nested, [...currentPath, key]);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findTomlProbePath(nested, currentPath);
      if (found) return found;
    }
  }
  return null;
}

function advanceTomlMultilineState(line, initialState) {
  let state = initialState;
  let index = 0;
  while (index < line.length) {
    if (state === 'basic') {
      const end = line.indexOf('"""', index);
      if (end < 0) return state;
      if (isEscapedAt(line, end)) {
        index = end + 1;
        continue;
      }
      state = null;
      index = end + 3;
      continue;
    }
    if (state === 'literal') {
      const end = line.indexOf("'''", index);
      if (end < 0) return state;
      state = null;
      index = end + 3;
      continue;
    }

    const character = line[index];
    if (character === '#') break;
    if (line.startsWith('"""', index)) {
      state = 'basic';
      index += 3;
      continue;
    }
    if (line.startsWith("'''", index)) {
      state = 'literal';
      index += 3;
      continue;
    }
    if (character === '"') {
      index += 1;
      while (index < line.length) {
        if (line[index] === '"' && !isEscapedAt(line, index)) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === "'") {
      const end = line.indexOf("'", index + 1);
      index = end < 0 ? line.length : end + 1;
      continue;
    }
    index += 1;
  }
  return state;
}

function isEscapedAt(source, index) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function pathStartsWith(value, prefix) {
  return prefix.every((segment, index) => value[index] === segment);
}

function appendTomlBlock(source, block, eol = '\n') {
  const normalizedBlock = String(block || '')
    .trimEnd()
    .replace(/\r?\n/g, eol);
  let prefix = String(source || '');
  if (!prefix) return `${normalizedBlock}${eol}`;
  if (!prefix.endsWith('\n')) prefix += eol;
  if (!prefix.endsWith(`${eol}${eol}`)) prefix += eol;
  return `${prefix}${normalizedBlock}${eol}`;
}

function replaceTomlTable(source, tableName, replacement) {
  return replaceTomlTableTree(source, tableName, replacement);
}

function replaceTomlTableTree(source, tableName, replacement) {
  const removed = removeTomlTableTree(String(source || ''), String(tableName).split('.'));
  return appendTomlBlock(removed.source, replacement, detectEol(source));
}

function withoutJsonServer(config, containerKey) {
  const copy = { ...config };
  if (isPlainObject(copy[containerKey])) {
    const container = { ...copy[containerKey] };
    delete container[JORIPSPACE_SERVER_ID];
    if (Object.keys(container).length) copy[containerKey] = container;
    else delete copy[containerKey];
  }
  return copy;
}

function getJsonPath(value, segments) {
  let current = value;
  for (const segment of segments) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function withoutJsonPath(value, segments) {
  if (!isPlainObject(value)) return value;
  const [segment, ...remaining] = segments;
  const copy = { ...value };
  if (segment === undefined) return copy;
  if (remaining.length === 0) {
    delete copy[segment];
    return copy;
  }
  if (isPlainObject(copy[segment])) {
    const nested = withoutJsonPath(copy[segment], remaining);
    if (Object.keys(nested).length === 0) delete copy[segment];
    else copy[segment] = nested;
  }
  return copy;
}

function withoutTomlServer(config) {
  const copy = { ...config };
  if (isPlainObject(copy.mcp_servers)) {
    const servers = { ...copy.mcp_servers };
    delete servers[JORIPSPACE_SERVER_ID];
    if (Object.keys(servers).length) copy.mcp_servers = servers;
    else delete copy.mcp_servers;
  }
  return copy;
}

function jsonFormattingOptions(source) {
  const eol = detectEol(source);
  const indentation = /\r?\n([ \t]+)["}]/.exec(source)?.[1] || '  ';
  if (indentation.includes('\t')) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: Math.max(1, indentation.length), eol };
}

function detectEol(source) {
  return String(source || '').includes('\r\n') ? '\r\n' : '\n';
}

function writeTextAtomically(filePath, source, options = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const hasExpected = Object.prototype.hasOwnProperty.call(options, 'expectedSource');
  const expectedSource = hasExpected ? options.expectedSource : readTextIfExists(filePath);
  if (readTextIfExists(filePath) !== expectedSource) throw concurrentConfigError();

  let mode = 0o600;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let descriptor;
  let temporaryExists = false;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', mode);
    temporaryExists = true;
    fs.writeFileSync(descriptor, source, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.chmodSync(temporaryPath, mode);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }

    if (typeof options.beforeCommit === 'function') options.beforeCommit();
    if (readTextIfExists(filePath) !== expectedSource) throw concurrentConfigError();
    fs.renameSync(temporaryPath, filePath);
    temporaryExists = false;
    fsyncDirectory(directory);
    if (fs.readFileSync(filePath, 'utf8') !== source) {
      throw codedError('MCP_CONFIG_WRITE_VERIFY_FAILED', 'MCP configuration write verification failed');
    }
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    if (temporaryExists) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {}
    }
  }
}

function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function concurrentConfigError() {
  return codedError('MCP_CONFIG_CONFLICT', 'MCP configuration changed concurrently; it was not overwritten');
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function skippedConfig(filePath, error, errorCode) {
  return {
    status: 'skipped',
    registration: 'skipped',
    changed: false,
    path: filePath,
    error,
    error_code: errorCode,
  };
}

function defaultCommandExists(command, env = process.env) {
  const pathValue = String(env.PATH || env.Path || env.path || '');
  if (!pathValue) return false;
  const pathEntries = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? commandHasExtension(command)
        ? ['']
        : String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
            .split(';')
            .filter(Boolean)
      : [''];

  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        const stats = fs.statSync(candidate);
        if (!stats.isFile()) continue;
        if (process.platform === 'win32' || (stats.mode & 0o111) !== 0) return true;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error?.code)) throw error;
      }
    }
  }
  return false;
}

function commandHasExtension(command) {
  return path.extname(command) !== '';
}

function normalizeConfigKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_/g, '');
}

function toPlainJsonValue(value) {
  if (Array.isArray(value)) return value.map(toPlainJsonValue);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    Object.defineProperty(output, key, {
      value: toPlainJsonValue(nested),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFiniteNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function cloneSerializable(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

module.exports = {
  JORIPSPACE_MCP_URL,
  MCP_AGENT_ADAPTERS,
  configureUserMcpServers,
  defaultCommandExists,
  mergeCodexConfig,
  mergeJsonMcpConfig,
  mergeOpenCodeConfig,
  replaceTomlTable,
  replaceTomlTableTree,
  sanitizeJoripspaceServer,
  writeTextAtomically,
};
