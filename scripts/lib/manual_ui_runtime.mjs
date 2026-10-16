import ts from 'typescript';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';

// Resolve declared HTML selectors and literal control labels independently of
// the interaction registry. Source registration must also pass: this is not an
// automatic permission to add an unreviewed control.
export async function runtimeDeclarations(root) {
  const selectors=new Set(), names=new Set();
  const html=source=>{
    for(const match of source.matchAll(/<(button|summary|input|select|textarea|a)\b([^>]*)>([^<]*)/g)) {
      const [,tag,attributes,text]=match;
      const id=/\bid=["']([^"']+)["']/.exec(attributes)?.[1];
      if(id&&!id.includes('${'))selectors.add(`${tag}[id=${JSON.stringify(id)}]`);
      const presentation=name=>['data-ui-icon','data-toolbar-hidden','data-show'].includes(name);
      for(const attr of attributes.matchAll(/\b(data-[\w-]+)=["']([^"']*)["']/g))if(!presentation(attr[1])&&!attr[2].includes('${'))selectors.add(`${tag}[${attr[1]}=${JSON.stringify(attr[2])}]`);
      for(const attr of attributes.matchAll(/\b(data-[\w-]+)=["']([^"']*)["']/g))if(!presentation(attr[1])&&attr[2].includes('${'))selectors.add(`${tag}[${attr[1]}]`);
      for(const attr of attributes.matchAll(/\b(data-[\w-]+)(?=\s|$)/g))if(!presentation(attr[1]))selectors.add(`${tag}[${attr[1]}]`);
      if(text.trim())names.add(text.trim());
      const label=/\baria-label=["']([^"']+)["']/.exec(attributes)?.[1];if(label&&!label.includes('${'))names.add(label);
    }
  };
  html(await readFile(path.join(root,'apps/manual-studio/index.html'),'utf8'));
  for(const file of await readdir(path.join(root,'apps/manual-studio/src')))if(/\.tsx?$/.test(file)&&!file.includes('.test.')) {
    const source=await readFile(path.join(root,'apps/manual-studio/src',file),'utf8');
    const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
    const literal=node=>{if(ts.isStringLiteralLike(node))names.add(node.text.trim());else if(ts.isConditionalExpression(node)){literal(node.whenTrue);literal(node.whenFalse);}};
    const walk=node=>{
      if(ts.isForOfStatement(node)&&/createElement\(['"]button['"]\)/.test(node.statement.getText(ast))) {
        const labels=n=>{if(ts.isStringLiteralLike(n))names.add(n.text);else ts.forEachChild(n,labels);};labels(node.expression);
      }
      if(ts.isStringLiteralLike(node)||ts.isTemplateExpression(node))html(ts.isStringLiteralLike(node)?node.text:node.getText(ast));
      if(ts.isBinaryExpression(node)&&ts.isPropertyAccessExpression(node.left)&&['textContent','title','ariaLabel'].includes(node.left.name.text))literal(node.right);
      if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&['button','action','addButton'].includes(node.expression.text)&&node.arguments[0])literal(node.arguments[0]);
      if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='setAttribute'&&ts.isStringLiteralLike(node.arguments[0])&&['aria-label','title'].includes(node.arguments[0].text)&&node.arguments[1])literal(node.arguments[1]);
      ts.forEachChild(node,walk);
    };walk(ast);
  }
  const adapters=JSON.parse(await readFile(path.join(root,'scripts/fixtures/manual-studio-runtime-adapters.json'),'utf8'));
  for(const adapter of adapters)for(const selector of adapter.selectors)selectors.add(selector);
  return {selectors:[...selectors],names:[...names].filter(Boolean)};
}

export async function collectRuntime(page,declarations) {
  return page.evaluate(({selectors,names})=>{
    const known=new Set(names), result=[];
    for(const node of document.querySelectorAll('button,summary,input,select,textarea,a,[role=menuitem],[role=treeitem],[draggable=true]')) {
      const box=node.getBoundingClientRect();if(!box.width||!box.height||!node.checkVisibility({visibilityProperty:true})||node.closest('[data-show=false]'))continue;
      const label=(node.getAttribute('aria-label')||[...(node.labels||[])].map(label=>label.innerText).join(' ')||node.innerText||node.getAttribute('title')||'').trim();
      const registered=selectors.some(selector=>node.matches(selector))||known.has(label);
      result.push({tag:node.tagName.toLowerCase(),id:node.id,label,role:node.getAttribute('role'),registered,disabled:node.matches(':disabled,[aria-disabled=true]'),selectors:selectors.filter(selector=>node.matches(selector)),markup:node.outerHTML.slice(0,650)});
    }
    return result;
  },declarations);
}

export function runtimeErrors(controls) {
  return controls.filter(item=>!item.registered).map(item=>`unregistered visible control: ${item.tag}#${item.id} ${item.label}`);
}

// Require only explicitly scheduled entries. Source declarations include many
// conditional controls that these snapshots do not exercise.
export function reachabilityErrors(snapshots,requirements) {
  return requirements.flatMap(({state,selector,label})=>{
    const target=selector||label;
    const snapshot=snapshots.find(item=>item.name===state);
    if(!snapshot)return [`unexplored required state: ${state}`];
    const controls=snapshot.controls.filter(item=>selector?item.selectors?.includes(selector):item.label===label);
    if(!controls.length)return [`unreachable required control: ${state} ${target}`];
    if(controls.every(item=>item.disabled))return [`disabled required control: ${state} ${target}`];
    return [];
  });
}
