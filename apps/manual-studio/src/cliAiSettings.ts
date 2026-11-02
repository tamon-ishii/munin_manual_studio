export const consultationAgents=[{id:'codex',label:'Codex'},{id:'claude',label:'Claude'},{id:'agy',label:'Agy'}] as const;

/** Per-project CLI models, independent of the default API/CLI connection. */
export function setupCliAiSettings(changed:(agent:string,model:string)=>void){
  const section=document.createElement('section');section.className='card';
  const heading=document.createElement('h3');heading.textContent='相談先AIごとの設定';
  const note=document.createElement('p');note.className='muted';note.textContent='各CLIのモデルを個別に保存します。空欄はCLIの既定モデルを使います。ログインは各CLIで行ってください。作業フォルダは開いているプロジェクトです。';
  section.append(heading,note);
  const fields=new Map<string,HTMLInputElement>();
  for(const agent of consultationAgents){
    const label=document.createElement('label');label.textContent=`${agent.label}のモデル`;
    const input=document.createElement('input');input.setAttribute('aria-label',`${agent.label}のモデル`);input.placeholder='CLIの既定モデル';input.maxLength=120;
    input.oninput=()=>changed(agent.id,input.value.trim());label.append(input);section.append(label);fields.set(agent.id,input);
  }
  document.getElementById('ai-cli-status')!.after(section);
  let models:Record<string,string>={};
  return {
    load(value:Record<string,string>){models={...value};for(const [id,input] of fields)input.value=models[id]||'';},
    set(agent:string,model:string){models[agent]=model;const input=fields.get(agent);if(input)input.value=model;},
    get(agent:string){return fields.get(agent)?.value.trim()??models[agent]??'';},
    snapshot(){return {...models,...Object.fromEntries([...fields].map(([id,input])=>[id,input.value.trim()]))};},
  };
}
