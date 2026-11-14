# GitHub 공유 및 로컬 자료 보관

이 저장소는 공개 저장소다. 소스 코드, 의존성 잠금 파일, 테스트, 연구 기준과 실행 안내를 공유한다. 팀원끼리만 공유할 자료도 공개 저장소에 넣지 않는다.

| 자료 | 보관 위치·공유 방식 | GitHub |
| --- | --- | --- |
| 운영 사이트·알고리즘·계산 코드 | `site/`, `algorithms/`, `metrics/` | 공유 |
| 연구·협업 문서 | 루트 Markdown, `docs/` | 공유 |
| 음원 경로 정의 | `data/metadata/dataset.json`, 사이트용 메타데이터 | 공유 |
| API 키·계정·환경 설정 | `.env*`, `.dev.vars*`, `.aws/`, `.ssh/` 등 | 제외 |
| 배포 프로젝트 연결 정보 | `site/.openai/hosting.json` 등 `.openai/` | 제외, 로컬 원본 유지 |
| 원음·소음·혼합 음원 | `data/clean/`, `data/noise/`, `data/mixed/` | 제외 |
| 알고리즘 출력·계산 결과 | `outputs/`, `metrics/results/` | 제외 |
| 사이트에 복사된 음원·계산 결과 | `site/public/research-audio/`, `site/public/metrics/results/` | 제외 |
| 참가자 자료·종이 평가·원응답 | `evaluations/` | 제외 |
| 개인 메모·비공개 중요문서 | `private/`, `docs/private/`, `docs/personal/`, `*.local.md`, `*.private.md` | 제외 |
| Word·Excel·PPT·PDF 원본 | 로컬 보관, 필요시 `private/`로 정리 | 확장자로 제외 |
| DB·응답 내보내기·백업 | `backups/`, `exports/`, DB 파일 | 제외 |
| 도구·가상환경·캐시·빌드 | `.tools/`, `.venv/`, `.cache/`, `node_modules/`, `site/dist/` | 제외 |

원본 파일을 지우거나 이름을 바꾸지 않는다. 필요한 원본 자료는 팀이 정한 비공개 전달 경로로 제공하고, 받은 팀원은 같은 상대경로에 배치한다. 음원 버전은 ID·SHA-256·계산 설정으로 맞춘다. 실제 평가 자료를 테스트 fixture로 복사하지 않는다. 익명 참가자 ID와 회차 진행 링크도 공개 문서·이슈·PR에 적지 않는다.

`.gitignore`는 새 파일의 자동 추가를 막는다. 이미 추적된 파일과 `git add -f`로 강제 추가한 파일은 별도 확인이 필요하다. [업로드 검사](../scripts/check_git_upload.py)는 전체 스테이징 내용에서 제외 파일, 알려진 비밀정보 패턴, 10 MiB 초과 파일을 검사하며 비밀 값은 출력하지 않는다. 임의 이름의 모든 문서·비밀을 판별하지는 못하므로 개인 자료는 지정된 제외 폴더에 보관한다.

```powershell
git add .
.\.venv\Scripts\python.exe scripts\check_git_upload.py
git diff --cached --stat
git diff --cached
```

코드를 받는 PC마다 `git config core.hooksPath .githooks`를 한 번 실행하면 커밋 전 검사가 자동 실행된다. 공개된 비밀을 발견하면 먼저 해당 키를 폐기·재발급하고 저장소 이력 처리도 확인한다.

Git 제외와 운영 배포는 별개다. 기존 빌드는 로컬 WAV와 지표를 사이트 배포 파일에 포함한다. 이 설정은 GitHub 업로드 범위만 제한하며 운영 사이트의 공개 범위는 바꾸지 않는다.
