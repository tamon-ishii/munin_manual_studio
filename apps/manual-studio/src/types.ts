export type CaptureSource = { kind: "window"; title: string; inset: number } | { kind: "scenario"; input: string };
export interface Task { id: string; kind: string; page: string; prompt: string; status: string }
export interface UIMap { total_elements: number; views: Array<{ id: string; name: string; observed_from?: string; elements: Array<{ name: string; role: string; selector: string }> }> }
export interface State {
  has_config: boolean;
  config: { docs: string; output: string; agent: string; model: string; connection_type?: string; endpoint_url?: string; assets?: string; mkdocs: { site_name: string; theme: string; language: string; use_directory_urls: boolean } };
  brief: string; pages: string[]; project_entries: Array<{ path: string; directory: boolean }>; tasks: Task[]; image_assets: Record<string, string>;
  capture_sources: Record<string, CaptureSource>; ui_map: UIMap | null;
  agents: Array<{ id: string; label: string; available: boolean }>;
}
export interface Document { page: string; content: string; revision: string }
export interface NativeWindow { id: string; title: string; width: number; height: number }
export interface RecordingResult { scenarioFile: string; events: number; operationText: string; sourceFile: string; annotationFile: string; completionFile: string; markitsStarted: boolean; message: string }
export interface LaunchCommand { name: string; program: string; args: string[] }
