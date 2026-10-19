const { message, projectNameMessage } = require('./locale');
const readline = require('node:readline/promises');
const { PROJECT_NAME_RULES, PROJECT_CREATE_AGREEMENTS } = require('./project-create-policy');

function normalizeProjectName(value) {
  const name = String(value || '')
    .trim()
    .toLowerCase();
  if (name.length < 3 || name.length > 50 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw createError(
      'invalid_project_name',
      message(
        'Project names must contain 3-50 lowercase letters, digits, or hyphens, and start and end with a letter or digit.',
        '프로젝트 이름은 영문 소문자, 숫자, 하이픈(-)만 사용해 3-50자로 입력해주세요.'
      )
    );
  }
  const tokens = name.split('-').filter(Boolean);
  for (const rule of PROJECT_NAME_RULES) {
    if (
      rule.terms.some((term) =>
        rule.mode === 'contains'
          ? name.includes(term)
          : rule.mode === 'token'
            ? tokens.includes(term)
            : name === term
      )
    ) {
      throw createError('reserved_project_name', projectNameMessage(rule.message));
    }
  }
  return name;
}

function createProjectCommand(deps) {
  return async function createProject(flags) {
    const name = normalizeProjectName(deps.stringFlag(flags, 'name'));
    if (deps.stringFlag(flags, 'plan') && deps.stringFlag(flags, 'plan') !== 'free') {
      throw createError(
        'free_project_only',
        message('The CLI can create only Free projects.', 'CLI에서는 무료 프로젝트만 생성할 수 있습니다.')
      );
    }
    const connection = deps.resolveConnection(flags);
    if (!connection.apiToken) throw loginRequired(name);
    const auth = {
      apiToken: deps.requireApiToken(flags, connection),
      apiBaseUrl: connection.apiBaseUrl,
    };
    try {
      await deps.apiRequest(flags, '/v1/me/projects', { method: 'GET', ...auth });
    } catch (error) {
      if (error.status === 401) throw loginRequired(name);
      throw error;
    }
    const missing = PROJECT_CREATE_AGREEMENTS.filter(({ flag }) => !explicitAgreement(flags[flag]));
    if (missing.length) {
      if (flags.json || !process.stdin.isTTY || !process.stdout.isTTY) {
        const error = createError(
          'project_agreements_required',
          message(
            'Obtain explicit user consent to all three required web agreements, then run the command again.',
            '웹과 동일한 필수 동의 3개를 사용자에게 확인받은 뒤 다시 실행하세요.'
          )
        );
        error.exitCode = 2;
        error.details = {
          name,
          plan: 'free',
          terms_url: 'https://joripspace.com/terms/',
          language: 'en',
          original_language: 'ko',
          agent_instruction:
            "Translate every agreement faithfully into the user's language and ask for explicit consent. Do not infer consent from a request to create a project or set agreement flags automatically.",
          agreements: PROJECT_CREATE_AGREEMENTS.map(({ id, flag, text, text_en }) => ({
            id,
            flag,
            text: text_en,
            original_text: text,
            required: true,
            accepted: explicitAgreement(flags[flag]),
          })),
          next_action: 'show-agreements-and-ask-user; pass-each-agreement-only-after-explicit-consent',
          resume_args: [
            'create',
            '--name',
            name,
            ...PROJECT_CREATE_AGREEMENTS.map(({ flag }) => `--${flag}`),
            '--json',
          ],
        };
        throw error;
      }
      await askAgreements(missing);
    }
    let result;
    try {
      result = await deps.apiRequest(flags, '/v1/projects', {
        method: 'POST',
        ...auth,
        timeoutMs: null,
        body: { name, ...Object.fromEntries(PROJECT_CREATE_AGREEMENTS.map(({ id }) => [id, true])) },
      });
    } catch (error) {
      if (error.code === 'request_failed' || error.code === 'request_timeout' || error.status >= 500) {
        error.details = {
          ...error.details,
          name,
          next_action: 'list-projects-and-check-name-before-retrying-create',
        };
      }
      throw error;
    }
    deps.output(flags, result, (value) => {
      console.log(
        message(
          `Project created: ${value.project_slug || value.project_id}`,
          `프로젝트 생성 완료: ${value.project_slug || value.project_id}`
        )
      );
      if (value.default_url)
        console.log(message(`Project URL: ${value.default_url}`, `프로젝트 주소: ${value.default_url}`));
      console.log(
        message(
          'Run start to connect this project to a local folder.',
          '이 프로젝트를 로컬 폴더에 연결하려면 start를 실행하세요.'
        )
      );
    });
  };
}

function loginRequired(name) {
  const error = createError(
    'connection_required',
    message(
      'Run joripspace login before creating a project.',
      '프로젝트를 생성하려면 먼저 joripspace login으로 로그인하세요.'
    )
  );
  error.exitCode = 2;
  error.details = {
    connect_url: 'https://joripspace.com/connect/',
    login_args: ['login', '--json'],
    resume_args: ['create', '--name', name, '--json'],
    next_action: 'login-then-retry-create; obtain-explicit-agreement-after-login',
  };
  return error;
}

function explicitAgreement(value) {
  return value === true || value === 'true';
}

async function askAgreements(agreements) {
  console.log(
    message(
      'Required agreements for a free project. Terms: https://joripspace.com/terms/',
      '무료 프로젝트 생성에 필요한 동의입니다. 이용약관: https://joripspace.com/terms/'
    )
  );
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const cancellation = new AbortController();
  prompt.once('close', () => cancellation.abort());
  try {
    for (const { text, text_en } of agreements) {
      const answer = await prompt.question(
        `${message(text_en, text)}\n${message('Do you agree? [y/N]: ', '동의하십니까? [y/N]: ')}`,
        {
          signal: cancellation.signal,
        }
      );
      if (!['y', 'yes', '예', '네', '동의'].includes(answer.trim().toLowerCase())) {
        throw createError(
          'project_agreement_declined',
          message(
            'A required agreement was declined. No project was created.',
            '필수 항목에 동의하지 않아 프로젝트를 생성하지 않았습니다.'
          )
        );
      }
    }
  } catch (error) {
    if (error.code !== 'ABORT_ERR') throw error;
    throw createError(
      'project_agreement_cancelled',
      message(
        'Agreement entry was cancelled. No project was created.',
        '동의 입력이 취소되어 프로젝트를 생성하지 않았습니다.'
      )
    );
  } finally {
    prompt.close();
  }
}

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = { createProjectCommand, normalizeProjectName };
