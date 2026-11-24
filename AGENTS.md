# 작업 방식

- 프로젝트 방향은 `README.md`, 확정한 자료·평가 기준은 `PROJECT_CONTEXT.md`, 실행 방법은 `CONTRIBUTING.md`를 따른다.
- 작업에 필요한 세부 조건은 해당 단계에서 사용자에게 한 항목씩 확인한다. 파일·코드에서 확인할 수 있는 정보는 직접 확인한다.
- 미정인 파라미터·실험 규모를 임의 확정하지 않는다. 필터 대역·Q/대역폭·감쇠량·소음 추정 방법은 분석·구현 단계에서 정한다.
- 설정·패턴 등록에 사용한 자료와 최종 평가 자료의 관계를 기록한다. 구체적인 구간·자료 분리 방법은 해당 실험을 준비할 때 확인한다.
- 같은 문장·화자·소음·SNR의 결과를 대응시켜 전처리·알고리즘의 효과를 비교한다.
- 원음·완료 결과·청음 응답·기존 변경 사항을 보존한다. 계획 수량과 실제 생성·계산·수집 수량을 구분한다.
- 자료 수량·공통 후보·전체 처리 조합·계획 수량은 `PROJECT_CONTEXT.md`의 최종 목적 기록을 따른다. 청취평가 참여 인원은 미정이다.
- 확정 사항은 담당 문서 한 곳에 모으고 관련 안내는 링크로 연결한다. 준비 단계의 상세 README와 빈 C 파일을 추가하지 않는다. 파일 삭제 전 참조와 중복 여부를 확인한다.

# 실행 도구

프로젝트 내부에 설치된 도구를 사용한다. `C:\Fied`의 실행 파일·코드·설정·패키지를 사용하지 않는다.

- Node.js는 `.tools/node-v22.23.4-win-x64/node.exe`, npm은 같은 폴더의 `node_modules/npm/bin/npm-cli.js`를 사용한다.
- macOS 웹 협업은 Node.js를 준비한 뒤 `website/`에서 `npm ci`·`npm run dev`로 진행한다. 별도 도구 설치기나 실행 래퍼를 추가하지 않는다.
- 개별 Node.js 실행 시 프로젝트 Node.js 폴더를 해당 프로세스의 PATH 앞에 둔다.
- Python은 `.venv/Scripts/python.exe`, 기반 Python은 `.tools/python/`을 사용한다.
- C 컴파일러는 `.tools/tcc/tcc.exe`를 사용하고 실행파일은 `.cache/noise_analysis/`에 둔다.
- 사이트 의존성은 `website/node_modules/`, 캐시는 `.cache/`를 사용한다.
- 객관 계산 도구는 `.venv/Scripts/python.exe code/evaluation/calculate_metrics.py`다. 이전 실험 자료는 정리했으며 새 12문장 카탈로그·처리 방식 연결 후 배치 계산을 실행한다.
- `export/export_results.py`는 완료 지표·대응 WAV를 검증해 `website/public/dataset/`에 전달한다.
- 웹 검증·빌드는 `website/package.json`의 `npm run build`로 통일한다. 루트에 같은 명령을 감싸는 cmd·PowerShell 파일을 추가하지 않는다.

# 작업 경계

- `analysis/`는 분석·그래프, `data/`는 입력, `code/`는 처리·평가 코드, `experiment/`는 새 실험 결과, `export/`는 전달, `website/`는 조회·비교·청음평가를 담당한다.
- 공용 분석 코드는 `analysis/mkgraphs/`, 이전 자료는 `before1123/`에 둔다. 보관본을 활성 결과로 자동 연결하지 않으며 현재 구조와 새 회차 파일 규격은 `CONTRIBUTING.md`를 따른다.
- 화면 소스는 `website/src/collection/`·`comparison/`·`listening-test/`, 서버는 `website/backend/`, 공용 로직은 `website/shared/`에서 수정한다.
- `website/public/dataset/`·`.sites-runtime/`·`dist/`는 생성물이다. 웹 빌드는 내보낸 스냅샷을 사용하며 Python·실험 원본을 호출하지 않는다.
- 현재 원음은 `data/clean/`에서 읽고 새 합성 저장 계획은 `data/mixtures/`다. 기존 평가 카탈로그와의 연결 상태는 `CONTRIBUTING.md`에서 확인한다.
- 새 문항·척도·재생 방식의 구현 상태를 확인하고 기존 질문표·척도·응답 원점수 버전을 보존한다.
- 배포 시 `website/.openai/hosting.json`의 기존 프로젝트 ID·D1·R2 연결을 유지한다.
- 로컬 웹은 `website/wrangler.local.json`과 `.wrangler/local-collab/`을 사용한다. `data/`·`analysis/`·`experiment/`의 연구 음원·합성음원·완료 분석·처리 결과는 팀 공유 자료로 관리하며 도구·캐시·생성된 웹 복사본·실행 DB·배포 인증정보는 제외한다.
- 변경한 계산·전달·웹 경로에 맞는 검증을 수행한다.
