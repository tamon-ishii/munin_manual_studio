export {reviewProofreading} from './proofreadingReview';

export const proofreadingProfiles = [
  {id:'yomiyasu', rules:'読み手が一度で理解できる文章にする。一文を短くし、主語と述語の対応、情報の順序、段落のまとまりを整える。'},
  {id:'natural-japanese', rules:'自然な日本語に整える。直訳調、冗長な表現、不自然な助詞や語順、同じ語尾の連続を改善する。'},
  {id:'japanese-tech-writing', rules:'技術文書として明確にする。用語と表記を統一し、条件、操作、結果を明示する。曖昧な指示語を減らす。事実や仕様を追加しない。'},
];
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

