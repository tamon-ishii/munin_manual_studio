export type CaptureSource = { kind: "window"; title: string; inset: number } | { kind: "scenario"; input: string };
export interface Task { name?: string; id: string; kind: string; page: string; prompt: string; status: string }
export interface HtmlThemeStyle {
  preset?: string;
  scheme?: 'light' | 'dark' | string;
  primary?: string;
  accent?: string;
  background?: string;
  surface?: string;
  text?: string;
  font?: 'sans' | 'serif' | 'mono' | string;
  layout?: 'standard' | 'wide' | 'compact' | string;
}
export interface State {
  alert_icons?: boolean;
  has_config: boolean;
  config: {
    docs: string;
    output: string;
    agent: string;
    model: string;
    cli_models?: Record<string, string>;
    connection_type?: string;
    endpoint_url?: string;
    assets?: string;
    mkdocs: {
      site_name: string;
      theme: string;
      language: string;
      use_directory_urls: boolean;
      nav?: Array<{ page: string; title?: string; section?: string; hidden?: boolean }>;
      exclude_unused_assets?: boolean;
      theme_style?: HtmlThemeStyle;
      working_directory?: string;
    };
  };
  execution_results?: Record<string, {status:string;error?:string;run_id:string}>;
  update_reasons?: Record<string, string[]>;
  brief: string; pages: string[]; project_entries: Array<{ path: string; directory: boolean }>; image_assets: Record<string, string>;
  capture_sources: Record<string, CaptureSource>;
  agents: Array<{ id: string; label: string; available: boolean }>;
}
export interface Document { page: string; content: string; revision: string }

export interface ResourceUsage {page:string;line:number;start:number;end:number;snippet:string}
