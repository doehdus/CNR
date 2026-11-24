import test from 'node:test';
import assert from 'node:assert/strict';
import { renderResearchPhase } from '../../.sites-runtime/public/website/js/research-phase.js';

class Element {
  constructor(){this.children=[];this.dataset={};this.hidden=false;}
  append(...children){this.children.push(...children);}setAttribute(){}
}

test('새 실험 준비 중에는 이전 구성·응답 화면을 감추고 원래 노드와 표시 상태를 보존한다',()=>{
  const nodes=new Map(),document={querySelector:id=>nodes.get(id),createElement:()=>new Element()};
  nodes.set('#research-phase',new Element());
  for(const id of ['demo','metrics','prefilter-listening','listening-test','analysis']){
    const section=new Element(),visible=new Element(),hidden=new Element();hidden.hidden=true;
    visible.savedResponse={key_correct:4};section.append(visible,hidden);nodes.set('#'+id,section);
  }
  renderResearchPhase(document,true);renderResearchPhase(document,true);
  for(const [id,section] of nodes){
    if(id==='#research-phase')continue;
    assert.equal(section.children.length,3);assert(section.children[0].hidden);assert(section.children[1].hidden);assert(!section.children[2].hidden);
    assert.equal(section.children[0].savedResponse.key_correct,4);
  }
  renderResearchPhase(document,false);
  assert(nodes.get('#research-phase').hidden);
  for(const [id,section] of nodes){if(id==='#research-phase')continue;assert(!section.children[0].hidden);assert(section.children[1].hidden);assert(section.children[2].hidden);}
});
