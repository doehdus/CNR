export const LISTENING_STUDY = 'bpf-20261122-v1';
export const LISTENING_SCALES = [
  {name:'naturalness',label:'음성 자연스러움',levels:['매우 부자연스러움','부자연스러움','보통','자연스러움','매우 자연스러움']},
  {name:'noise',label:'소음 방해 정도',levels:['매우 많이 방해됨','많이 방해됨','보통 정도로 방해됨','조금 방해됨','전혀 방해되지 않음']},
];
export function normalizeListeningAssignment(data) {
  const fail=()=>{throw Error('청음평가 배정표의 조건·음원·지표를 확인하세요.');};
  if(data?.version!==1||data.status!=='audio_selection_completed'||data.groups?.length!==5||!data.source?.sha256)fail();
  const keys=new Set(),counts=new Map();
  for(let g=0;g<5;g++) {
    const group=data.groups[g];if(group.id!==String(g+1)||group.conditions?.length!==6)fail();
    const sentences=new Set(),speakers={},noises={};
    for(const r of group.conditions) {
      if(!/^(instruction|warning)0[1-6]$/.test(r.statement)||sentences.has(r.statement)||!['single','complex','changing'].includes(r.noise)||![0,5,10,20].includes(r.snr))fail();
      const key=[r.statement,r.noise,r.snr].join('/');if(keys.has(key))fail();keys.add(key);sentences.add(r.statement);
      counts.set(r.statement,(counts.get(r.statement)||0)+1);speakers[r.speaker]=(speakers[r.speaker]||0)+1;noises[r.noise]=(noises[r.noise]||0)+1;
      if(r.input_path!==`data/mixed/${r.noise}/snr${String(r.snr).padStart(2,'0')}/${r.statement}.wav`||r.output_path!==`outputs/prefilter_bpf/runs/${data.source.bpf_run_id}/${r.noise}/snr${String(r.snr).padStart(2,'0')}/${r.statement}.wav`)fail();
      if(!['input_sha256','output_sha256'].every(k=>/^[a-f0-9]{64}$/.test(r[k])))fail();
      for(const m of ['stoi','estoi'])if(!Number.isFinite(r.baseline?.[m])||!Number.isFinite(r.filtered?.[m])||!Number.isFinite(r.delta?.[m])||Math.abs(r.baseline[m])>1||Math.abs(r.filtered[m])>1||Math.abs(r.filtered[m]-r.baseline[m]-r.delta[m])>1e-12)fail();
    }
    if(speakers['유채원']!==3||speakers['김도연']!==3||Object.values(noises).length!==3||Object.values(noises).some(n=>n!==2)||[...sentences].filter(s=>s.startsWith('instruction')).length!==3)fail();
  }
  if(counts.size!==12||[...counts.values()].some(n=>n<2||n>3))fail();return data;
}
export function listeningTrials(group,order) {
  if(order.length!==6||new Set(order).size!==6||order.some(n=>!Number.isInteger(n)||n<0||n>5))throw Error('평가 순서를 확인하세요.');
  return order.flatMap(pair=>['baseline','filtered'].map(mode=>({pair,mode,...group.conditions[pair]})));
}
export function summarizeListening(participants,responses) {
  const completed=new Set(participants.filter(p=>responses.filter(r=>r.participant_id===p.id).length===12).map(p=>p.id));
  function means(rows) {
    if(!rows.length)return null;
    return {naturalness:rows.reduce((s,r)=>s+r.naturalness,0)/rows.length,noise:rows.reduce((s,r)=>s+r.noise,0)/rows.length,
      key_rate:rows.reduce((s,r)=>s+r.key_correct,0)/(rows.length*4)};
  }
  const groups=Array.from({length:5},(_,g)=>{
    const id=String(g+1),people=participants.filter(p=>p.group_id===id),valid=responses.filter(r=>r.group_id===id&&completed.has(r.participant_id));
    const baseline=means(valid.filter(r=>r.mode==='baseline')),filtered=means(valid.filter(r=>r.mode==='filtered'));
    return {id,participants:people.length,completed:people.filter(p=>completed.has(p.id)).length,responses:responses.filter(r=>r.group_id===id).length,
      baseline,filtered,delta:baseline&&filtered?Object.fromEntries(Object.keys(baseline).map(k=>[k,filtered[k]-baseline[k]])):null};
  });
  const ready=groups.filter(g=>g.completed>0);
  const overall=ready.length===5?Object.fromEntries(['baseline','filtered','delta'].map(mode=>[mode,Object.fromEntries(['naturalness','noise','key_rate'].map(k=>[k,groups.reduce((s,g)=>s+g[mode][k],0)/5]))])):null;
  return {groups,overall,participants:participants.length,completed:completed.size,responses:responses.length,ready_groups:ready.length};
}
