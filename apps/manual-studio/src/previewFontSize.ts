import {createFontSizePreference} from './fontSizePreference';

const preference = createFontSizePreference({
  storageKey: 'manual-studio-preview-font-size',
  cssProperty: '--preview-font-size',
  changeEvent: 'manual-studio-preview-font-size-change',
  defaultSize: 16, min: 12, max: 32,
});

export const isPreviewFontSize = preference.isValid;
export const applyPreviewFontSize = preference.apply;
export const setupPreviewFontSize = preference.setup;
