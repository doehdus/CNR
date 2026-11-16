# 온라인 소음 저감 연구 보고서

운영 소스는 이 폴더다. 사용자용 시연은 배포 주소에서 진행한다.

팀원 환경 구성은 [협업 안내](../CONTRIBUTING.md), 공유·제외 범위는 [파일 공유 기준](../docs/repository-policy.md)을 따른다. GitHub에는 원본 WAV·복사된 배포 음원·실측 결과·`.openai/` 연결 정보를 포함하지 않는다. 전체 연구 빌드 전 필요한 자료를 별도로 전달받는다. 기존 로컬 `hosting.json`의 `project_id`는 유지한다.

## 사용

1. 상위 CNR 프로젝트의 data/·outputs/ 폴더에 WAV를 넣는다. 아래 경로 규칙을 따른다.
2. 프로젝트 루트의 `calculate-metrics.cmd`로 지표를 별도 계산하거나, 완료 JSON을 `results/metrics/stoi_estoi.json`으로 전달받는다.
3. `build-site.cmd`로 완료 JSON 검증·반영과 웹 빌드를 실행한다. 계산기를 호출하지 않으며 결과는 `site/dist/`에 생성된다.
4. 기존 Sites 프로젝트에 빌드 결과를 배포한다. WAV의 추가·교체·삭제와 결과 JSON은 이 배포에 반영된다. 빌드 명령만으로 운영 배포가 실행되지는 않는다.
5. 청음평가에서 QR 회차를 만들고 응답을 수집한다. 수동 입력과 응답 파일 가져오기도 이 메뉴에서 진행한다.
6. 응답 저장 후 음원별 결과와 지표·청음 비교를 확인한다.
7. 상단 보고서 인쇄/PDF 또는 CSV·JSON 내보내기로 결과를 보관한다.

자동 계산 지표는 배포된 JSON에서 읽는다. QR·수동 청음 응답, 경로 설정과 웹에서 수동으로 가져온 지표는 D1에 저장한다. 전달 규칙은 [결과 데이터 안내](../results/README.md)를 따른다. 입력 중 미리보기는 저장 전이다. JSON 복원은 서버 자료를 교체하므로 먼저 백업한다.

메뉴 순서는 **데이터파일 → SS 결과물 → STOI ESTOI → STOI ESTOI 지표 분석 → 청음평가 → 청음결과표 → 지표청음 비교**다. 설정·백업은 별도 보조 메뉴로 유지한다.

**STOI ESTOI 지표 분석**에서는 같은 소음·SNR·문장의 대응 음원으로 처리 전후 지표와 개선량을 비교한다. **청음평가**에서는 QR 진행과 수동 입력을, **청음결과표**에서는 누적 집계·원응답·CSV 내보내기를 관리한다. **지표청음 비교**에서는 이해도를 핵심정보 정답률로 측정하여 STOI·ESTOI 각각과 Spearman 순위상관을 구한다. 소음 방해·자연스러움의 5단계 평균은 보조 분석으로 비교하고, 선택 음원의 누적 결과에서 단계별 응답 분포를 확인한다. n은 대응 음원 수이며 응답자 수와 구분한다. 그래프는 보고서 인쇄에도 포함된다.

## QR 청음평가

청음평가의 **QR 회차 만들기 · 진행** 또는 `/website/survey-admin.html`에서 진행한다.

1. 연결된 평가 음원을 선택하고 회차 이름과 재생 순서를 정한다. 기본으로 순서를 섞으며, 순서 목록의 위·아래 버튼으로 직접 정할 수 있다.
2. 회차를 생성하면 참가자용 QR과 진행자 전용 링크를 발급한다. 진행 링크를 보관하면 다른 기기에서도 회차를 이어갈 수 있다.
3. 참가자는 QR을 한 번 스캔하고 평가 참가를 누른다. 익명 ID가 자동 발급되며 같은 브라우저로 다시 접속하면 이어진다.
4. 진행자는 평가 시작 후 현재 음원을 재생하고 **응답 시작**을 누른다. 참가자는 객관식 3문항과 소음 방해·자연스러움 두 항목의 5단계 평가를 제출한다. 이해도는 핵심정보 정답률로 측정한다.
5. 제출 인원을 확인하고 다음 음원을 연다. 마지막에는 회차 종료를 누른다. 화면은 2초 간격으로 동기화한다.

자동채점 기준은 `qr-mc-v1`이며 각 문항 1점, 음원당 총 3점이다. 모르겠음은 0점으로 계산한다. 미제출은 미응답으로 보관한다. 질문표·음원 순서·파일 지문은 회차 생성 시 고정한다.

기존 QR도 같은 주소에서 새 2항목 설문으로 진행할 수 있다. 2026-11-15 결정으로 기존 5단계 체감 이해도 값은 배포 시 삭제하며, 예전 백업·CSV를 복원해도 해당 필드를 다시 저장하지 않는다. 정오답·핵심정보 정답률과 소음 방해·자연스러움의 개인별 응답은 유지한다.

QR 원응답은 D1의 회차·참가자·응답 테이블에 저장한다. 청음결과표와 지표청음 비교는 QR 응답과 수동 응답을 함께 집계한다. 원응답 CSV에도 두 경로의 응답이 포함된다. JSON 전체 백업 v2는 질문표와 QR 원자료까지 보관하며, 복원은 하나의 트랜잭션으로 처리한다. 이전 v1 백업을 복원할 때는 현재 QR 자료를 보관하고 수동 자료를 복원한다.

웹 JSON 백업에는 WAV 파일 자체가 포함되지 않는다. 원본 WAV와 `results/metrics/`의 계산 원본 JSON·CSV는 별도로 보관한다. 웹 백업의 지표 행은 홈페이지 입력용으로 정규화된 값이므로 전체 계산 구간·정렬 메타데이터의 원본 보관을 대신하지 않는다.

청음결과표는 기본으로 응답이 있는 전체 처리 방식을 표시한다. 같은 소음·문장·SNR 칸에 무처리와 처리 응답을 방식별로 함께 표시하며, 특정 방식으로 좁히면 전체·표시 응답 수를 안내한다. 응답은 2초 간격과 결과 메뉴 진입·브라우저 복귀 시 확인하고 수동 새로고침도 지원한다.

**저장한 원응답** 바로 아래 **QR 회차 삭제**에서 QR 하나를 선택한다. 회차 이름·코드·음원 수·참가자 수·응답 수를 확인한 뒤 삭제한다. 해당 QR은 회차 목록에서 빠지고 참가자·진행자 링크가 사용할 수 없는 상태가 되며, 그 회차의 응답 전체를 결과표·그래프·CSV 집계에서 제외한다. 다른 QR과 수동 응답은 유지한다. 회차·참가자·원답변은 회차의 `deleted_at`과 함께 전체 JSON 백업에 보존한다. 삭제 시점에 응답이나 진행 상태가 바뀌면 요청 전체를 취소한다. 이전 v2 백업의 삭제 필드 누락도 복원할 수 있다. 개별 응답 선택 삭제 UI와 API는 제공하지 않는다.

## 로컬 음원 경로

경로는 C:\ConstructionNoiseReduction을 기준으로 한다. 문장 파일명은 instruction_01.wav, instruction_02.wav, warning_01.wav다.

| 음원 | 경로 예시 |
| --- | --- |
| 깨끗한 기준 음성 | data/clean/instruction_01.wav |
| 단일 소음 원본 | data/noise/single.wav |
| 복합 소음 원본 | data/noise/complex.wav |
| 변화 소음 원본 | data/noise/changing.wav |
| 무처리 합성 음성 | data/mixed/single/snr20/instruction_01.wav |
| 처리 결과 | outputs/ss_fixed/single/snr20/instruction_01.wav |

소음 원본의 저장 폴더는 `C:\ConstructionNoiseReduction\data\noise\`입니다. 단일·복합·변화 소음 파일명을 각각 `single.wav`, `complex.wav`, `changing.wav`로 지정해 이 폴더에 저장합니다. 저장 후 사이트를 다시 배포하면 반영됩니다.

소음 폴더는 single·complex·changing, SNR 폴더는 snr20·snr10·snr05·snr00을 사용한다. 처리 방식은 ss_fixed·ss_pattern_fixed·ss_pattern_update·additional이다. 다른 파일명은 상위 data/metadata/dataset.json의 해당 ID 경로를 변경하거나 홈페이지의 경로 JSON으로 연결한다.

배포 빌드가 RIFF/WAVE 헤더와 크기를 검사하고 SHA-256을 계산한다. 파일이 달라지면 기존 객관 지표의 입력 지문을 다시 확인한다. 배포에 포함할 음원은 파일당 25 MiB 이하여야 한다. [Cloudflare 파일 크기 제한](https://developers.cloudflare.com/workers/platform/limits/#static-assets)

## 구조

- frontend/: app/의 루트 페이지, handler.ts의 화면 경로 처리, public/website/의 HTML·CSS·브라우저 JS
- backend/: api/·surveys/·study/별 서버 기능, db/ 스키마와 migrations/ 마이그레이션
- shared/: 음원 정의·검증·집계·지표·상관분석 등 양쪽이 사용하는 연구 로직. DOM이나 서버 저장소에 의존하지 않는다.
- worker.ts: 같은 출처에서 백엔드 요청과 프론트엔드 요청을 연결하는 배포 진입점
- scripts/prepare-frontend.mjs: 화면·공개 공용 JS·연구 스냅샷을 .sites-runtime/public/에 조합한다.
- scripts/prepare-backend.mjs: 서버 입력 데이터를 .sites-runtime/backend/에 준비한다.
- scripts/import-metric-results.mjs: 외부에서 계산한 결과 JSON을 검증하고 public/metrics/results/에 반영한다.
- public/data/metadata/dataset.json: 183개 음원 ID + 소음 원본 3개의 경로
- scripts/prepare-audio.mjs: 상위 프로젝트의 로컬 WAV 검증·복사와 배포 목록 생성
- public/research-audio/: 실제 배포할 WAV와 SHA-256 목록
- .openai/hosting.json: Sites 식별자 및 DB/BUCKET 바인딩
- tests/: 집계·파일 대응·실제 SQLite 저장·업로드·완료 결과 전달 검사. Python 계산 연동 검사는 상위 metrics/tests/에 둔다.

상세 폴더 트리와 의존 규칙은 [구조 안내](ARCHITECTURE.md)를 따른다. `.sites-runtime/`와 `dist/`는 생성 결과다.

프론트엔드는 기존 `/api/` 상대 경로로 백엔드와 통신한다. 배포는 같은 Sites 프로젝트의 Worker 하나로 묶고 URL·D1·R2 연결을 유지한다. 코드와 검사 단위를 분리했으며 별도 서버 두 개를 운영하는 구조는 아니다. 질문표·정답·채점·저장 처리는 backend/에만 두고, shared/에는 브라우저에 공개해도 되는 코드만 둔다. backend/는 frontend/의 소스를 가져오지 않는다.

사이트는 Sites의 Public 공개 범위로 운영한다. 링크를 가진 누구나 로그인 없이 열람·음원 재생·응답 입력·설정 변경을 사용할 수 있다. 서버의 수정 버전 검사와 동일 출처 요청 검사를 적용한다.

## 개발자 검증

프로젝트 전용 Node.js 22.23.4와 npm은 상위 `.tools/node-v22.23.4-win-x64/`에 있다. 프로젝트 루트의 `.\build-site.cmd`는 완료된 `results/metrics/stoi_estoi.json` 검증·반영, 사이트 테스트·타입 검사와 빌드를 수행한다. 홈페이지 빌드·테스트에는 Python이 필요하지 않다. 계산은 독립 `metrics/` 도구와 `calculate-metrics.cmd`에서 수행한다. 사이트 패키지는 이 폴더의 `node_modules/`를 사용한다.

`site/`에서 프로젝트 내부 Node.js를 PATH 앞에 둔 뒤 다음 npm 스크립트를 사용할 수 있다. npm도 상위 도구 폴더의 `node_modules/npm/bin/npm-cli.js`를 프로젝트 Node.js로 실행한다.

| 명령 | 범위 |
| --- | --- |
| `npm run test:frontend` | 화면 경로 |
| `npm run test:backend` | API·SQLite·QR 진행·채점·백업·동시 제출 |
| `npm run test:shared` | 공용 집계·지표·그래프 계산 |
| `npm run test:integration` | 배포 자산·음원 준비·결과 전달·의존 경계 |
| `npm run check:architecture` | 소스 의존 방향 |
| `npm run typecheck:frontend` | 프론트엔드 TypeScript |
| `npm run typecheck:backend` | 백엔드 TypeScript |
| `npm test` / `npm run typecheck` | 통합 검사 |
| `npm run dev` / `npm run build` | 자산 준비 후 통합 개발·빌드 |

D1 스키마를 바꿀 때 npm run db:generate로 새 마이그레이션을 생성하고 Sites 배포에 포함한다. 로컬 개발 미리보기는 개발 검증에만 사용한다. 운영 DB와 미리보기 DB는 별개다.

현재 기준 음성 3개·소음 원본 3개·무처리 합성 36개·초기 고정형 SS 36개로 WAV 78개와 실제 STOI·ESTOI 72개를 배포에 포함한다. 후속 처리 음원은 추가 등록 대기다. 실제 청음 응답 수집 건수는 운영 D1에서 확인한다. 테스트 신호·테스트 응답을 운영 DB에 넣지 않는다.
