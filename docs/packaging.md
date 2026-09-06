# npm 패키징 기록

## 원본 조사

- `packages/cli/bin/joripspace.js`: CommonJS JavaScript CLI 본체, Node.js 18 이상, 버전 0.4.1.
- `packages/cli/lib/`: 명령 처리, 인증·작업 경로, API 어댑터, 기존 호환 모듈.
- `packages/cli/bin/installer-entry.js`: 같은 JavaScript 본체를 포함하는 네이티브 설치 진입점. PowerShell/bash 설치 스크립트와 본체 언어는 다르다.
- `scripts/build-cli-release.mjs`: `@yao-pkg/pkg`와 Node.js 22로 OS별 설치 파일 빌드.
- `scripts/publish-cli-release.mjs`, `scripts/verify-cli-native-smoke.mjs`, `docs/operations/cli-release.md`: 기존 R2 게시·검증 절차. npm 경로에 복사하거나 실행하지 않았다.
- 대상 GitHub 저장소는 `5868663`의 README만 존재했고 사용자 변경은 없었다. 독립 clone으로 관리하며 상위 `.gitignore`에 `/joripspace-cli/`를 추가했다.

## 재사용 범위와 차이

CLI `bin`, `lib`, 기존 테스트 10개 파일을 복사했다. 기존 JavaScript 구조를 유지하므로 형식 통일을 위한 TypeScript 재작성이나 컴파일러를 추가하지 않았다. npm 검증 스크립트도 기존 Node.js 테스트 방식에 맞췄다.

비공개 workspace 의존성은 패키지 내부 `vendor`로 한정해 옮겼다. `core/onboarding.cjs` 및 그 두 의존 파일은 기존 고객 안내·이전 호환·고객 GitHub workflow 문자열 생성 코드다. Control API/Dispatch 구현, DB, 플랫폼 비밀 설정은 포함하지 않았다. `templates/index.js`와 기본 템플릿 두 개의 manifest/Worker 예제를 보존했다. 원본 해시는 `source-inventory.json`에 기록한다.

내부 require 경로 두 곳과 Node 실행에 맞춘 `start` 후속 명령 문자열을 수정했다. 후속 GitHub OS 검증에서 발견한 이전 설정 이동 오류는 실제 경로를 기준으로 프로젝트 루트를 비교하도록 보완했다. 명령·옵션·API·토큰 검증·설정 저장·JSON 키·종료 코드는 유지한다. Windows에서도 후속 명령을 실행할 수 있도록 기존 문자열에 Node 실행 경로를 추가했다.

`bin/installer-entry.js`와 설치 관련 호환 모듈의 원본은 저장소에 남겼다. npm의 실행 이름은 `joripspace` 하나이며 네이티브 설치 진입점은 npm에 공개하지 않는다. 기존 네이티브 설치 파일과 플랫폼 원본 CLI는 삭제하거나 변경하지 않았다. 기존 MCP 관련 모듈·테스트는 보존했으며 새 등록 기능이나 플러그인은 만들지 않았다.

버전은 원본 0.4.1, Node 최소 조건은 기존 `>=18`을 유지한다. 최소 버전의 EOL 여부와 별개로 신규 사용자에게는 지원 중인 LTS 사용을 안내한다. 일반 실행에 외부 컴파일러는 필요하지 않으며 Git 관련 기존 기능에는 Git이 필요하다. `prepack`은 검사만 하고 `postinstall`·`prepare`는 없다.

## 최초 공개 전에 할 일

1. 원본에 없는 배포 라이선스를 소유자가 결정한다. 현재 `license`와 LICENSE 파일은 임의로 추가하지 않았다.
2. npm `@joripspace` 조직 및 `@joripspace/cli` 게시 권한, 0.4.1 버전 사용 가능 여부를 확인한다. 로그인·게시·버전 선점은 이번에 하지 않았다.
3. 변경을 검토하고 별도 승인된 절차로 GitHub에 올린 뒤 OS/Node CI 행렬을 실행한다. workflow는 검증 전용이며 publish, release, artifact upload, npm 캐시 저장 작업이 없다.
4. `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run test:package`로 최종 tarball을 검토한 후 별도 승인된 담당자가 공개한다.

최초 준비 단계에서는 npm publish, GitHub push, release 생성, 운영 플랫폼 배포를 실행하지 않았다. 이후 사용자가 npm 게시와 필요한 GitHub 반영을 승인했다. GitHub 유료 저장공간을 사용하지 않도록 Actions artifact 업로드·의존성 캐시·GitHub Packages 게시를 사용하지 않는다. 테스트 tarball은 러너의 임시 디스크에서만 사용한다.
