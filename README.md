# JoripSpace CLI

기존 CLI 0.4.1을 재사용한 Node.js 공통 패키지입니다. npm 레지스트리에 등록된 버전은 다음 명령으로 실행합니다.

```sh
npx -y @joripspace/cli@latest --help
npx -y @joripspace/cli@latest templates --json
npx -y @joripspace/cli@latest realtime-v2 docs --json
```

Windows/macOS/Linux에서 Node.js와 npm이 필요합니다. 기존 최소 조건인 Node.js 18 이상을 유지하며, 신규 설치에는 지원 중인 LTS 버전을 권장합니다. TypeScript 컴파일러나 네이티브 빌드 도구는 필요하지 않습니다. OS별 실행 파일을 내려받는 래퍼가 아니며, 설치 시 빌드·로그인·브라우저 실행·설정 변경을 하지 않습니다.

## 연결과 사용

사용자 프로젝트 폴더에서 실행하세요. 공백·한글이 있는 경로는 따옴표로 감쌉니다.

```sh
npx -y @joripspace/cli@latest login
npx -y @joripspace/cli@latest login --code "복사한_연결_코드" --cwd "내 프로젝트"
npx -y @joripspace/cli@latest start my-app --cwd "내 프로젝트" --json
npx -y @joripspace/cli@latest get --cwd "내 프로젝트" --json
```

`login`이 안내하는 https://joripspace.com/connect/ 에서 사용자가 연결을 승인하고 5분 일회용 코드를 복사합니다. `login --code`는 기존 방식대로 지정 프로젝트의 Git 제외 파일 `.env.joripspace`에 연결 토큰과 API 주소를 저장합니다. 일반 `.env`는 인증에 사용하지 않습니다. 같은 프로젝트에서는 다음 npx 실행도 기존 인증을 재사용합니다. 설정·인증·프로젝트 상태를 npm 캐시나 패키지 내부에 저장하지 않습니다.

`--cwd`가 없으면 실행한 현재 작업 폴더를 기준으로 상위 폴더의 프로젝트 연결을 찾습니다. `.joripspace/project`의 slug, `--project` 별칭, 환경변수 및 이전 인증 형식의 검증·이전 규칙을 유지합니다. 기본 API는 https://api.joripspace.com 이며 기존 `--api-url`과 `JORIPSPACE_API_URL`을 사용할 수 있습니다.

`start`는 기존 프로젝트를 연결·재개하는 명령입니다. 프로젝트를 새로 만들지 않으며 기존 동작에 따라 프로젝트 안내 파일을 관리하고 필요한 소스를 동기화합니다. 이번 npm 패키징에서 새로운 에이전트 탐지, MCP 등록, Plugin, Skill, Hook을 추가하지 않았습니다. 기존 구현과 호환 모듈은 보존했습니다.

## 선택적 전역 설치

다음 방식도 사용할 수 있습니다. 기본 안내는 npx이며 전역 설치나 영구 PATH 변경은 필수가 아닙니다.

```sh
npm install -g @joripspace/cli
joripspace --help
```

## 기존 명령과 의존성

정확한 명령·옵션은 `--help`, `deploy --help`, `deploy-template --help`, `install-template --help`로 확인합니다. 인증·프로젝트 조회·배포·템플릿·저장본·DB·스토리지·실시간 v2·Secret·Cron·도메인·메일·사용량·이벤트 등의 기존 구현을 사용합니다. 기존 웹 전용 작업은 동일하게 거부합니다. `--json`은 성공 결과를 stdout, 오류를 stderr로 출력하며 기존 종료 코드 0/1/2를 보존합니다.

CLI 설치와 일반 API 명령에는 Node.js/npm만 필요합니다. 기존 GitHub 소스 연결·Git 이력 동기화 기능에는 Git이 필요합니다. 대화형 `start`의 브라우저 열기는 Windows `cmd.exe`, macOS `open`, Linux `xdg-open`을 사용하며 브라우저를 열 수 없어도 출력된 URL로 직접 연결할 수 있습니다. 템플릿의 고객 Worker 예제는 기존 공개 템플릿이며 플랫폼 서버 구현은 포함하지 않습니다.

`start` 응답의 `executable`은 JS 진입점의 절대 경로입니다. 직접 실행할 때는 `node "진입점 경로" ...`를 사용하거나 위 npx 명령을 사용하세요. 응답의 `login_command`, `resume_command`, `install_command`에는 Node 실행 경로를 포함했습니다. Windows PowerShell에서 따옴표로 감싼 실행 경로를 직접 입력할 때는 앞에 호출 연산자 `&`가 필요합니다. JSON의 구조나 키는 변경하지 않았습니다.

## 개발 및 공개 전 패키지 검증

상위 플랫폼 저장소 없이 단독으로 동작합니다. 기존 JavaScript를 재사용하므로 컴파일 단계가 없습니다. `prepack`은 메타데이터·JS 구문·shebang·실행 권한을 확인하며 설치 시 실행되는 수명주기 스크립트는 없습니다.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:package
```

`test:package`는 실제 `npm pack` 결과를 `.artifacts/`에 만들고 파일 내용·해시·실행 권한을 확인합니다. 저장소 밖의 공백·한글 임시 경로에서 설치, npx, npm exec, 인자·출력·종료 코드 비교, 로컬 모의 API 인증 재사용, 작업 폴더 유지, 취소를 검사합니다. 운영 API나 실제 사용자 설정은 수정하지 않습니다. 원본과 비교하려면 테스트 프로세스에 `JORIPSPACE_BASELINE_CLI`로 원본 `bin/joripspace.js` 경로를 전달합니다. 없으면 독립 저장소 소스를 기준으로 비교합니다.

공개 전에는 생성된 tarball의 **절대 경로**로 실행할 수 있습니다.

```sh
npm exec --yes --package="/absolute/path/joripspace-cli-0.4.1.tgz" -- joripspace --help
```

Windows에서는 해당 위치를 `C:/.../joripspace-cli-0.4.1.tgz`로 바꿉니다. 실제 결과와 OS별 미검증 범위는 [검증 기록](docs/verification.md), 원본·변경 범위와 최초 공개 조건은 [패키징 기록](docs/packaging.md)에 정리합니다.

라이선스는 원본과 대상 저장소에서 확인되지 않아 임의로 지정하지 않았습니다.

설정 참고: [npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/), [npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec/), [Node.js 지원 버전](https://nodejs.org/en/about/previous-releases).
