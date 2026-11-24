const previousVisibility = new WeakMap();
const pages = {
  'prefilter-listening': ['청취평가 준비 중', '전체 처리와 객관 지표 계산 후 평가 음원을 선정합니다.'],
  demo: ['처리 결과 준비 중', '공통 후보를 선정한 뒤 Butterworth 전처리와 세 알고리즘의 전체 조합을 처리합니다.'],
  metrics: ['객관 평가 준비 중', '완료된 최종 처리 음원 전체의 STOI·ESTOI를 계산해 연결합니다.'],
  'listening-test': ['청취평가 준비 중', '새 평가 음원·문항·배정을 확정한 뒤 참여를 시작합니다.'],
  analysis: ['비교 보고서 준비 중', '재분석 근거와 처리 결과, 객관 지표와 청취 응답을 같은 조건으로 연결합니다.'],
};

export function renderResearchPhase(document, preparing) {
  const banner = document.querySelector('#research-phase');
  if (banner) banner.hidden = !preparing;
  for (const [id, [title, description]] of Object.entries(pages)) {
    const section = document.querySelector('#' + id);
    if (!section) continue;
    let notice = [...section.children].find(child => child.dataset.researchPreparing === 'true');
    if (!notice && !preparing) continue;
    if (!notice) {
      notice = document.createElement('div'); notice.className = 'panel'; notice.dataset.researchPreparing = 'true';
      notice.setAttribute('role', 'status');
      const heading = document.createElement('h1'), text = document.createElement('p');
      heading.textContent = title; text.textContent = description; notice.append(heading, text); section.append(notice);
    }
    for (const child of section.children) {
      if (child === notice) continue;
      if (preparing) {
        if (!previousVisibility.has(child)) previousVisibility.set(child, child.hidden);
        child.hidden = true;
      } else if (previousVisibility.has(child)) {
        child.hidden = previousVisibility.get(child); previousVisibility.delete(child);
      }
    }
    notice.hidden = !preparing;
  }
}
