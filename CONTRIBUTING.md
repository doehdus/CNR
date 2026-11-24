# 개발·실행 안내

연구 범위·수량·대역·보관 범위는 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md#2026-11-24-폴더-재정리와-butterworth-새-시작)를 따른다.

## 폴더 구조

```text
analysis/
  graphs/<주제>/<회차>/           이번 선정 그래프와 최신 위치 목록
  mkgraphs/                      C 수치 계산·Python 실행·그래프 생성
  results/signals/<회차>/         분석 수치·CSV·manifest
  results/candidates/butterworth/ 후보 비교와 선정 근거
data/
  clean/                         원음 12개
  noise/                         원본 소음 3개
  reference/                     합성 대응 기준음 12개
  mixtures/<소음>/snr<SNR>/       합성음 144개
  metadata/                      문장·화자·입력 목록·지문·이동 기록
  preparation/                   합성 구간·배율·검증표·확장 소음
code/
  pre/butterworth1/               SOS 4절을 내장한 butterworth1.c
  pre/butterworth2/               SOS 16절을 내장한 butterworth2.c
  pre/run_research_bpf.py         두 후보 공통 컴파일·실행·검증·기록
  post/                          SS·Wiener·Log-MMSE 후보 코드 위치, 아직 미구현
  prepare/                       합성 재현·입력 점검
  evaluation/                    STOI·ESTOI·청취 선정 코드
  config/workflow.json           공통 후보·분석 설정·출력 위치
  tests/                         연구 코드 검증
  requirements.in / .txt          Python 의존성
experiment/
  pre/butterworth1result/<회차>/  새 후보 1 결과
  pre/butterworth2result/<회차>/  새 후보 2 결과
  post/<방식>/<전처리>/<회차>/    후처리 결과
  evaluation/                    완료 지표
  listening/                     청취 선정·배정·문항·척도 버전
  report/                        비교표·그림·보고서
before1123/                      이전 결과 보관
export/                          웹 전달 코드·paths.json·전달 테스트
website/                         화면·서버·공용 로직·웹 테스트
scripts/                         Git 업로드 검사
.tools/ · .venv/ · .cache/        프로젝트 도구·의존성·캐시
```

후처리는 아직 미구현이며 빈 C 파일이나 가짜 결과를 만들지 않는다. Butterworth SOS 계수는 각 C 파일에 고정하며 실행 시 계수 덮어쓰기를 받지 않는다. 사용자가 확정한 공통 출력 감쇠 −1.7dB도 각 C 파일에 고정한다. 입력·출력 경로와 측정 전용 옵션만 받으며 파일별 음량 보정은 하지 않는다. −3dB 차단 주파수는 통과대역 기준이고, 공통 출력 감쇠를 포함한 절대 차단점 이득은 약 −4.7103dB다. Python은 컴파일·실행·독립 검증·기록을 담당하고 실행파일은 `.cache/noise_analysis/`에 둔다.

새 Butterworth 회차는 소음/SNR별 WAV 144개, 설정·환경·조건별 수치·입출력 지문·검증을 합친 `result.json` 1개, `code/`의 실제 C·공통 Python 사본 2개로 총 147파일을 저장한다. 별도 SOS·환경·조건·검증·manifest JSON과 latest 포인터를 만들지 않는다. 결과를 사용할 때 회차 경로를 명시한다. 소스 사본 실행 시 프로젝트 루트를 찾아 해당 C 사본을 사용한다.

처리 전에 전 144조건의 헤드룸을 측정한다. PCM16 범위 초과 시 출력 WAV를 만들지 않고 중단한다. 자동 클리핑·감쇠·정규화는 하지 않으며 설정 변경이 필요하면 사용자에게 확인한다. 통과한 결과만 독립 SciPy SOS·동일 PCM16 반올림과 샘플 단위 비교한 뒤 완료 저장한다.

기존 완료 기록 원문은 보존한다. 분석의 명시적 경로 매핑으로 새 저장 위치를 해석하며 보관 자료를 활성 결과로 자동 연결하지 않는다. 기존 분석의 manifest·latest 규격은 유지한다. 원음·완료 결과·응답 원점수·기존 변경 사항을 보존한다.

## 도구와 검증

Windows 프로젝트 루트에서 실행한다. C는 `.tools/tcc/tcc.exe`, Python은 `.venv/Scripts/python.exe`를 사용한다. `C:\Fied`의 도구·패키지·설정은 사용하지 않는다.

```powershell
& .\.venv\Scripts\python.exe code/prepare/inspect_mixtures.py
& .\.venv\Scripts\python.exe -m unittest discover -s code/tests -t code -v
& .\.venv\Scripts\python.exe -m unittest discover -s export/tests -v
```

새 분석·처리는 아래 명령이다. 폴더 정리에서는 전체 배치를 실행하지 않는다.

```powershell
& .\.venv\Scripts\python.exe -m analysis.mkgraphs.run_research
& .\.venv\Scripts\python.exe -m analysis.mkgraphs.research_bpf --config <후보비교설정.json>
& .\.venv\Scripts\python.exe code/pre/run_research_bpf.py --candidate bpf01
& .\.venv\Scripts\python.exe code/pre/run_research_bpf.py --candidate bpf02
```

그림 배치만 복구하려면 프로젝트 Python으로 `-m analysis.mkgraphs.graph_output`을 실행한다. 수치는 재계산하지 않으며 변경된 그림은 덮어쓰지 않는다.

객관 계산 도구는 `.venv/Scripts/python.exe code/evaluation/calculate_metrics.py`다. 기존 평가 카탈로그 호환 기능을 보존했으며 새 12문장·후보 조합·대응 기준음 연결 후 전체 배치를 계산한다. 질문표·척도·응답 원점수 버전을 유지한다.

## 전달·웹·공유

`export/export_results.py`는 `export/paths.json`의 실제 저장 경로와 완료 지표·WAV 지문을 검증해 `website/public/dataset/`에 전달한다. 공개 경로 `data/clean`·`data/noise`·`data/mixed`·`outputs`는 유지한다. 이번 분석 그래프를 웹에 새로 연결하지 않는다.

```powershell
& .\.venv\Scripts\python.exe export/export_results.py
$env:PATH = "$PWD\.tools\node-v22.23.4-win-x64;$env:PATH"
& .\.tools\node-v22.23.4-win-x64\node.exe .\.tools\node-v22.23.4-win-x64\node_modules\npm\bin\npm-cli.js --prefix website run build
```

웹 검증·빌드는 `website/package.json`의 `npm run build`로 통일한다. 빌드는 내보낸 스냅샷만 사용하며 Python·연구 DSP를 호출하지 않는다.

macOS는 Node.js 22.23.4 준비 후 `website/`에서 `npm ci`, `npm run dev`를 실행한다. 별도 설치기나 실행 래퍼를 추가하지 않는다. 주소는 `http://localhost:5173/website/`다.

기존 응답 DB, `website/wrangler.local.json`, `.wrangler/local-collab/`, `.wrangler/state/`, `website/.openai/hosting.json`의 프로젝트 ID·D1·R2 연결을 유지한다. 배포는 별도 작업이다.

연구 입력·완료 분석·처리 결과는 공유한다. 도구·캐시·생성 웹 복사본·실행 DB·응답 백업·인증정보·before1123 전체는 공유에서 제외한다. 업로드 검사는 `scripts/check_git_upload.py`를 사용하며 자동 커밋·푸시는 하지 않는다.
