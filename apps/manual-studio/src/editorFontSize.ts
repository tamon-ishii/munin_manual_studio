import {createFontSizePreference} from './fontSizePreference';

const preference = createFontSizePreference({
  storageKey: 'manual-studio-editor-font-size',
  cssProperty: '--editor-font-size',
  changeEvent: 'manual-studio-editor-font-size-change',
  defaultSize: 14, min: 12, max: 28,
});

export const isEditorFontSize = preference.isValid;
export const applyEditorFontSize = preference.apply;
export const setupEditorFontSize = preference.setup;
