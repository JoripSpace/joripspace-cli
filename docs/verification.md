# 실행 검증 기록

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

## 미검증 범위

macOS/Linux 및 Node.js 18/20/22에서 직접 실행하지 않았다. 브라우저를 실제로 여는 대화형 로그인·터미널 Ctrl+C 키 입력·운영 API 연결·실제 배포는 이번 범위에서 실행하지 않았다. 기존 API 동작은 로컬 모의 서버 계약 검사로 확인했다. SIGINT 프로세스 검사를 모든 터미널의 Ctrl+C 전파 검증으로 표시하지 않는다.

CI는 Windows/macOS/Linux와 Node.js 18/20/22/24 조합에서 동일한 기존 CLI 검사와 npm tarball 검사를 실행하도록 구성했다. workflow 생성과 해당 OS의 실제 성공은 구분한다. 운영 API 접속·배포나 사용자 브라우저 인증을 모의 API 검증과 혼동하지 않는다.
