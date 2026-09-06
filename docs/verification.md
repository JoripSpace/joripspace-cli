# 실행 검증 기록

## 0.5.0 공통 에이전트 온보딩 및 운영 반영

2026-09-06, CLI 커밋 `8f4d256`의 [CI 34034170245](https://github.com/JoripSpace/joripspace-cli/actions/runs/34034170245)이 Windows/macOS/Linux × Node.js 18/20/22/24 **12개 조합 모두 성공**했다. 각 조합에서 99개 검사와 실제 tarball 설치 검사를 통과했다. CLI 응답·생성 AGENTS.md·공개 온보딩 문서는 같은 원본 안내를 사용한다. 사용자 문서 보존·반복 실행·인증 전 안내·프로젝트 충돌·기존 템플릿 흐름·공백/한글/셸 특수문자 경로에서 인자 배열 실행을 확인했다.

`@joripspace/cli@0.5.0`을 npm 공개 `latest`로 게시했다. 실제 게시 파일은 **123,902 bytes / 29개 파일**, SHA-256 `6e13f21dff81e2f95801f40b202cd3136e7bab8d85c3ef010f2d3271e183d48c`이며 공개 레지스트리 다운로드와 로컬 검증 tarball이 바이트 단위로 일치한다. 인증 없는 외부 임시 디렉터리의 설치·npx 실행·6개 안전한 명령 비교를 통과했다. 로컬 전역 설치도 0.5.0으로 갱신했다. 실제 설치본의 인증 필요 응답에서 inline 안내와 절대경로 실행 객체를 확인하고 그 객체로 help를 실행했다. 해당 검사는 종료 코드 2를 유지하고 작업 폴더에 파일을 쓰지 않았다.

상위 플랫폼 커밋 `adc8d903`을 반영했다. Control API 배포 버전은 `6d0d39ed-7726-41ba-91c9-3ddf9fa0fde7`이며 공개 `/onboarding.md`의 HTTP 200·npm 안내·실행 객체 설명을 확인했다. 정식 `npm run deploy:landing`에서 Preview `https://441bbcdd.joripspace.pages.dev`의 Functions 컴파일·업로드·핵심 JS 검사를 통과한 뒤 운영 `https://7fb2b9be.joripspace.pages.dev`의 루트·동적 프로젝트 경로 HTTP 200을 확인했다. 실제 로그인된 운영 프로젝트 시작하기 탭에서 해당 프로젝트명, npm 설치 및 start 명령, 복사 대상의 일치, 14px 글자와 줄바꿈·가로 넘침 없음을 확인했다.

관련 Control API 타입 검사·온보딩 계약·기존 CLI smoke·인증/환경 파일 검사·Pages 릴리스 검사 24개·설치 스크립트 7개 시나리오·최소 글자 크기 검사를 통과했다. 전체 저장소 검사에는 기존 메일 README 마커 누락 3건과 기존 파일 크기 한도 초과 4건이 남아 있다. 해당 무관한 계약이나 한도를 완화하지 않았다. CLI의 실제 운영 API 로그인·고객 프로젝트 제작 및 배포는 수행하지 않았고, 여러 에이전트 제품 각각의 실제 대화 및 모바일 브라우저 검증을 완료한 것으로 표시하지 않는다. 플러그인이나 스킬 자동 등록 없이 inline 안내로 진행하도록 구현했다.

GitHub Actions artifact·캐시는 각각 0개이고 GitHub Packages를 사용하지 않았다. 로컬 로그는 `.artifacts/onboarding-tests.log`, `.artifacts/onboarding-package.log`, `.artifacts/registry-verification.json`에 있다.

## npm 공개 및 영문 소개 반영 완료

2026-09-06에 `@joripspace/cli@0.4.1`을 최초 게시한 뒤, README와 패키지 설명을 영문으로 정리한 **0.4.2**를 공개 `latest`로 게시했다. GitHub 소개와 홈페이지에도 사용자 제공 문구를 반영했다. 런타임 코드는 변경하지 않았다.

0.4.2에서 로컬 기존 검사 **98개**와 실제 tarball 패키지 검사를 다시 통과했다. 공개 레지스트리에서 인증 없이 별도의 공백·한글 임시 경로에 설치하고, 6개 안전한 명령의 stdout·stderr·종료 코드를 소스와 비교했다. `npx -y @joripspace/cli@latest --version`은 `0.4.2`를 반환했다. 다운로드한 tarball은 검증한 로컬 파일과 바이트 단위로 같았고, SHA-256은 `e3b9f97103cdb05e2976d6c115a9b1456ca4e6651c81ec8be63bd92b349fa3ee`이다. 영문 README·지원 이메일·MIT·기존 제3자 고지 포함을 확인했다.

이 PC의 사용자 npm 전역 경로에도 실제 레지스트리에서 설치했으며 `joripspace --version`이 `0.4.2`를 반환했다. 검증 환경은 Windows x64 / Node.js 24.18.0 / npm 11.16.0이다. 0.4.2의 실제 레지스트리 설치는 Windows에서 확인했으며, macOS/Linux의 실행 근거는 아래 동일 런타임 코드의 12개 CI 조합이다. npm 게시 인증을 CLI의 운영 API 연결 검증으로 표시하지 않는다.

결과는 `.artifacts/english-tests.log`, `.artifacts/english-package-test.log`, `.artifacts/registry-verification.json`에 기록했다. GitHub Actions artifact·캐시는 각각 0개이며 GitHub Packages를 사용하지 않았다.

## 후속 MIT 적용과 OS별 실제 검증

사용자가 npm 게시·필요한 GitHub 반영·MIT 적용을 승인했다. 최종 코드 `fbbdb03`의 [GitHub 검사 34029633896](https://github.com/JoripSpace/joripspace-cli/actions/runs/34029633896)은 **Windows/macOS/Linux × Node.js 18/20/22/24, 12개 조합 모두 성공**했다. 각 조합에서 기존 검사 98개와 실제 npm pack·격리 설치·npx·전역 prefix·인증 모의 API·취소 검사를 완료했다. 실제 운영 API 인증 성공을 의미하지 않는다.

첫 OS 검사에서 이전 설정 이동의 프로젝트 루트와 실제 파일 경로가 달라지는 문제를 찾아 루트도 realpath로 비교하도록 수정했다. 테스트의 경로별 장애 주입과 대소문자 파일명 검사를 실제 파일시스템에 맞췄고, Node 18의 실험적 MockTimers 대신 같은 테스트 시계를 사용했다. 경로 별칭 회귀 검사는 수정 전 실패·수정 후 성공을 로컬에서 재현했다. CLI 명령·API·출력 구조를 새로 추가하지 않았다.

MIT 적용본의 로컬 tarball은 **120,310 bytes, 28개 파일**, SHA-256 `244347fdf3cb45a63e7b326a551d40b92071dc020e85e1e66f9dde58e1fca90f`이다. `LICENSE`의 표준 MIT 전문·Cosmosfarm Software 표기, `license: MIT`, `THIRD_PARTY_NOTICES.md`의 외부 의존성 원래 고지 포함을 실제 tar 원문과 대조했다. 고지 검사는 설치된 각 의존성의 버전과 라이선스 전문까지 비교한다. 이 항목이 아래 최초 준비 단계의 tarball 크기·해시를 대체한다.

결과는 `.artifacts/license-final-tests.log`, `.artifacts/license-package-test.log`과 위 CI 로그에 있다. GitHub Actions artifact와 캐시 목록을 조회해 각각 **0개**임을 확인했다. GitHub Packages·artifact 업로드·의존성 캐시는 사용하지 않는다. 당시 대기 중이던 npm 게시 인증과 레지스트리 설치 검증은 위 후속 단계에서 완료했다.

## 최초 npm 준비 단계의 로컬 기록

2026-09-06, Windows x64 / Node.js 24.18.0 / npm 10.8.0에서 실행했다. 관리자 그룹 활성 여부는 false이며 사용자 임시 폴더·격리된 npm 캐시와 전역 prefix를 사용했다. `.artifacts/package-verification.json`은 실제 tarball의 파일 목록·SHA-256 및 격리 실행 결과이며 npm 배포에는 포함하지 않는다.

| 검사 | 실제 결과 |
| --- | --- |
| 원본 CLI `npm --workspace @joripspace/cli test` | 97개 통과 |
| 독립 저장소 `npm ci --ignore-scripts`, `npm test` | 외부 의존성 3개 설치, 97개 통과, 16.76초 |
| `npm run check` / `prepack` | 메타데이터·구문·shebang 검사 통과, 컴파일 불필요 |
| `npm run test:package` | 실제 pack, 저장소 밖 설치, npx, npm exec, 격리된 전역 설치 통과 |
| 원본과 비교 | `--help`, `--version`, `version`, `deploy --help`, `templates --json`, `realtime-v2 docs --json`, 잘못된 명령과 `start` 인자 오류의 stdout/stderr/종료 코드 일치 |
| 인증·작업 폴더 | 로컬 모의 API에서 연결 코드 교환 1회 후 인증 재사용. 현재 폴더·명시적 `--cwd`·상위 marker 검색·한글/공백/커서 인자 전달 통과 |
| 설치·설정 격리 | npm 캐시·설치 폴더에 프로젝트 인증 파일 없음. 실제 운영 API·사용자 설정 변경 없음 |
| 취소·오류 | 비대화형 stdin EOF, 오류 종료 1/2 유지, 대기 중인 모의 요청에 SIGINT 전달 후 종료 확인 |
| `npm audit --omit=dev --json` | 조회 시 알려진 취약점 0건. 잠재 취약점이 없다는 보장은 아님 |

최종 패키지 검증 시각은 `2026-09-06T10:54:26.743Z`이다. 결과 로그는 `.artifacts/final-tests.log`, `.artifacts/package-test.log`, `.artifacts/npm-audit.json`이다. 원본과의 대조에는 `JORIPSPACE_BASELINE_CLI`를 사용했으며 운영 자격증명은 주입하지 않았다.

## 배포본

`.artifacts/joripspace-cli-0.4.1.tgz`: **117,702 bytes**, SHA-256 `62442346decf1df29088e59dab046547a541ec55ae8efa3ad9592767eb048c48`.

26개 파일: `package.json`, `README.md`, `bin/joripspace.js`, `lib`의 JavaScript 15개, `vendor/core`의 CJS 3개, `vendor/templates/index.js`, 기본 템플릿 두 개의 manifest 및 Worker 파일 4개. 정확한 파일별 크기·해시는 `.artifacts/package-verification.json`에 있다.

tarball 원문을 검사해 허용 목록 밖 파일, symlink, `.env`·인증 파일, 비밀 키 표식·토큰 패턴, 로컬 저장소 절대 경로가 없음을 확인했다. `file:`·workspace 의존성과 상위 node_modules 링크를 제거하고 외부 레지스트리 URL·integrity를 갖춘 독립 lockfile로 `npm ci`를 완료했다. 패키지 내부에 전체 플랫폼 소스·DB·테스트·네이티브 바이너리·설치 진입점은 없다. 설치 시 실행되는 수명주기 스크립트도 없다.

Windows에서 생성한 tar의 진입점 권한 표시는 `0644`이며 실행은 npm의 `.cmd` shim으로 확인했다. 저장소 진입점은 Git 실행 비트를 설정하고 POSIX에서는 `prepack`이 `0755`로 설정한다. CI는 POSIX tarball과 설치된 bin의 실행 비트를 검사한다.

## 최초 준비 당시 미검증 범위

macOS/Linux 및 Node.js 18/20/22에서 직접 실행하지 않았다. 브라우저를 실제로 여는 대화형 로그인·터미널 Ctrl+C 키 입력·운영 API 연결·실제 배포는 이번 범위에서 실행하지 않았다. 기존 API 동작은 로컬 모의 서버 계약 검사로 확인했다. SIGINT 프로세스 검사를 모든 터미널의 Ctrl+C 전파 검증으로 표시하지 않는다.

CI는 Windows/macOS/Linux와 Node.js 18/20/22/24 조합에서 동일한 기존 CLI 검사와 npm tarball 검사를 실행하도록 구성했다. workflow 생성과 해당 OS의 실제 성공은 구분한다. 운영 API 접속·배포나 사용자 브라우저 인증을 모의 API 검증과 혼동하지 않는다.
