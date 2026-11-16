# 초기 웹사이트 요구사항

> 2026-11-15 검토: 이 문서의 아래 본문은 이전 설계·검토 기록이다. 현재 실행 지침은 [협업 안내](../CONTRIBUTING.md), 화면·데이터 구조는 [사이트 구조](../site/ARCHITECTURE.md), 평가는 [평가 프로토콜](evaluation-protocol.md)을 따른다. 과거 폴더·시작 파일·브라우저 저장·종이 전용 수집·미완료 표시는 당시 기록으로 보존한다.

## 현재 기준 요약

현재 운영 소스는 `site/frontend/`·`site/backend/`·`site/shared/`로 분리돼 있고 일곱 메뉴·QR/D1 수집을 사용한다. 계산은 독립 `metrics/`, 완료 JSON·CSV는 `results/metrics/`다. `calculate-metrics.cmd`로 계산하고 `build-site.cmd`로 결과 검증·반영·웹 빌드를 실행한다. 웹 빌드는 계산기를 호출하지 않으며 운영 배포는 별도다. 자동 지표 전달에는 DB가 필요하지 않고 D1은 공유 청음 응답·설정 등에 사용한다.

로컬 검증 기준은 WAV 78개와 무처리·초기 SS 지표 72개다. 실제 청음 응답 건수는 운영 DB에서 확인한다. 과거 로컬 홈페이지·시작 파일과 미사용 UI·D1 예제는 현재 저장소에 포함하지 않는다.

## 아래는 과거 기록


WEBSITE_REQUIREMENTS — 연구용 음성 평가 웹사이트
1. 목적과 제외 범위
- 목적: 연구 데이터 조회 → 비교 청취 → 객관 지표 확인 → 종이 청취 평가 결과 입력 → Spearman 분석.
- 사용 주체: 발표자/연구자(웹사이트 조작 및 결과 입력). 청취자는 홈페이지를 조작하지 않고 종이에 평가한다.
- 발표 슬라이드는 별개. 웹사이트는 음원 시연 및 데이터 관리 도구로 사용.
- MVP에는 브라우저 내 C/C++ 소음 저감 실행, 실시간 블루투스 통신, 청취자 개인 로그인 기능을 포함하지 않음.
2. 메뉴와 세부 기능
2.1 Dashboard
- 조건별 입력/출력 WAV 개수, 검증 상태, STOI/ESTOI 계산 완료 수
- 청취자 수, 입력한 평가 건수, 아직 미평가인 음원 수
- 계산 불가 또는 데이터 누락 경고 표시
2.2 Audio Dataset
- 종류: clean / noise / mixed / processed
- 검색/필터: 소음 조건, SNR, 문장, 처리 알고리즘
- 파일 정보: 파일명, 상대경로, 길이, 샘플링 주파수, 채널 수, 형식, 파일 상태
- 미리듣기, 다운로드; 없는 파일은 재생 버튼 비활성화
- 등록용/평가용 소음 자료 분리 정보 표시
2.3 Audio Comparison
- 선택 순서: 소음 유형 → SNR → 문장 → 출력 방식
- 깨끗한 원본(연구자 전용), 무처리 합성, 처리 결과를 동일 조건으로 재생
- A/B 비교 재생, 정지, 반복, 이전 음성 자동 정지, 재생 길이/시간 표시
- 평가 모드에서는 알고리즘 이름과 객관적 점수 숨기기 및 블라인드 코드 사용
- 발표용 1초 소음 미리듣기는 별도 파일로 연결; 본 평가 파일과 구분
2.4 Objective Metrics
- 오디오 ID별 STOI·ESTOI 및 계산 완료 여부
- ΔSTOI = processed STOI - noisy STOI, ΔESTOI = processed ESTOI - noisy ESTOI
- 소음 유형별·SNR별 표/그래프, 동일 입력에 대한 방법별 비교
- 잘못된 정렬·형식의 데이터는 계산 성공으로 표시하지 않음
2.5 Evaluation Entry — 발표자 종이 평가 전사
- 청취자에게는 종이 평가지 배포. 발표자는 홈페이지에서 음원을 재생하고, 수거한 용지를 그대로 입력.
- 입력 키: session_id, participant_id(익명), audio_id(또는 블라인드 코드)
- 입력값: 소음 방해/자연스러움 점수(각 0/2.5/5/7.5/10), 핵심 정보 정답 여부와 청취 기록, 필요시 메모. 이해도는 핵심정보 정답률로 대체한다.
- 같은 음원을 여러 명이 채점하면 평가자 행 여러 개로 입력. 빠른 표 형식 일괄 입력 지원
- 필수값 검증, 저장, 수정, 미입력 표시, 중복 입력 방지, CSV 내보내기
- 읽은 문장 정답과 객관적 점수는 입력 화면에서 연구자 전용으로 처리, 평가자에게 공개하지 않음
- 저장 성공을 확인할 수 있는 지속성 필요: 브라우저 로컬스토리지(단일 장치) + JSON/CSV 백업, 또는 경량 백엔드/DB 중 선택. UI에서 ‘저장’ 표시만 하는 가짜 저장 금지
2.6 Correlation Analysis
- 같은 audio_id에 대해 STOI, ESTOI, keyword_accuracy, mean_noise_interference, mean_naturalness 연결
- 주분석: Spearman ρ(STOI, 핵심정보 정답률), Spearman ρ(ESTOI, 핵심정보 정답률). 소음 방해·자연스러움 평균은 보조 분석으로 비교한다.
- 보조분석: 각 지표 ↔ 핵심 정보 정답률, 소음/SNR별 하위 분석
- 유효 쌍의 개수 N, 제외된 음원 수와 이유, 동률 여부, 계산 불가 이유 표시
- 막대차트·산점도/점수 순위표, CSV 내보내기
- 동일 문장 반복·작은 표본으로 통계적 일반화 제한 안내
3. 최소 데이터 구조
엔터티	핵심 필드	설명
audio_files	audio_id, type, noise_type, snr_db, sentence_id, method, path, status	파일 조회 및 재생
objective_scores	audio_id, stoi, estoi, reference_id, calculated_at	객관적 측정
participants	participant_id	익명 평가자
sessions	session_id, date, notes	발표/평가 세션
ratings	session_id, participant_id, audio_id, noise_interference, naturalness, keyword_correct_count, keyword_total_count	종이 평가 전사


- audio_id는 모든 표의 조인 기준.
- ST(O)I와 ESTOI 점수는 해당 음성의 조건과 clean 기준 파일을 함께 기록.
- 누락 값은 0점으로 임의 치환하지 않고 null/미입력으로 저장.
4. 사용자 흐름
1. 홈페이지에서 조건 선택 → 합성/처리 음원 재생
2. 청취자 종이 채점 → 발표자가 용지 수거
3. 평가자별 점수를 표에 입력 → 검증 후 저장
4. 평균점수 및 정답률 집계 → STOI·ESTOI 연결
5. Spearman ρ와 시각화 자동 갱신 → CSV/이미지로 결과 보관
5. 구현 단계 (MVP)
- [ ] 파일 메타데이터 목록 로딩 및 조건 필터
- [ ] WAV 재생기 연결 및 자동 정지
- [ ] STOI·ESTOI 결과 JSON 로딩
- [ ] 평가자별 점수 일괄 입력 + 지속적 저장/백업
- [ ] 결측/중복 검증 및 청취 평균 계산
- [ ] Spearman 상관분석과 N/계산불가 표시
- [ ] 평가 결과 CSV 내보내기
6. 수용 기준
- 한 조건에서 무처리/초기 고정형 음원을 선택해 재생 가능
- 실존하지 않는 WAV/점수는 미생성·미측정으로 표시
- 5명 평가자가 동일 음원을 채점해도 독립적으로 보존
- 재실행 후 저장된 평가 결과 재조회 가능
- STOI/ESTOI가 모두 있는 음원 여러 개에서 상관계수 계산 가능
- 한 음원만 있거나 사람 평가가 모두 같으면 '상관계수 계산 불가' 표시
