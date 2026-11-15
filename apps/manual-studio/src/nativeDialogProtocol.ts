import type {ThemeId} from './theme';

export interface DialogField {id:string;value?:string;checked?:boolean;open?:boolean;customValidity?:string}
export interface DialogSnapshot {html:string;fields:DialogField[];theme:ThemeId;focus?:string;ack:number}
export interface DialogFile {name:string;mime:string;modified:number;data:string}
export type DialogEvent='click'|'input'|'change'|'keydown'|'focus'|'blur'|'toggle'|'dragstart'|'dragover'|'drop'|'dragend';
export type DialogMessage =
  |{type:'ready'}
  |{type:'snapshot';snapshot:DialogSnapshot}
  |{type:'event';sequence:number;id:string;event:DialogEvent;fields:DialogField[];files?:DialogFile[];xRatio?:number;yRatio?:number;dragData?:Record<string,string>;key?:string;code?:string;ctrlKey?:boolean;altKey?:boolean;shiftKey?:boolean;metaKey?:boolean}
  |{type:'cancel'};

export function dialogFields(root:Element):DialogField[]{
  return [...root.querySelectorAll<HTMLElement>('[data-dialog-node]')].flatMap<DialogField>(element=>{
    const id=element.dataset.dialogNode!;
    if(element instanceof HTMLInputElement)return [{id,value:element.value,checked:element.checked,customValidity:element.validity.customError?element.validationMessage:''}];
    if(element instanceof HTMLTextAreaElement||element instanceof HTMLSelectElement)return [{id,value:element.value,customValidity:element.validity.customError?element.validationMessage:''}];
    if(element instanceof HTMLDetailsElement)return [{id,open:element.open}];
    return [];
  });
}

export function applyDialogFields(root:Element,fields:DialogField[]):void{
  const elements=new Map([...root.querySelectorAll<HTMLElement>('[data-dialog-node]')].map(element=>[element.dataset.dialogNode!,element]));
  for(const field of fields){
    const element=elements.get(field.id);if(!element)continue;
    if(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element instanceof HTMLSelectElement){
      if(field.value!==undefined&&!(element instanceof HTMLInputElement&&element.type==='file')&&element.value!==field.value)element.value=field.value;
      if(field.customValidity!==undefined)element.setCustomValidity(field.customValidity);
    }
    if(element instanceof HTMLInputElement&&field.checked!==undefined)element.checked=field.checked;
    if(element instanceof HTMLDetailsElement&&field.open!==undefined&&element.open!==field.open)element.open=field.open;
  }
}
