const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parse: parseJsonc } = require('jsonc-parser');
const { parse: parseToml } = require('smol-toml');
const {
  configureUserMcpServers,
  defaultCommandExists,
  mergeCodexConfig,
  mergeJsonMcpConfig,
  mergeOpenCodeConfig,
  sanitizeJoripspaceServer,
  writeTextAtomically,
} = require('../lib/mcp-config');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-mcp-config-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('all known user-scope adapters scrub legacy execution and auth overrides while preserving safe settings', () => {
  const { root, cleanup } = fixture();
  const sentinel = 'MCP-SECRET-SENTINEL-DO-NOT-KEEP';
  try {
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(root, '.gemini', 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.codex', 'config.toml'),
      [
        '# unrelated Codex comment',
        '[mcp_servers.other]',
        'url = "https://other.example"',
        '',
        '[mcp_servers.joripspace]',
        'url = "https://legacy.example"',
        'startup_timeout_sec = 12',
        'enabled_tools = ["safe_tool"]',
        'default_tools_approval_mode = "prompt"',
        `headers_helper = "${sentinel}"`,
        '',
        '[mcp_servers.joripspace.http_headers]',
        `Authorization = "Bearer ${sentinel}"`,
        '',
        '[mcp_servers.joripspace.oauth]',
        `client_secret = "${sentinel}"`,
        'auth_server_metadata_url = "https://evil.example"',
        '',
        '[mcp_servers.joripspace.tools.safe_tool]',
        'approval_mode = "writes"',
        '',
        '[mcp_servers.joripspace.tools.token_inspector]',
        'approval_mode = "prompt"',
        '',
      ].join('\n')
    );

    const commonServer = {
      url: 'https://legacy.example',
      timeout: 31,
      alwaysLoad: true,
      disabled: false,
      disabledTools: ['legacy_tool'],
      headers: { Authorization: `Bearer ${sentinel}` },
      headersHelper: `run-${sentinel}`,
      env: { TOKEN: sentinel },
      command: 'node',
      args: ['--token', sentinel],
      oauth: {
        clientId: 'legacy-client',
        clientSecret: sentinel,
        authServerMetadataUrl: 'https://evil.example',
      },
      authProviderType: 'google_credentials',
      nested: { apiToken: sentinel, safe: true },
    };
    for (const filePath of [
      path.join(root, '.claude.json'),
      path.join(root, '.cursor', 'mcp.json'),
      path.join(root, '.gemini', 'config', 'mcp_config.json'),
    ]) {
      fs.writeFileSync(
        filePath,
        `${JSON.stringify({
          theme: 'keep-me',
          mcpServers: {
            other: { url: 'https://other.example', timeout: 9 },
            joripspace: commonServer,
          },
        })}\n`
      );
    }
    const openCodePath = path.join(root, '.config', 'opencode', 'opencode.jsonc');
    fs.writeFileSync(
      openCodePath,
      [
        '{',
        '  // keep this OpenCode comment',
        '  "theme": "keep-me",',
        '  "mcp": {',
        '    "other": { "type": "remote", "url": "https://other.example" },',
        `    "joripspace": ${JSON.stringify(commonServer)},`,
        '  },',
        '}',
        '',
      ].join('\n')
    );

    const desktopChatPath = path.join(root, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
    fs.mkdirSync(path.dirname(desktopChatPath), { recursive: true });
    const desktopChatSource = `{"mcpServers":{"joripspace":{"headers":{"Authorization":"${sentinel}"}}}}\n`;
    fs.writeFileSync(desktopChatPath, desktopChatSource);

    const first = configureUserMcpServers({
      homeDir: root,
      env: {},
      commandExists: () => false,
    });
    assert.deepEqual(
      first.map(({ id, status, registration, detected }) => ({ id, status, registration, detected })),
      [
        { id: 'codex', status: 'configured', registration: 'updated', detected: true },
        { id: 'claude-code', status: 'configured', registration: 'updated', detected: true },
        { id: 'cursor', status: 'configured', registration: 'updated', detected: true },
        { id: 'antigravity', status: 'configured', registration: 'updated', detected: true },
        { id: 'opencode', status: 'configured', registration: 'updated', detected: true },
      ]
    );
    for (const result of first) {
      assert.equal(result.auth_status, 'not_checked');
      assert.equal(result.activation, 'next_session');
    }

    const claude = JSON.parse(fs.readFileSync(path.join(root, '.claude.json'), 'utf8'));
    assert.deepEqual(claude.mcpServers.joripspace, {
      type: 'http',
      url: 'https://api.joripspace.com/mcp',
      timeout: 31,
      alwaysLoad: true,
    });
    const cursor = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'mcp.json'), 'utf8'));
    assert.deepEqual(cursor.mcpServers.joripspace, {
      url: 'https://api.joripspace.com/mcp',
      timeout: 31,
    });
    const antigravity = JSON.parse(
      fs.readFileSync(path.join(root, '.gemini', 'config', 'mcp_config.json'), 'utf8')
    );
    assert.deepEqual(antigravity.mcpServers.joripspace, {
      serverUrl: 'https://api.joripspace.com/mcp',
      timeout: 31,
      disabled: false,
      disabledTools: ['legacy_tool'],
    });
    for (const config of [claude, cursor, antigravity]) {
      assert.equal(config.theme, 'keep-me');
      assert.deepEqual(config.mcpServers.other, { url: 'https://other.example', timeout: 9 });
      assert.equal(JSON.stringify(config.mcpServers.joripspace).includes(sentinel), false);
    }

    const openCodeSource = fs.readFileSync(openCodePath, 'utf8');
    const openCode = parseJsonc(openCodeSource);
    assert.match(openCodeSource, /keep this OpenCode comment/);
    assert.equal(openCode.theme, 'keep-me');
    assert.deepEqual(openCode.mcp.other, {
      type: 'remote',
      url: 'https://other.example',
    });
    assert.deepEqual(openCode.mcp.joripspace, {
      type: 'remote',
      url: 'https://api.joripspace.com/mcp',
      enabled: true,
      timeout: 31,
    });
    assert.equal(openCodeSource.includes(sentinel), false);

    const codexSource = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
    const codex = parseToml(codexSource);
    assert.match(codexSource, /unrelated Codex comment/);
    assert.equal(codexSource.includes(sentinel), false);
    assert.equal(codex.mcp_servers.other.url, 'https://other.example');
    assert.deepEqual(codex.mcp_servers.joripspace, {
      url: 'https://api.joripspace.com/mcp',
      auth: 'oauth',
      enabled: true,
      required: false,
      startup_timeout_sec: 12,
      enabled_tools: ['safe_tool'],
      default_tools_approval_mode: 'prompt',
      tools: {
        safe_tool: { approval_mode: 'writes' },
        token_inspector: { approval_mode: 'prompt' },
      },
    });
    assert.equal(fs.readFileSync(desktopChatPath, 'utf8'), desktopChatSource);

    const snapshots = new Map(first.map((result) => [result.path, fs.readFileSync(result.path, 'utf8')]));
    const second = configureUserMcpServers({
      homeDir: root,
      env: {},
      commandExists: () => false,
    });
    assert.equal(
      second.every((result) => result.registration === 'unchanged'),
      true
    );
    assert.equal(
      second.every((result) => result.changed === false),
      true
    );
    for (const [filePath, source] of snapshots) {
      assert.equal(fs.readFileSync(filePath, 'utf8'), source);
    }
  } finally {
    cleanup();
  }
});

test('invalid and ambiguous JSON, JSONC, and TOML are skipped byte-for-byte', () => {
  const { root, cleanup } = fixture();
  try {
    const cases = [
      {
        path: path.join(root, 'cursor.json'),
        source: '{invalid\n',
        run: (filePath) => mergeJsonMcpConfig(filePath, 'cursor'),
        code: 'invalid_json',
      },
      {
        path: path.join(root, 'duplicate.json'),
        source: '{"mcpServers":{"other":1,"other":2}}\n',
        run: (filePath) => mergeJsonMcpConfig(filePath, 'claude'),
        code: 'duplicate_json_key',
      },
      {
        path: path.join(root, 'opencode.jsonc'),
        source: '{"mcp": /* unterminated',
        run: mergeOpenCodeConfig,
        code: 'invalid_jsonc',
      },
      {
        path: path.join(root, 'config.toml'),
        source: 'invalid =\n',
        run: mergeCodexConfig,
        code: 'invalid_toml',
      },
      {
        path: path.join(root, 'inline.toml'),
        source: 'mcp_servers = { joripspace = { url = "https://legacy.example" } }\n',
        run: mergeCodexConfig,
        code: 'unsupported_toml_representation',
      },
    ];
    for (const candidate of cases) {
      fs.writeFileSync(candidate.path, candidate.source);
      const result = candidate.run(candidate.path);
      assert.equal(result.status, 'skipped');
      assert.equal(result.error_code, candidate.code);
      assert.equal(fs.readFileSync(candidate.path, 'utf8'), candidate.source);
    }

    const directory = path.join(root, '.config', 'opencode');
    fs.mkdirSync(directory, { recursive: true });
    const jsonPath = path.join(directory, 'opencode.json');
    const jsoncPath = path.join(directory, 'opencode.jsonc');
    fs.writeFileSync(jsonPath, '{"theme":"json"}\n');
    fs.writeFileSync(jsoncPath, '{// jsonc\n"theme":"jsonc"}\n');
    const result = configureUserMcpServers({
      homeDir: root,
      env: {},
      commandExists: () => false,
    }).find((item) => item.id === 'opencode');
    assert.equal(result.status, 'skipped');
    assert.equal(result.error_code, 'ambiguous_opencode_config');
    assert.equal(fs.readFileSync(jsonPath, 'utf8'), '{"theme":"json"}\n');
    assert.equal(fs.readFileSync(jsoncPath, 'utf8'), '{// jsonc\n"theme":"jsonc"}\n');
  } finally {
    cleanup();
  }
});

test('Codex merge preserves valid multiline TOML containing a table-looking string', () => {
  const { root, cleanup } = fixture();
  try {
    const filePath = path.join(root, 'config.toml');
    const source = [
      'note = """',
      '[mcp_servers.joripspace]',
      'this is string content',
      '"""',
      '',
      '[mcp_servers.other]',
      'url = "https://other.example"',
      '',
    ].join('\n');
    fs.writeFileSync(filePath, source);
    const result = mergeCodexConfig(filePath);
    assert.equal(result.status, 'configured');
    const next = fs.readFileSync(filePath, 'utf8');
    assert.match(next, /this is string content/);
    const parsed = parseToml(next);
    assert.match(parsed.note, /\[mcp_servers\.joripspace\]/);
    assert.equal(parsed.mcp_servers.other.url, 'https://other.example');
    assert.equal(parsed.mcp_servers.joripspace.auth, 'oauth');
  } finally {
    cleanup();
  }
});

test('agent detection uses exact state and PATH evidence without executing candidate commands', () => {
  const { root, cleanup } = fixture();
  try {
    fs.mkdirSync(path.join(root, '.gemini'), { recursive: true });
    let results = configureUserMcpServers({
      homeDir: root,
      env: {},
      commandExists: () => false,
    });
    assert.equal(results.length, 5);
    assert.equal(
      results.every((result) => result.status === 'not_detected'),
      true
    );

    fs.mkdirSync(path.join(root, '.gemini', 'antigravity'), { recursive: true });
    fs.mkdirSync(path.join(root, '.config', 'opencode'), { recursive: true });
    results = configureUserMcpServers({
      homeDir: root,
      env: {},
      commandExists: () => false,
    });
    assert.equal(results.find((result) => result.id === 'antigravity').status, 'configured');
    assert.equal(results.find((result) => result.id === 'opencode').status, 'configured');

    const binaryDirectory = path.join(root, 'bin');
    const markerPath = path.join(root, 'executed.txt');
    fs.mkdirSync(binaryDirectory, { recursive: true });
    const binaryPath = path.join(binaryDirectory, process.platform === 'win32' ? 'codex.CMD' : 'codex');
    fs.writeFileSync(
      binaryPath,
      process.platform === 'win32'
        ? `@echo executed>${markerPath}\r\n`
        : `#!/bin/sh\nprintf executed > "${markerPath}"\n`
    );
    if (process.platform !== 'win32') fs.chmodSync(binaryPath, 0o755);
    assert.equal(
      defaultCommandExists('codex', {
        PATH: binaryDirectory,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      }),
      true
    );
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    cleanup();
  }
});

test('OpenCode uses the user XDG configuration directory when configured', () => {
  const { root, cleanup } = fixture();
  try {
    const xdgConfigHome = path.join(root, 'custom-xdg');
    fs.mkdirSync(path.join(xdgConfigHome, 'opencode'), { recursive: true });
    const result = configureUserMcpServers({
      homeDir: root,
      env: { XDG_CONFIG_HOME: xdgConfigHome, PATH: '' },
      commandExists: () => false,
    }).find((entry) => entry.id === 'opencode');
    assert.equal(result.status, 'configured');
    assert.equal(result.path, path.join(xdgConfigHome, 'opencode', 'opencode.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(result.path, 'utf8')).mcp.joripspace, {
      type: 'remote',
      url: 'https://api.joripspace.com/mcp',
      enabled: true,
    });

    const source = fs.readFileSync(result.path, 'utf8');
    const second = mergeOpenCodeConfig(result.path);
    assert.equal(second.registration, 'unchanged');
    assert.equal(second.changed, false);
    assert.equal(fs.readFileSync(result.path, 'utf8'), source);
  } finally {
    cleanup();
  }
});

test('OpenCode merge uses the official direct mcp map, scrubs credentials, and preserves JSONC comments', () => {
  const { root, cleanup } = fixture();
  const filePath = path.join(root, 'opencode.jsonc');
  const sentinel = 'OPEN-CODE-V2-SECRET';
  try {
    fs.writeFileSync(
      filePath,
      [
        '{',
        '  // keep root comment',
        '  "theme": "keep-me",',
        '  "mcp": {',
        '    // keep other server comment',
        '    "other": { "type": "remote", "url": "https://other.example" },',
        '    "joripspace": {',
        '      "type": "local",',
        '      "url": "https://legacy.example",',
        '      "disabled": true,',
        '      "enabled": false,',
        '      "timeout": 27,',
        `      "headers": { "Authorization": "Bearer ${sentinel}" },`,
        `      "oauth": { "clientSecret": "${sentinel}" },`,
        `      "command": ["node", "${sentinel}"],`,
        `      "env": { "TOKEN": "${sentinel}" }`,
        '    },',
        '  },',
        '}',
        '',
      ].join('\n')
    );

    const first = mergeOpenCodeConfig(filePath);
    assert.equal(first.status, 'configured');
    assert.equal(first.registration, 'updated');
    assert.equal(first.changed, true);
    const source = fs.readFileSync(filePath, 'utf8');
    const config = parseJsonc(source);
    assert.match(source, /keep root comment/);
    assert.match(source, /keep other server comment/);
    assert.equal(source.includes(sentinel), false);
    assert.equal(config.theme, 'keep-me');
    assert.deepEqual(config.mcp.other, {
      type: 'remote',
      url: 'https://other.example',
    });
    assert.deepEqual(config.mcp.joripspace, {
      type: 'remote',
      url: 'https://api.joripspace.com/mcp',
      enabled: true,
      timeout: 27,
    });

    const second = mergeOpenCodeConfig(filePath);
    assert.equal(second.registration, 'unchanged');
    assert.equal(second.changed, false);
    assert.equal(fs.readFileSync(filePath, 'utf8'), source);
  } finally {
    cleanup();
  }
});

test('OpenCode direct merge stays direct and remains idempotent', () => {
  const { root, cleanup } = fixture();
  const filePath = path.join(root, 'opencode.json');
  try {
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({
        mcp: {
          other: { type: 'remote', url: 'https://other.example' },
          joripspace: {
            type: 'local',
            command: ['node', '--token', 'legacy-secret'],
            headers: { Authorization: 'legacy-secret' },
            timeout: 19,
          },
        },
      })}\n`
    );

    const first = mergeOpenCodeConfig(filePath);
    assert.equal(first.status, 'configured');
    const source = fs.readFileSync(filePath, 'utf8');
    const config = JSON.parse(source);
    assert.deepEqual(config.mcp.joripspace, {
      type: 'remote',
      url: 'https://api.joripspace.com/mcp',
      enabled: true,
      timeout: 19,
    });
    assert.equal(Object.prototype.hasOwnProperty.call(config.mcp, 'servers'), false);
    assert.equal(source.includes('legacy-secret'), false);

    const second = mergeOpenCodeConfig(filePath);
    assert.equal(second.registration, 'unchanged');
    assert.equal(second.changed, false);
    assert.equal(fs.readFileSync(filePath, 'utf8'), source);
  } finally {
    cleanup();
  }
});

test('OpenCode invalid MCP containers are skipped byte-for-byte', () => {
  const { root, cleanup } = fixture();
  try {
    const cases = [
      {
        name: 'unknown.jsonc',
        source: '{// keep unknown\n"mcp":true}\n',
      },
    ];
    for (const candidate of cases) {
      const filePath = path.join(root, candidate.name);
      fs.writeFileSync(filePath, candidate.source);
      const result = mergeOpenCodeConfig(filePath);
      assert.equal(result.status, 'skipped');
      assert.equal(result.error_code, 'invalid_mcp_container');
      assert.equal(fs.readFileSync(filePath, 'utf8'), candidate.source);
    }
  } finally {
    cleanup();
  }
});

test('atomic writer refuses a concurrent update, cleans its temporary file, and preserves mode', () => {
  const { root, cleanup } = fixture();
  try {
    const filePath = path.join(root, 'config.json');
    fs.writeFileSync(filePath, 'before\n');
    if (process.platform !== 'win32') fs.chmodSync(filePath, 0o640);
    assert.throws(
      () =>
        writeTextAtomically(filePath, 'ours\n', {
          expectedSource: 'before\n',
          beforeCommit: () => fs.writeFileSync(filePath, 'concurrent\n'),
        }),
      (error) => error?.code === 'MCP_CONFIG_CONFLICT'
    );
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'concurrent\n');
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.includes('.tmp-')),
      []
    );

    writeTextAtomically(filePath, 'after\n', { expectedSource: 'concurrent\n' });
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'after\n');
    if (process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777, 0o640);
  } finally {
    cleanup();
  }
});

test('credential sanitizer removes executable and auth-routing aliases recursively', () => {
  const sentinel = 'SECRET';
  assert.deepEqual(
    sanitizeJoripspaceServer({
      timeout: 10,
      headersHelper: `run-${sentinel}`,
      authProviderType: 'google_credentials',
      oauth: { clientId: 'client', clientSecret: sentinel },
      nested: { safe: true, apiToken: sentinel, requestHeaders: { Authorization: sentinel } },
    }),
    { timeout: 10, nested: { safe: true } }
  );
});
