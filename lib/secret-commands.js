const { message } = require('./locale');

function secretManagementUrl(project) {
  return `https://joripspace.com/projects/${encodeURIComponent(project)}/?tab=secrets`;
}

function createSecretCommands(deps) {
  return async function secrets(rest, flags) {
    const subcommand = rest[0] || 'list';
    if (subcommand === 'delete') {
      return deps.webOnlyCommand(message('Secret deletion', '비밀 키 삭제'));
    }
    if (!['list', 'generate', 'set', 'update'].includes(subcommand)) {
      throw new Error('secret command requires: list, generate, set, or update');
    }
    const project = deps.requireProjectId(flags);
    const url = secretManagementUrl(project);
    const auth = deps.projectAuth(flags);
    const endpoint = `/v1/projects/${encodeURIComponent(project)}/secrets`;
    let result;
    if (subcommand === 'list') {
      result = await deps.apiRequest(flags, endpoint, { method: 'GET', ...auth });
    } else {
      const name = deps.stringFlag(flags, 'name').toUpperCase();
      if (!name || !/^[_A-Z][_A-Z0-9]{0,127}$/.test(name)) {
        throw new Error('secret requires --name matching [_A-Z][_A-Z0-9]* (at most 128 characters)');
      }
      if (subcommand === 'generate') {
        result = await deps.apiRequest(flags, `${endpoint}/generate`, {
          method: 'POST', ...auth, body: { name },
        });
      } else {
        if (!deps.booleanFlag(flags, 'value-stdin') || flags.value !== undefined) {
          throw new Error(message(
            'Use --value-stdin to supply the secret through standard input, never a command-line value.',
            '--value-stdin으로 비밀 키 값을 표준 입력으로 전달하세요. 명령 인자에는 값을 넣지 마세요.'
          ));
        }
        const value = await readSecretValue(process.stdin);
        try {
          await deps.apiRequest(flags, endpoint, { method: 'POST', ...auth, body: { name, value } });
        } catch (cause) {
          // An upstream failure may echo all or part of a value. Report only safe metadata.
          const error = new Error(message('The secret could not be saved.', '비밀 키를 저장하지 못했습니다.'));
          error.code = 'secret_set_failed';
          error.details = {
            name, secret_management_url: url,
            ...(Number.isInteger(cause?.status) ? { http_status: cause.status } : {}),
          };
          throw error;
        }
        result = { status: 'success', project_id: project, name };
      }
    }
    result = { ...result, secret_management_url: url };
    deps.output(flags, result, (body) => {
      if (subcommand === 'list') {
        for (const secret of body.secrets || []) {
          console.log(`${secret.name}\tcreated=${secret.created_at}\tupdated=${secret.updated_at}`);
        }
      } else {
        console.log(`Secret: ${body.name}`);
        console.log(`Status: ${body.status || (body.created || body.generated ? 'generated' : 'preserved')}`);
      }
      console.log(`${message('Secret management', '비밀 키 관리')}: ${url}`);
    });
  };
}

async function readSecretValue(input) {
  if (input.isTTY) {
    throw new Error(message('Pipe the secret value to standard input.', '비밀 키 값을 표준 입력으로 전달하세요.'));
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(bytes);
      size += bytes.length;
      if (size > 5120) throw new Error('invalid size');
    }
    if (!size) throw new Error('empty value');
    // Preserve whitespace and newlines, including multi-line provider keys.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error(message(
      'Secret input must contain 1-5120 UTF-8 bytes.',
      '비밀 키 값은 UTF-8 기준 1~5120바이트여야 합니다.'
    ));
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

module.exports = { createSecretCommands, secretManagementUrl };
