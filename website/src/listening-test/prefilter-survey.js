import {$,element as el,api,storedValue,showMessage} from './survey-common.js';
import {LISTENING_STUDY,LISTENING_SCALES} from './prefilter-listening-data.js';
const group=new URLSearchParams(location.search).get('group'),valid=/^[1-5]$/.test(group||'');
const base='/api/prefilter-listening/groups/'+group,storageKey='cnr-'+LISTENING_STUDY+'-participant';
let token=storedValue(storageKey),view=null,busy=false,trial=-1,pendingPlays=[],playingRequest=false;
const audio=$('#prefilter-audio');
function choice(name,prompt,options){
 const field=el('fieldset','survey-question');field.append(el('legend','',prompt));const list=el('div','survey-options');
 for(const option of options){const label=el('label','survey-option'),input=el('input');input.type='radio';input.name=name;input.value=String(option.id);input.required=true;label.append(input,el('span','',option.label));list.append(label);}field.append(list);return field;
}
function render(next){
 view=next;$('#prefilter-loading').hidden=true;$('#prefilter-join').hidden=true;$('#prefilter-retry').hidden=true;
 $('#prefilter-complete').hidden=!next.completed;$('#prefilter-trial').hidden=next.completed;
 if(next.completed){audio.pause();audio.removeAttribute('src');return;}
 if(next.current_index!==trial){
  audio.pause();trial=next.current_index;pendingPlays=[];$('#prefilter-form').reset();audio.src=next.audio_url;
  $('#prefilter-key-questions').replaceChildren(...next.questions.map(q=>choice('answer.'+q.id,q.prompt,q.options)));
  $('#prefilter-rating-questions').replaceChildren(...LISTENING_SCALES.map(s=>choice(s.name,s.label,s.levels.map((label,i)=>({id:i+1,label:(i+1)+'점 · '+label})))));
 }
 $('#prefilter-progress').textContent='음원 '+(trial+1)+' / 12 · 저장 완료 '+trial+'개';$('#prefilter-progress-bar').value=trial;
 $('#prefilter-trial-title').textContent='음원 '+(trial+1);
 $('#prefilter-play-status').textContent=next.play_count?'재생 완료 '+next.play_count+'회 · 필요하면 다시 들을 수 있습니다.':'한 번 끝까지 재생한 뒤 응답을 제출할 수 있습니다.';
 $('#prefilter-submit').disabled=busy||!next.play_count||pendingPlays.length>0;
 $('#prefilter-submit').textContent=trial===11?'마지막 응답 저장':'응답 저장 후 다음';
}
async function refresh(){
 if(!valid)return;
 try{if(token){render(await api(base+'/state',{token}));showMessage('');}else{$('#prefilter-loading').hidden=true;$('#prefilter-join').hidden=false;}}
 catch(e){if(e.status===401){$('#prefilter-loading').hidden=true;$('#prefilter-join').hidden=false;}else{showMessage(e.message,true);$('#prefilter-loading').hidden=true;$('#prefilter-retry').hidden=false;}}
}
$('#prefilter-start').addEventListener('click',async()=>{
 if(busy)return;busy=true;$('#prefilter-start').disabled=true;
 try{token=token||crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');storedValue(storageKey,token);render(await api(base+'/join',{method:'POST',body:{token}}));showMessage('');}
 catch(e){showMessage(e.message,true);}finally{busy=false;$('#prefilter-start').disabled=false;if(view)render(view);}
});
async function savePlay(){
 if(!pendingPlays.length||playingRequest)return;playingRequest=true;
 try{while(pendingPlays.length){const result=await api(base+'/play',{token,method:'POST',body:pendingPlays[0]});pendingPlays.shift();render(result);showMessage('');}}
 catch(e){showMessage('재생 기록을 저장하지 못했습니다. 연결 다시 확인을 눌러 주세요. '+e.message,true);$('#prefilter-retry').hidden=false;}
 finally{playingRequest=false;}
}
audio.addEventListener('ended',()=>{pendingPlays.push({trial_index:trial,event_id:crypto.randomUUID().replaceAll('-','')});$('#prefilter-submit').disabled=true;savePlay();});
audio.addEventListener('error',()=>{showMessage('음원을 재생하지 못했습니다. 네트워크를 확인하고 연결 다시 확인을 눌러 주세요.',true);$('#prefilter-retry').hidden=false;});
$('#prefilter-form').addEventListener('submit',async event=>{
 event.preventDefault();if(busy||!view?.play_count||pendingPlays.length)return;busy=true;audio.pause();$('#prefilter-submit').disabled=true;
 const data=new FormData(event.currentTarget),answers=Object.fromEntries(view.questions.map(q=>[q.id,data.get('answer.'+q.id)]));
 try{const result=await api(base+'/response',{token,method:'POST',body:{trial_index:trial,answers,naturalness:Number(data.get('naturalness')),noise:Number(data.get('noise'))}});showMessage('');render(result);window.scrollTo({top:0,behavior:'smooth'});}
 catch(e){showMessage(e.message,true);$('#prefilter-retry').hidden=false;}finally{busy=false;if(view)render(view);}
});
$('#prefilter-retry').addEventListener('click',()=>pendingPlays.length?savePlay():refresh());
window.addEventListener('pagehide',()=>audio.pause());
if(valid){$('#prefilter-group-label').textContent='그룹 '+group;refresh();}else{$('#prefilter-loading').hidden=true;showMessage('그룹 1~5의 참여 링크로 접속해 주세요.',true);}
