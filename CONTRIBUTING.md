# 협업 안내

## 처음 시작하기

```powershell
git clone https://github.com/doehdus/CNR.git C:\ConstructionNoiseReduction
Set-Location C:\ConstructionNoiseReduction
git config core.hooksPath .githooks
```

소스에 도구·음원·실측 결과·운영 계정은 포함하지 않는다. 프로젝트 내부에 다음 도구를 별도로 준비한다. 다른 프로젝트의 실행 파일·패키지·설정을 가져와 실행하지 않는다.

| 항목 | 위치 |
| --- | --- |
| Node.js 22.23.4 Windows x64와 포함된 npm | `.tools/node-v22.23.4-win-x64/` |
| Python 3.12 기반 실행 파일 | `.tools/python/cpython-3.12.16-windows-x86_64-none/python.exe` |
| 프로젝트 Python 가상환경 | `.venv/Scripts/python.exe` |
| 사이트 의존성 | `site/node_modules/` |
| npm·pip 등 캐시 | `.cache/` |

홈페이지 작업은 Node.js·npm을 준비하고, 독립 지표 계산이나 Python 검증이 필요할 때 Python 기반 런타임도 준비한다. 아래 명령은 프로젝트 루트에서 실행한다. 기존 `.venv/`는 다시 만들 필요가 없다.

```powershell
$env:PATH = (Join-Path $PWD '.tools\node-v22.23.4-win-x64') + [IO.Path]::PathSeparator + $env:PATH
$env:npm_config_cache = Join-Path $PWD '.cache\npm'
$env:PIP_CACHE_DIR = Join-Path $PWD '.cache\pip'

# 가상환경이 없는 새 PC에서만 실행
& .\.tools\python\cpython-3.12.16-windows-x86_64-none\python.exe -m venv .venv

& .\.venv\Scripts\python.exe -m pip install --require-hashes -r metrics\requirements.txt
& .\.tools\node-v22.23.4-win-x64\node.exe .\.tools\node-v22.23.4-win-x64\node_modules\npm\bin\npm-cli.js ci --prefix site
```

Python 런타임이 `venv`·`pip`를 포함해야 한다. 도구 다운로드와 패키지 설치에는 네트워크가 필요하다. 사이트 단위 테스트는 원본 WAV와 Python 없이 실행할 수 있다. 통합 타입 검사·미리보기·배포에는 담당자에게 받은 기존 `site/.openai/hosting.json`도 준비한다. 전체 연구 재생 검증은 별도 전달받은 원음·소음·혼합 음원·SS 출력을 [정해진 경로](site/README.md#로컬-음원-경로)에 먼저 배치한다.

## 검증과 빌드

프로젝트 루트에서 실행한다. Node.js를 개별 실행할 때도 위 PATH와 캐시 설정을 사용한다.

```powershell
# 실제 연구 음원이 없어도 가능한 코드 검사
& .\.venv\Scripts\python.exe -m unittest discover -s metrics/tests -v
& .\.tools\node-v22.23.4-win-x64\node.exe .\.tools\node-v22.23.4-win-x64\node_modules\npm\bin\npm-cli.js test --prefix site
& .\.tools\node-v22.23.4-win-x64\node.exe site\node_modules\typescript\bin\tsc --noEmit --project site\tsconfig.json

# 계산 담당: 실제 연구 음원을 받은 뒤 별도 계산
.\calculate-metrics.cmd

# 홈페이지 담당: 완료 결과 반영·검증·사이트 빌드
.\build-site.cmd
```

`calculate-metrics.cmd`는 기본 72개 지표를 `results/metrics/`의 JSON·CSV로 저장한다. `build-site.cmd`는 완료 JSON 검증·반영 → 사이트 테스트 → 타입 검사 → 음원 수집·사이트 빌드를 수행한다. 결과는 `site/dist/`이며 운영 배포는 기존 Sites 프로젝트에서 별도로 수행한다. 홈페이지 빌드·테스트는 Python에 의존하지 않는다. 원본 WAV가 없는 계산 환경에서는 계산을 진행할 수 없지만 완료 JSON을 전달받아 홈페이지에 반영할 수 있다. 재생할 WAV는 별도 준비한다. 사이트 테스트는 임시 자료·임시 DB를 사용한다.

Python→결과 파일→홈페이지 연결 검사는 계산 도구 쪽에 두며 프로젝트 루트에서 실행한다.

```powershell
& .\.tools\node-v22.23.4-win-x64\node.exe --test metrics\tests\website-bridge.test.mjs
```

## 변경 공유

1. `git pull --ff-only`로 최신 상태를 받는다.
2. `git switch -c feature/작업명` 또는 `fix/작업명`으로 작업 브랜치를 만든다.
3. 코드와 관련 문서를 함께 수정하고 해당 검사를 실행한다.
4. `git add .` 후 아래 검사와 변경 내용을 확인한다.
5. 커밋하고 작업 브랜치를 push한 뒤 `main` 대상으로 PR을 열어 팀원이 검토한다.

```powershell
.\.venv\Scripts\python.exe scripts\check_git_upload.py
git diff --cached --stat
git diff --cached
```

화면은 `site/frontend/`, API·저장·서버 채점은 `site/backend/`, 공용 연구 로직은 `site/shared/research/`에서 수정한다. 폴더별 책임과 의존 방향은 [사이트 구조](site/ARCHITECTURE.md)를 따른다. `site/.sites-runtime/`는 생성 결과다. DB 스키마 변경에는 `site/backend/migrations/` 마이그레이션을 포함한다. 패키지 변경에는 `site/package-lock.json`을 함께 반영한다. 실험 기준이 바뀌면 `PROJECT_CONTEXT.md`와 해당 프로토콜을 갱신한다. 아직 구현되지 않은 알고리즘이나 준비되지 않은 음원을 완료로 표시하지 않는다.

## 운영 자료와 배포

계정·키·원음·응답·JSON 백업은 [파일 공유 기준](docs/repository-policy.md)에 따라 별도로 전달한다. `site/.openai/hosting.json`은 로컬에서 보관하며 기존 `project_id`를 유지한다. 새 팀원은 운영 배포 권한과 해당 파일을 담당자에게 받아 사용하고, 새 프로젝트 ID로 덮어쓰지 않는다. Git push는 운영 배포를 실행하지 않는다.
