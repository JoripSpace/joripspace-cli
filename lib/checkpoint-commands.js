const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCheckpointOperation } = require('./checkpoint-client');

function createCheckpointCommands(deps) {
  async function command(rest, flags) {
    const subcommand = rest[0] || 'list';
    const project = deps.requireProjectId(flags);
    const checkpointId =
      deps.stringFlag(flags, 'checkpoint') || deps.stringFlag(flags, 'checkpoint-id') || rest[1] || '';
    if (subcommand === 'save' || subcommand === 'restore') {
      await runLocalOperation(subcommand, flags, checkpointId);
      return;
    }
    if (subcommand === 'list') {
      const params = new URLSearchParams();
      const limit = deps.positiveIntegerFlag(flags, 'limit');
      const cursor = deps.stringFlag(flags, 'cursor');
      if (limit) params.set('limit', String(limit));
      if (cursor) params.set('cursor', cursor);
      const body = await deps.apiRequest(
        flags,
        `/v1/projects/${encodeURIComponent(project)}/checkpoints${params.size ? `?${params}` : ''}`,
        { method: 'GET', ...deps.projectAuth(flags) }
      );
      deps.output(flags, body, (value) => {
        for (const item of value.checkpoints || []) {
          console.log(
            `#${item.sequence}\t${item.checkpoint_id}\t${item.label || '(이름 없음)'}\t${item.status}\t${item.deployable ? '배포 가능' : '백업 전용'}`
          );
        }
        if (value.next_cursor) console.log(`다음 cursor: ${value.next_cursor}`);
      });
      return;
    }
    if (!checkpointId) throw new Error(`checkpoint ${subcommand} requires --checkpoint`);
    const itemPath = `/v1/projects/${encodeURIComponent(project)}/checkpoints/${encodeURIComponent(checkpointId)}`;
    if (subcommand === 'get') {
      const body = await deps.apiRequest(flags, itemPath, { method: 'GET', ...deps.projectAuth(flags) });
      deps.output(flags, body, (value) => {
        console.log(`#${value.sequence} ${value.label || '(이름 없음)'}`);
        console.log(`상태: ${value.status}`);
        console.log(`배포: ${value.deployable ? '가능' : '백업 전용'}`);
        console.log(`파일: ${value.file_count || 0}개`);
      });
      return;
    }
    if (subcommand === 'update') {
      const bodyInput = {};
      if (flags.label !== undefined) bodyInput.label = deps.stringFlag(flags, 'label');
      if (flags.pin) bodyInput.pinned = true;
      if (flags.unpin) bodyInput.pinned = false;
      const pinned = deps.stringFlag(flags, 'pinned');
      if (pinned) bodyInput.pinned = pinned === 'true' || pinned === '1';
      const body = await deps.apiRequest(flags, itemPath, {
        method: 'PATCH',
        ...deps.projectAuth(flags),
        body: bodyInput,
      });
      deps.output(flags, body, (value) => console.log(`저장본 #${value.sequence} 정보를 변경했습니다.`));
      return;
    }
    if (subcommand === 'delete') {
      if (!deps.booleanFlag(flags, 'yes')) throw new Error('checkpoint delete requires --yes');
      const body = await deps.apiRequest(flags, itemPath, { method: 'DELETE', ...deps.projectAuth(flags) });
      deps.output(flags, body, () => console.log('저장본을 삭제했습니다.'));
      return;
    }
    if (subcommand === 'deploy') {
      const body = await deps.apiRequest(flags, `${itemPath}/deploy`, {
        method: 'POST',
        ...deps.projectAuth(flags),
        body: {},
      });
      deps.output(flags, body, (value) => {
        console.log(`저장본을 배포했습니다: ${value.url || project}`);
        console.log(`Deployment: ${value.deployment_id}`);
        printCheckpointWarnings(value.warnings);
      });
      return;
    }
    throw new Error(`Unknown checkpoint command: ${subcommand}`);
  }

  async function runLocalOperation(operation, flags, checkpointId) {
    const connection = deps.resolveConnection(flags);
    const value = await runCheckpointOperation(operation, {
      workspaceDir: deps.projectWorkspaceDir(flags),
      projectId: deps.requireProjectId(flags),
      apiBaseUrl: connection.apiBaseUrl,
      apiToken: deps.requireApiToken(flags, connection),
      checkpointId,
      label: deps.stringFlag(flags, 'label'),
      apply: deps.booleanFlag(flags, 'apply'),
      deploy: deps.booleanFlag(flags, 'deploy'),
    });
    deps.output(flags, value, (result) => {
      if (result.status === 'saved') {
        console.log(`저장본 #${result.checkpoint.sequence}을 만들었습니다. 파일 ${result.file_count}개`);
        printCheckpointWarnings(result.checkpoint.warnings);
        if (result.deployment) {
          console.log(
            `같은 저장본으로 배포했습니다: ${result.deployment.url || result.checkpoint.checkpoint_id}`
          );
        }
        return;
      }
      console.log(
        `추가 ${result.additions.length}개, 덮어쓰기 ${result.overwrites.length}개, 삭제 ${result.deletions.length}개`
      );
      if (result.status === 'preview') {
        console.log('미리보기만 했습니다. 승인 후 --apply를 붙여 다시 실행하세요.');
      } else console.log(`로컬 파일을 복원했습니다. 백업: ${result.backup_root}`);
    });
  }

  async function deployArchive(flags, project, label, reason, options = {}) {
    const staged = stageArchive(flags);
    const connection = deps.resolveConnection(flags);
    try {
      const result = await runCheckpointOperation('save', {
        workspaceDir: staged.root,
        projectId: project,
        apiBaseUrl: connection.apiBaseUrl,
        apiToken: deps.requireApiToken(flags, connection),
        entrypoint: staged.entrypoint,
        label,
        deploy: true,
        sourceType: 'agent',
      });
      const value = {
        ...(result.deployment || {}),
        checkpoint_id: result.checkpoint.checkpoint_id,
        transport: 'verified_chunked_archive',
        archive_bytes: result.archive_bytes,
        file_count: result.file_count,
        transport_reason: reason,
      };
      if (options.output !== false) {
        deps.output(flags, value, (body) => {
          console.log(`Deployment: ${body.deployment_id || body.checkpoint_id}`);
          console.log(`Status: ${body.status || 'deployed'}`);
          if (body.url || body.default_url) console.log(`URL: ${body.url || body.default_url}`);
          console.log(`Transport: ${body.transport}`);
          printCheckpointWarnings(result.checkpoint.warnings);
        });
      }
      return value;
    } finally {
      if (staged.temporary) fs.rmSync(staged.root, { recursive: true, force: true });
    }
  }

  function stageArchive(flags) {
    const source = deps.stringFlag(flags, 'source');
    const directory = deps.stringFlag(flags, 'dir');
    const mappings = deps.arrayFlag(flags, 'file');
    if (directory) {
      const root = deps.resolveDeploySourceDirectory(directory, deps.projectWorkspaceDir(flags)).path;
      const entrypoint = deps.safeProjectRelativePath(deps.stringFlag(flags, 'entrypoint'));
      if (!fs.existsSync(path.join(root, ...entrypoint.split('/')))) {
        throw new Error(`entrypoint not found in --dir: ${entrypoint}`);
      }
      deps.resolveDeploySourceFile(path.join(root, ...entrypoint.split('/')), root);
      return { root, entrypoint, temporary: false };
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-deploy-'));
    try {
      if (source) {
        const entrypoint = deps.safeProjectRelativePath(
          deps.stringFlag(flags, 'entrypoint') || path.basename(source)
        );
        copySource(root, entrypoint, source, deps.projectWorkspaceDir(flags));
        return { root, entrypoint, temporary: true };
      }
      if (mappings.length) {
        const entrypoint = deps.safeProjectRelativePath(deps.stringFlag(flags, 'entrypoint'));
        for (const mapping of mappings) {
          const [name, filePath] = deps.splitFileMapping(mapping);
          copySource(root, deps.safeProjectRelativePath(name), filePath, deps.projectWorkspaceDir(flags));
        }
        if (!fs.existsSync(path.join(root, ...entrypoint.split('/')))) {
          throw new Error(`entrypoint not found in --file mappings: ${entrypoint}`);
        }
        return { root, entrypoint, temporary: true };
      }
      throw new Error('deploy requires --source, --dir, or --file');
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  function copySource(root, relative, source, workspaceDir) {
    deps.assertDeployableProjectPath(relative);
    const resolved = deps.resolveDeploySourceFile(source, workspaceDir);
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(resolved.path, target);
  }

  return { command, deployArchive };
}

function printCheckpointWarnings(warnings) {
  for (const warning of warnings || []) console.warn(`경고: ${warning.message}`);
}

module.exports = { createCheckpointCommands };
