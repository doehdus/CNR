# 내부 STOI·ESTOI 계산

기준 음성과 무처리·처리 WAV를 공통 샘플레이트로 리샘플링하고 고정 지연을 보정한 뒤 STOI·ESTOI를 계산한다. 현재 준비된 무처리 36개와 초기 고정형 SS 36개를 계산할 수 있다.

## Python 환경

프로젝트 안의 `.venv/`에 Python 3.12.16 환경을 구성했다. `pystoi==0.4.1`, `soundfile==0.13.1`과 NumPy·SciPy 등 의존성은 [requirements.txt](requirements.txt)에 버전·해시를 고정했다. 시스템 PATH와 레지스트리는 변경하지 않았다.

현재 PC에서 가상환경을 활성화할 필요 없이 `.venv\Scripts\python.exe`를 직접 사용한다. 새 팀원은 [협업 안내](../CONTRIBUTING.md)에 따라 프로젝트 내부에 Python 3.12 기반 런타임을 준비한다. 아래는 가상환경이 없는 새 PC에서만 실행한다.

```powershell
& .\.tools\python\cpython-3.12.16-windows-x86_64-none\python.exe -m venv .venv
$env:PIP_CACHE_DIR = Join-Path $PWD '.cache\pip'
.\.venv\Scripts\python.exe -m pip install --require-hashes -r metrics\requirements.txt
```

현재 uv로 구성한 환경의 의존성을 다시 맞출 때는 다음 명령을 사용할 수 있다.

```powershell
.\.tools\uv\uv.exe pip sync metrics\requirements.txt --python .venv\Scripts\python.exe --require-hashes
```

## 계산 함수

```python
from metrics.calculate_metrics import calculate_signals, calculate_wav_pair, prepare_signals

# 같은 샘플레이트·길이의 시간 정렬된 mono 신호 배열
scores = calculate_signals(clean_signal, compared_signal, sample_rate)

# WAV를 16 kHz로 리샘플링하고 최대 ±0.5초 범위에서 자동 정렬
scores = calculate_wav_pair(clean_wav_path, compared_wav_path)
# 반환: {"stoi": 실제 계산값, "estoi": 실제 계산값}

# 배열의 원래 샘플레이트가 다르거나 정렬 내역을 확인할 때
clean, compared, preparation = prepare_signals(clean_signal, compared_signal, 48000, 16000)
scores = calculate_signals(clean, compared, preparation["sample_rate"])
```

`calculate_wav_pair`와 `calculate_dataset`은 다음 순서로 음원을 준비한다.

1. 두 mono 신호를 `scipy.signal.resample_poly`의 저역통과 필터를 통해 공통 16 kHz로 리샘플링한다. 같은 샘플레이트의 신호도 동일한 함수로 처리한다. [SciPy 리샘플링 문서](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.resample_poly.html)
2. 평균을 제거한 파형 복사본의 절댓값 교차상관이 가장 큰 고정 지연을 찾는다. 기본 탐색 범위는 ±0.5초다. 길이가 같은 파일도 시작 시점 차이를 보정한다. [SciPy 교차상관 문서](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.correlate.html)
3. 지연을 보정한 두 신호에서 겹치는 구간을 선택해 길이를 맞춘다. 실제 점수에는 리샘플링한 원래 진폭의 파형을 사용한다.
4. 같은 구간으로 `pystoi.stoi`의 `extended=False`와 `extended=True`를 각각 호출한다. 라이브러리 내부의 리샘플링·비발화 제거 규칙을 적용한다.

`sample_rate`와 `max_delay_seconds` 인자로 공통 샘플레이트와 탐색 범위를 지정할 수 있다. `max_delay_seconds=0`은 시작 시점을 유지하고 공통 길이를 선택한다. 보정은 파일 전체에 동일한 고정 지연을 적용한다. `calculate_signals`는 같은 샘플레이트·길이로 시간 정렬된 배열을 직접 평가한다.

실수 1차원 mono, 같은 길이와 샘플레이트, 유한한 값이 필요하다. 무음·상수 신호, 유효 발화 부족, 읽기 실패 등은 `MetricInputError`로 반환한다. 짧은 음원에서 라이브러리가 경고와 함께 내놓는 작은 대체값을 실제 점수로 저장하지 않는다. 부동소수점 연산으로 수학적 범위를 1e-12 이내 벗어난 경우에만 경계 오차를 보정한다.

STOI·ESTOI는 일반·확장 명료도 예측 지표이며 단어 정답률이 아니다. [참조 구현과 API](https://github.com/mpariente/pystoi), [실제 계산 소스](https://github.com/mpariente/pystoi/blob/master/pystoi/stoi.py)를 따른다.

## 음원별 계산과 홈페이지 연결

선정 원음은 유채원의 작업 지시 1·2와 김도연의 경고 1이다. [음원 설정](../data/metadata/dataset.json)의 원음 3개와 무처리 36개·초기 고정형 SS 36개를 준비한 뒤 프로젝트 루트에서 실행한다.

```powershell
.\.venv\Scripts\python.exe -m metrics.calculate_metrics --algorithm noisy --algorithm ss_fixed
```

공통 샘플레이트와 지연 탐색 범위를 바꾸려면 다음과 같이 지정한다.

```powershell
.\.venv\Scripts\python.exe -m metrics.calculate_metrics --algorithm noisy --algorithm ss_fixed --sample-rate 16000 --max-delay-seconds 0.5
```

내부 호출 방식은 다음과 같다. `calculate_dataset` 자체는 파일을 쓰지 않는다.

```python
from metrics.calculate_metrics import calculate_dataset, write_results

rows = calculate_dataset()  # 다섯 방식의 전체 180개 음원이 준비된 경우
write_results(rows, "metrics/results")
```

배치는 음원 ID·녹음자·문장·소음·SNR·처리 방식과 경로를 검사한다. 기준 음성은 문장에 고정된 원음에 대응시킨다. 소음 원본 3개는 청취용이며 평가 대상에서 제외한다. 하나라도 실패하면 `BatchCalculationError`에 음원별 오류를 담고 기본 명령은 결과를 저장하지 않은 채 종료한다. 기존 결과 파일은 덮어쓰지 않는다.

`calculate_dataset(..., sample_ids=[...])`로 계산할 음원 ID를 선택할 수 있다. CLI의 `--algorithm`은 여러 번 지정할 수 있으며, 생략하면 무처리와 네 가지 처리 방식의 전체 180개를 계산한다.

결과는 `metrics/results/stoi_estoi.csv`와 `stoi_estoi.json`에 기록한다. 두 파일을 먼저 임시 파일로 준비하고 CSV, 홈페이지 기본 입력인 JSON 순서로 교체한다.

실제 음원과 계산 결과는 GitHub에서 제외한다. 경로 정의와 계산 코드만 공유하므로 다른 PC에서는 원본을 별도 전달받아 계산한다.

필드는 다음과 같다.

```text
sample_id,stoi,estoi,tool_version,reference_id,reference_path,compared_path,
reference_sha256,compared_sha256,sample_rate,samples,reference_sample_rate,
compared_sample_rate,alignment_max_delay_seconds,alignment_delay_samples,
alignment_correlation,reference_trim_start,reference_trim_end,
compared_trim_start,compared_trim_end,calculated_at
```

`sample_rate`와 `samples`는 실제 계산 구간의 공통 샘플레이트와 샘플 수다. `reference_sample_rate`와 `compared_sample_rate`는 원본 파일의 샘플레이트다. 지연과 앞·뒤 제외량은 모두 공통 샘플레이트의 샘플 단위다. `alignment_delay_samples`가 양수이면 비교 음성이 기준 음성보다 늦고, 음수이면 빠르다. `alignment_correlation`은 정렬된 구간의 Pearson 상관계수다. 계산 도구 버전은 `cnr/2`로 기록한다.

두 점수·버전과 함께 실제 읽은 원본 파일 바이트의 SHA-256과 경로를 기록한다. 홈페이지에 결과 파일을 가져오면 지표 표·개선량·상관분석이 같은 음원 ID로 연결된다. 계산 후 원음이나 처리 음원을 변경했거나 다른 경로·임시 WAV로 바꾼 경우 해당 점수를 표시하지 않는다. 다시 계산해야 한다.

## 검증 범위

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s metrics/tests -v
```

검증용 신호·임시 WAV로 일반·확장 참조 호출과의 일치, 44.1/48 kHz에서 16 kHz로의 변환, 비교 음성의 8 kHz 변환, 양·음의 지연, 같은 길이 파일의 지연, 소음·극성 반전, 보정값·실제 계산 구간의 기록, 형식·무음·짧은 발화 오류, 180개 기준 대응, CSV·JSON 저장, 실패 시 기존 결과 보존을 검사한다. 홈페이지 테스트에는 Python이 만든 임시 결과를 실제로 읽어 파일 지문·개선량 연결까지 확인하는 검사가 있다.

시험 데이터와 검증 결과는 임시 폴더에 보관한다. 실제 연구 음원의 측정 SNR과 보정 후 발화 구간은 별도로 확인한다.
