# ConstructionNoiseReduction

공사 소음 환경의 음성 저감 연구를 위한 **온라인 데이터 시각화·시연·결과보고서** 프로젝트입니다.

연구자: 김도연 · 유채원

## 팀원 시작 안내

저장소: [doehdus/CNR](https://github.com/doehdus/CNR)

처음 참여하는 팀원은 [협업·환경 구성](CONTRIBUTING.md)과 [문서 안내](docs/README.md)를 먼저 확인합니다. 소스·연구 기준·실행 문서를 공유하며, 원본 음원·실측 결과·평가 응답·비밀정보·개인 문서·설치 도구는 GitHub에서 제외합니다. 필요한 연구 자료는 별도로 전달받아 같은 상대경로에 배치합니다. 자세한 구분은 [파일 공유 기준](docs/repository-policy.md)을 따릅니다.

## 운영 사이트

[CNR 홈페이지 바로 열기](https://cnr.hillyparsnip1.chatgpt.site)

누구나 링크를 눌러 로그인 없이 열람·음원 재생·응답 입력을 이용할 수 있는 공개(Public) 페이지입니다.

## 프로젝트 내부 실행

Node.js 22.23.4와 npm은 `.tools/node-v22.23.4-win-x64/`, Python은 `.tools/python/`와 `.venv/`, 사이트 패키지는 `site/node_modules/`에 설치합니다. 빌드 명령은 프로젝트 내부 실행 파일과 `.cache/` 캐시를 사용합니다.

`C:\ConstructionNoiseReduction`에서 다음 명령을 실행합니다.

```powershell
# 계산이 필요할 때 별도 실행
.\calculate-metrics.cmd

# 완료된 결과 파일을 홈페이지에 반영하고 빌드
.\build-site.cmd
```

계산 코드는 `metrics/`, 완료된 JSON·CSV는 `results/metrics/`에 둡니다. `calculate-metrics.cmd`는 현재 무처리·초기 SS 72개를 계산합니다. `build-site.cmd`는 완료된 JSON만 검증해 반영하고 테스트·타입 검사·음원 수집·사이트 빌드를 수행하며 Python 계산을 실행하지 않습니다. 배포용 결과는 `site/dist/`에 생성됩니다. 다른 환경에서 계산한 JSON도 전달받아 사용할 수 있습니다. [결과 데이터 흐름](results/README.md)과 [코드 검사 안내](CONTRIBUTING.md#검증과-빌드)를 따릅니다.

## 로컬 음원 반영

`C:\ConstructionNoiseReduction`의 아래 경로에 WAV를 넣거나 교체한 뒤 사이트를 다시 배포하면 반영됩니다.

| 음원 | 경로 예시 |
| --- | --- |
| 깨끗한 기준 음성 | data/clean/instruction_01.wav |
| 단일 소음 원본 | data/noise/single.wav |
| 복합 소음 원본 | data/noise/complex.wav |
| 변화 소음 원본 | data/noise/changing.wav |
| 무처리 합성 음성 | data/mixed/single/snr20/instruction_01.wav |
| SS 처리 결과 | outputs/ss_fixed/single/snr20/instruction_01.wav |

소음 원본 3개는 모두 `C:\ConstructionNoiseReduction\data\noise\` 폴더에 저장합니다. 단일 소음은 `single.wav`, 복합 소음은 `complex.wav`, 변화 소음은 `changing.wav`로 이름을 지정합니다. 저장한 WAV는 사이트를 다시 배포하면 반영됩니다.

파일명·소음·SNR별 폴더 규칙은 [사이트 안내](site/README.md#로컬-음원-경로)에 정리했습니다. 로컬 파일의 추가·교체·삭제는 다음 배포에 반영됩니다.

## 홈페이지 구성

코드는 `site/frontend/` 화면, `site/backend/` API·저장·QR 채점, `site/shared/` 공용 연구 로직으로 나눕니다. 자세한 책임과 의존 방향은 [사이트 구조](site/ARCHITECTURE.md)에 정리했습니다.

청음평가의 **QR 회차 만들기 · 진행**에서 음원을 선택하고 QR을 발급합니다. 참가자들은 같은 음원을 듣고 휴대폰으로 답하며, 연구자가 응답 시작과 다음 음원을 제어합니다. 객관식 3문항은 자동채점되고 기존 그래프·집계에 연결됩니다.

1. **데이터파일**: 깨끗한 음원, 소음 원본, SNR 20/10/5/0 dB별 무처리 합성 음원 표
2. **SS 결과물**: 초기 고정형, 사전패턴 고정형, 사전패턴 갱신형, 추가 알고리즘의 SNR별 표와 비교 청음
3. **STOI ESTOI**: 결과물별 두 지표와 무처리 대비 개선량
4. **STOI ESTOI 지표 분석**: SNR별 처리 전후 지표 그래프와 평균 개선량
5. **청음평가**: QR 회차 생성·진행, 수동 응답 입력·가져오기
6. **청음결과표**: 음원별 정답률·5단계 평가 집계, 원응답 확인과 CSV 내보내기
7. **지표청음 비교**: 같은 음원의 지표·정답률·세 평가 항목 비교표, 두 지표의 산점도와 Spearman 분석

상단에서 전체 결과보고서를 인쇄하거나 PDF로 저장할 수 있습니다. CSV 결과표·JSON 백업도 제공합니다.

## 실행·보관 기준

사용자는 배포된 공개 HTTPS 사이트로 접속합니다. 홈페이지에서 열람·재생·입력·설정 변경을 로그인 없이 사용할 수 있으며, 공개 범위는 Sites의 Public 설정으로 관리합니다.

- 홈페이지 소스와 배포 설정: [site/](site/README.md)
- 자동 계산 지표: `results/metrics/` 원본 JSON·CSV와 홈페이지에 반영한 정적 JSON
- QR 회차·청음 응답·경로 설정·웹에서 수동으로 가져온 지표: 서버 D1 데이터베이스
- 로컬 WAV: 배포 빌드가 data/·outputs/에서 수집해 사이트에 포함
- 기존 업로드 WAV: 서버 R2 파일 저장소
- 과거 로컬 구현: 현재 저장소에 포함하지 않으며 운영 대상에서 제외
- C/C++ 음원 처리와 Python 지표 계산: 별도 오프라인 연구 도구로 유지

현재 로컬 연구 환경에서 기준 음성 3개, 소음 원본 3개, 무처리 합성 음원 36개, 초기 고정형 SS 결과 36개로 총 WAV 78개를 연결했습니다. 무처리·초기 고정형 SS 72개의 STOI·ESTOI를 계산했습니다. 이 음원과 실측 결과는 GitHub 업로드 대상에서 제외됩니다. 후속 처리 음원은 추가 등록 대기이며 실제 청음 응답 수집 건수는 운영 D1에서 확인합니다. 183개 음원 ID와 소음 원본 3개의 연결 자리는 실제 보유 파일·평가 완료 수와 구분해 표시합니다.

## 실험 구성

기준 문장 3개 × 소음 3종 × SNR 4단계 = 36조건입니다. 무처리 36개와 네 가지 처리 방식 144개를 합해 평가 대상은 최대 180개입니다. 깨끗한 기준 음성 3개와 소음 원본 3개는 별도입니다.

5단계 척도는 기존 평가 규칙인 0/2.5/5/7.5/10을 유지합니다. QR 정답률은 문장별 객관식 3문항을 `qr-mc-v1` 기준으로 서버에서 자동채점합니다. 수동 응답은 채점 기준 버전과 정답 수·전체 문항 수가 있어야 정답률을 산출합니다.

## 연구 문서

- [전체 문서 안내](docs/README.md)
- [협업·환경 구성](CONTRIBUTING.md)
- [파일 공유 기준](docs/repository-policy.md)
- [확정 기준](PROJECT_CONTEXT.md)
- [실험 프로토콜](docs/experiment-protocol.md)
- [평가 프로토콜](docs/evaluation-protocol.md)
- [사이트 사용·개발](site/README.md)
- [STOI·ESTOI 계산](metrics/README.md)
- [완료 결과 데이터 전달](results/README.md)

이전 설계·개발 이력의 위치와 문서 간 우선순위는 문서 안내에서 확인합니다.
