import ts from 'typescript';
import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';

export const fingerprint = value => createHash('sha256').update(value).digest('hex');
export async function treeFingerprint(root, relativePaths) {
  const records=[];
  async function visit(relative) {
    const absolute=path.join(root,relative);
    const {stat}=await import('node:fs/promises');
    if((await stat(absolute)).isDirectory()) {
      for(const name of (await readdir(absolute)).sort()) if(!['node_modules','target','.git','__pycache__'].includes(name))await visit(`${relative}/${name}`);
    } else records.push(`${relative}:${fingerprint(await readFile(absolute))}`);
  }
  for(const relative of relativePaths)await visit(relative);
  return fingerprint(records.join('\n'));
}
const interactionEvents = new Set(['click','dblclick','contextmenu','input','change','submit','keydown','keyup','paste','drop','dragstart','dragover','dragenter','dragleave','dragend','pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup','toggle','select','cancel']);
const controlTags = new Set(['button','summary','input','select','textarea','a']);

export async function sourceInventory(root) {
  const files = ['apps/manual-studio/index.html','apps/manual-studio/recording-control.html'];
  for (const file of await readdir(path.join(root,'apps/manual-studio/src'))) {
    if (/\.tsx?$/.test(file) && !/\.test\./.test(file)) files.push(`apps/manual-studio/src/${file}`);
  }
  const operations = [], hashes = [];
  for (const file of files.sort()) {
    const source = await readFile(path.join(root,file),'utf8');
    hashes.push(`${file}:${fingerprint(source)}`);
    const occurrences = new Map();
    const add = (kind, expression, pos) => {
      const normalized = expression.replace(/\s+/g,' ').trim();
      const base = `${file}:${kind}:${fingerprint(normalized).slice(0,16)}`;
      const occurrence = (occurrences.get(base) || 0) + 1; occurrences.set(base,occurrence);
      operations.push({id:`${base}:${occurrence}`,file,line:source.slice(0,pos).split('\n').length,kind,expression:normalized});
    };
    const html = (value, pos) => {
      for (const match of value.matchAll(/<([a-z][\w-]*)\b[^>]*>/gi)) {
        if(controlTags.has(match[1].toLowerCase())||/\brole=["'](?:menuitem|treeitem|tab)["']/.test(match[0]))add(`html:${match[1].toLowerCase()}`,match[0],pos+match.index);
      }
    };
    if (file.endsWith('.html')) { html(source,0); continue; }
    const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    const walk=node=>{
      if(ts.isPropertyAssignment(node)&&['onUpload','onRun'].includes(node.name.getText(ast)))add(`callback:${node.name.getText(ast)}`,node.getText(ast),node.getStart(ast));
      if(ts.isForOfStatement(node)&&/createElement\(['"](?:button|input|select|textarea)['"]\)/.test(node.statement.getText(ast))) add('loop-controls',node.getText(ast),node.getStart(ast));
      if (ts.isCallExpression(node)) {
        const callee=node.expression;
        if(ts.isPropertyAccessExpression(callee)&&callee.name.text==='forEach'&&/addEventListener\(/.test(node.getText(ast)))add('binding-loop',node.getText(ast),node.getStart(ast));
        if (ts.isPropertyAccessExpression(callee) && callee.name.text==='addEventListener') {
          const event=node.arguments[0];
          if (event && ts.isStringLiteralLike(event) && interactionEvents.has(event.text)) add(`event:${event.text}`,node.getText(ast),node.getStart(ast));
          else if(event&&!ts.isStringLiteralLike(event))add('event:dynamic',node.getText(ast),node.getStart(ast));
        }
        if (ts.isPropertyAccessExpression(callee) && callee.name.text==='createElement') {
          const tag=node.arguments[0];
          if (tag && ts.isStringLiteralLike(tag) && controlTags.has(tag.text)) add(`create:${tag.text}`,node.parent.getText(ast),node.getStart(ast));
        }
        // Dynamic button factories and actionButton bindings are independent entry points.
        if (ts.isIdentifier(callee) && ['button','action','actionButton','addButton'].includes(callee.text)) add('factory',node.getText(ast),node.getStart(ast));
        if (ts.isIdentifier(callee) && ['keymap','addKeymap'].includes(callee.text)) add('keyboard-map',node.getText(ast),node.getStart(ast));
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind===ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && interactionEvents.has(node.left.name.text.slice(2)) && node.left.name.text.startsWith('on')) add('handler',node.getText(ast),node.getStart(ast));
      if (ts.isJsxAttribute(node) && /^on[A-Z]/.test(node.name.getText(ast))) add('jsx',node.getText(ast),node.getStart(ast));
      if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) html(node.text,node.getStart(ast));
      else if (ts.isTemplateExpression(node)) html(node.getText(ast),node.getStart(ast));
      ts.forEachChild(node,walk);
    };
    walk(ast);
  }
  return {sourceHash:fingerprint(hashes.join('\n')),operations};
}

export function validateRegistry(registry, discovered) {
  const errors=[];
  const unique=(items,label)=>{const seen=new Set();for(const item of items){if(!item.id||seen.has(item.id))errors.push(`${label}: duplicate or empty ID ${item.id}`);seen.add(item.id);}return seen;};
  const features=unique(registry.features||[],'feature');
  const cases=unique(registry.cases||[],'case');
  const actions=unique(registry.actions||[],'action');
  for(const action of registry.actions||[]) {
    if(!features.has(action.feature))errors.push(`${action.id}: unknown feature`);
    if(!action.cases?.length||action.cases.some(id=>!cases.has(id)))errors.push(`${action.id}: orphan entry point`);
    if(!action.result||!action.returnTarget||!action.spec)errors.push(`${action.id}: missing result/return/spec`);
  }
  for(const testCase of registry.cases||[]) {
    if(!features.has(testCase.feature)||!testCase.entryPoints?.length||testCase.entryPoints.some(id=>!actions.has(id)))errors.push(`${testCase.id}: invalid feature/entry points`);
    if(!testCase.expected?.visible||!testCase.expected?.stored||!testCase.expected?.preserved||!testCase.expected?.returnTarget)errors.push(`${testCase.id}: missing observable expectations`);
    if(!testCase.requiredEvidence?.length||testCase.requiredEvidence.some(type=>!['browser-mock','real-backend','real-desktop','real-provider'].includes(type)))errors.push(`${testCase.id}: invalid evidence requirements`);
    for(const id of testCase.entryPoints||[])if(!(registry.actions||[]).find(action=>action.id===id)?.cases?.includes(testCase.id))errors.push(`${testCase.id}: entry point has no reverse case link`);
  }
  if(discovered) {
    const live=new Set(discovered.operations.map(item=>item.id));
    for(const item of discovered.operations)if(!actions.has(item.id))errors.push(`unregistered operation: ${item.file}:${item.line} ${item.kind} ${item.expression.slice(0,100)}`);
    for(const action of registry.actions||[])if(!live.has(action.id))errors.push(`stale operation: ${action.id}`);
  }
  return errors;
}

export function validateEvidence(registry, report, {sourceHash,buildHash,os,now=Date.now(),maxAgeMs=86400000}={}) {
  const errors=[];
  if(!report || report.sourceHash!==sourceHash || report.buildHash!==buildHash || !sourceHash || !buildHash)errors.push('missing or stale source/build evidence');
  if(report?.os!==os||!os)errors.push('OS evidence mismatch');
  const runTime=Date.parse(report?.executedAt);
  if(!Number.isFinite(runTime)||runTime>now+60000||now-runTime>maxAgeMs)errors.push('missing or expired run timestamp');
  const results=report?.results||[];const seen=new Set();
  for(const result of results){const key=JSON.stringify([result.caseId,result.entryPoint,result.type]);if(seen.has(key))errors.push(`duplicate evidence ${key}`);seen.add(key);if(!(registry.cases||[]).some(item=>item.id===result.caseId&&item.entryPoints.includes(result.entryPoint)&&item.requiredEvidence.includes(result.type)))errors.push(`unknown evidence ${key}`);}
  for(const testCase of registry.cases||[])for(const entryPoint of testCase.entryPoints)for(const type of testCase.requiredEvidence) {
    const result=results.find(item=>item.caseId===testCase.id&&item.entryPoint===entryPoint&&item.type===type);
    const key=`${testCase.id}/${entryPoint}/${type}`;
    if(!result||result.status!=='passed') {errors.push(`${key}: ${result?.status||'not run'}`);continue;}
    for(const expectation of ['visible','stored','preserved','returnTarget'])if(result.assertions?.[expectation]!==true)errors.push(`${key}: ${expectation} not verified`);
    if(!result.artifacts?.length||!result.steps?.length)errors.push(`${key}: missing artifacts/operation log`);
  }
  return errors;
}

export function entryEvidenceStatus(registry, report, identity) {
  return registry.cases.flatMap(testCase => testCase.entryPoints.map(entryPoint => {
    const scoped = { cases: [{ ...testCase, entryPoints: [entryPoint] }] };
    const results = (report?.results || []).filter(result => result.caseId === testCase.id && result.entryPoint === entryPoint);
    const errors = validateEvidence(scoped, { ...report, results }, identity);
    const action = registry.actions.find(action => action.id === entryPoint);
    if (action?.reviewStatus !== 'reviewed') errors.push('entry-specific contract not reviewed');
    return { caseId: testCase.id, entryPoint, requiredEvidence: testCase.requiredEvidence, status: errors.length ? 'unverified' : 'passed', errors };
  }));
}
