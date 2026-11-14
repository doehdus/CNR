# 프로젝트 실행 도구

사용자 결정에 따라 `C:\ConstructionNoiseReduction` 내부에 설치된 도구로 작업한다. `C:\Fied`의 실행 파일·코드·설정·패키지를 사용하지 않는다.

- Node.js는 `.tools/node-v22.23.4-win-x64/node.exe`를 사용한다.
- npm은 같은 Node.js 폴더의 `node_modules/npm/bin/npm-cli.js`를 사용한다.
- Python은 `.venv/Scripts/python.exe`를 사용한다. 기반 Python도 `.tools/python/` 안에 있다.
- 사이트 의존성은 `site/node_modules/`, 도구 캐시는 `.cache/`를 사용한다.
- 프로젝트 루트의 `build-site.cmd`가 현재 무처리·초기 고정형 SS 72개의 지표 계산, 사이트에 결과 반영, 테스트, 타입 검사, 음원 수집, 빌드를 수행한다.
- 개별 Node.js 명령을 실행할 때는 프로젝트 내부 Node.js 폴더를 해당 프로세스의 PATH 앞에 추가한다.

운영 사이트 소스는 `site/`이며, 배포 시 `.openai/hosting.json`의 기존 프로젝트 ID를 유지한다.
