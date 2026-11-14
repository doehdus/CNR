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

Node.js 배포본과 Python 기반 런타임을 위 경로에 준비한 뒤 프로젝트 루트에서 실행한다. 기존 `.venv/`는 다시 만들 필요가 없다.

```powershell
$env:PATH = (Join-Path $PWD '.tools\node-v22.23.4-win-x64') + [IO.Path]::PathSeparator + $env:PATH
$env:npm_config_cache = Join-Path $PWD '.cache\npm'
$env:PIP_CACHE_DIR = Join-Path $PWD '.cache\pip'

# 가상환경이 없는 새 PC에서만 실행
& .\.tools\python\cpython-3.12.16-windows-x86_64-none\python.exe -m venv .venv

& .\.venv\Scripts\python.exe -m pip install --require-hashes -r metrics\requirements.txt
& .\.tools\node-v22.23.4-win-x64\node.exe .\.tools\node-v22.23.4-win-x64\node_modules\npm\bin\npm-cli.js ci --prefix site
```

Python 런타임이 `venv`·`pip`를 포함해야 한다. 도구 다운로드와 패키지 설치에는 네트워크가 필요하다. 데이터 없이도 단위 테스트와 타입 검사를 할 수 있다. 전체 연구 빌드는 별도 전달받은 원음·소음·혼합 음원·SS 출력을 [정해진 경로](site/README.md#로컬-음원-경로)에 먼저 배치한다.

## 검증과 빌드

프로젝트 루트에서 실행한다. Node.js를 개별 실행할 때도 위 PATH와 캐시 설정을 사용한다.

```powershell
# 실제 연구 음원이 없어도 가능한 코드 검사
& .\.venv\Scripts\python.exe -m unittest discover -s metrics/tests -v
& .\.tools\node-v22.23.4-win-x64\node.exe .\.tools\node-v22.23.4-win-x64\node_modules\npm\bin\npm-cli.js test --prefix site
& .\.tools\node-v22.23.4-win-x64\node.exe site\node_modules\typescript\bin\tsc --noEmit --project site\tsconfig.json

# 실제 연구 음원을 받은 뒤 전체 지표 계산·검증·사이트 빌드
.\build-site.cmd
```

`build-site.cmd`는 무처리·초기 고정형 SS 72개의 STOI·ESTOI를 계산하고, 결과 복사 → 사이트 테스트 → 타입 검사 → 음원 수집·사이트 빌드를 수행한다. 결과는 `site/dist/`에 생성된다. WAV가 없으면 전체 계산이 실패하므로 저장소를 받은 직후에는 코드 검사부터 진행한다. 테스트는 임시 신호·임시 DB를 사용하며 운영 응답을 필요로 하지 않는다.

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

DB 스키마 변경에는 `site/drizzle/` 마이그레이션을 포함한다. 패키지 변경에는 `site/package-lock.json`을 함께 반영한다. 실험 기준이 바뀌면 `PROJECT_CONTEXT.md`와 해당 프로토콜을 갱신한다. 아직 구현되지 않은 알고리즘이나 준비되지 않은 음원을 완료로 표시하지 않는다.

## 운영 자료와 배포

계정·키·원음·응답·JSON 백업은 [파일 공유 기준](docs/repository-policy.md)에 따라 별도로 전달한다. `site/.openai/hosting.json`은 로컬에서 보관하며 기존 `project_id`를 유지한다. 새 팀원은 운영 배포 권한과 해당 파일을 담당자에게 받아 사용하고, 새 프로젝트 ID로 덮어쓰지 않는다. Git push는 운영 배포를 실행하지 않는다.
