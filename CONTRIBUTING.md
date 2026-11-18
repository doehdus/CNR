# 개발·실행 안내

프로젝트 방향은 [README.md](README.md), 확정한 연구 자료는 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)를 따른다. 이 문서는 현재 실행 가능한 명령과 코드의 연결 지점을 관리한다.

## macOS 협업용 웹 실행

Node.js 22.23.4를 준비한 뒤 아래 명령으로 실행한다. Node.js 설치는 필요한 팀원이 직접 진행한다.

```bash
cd website
npm ci
npm run dev
```

`npm ci`는 처음 실행하거나 `package-lock.json`이 바뀐 경우에 사용한다. 이후에는 `git pull` 후 `npm run dev`로 실행한다. 패키지는 `npm ci`를 직접 실행할 때 설치한다.

- 주소: `http://localhost:5173/website/`, 종료: 터미널에서 `Ctrl+C`
- 검증·빌드: `website/`에서 `npm run build`
- 원음은 `experiment/data/clean/`, 소음은 `experiment/data/noise/`의 공유 파일을 읽는다.
- `experiment/outputs/noise_analysis/`의 완료된 FFT 수치·분석 이력과 `experiment/outputs/graphs/noise_analysis/`의 그래프를 함께 공유한다. 로컬 웹 준비는 계산을 반복하지 않고 완료된 그래프를 전달한다. 소음 원본이 달라지면 이전 그래프 표시를 보류한다.
- 운영 배포 정보 없이 `website/wrangler.local.json`의 로컬 DB·R2를 사용하며 상태는 `.wrangler/local-collab/`에 보관한다. 기존 `.wrangler/state/`는 보존한다.
- Node.js만으로 웹 자료를 준비한다. C/Python을 통한 FFT 재계산·객관 계산은 아래 실험 도구와 실행 절차를 따른다.

`npm run dev`는 기존 웹 실행 코드에서 공유 자료와 로컬 DB만 준비한다. 웹 빌드는 계속 내보낸 스냅샷만 사용하며 실험 원본을 읽는 개발 준비와 분리한다. Windows 작업 PC에서는 아래 프로젝트 Node.js·npm을 사용한다.

## 프로젝트 내부 도구

작업 루트는 `C:\ConstructionNoiseReduction`이다.

| 도구 | 위치 |
| --- | --- |
| Node.js·npm | `.tools/node-v22.23.4-win-x64/` |
| 기반 Python | `.tools/python/cpython-3.12.16-windows-x86_64-none/python.exe` |
| Python 가상환경 | `.venv/Scripts/python.exe` |
| C 컴파일러 | `.tools/tcc/tcc.exe` (TinyCC 0.9.27) |
| 사이트 패키지 | `website/node_modules/` |
| 캐시 | `.cache/` |

개별 Node.js 명령을 실행할 때도 아래 PATH 설정을 적용한다. 새 PC의 환경 구성은 프로젝트 루트에서 진행한다.

```powershell
$env:PATH = (Join-Path $PWD '.tools\node-v22.23.4-win-x64') + [IO.Path]::PathSeparator + $env:PATH
$env:npm_config_cache = Join-Path $PWD '.cache\npm'
$env:PIP_CACHE_DIR = Join-Path $PWD '.cache\pip'

# 가상환경이 없는 새 PC에서 생성
& .\.tools\python\cpython-3.12.16-windows-x86_64-none\python.exe -m venv .venv

# 필요한 의존성 설치
& .\.venv\Scripts\python.exe -m pip install --require-hashes -r experiment\requirements.txt
& .\.tools\node-v22.23.4-win-x64\node.exe .\.tools\node-v22.23.4-win-x64\node_modules\npm\bin\npm-cli.js ci --prefix website
```

## C 분석·수치 저장·Python 그래프

기존 소음 3종은 다음 순서로 처리한다. `run_fft.py`는 컴파일된 C 실행파일을 호출하고 원본 지문과 실행 이력을 기록한다. `plot_spectrum.py`는 저장된 CSV만 읽어 그래프를 그린다.

```powershell
# 1. C 소스 컴파일 (C 코드 수정 시 다시 실행)
New-Item -ItemType Directory -Force .cache\noise_analysis | Out-Null
& .\.tools\tcc\tcc.exe -std=c99 -Wall -Werror experiment\src\noise_analysis\noise_fft.c -o .cache\noise_analysis\noise_fft.exe

# 2. C 실행 → 소음별 전체 FFT CSV·분석 조건 JSON 저장
& .\.venv\Scripts\python.exe -m experiment.src.noise_analysis.run_fft

# 3. 저장된 수치 → 소음별 3장·비교 1장 PNG 생성
& .\.venv\Scripts\python.exe -m experiment.src.noise_analysis.plot_spectrum
```

| 구분 | 위치 |
| --- | --- |
| C 계산 소스 | `experiment/src/noise_analysis/noise_fft.c` |
| 컴파일된 실행파일 | `.cache/noise_analysis/noise_fft.exe` |
| 실행 결과 | `experiment/outputs/noise_analysis/<실행ID>/<소음>/spectrum.csv`·`metadata.json` |
| Python 그래프 소스 | `experiment/src/noise_analysis/plot_spectrum.py` |
| 생성된 그래프 | `experiment/outputs/graphs/noise_analysis/<실행ID>/*.png` |

`latest.json`은 마지막 C 실행 회차를 가리킨다. 이전 회차의 수치·그래프는 보존한다. 그래프 생성이 끝나면 분석용 `results.json`을 갱신하고, 아래 exporter 명령으로 홈페이지에 전달한다. 웹 빌드는 C·Python을 실행하지 않는다. 전체 FFT의 한쪽 스펙트럼을 창 이득 보정한 dBFS로 표시하며 CSV에는 진폭과 전력밀도도 저장한다. 창·피크 검출의 확정 상태는 PROJECT_CONTEXT를 따른다.

기존 웹 WAV·지표를 유지하고 소음 분석만 갱신할 때는 `& .\.venv\Scripts\python.exe export\export_results.py --noise-analysis-only`를 실행한다. 이 명령도 기존 스냅샷의 WAV·지표·소음 입력 지문을 검증한다.

## 계산·전달·웹 빌드

실험 자료 페이지의 새 원음은 `experiment/config/collection.json`에 정의하고 `experiment/data/clean/`에서 읽는다. `& .\.venv\Scripts\python.exe export\export_results.py --collection-only`로 원본 WAV를 그대로 웹 스냅샷에 전달한다. 화면은 `dataset/collection.json`과 내보낸 WAV를 사용하며 작업 지시·위험 경고 12개를 재생한다.

아래 명령은 현재 입력 자료와 완료 결과를 점검·전달한다.

```powershell
# 새로 받은 합성음원 점검 (실제 수령 수량·누락·중복·WAV 형식·파일 지문)
& .\.venv\Scripts\python.exe -m experiment.src.validation.inspect_mixtures --save

# 완료 지표·대응 WAV 전달
& .\.venv\Scripts\python.exe export\export_results.py

# 스냅샷 검증·전체 테스트·타입 검사·빌드
& .\.tools\node-v22.23.4-win-x64\node.exe .\.tools\node-v22.23.4-win-x64\node_modules\npm\bin\npm-cli.js --prefix website run build
```

입력 경로는 `experiment/config/paths.json`, 실험 평가 목록은 `experiment/data/metadata/dataset.json`, 원음 목록은 `experiment/config/collection.json`을 사용한다. 이전 실험 자료를 정리해 현재 평가 목록과 지표는 비어 있다. 전체 내보내기는 원음·소음·완료된 FFT를 전달하며 미계산 점수는 만들지 않는다. 새 12문장 평가 목록과 처리 방식의 연결 후 배치 계산을 실행한다.

새 12문장의 합성·평가 배치 연동은 후속 작업이다. 현재 QR 구현은 `qr-mc-v1`의 3문항·0/2.5/5/7.5/10점·진행자 제어 방식이다. 새 개별 재생·4문항·1~5점 규격에 맞춘 화면·채점·저장·집계는 구현 시 함께 수정한다.

계산 결과는 `experiment/outputs/metrics.json`·`metrics.csv`, 전달된 스냅샷은 `website/public/dataset/`, 웹 빌드는 `website/dist/`에 둔다. exporter는 완료 지표·기준 음원·비교 음원의 경로·SHA-256을 검증한 뒤 스냅샷을 교체한다. 계산기 소스는 [calculate_metrics.py](experiment/src/evaluation/calculate_metrics.py), 전달 소스는 [export_results.py](export/export_results.py)다.

개별 파일 계산은 계산기의 `calculate_wav_pair`, 배열 계산은 `calculate_signals`를 사용한다. 현재 기본 전처리는 공통 16 kHz 리샘플링·고정 지연 보정·공통 구간 선택이며 계산 결과에 실제 입력 지문·도구 버전·정렬 구간을 보관한다.

## 합성 배치와 보조 Python 분석 재현

2026-11-18 유채원 배치의 재현 코드는 `experiment/src/mixtures/build_dataset.py`다. 기존 원본과 C FFT 결과를 보존하고 **새 빈 출력 폴더**에 합성음·대응 기준음·보조 그래프·검증표를 생성한다. 프로젝트 `experiment/requirements.txt`의 환경을 사용한다.

```powershell
& .\.venv\Scripts\python.exe -m experiment.src.mixtures.build_dataset --output .cache/mixture-reproduction/2026-11-18
```

macOS에서는 같은 인수를 `.venv/bin/python -m experiment.src.mixtures.build_dataset`에 전달한다. 실행 위치는 프로젝트 루트다. `--clean-root`·`--noise-root`는 생략하면 현재 공유 원본을 읽는다. 출력 폴더가 비어 있지 않으면 재실행을 거부한다. 후보 필터 설계·C 피크 검출·웹 연결을 실행하는 명령이 아니다.

출력 아래 `mixtures/`는 `experiment/mixtures/`, `data/reference/`는 `experiment/data/reference/`에 대응한다. 대응 기준음은 리샘플링·공통 이득을 적용한 평가 자료로 원본 `data/clean/`과 구분한다. 소음 확장본은 `outputs/mixture_preparation/noise/`, 보조 분석표는 `outputs/mixture_analysis/`, 그래프는 `outputs/graphs/mixture_analysis/`에 생성한다. 기존 exporter·평가 카탈로그는 이 기준음을 아직 연결하지 않으므로 후속 연결 시 경로와 입력 지문을 함께 검토한다.

배치 조건과 실제 검증 수치는 `PROJECT_CONTEXT.md`의 합성 배치 기록을 따른다. Python Welch 피크는 이번 배치의 탐색 자료이며 기존 C FFT 경로와 분석 설정이 다르다. 공식 피크 검출·필터 조건으로 자동 확정하지 않는다.

## 합성 수령과 이후 구현 파일

새 합성음원은 `experiment/mixtures/<소음>/snr<SNR>/<원음ID>.wav`에 둔다. 예: `single/snr20/instruction01.wav`. 소음별로 `snr20`·`snr10`·`snr05`·`snr00` 폴더를 준비했다. 점검기는 `snr5`·`snr0` 표기도 인식하며 같은 조건이 두 번 들어오면 중복으로 보고한다.

`inspect_mixtures.py`는 원음을 변경하지 않고 실제 파일·누락 조건·파형 형식·파일 지문을 확인한다. 폴더의 SNR은 표기값이며 실제 SNR 계산은 별도다. 결과는 `experiment/outputs/validation/<실행ID>/report.json`·`files.csv`에 저장한다. 원음과 합성의 길이·샘플링 차이와 PCM 최대값 접촉도 기록하며, 이를 자동으로 잘못된 합성이나 클리핑으로 판정하지 않는다.

| 담당 위치 | 파일과 상태 |
| --- | --- |
| `src/validation/` | `inspect_mixtures.py` 구현 완료 |
| `src/noise_analysis/` | 기존 FFT·실행·그래프 코드 재사용, `detect_peaks.c`는 검출 기준 확정 후 구현 |
| `src/preprocessing/` | `prefilter.c`는 필터 조건 확정 후 구현 |
| `src/algorithms/` | `ss_fixed`·`ss_pattern_fixed`·`ss_pattern_update`·`wiener`·`logmmse`의 `main.c`와 `run_processing.py` 구현 예정 |
| `src/evaluation/` | 기존 `calculate_metrics.py`를 새 목록에 연결하고 `plot_metrics.py` 구현 예정 |
| `config/` | `experiment.yaml`의 미정 값은 유지, `listening_test.json`은 문항 확정 후 추가 |
| `export/`·`website/` | 기존 전달·화면·공용 모듈을 수정해 새 자료 연결 |

표의 `src/`·`config/`는 `experiment/` 아래 경로다. 주석으로만 남아 있던 이전 SS C 파일은 정리했다. 구현 예정 파일은 해당 단계에서 실제 코드와 함께 생성한다.

처리 WAV는 `outputs/enhanced/`, 계산 수치는 `outputs/`, 그래프는 `outputs/graphs/`에 생성한다. 현재 `outputs/enhanced/`는 비어 있으며 새 전처리·알고리즘 처리 결과는 아직 없다.

## 코드 검증

변경한 경로에 해당하는 검사를 실행한다.

```powershell
& .\.venv\Scripts\python.exe -m unittest discover -s experiment/tests/evaluation -v
& .\.venv\Scripts\python.exe -m unittest discover -s experiment/tests/noise_analysis -v
& .\.venv\Scripts\python.exe -m unittest discover -s experiment/tests/validation -v
& .\.venv\Scripts\python.exe -m unittest discover -s export/tests -v
& .\.tools\node-v22.23.4-win-x64\node.exe --test experiment\tests\evaluation\website-bridge.test.mjs
& .\.tools\node-v22.23.4-win-x64\node.exe --test export\tests\local-dataset.test.mjs
& .\.tools\node-v22.23.4-win-x64\node.exe .\.tools\node-v22.23.4-win-x64\node_modules\npm\bin\npm-cli.js test --prefix website
& .\.tools\node-v22.23.4-win-x64\node.exe website\node_modules\typescript\bin\tsc --noEmit --project website\tsconfig.json
```

테스트는 임시 신호·WAV·DB를 사용한다. 실제 연구 음원과 청음 응답은 별도로 보관한다.

## 웹 연결과 운영

화면은 `website/src/`, 서버·DB·채점은 `website/backend/`, 공용 연구 검증·집계는 `website/shared/research/`에 둔다. `src → shared`·`backend → shared`의 의존 방향을 사용하고 `website/worker.ts`에서 HTTP 요청을 연결한다.

웹은 내보낸 `manifest.json`·`results.json`과 `audio/`를 사용한다. 소음 분석의 선택적 입력은 `website/public/dataset/noise_analysis/results.json`이며 그래프는 그 아래 `graphs/`에 둔다. 자료 형식은 [noise-analysis-data.js](website/shared/research/noise-analysis-data.js), 화면은 [noise-analysis.js](website/src/comparison/noise-analysis.js)를 따른다. exporter는 완료된 분석 결과와 그래프의 SHA-256을 검증해 함께 전달한다.

`website/.sites-runtime/`·`dist/`는 생성물이다. DB 스키마 변경은 `website/backend/migrations/`의 순서에 맞춰 반영한다. 완료 지표는 스냅샷, QR·수동 청음 응답과 설정은 D1, 기존 업로드 WAV는 R2에 보관한다. 질문표·척도 변경 시 이전 응답의 버전·원점수와 백업 호환을 확인한다.

`website/.openai/hosting.json`의 기존 프로젝트 ID·DB·R2 연결을 사용한다. 빌드 후 운영 배포는 기존 Sites 프로젝트에서 진행한다.

## 공유와 문서

코드·설정 정의·의존성 잠금 파일·테스트·작업 문서와 `experiment/`의 연구 음원·합성음원·완료 분석·처리 결과를 팀 자료로 공유한다. 설치 도구·의존성·캐시·생성된 웹 스냅샷·실행 중인 DB·백업·운영 배포 연결 정보·키는 Git에서 제외한다. 계산 이력과 입력 지문을 함께 보존하며, 공유 제외 규칙은 `.gitignore`, 업로드 검사는 [check_git_upload.py](scripts/check_git_upload.py)를 따른다.

협업 PC에서 `git config core.hooksPath .githooks`를 설정하고 변경 내용을 검토한 뒤 공유한다. 스테이징 자료는 아래 명령으로 확인한다.

```powershell
& .\.venv\Scripts\python.exe scripts\check_git_upload.py
git diff --cached --stat
git diff --cached
```

문서는 README의 진행 방향, PROJECT_CONTEXT의 확정 자료, CONTRIBUTING의 실행 방법, AGENTS의 작업 지침 네 곳에 모은다. 세부 결정은 작업 중 필요한 시점에 확인하고 담당 문서에 반영한다.

## 피크·합성음 비교 웹 연결

등록된 144개 합성음과 대응 기준음은 프로젝트 Python으로 `-m experiment.src.noise_analysis.analyze_mixture_peaks`를 실행해 분석한다. 완료 결과는 `experiment/outputs/peak_analysis/results.json`에 저장하며 이전 결과는 해시별 파일로 보존한다. 배치 조건과 해석 범위는 PROJECT_CONTEXT를 따른다.

`export/export_results.py`의 전체 내보내기는 완료 분석과 원본/기준음/합성음 171개를 지문 검증 후 전달한다. `website/`의 `npm run dev`도 완료 자료만 전달한다. 웹은 DSP 계산을 실행하지 않는다. 입력이 바뀌면 내보내기/표시를 보류하며 이전 실측 점수·응답을 새 문장에 재할당하지 않는다.

‘소음 특성 분석’에서 소음 3종 → 피크 표/확대 → 12문장·SNR 4단계 비교 → 피크 주변 검토 대역 순서로 확인한다. 기존 C FFT와 보조 Welch PSD의 단위·분석 조건은 구분한다. PNG 저장 링크는 현재 그려진 그래프를 이미지로 제공한다. 후보 대역은 필터 설정이 아니며 효과 검증 전이다.

전달 검사는 `node --test export/tests/peak-analysis.test.mjs export/tests/local-dataset.test.mjs`, 웹 검증은 `website/`의 `npm run build`다. 이전 QR 규격·객관 평가 ID는 이 작업에서 변경하지 않는다.
