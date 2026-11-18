import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
const { AnnotationEditor } = await tsImport('../crates/markits/apps/desktop/src/editor.ts', import.meta.url);
const editor=Object.create(AnnotationEditor.prototype);
editor.selection=new Set(); editor.primary=null;
editor.svgLayerEl={querySelectorAll:()=>[]};
editor.scene={canvas:{width:800,height:600},annotations:[
 {type:'rect',target:[10,10,20,20]},
 {type:'rect',target:[50,50,20,20]},
 {type:'arrow',start:[100,100],end:[150,150]},
 {type:'rect',target:[10,10,20,20]},
],hidden_annotations:[3]};
editor.updateHandles=()=>{};editor.updateInspector=()=>{};
editor.marquee={x:80,y:80,endX:0,endY:0,initial:[]};
editor.handleMouseUp();
assert.deepEqual([...editor.selection],[0,1],'reverse marquee selects intersecting visible marks');
editor.toggleSelection(1); assert.deepEqual([...editor.selection],[0]);
editor.toggleSelection(2); assert.deepEqual([...editor.selection],[0,2]);
editor.marquee={x:200,y:200,endX:200,endY:200,initial:[]};
editor.handleMouseUp();assert.equal(editor.selection.size,0,'empty click clears selection');
editor.marquee={x:90,y:90,endX:160,endY:160,initial:[0]};
editor.handleMouseUp();assert.deepEqual([...editor.selection],[0,2],'additive range preserves selection');
editor.selectedIndex=null;assert.equal(editor.selection.size,0,'single-selection reset clears multiple selection');
console.log('Markits selection regression tests passed');
