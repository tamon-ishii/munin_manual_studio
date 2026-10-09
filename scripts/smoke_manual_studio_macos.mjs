// Exercises the actual macOS Studio UI through native accessibility and input.
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
if(process.platform!=='darwin')throw new Error('Requires macOS native accessibility');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const bin=path.resolve(process.env.MANUAL_NATIVE_BIN_DIR||path.join(repo,'target/debug'));
const cli=path.join(bin,'manualctl');const run=promisify(execFile);
const root=await mkdtemp(path.join(tmpdir(),'munin-macos-studio-'));
const output=path.resolve('native-smoke-results/macos-studio');await mkdir(output,{recursive:true});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deadline=Date.now()+180000;let studio,targetPid;let stderr="";const results=[];
const poll=async(read)=>{while(Date.now()<deadline){const value=await read();if(value)return value;await pause(200);}throw new Error('macOS Studio UI deadline exceeded');};
async function scenario(window,steps){
 const file=path.join(root,'scenario.json');await writeFile(file,JSON.stringify({version:1,platform:'desktop',window,steps}));
 await run(cli,['scenario-run','--root',root,'--input',file],{timeout:Math.min(40000,Math.max(1,deadline-Date.now()))});
}
const press=name=>[{expect_visible:`button[name="${name}"]`},{press:`button[name="${name}"]`}];
const fill=(role,name,value)=>[{expect_visible:`${role}[name*="${name}"]`},{key:{selector:`${role}[name*="${name}"]`,keys:"Cmd+A"}},{text:value},{wait_ms:300}];
const finishEditor=[{expect_visible:'button[name*="編集終了"]'},{press:'button[name*="編集終了"]'}];
const main=()=>`pid:${studio.pid}:Munin Manual Studio`;
async function manifests(){try{return await readdir(path.join(root,'.munin/screenshots'));}catch{return [];}}
async function shot(){for(const id of await manifests()){try{const s=JSON.parse(await readFile(path.join(root,'.munin/screenshots',id,'manifest.json'),'utf8'));if(s.adopted)return s;}catch{}}}
async function ownedMarkits(){const {stdout}=await run(cli,['list-accessible-windows','--root',root]);for(const w of JSON.parse(stdout)){if(w.title!=='MarkIts Editor'||!w.pid)continue;const {stdout:parent}=await run('ps',['-o','ppid=','-p',String(w.pid)]);if(Number(parent.trim())===studio.pid)return `pid:${w.pid}:MarkIts Editor`;}}
async function foreground(){const {stdout}=await run('osascript',['-e','tell application "System Events" to get unix id of first application process whose frontmost is true']);return Number(stdout.trim());}
const pass=message=>{results.push(message);console.log('PASS: '+message);};
try{
 await mkdir(path.join(root,'docs'));await writeFile(path.join(root,'docs/index.md'),'# Native macOS Studio\n');
 await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',output:'manual',connection_type:'none'}));
 const fixture=path.join(root,'target.py'),report=path.join(root,'arguments.json');
 await writeFile(fixture,'import tkinter as tk,json,sys,os\nfrom pathlib import Path\nPath(sys.argv[1]).write_text(json.dumps({"args":sys.argv[2:],"pid":os.getpid()}))\nroot=tk.Tk();root.title("Munin macOS Recording Target");root.geometry("640x400")\ntk.Button(root,text="Record target",command=lambda:root.title("Munin macOS Recording Target clicked")).place(x=30,y=40,width=120,height=80)\nroot.mainloop()\n');
 const {stdout:python}=await run(process.env.MANUAL_NATIVE_PYTHON||'python3',['-c','import sys; print(sys.executable)']);
 studio=spawn(path.join(bin,'manual-studio'),[],{cwd:root,stdio:['ignore','ignore','pipe']});studio.stderr.on('data',s=>stderr=(stderr+s).slice(-4000));
 await scenario(main(),[...press('開く'),...fill('text_field','プロジェクトのフォルダー',root),...press('開く'),...press('アプリ登録'),...press('アプリを追加')]);
 await scenario(main(),[...fill('text_field','起動パス',python.trim()),...fill('text_area','起動引数（1行に1つ）',[fixture,report,' value with spaces ','$(literal)'].join('\n')),...press('アプリ登録を保存'),...press('閉じる'),...press('スクリーンショット一覧'),...press('操作を記録して撮影'),...press('記録を開始')]);
 pass('Studio project open, application registration and recording start controls');
 const args=await poll(async()=>{try{return JSON.parse(await readFile(report,'utf8'));}catch{return null;}});targetPid=args.pid;assert.deepEqual(args.args,[' value with spaces ','$(literal)']);
 // The fixture writes arguments before Studio finishes detecting its window
 // and starts the recorder. Wait for Studio's ready control and helper file.
 await scenario(`pid:${studio.pid}:Munin Manual Studio — 撮影`,[{expect_visible:'button[name="スクリーンショットを実行"]'}]);
 const recorderFile=await poll(async()=>{const files=await readdir(tmpdir());const name=files.find(name=>name.startsWith(`manual-studio-recorder-${studio.pid}-`)&&name.endsWith('.jsonl'));return name?path.join(tmpdir(),name):null;});
 await scenario(`pid:${targetPid}:Munin macOS Recording Target`,[{wait_ms:600},{click:{x:80,y:80}},{expect_window:`pid:${targetPid}:Munin macOS Recording Target clicked`}]);
 await poll(async()=>{const events=(await readFile(recorderFile,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));return events.some(event=>event.kind==='click');});
 pass('Actual Studio recorder is ready and records the target click');
 await scenario(`pid:${studio.pid}:Munin Manual Studio — 撮影`,press('スクリーンショットを実行'));
 const editor=await poll(async()=>{const found=await ownedMarkits();if(found)return found;try{const {stdout}=await run(cli,['inspect-window','--root',root,'--window',main()],{timeout:3000});if(stdout.includes('撮影に失敗')||stdout.includes('起動できません'))throw new Error(stdout);}catch(error){if(String(error).includes('撮影に失敗')||String(error).includes('起動できません'))throw error;}return null;});await scenario(editor,finishEditor);
 const initial=await poll(shot);assert.ok(initial.recipe.steps.some(step=>step.click),'Native recorder captured the fixture click');
 await poll(async()=>await foreground()===studio.pid);pass('macOS Studio registration, native recording/capture, MarkIts completion and Studio foreground return');
 const {stdout:source}=await run(cli,['--request',JSON.stringify({root,action:'screenshots-image',options:{id:initial.id,json:{original:true}}})]);
 const original=JSON.parse(source).data,hash=createHash('sha256').update(original).digest('hex');
 await scenario(main(),press('MarkItsで編集'));const reopened=await poll(ownedMarkits);await scenario(reopened,finishEditor);
 await poll(async()=>await foreground()===studio.pid);
 const reedited=await poll(shot);assert.deepEqual(reedited.edits.at(-1).scene,initial.edits.at(-1).scene,'Re-edit restores the saved annotation scene');
 const {stdout:after}=await run(cli,['--request',JSON.stringify({root,action:'screenshots-image',options:{id:initial.id,json:{original:true}}})]);
 assert.equal(createHash('sha256').update(JSON.parse(after).data).digest('hex'),hash);
 await scenario(main(),[...press('文書に挿入'),...press('ここに挿入')]);
 await poll(async()=>{const md=await readFile(path.join(root,'docs/index.md'),'utf8');return md.includes('screenshot:ref');});
 const {stdout:build}=await run(cli,['build-mkdocs','--root',root],{timeout:40000});assert.ok(build.includes('Site:'));assert.ok((await readFile(path.join(root,'manual/index.html'),'utf8')).includes(initial.id));
 pass('macOS Studio re-edit, immutable original, document insertion/autosave and HTML publication without AI');
 await writeFile(path.join(output,'report.json'),JSON.stringify({results,platform:process.platform,scope:'Actual native Studio UI, accessibility/input, MarkIts handoff and foreground; no browser mocks'},null,2));
}catch(error){
 console.error('Studio process state', {exitCode:studio?.exitCode,signalCode:studio?.signalCode});
 try{const {stdout}=await run('ps',['-axo','pid,ppid,stat,command']);await writeFile(path.join(output,'processes.txt'),stdout);}catch{}
 for(const directory of ['.munin','manual']){try{await cp(path.join(root,directory),path.join(output,directory==='.munin'?'munin-data':directory),{recursive:true});}catch{}}
 try{await cp(path.join(tmpdir(),'manual-studio-markits'),path.join(output,'handoff'),{recursive:true});}catch{}
 for(const action of ['list-windows','list-accessible-windows']){try{const {stdout}=await run(cli,[action,'--root',root],{timeout:10000});await writeFile(path.join(output,action+'.json'),stdout);}catch{}}
 if(studio){try{const {stdout}=await run(cli,['inspect-window','--root',root,'--window',main()],{timeout:10000});await writeFile(path.join(output,'studio-tree.txt'),stdout);}catch{}}
 await writeFile(path.join(output,'studio-stderr.txt'),stderr);
 for(const file of ['manual_setting.json','arguments.json']){try{await writeFile(path.join(output,file),await readFile(path.join(root,file)));}catch{}}
 await writeFile(path.join(output,'failure.txt'),String(error));throw error;
}finally{
 if(targetPid){try{process.kill(targetPid,'SIGTERM');}catch{}}
 if(studio&&studio.exitCode===null){studio.kill('SIGTERM');await pause(500);if(studio.exitCode===null)studio.kill('SIGKILL');}
 await rm(root,{recursive:true,force:true});
}
