const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = fs;
const {
  startProject,
  syncConnectedGithubRepository,
  upsertClaudeAgentsReference,
  validGitBranch,
  redactGitDiagnostic,
} = require('../lib/start');

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'joripspace-start-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { root, home, workspace };
}

function apiFor(projects, details = {}) {
  return async (requestPath) => {
    if (requestPath === '/v1/me/projects') return { account_id: 'account-test', projects };
    if (requestPath.includes('/deployments'))
      return { deployments: [{ deployment_id: 'dep-1', status: 'success' }] };
    return { project_id: 'heyenterc', project_slug: 'heyenterc', ...details };
  };
}

function generatedLegacyProject(overrides = {}) {
  const core = require('../vendor/core/onboarding.cjs');
  return {
    onboarding_schema_version: 9,
    agent_guide_updated_at: core.JORIPSPACE_AGENT_GUIDE_UPDATED_AT,
    deployment_policy: core.JORIPSPACE_WORKFLOW_POLICY,
    project_id: 'heyenterc',
    project_slug: 'heyenterc',
    default_url: 'https://heyenterc.example',
    api_base_url: 'https://api.joripspace.com',
    mcp_url: 'https://api.joripspace.com/mcp',
    deployment: { mode: 'direct', connection_status: 'not_connected' },
    ...overrides,
  };
}

test('start links an existing project with the canonical three-file contract and is idempotent', async () => {
  const { root, home, workspace } = fixture();
  try {
    writeFileSync(path.join(workspace, 'AGENTS.md'), '# User instructions\n');
    writeFileSync(path.join(workspace, 'CLAUDE.md'), '# Claude notes\n\n@AGENTS.md\n@AGENTS.md\n');
    const options = {
      projectId: 'heyenterc',
      cwd: workspace,
      homeDir: home,
      apiToken: 'token-is-not-written-by-start',
      apiRequest: apiFor([{ name: 'heyenterc', project_slug: 'heyenterc', role: 'owner' }], {
        description: 'Existing service',
        status: 'active',
      }),
      executable: path.join(home, 'bin', 'joripspace.exe'),
    };
    const first = await startProject(options);
    assert.equal(first.ok, true);
    assert.deepEqual(Object.keys(first).sort(), [
      'context',
      'continue_with',
      'executable',
      'next_action',
      'ok',
      'project',
      'template_choice',
    ]);
    assert.equal(first.project, 'heyenterc');
    assert.equal(first.executable, path.resolve(home, 'bin', 'joripspace.exe'));
    assert.equal(first.continue_with, 'cli');
    assert.equal(first.next_action, 'continue-development');
    assert.equal(first.template_choice, null);
    assert.equal(first.context.description, 'Existing service');
    assert.equal(first.context.project_status, 'active');
    assert.equal(readFileSync(path.join(workspace, '.joripspace', 'project'), 'utf8'), 'heyenterc\n');
    assert.equal(fs.existsSync(path.join(workspace, '.joripspace', 'project.json')), false);
    assert.equal(fs.existsSync(path.join(workspace, '.joripspace', 'agent-session.json')), false);
    assert.match(readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), /# User instructions/);
    assert.match(readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), /joripspace:start/);
    assert.equal(readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n\n# Claude notes\n\n');
    assert.match(readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), /\.joripspace\/project`/);

    const before = ['.joripspace/project', 'AGENTS.md', 'CLAUDE.md'].map((relative) =>
      readFileSync(path.join(workspace, ...relative.split('/')), 'utf8')
    );
    const second = await startProject(options);
    assert.deepEqual(second, first);
    assert.deepEqual(
      ['.joripspace/project', 'AGENTS.md', 'CLAUDE.md'].map((relative) =>
        readFileSync(path.join(workspace, ...relative.split('/')), 'utf8')
      ),
      before
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start authenticates and resolves the remote project before refusing a different legacy marker', async () => {
  const { root, workspace } = fixture();
  try {
    mkdirSync(path.join(workspace, '.joripspace'), { recursive: true });
    writeFileSync(
      path.join(workspace, '.joripspace', 'project.json'),
      `${JSON.stringify({ project_id: 'another-project' })}\n`
    );
    const calls = [];
    const result = await startProject({
      projectId: 'heyenterc',
      cwd: workspace,
      apiToken: 'token',
      apiRequest: async (requestPath) => {
        calls.push(requestPath);
        if (requestPath === '/v1/me/projects') {
          return { projects: [{ name: 'heyenterc', project_slug: 'heyenterc' }] };
        }
        throw new Error('details must not be fetched after a local identity conflict');
      },
      configureMcpServers: () => [],
      dataDir: path.join(root, 'data'),
    });
    assert.deepEqual(result, {
      ok: false,
      status: 'project_conflict',
      project: 'heyenterc',
      existing_project: 'another-project',
      cwd: path.resolve(workspace),
      conflicts: [],
      next_action: 'choose-a-folder-without-a-different-joripspace-project',
    });
    assert.deepEqual(calls, ['/v1/me/projects']);
    assert.equal(fs.existsSync(path.join(workspace, '.joripspace', 'project')), false);
    assert.equal(fs.existsSync(path.join(workspace, '.joripspace', 'project.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start never creates a project when the requested project is inaccessible', async () => {
  const { root, home, workspace } = fixture();
  try {
    const result = await startProject({
      projectId: 'missing-project',
      cwd: workspace,
      homeDir: home,
      apiToken: 'token',
      apiRequest: apiFor([{ project_slug: 'other-project', role: 'owner' }]),
      commandExists: () => false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'project_not_found');
    assert.equal(fs.existsSync(path.join(workspace, '.joripspace')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start matches a project name or slug but never accepts an internal project id as local identity', async () => {
  const { root, workspace } = fixture();
  try {
    const result = await startProject({
      projectId: 'internal-project-uuid',
      cwd: workspace,
      apiToken: 'token',
      apiRequest: apiFor([
        {
          project_id: 'internal-project-uuid',
          project_slug: 'public-project',
          name: 'Public Project',
        },
      ]),
      configureMcpServers: () => [],
      dataDir: path.join(root, 'data'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'project_not_found');
    assert.equal(JSON.stringify(result.available_projects).includes('internal-project-uuid'), false);
    assert.deepEqual(result.available_projects, [
      { project: 'public-project', name: 'Public Project', default_url: null, role: null },
    ]);
    assert.equal(fs.existsSync(path.join(workspace, '.joripspace')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start does not inspect or change user MCP configuration', async () => {
  const { root, home, workspace } = fixture();
  try {
    let configurationAttempted = false;
    const result = await startProject({
      projectId: 'heyenterc',
      cwd: workspace,
      homeDir: home,
      apiToken: 'token',
      apiRequest: apiFor([{ project_slug: 'heyenterc' }]),
      configureMcpServers: () => {
        configurationAttempted = true;
        throw new Error('MCP configuration must not be called');
      },
    });
    assert.equal(result.ok, true);
    assert.equal(configurationAttempted, false);
    assert.equal('mcp_configured' in result, false);
    assert.equal('mcp_active_in_current_session' in result, false);
    assert.equal('mcp_registrations' in result.context, false);
    assert.equal(result.next_action, 'continue-development');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a new empty project embeds the marketplace template choice before project questions', async () => {
  const { root, home, workspace } = fixture();
  try {
    const executable = path.join(home, 'bin', 'joripspace.exe');
    const calls = [];
    const result = await startProject({
      projectId: 'heyenterc',
      cwd: workspace,
      homeDir: home,
      apiToken: 'token',
      executable,
      apiRequest: async (requestPath) => {
        calls.push(requestPath);
        if (requestPath === '/v1/me/projects') {
          return { projects: [{ project_slug: 'heyenterc', status: 'active' }] };
        }
        if (requestPath === '/v1/projects/heyenterc') {
          return { project_slug: 'heyenterc', status: 'active', deployment: { mode: 'direct' } };
        }
        if (requestPath === '/v1/projects/heyenterc/deployments?limit=1') {
          return { deployments: [] };
        }
        if (requestPath === '/v1/templates') {
          return {
            templates: [
              {
                slug: 'jorip-note',
                name: 'JoripNote',
                description: '협업 문서와 노트',
                git_history_available: true,
              },
            ],
            next_cursor: 'next-page',
          };
        }
        throw new Error(`unexpected request: ${requestPath}`);
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.context.warnings, []);
    assert.equal(result.executable, path.resolve(executable));
    assert.equal(result.continue_with, 'cli');
    assert.equal(result.next_action, 'present-template-choice');
    assert.equal(result.template_choice.status, 'ready');
    assert.deepEqual(result.template_choice.no_template_option, {
      number: 0,
      name: '템플릿 없이 시작',
    });
    assert.equal(result.template_choice.templates[0].number, 1);
    assert.equal(result.template_choice.templates[0].slug, 'jorip-note');
    assert.equal(result.template_choice.next_cursor, 'next-page');
    assert.match(result.template_choice.install_command, /install-template/);
    assert.deepEqual(calls.filter((requestPath) => requestPath === '/v1/templates'), ['/v1/templates']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start safely migrates generated legacy workspace metadata and package helpers', async () => {
  const { root, workspace } = fixture();
  const core = require('../vendor/core/onboarding.cjs');
  const config = generatedLegacyProject();
  const helperFiles = [
    ['doctor.mjs', core.projectDoctorHelperFile()],
    ['deploy.mjs', core.projectDeployHelperFile()],
    ['install-template.mjs', core.projectInstallTemplateHelperFile()],
    ['pull.mjs', core.projectPullHelperFile()],
    ['checkpoint-client.mjs', core.projectCheckpointClientFile()],
    ['save.mjs', core.projectSaveHelperFile()],
    ['checkpoints.mjs', core.projectCheckpointsHelperFile()],
    ['restore.mjs', core.projectRestoreHelperFile()],
    ['deploy-checkpoint.mjs', core.projectDeployCheckpointHelperFile()],
    ['github-actions-template.yml', core.projectGithubActionsTemplateFile(config)],
  ];
  try {
    const managed = path.join(workspace, '.joripspace');
    mkdirSync(managed, { recursive: true });
    writeFileSync(path.join(managed, 'project.json'), `${JSON.stringify(config, null, 2)}\n`);
    writeFileSync(path.join(managed, 'agent-session.json'), core.projectAgentSessionFile(config));
    for (const [name, source] of helperFiles) writeFileSync(path.join(managed, name), source);
    writeFileSync(
      path.join(workspace, 'AGENTS.md'),
      core.upsertProjectAgentsContent('# Keep user rule\n', config)
    );
    writeFileSync(path.join(workspace, 'CLAUDE.md'), '# Keep Claude rule\n\n@AGENTS.md\n');
    writeFileSync(path.join(workspace, '.gitignore'), '.env.joripspace\n.joripspace/agent-session.json\n');
    writeFileSync(
      path.join(workspace, 'package.json'),
      `${JSON.stringify({ private: true, scripts: core.projectPackageHelperScripts(), dependencies: { fflate: '^0.8.2' } }, null, 2)}\n`
    );

    const result = await startProject({
      projectId: 'heyenterc',
      cwd: workspace,
      apiToken: 'token',
      apiRequest: apiFor([{ project_slug: 'heyenterc', name: 'heyenterc' }]),
      configureMcpServers: () => [],
      dataDir: path.join(root, 'data'),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(fs.readdirSync(managed), ['project']);
    assert.equal(readFileSync(path.join(managed, 'project'), 'utf8'), 'heyenterc\n');
    assert.match(readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), /# Keep user rule/);
    assert.equal(
      (readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8').match(/joripspace:start/g) || []).length,
      1
    );
    assert.equal(
      readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8'),
      '@AGENTS.md\n\n# Keep Claude rule\n\n'
    );
    assert.doesNotMatch(readFileSync(path.join(workspace, '.gitignore'), 'utf8'), /agent-session/);
    const packageJson = JSON.parse(readFileSync(path.join(workspace, 'package.json'), 'utf8'));
    assert.deepEqual(packageJson.scripts, {});
    assert.equal(packageJson.dependencies.fflate, '^0.8.2');
    const migrationWarning = result.context.warnings.find(
      (warning) => warning.code === 'legacy_workspace_backup_created'
    );
    assert.ok(migrationWarning);
    assert.equal(
      readFileSync(path.join(migrationWarning.backup_root, 'frozen', '.joripspace', 'doctor.mjs'), 'utf8'),
      core.projectDoctorHelperFile()
    );
    assert.equal(
      readFileSync(path.join(migrationWarning.backup_root, 'live', '.joripspace', 'doctor.mjs'), 'utf8'),
      core.projectDoctorHelperFile()
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start reinspects legacy files after source synchronization and preserves a changed helper', async () => {
  const { root, workspace } = fixture();
  const core = require('../vendor/core/onboarding.cjs');
  try {
    const managed = path.join(workspace, '.joripspace');
    mkdirSync(managed, { recursive: true });
    writeFileSync(path.join(managed, 'project.json'), `${JSON.stringify(generatedLegacyProject())}\n`);
    const helperPath = path.join(managed, 'doctor.mjs');
    const changedHelper = `${core.projectDoctorHelperFile()}\n// changed after initial inspection\n`;
    writeFileSync(helperPath, core.projectDoctorHelperFile());
    const packagePath = path.join(workspace, 'package.json');
    writeFileSync(
      packagePath,
      `${JSON.stringify({ private: true, scripts: core.projectPackageHelperScripts() }, null, 2)}\n`
    );

    const result = await startProject({
      projectId: 'heyenterc',
      cwd: workspace,
      apiToken: 'token',
      apiRequest: apiFor([{ project_slug: 'heyenterc' }]),
      configureMcpServers: () => [],
      dataDir: path.join(root, 'data'),
      beforeWorkspaceMigration: () => {
        writeFileSync(helperPath, changedHelper);
        writeFileSync(
          packagePath,
          `${JSON.stringify(
            {
              private: true,
              version: '2.0.0',
              userField: { keep: true },
              scripts: core.projectPackageHelperScripts(),
            },
            null,
            2
          )}\n`
        );
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'legacy_workspace_migration_blocked');
    assert.equal(readFileSync(helperPath, 'utf8'), changedHelper);
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    assert.equal(packageJson.version, '2.0.0');
    assert.deepEqual(packageJson.userField, { keep: true });
    assert.equal(fs.existsSync(path.join(managed, 'project')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start removes only generated package scripts from the latest inspected package', async () => {
  const { root, workspace } = fixture();
  const core = require('../vendor/core/onboarding.cjs');
  try {
    const managed = path.join(workspace, '.joripspace');
    mkdirSync(managed, { recursive: true });
    writeFileSync(path.join(managed, 'project.json'), `${JSON.stringify(generatedLegacyProject())}\n`);
    const helperPath = path.join(managed, 'doctor.mjs');
    writeFileSync(helperPath, core.projectDoctorHelperFile());
    const packagePath = path.join(workspace, 'package.json');
    writeFileSync(
      packagePath,
      `${JSON.stringify({ private: true, scripts: core.projectPackageHelperScripts() }, null, 2)}\n`
    );

    const result = await startProject({
      projectId: 'heyenterc',
      cwd: workspace,
      apiToken: 'token',
      apiRequest: apiFor([{ project_slug: 'heyenterc' }]),
      configureMcpServers: () => [],
      dataDir: path.join(root, 'data'),
      beforeWorkspaceMigration: () => {
        writeFileSync(
          packagePath,
          `${JSON.stringify(
            {
              private: true,
              version: '2.0.0',
              userField: { keep: true },
              scripts: core.projectPackageHelperScripts(),
            },
            null,
            2
          )}\n`
        );
      },
    });

    assert.equal(result.ok, true);
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    assert.equal(packageJson.version, '2.0.0');
    assert.deepEqual(packageJson.userField, { keep: true });
    assert.deepEqual(packageJson.scripts, {});
    assert.equal(fs.existsSync(helperPath), false);
    assert.equal(readFileSync(path.join(managed, 'project'), 'utf8'), 'heyenterc\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start aborts if a validated legacy file changes immediately before migration commit', async () => {
  const { root, workspace } = fixture();
  const core = require('../vendor/core/onboarding.cjs');
  try {
    const managed = path.join(workspace, '.joripspace');
    mkdirSync(managed, { recursive: true });
    writeFileSync(path.join(managed, 'project.json'), `${JSON.stringify(generatedLegacyProject())}\n`);
    const helperPath = path.join(managed, 'doctor.mjs');
    const changedHelper = `${core.projectDoctorHelperFile()}\n// concurrent user edit\n`;
    writeFileSync(helperPath, core.projectDoctorHelperFile());

    await assert.rejects(
      startProject({
        projectId: 'heyenterc',
        cwd: workspace,
        apiToken: 'token',
        apiRequest: apiFor([{ project_slug: 'heyenterc' }]),
        configureMcpServers: () => [],
        dataDir: path.join(root, 'data'),
        beforeMigrationCommit: () => writeFileSync(helperPath, changedHelper),
      }),
      (error) => error?.code === 'legacy_workspace_changed_during_migration'
    );
    assert.equal(readFileSync(helperPath, 'utf8'), changedHelper);
    assert.equal(fs.existsSync(path.join(managed, 'project')), false);
    assert.equal(fs.existsSync(path.join(managed, 'project.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start preserves a helper recreated after its validated path is atomically quarantined', async () => {
  const { root, workspace } = fixture();
  const core = require('../vendor/core/onboarding.cjs');
  try {
    const managed = path.join(workspace, '.joripspace');
    mkdirSync(managed, { recursive: true });
    writeFileSync(path.join(managed, 'project.json'), `${JSON.stringify(generatedLegacyProject())}\n`);
    const helperPath = path.join(managed, 'doctor.mjs');
    const changedHelper = `${core.projectDoctorHelperFile()}\n// concurrent path replacement\n`;
    writeFileSync(helperPath, core.projectDoctorHelperFile());

    await assert.rejects(
      startProject({
        projectId: 'heyenterc',
        cwd: workspace,
        apiToken: 'token',
        apiRequest: apiFor([{ project_slug: 'heyenterc' }]),
        configureMcpServers: () => [],
        dataDir: path.join(root, 'data'),
        afterLegacyPathQuarantined: ({ path: migratedPath, operation }) => {
          if (migratedPath === helperPath && operation === 'remove') {
            writeFileSync(helperPath, changedHelper);
          }
        },
      }),
      (error) => error?.code === 'legacy_workspace_changed_during_migration'
    );
    assert.equal(readFileSync(helperPath, 'utf8'), changedHelper);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start restores a quarantined helper if its bytes change before removal', async () => {
  const { root, workspace } = fixture();
  const core = require('../vendor/core/onboarding.cjs');
  try {
    const managed = path.join(workspace, '.joripspace');
    mkdirSync(managed, { recursive: true });
    writeFileSync(path.join(managed, 'project.json'), `${JSON.stringify(generatedLegacyProject())}\n`);
    const helperPath = path.join(managed, 'doctor.mjs');
    const changedHelper = `${core.projectDoctorHelperFile()}\n// concurrent open-file edit\n`;
    writeFileSync(helperPath, core.projectDoctorHelperFile());

    await assert.rejects(
      startProject({
        projectId: 'heyenterc',
        cwd: workspace,
        apiToken: 'token',
        apiRequest: apiFor([{ project_slug: 'heyenterc' }]),
        configureMcpServers: () => [],
        dataDir: path.join(root, 'data'),
        afterLegacyPathQuarantined: ({ path: migratedPath, quarantinePath, operation }) => {
          if (migratedPath === helperPath && operation === 'remove') {
            writeFileSync(quarantinePath, changedHelper);
          }
        },
      }),
      (error) => error?.code === 'legacy_workspace_changed_during_migration'
    );
    assert.equal(readFileSync(helperPath, 'utf8'), changedHelper);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start never overwrites a helper recreated immediately before no-replace recovery', async () => {
  const { root, workspace } = fixture();
  const core = require('../vendor/core/onboarding.cjs');
  const originalLinkSync = fs.linkSync;
  let backupPath = '';
  let injected = false;
  try {
    const managed = path.join(workspace, '.joripspace');
    mkdirSync(managed, { recursive: true });
    writeFileSync(path.join(managed, 'project.json'), `${JSON.stringify(generatedLegacyProject())}\n`);
    const helperPath = path.join(managed, 'doctor.mjs');
    const changedBackup = `${core.projectDoctorHelperFile()}\n// concurrent open-file edit\n`;
    const recreatedHelper = '// recreated immediately before recovery\n';
    writeFileSync(helperPath, core.projectDoctorHelperFile());

    fs.linkSync = function linkSyncWithConcurrentRecreation(existingPath, newPath) {
      if (
        !injected &&
        backupPath &&
        path.resolve(String(existingPath)) === path.resolve(backupPath) &&
        path.resolve(String(newPath)) === path.resolve(helperPath)
      ) {
        injected = true;
        writeFileSync(helperPath, recreatedHelper);
      }
      return originalLinkSync.apply(this, arguments);
    };

    await assert.rejects(
      startProject({
        projectId: 'heyenterc',
        cwd: workspace,
        apiToken: 'token',
        apiRequest: apiFor([{ project_slug: 'heyenterc' }]),
        configureMcpServers: () => [],
        dataDir: path.join(root, 'data'),
        afterLegacyPathQuarantined: ({ path: migratedPath, quarantinePath, operation }) => {
          if (migratedPath === helperPath && operation === 'remove') {
            backupPath = quarantinePath;
            writeFileSync(quarantinePath, changedBackup);
          }
        },
      }),
      (error) => error?.code === 'legacy_workspace_changed_during_migration'
    );
    assert.equal(injected, true);
    assert.equal(readFileSync(helperPath, 'utf8'), recreatedHelper);
    assert.equal(readFileSync(backupPath, 'utf8'), changedBackup);
  } finally {
    fs.linkSync = originalLinkSync;
    rmSync(root, { recursive: true, force: true });
  }
});

test('start never overwrites a package recreated during its atomic migration', async () => {
  const { root, workspace } = fixture();
  const core = require('../vendor/core/onboarding.cjs');
  try {
    const managed = path.join(workspace, '.joripspace');
    mkdirSync(managed, { recursive: true });
    writeFileSync(path.join(managed, 'project.json'), `${JSON.stringify(generatedLegacyProject())}\n`);
    const packagePath = path.join(workspace, 'package.json');
    writeFileSync(
      packagePath,
      `${JSON.stringify({ private: true, scripts: core.projectPackageHelperScripts() }, null, 2)}\n`
    );
    const concurrentPackage = `${JSON.stringify(
      { private: true, version: '9.9.9', userField: { keep: true }, scripts: { custom: 'keep' } },
      null,
      2
    )}\n`;

    await assert.rejects(
      startProject({
        projectId: 'heyenterc',
        cwd: workspace,
        apiToken: 'token',
        apiRequest: apiFor([{ project_slug: 'heyenterc' }]),
        configureMcpServers: () => [],
        dataDir: path.join(root, 'data'),
        afterLegacyPathQuarantined: ({ path: migratedPath, operation }) => {
          if (migratedPath === packagePath && operation === 'replace') {
            writeFileSync(packagePath, concurrentPackage);
          }
        },
      }),
      (error) => error?.code === 'legacy_workspace_changed_during_migration'
    );
    assert.equal(readFileSync(packagePath, 'utf8'), concurrentPackage);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start preserves a modified legacy helper and stops before migration writes', async () => {
  const { root, workspace } = fixture();
  const core = require('../vendor/core/onboarding.cjs');
  try {
    const managed = path.join(workspace, '.joripspace');
    mkdirSync(managed, { recursive: true });
    writeFileSync(path.join(managed, 'project.json'), `${JSON.stringify(generatedLegacyProject())}\n`);
    const helperPath = path.join(managed, 'doctor.mjs');
    writeFileSync(helperPath, `${core.projectDoctorHelperFile()}\n// user modification\n`);
    const before = readFileSync(helperPath, 'utf8');
    const result = await startProject({
      projectId: 'heyenterc',
      cwd: workspace,
      apiToken: 'token',
      apiRequest: apiFor([{ project_slug: 'heyenterc' }]),
      configureMcpServers: () => [],
      dataDir: path.join(root, 'data'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'legacy_workspace_migration_blocked');
    assert.equal(readFileSync(helperPath, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(managed, 'project')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start preserves and refuses to delete a legacy project file with user-defined fields', async () => {
  const { root, workspace } = fixture();
  try {
    const managed = path.join(workspace, '.joripspace');
    mkdirSync(managed, { recursive: true });
    const legacyPath = path.join(managed, 'project.json');
    const source = `${JSON.stringify(generatedLegacyProject({ user_extension: { keep: true } }), null, 2)}\n`;
    writeFileSync(legacyPath, source);
    const result = await startProject({
      projectId: 'heyenterc',
      cwd: workspace,
      apiToken: 'token',
      apiRequest: apiFor([{ project_slug: 'heyenterc' }]),
      configureMcpServers: () => [],
      dataDir: path.join(root, 'data'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'legacy_workspace_migration_blocked');
    assert.equal(
      result.conflicts.some((value) => value.includes('user_extension')),
      true
    );
    assert.equal(readFileSync(legacyPath, 'utf8'), source);
    assert.equal(fs.existsSync(path.join(managed, 'project')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start preserves a legacy project file with nested deployment extensions', async () => {
  const { root, workspace } = fixture();
  try {
    const managed = path.join(workspace, '.joripspace');
    mkdirSync(managed, { recursive: true });
    const legacyPath = path.join(managed, 'project.json');
    const source = `${JSON.stringify(
      generatedLegacyProject({
        deployment: {
          mode: 'direct',
          connection_status: 'not_connected',
          user_extension: { keep: true },
        },
      }),
      null,
      2
    )}\n`;
    writeFileSync(legacyPath, source);
    const result = await startProject({
      projectId: 'heyenterc',
      cwd: workspace,
      apiToken: 'token',
      apiRequest: apiFor([{ project_slug: 'heyenterc' }]),
      configureMcpServers: () => [],
      dataDir: path.join(root, 'data'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'legacy_workspace_migration_blocked');
    assert.equal(
      result.conflicts.some((value) => value.includes('deployment contains an unknown field')),
      true
    );
    assert.equal(readFileSync(legacyPath, 'utf8'), source);
    assert.equal(fs.existsSync(path.join(managed, 'project')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start preserves and refuses to delete a legacy agent session with user-defined fields', async () => {
  const { root, workspace } = fixture();
  try {
    const managed = path.join(workspace, '.joripspace');
    mkdirSync(managed, { recursive: true });
    const sessionPath = path.join(managed, 'agent-session.json');
    const source = `${JSON.stringify({
      schema_version: 2,
      scope: 'shared_workspace',
      project: { id: 'heyenterc', slug: 'heyenterc', config_file: '.joripspace/project.json' },
      agent_guide: { updated_at: '2026-08-01' },
      collaboration: { git_tracked: true },
      local_auth: {
        env_file: '.env.joripspace',
        required_environment: ['JORIPSPACE_API_TOKEN'],
        credential_values_in_session: false,
      },
      user_extension: { keep: true },
    })}\n`;
    writeFileSync(sessionPath, source);
    const result = await startProject({
      projectId: 'heyenterc',
      cwd: workspace,
      apiToken: 'token',
      apiRequest: apiFor([{ project_slug: 'heyenterc' }]),
      configureMcpServers: () => [],
      dataDir: path.join(root, 'data'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'legacy_workspace_migration_blocked');
    assert.equal(
      result.conflicts.some((value) => value.includes('generated shared-workspace session')),
      true
    );
    assert.equal(readFileSync(sessionPath, 'utf8'), source);
    assert.equal(fs.existsSync(path.join(managed, 'project')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start rejects JSON or multiline canonical marker content without rewriting it', async () => {
  for (const marker of ['{"project_id":"heyenterc"}\n', 'heyenterc\nother-project\n']) {
    const { root, workspace } = fixture();
    try {
      mkdirSync(path.join(workspace, '.joripspace'), { recursive: true });
      const markerPath = path.join(workspace, '.joripspace', 'project');
      writeFileSync(markerPath, marker);
      await assert.rejects(
        startProject({
          projectId: 'heyenterc',
          cwd: workspace,
          apiToken: 'token',
          apiRequest: apiFor([{ project_slug: 'heyenterc' }]),
          configureMcpServers: () => [],
          dataDir: path.join(root, 'data'),
        }),
        (error) => error?.code === 'invalid_project_marker'
      );
      assert.equal(readFileSync(markerPath, 'utf8'), marker);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('start fails closed on a non-canonical casing alias for the project marker', async () => {
  const { root, workspace } = fixture();
  try {
    mkdirSync(path.join(workspace, '.JORIPSPACE'), { recursive: true });
    writeFileSync(path.join(workspace, '.JORIPSPACE', 'PROJECT'), 'heyenterc\n');
    const result = await startProject({
      projectId: 'heyenterc',
      cwd: workspace,
      apiToken: 'token',
      apiRequest: apiFor([{ project_slug: 'heyenterc' }]),
      configureMcpServers: () => [],
      dataDir: path.join(root, 'data'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'non_canonical_workspace_path');
    assert.equal(
      result.conflicts.some((value) => value.includes('non-canonical casing')),
      true
    );
    assert.equal(fs.existsSync(path.join(workspace, '.joripspace', 'project.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start resolves a Git root containing spaces and Korean text without changing non-repository cwd behavior', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'joripspace-git-root-'));
  const repository = path.join(root, '한글 프로젝트 root');
  const nested = path.join(repository, 'packages', '웹 앱');
  mkdirSync(nested, { recursive: true });
  try {
    const initialized = require('node:child_process').spawnSync('git', ['-C', repository, 'init'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (initialized.error?.code === 'ENOENT') return;
    assert.equal(initialized.status, 0, initialized.stderr);
    const { resolveProjectRoot } = require('../lib/start');
    assert.equal(resolveProjectRoot(nested, 'git'), fs.realpathSync.native(repository));

    const plain = path.join(root, '일반 폴더');
    mkdirSync(plain, { recursive: true });
    assert.equal(resolveProjectRoot(plain, 'git'), path.resolve(plain));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLAUDE merge keeps its BOM and all non-reference bytes while removing duplicate references', () => {
  const remainder = '# 사용자 지침\r\nkeep trailing spaces  \n\r\n';
  const source = `\uFEFF${remainder}@AGENTS.md\r\n@AGENTS.md\n`;
  const result = upsertClaudeAgentsReference(source);
  assert.equal(result, `\uFEFF@AGENTS.md\r\n\r\n${remainder}`);
  assert.equal((result.match(/@AGENTS\.md/g) || []).length, 1);
  assert.equal(upsertClaudeAgentsReference(result), result);
});

test('GitHub source sync refuses a non-empty non-repository without overwriting it', () => {
  const { root, workspace } = fixture();
  try {
    writeFileSync(path.join(workspace, 'user-work.txt'), 'keep me\n');
    const result = syncConnectedGithubRepository(
      workspace,
      {
        mode: 'github_actions',
        repository: 'example/project',
        branch: 'main',
      },
      'git'
    );
    assert.equal(result.status, 'non_empty_directory');
    assert.deepEqual(result.unexpected_entries, ['user-work.txt']);
    assert.equal(readFileSync(path.join(workspace, 'user-work.txt'), 'utf8'), 'keep me\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('re-running start preserves a dirty matching GitHub worktree and returns the CLI continuation', async () => {
  const { root, workspace } = fixture();
  const childProcess = require('node:child_process');
  const originalSpawnSync = childProcess.spawnSync;
  const startModulePath = require.resolve('../lib/start');
  try {
    writeFileSync(path.join(workspace, 'app.js'), 'local uncommitted work\n');
    childProcess.spawnSync = (command, args) => {
      if (args.includes('--show-toplevel')) {
        return { status: 0, stdout: `${workspace}\n`, stderr: '' };
      }
      if (args.includes('--is-inside-work-tree')) return { status: 0, stdout: 'true\n', stderr: '' };
      if (args.includes('get-url')) {
        return { status: 0, stdout: 'https://github.com/example/project.git\n', stderr: '' };
      }
      if (args.includes('--show-current')) return { status: 0, stdout: 'main\n', stderr: '' };
      if (args.includes('--porcelain')) return { status: 0, stdout: ' M app.js\n', stderr: '' };
      throw new Error(`dirty start must not mutate Git state: ${args.join(' ')}`);
    };
    delete require.cache[startModulePath];
    const fresh = require('../lib/start');
    const options = {
      projectId: 'demo',
      cwd: workspace,
      apiToken: 'token',
      apiRequest: apiFor([{ project_slug: 'demo' }], {
        project_slug: 'demo',
        deployment: { mode: 'github_actions', repository: 'example/project', branch: 'main' },
      }),
      configureMcpServers: () => [],
      dataDir: path.join(root, 'data'),
      executable: path.join(root, 'bin', 'joripspace'),
    };
    const first = await fresh.startProject(options);
    const second = await fresh.startProject(options);
    for (const result of [first, second]) {
      assert.equal(result.ok, true);
      assert.equal(result.context.source_sync.status, 'dirty_worktree');
      assert.equal(result.context.warnings[0].code, 'local_work_preserved');
      assert.equal(result.continue_with, 'cli');
      assert.equal(path.isAbsolute(result.executable), true);
    }
    assert.equal(readFileSync(path.join(workspace, 'app.js'), 'utf8'), 'local uncommitted work\n');
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    delete require.cache[startModulePath];
    require('../lib/start');
    rmSync(root, { recursive: true, force: true });
  }
});

test('GitHub source sync rejects malformed repository configuration before mutation', () => {
  const { root, workspace } = fixture();
  try {
    const result = syncConnectedGithubRepository(
      workspace,
      {
        mode: 'github_actions',
        repository: 'https://attacker.example/repository',
        branch: 'main',
      },
      'git'
    );
    assert.equal(result.status, 'invalid_configuration');
    assert.equal(fs.readdirSync(workspace).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GitHub source sync rejects branch names that git could parse as options or invalid refs', () => {
  const { root, workspace } = fixture();
  try {
    for (const branch of [
      '-c-core.sshCommand=attacker',
      'main..other',
      'main@{1}',
      'feature\\windows',
      'feature//empty',
      'feature/.hidden',
      'feature/release.lock',
      'feature\nmalicious',
    ]) {
      assert.equal(validGitBranch(branch), false, branch);
      const result = syncConnectedGithubRepository(
        workspace,
        { mode: 'github_actions', repository: 'example/project', branch },
        'git-command-must-not-run'
      );
      assert.equal(result.status, 'invalid_configuration', branch);
    }
    for (const branch of ['main', 'feature/safe-name', 'release-2026.08']) {
      assert.equal(validGitBranch(branch), true, branch);
    }
    assert.equal(fs.readdirSync(workspace).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GitHub clone refuses a tracked project environment without changing local authentication files', () => {
  const { root, workspace } = fixture();
  const childProcess = require('node:child_process');
  const originalSpawnSync = childProcess.spawnSync;
  const startModulePath = require.resolve('../lib/start');
  try {
    writeFileSync(path.join(workspace, '.env.joripspace'), 'JORIPSPACE_API_TOKEN=local-token\n');
    writeFileSync(path.join(workspace, '.gitignore'), 'local-ignore\n.env.joripspace\n');
    const beforeEnv = readFileSync(path.join(workspace, '.env.joripspace'), 'utf8');
    const beforeIgnore = readFileSync(path.join(workspace, '.gitignore'), 'utf8');
    childProcess.spawnSync = (command, args) => {
      if (args.includes('rev-parse')) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('clone')) {
        const temporary = args.at(-1);
        mkdirSync(temporary, { recursive: true });
        writeFileSync(path.join(temporary, '.ENV.JORIPSPACE'), 'JORIPSPACE_API_TOKEN=remote-token\n');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args.includes('ls-files')) return { status: 0, stdout: '.ENV.JORIPSPACE\n', stderr: '' };
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    };
    delete require.cache[startModulePath];
    const fresh = require('../lib/start');
    const result = fresh.syncConnectedGithubRepository(
      workspace,
      { mode: 'github_actions', repository: 'example/project', branch: 'main' },
      'git'
    );
    assert.equal(result.status, 'protected_auth_file_tracked');
    assert.equal(readFileSync(path.join(workspace, '.env.joripspace'), 'utf8'), beforeEnv);
    assert.equal(readFileSync(path.join(workspace, '.gitignore'), 'utf8'), beforeIgnore);
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    delete require.cache[startModulePath];
    require('../lib/start');
    rmSync(root, { recursive: true, force: true });
  }
});

test('GitHub clone preserves remote and local ignore entries while enforcing project environment ignore', () => {
  const { root, workspace } = fixture();
  const childProcess = require('node:child_process');
  const originalSpawnSync = childProcess.spawnSync;
  const startModulePath = require.resolve('../lib/start');
  try {
    writeFileSync(path.join(workspace, '.env.joripspace'), 'JORIPSPACE_API_TOKEN=local-token\n');
    writeFileSync(path.join(workspace, '.gitignore'), 'local-ignore\n');
    childProcess.spawnSync = (command, args) => {
      if (args.includes('rev-parse')) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('clone')) {
        const temporary = args.at(-1);
        mkdirSync(temporary, { recursive: true });
        writeFileSync(path.join(temporary, '.GITIGNORE'), 'remote-ignore\n!.env.joripspace\n');
        writeFileSync(path.join(temporary, 'worker.js'), 'export default {}\n');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args.includes('ls-files')) return { status: 1, stdout: '', stderr: '' };
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    };
    delete require.cache[startModulePath];
    const fresh = require('../lib/start');
    const result = fresh.syncConnectedGithubRepository(
      workspace,
      { mode: 'github_actions', repository: 'example/project', branch: 'main' },
      'git'
    );
    assert.equal(result.status, 'synchronized');
    assert.equal(
      readFileSync(path.join(workspace, '.env.joripspace'), 'utf8'),
      'JORIPSPACE_API_TOKEN=local-token\n'
    );
    assert.equal(readFileSync(path.join(workspace, 'worker.js'), 'utf8'), 'export default {}\n');
    const ignore = readFileSync(path.join(workspace, '.gitignore'), 'utf8');
    assert.match(ignore, /^remote-ignore$/m);
    assert.match(ignore, /^local-ignore$/m);
    assert.equal(ignore.trimEnd().split(/\r?\n/).at(-1), '.env.joripspace');
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    delete require.cache[startModulePath];
    require('../lib/start');
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git diagnostics redact URL credentials, token query parameters, and token-like values', () => {
  const sentinel = ['github', 'pat', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'].join('_');
  const redacted = redactGitDiagnostic(
    `fatal: https://user:pass@github.com/example/project.git?access_token=query-secret&token=second ${sentinel}`
  );
  assert.equal(redacted.includes('user:pass'), false);
  assert.equal(redacted.includes('query-secret'), false);
  assert.equal(redacted.includes('second'), false);
  assert.equal(redacted.includes(sentinel), false);
  assert.match(redacted, /https:\/\/github\.com\/example\/project\.git/);
  assert.match(redacted, /access_token=\[redacted\]/);
});

test('start refuses a symlinked or junction .joripspace directory before API or guidance writes', async (t) => {
  const { root, workspace } = fixture();
  const outside = path.join(root, 'outside-management');
  mkdirSync(outside, { recursive: true });
  try {
    try {
      fs.symlinkSync(
        outside,
        path.join(workspace, '.joripspace'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip('symlinks unavailable');
      throw error;
    }
    let apiCalled = false;
    await assert.rejects(
      startProject({
        projectId: 'demo',
        cwd: workspace,
        apiToken: 'token',
        apiRequest: async () => {
          apiCalled = true;
          return {};
        },
      }),
      /symbolic link or junction/
    );
    assert.equal(apiCalled, false);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
