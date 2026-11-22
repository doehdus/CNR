# 개발·실행 안내

## 필터링 청음평가 실행

공개 음원 수는 315개이며 로컬 전체 dataset 459개는 보존한다. 배포용 카탈로그와 정적 파일 복사는 `prepareAudio()`의 활성 목록을 사용한다. 미사용 비교 복사본·Peaking EQ 보관 원본을 삭제해 수량을 맞추지 않는다. [공개 음원 정리 기준](PROJECT_CONTEXT.md#2026-11-22-공개-음원-정리--실제-사용-315개만-배포)을 따른다.

현재 새 필터 비교는 `#prefilter-listening`에서 그룹별 링크 또는 QR로 접속한다. 참여 주소는 `/website/prefilter-survey.html?group=1`~`group=5`다. 새 응답은 `/api/prefilter-listening/`과 별도 D1 테이블로 저장·집계하며, 기존 진행자 제어 QR·척도·백업과 혼합하지 않는다. 배정·문항·집계·해석 기준은 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md#2026-11-22-필터링-청음평가--5개-참여-링크와-실제-응답-집계-연결)을 따른다.

`export/export_results.py`가 배정표를 검증·전달한 뒤 `website/`의 `npm run build`를 실행한다. 개발 서버는 같은 배정표를 Node 전달기로 준비하며 점수를 재계산하지 않는다. 새 SQL 마이그레이션은 기존 데이터를 보존하는 테이블 추가뿐이다. 운영의 첫 API 접근도 같은 테이블을 안전하게 준비한다. 연구 스냅샷이 등록된 뒤 같은 연구 ID의 배정·문항·척도가 바뀌면 접속을 보류하므로, 수집 중 자료 변경은 새 연구 버전으로 분리한다. 기존 일반 백업은 이전 평가용이며 새 필터 원응답은 별도 D1 테이블에 보존한다.

## 필터링 청음평가 음원 선정

확정된 5그룹의 30쌍·문장 배정·점수·기존 WAV 지문은 [prefilter_listening.json](experiment/config/prefilter_listening.json), 선정 논리와 실제 수량은 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md#2026-11-22-필터링-청음평가--12문장을-고르게-사용하는-5그룹-음원-선정)을 따른다. 검토용 CSV는 `experiment/outputs/prefilter_listening/assignment.csv`다. 다음 검사는 WAV·지표를 재생성하지 않는다.

```powershell
& .\.venv\Scripts\python.exe -m experiment.src.evaluation.select_prefilter_listening --verify-config experiment/config/prefilter_listening.json
& .\.venv\Scripts\python.exe -m unittest experiment.tests.evaluation.test_prefilter_listening -v
```

선정기는 기존 설정·CSV를 덮어쓰지 않는다. 새 선정을 만들 때에는 별도의 `experiment/config/` 출력 경로를 지정하고 완료된 지표 회차와 파일 지문을 보존한다. 이번 필터 청음평가는 위 새 자가 재생 경로에 연결됐으며, 아래 일반 알고리즘 평가의 전환 작업과 구분한다.

## 필터링 결과의 STOI·ESTOI 계산과 전달

기준음·정렬·공통 구간·수량·평가 자료 관계는 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md#2026-11-22-필터링-결과-분석--실제-stoiestoi-비교)를 따른다. 기존 144조건 BPF 처리 회차가 준비된 상태에서 프로젝트 루트에서 실행한다.

```powershell
& .\.venv\Scripts\python.exe -m experiment.src.evaluation.calculate_metrics --prefilter-bpf
& .\.venv\Scripts\python.exe -m unittest experiment.tests.evaluation.test_prefilter_metrics experiment.tests.evaluation.test_calculate_metrics -v
& .\.venv\Scripts\python.exe export/export_results.py
```

실제 지표는 기존 `calculate_signals`·pystoi로 계산한다. `prefilter_metrics.py`는 같은 Clean 구간의 원본/BPF 쌍과 지문·정렬을 묶어 `experiment/outputs/prefilter_metrics/runs/<회차>/results.json`, `comparison.csv`에 보존한다. 현재 포인터는 `experiment/outputs/prefilter_metrics.json`이며 이전 회차·원본·기존 `metrics.json`·평가 카탈로그·응답은 유지한다. 이번 모드는 기존 `--sample-rate`(현재 16000Hz)·`--max-delay-seconds`(기본 0.5초)를 기록한다. 기존 3문장 알고리즘 배치 모드는 별도로 보존한다.

`export/bpf.mjs`는 `export/prefilter_metrics.mjs`를 통해 완료 지표를 검증·전달한다. Node 로컬 준비에서도 지표 회차 지문을 반영해 완료 자료를 갱신하며 지표를 재계산하지 않는다. 새 화면은 `website/src/comparison/prefilter-analysis.js`, 공용 데이터 검증은 `website/shared/research/prefilter-metrics-data.js`다. 웹 검증은 기존대로 `website/`의 `npm run build`를 사용한다.

## 고정 Butterworth BPF 설계·처리·재생표 전달

확정 설정·선정 근거·공통 청음 레벨·자료 관계는 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md#2026-11-21-고정-butterworth-bpf-확정144조건-처리), 수치 원본은 [prefilter_bpf.json](experiment/config/prefilter_bpf.json)을 따른다. 프로젝트 루트에서 실행한다.

```powershell
& .\.venv\Scripts\python.exe -m experiment.src.preprocessing.design_bpf
& .\.venv\Scripts\python.exe -m experiment.src.preprocessing.run_bpf
& .\.venv\Scripts\python.exe -m unittest experiment.tests.preprocessing.test_bpf -v
& .\.venv\Scripts\python.exe export/export_results.py
```

C가 계수·극점·응답과 WAV 필터링을 계산하며 Python은 실행·검증·지문·완료 응답 PNG를 담당한다. 설계는 `experiment/outputs/bpf_design/runs/`, BPF 144개와 무처리 청음용 복사본 144개는 `experiment/outputs/enhanced/prefilter_bpf/runs/`에 새 회차로 보존한다. 현재 포인터는 `experiment/outputs/bpf_results.json`이다. 원본 입력에는 쓰지 않는다. 처리기의 `--measure-only`는 양자화 전 피크·범위 초과 예상 수만 반환하고 WAV를 만들지 않는다. `--gain-db`는 설정에 명시한 고정 배율만 적용하며 기본은 0dB, 범위 초과 시 자동 클리핑 없이 실패한다.

Python exporter와 Node 로컬 자료 준비는 `export/bpf.mjs`로 같은 완료 자료·지문·형식을 검증한다. BPF가 있으면 이전 EQ의 완료 WAV는 실험 원본에 보존하고 웹에는 이력 메타데이터만 전달해 Sites 용량 제한 안에 현재 재생 자산을 담는다. 웹은 `prefilter_bpf/results.json`과 전달 음원/그래프를 읽으며 필터를 실행하지 않는다. `website/`에서 `npm run build`로 전달 스냅샷·재생 버튼의 전체 조건 대응·타입·빌드를 검증한다. 전달 경로의 별도 검사는 프로젝트 Node.js의 `node --test export/tests/bpf.test.mjs`다. 이전 고정 EQ 명령과 완료 회차는 비교 이력으로 보존한다.

현재 재생 화면 구성은 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md#2026-11-21-사전필터링을-음원별소음별-선택-재생표로-변경)를 따른다. 화면은 `website/src/comparison/butterworth-prefilter.js`, 재생표 검사는 `website/tests/frontend/butterworth-prefilter.test.js`에서 관리한다. 화면 변경 시 WAV 처리를 반복하지 않는다.

## Butterworth BPF 후보 비교

선정 목적·자료 대응·수치의 한계는 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md#2026-11-21-butterworth-bpf-주-전처리-후보-비교), 탐색 후보군은 [bpf_candidates.json](experiment/config/bpf_candidates.json)을 따른다. 프로젝트 루트에서 실행한다.

```powershell
& .\.venv\Scripts\python.exe -m experiment.src.preprocessing.compare_bpf
& .\.venv\Scripts\python.exe -m unittest experiment.tests.preprocessing.test_compare_bpf -v
```

실행기는 프로젝트 TinyCC로 `compare_bpf.c`를 `.cache/noise_analysis/`에 컴파일하고 기존 C의 원본·그룹·개별 PSD를 재사용한다. FFT·소음 추정·음원 필터링을 반복하지 않는다. 결과·구간별 CSV·응답·그래프·입력 지문은 `experiment/outputs/bpf_candidates/runs/<실행ID>/`에 보존하며 기존 회차를 덮어쓰지 않는다. 탐색 단면 그래프에 표시한 고정 상한·하한·차수는 비교를 위한 조건이며 확정 설정이 아니다. 이 명령은 웹·exporter·현재 고정 EQ의 재생 표를 변경하지 않는다.

## 고정 EQ 음원 처리와 재생표 전달

처리 범위·방식·화면 기준은 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md#2026-11-21-고정-eq-144개-처리와-사전-필터링-화면-통합)를 따른다. 고정 EQ 설계 검증 회차가 준비된 뒤 프로젝트 루트에서 실행한다.

```powershell
& .\.venv\Scripts\python.exe -m experiment.src.preprocessing.run_prefilter
& .\.venv\Scripts\python.exe -m unittest experiment.tests.preprocessing.test_prefilter -v
& .\.venv\Scripts\python.exe export/export_results.py
```

실행기는 프로젝트 TinyCC로 `prefilter.c`를 `.cache/noise_analysis/`에 컴파일하며, 완료된 계수만 C에 전달한다. 처리 WAV·manifest는 `experiment/outputs/enhanced/prefilter_fixed/runs/<실행ID>/`, 현재 참조는 `experiment/outputs/prefilter_results.json`이다. 설정·설계·입력이 달라지면 재설계 검증 또는 입력 확인을 요구하며, 기존 처리 회차는 보존한다.

`npm run dev`의 기존 Node 자료 준비도 완료 WAV를 검증·전달하며 필터를 실행하지 않는다. 웹 검증은 `website/`에서 기존 `npm run build`를 사용한다. 새 재생표 검사는 `website/tests/frontend/prefilter.test.js`와 `website/tests/shared/prefilter-fixed.test.js`이며 빌드 검사에 포함된다. 기존 3문장 평가 카탈로그·원응답은 새 144조건으로 자동 변환하지 않는다.

## 공통 고정형 peaking EQ 설계·응답 검증

확정 설정과 자료 관계는 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md#2026-11-21-공통-고정형-peaking-eq-설계응답-검증), 수치 원본은 [prefilter_fixed.json](experiment/config/prefilter_fixed.json)을 따른다. 프로젝트 루트에서 실행한다.

```powershell
& .\.venv\Scripts\python.exe -m experiment.src.preprocessing.design_peaking_eq
& .\.venv\Scripts\python.exe -m unittest experiment.tests.preprocessing.test_design_peaking_eq -v
```

실행기는 프로젝트 TinyCC로 설계 계산기를 `.cache/noise_analysis/`에 컴파일한다. C가 계수·극점·복소 응답·반감쇠 경계를 계산하고 Python은 지문 기록·CSV 조회·PNG 작성만 담당한다. 결과는 `experiment/outputs/prefilter_design/runs/<실행ID>/`의 `design.json`, `response.csv`, 전체·대역별 PNG 3개와 `manifest.json`에 보존한다. 응답은 0.5Hz 격자에 정확한 중심·반감쇠 경계를 추가하며 중복 주파수는 제거한다. 검사는 독립적인 SciPy 아날로그 원형의 bilinear 변환과 C의 복소 응답을 대조한다.

기존 완료 회차를 덮어쓰지 않으며 설정·코드·컴파일러·참조 분석이 계산 중 달라지면 결과를 게시하지 않는다. 이 명령은 음원이나 지표를 처리하지 않는다. 웹의 기존 소음별 초기 EQ 표는 보존된 이전 안이며, 새 공통 설계는 이번 단계에서 웹·exporter에 연결하지 않는다.

## 피크·추적 안정성·Clean 중첩 발표 비교

기존 12그룹 평균과 개별 C 분석을 준비한 뒤 프로젝트 루트에서 실행한다. 집계·구간 경계·미검출·정규화 기준은 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md#2026-11-20-피크-유지추적-안정성clean-중첩-비교)를 따른다.

```powershell
& .\.venv\Scripts\python.exe -m experiment.src.noise_analysis.plot_peak_comparison
& .\.venv\Scripts\python.exe export\export_results.py
```

실행기는 프로젝트 TinyCC로 집계 도구와 기존 분석 도구를 컴파일해 `.cache/noise_analysis/`에서 실행한다. 기존 전체 구간 통계와 그룹 PSD는 재사용하며, Changing 구간별 검출·추적만 별도 산출한다. 결과는 `experiment/outputs/mixture_summary/peak_comparison.json`과 새 회차의 PNG·구간 C 원출력에 보존하고 기존 결과는 덮어쓰지 않는다. 수치 검사는 `.venv/Scripts/python.exe -m unittest experiment.tests.noise_analysis.test_peak_comparison experiment.tests.noise_analysis.test_analyze_signals`, 전달 검사는 프로젝트 Node.js의 `node --test export/tests/mixture-summary.test.mjs`, 웹 검증은 `website/`의 `npm run build`다.

## 완료 PSD로 발표용 SNR 비교 그래프 생성

기존 12묶음 평균 분석이 완료된 상태에서 아래 명령만 실행한다. 추가 평균 계산 없이 저장된 Mixture mean PSD를 그린다. 표시 기준은 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md#2026-11-20-snr-비교-발표-그래프)를 따른다.

```powershell
& .\.venv\Scripts\python.exe -m experiment.src.noise_analysis.plot_snr_comparison
& .\.venv\Scripts\python.exe export\export_results.py
```

그래프와 출처 기록은 기존 `experiment/outputs/mixture_summary/` 안에 별도 렌더 회차로 보존한다. 선·축 검증은 `.venv/Scripts/python.exe -m unittest experiment.tests.noise_analysis.test_snr_comparison`, 웹 검증·빌드는 기존 `website/`의 `npm run build`를 사용한다.

## 합성음 평균 요약 실행

평균의 정규화·구간·시간축·비교 기준은 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md#2026-11-20-합성음-평균-요약)에 모았다. 기존 개별 분석과 등록 발화 구간이 준비된 상태에서 프로젝트 루트에서 실행한다.

```powershell
& .\.tools\tcc\tcc.exe -std=c99 -Wall -Werror experiment\src\noise_analysis\analyze_signals.c -o .cache\noise_analysis\analyze_signals.exe
& .\.venv\Scripts\python.exe -m experiment.src.noise_analysis.run_summary
& .\.venv\Scripts\python.exe export\export_results.py
```

완료 회차는 `experiment/outputs/mixture_summary/`에 보존하며 웹에는 현재 참조하는 JSON·PNG만 전달한다. `npm run dev`도 검증된 완료 요약을 전달한다. 웹 검증·빌드는 기존과 같이 `website/`에서 `npm run build`로 실행한다. 독립 수치 검사는 `.venv/Scripts/python.exe -m unittest experiment.tests.noise_analysis.test_mixture_summary`, 전달 검사는 프로젝트 Node.js로 `node --test export/tests/mixture-summary.test.mjs`를 실행한다. 웹·내보내기에서 RMS·FFT·피크를 재계산하지 않는다.

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

## 새 평가 기준으로 전환할 작업

소음 특성 분석과 별도 필터 청음평가는 새 12문장으로 연결되어 있다. 일반 알고리즘의 음성 처리 결과·객관 평가·기존 진행자 제어 QR은 이전 3문장 ID를 사용한다. 아래 표는 이 일반 평가의 전환 작업이며, 새 필터 청음평가의 연결 상태와 구분한다.

| 경로 | 현재 상태 | 전환 시 할 일 |
| --- | --- | --- |
| `experiment/config/collection.json` | 새 원음 12개와 문장·화자 정의 | 새 평가 카탈로그의 문장 기준으로 재사용 |
| `website/shared/research/dataset.js` | 이전 3문장·36조건과 새 처리 방식 정의 | 새 ID·문장·화자를 연결하고 처리 결과 표·선택 메뉴·집계를 함께 전환 |
| `experiment/src/evaluation/calculate_metrics.py` | 이전 문장·알고리즘 목록 검증 | 새 목록·전처리 조건·완료 처리 방식 및 `data/reference/` 기준음을 연결 |
| `experiment/data/metadata/dataset.json` | 평가 음원 목록 비어 있음 | 실제 완료한 무처리·전처리·알고리즘 결과만 경로와 지문을 확인해 등록 |
| `website/backend/surveys/model.ts` | `qr-mc-v1`, 이전 3문장의 3문항 | 새 12문장별 핵심정보 4문항과 보기를 확정한 뒤 새 질문표 버전으로 구현 |
| `website/shared/research/evaluation.js`·`src/listening-test/` | 0·2.5·5·7.5·10점, 진행자 제어 | 새 1~5점 척도·개별 재생·무제한 다시 듣기를 채점·저장·집계·화면과 함께 구현 |
| `website/backend/surveys/backup.ts`·DB 마이그레이션 | 이전 응답 복원·검증 지원 | 이전 질문표·척도·원점수를 보존하고 새 응답과 혼합 집계하지 않도록 버전 구분 |
| `export/`·`website/tests/`·`experiment/tests/` | 이전 평가 규격 검증과 새 분석 검증 공존 | 새 기준의 전달·평가·백업 호환을 검증한 뒤 메뉴 연결 확인 |

진행 순서는 **카탈로그·기준음 연결 → 완료 처리 결과 등록 → STOI·ESTOI 계산·전달 → 새 청음 규격 구현 → 백업·집계 검증**이다. 핵심정보 4문항의 실제 내용·보기와 처리 범위는 확정한 뒤 구현한다. 질문표나 음원 ID를 이름만 바꿔 기존 응답에 적용하지 않는다. 현재 미연결 셀의 ‘연결 대기’는 유지한다.

삭제한 미사용 항목은 `deliverPeakAnalysis()`와 브라우저의 미사용 가져오기·저장 키다. 실제 전달 경로 `prepareLocalDataset()`·`export_results.py`, 현재 분석·과거 분석 이력, DB 스키마·마이그레이션, 배포 실행 도구는 유지한다.

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

출력 아래 `mixtures/`는 `experiment/mixtures/`, `data/reference/`는 `experiment/data/reference/`에 대응한다. 대응 기준음은 리샘플링·공통 이득을 적용한 평가 자료로 원본 `data/clean/`과 구분한다. 소음 확장본은 `outputs/mixture_preparation/noise/`, 보조 분석표는 `outputs/mixture_analysis/`, 그래프는 `outputs/graphs/mixture_analysis/`에 생성한다. 보조 소음 분석용 전달은 이 기준음을 포함한다. 객관 평가 카탈로그·계산기의 기준음 연결은 아직 후속 작업이므로 경로와 입력 지문을 함께 검토한다.

배치 조건과 실제 검증 수치는 `PROJECT_CONTEXT.md`의 합성 배치 기록을 따른다. Python Welch 피크는 이번 배치의 탐색 자료이며 기존 C FFT 경로와 분석 설정이 다르다. 공식 피크 검출·필터 조건으로 자동 확정하지 않는다.

## 합성 수령과 이후 구현 파일

새 합성음원은 `experiment/mixtures/<소음>/snr<SNR>/<원음ID>.wav`에 둔다. 예: `single/snr20/instruction01.wav`. 소음별로 `snr20`·`snr10`·`snr05`·`snr00` 폴더를 준비했다. 점검기는 `snr5`·`snr0` 표기도 인식하며 같은 조건이 두 번 들어오면 중복으로 보고한다.

`inspect_mixtures.py`는 원음을 변경하지 않고 실제 파일·누락 조건·파형 형식·파일 지문을 확인한다. 폴더의 SNR은 표기값이며 실제 SNR 계산은 별도다. 결과는 `experiment/outputs/validation/<실행ID>/report.json`·`files.csv`에 저장한다. 원음과 합성의 길이·샘플링 차이와 PCM 최대값 접촉도 기록하며, 이를 자동으로 잘못된 합성이나 클리핑으로 판정하지 않는다.

| 담당 위치 | 파일과 상태 |
| --- | --- |
| `src/validation/` | `inspect_mixtures.py` 구현 완료 |
| `src/noise_analysis/` | 기존 전체 C FFT 보존, `analyze_signals.c`에서 Welch·피크·STFT·인접 프레임 추적 수치 계산 |
| `src/preprocessing/` | `design_peaking_eq.c`·`.py`로 설계·응답 검증, `prefilter.c`·`run_prefilter.py`로 144개 WAV 처리·회차 보존 |
| `src/algorithms/` | `ss_fixed`·`ss_pattern_fixed`·`ss_pattern_update`·`wiener`·`logmmse`의 `main.c`와 `run_processing.py` 구현 예정 |
| `src/evaluation/` | 기존 `calculate_metrics.py`를 새 목록에 연결하고 `plot_metrics.py` 구현 예정 |
| `config/` | `experiment.yaml`의 미정 값은 유지, `listening_test.json`은 문항 확정 후 추가 |
| `export/`·`website/` | 기존 전달·화면·공용 모듈을 수정해 새 자료 연결 |

표의 `src/`·`config/`는 `experiment/` 아래 경로다. 주석으로만 남아 있던 이전 SS C 파일은 정리했다. 구현 예정 파일은 해당 단계에서 실제 코드와 함께 생성한다.

처리 WAV는 `experiment/outputs/enhanced/`, 계산 수치와 그래프는 `experiment/outputs/`의 해당 회차에 보존한다. 현재 완료한 Butterworth·STOI/ESTOI·청음평가 배정 상태는 PROJECT_CONTEXT를 따른다. 후속 알고리즘 결과와 구분한다.

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

코드·설정 정의·의존성 잠금 파일·테스트·작업 문서와 **현재 사용하는 연구 자료만** GitHub로 공유한다. WAV는 원본/기준/소음/합성 171개와 Butterworth 처리 144개, 총 315개다. 완료 분석은 현재 결과 포인터와 선정 근거에서 참조하는 회차를 공유한다. 이전 분석 회차·중간 합성 소음·미사용 EQ 처리 WAV·예전 −1dB 무처리 비교 WAV는 로컬에 보존하며 Git에서는 제외한다. EQ 회귀 검사와 이력 표시에 필요한 설정·설계·처리 manifest만 남긴다. 설치 도구·의존성·캐시·생성된 웹 스냅샷·실행 중인 DB·백업·운영 배포 연결 정보·키도 제외한다. 공유 범위는 `.gitignore`, 업로드 검사는 [check_git_upload.py](scripts/check_git_upload.py)를 따른다.

새 회차를 실제 사용 대상으로 전환할 때는 결과 포인터와 `.gitignore`의 활성 회차를 함께 갱신하고 입력·결과 지문을 검증한다. 새 복제본에서는 미사용 WAV가 없어도 내보내기·개발 서버·빌드가 동작한다. 보관 자료가 로컬에 존재하면 선택적으로 검증하며, 누락된 필수 원본/Butterworth 파일이나 존재하지만 지문이 다른 파일은 계속 거부한다.

업로드 검사는 소스 파일 10MiB, 연구 입력·합성·결과 파일 100MiB 한도와 비밀정보 검사를 적용한다. 전체 스테이징 트리를 검사하되 Git blob을 하나씩 읽어 대용량 연구 자료 전체를 메모리에 쌓지 않는다. 테스트는 `python -m unittest scripts.tests.test_git_upload -v`로 실행한다.

협업 PC에서 `git config core.hooksPath .githooks`를 설정하고 변경 내용을 검토한 뒤 공유한다. 스테이징 자료는 아래 명령으로 확인한다.

```powershell
& .\.venv\Scripts\python.exe scripts\check_git_upload.py
git diff --cached --stat
git diff --cached
```

문서는 README의 진행 방향, PROJECT_CONTEXT의 확정 자료, CONTRIBUTING의 실행 방법, AGENTS의 작업 지침 네 곳에 모은다. 세부 결정은 작업 중 필요한 시점에 확인하고 담당 문서에 반영한다.

## 피크·합성음 비교 웹 연결

현재 주파수 수치는 C에서 계산한다. 프로젝트 Python은 C 실행·지문·기록·완료 수치의 그래프 생성을 묶는다. 계산 설정과 해석 범위는 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md#2026-11-20-c-수치-계산과-noisemixture-화면-분리), 실제 파라미터는 [frequency_analysis.json](experiment/config/frequency_analysis.json)을 따른다.

```powershell
New-Item -ItemType Directory -Force .cache\noise_analysis | Out-Null
& .\.tools\tcc\tcc.exe -std=c99 -Wall -Werror experiment\src\noise_analysis\analyze_signals.c -o .cache\noise_analysis\analyze_signals.exe
& .\.venv\Scripts\python.exe -m experiment.src.noise_analysis.run_analysis
& .\.venv\Scripts\python.exe export\export_results.py
```

이전 `-m experiment.src.noise_analysis.analyze_mixture_peaks` 명령은 동일한 C 실행 경로로 연결한다. 결과는 `experiment/outputs/peak_analysis/runs/<실행ID>/`의 `raw/*.json.gz`(C 원출력), `details/*.json`(저장된 추적 수치), `graphs/*.png`와 `manifest.json`에 보존한다. 모든 조건이 성공하고 입력 지문을 다시 확인한 뒤에만 `results.json`을 교체한다. 이전 결과는 해시별 JSON과 기존 실행 폴더로 보존한다. 연구 수치 원출력과 웹에 전달하는 PNG·상세 JSON을 구분한다.

`export/export_results.py`의 전체 내보내기는 완료 분석과 원본/기준음/합성음 171개를 지문 검증 후 전달한다. `website/`의 `npm run dev`도 완료 자료만 전달한다. 웹은 DSP 계산을 실행하지 않는다. 입력이 바뀌면 내보내기/표시를 보류하며 이전 실측 점수·응답을 새 문장에 재할당하지 않는다.

Noise·Mixture 분석은 각각 3개 세부 화면을 제공한다. 현재 사전 필터·지표·청음평가는 문서 위쪽의 Butterworth 경로로 연결한다. 초기 EQ 설정 `experiment/config/prefilter_initial.json`은 이력 정의로 보존하며 참조 분석의 회차·지문을 검증한다. 초기 설계 기록은 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md#2026-11-20-사전-필터-준비와-초기-eq-설계안)을 따른다. PNG 저장 링크는 계산 회차에 저장된 파일을 사용하며 브라우저에서 그래프 수치를 재계산하지 않는다. 웹 데이터의 `engine`은 C 소스·실행파일·설정 지문과 실행 회차를 기록하고, `artifacts`는 상세 JSON·PNG 지문을 기록한다. 입력·결과가 변경되면 전달이나 표시를 보류한다.

연구용 전체 프레임·궤적 기록은 `experiment/outputs/peak_analysis/`에 보존한다. 웹 전달은 PNG와 모든 혼합음 궤적의 C 통계 요약을 사용하며, 실제 추가 소음은 비교에 필요한 대표 궤적 통계만 전달한다. 전달기는 통계값을 재계산하지 않고 배열로 직렬화하며, 원래 결과의 SHA-256을 `delivery.source_sha256`에 기록한다. 웹은 이를 검증한 뒤 표의 필드로 복원한다.

전달 검사는 `node --test export/tests/peak-analysis.test.mjs export/tests/local-dataset.test.mjs`, 웹 검증은 `website/`의 `npm run build`다. 이전 QR 규격·객관 평가 ID는 이 작업에서 변경하지 않는다.
