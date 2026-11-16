# 문서 안내

팀원이 처음 합류하면 [프로젝트 소개](../README.md) → [협업·환경 구성](../CONTRIBUTING.md) → [확정 기준](../PROJECT_CONTEXT.md) 순서로 읽는다.

## 현재 기준

| 문서 | 관리 내용 |
| --- | --- |
| [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md) | 최신 결정·구현 상태·연구 범위 |
| [실험 프로토콜](experiment-protocol.md) | 음원 ID·소음·SNR·처리 방식·인수 검증 |
| [평가 프로토콜](evaluation-protocol.md) | QR 평가·채점·객관 지표·집계 기준 |
| [사이트 안내](../site/README.md) | 사이트 사용·음원 경로·개발·배포 |
| [사이트 구조](../site/ARCHITECTURE.md) | 프론트·백엔드·공용 코드와 생성물의 책임·의존 방향 |
| [계산 안내](../metrics/README.md) | STOI·ESTOI 계산·정렬·결과 형식 |
| [결과 데이터](../results/README.md) | 계산→완료 파일→홈페이지 전달과 DB 역할 |
| [협업 안내](../CONTRIBUTING.md) | 환경 구성·브랜치·검증·공유 범위 |
| [파일 공유 기준](repository-policy.md) | Git 업로드 제외·로컬 문서·자료 전달 |

## 이전 설계와 검토 기록

[개발계획 및 변경 이력](development-plan.md), [연구 흐름 검토](research-workflow-review.md), [초기 웹사이트 요구사항](website-requirements.md)은 변경 배경을 확인하는 기록이다. 종이 수집·브라우저 저장·이전 메뉴에 관한 설명은 현재 QR/D1 구현과 다를 수 있다. 과거 기록의 메뉴·폴더·시작 파일·미완료 표시는 당시 상태로 읽고 현재 실행 지침으로 사용하지 않는다. 현재 결정은 `PROJECT_CONTEXT.md`, 실행은 `CONTRIBUTING.md`·`site/README.md`, 상세 평가는 `evaluation-protocol.md`를 따른다. 날짜가 있는 프로토콜의 최신 결정도 먼저 확인한다.

## 문서 관리

확정한 연구 기준은 관련 프로토콜과 `PROJECT_CONTEXT.md`를 함께 수정한다. 실행 절차는 `CONTRIBUTING.md`와 해당 기능의 README에 적는다. 개인 메모·계정·참가자 자료는 [파일 공유 기준](repository-policy.md)에 따라 로컬에 보관한다. 음원 경로 판별에 쓰이는 `PROJECT_CONTEXT.md`는 루트에 유지한다.
