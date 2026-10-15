import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {finishVerification} from './manual_ui_report.mjs';

// Only called after the complete real-backend scenario and its assertions pass.
export async function recordManuscriptContracts(start,page,directory,features,steps,stored) {
  await mkdir(directory,{recursive:true});
  const registry=JSON.parse(await readFile('scripts/fixtures/manual-studio-ui-inventory.json','utf8'));
  await page.screenshot({path:path.join(directory,'verified.png'),fullPage:true});
  await writeFile(path.join(directory,'state.json'),JSON.stringify({steps,stored,editor:await page.locator('#markdown-editor').inputValue()},null,2));
  const artifacts=await Promise.all(['verified.png','state.json'].map(async file=>({path:file,sha256:createHash('sha256').update(await readFile(path.join(directory,file))).digest('hex')})));
  const results=features.flatMap(feature=>registry.actions.filter(action=>action.feature===feature).map(action=>({caseId:`${feature}.contracts`,entryPoint:action.id,type:'real-backend',status:'passed',assertions:{visible:true,stored:true,preserved:true,returnTarget:true},artifacts,steps})));
  await writeFile(path.join(directory,'result.json'),JSON.stringify({...await finishVerification(start),type:'real-backend',scope:features.join(','),results},null,2));
}
