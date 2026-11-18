import { normalizePeakAnalysis, peakInputsMatch } from './peak-analysis-data.js';
const $ = selector => document.querySelector(selector);
const el = (tag, cls = '', text = '') => { const e = document.createElement(tag); e.className = cls; e.textContent = text; return e; };
const n = value => Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '미검출';
const labels = {single:'단일 · 콘크리트 절단기 B',complex:'복합 · 절단기 B + 드릴',changing:'변화 · 2.5초부터 드릴 추가'};
function table(target, headers, rows) {
  const t = el('table'), head = el('thead'), tr = el('tr'), body = el('tbody');
  for (const label of headers) { const th = el('th', '', label); th.scope = 'col'; tr.append(th); } head.append(tr);
  for (const values of rows) { const row = el('tr'); for (const value of values) row.append(el('td', '', value)); body.append(row); }
  t.append(head, body); $(target).replaceChildren(t);
}
function chart(target, title, frequency, lines, filename, { peaks = [], minHz = 0, maxHz = 8000 } = {}) {
  const figure = el('figure','noise-figure measured-figure'), canvas = el('canvas'), caption = el('figcaption','',title);
  canvas.width=1440; canvas.height=510; canvas.setAttribute('role','img'); canvas.setAttribute('aria-label', title + '。가로축 주파수 Hz, 세로축 PSD dBFS/Hz. 수치는 아래 표 참조.');
  const c=canvas.getContext('2d'), left=95,right=1400,top=85,bottom=425;
  const x=f=>left+(f-minHz)/(maxHz-minHz)*(right-left), y=v=>bottom-(v+120)/120*(bottom-top);
  c.fillStyle='#fff';c.fillRect(0,0,1440,510);c.font='22px sans-serif';c.fillStyle='#213d35';c.fillText(title, left, 33);
  c.font='17px sans-serif';
  for(let tick=-120;tick<=0;tick+=20){c.strokeStyle='#e6ece8';c.beginPath();c.moveTo(left,y(tick));c.lineTo(right,y(tick));c.stroke();c.fillStyle='#53695e';c.fillText(String(tick),25,y(tick)+6);}
  for(let i=0;i<=8;i++){const hz=minHz+(maxHz-minHz)*i/8;c.strokeStyle='#edf1ee';c.beginPath();c.moveTo(x(hz),top);c.lineTo(x(hz),bottom);c.stroke();c.fillStyle='#53695e';c.fillText(String(Math.round(hz)),x(hz)-18,bottom+28);}
  c.fillText('주파수 (Hz)',650,493);c.fillText('PSD (dBFS/Hz)',left,65);
  c.save();c.beginPath();c.rect(left,top,right-left,bottom-top);c.clip();
  lines.forEach(line=>{c.strokeStyle=line.color;c.lineWidth=2;c.setLineDash(line.dash||[]);c.beginPath();let first=true;frequency.forEach((f,i)=>{if(f<minHz||f>maxHz)return;if(first){c.moveTo(x(f),y(line.values[i]));first=false;}else c.lineTo(x(f),y(line.values[i]));});c.stroke();});
  c.setLineDash([]);c.restore();
  lines.forEach((line,i)=>{const pos=820+i*190;c.fillStyle=line.color;c.fillRect(pos,48,24,4);c.fillStyle='#334e43';c.fillText(line.label,pos+30,57);});
  peaks.forEach((p,i)=>{if(p.frequency_hz<minHz||p.frequency_hz>maxHz)return;c.fillStyle='#b35a16';c.beginPath();c.arc(x(p.frequency_hz),y(p.magnitude_db),4,0,Math.PI*2);c.fill();if(i<3){c.font='16px sans-serif';c.fillText(Math.round(p.frequency_hz)+' Hz',Math.min(right-80,x(p.frequency_hz)+8),y(p.magnitude_db)-12-i%2*20);}});
  const save=el('button','button secondary small','PNG 저장');save.type='button';save.setAttribute('aria-label', title+' PNG 저장');
  save.addEventListener('click',()=>canvas.toBlob(blob=>{if(!blob)return;const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename+'.png';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);},'image/png'));
  figure.append(canvas,caption,save);$(target).replaceChildren(figure);
}
function player(path,title){const card=el('article','audio-card');card.append(el('h3','',title));const audio=el('audio');audio.controls=true;audio.preload='none';audio.src=new URL('../dataset/audio/'+path,location.href);audio.setAttribute('aria-label',title);card.append(audio);return card;}
export function createPeakAnalysis({fingerprints}) {
  let data=null,error='';const picks=new Map();
  const valid=()=>peakInputsMatch(data,fingerprints());
  async function load(){try{const r=await fetch(new URL('../dataset/peak_analysis/results.json',location.href),{cache:'no-store'});if(r.status===404){data=null;return;}if(!r.ok)throw Error('피크 분석을 불러오지 못했습니다.');data=normalizePeakAnalysis(await r.json());}catch(e){data=null;error=e.message;}}
  function hasNoise(noise){return valid()&&data.sources.some(s=>s.noise===noise);}
  function renderZoom(noise){if(!hasNoise(noise))return;const source=data.sources.find(s=>s.noise===noise);const p=source.peaks.find(p=>p.id===$('#noise-peak-select').value);if(!p){$('#noise-peak-zoom').replaceChildren(el('p','','검출된 피크가 없습니다.'));return;}picks.set(noise,p.id);chart('#noise-peak-zoom',`${p.id} · ${n(p.frequency_hz)} Hz 주변`,data.frequency_hz,[{values:source.psd_db,color:'#316c56',label:'소음 원본'}],`peak_${noise}_${p.id}`,{peaks:[p],minHz:Math.max(0,p.low_hz-100),maxHz:Math.min(8000,p.high_hz+100)});}
  function render(noise){
    if(!hasNoise(noise))return;
    const source=data.sources.find(s=>s.noise===noise), form=$('#noise-mixture-form');
    const current=form.elements.namedItem('statement').value;
    const select=form.elements.namedItem('statement');select.replaceChildren(...data.recordings.map(r=>new Option(`${r.id} · ${r.speaker}`,r.id)));select.value=data.recordings.some(r=>r.id===current)?current:data.recordings[0].id;
    const statement=select.value,snr=Number(form.elements.namedItem('snr').value), recording=data.recordings.find(r=>r.id===statement);
    const row=data.conditions.find(r=>r.noise===noise&&r.snr===snr&&r.statement===statement);
    $('#noise-peaks-count').textContent=`탐색 피크 ${source.peaks.length}개 · 효과 검증 전`;
    $('#noise-peaks-method').textContent='Welch PSD · Hann 2048샘플 / 중첩 1024 · 돌출도 ≥6dB · 최소 간격 46.875Hz · 전력순 최대 8개. 폭은 선형 PSD의 half-prominence 폭이며 필터 대역폭이 아닙니다.';
    chart('#noise-peaks-artifact',labels[noise]+' · 주요 피크',data.frequency_hz,[{values:source.psd_db,color:'#316c56',label:'소음 원본'}],`peaks_${noise}`,{peaks:source.peaks});
    table('#noise-peaks-table',['피크','주파수 (Hz)','PSD (dBFS/Hz)','폭 (Hz)','돌출도 (dB)'],source.peaks.map(p=>[p.id,n(p.frequency_hz),n(p.magnitude_db),n(p.bandwidth_hz),n(p.prominence_db)]));
    const peakSelect=$('#noise-peak-select');peakSelect.replaceChildren(...source.peaks.map(p=>new Option(`${p.id} · ${n(p.frequency_hz)} Hz`,p.id)));peakSelect.disabled=!source.peaks.length;peakSelect.value=picks.get(noise)||source.peaks[0]?.id||'';renderZoom(noise);
    $('#noise-mixture-caption').textContent=`${labels[noise]} · ${snr} dB · ${statement} · ${recording.speaker}`;
    $('#noise-mixture-status').textContent='144조건 분석 연결 · 선택 조건 측정 완료';$('#noise-mixture-status').classList.remove('pending');$('#noise-mixture-status').classList.add('ready');
    $('#noise-mixture-players').replaceChildren(player(`data/reference/${statement}.wav`,'합성과 대응하는 기준음'),player(`data/noise/${noise}.wav`,'소음 원본 · 크기 보정 전'),player(`data/mixed/${noise}/snr${String(snr).padStart(2,'0')}/${statement}.wav`,'무처리 합성음'));
    chart('#noise-mixture-artifact',`${statement} · ${snr} dB · 기준음 / 추가 소음 / 합성음`,data.frequency_hz,[{values:row.speech_db,color:'#2563eb',label:'대응 기준음'},{values:row.noise_db,color:'#bd691c',label:'실제 추가 소음',dash:[6,4]},{values:row.mixture_db,color:'#316c56',label:'합성음'}],`comparison_${noise}_snr${snr}_${statement}`);
    table('#noise-mixture-table',['소음 피크','소음 (Hz)','합성 대응 (Hz)','같은 대역의 기준음','기준음/추가소음 (dB)'],row.observations.map(o=>[o.peak_id,n(source.peaks.find(p=>p.id===o.peak_id).frequency_hz),n(o.mixture_frequency_hz),o.speech_peak_present?'국소 피크 관찰':'피크 미검출 · 음성 부재 의미 아님',n(o.speech_to_noise_db)]));
    $('#noise-mixture-note').textContent=`전체 음원 Welch PSD를 동일 축으로 비교합니다. 주황 선은 합성음에서 대응 기준음을 뺀 실제 추가 소음입니다. 대역 전력비가 0dB보다 크면 기준음이 더 강합니다. 피크 대응 허용 범위는 max(2 bin, 소음 폭/2). SNR 검산 ${n(row.actual_snr_db)}dB · 산정 구간 ${n(row.interval_sec[0])}–${n(row.interval_sec[1])}초. 재생하는 소음 원본은 크기 보정 전입니다. 기준음에는 문장별 공통 이득이 적용됐으며 원본 녹음과 구분합니다.`;
    const candidates=data.sources.flatMap(s=>s.peaks.slice(0,3).map(p=>{const obs=data.conditions.filter(r=>r.noise===s.noise&&r.snr===20).map(r=>r.observations.find(o=>o.peak_id===p.id));return[labels[s.noise],`${n(p.low_hz)}–${n(p.high_hz)}`,`${n(p.frequency_hz)}Hz · 주변 대비 ${n(p.prominence_db)}dB · 측정한 피크 폭`, `12개 기준음 중 ${obs.filter(o=>o.speech_peak_present).length}개에서 국소 피크 관찰`, `2.5초 이후 대역 전력 ${p.time_change_db>=0?'+':''}${n(p.time_change_db)}dB`, '검토 중 · 필터 효과 검증 전'];}));
    table('#noise-candidates-table',['소음','피크 주변 검토 대역 (Hz)','선정 근거','음성과 겹침','시간 구간 차이','검토 상태'],candidates);
  }
  function feedback(){if(error)return error;return data&&!valid()?'피크 분석 입력 음원이 변경됐거나 파일 지문을 확인하지 못해 보완 분석 표시를 보류했습니다.':'';}
  return {load,hasNoise,render,renderZoom,feedback};
}
