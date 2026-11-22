import { normalizePrefilterMetrics,prefilterMetricInputsMatch } from './prefilter-metrics-data.js';
import { element as el,analysisTable } from './peak-analysis.js';
const $=selector=>document.querySelector(selector);
const noises={single:'단일 소음',complex:'복합 소음',changing:'변화 소음'};
const score=v=>v.toFixed(4);
const delta=v=>{ const rounded=Number(v.toFixed(5)); return (rounded>0?'+':'')+rounded.toFixed(5); };
const direction=v=>v>0?'increase':v<0?'decrease':'unchanged';

export function createPrefilterAnalysis({fingerprints}) {
  let data=null,error='',key='',metric='stoi',snr=20;
  const metricButtons=[],snrButtons=[];
  async function load() {
    data=null;error='';key='';
    try {
      const response=await fetch(new URL('../dataset/prefilter_analysis/results.json',location.href),{cache:'no-store'});
      if(response.status===404) return;
      if(!response.ok) throw Error('필터링 분석 결과를 읽지 못했습니다.');
      data=normalizePrefilterMetrics(await response.json());
    } catch(failure) { error=failure.message; }
  }
  function matrix() {
    const table=el('table','condition-matrix prefilter-score-matrix'),cols=el('colgroup'),head=el('thead'),heading=el('tr'),body=el('tbody');
    table.append(el('caption','sr-only',metric.toUpperCase()+' · 입력 SNR '+snr+'dB · 무처리와 Butterworth 처리의 12음원·3소음 비교'));
    cols.append(el('col','prefilter-score-recording-column'));
    for(const noise of Object.keys(noises)) cols.append(el('col','prefilter-score-noise-column'));
    for(const text of ['음원',...Object.values(noises)]) { const th=el('th','',text);th.scope='col';heading.append(th); }
    head.append(heading);
    for(const recording of data.recordings) {
      const tr=el('tr'),th=el('th','prefilter-recording');th.scope='row';
      th.append(el('strong','',(recording.category==='warning'?'위험 경고 ':'작업 지시 ')+recording.id.slice(-2)),
        el('span','prefilter-speaker',recording.speaker),el('small','prefilter-sentence',recording.text));tr.append(th);
      for(const [noise,label] of Object.entries(noises)) {
        const row=data.conditions.find(r=>r.statement===recording.id&&r.noise===noise&&r.snr===snr),cell=el('td'),pair=el('div','prefilter-score-pair');
        cell.dataset.noise=noise;cell.dataset.statement=recording.id;cell.dataset.snr=String(snr);
        for(const [field,title] of [['baseline','무처리'],['filtered','필터링 후']]) {
          const line=el('div','prefilter-score-line '+field);line.append(el('span','',title),el('strong','',score(row[field][metric])));pair.append(line);
        }
        pair.append(el('div','prefilter-delta '+direction(row.delta[metric]),'Δ '+delta(row.delta[metric])));
        cell.setAttribute('aria-label',recording.id+' · '+label+' · '+metric.toUpperCase()+' 무처리 '+score(row.baseline[metric])+', 필터링 후 '+score(row.filtered[metric])+', 변화량 '+delta(row.delta[metric]));
        cell.append(pair);tr.append(cell);
      }
      body.append(tr);
    }
    table.append(cols,head,body);return table;
  }
  function render() {
    const ready=prefilterMetricInputsMatch(data,fingerprints()),next=[data?.run_id,metric,snr,ready,error].join('|');
    if(next===key) return;key=next;
    $('#prefilter-analysis-status').textContent=ready?'144조건 · 288음원 계산 완료':error||(data?'음원 지문이 달라 분석 표시를 보류했습니다.':'완료된 STOI·ESTOI 계산 결과 등록 대기');
    $('#prefilter-analysis-status').classList.toggle('ready',ready);$('#prefilter-analysis-status').classList.toggle('pending',!ready);
    $('#prefilter-analysis-content').hidden=!ready;if(!ready) return;
    for(const button of metricButtons) { const active=button.dataset.metric===metric;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active)); }
    for(const button of snrButtons) { const active=Number(button.dataset.snr)===snr;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active)); }
    const summary=data.summaries.find(s=>s.snr===snr)[metric];
    $('#prefilter-analysis-scope').textContent='입력 SNR '+snr+'dB · '+metric.toUpperCase()+' · 36쌍 평균';
    $('#prefilter-mean-baseline').textContent=score(summary.baseline);$('#prefilter-mean-filtered').textContent=score(summary.filtered);
    $('#prefilter-mean-delta').textContent=delta(summary.delta);$('#prefilter-mean-delta').className='prefilter-delta '+direction(summary.delta);
    $('#prefilter-analysis-title').textContent=metric.toUpperCase()+' 전후 비교';
    $('#prefilter-analysis-matrix').replaceChildren(matrix());
    $('#prefilter-metric-tool').textContent=data.tool_version;
    $('#prefilter-metric-calculated').textContent='계산 회차 '+data.run_id+' · 전체 144조건 / 기준음 12개';
    const csv=new URL('../dataset/prefilter_analysis/comparison.csv',location.href);csv.searchParams.set('v',data.artifacts['comparison.csv']);$('#prefilter-analysis-csv').href=csv.href;
  }
  function initialize() {
    for(const value of ['stoi','estoi']) {
      const button=el('button','prefilter-kind-button',value.toUpperCase());button.type='button';button.dataset.metric=value;
      button.addEventListener('click',()=>{metric=value;render();});metricButtons.push(button);$('#prefilter-metric-options').append(button);
    }
    for(const value of [20,10,5,0]) {
      const button=el('button','prefilter-snr-button',value+' dB');button.type='button';button.dataset.snr=String(value);
      button.addEventListener('click',()=>{snr=value;render();});snrButtons.push(button);$('#prefilter-analysis-snr-options').append(button);
    }
  }
  function report() {
    const host=el('div');
    if(!data||!prefilterMetricInputsMatch(data,fingerprints())) {host.append(el('p','','유효한 필터링 지표 등록 대기'));return host;}
    const mean=data.summaries.find(s=>s.snr===null);
    host.append(el('p','','전체 144조건 · 같은 Clean 기준음·공통 구간 · 무처리 원본과 실제 BPF 처리 파일 비교'));
    const table=el('div');analysisTable(table,['지표','무처리 평균','필터링 후 평균','평균 변화량'],['stoi','estoi'].map(m=>[m.toUpperCase(),score(mean[m].baseline),score(mean[m].filtered),delta(mean[m].delta)]));host.append(table);
    return host;
  }
  return {load,render,initialize,report};
}
