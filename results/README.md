# 연구 결과 데이터

계산 코드는 `../metrics/`, 계산된 데이터는 이 폴더에서 관리한다. 원본 WAV는 기존 `data/`와 `outputs/`에 둔다. 실제 결과 JSON·CSV는 GitHub에서 제외하고 별도로 전달한다.

```text
metrics/                  독립 Python STOI·ESTOI 계산 코드와 검증
results/metrics/
├─ stoi_estoi.json         홈페이지에 전달할 완료 결과
└─ stoi_estoi.csv          분석·보관용 결과
site/public/metrics/results/stoi_estoi.json
                          검증을 통과한 홈페이지 배포 사본
```

## 실행 순서

프로젝트 루트에서 프로젝트 내부 도구로 실행한다.

```powershell
# 계산 담당: 준비된 무처리·초기 SS 72개를 계산
.\calculate-metrics.cmd

# 홈페이지 담당: 완료된 JSON 반영 → 사이트 검증 → 빌드
.\build-site.cmd
```

계산과 웹 빌드는 각각 실행한다. 웹 빌드는 Python 계산기를 호출하지 않는다. 다른 PC에서 계산한 `stoi_estoi.json`을 `results/metrics/`에 전달해도 같은 반영 경로를 사용할 수 있다. 결과에 대응하는 WAV는 기존 경로로 별도 전달해야 재생·입력 지문 검증이 가능하다.

## 전달 계약

JSON은 음원별 결과 객체의 배열이다. 각 행에 `sample_id`, 실제 숫자인 `stoi`·`estoi`, `tool_version`, `reference_id`·두 입력 경로·두 SHA-256, `sample_rate`, `samples`, `calculated_at`이 필요하다. 계산기가 기록한 리샘플링·지연·구간 메타데이터도 그대로 보존한다. 필드별 의미는 [계산 안내](../metrics/README.md)를 따른다.

`site/scripts/import-metric-results.mjs`가 ID·중복·점수 범위·계산 출처를 검증한 뒤 홈페이지 사본을 교체한다. 빈 결과·손상된 JSON·검증 실패 시 기존 홈페이지 사본은 유지하고 빌드를 중단한다. 계산 원본은 수정하지 않는다. 홈페이지는 JSON을 읽어 표·개선량·그래프를 만들며 STOI·ESTOI를 계산하지 않는다.

웹사이트의 JSON 백업과 별개로 이 폴더의 계산 원본 JSON·CSV와 대응 WAV를 보관한다. 웹 백업에 포함된 정규화 지표만으로 전체 리샘플링·지연·계산 구간 내역을 대체하지 않는다.

## DB의 역할

완료된 지표 결과 전달·표시는 JSON 파일로 처리하므로 DB가 필요하지 않다. 현재 D1은 QR 회차·참가자·청음 응답·진행 상태·설정과 기존 웹 수동 입력 기능의 저장용으로 유지한다. 자동 계산 결과의 원본은 `results/metrics/`이며 DB 업로드를 거치지 않는다. 배포 음원 목록과 정적 음원 재생도 DB 없이 사용할 수 있다.
