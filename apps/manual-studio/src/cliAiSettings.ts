export const consultationAgents=[{id:'codex',label:'Codex'},{id:'claude',label:'Claude Code'},{id:'agy',label:'Agy'}] as const;

/** Per-project CLI models used by AI terminal and consultation actions. */
export function setupCliAiSettings(changed:(agent:string,model:string)=>void){
  const section=document.createElement('section');section.className='settings-subsection';
  const heading=document.createElement('h3');heading.textContent='AIターミナル用CLIのモデル（省略可）';
  const note=document.createElement('p');note.className='muted';note.textContent='AIターミナルで使う各CLIのモデルを個別に指定できます。空欄なら各CLIの既定モデルを使います。';
  section.append(heading,note);
  const grid=document.createElement('div');grid.className='settings-grid';
  const fields=new Map<string,HTMLInputElement>();
  for(const agent of consultationAgents){
    const label=document.createElement('label');label.textContent=`${agent.label}のモデル`;
    const input=document.createElement('input');input.setAttribute('aria-label',`${agent.label}のモデル`);input.placeholder='CLIの既定モデル';input.maxLength=120;
    input.oninput=()=>changed(agent.id,input.value.trim());label.append(input);grid.append(label);fields.set(agent.id,input);
  }
  section.append(grid);
  document.getElementById('ai-cli-status')!.after(section);
  let models:Record<string,string>={};
  return {
    load(value:Record<string,string>){models={...value};for(const [id,input] of fields)input.value=models[id]||'';},
    set(agent:string,model:string){models[agent]=model;const input=fields.get(agent);if(input)input.value=model;},
    get(agent:string){return fields.get(agent)?.value.trim()??models[agent]??'';},
    snapshot(){return {...models,...Object.fromEntries([...fields].map(([id,input])=>[id,input.value.trim()]))};},
  };
}
