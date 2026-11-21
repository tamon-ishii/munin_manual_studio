export {reviewProofreading} from './proofreadingReview';
import proofreadingProfiles from '../../../crates/manual-core/src/proofreading_profiles.json';
export {proofreadingProfiles};
export interface ProofreadingOptions {enabled:boolean; profiles:Array<{id:string;rules:string}>}
export function proofreadingOptions():{element:HTMLElement;read:()=>ProofreadingOptions}{
  const element=document.createElement('fieldset');element.className='proofreading-options';
  const legend=document.createElement('legend');legend.textContent='推敲するスキル（複数選択可）';
  const choices=document.createElement('div');choices.className='proofreading-skill-choices';
  const checks=proofreadingProfiles.map(profile=>{
    const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.dataset.proofreadingSkill=profile.id;
    label.append(check,profile.id);choices.append(label);return check;
  });
  const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='推敲ルールを確認・編集';
  const note=document.createElement('p');note.textContent='スキル本体は未登録です。初期値は各観点の仮ルールです。実際のスキルを使う場合は、各欄をスキルの指示に置き換えてください。';details.append(summary,note);
  const fields=proofreadingProfiles.map(profile=>{
    const label=document.createElement('label');label.textContent=profile.id;
    const input=document.createElement('textarea');input.rows=4;input.value=profile.rules;input.maxLength=12000;input.setAttribute('aria-label',`${profile.id} の推敲ルール`);label.append(input);details.append(label);return input;
  });
  element.append(legend,choices,details);
  return {element,read:()=>{const profiles=proofreadingProfiles.flatMap((profile,i)=>checks[i].checked?[{id:profile.id,rules:fields[i].value.trim()}]:[]);return {enabled:profiles.length>0,profiles};}};
}

