import type { HtmlThemeStyle } from './types';

export interface HtmlThemePreset {
  id: string;
  label: string;
  description: string;
  scheme: 'light' | 'dark';
  primary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  font: 'sans' | 'serif' | 'mono';
  layout: 'standard' | 'wide' | 'compact';
}

export const HTML_THEME_PRESETS: readonly HtmlThemePreset[] = [
  {
    id: 'clean-blue',
    label: 'クリーンブルー',
    description: '標準・見やすい白ベース',
    scheme: 'light',
    primary: '#2563eb',
    accent: '#0ea5e9',
    background: '#ffffff',
    surface: '#f7f8fa',
    text: '#1f2937',
    font: 'sans',
    layout: 'standard',
  },
  {
    id: 'forest',
    label: 'フォレスト',
    description: '落ち着いた深緑アクセント',
    scheme: 'light',
    primary: '#285d46',
    accent: '#3f8b60',
    background: '#ffffff',
    surface: '#f2f5f0',
    text: '#22312b',
    font: 'sans',
    layout: 'standard',
  },
  {
    id: 'warm-paper',
    label: 'ウォームペーパー',
    description: '紙のような温かみ・長文向け',
    scheme: 'light',
    primary: '#98613e',
    accent: '#c27d4a',
    background: '#faf7f2',
    surface: '#f3ece1',
    text: '#3a3028',
    font: 'serif',
    layout: 'standard',
  },
  {
    id: 'indigo-tech',
    label: 'インディゴテック',
    description: '開発者・技術仕様書向け',
    scheme: 'light',
    primary: '#4f46e5',
    accent: '#7c3aed',
    background: '#ffffff',
    surface: '#f5f7fb',
    text: '#1e293b',
    font: 'sans',
    layout: 'wide',
  },
  {
    id: 'slate-dark',
    label: 'スレートダーク',
    description: '目に優しいダークモード',
    scheme: 'dark',
    primary: '#60a5fa',
    accent: '#38bdf8',
    background: '#161b22',
    surface: '#1f2630',
    text: '#e6edf3',
    font: 'sans',
    layout: 'standard',
  },
  {
    id: 'midnight-dark',
    label: 'ミッドナイトグリーン',
    description: '黒×エメラルドのモダン配色',
    scheme: 'dark',
    primary: '#6ee7b7',
    accent: '#34d399',
    background: '#141d19',
    surface: '#1c2822',
    text: '#e7f2ec',
    font: 'sans',
    layout: 'standard',
  },
] as const;

export function normalizeHtmlThemeStyle(raw?: HtmlThemeStyle | null): Required<HtmlThemeStyle> {
  const preset = HTML_THEME_PRESETS.find((item) => item.id === raw?.preset) ?? HTML_THEME_PRESETS[0];
  const isCustom = raw?.preset === 'custom';
  return {
    preset: isCustom ? 'custom' : preset.id,
    scheme: raw?.scheme === 'dark' || raw?.scheme === 'light' ? raw.scheme : preset.scheme,
    primary: isHex(raw?.primary) ? raw!.primary!.toLowerCase() : preset.primary,
    accent: isHex(raw?.accent) ? raw!.accent!.toLowerCase() : preset.accent,
    background: isHex(raw?.background) ? raw!.background!.toLowerCase() : preset.background,
    surface: isHex(raw?.surface) ? raw!.surface!.toLowerCase() : preset.surface,
    text: isHex(raw?.text) ? raw!.text!.toLowerCase() : preset.text,
    font: raw?.font === 'serif' || raw?.font === 'mono' || raw?.font === 'sans' ? raw.font : preset.font,
    layout: raw?.layout === 'wide' || raw?.layout === 'compact' || raw?.layout === 'standard' ? raw.layout : preset.layout,
  };
}

export function themeStyleLabel(raw?: HtmlThemeStyle | null): string {
  const style = normalizeHtmlThemeStyle(raw);
  const preset = HTML_THEME_PRESETS.find((item) => item.id === style.preset);
  return preset ? preset.label : `カスタム（${style.scheme === 'dark' ? 'ダーク' : 'ライト'}）`;
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

export function htmlThemeEquals(a?: HtmlThemeStyle | null, b?: HtmlThemeStyle | null): boolean {
  const na = normalizeHtmlThemeStyle(a);
  const nb = normalizeHtmlThemeStyle(b);
  return (
    na.preset === nb.preset &&
    na.scheme === nb.scheme &&
    na.primary === nb.primary &&
    na.accent === nb.accent &&
    na.background === nb.background &&
    na.surface === nb.surface &&
    na.text === nb.text &&
    na.font === nb.font &&
    na.layout === nb.layout
  );
}

export interface HtmlThemePickerController {
  getValue(): Required<HtmlThemeStyle>;
  setValue(style?: HtmlThemeStyle | null): void;
  setSiteName(name: string): void;
  setDisabled(disabled: boolean): void;
}

export function createHtmlThemePicker(
  host: HTMLElement,
  options: { idPrefix: string; onChange?: (style: Required<HtmlThemeStyle>) => void },
): HtmlThemePickerController {
  let state: Required<HtmlThemeStyle> = normalizeHtmlThemeStyle();
  let siteTitle = 'マニュアル';

  host.replaceChildren();
  const root = document.createElement('div');
  root.className = 'html-theme-picker';

  const headingRow = document.createElement('div');
  headingRow.className = 'html-theme-picker-heading';
  const titleEl = document.createElement('strong');
  titleEl.textContent = '出力HTMLのテーマ';
  const activeBadge = document.createElement('span');
  activeBadge.className = 'html-theme-active-badge';
  headingRow.append(titleEl, activeBadge);

  // Preset visual cards
  const presetGrid = document.createElement('div');
  presetGrid.className = 'html-theme-presets';
  presetGrid.setAttribute('role', 'radiogroup');
  presetGrid.setAttribute('aria-label', '出力HTMLテーマのプリセット');

  const presetButtons = new Map<string, HTMLButtonElement>();
  for (const preset of HTML_THEME_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'html-theme-preset-card';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.dataset.htmlThemePreset = preset.id;
    btn.title = `${preset.label}: ${preset.description}`;

    const mockup = document.createElement('div');
    mockup.className = 'html-theme-card-mockup';
    mockup.style.setProperty('--mock-bg', preset.background);
    mockup.style.setProperty('--mock-surface', preset.surface);
    mockup.style.setProperty('--mock-primary', preset.primary);
    mockup.style.setProperty('--mock-accent', preset.accent);
    mockup.style.setProperty('--mock-text', preset.text);
    mockup.innerHTML = `
      <span class="mock-sidebar">
        <span class="mock-bar-title"></span>
        <span class="mock-nav-line"></span>
        <span class="mock-nav-line is-short"></span>
      </span>
      <span class="mock-main">
        <span class="mock-h1"></span>
        <span class="mock-line"></span>
        <span class="mock-line is-short"></span>
        <span class="mock-pill"></span>
      </span>
    `;

    const meta = document.createElement('div');
    meta.className = 'html-theme-card-meta';
    const name = document.createElement('span');
    name.className = 'html-theme-card-name';
    name.textContent = preset.label;
    const mode = document.createElement('span');
    mode.className = 'html-theme-card-mode';
    mode.textContent = preset.scheme === 'dark' ? 'ダーク' : 'ライト';
    meta.append(name, mode);

    btn.append(mockup, meta);
    btn.addEventListener('click', () => {
      state = {
        preset: preset.id,
        scheme: preset.scheme,
        primary: preset.primary,
        accent: preset.accent,
        background: preset.background,
        surface: preset.surface,
        text: preset.text,
        font: preset.font,
        layout: preset.layout,
      };
      render();
      options.onChange?.({ ...state });
    });
    presetButtons.set(preset.id, btn);
    presetGrid.append(btn);
  }

  // Live preview mockup of the selected theme
  const preview = document.createElement('div');
  preview.className = 'html-theme-live-preview';
  preview.setAttribute('aria-label', '出力HTMLのテーマプレビュー');
  preview.innerHTML = `
    <div class="html-theme-preview-sidebar">
      <div class="html-theme-preview-site"></div>
      <div class="html-theme-preview-btn">PDF保存</div>
      <div class="html-theme-preview-toc">
        <span class="is-current">はじめに</span>
        <span>基本操作</span>
        <span>設定と応用</span>
      </div>
    </div>
    <div class="html-theme-preview-main">
      <div class="html-theme-preview-h1">はじめに</div>
      <p class="html-theme-preview-p">選択した配色・フォント・本文幅が出力HTML（単一HTML / MkDocs / Zensical）に反映されます。</p>
      <div class="html-theme-preview-alert">ヒント: リンクや見出しは <span class="html-theme-preview-link">アクセントカラー</span> で強調されます。</div>
    </div>
  `;
  const previewSiteEl = preview.querySelector<HTMLElement>('.html-theme-preview-site')!;

  // Collapsible fine-grained customization
  const customDetails = document.createElement('details');
  customDetails.className = 'html-theme-custom';
  const customSummary = document.createElement('summary');
  customSummary.textContent = '配色・フォント・幅を細かくカスタマイズ';
  const customBody = document.createElement('div');
  customBody.className = 'html-theme-custom-body';

  // Scheme + Font + Layout selectors
  const optionsRow = document.createElement('div');
  optionsRow.className = 'html-theme-options-row';

  const makeSelect = (
    suffix: string,
    labelText: string,
    entries: Array<[string, string]>,
    onPick: (value: string) => void,
  ): HTMLSelectElement => {
    const label = document.createElement('label');
    label.className = 'html-theme-field';
    label.textContent = labelText;
    const select = document.createElement('select');
    select.id = `${options.idPrefix}-theme-${suffix}`;
    select.setAttribute('aria-label', labelText);
    for (const [value, text] of entries) select.add(new Option(text, value));
    select.addEventListener('change', () => {
      onPick(select.value);
      state.preset = 'custom';
      render();
      options.onChange?.({ ...state });
    });
    label.append(select);
    optionsRow.append(label);
    return select;
  };

  const schemeSelect = makeSelect(
    'scheme',
    '配色モード',
    [
      ['light', 'ライト'],
      ['dark', 'ダーク'],
    ],
    (value) => {
      state.scheme = value === 'dark' ? 'dark' : 'light';
    },
  );
  const fontSelect = makeSelect(
    'font',
    'フォント',
    [
      ['sans', 'ゴシック体（標準）'],
      ['serif', '明朝体（読み物向け）'],
      ['mono', '等幅寄り（技術向け）'],
    ],
    (value) => {
      state.font = value;
    },
  );
  const layoutSelect = makeSelect(
    'layout',
    '本文の幅',
    [
      ['standard', '標準（920px）'],
      ['wide', 'ワイド（1160px）'],
      ['compact', 'コンパクト（760px）'],
    ],
    (value) => {
      state.layout = value;
    },
  );

  // Color pickers
  const colorRow = document.createElement('div');
  colorRow.className = 'html-theme-color-row';
  type ColorKey = 'primary' | 'accent' | 'background' | 'surface' | 'text';
  const colorInputs = new Map<ColorKey, { input: HTMLInputElement; code: HTMLElement }>();
  const colorDefs: Array<[ColorKey, string]> = [
    ['primary', 'メイン'],
    ['accent', 'アクセント'],
    ['background', '背景'],
    ['surface', 'サイドバー'],
    ['text', '文字'],
  ];
  for (const [key, labelText] of colorDefs) {
    const label = document.createElement('label');
    label.className = 'html-theme-color-chip';
    const swatchWrap = document.createElement('span');
    swatchWrap.className = 'html-theme-color-swatch';
    const input = document.createElement('input');
    input.type = 'color';
    input.id = `${options.idPrefix}-theme-${key}`;
    input.setAttribute('aria-label', `${labelText}カラー`);
    const code = document.createElement('code');
    code.className = 'html-theme-color-hex';
    swatchWrap.append(input, code);
    const caption = document.createElement('span');
    caption.textContent = labelText;
    label.append(caption, swatchWrap);
    input.addEventListener('input', () => {
      state[key] = input.value.toLowerCase();
      state.preset = 'custom';
      render();
      options.onChange?.({ ...state });
    });
    colorInputs.set(key, { input, code });
    colorRow.append(label);
  }

  customBody.append(optionsRow, colorRow);
  customDetails.append(customSummary, customBody);
  root.append(headingRow, presetGrid, preview, customDetails);
  host.append(root);

  const fontCss: Record<string, string> = {
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", sans-serif',
    serif: '"Noto Serif JP", "Yu Mincho", "Hiragino Mincho ProN", Georgia, serif',
    mono: '"JetBrains Mono", "Noto Sans Mono CJK JP", Consolas, monospace',
  };

  function render(): void {
    activeBadge.textContent = themeStyleLabel(state);
    for (const [id, btn] of presetButtons) {
      const active = state.preset === id;
      btn.setAttribute('aria-checked', String(active));
      btn.classList.toggle('is-selected', active);
    }
    schemeSelect.value = state.scheme;
    fontSelect.value = state.font;
    layoutSelect.value = state.layout;
    for (const [key, pair] of colorInputs) {
      pair.input.value = state[key];
      pair.code.textContent = state[key];
    }
    previewSiteEl.textContent = siteTitle || 'マニュアル';
    preview.dataset.scheme = state.scheme;
    preview.dataset.layout = state.layout;
    preview.style.setProperty('--pv-bg', state.background);
    preview.style.setProperty('--pv-surface', state.surface);
    preview.style.setProperty('--pv-primary', state.primary);
    preview.style.setProperty('--pv-accent', state.accent);
    preview.style.setProperty('--pv-text', state.text);
    preview.style.setProperty('--pv-font', fontCss[state.font] || fontCss.sans);
  }

  render();

  return {
    getValue: () => ({ ...state }),
    setValue: (next) => {
      state = normalizeHtmlThemeStyle(next);
      render();
    },
    setSiteName: (name) => {
      siteTitle = name.trim() || 'マニュアル';
      previewSiteEl.textContent = siteTitle;
    },
    setDisabled: (disabled) => {
      for (const btn of presetButtons.values()) btn.disabled = disabled;
      schemeSelect.disabled = disabled;
      fontSelect.disabled = disabled;
      layoutSelect.disabled = disabled;
      for (const pair of colorInputs.values()) pair.input.disabled = disabled;
    },
  };
}
