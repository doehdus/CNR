import {normalizeSSFixed, selectSSConditions, SS_METHODS, SS_NOISES} from './ss-fixed-data.js';
const $ = selector => document.querySelector(selector);
const value = n => n.toFixed(5);
const delta = n => (n > 0 ? '+' : '') + n.toFixed(5);
const methodLabels = {input:'Butterworth만 적용',ss1:'고정형 SS · 감산 1',ss5:'고정형 SS · 감산 5'};
function node(tag,text,className) {
  const element=document.createElement(tag);
  if(text!==undefined) element.textContent=text;
  if(className) element.className=className;
  return element;
}
function table(host,headers,rows) {
  const element=node('table'), head=node('thead'), tr=node('tr');
  headers.forEach(label=>{const th=node('th',label);th.scope='col';tr.append(th);});head.append(tr);
  const body=node('tbody');
  for(const row of rows){const tr=node('tr');row.forEach((text,index)=>{const cell=node(index===0?'th':'td',String(text));if(index===0)cell.scope='row';tr.append(cell);});body.append(tr);}
  element.append(head,body);host.replaceChildren(element);
}
export function createSSFixed() {
  let data=null, loading=null;
  function choices(){return {bpf:$('#ss-bpf').value,noise:$('#ss-noise').value,snr:$('#ss-snr').value};}
  function stop(){document.querySelectorAll('#ss-fixed audio').forEach(audio=>audio.pause());}
  function renderOverview() {
    table($('#ss-overall'),['처리 조합','STOI 평균','Δ STOI','ESTOI 평균','Δ ESTOI','STOI 상승 / 하락','ESTOI 상승 / 하락'],data.summary.map(s=>[
      `버터워스 ${s.bpf.slice(-1)} + 감산 ${s.alpha}`,value(s.stoi_mean),delta(s.delta_stoi_mean),value(s.estoi_mean),delta(s.delta_estoi_mean),`${s.stoi_increased} / ${s.stoi_decreased}`,`${s.estoi_increased} / ${s.estoi_decreased}`
    ]));
    $('#ss-summary-text').textContent='각 144조건 평균에서 네 조합 모두 지표가 상승했고, 두 Butterworth 모두 감산 1의 평균 점수가 감산 5보다 높았습니다. 감산 5에서는 지표가 하락한 조건도 함께 확인됩니다.';
  }
  function renderGroup() {
    stop();const selection=choices(),rows=selectSSConditions(data,selection);
    const options=$('#ss-statement'), previous=options.value;
    options.replaceChildren(...data.recordings.map(r=>{const o=node('option',`${r.id.startsWith('instruction')?'작업 지시':'위험 경고'} ${r.id.slice(-2)} · ${r.speaker}`);o.value=r.id;return o;}));
    if(data.recordings.some(r=>r.id===previous))options.value=previous;
    $('#ss-group-title').textContent=`버터워스 ${selection.bpf.slice(-1)} · ${SS_NOISES[selection.noise]} · 입력 SNR ${selection.snr}dB`;
    table($('#ss-group-metrics'),['문장 · 화자','필터 STOI','감산 1 STOI (Δ)','감산 5 STOI (Δ)','필터 ESTOI','감산 1 ESTOI (Δ)','감산 5 ESTOI (Δ)'],data.recordings.map(record=>{
      const r=rows.find(row=>row.statement===record.id),m=r.methods;
      return [`${record.id.startsWith('instruction')?'작업 지시':'위험 경고'} ${record.id.slice(-2)} · ${record.speaker}`,value(m.input.stoi),`${value(m.ss1.stoi)} (${delta(m.ss1.stoi-m.input.stoi)})`,`${value(m.ss5.stoi)} (${delta(m.ss5.stoi-m.input.stoi)})`,value(m.input.estoi),`${value(m.ss1.estoi)} (${delta(m.ss1.estoi-m.input.estoi)})`,`${value(m.ss5.estoi)} (${delta(m.ss5.estoi-m.input.estoi)})`];
    }));
    renderAudio();
  }
  function renderAudio() {
    stop();const row=selectSSConditions(data,choices()).find(r=>r.statement===$('#ss-statement').value),record=data.recordings.find(r=>r.id===row.statement);
    $('#ss-selected-text').textContent=record.text;$('#ss-selected-speaker').textContent=record.speaker;
    const cards=SS_METHODS.map(method=>{
      const item=row.methods[method],card=node('div',undefined,'ss-audio-card');
      card.append(node('h3',methodLabels[method]));
      const audio=node('audio');audio.controls=true;audio.preload='none';audio.src='/dataset/audio/'+item.path;audio.setAttribute('aria-label',`${record.text} · ${methodLabels[method]}`);
      audio.addEventListener('play',()=>document.querySelectorAll('audio').forEach(other=>{if(other!==audio)other.pause();}));
      audio.addEventListener('error',()=>{card.append(node('p','음원을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.','ss-audio-error'));},{once:true});
      card.append(audio,node('p',`STOI ${value(item.stoi)} · ESTOI ${value(item.estoi)}`,'ss-score'));
      if(method!=='input')card.append(node('p',`필터 대비 Δ ${delta(item.stoi-row.methods.input.stoi)} / ${delta(item.estoi-row.methods.input.estoi)}`,'ss-delta'));
      return card;
    });
    $('#ss-audio-cards').replaceChildren(...cards);
  }
  async function load() {
    if(data)return;
    if(loading)return loading;
    loading=(async()=>{try{
      const response=await fetch('/dataset/ss_fixed/results.json');if(!response.ok)throw Error('자료를 불러오지 못했습니다.');
      data=normalizeSSFixed(await response.json());$('#ss-error').hidden=true;renderOverview();$('#ss-content').hidden=false;$('#ss-status').textContent='576개 처리 · 지표 계산 완료';renderGroup();
    }catch(e){data=null;$('#ss-content').hidden=true;$('#ss-status').textContent='비교 자료 확인 필요';$('#ss-error').textContent='SS 비교 자료를 불러오지 못했습니다. 새로고침 후 다시 확인해 주세요.';$('#ss-error').hidden=false;}
    finally{loading=null;}})();return loading;
  }
  function initialize() {
    for(const id of ['#ss-bpf','#ss-noise','#ss-snr'])$(id).addEventListener('change',renderGroup);
    $('#ss-statement').addEventListener('change',renderAudio);
  }
  return {initialize,load};
}
