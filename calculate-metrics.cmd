@echo off
rem STOI와 ESTOI 계산을 시작하는 실행 파일이다.
rem 환경 변수 변경을 이 실행 안으로 한정하고 프로젝트 폴더로 이동한다.
setlocal
pushd "%~dp0"
rem 인수가 없으면 현재 준비된 무처리 36개와 초기 고정형 SS 36개를 계산한다.
rem 인수가 있으면 사용자가 지정한 계산 옵션을 그대로 전달한다.
if "%~1"=="" (
    "%~dp0.venv\Scripts\python.exe" -m metrics.calculate_metrics --algorithm noisy --algorithm ss_fixed
) else (
    "%~dp0.venv\Scripts\python.exe" -m metrics.calculate_metrics %*
)
set "calculationExit=%errorlevel%"
rem 원래 폴더로 돌아간 뒤 Python의 성공 또는 실패 종료 코드를 전달한다.
rem 계산 결과는 기본으로 results/metrics/의 JSON과 CSV에 저장된다.
popd
exit /b %calculationExit%
