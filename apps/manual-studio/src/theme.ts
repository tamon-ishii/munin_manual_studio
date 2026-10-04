export const themeOptions = [
  { id: "forest", label: "フォレスト（白）" },
  { id: "blue", label: "ブルー（白）" },
  { id: "warm", label: "ウォーム（白）" },
  { id: "charcoal", label: "チャコール（黒）" },
  { id: "midnight", label: "ミッドナイト（黒）" },
  { id: "dark-forest", label: "ダークフォレスト（黒）" },
] as const;

export type ThemeId = typeof themeOptions[number]["id"];
type ThemePalette = Record<string, string>;

const storageKey = "manual-studio-theme";
const palettes: Record<ThemeId, ThemePalette> = {
  forest: {
    "--app-bg": "#f7f8f6", "--surface-bg": "#ffffff", "--surface-raised": "#ffffff", "--surface-soft": "#f0f3ed",
    "--text-primary": "#26342f", "--text-secondary": "#52624d", "--text-muted": "#748076", "--border-color": "#dce3d9", "--border-strong": "#cbd7cc",
    "--accent": "#285d46", "--accent-hover": "#1f4c38", "--accent-soft": "#e8f0e6", "--accent-text": "#ffffff", "--input-bg": "#ffffff", "--input-text": "#26342f",
    "--danger": "#b03932", "--selection-bg": "#b8d9bf", "--shadow-color": "#20352518", "--color-scheme": "light",
  },
  blue: {
    "--app-bg": "#f5f8fc", "--surface-bg": "#ffffff", "--surface-raised": "#ffffff", "--surface-soft": "#edf2f9",
    "--text-primary": "#26364a", "--text-secondary": "#4e6178", "--text-muted": "#718196", "--border-color": "#d8e1ed", "--border-strong": "#c4d2e3",
    "--accent": "#315f9d", "--accent-hover": "#254c80", "--accent-soft": "#e5eef9", "--accent-text": "#ffffff", "--input-bg": "#ffffff", "--input-text": "#26364a",
    "--danger": "#b03945", "--selection-bg": "#c0d7f4", "--shadow-color": "#243b5a18", "--color-scheme": "light",
  },
  warm: {
    "--app-bg": "#faf7f2", "--surface-bg": "#fffdfa", "--surface-raised": "#ffffff", "--surface-soft": "#f4eee4",
    "--text-primary": "#3b332c", "--text-secondary": "#675a4d", "--text-muted": "#8a7c6e", "--border-color": "#e7ddd0", "--border-strong": "#d9cbbc",
    "--accent": "#98613e", "--accent-hover": "#7d4d30", "--accent-soft": "#f3e8dc", "--accent-text": "#ffffff", "--input-bg": "#fffdfa", "--input-text": "#3b332c",
    "--danger": "#a64435", "--selection-bg": "#efd2b1", "--shadow-color": "#49351f18", "--color-scheme": "light",
  },
  charcoal: {
    "--app-bg": "#202422", "--surface-bg": "#282d2b", "--surface-raised": "#303633", "--surface-soft": "#343b37",
    "--text-primary": "#edf1ee", "--text-secondary": "#c4cec7", "--text-muted": "#9aa69e", "--border-color": "#414b45", "--border-strong": "#56635b",
    "--accent": "#82c69a", "--accent-hover": "#9bd8ad", "--accent-soft": "#344c3c", "--accent-text": "#17271c", "--input-bg": "#242a27", "--input-text": "#edf1ee",
    "--danger": "#ff978d", "--selection-bg": "#435d4a", "--shadow-color": "#00000060", "--color-scheme": "dark",
  },
  midnight: {
    "--app-bg": "#171d29", "--surface-bg": "#202838", "--surface-raised": "#283246", "--surface-soft": "#2d3950",
    "--text-primary": "#edf2fb", "--text-secondary": "#c2cde0", "--text-muted": "#98a7bd", "--border-color": "#3b4961", "--border-strong": "#50617d",
    "--accent": "#8db9ff", "--accent-hover": "#acd0ff", "--accent-soft": "#304566", "--accent-text": "#14223a", "--input-bg": "#1b2433", "--input-text": "#edf2fb",
    "--danger": "#ff9aa7", "--selection-bg": "#3b5074", "--shadow-color": "#00000066", "--color-scheme": "dark",
  },
  "dark-forest": {
    "--app-bg": "#19221e", "--surface-bg": "#202b25", "--surface-raised": "#29372f", "--surface-soft": "#2d3c32",
    "--text-primary": "#eaf2ec", "--text-secondary": "#c2d2c6", "--text-muted": "#95a99a", "--border-color": "#394c3f", "--border-strong": "#4d6554",
    "--accent": "#8bd3a0", "--accent-hover": "#a5e4b5", "--accent-soft": "#2d4d37", "--accent-text": "#14291b", "--input-bg": "#1c2721", "--input-text": "#eaf2ec",
    "--danger": "#ff9884", "--selection-bg": "#385943", "--shadow-color": "#0000005c", "--color-scheme": "dark",
  },
};

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return themeOptions.some((theme) => theme.id === value);
}

export function currentTheme(): ThemeId {
  const selected = document.documentElement.dataset.theme;
  return isThemeId(selected) ? selected : "forest";
}

export function getThemeVariables(theme: ThemeId = currentTheme()): Readonly<ThemePalette> {
  return palettes[theme];
}

export function applyTheme(theme: ThemeId, persist = true): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = palettes[theme]["--color-scheme"];
  for (const [name, value] of Object.entries(palettes[theme])) {
    if (name !== "--color-scheme") document.documentElement.style.setProperty(name, value);
  }
  if (persist) localStorage.setItem(storageKey, theme);
  window.dispatchEvent(new CustomEvent("manual-studio-theme-change", { detail: theme }));
}

export function initializeTheme(): void {
  const saved = localStorage.getItem(storageKey);
  applyTheme(isThemeId(saved) ? saved : "forest", false);
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey && isThemeId(event.newValue)) applyTheme(event.newValue, false);
  });
}
