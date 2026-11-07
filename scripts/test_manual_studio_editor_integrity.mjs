import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';

const base=process.env.MANUAL_STUDIO_TEST_URL||'http://127.0.0.1:5174';
const root=await mkdtemp(path.join(os.tmpdir(),'munin-editor-integrity-'));
const original='# Cursor test\n\nEditable paragraph with **bold** and `code`.\n\nAnother paragraph.\n';
const artifacts=process.env.MANUAL_EDITOR_RESULTS||'ui-coverage-results/editor-smoke';
let browser,page;const errors=[],observations=[];
try{
 await mkdir(path.join(root,'docs'));await writeFile(path.join(root,'docs/index.md'),original);await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',targets:['docs'],connection_type:'none'}));
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/__manual/rpc',async route=>{const response=await route.fetch({headers:{...route.request().headers(),origin:'http://127.0.0.1:5174'}});await route.fulfill({response});});
 const editor=page.locator('#markdown-editor'),rich=page.locator('#milkdown-editor .ProseMirror');
 const idle=()=>page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
 async function caret(stage,source=false){
   const state=await(source?editor:rich).evaluate(node=>{const selection=window.getSelection(),style=getComputedStyle(node);return {focused:document.activeElement===node,editable:node instanceof HTMLTextAreaElement?!node.readOnly&&!node.disabled:node.isContentEditable,collapsed:node instanceof HTMLTextAreaElement?node.selectionStart===node.selectionEnd:selection?.isCollapsed,inEditor:node instanceof HTMLTextAreaElement||!!selection?.anchorNode&&node.contains(selection.anchorNode),color:style.caretColor,virtual:node.classList.contains('virtual-cursor-enabled'),selection:node instanceof HTMLTextAreaElement?node.value.slice(node.selectionStart,node.selectionEnd):selection?.toString()};});
   observations.push({stage,...state});assert.equal(state.focused,true,`${stage}: editor focus`);assert.equal(state.editable,true,`${stage}: editable`);assert.equal(state.collapsed,true,`${stage}: insertion caret`);assert.equal(state.inEditor,true,`${stage}: selection owner`);assert.equal(state.virtual,false,`${stage}: native caret must not depend on an overlay`);assert.ok(!['transparent','rgba(0, 0, 0, 0)'].includes(state.color),`${stage}: visible caret color`);
 }
 await page.goto(`${base}/?root=${encodeURIComponent(root)}&page=index.md`);await idle();await rich.getByText('Another paragraph.',{exact:true}).click();await rich.press('End');await caret('initial rich text');
 await rich.pressSequentially(' visible');await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('Another paragraph. visible'));await caret('typing');const typed=await editor.inputValue();
 await rich.press('ControlOrMeta+z');await page.waitForFunction(()=>!document.querySelector('#markdown-editor').value.includes('visible'));await rich.press('ControlOrMeta+Shift+z');await page.waitForFunction(expected=>document.querySelector('#markdown-editor').value===expected,typed);await caret('undo and redo');
 for(let index=0;index<5;index++)await rich.press('Shift+ArrowLeft');assert.equal(await page.evaluate(()=>window.getSelection()?.toString()),'sible');
 await page.locator('.milkdown-top-bar').getByRole('button',{name:'太字',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('**sible**'));assert.equal(await page.evaluate(()=>window.getSelection()?.toString()),'sible','toolbar preserves the selected text');await rich.press('ArrowRight');await caret('formatting selection');await rich.press('ControlOrMeta+z');
 await page.locator('#application-settings').click();await page.locator('#settings-tab-appearance').click();await page.locator('#toolbar-customization').evaluate(node=>node.open=true);await page.locator('#toolbar-customization-list').getByLabel('注釈を表示',{exact:true}).uncheck();await page.locator('#toolbar-customization-list').getByRole('button',{name:'AI操作を前へ',exact:true}).click();await page.locator('#panel-settings .panel-header').getByRole('button',{name:'閉じる',exact:true}).click();await rich.getByText(/Another paragraph/).click();await rich.press('ArrowRight');await caret('toolbar settings and reorder');
 await rich.press('ControlOrMeta+s');await page.waitForFunction(()=>document.querySelector('#save-state').dataset.state==='saved');await idle();await rich.getByText(/Another paragraph/).click();await rich.press('ArrowRight');await caret('readonly save roundtrip');const saved=await editor.inputValue();assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),saved);
 await page.getByRole('button',{name:'Markdownソース',exact:true}).click();await editor.evaluate(node=>{node.focus();node.setSelectionRange(node.value.length,node.value.length);});await caret('source mode',true);await editor.pressSequentially('source');assert.equal(await editor.inputValue(),saved+'source');
 await page.getByRole('button',{name:'Milkdown編集',exact:true}).click();await rich.getByText(/source/).click();await rich.press('ArrowRight');await caret('source to rich');
 await page.evaluate(async()=>{const{applyTheme}=await import('/src/theme.ts');applyTheme('midnight');});await rich.press('ArrowRight');await caret('dark theme');
 await rich.press('ControlOrMeta+a');await rich.press('Backspace');await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.trim()==='');await caret('empty document');await page.keyboard.insertText('code');await rich.press('ControlOrMeta+a');await page.locator('.milkdown-top-bar').getByRole('button',{name:'挿入・その他',exact:true}).click();await page.locator('.top-bar-heading-option').getByText('インラインコード',{exact:true}).click();await rich.press('ArrowRight');await page.keyboard.insertText(' after');await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('`code` after'));await caret('inline code boundary');
 await page.evaluate(async()=>{const{applyTheme}=await import('/src/theme.ts');applyTheme('forest');});await rich.press('ArrowRight');await caret('light theme');assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),saved,'later edits stay unsaved');assert.deepEqual(errors,[]);
 await mkdir(artifacts,{recursive:true});await writeFile(path.join(artifacts,'caret.json'),JSON.stringify({status:'passed',observations,errors},null,2));
 console.log('Editor integrity passed: native caret/focus/selection in light, dark, empty, rich/source, toolbar formatting/reorder, save/readonly, undo/redo and inline-code boundary.');
}catch(error){await mkdir(artifacts,{recursive:true});await page?.screenshot({path:path.join(artifacts,'caret-failure.png')}).catch(()=>{});await writeFile(path.join(artifacts,'caret.json'),JSON.stringify({status:'failed',error:String(error),observations,errors},null,2));throw error;
}finally{for(const context of browser?.contexts()||[])for(const page of context.pages())await page.unrouteAll({behavior:'ignoreErrors'});await browser?.close();await rm(root,{recursive:true,force:true});}
