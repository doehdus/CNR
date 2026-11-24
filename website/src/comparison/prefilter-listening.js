import {element as el,analysisTable} from './peak-analysis.js';
import qrcode from '../vendor/qrcode.mjs';
const $=s=>document.querySelector(s),fmt=(v,d=2)=>Number.isFinite(v)?v.toFixed(d):'—';
export function createPrefilterListening(){
 let data=null,error='',selected='all',preparing=false;
 async function load(){try{const response=await fetch('/api/prefilter-listening/summary',{cache:'no-store'});const result=await response.json();preparing=response.status===503;if(!response.ok)throw Error(result.error||'평가 현황을 읽지 못했습니다.');data=result;error='';}catch(e){data=null;error=e.message;}render();}
 function render(){
  const status=$('#prefilter-listening-status');if(!status)return;
  $('#prefilter-listening-links').hidden=!data;
  status.textContent=error||(data?`참여 ${data.participants}명 · 완료 ${data.completed}명 · 응답 ${data.responses}개`:'청음평가 현황 확인 중');
  const host=$('#prefilter-listening-means'),result=selected==='all'?data?.overall:data?.groups.find(g=>g.id===selected);
  const values=selected==='all'?result:result?.baseline?result:null;
  const rows=[['핵심정보 정답률','key_rate',true],['음성 자연스러움','naturalness',false],['소음 방해 정도','noise',false]].map(([name,key,percent])=>{
   const multiplier=percent?100:1,suffix=percent?'%':'점',difference=values?.delta?.[key];
   return [name,values?.baseline?fmt(values.baseline[key]*multiplier)+suffix:'—',values?.filtered?fmt(values.filtered[key]*multiplier)+suffix:'—',Number.isFinite(difference)?(difference>0?'+':'')+fmt(difference*multiplier)+(percent?'%p':'점'):'—'];
  });
  analysisTable(host,['평가 항목','무처리 평균','Butterworth 평균','변화량'],rows);
  $('#prefilter-listening-empty').textContent=preparing?'전체 처리와 객관 지표 계산 후 청취평가 음원을 선정합니다.':error?'현황을 불러오지 못했습니다. 잠시 후 새로고침해 주세요.':values?'12개 평가를 완료한 참가자의 대응 응답만 평균에 포함합니다.':selected==='all'?'5개 그룹 모두에 완료 응답이 모이면 전체 평균을 표시합니다. 그룹을 선택하면 해당 그룹의 평균을 먼저 확인할 수 있습니다.':'이 그룹의 완료 응답을 기다리고 있습니다.';
  if(!data)$('#prefilter-listening-counts').replaceChildren();
  if(data)analysisTable($('#prefilter-listening-counts'),['그룹','참여','완료','진행 중','저장 응답'],data.groups.map(g=>['그룹 '+g.id,g.participants+'명',g.completed+'명',(g.participants-g.completed)+'명',g.responses+'개']));
 }
 function initialize(){
  const host=$('#prefilter-listening-links');if(!host)return;host.hidden=true;
  for(let i=1;i<=5;i++){
   const card=el('article','prefilter-group-card'),url=new URL('prefilter-survey.html?group='+i,location.href);
   const label=el('span','prefilter-group-label','GROUP '+String(i).padStart(2,'0')),heading=el('h2','','그룹 '+i),desc=el('p','','6조건 · 전후 12개 음원'),link=el('a','button primary','그룹 '+i+' 평가 참여');link.href=url.href;
   const copy=el('button','button secondary','링크 복사');copy.type='button';copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(url.href);copy.textContent='복사 완료';setTimeout(()=>{copy.textContent='링크 복사';},1800);}catch{copy.textContent='아래 주소를 복사해 주세요.';address.hidden=false;}});
   const address=el('input','prefilter-link-address');address.readOnly=true;address.value=url.href;address.setAttribute('aria-label','그룹 '+i+' 참여 주소');address.hidden=true;address.addEventListener('focus',()=>address.select());
   const detail=el('details','prefilter-qr'),summary=el('summary','','QR 보기'),qr=el('div','prefilter-qr-image');const code=qrcode(0,'M');code.addData(url.href);code.make();qr.innerHTML=code.createSvgTag({cellSize:4,margin:4,scalable:true});
   const svg=qr.querySelector('svg');svg.setAttribute('role','img');svg.setAttribute('aria-label','그룹 '+i+' 참여 QR');
   const save=el('button','button secondary','QR 저장');save.type='button';save.addEventListener('click',()=>{const blob=URL.createObjectURL(new Blob([qr.innerHTML],{type:'image/svg+xml'})),a=el('a');a.href=blob;a.download='prefilter-group-'+i+'.svg';a.click();setTimeout(()=>URL.revokeObjectURL(blob),1000);});
   detail.append(summary,qr,save);card.append(label,heading,desc,link,copy,address,detail);host.append(card);
  }
  $('#prefilter-listening-refresh').addEventListener('click',load);$('#prefilter-listening-group').addEventListener('change',e=>{selected=e.target.value;render();});
  setInterval(()=>{if(!document.hidden&&location.hash==='#prefilter-listening')load();},30000);
 }
 return {initialize,load,render};
}
