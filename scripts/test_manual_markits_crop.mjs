import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {chromium} from 'playwright-core';
const base='http://127.0.0.1:5174';let server,browser;
try {
 server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 browser=await chromium.launch({channel:process.env.MUNIN_TEST_BROWSER || 'chrome',headless:true});const page=await browser.newPage();
 const ids=['viewport','canvas-container','svg-layer','handles-layer','snap-guide-layer','inspector-content','layer-list','layer-count','empty-state','editor-crop-overlay','crop-box','crop-size-badge','crop-mask-top','crop-mask-bottom','crop-mask-left','crop-mask-right','crop-preset-select'];
 await page.route('**/crop-test',route=>route.fulfill({contentType:'text/html',body:`<html><body>${ids.map(id=>id==='crop-preset-select'?`<select id="${id}"></select>`:`<div id="${id}"></div>`).join('')}<img id="bg-image"><button id="btn-revert-crop"></button><script type="module">import {AnnotationEditor} from '/@fs/${path.resolve('crates/markits/apps/desktop/src/editor.ts').split(path.sep).join('/')}';window.editor=new AnnotationEditor(async()=>'<svg></svg>');</script></body></html>`}));
 await page.goto(`${base}/crop-test`);await page.waitForFunction(()=>window.editor);
 const result=await page.evaluate(async()=>{
  const full=document.createElement('canvas');full.width=80;full.height=60;const ctx=full.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,80,60);ctx.fillStyle='blue';ctx.fillRect(0,0,10,10);const original=full.toDataURL();
  const small=document.createElement('canvas');small.width=30;small.height=25;small.getContext('2d').drawImage(full,20,10,30,25,0,0,30,25);
  const scene=JSON.stringify({canvas:{width:30,height:25},annotations:[{type:'rect',target:[3,4,10,5],style:'primary'}]});
  editor.setBackgroundImage(small.toDataURL(),30,25,scene,[]);editor.restoreCropState({dataUrl:original,width:80,height:60,uiElements:[]},{is_auto_cropped:false,offset_x:20,offset_y:10,base_width:80,base_height:60});
  const restored=editor.getCropState();const disabled=document.getElementById('btn-revert-crop').disabled;editor.revertCrop();
  const after=JSON.parse(editor.getSceneJson());const url=document.getElementById('bg-image').src;
  const image=new Image();image.src=url;await image.decode();const verify=document.createElement('canvas');verify.width=80;verify.height=60;verify.getContext('2d').drawImage(image,0,0);const pixel=[...verify.getContext('2d').getImageData(0,0,1,1).data];
  return {restored,disabled,after,url,original,pixel};
 });
 assert.equal(result.restored.hasCropHistory,true);assert.deepEqual(result.restored.autoCropOffset,{x:20,y:10});assert.equal(result.disabled,false);
 assert.deepEqual(result.after.canvas,{width:80,height:60});assert.deepEqual(result.after.annotations[0].target,[23,14,10,5]);assert.equal(result.url,result.original);assert.deepEqual(result.pixel,[0,0,255,255]);

 const presetResult = await page.evaluate(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 1920; canvas.height = 1080;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'green'; ctx.fillRect(0, 0, 1920, 1080);
  editor.setBackgroundImage(canvas.toDataURL(), 1920, 1080, JSON.stringify({ canvas: { width: 1920, height: 1080 }, annotations: [] }), []);
  editor.startCropMode();
  editor.applyCropPreset('1280x720');
  const rect720 = editor.getCropRect();
  editor.applyCropPreset('1024x1024');
  const rectSquare = editor.getCropRect();
  editor.applyCrop();
  const croppedScene = JSON.parse(editor.getSceneJson());
  return { rect720, rectSquare, croppedWidth: croppedScene.canvas.width, croppedHeight: croppedScene.canvas.height };
 });
 assert.deepEqual(presetResult.rect720, { x: 320, y: 180, width: 1280, height: 720 });
 assert.deepEqual(presetResult.rectSquare, { x: 448, y: 28, width: 1024, height: 1024 });
 assert.equal(presetResult.croppedWidth, 1024);
 assert.equal(presetResult.croppedHeight, 1024);

 console.log('MarkIts restored manual crop and representative resolution presets verified.');
} finally {await browser?.close();server?.kill();}
