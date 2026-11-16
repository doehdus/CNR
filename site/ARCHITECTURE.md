# 사이트 코드 구조

운영 소스와 패키지 설치 위치는 `site/`로 유지한다. 프론트엔드와 백엔드는 책임과 검사 단위를 분리하고, 같은 출처의 Cloudflare Worker로 배포한다.

현재 연구 화면은 `frontend/public/website/`의 HTML·CSS·JS가 담당한다. `frontend/app/`는 연구 화면으로 연결하는 역할이다. 사용하지 않는 UI 템플릿·D1 예제는 포함하지 않으며, QR 라이브러리는 `prepare-survey.mjs`가 설치된 패키지에서 생성 자산으로 복사한다.

```text
site/
├─ frontend/                 화면과 사용자 상호작용
│  ├─ app/                   Vinext 레이아웃·루트 페이지
│  ├─ public/website/        연구 화면·QR 화면의 HTML, CSS, JS 원본
│  ├─ handler.ts             /website 경로 처리
│  └─ tsconfig.json          화면 타입 검사
├─ backend/                  서버 전용 코드
│  ├─ api/research.ts        API 진입·음원 목록·업로드·부분 재생
│  ├─ surveys/               QR 회차·참가·진행·서버 채점·백업
│  ├─ study/store.ts         연구 상태 저장과 버전 충돌 제어
│  ├─ db/                    D1 스키마
│  ├─ migrations/            순서가 고정된 D1 마이그레이션
│  ├─ integrations/          Sites 요청별 연동 컨텍스트
│  └─ tsconfig.json          서버 타입 검사
├─ shared/research/          음원 정의·검증·지표·집계·상관분석
├─ tests/
│  ├─ frontend/              화면 경로
│  ├─ backend/               API·SQLite·QR·동시성
│  ├─ shared/                공용 연구 계산
│  ├─ integration/           결과 전달·음원 준비·배포 자산·의존 경계
│  └─ helpers/               SQLite와 파일 목록 테스트 도우미
├─ scripts/                  준비·빌드·환경·구조 검사 도구
├─ public/                   음원·지표·메타데이터 배포 스냅샷
├─ .sites-runtime/           생성 전용: public/ 정적 자산, backend/ JSON 입력
├─ worker.ts                 요청 조합: API → 화면 → 프레임워크
├─ dist/                     최종 Worker와 클라이언트 빌드
└─ package.json              공통 의존성과 영역별 실행 명령
```

## 의존 방향

`frontend → shared`, `backend → shared`만 허용한다. 두 영역의 연결은 `worker.ts`와 HTTP `/api/` 계약이 담당한다. 서버 코드가 화면 코드를 가져오거나 화면 코드가 서버 코드를 가져오지 않도록 `scripts/check-architecture.mjs`와 통합 테스트로 검사한다.

`shared/research/`는 DOM·React·Vinext·Cloudflare 저장소에 의존하지 않는 연구 계산만 담는다. 다운로드·화면 표시·브라우저 요청은 `frontend/`에서, 질문표의 정답·토큰·채점·저장·수정 충돌 처리는 `backend/`에서 관리한다. 공용 모듈을 추가할 때는 브라우저 공개 여부를 검토하고, 공개가 필요한 모듈만 `prepare-frontend.mjs`의 목록에 넣는다.

## 생성물과 실행

HTML·CSS·브라우저 JS는 `frontend/public/website/`에서 수정한다. 준비 도구가 화면과 공개 공용 모듈, 연구 스냅샷을 `.sites-runtime/public/`에 조합한다. 백엔드는 `.sites-runtime/backend/`의 별도 JSON 스냅샷을 읽는다. `.sites-runtime/`와 `dist/`는 생성물이므로 직접 수정하거나 GitHub에 올리지 않는다.

STOI·ESTOI 계산 코드는 상위 `metrics/`, 완료 결과 데이터는 상위 `results/metrics/`에 둔다. 원본 WAV는 `data/`·`outputs/`에서 관리한다. 웹사이트는 계산 코드에 의존하지 않고 `import-metric-results.mjs`를 통해 완료 JSON만 전달받는다. 원본이 없는 배포 소스에서는 `public/`의 준비된 스냅샷을 사용한다. 코드 검사 시 음원·지표가 없으면 빈 스냅샷으로 준비하며, 실제 측정값을 만들어 표시하지 않는다.

`calculate-metrics.cmd`는 Python 계산과 결과 JSON·CSV 저장만 수행한다. `build-site.cmd`는 결과 파일 검증·반영 → 사이트 테스트 → 타입 검사 → 자산 준비 → 통합 빌드를 수행하며 Python을 실행하지 않는다. Python과 웹을 연결하는 연구 검증은 상위 `metrics/tests/website-bridge.test.mjs`로 분리한다. 개별 검사는 [사이트 README](README.md#개발자-검증)의 명령을 따른다. 실행 파일은 프로젝트 내부 도구를 사용하고 의존성은 `site/node_modules/`에만 설치한다.

## 지표 데이터와 DB

```text
독립 Python 계산기 → results/metrics/의 JSON·CSV
                  → JSON 검증·반영 → 정적 배포 데이터 → 홈페이지 표·그래프

QR 회차·참가·청음 응답·설정 → API → D1
```

자동 계산 지표의 전달·표시에는 DB가 필요하지 않다. 홈페이지가 읽는 JSON은 정적 파일이고, 배포 음원 목록·재생도 D1 없이 동작한다. D1은 공유·갱신되는 웹 입력 저장과 기존 수동 지표 가져오기 호환을 위해 유지한다. 완료 결과 JSON의 전체 계산 출처는 전달 단계에서 보존한다.

DB 변경은 `backend/db/schema.ts`와 `backend/migrations/`에서 관리한다. 기존 마이그레이션 순서와 `.openai/hosting.json`의 프로젝트·DB·R2 연결은 유지한다.
