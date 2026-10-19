function detectLanguage(locale) {
  try {
    const selected = locale === undefined ? Intl.DateTimeFormat().resolvedOptions().locale : locale;
    return /^ko(?:[-_]|$)/i.test(String(selected || '')) ? 'ko' : 'en';
  } catch {
    return 'en';
  }
}

const language = detectLanguage();

function message(english, korean) {
  return language === 'ko' && korean ? korean : english;
}

const NAME_POLICY_MESSAGES = {
  '조립스페이스 브랜드나 운영 주체로 오해될 수 있는 이름은 사용할 수 없습니다.':
    'This name could be mistaken for the JoripSpace brand or operator and cannot be used.',
  '서비스 운영에 쓰는 예약어라서 프로젝트 이름으로 사용할 수 없습니다.':
    'This name is reserved for service operations and cannot be used as a project name.',
  '로그인, 결제, 보안, 고객지원으로 오해될 수 있는 단어는 사칭 위험 때문에 사용할 수 없습니다.':
    'Names that could impersonate login, billing, security, or customer support cannot be used.',
  '다른 회사나 서비스 이름을 포함하면 공식 서비스처럼 보일 수 있어 사용할 수 없습니다.':
    'Names containing another company or service brand cannot be used because they could appear official.',
  '불법 또는 유해한 목적으로 오해될 수 있는 단어는 사용할 수 없습니다.':
    'Names that could imply illegal or harmful purposes cannot be used.',
  '불법, 성인, 도박, 약물, 무기 관련 단어는 사용할 수 없습니다.':
    'Names related to illegal activities, adult content, gambling, drugs, or weapons cannot be used.',
};

function projectNameMessage(original) {
  return message(NAME_POLICY_MESSAGES[original] || 'This project name is not allowed.', original);
}

module.exports = { detectLanguage, language, message, projectNameMessage };
