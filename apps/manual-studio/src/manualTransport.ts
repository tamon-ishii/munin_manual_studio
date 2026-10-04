export interface ManualRequest {
  root: string;
  action: string;
  options: Record<string, unknown>;
}

/** Transport errors must not be interpreted as successful empty output. */
export async function sendManualRequest(
  request: ManualRequest,
  nativeRequest?: (request: ManualRequest) => Promise<string>,
  fetchRequest: typeof fetch = fetch,
): Promise<string> {
  if (!request.root) throw new Error("先にプロジェクトのフォルダーを開いてください。");
  if (nativeRequest) return nativeRequest(request);
  const response = await fetchRequest("/__manual/rpc", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
  });
  let result: unknown;
  try { result = await response.json(); }
  catch { throw new Error(`サーバーの応答を読み取れませんでした（HTTP ${response.status}）。`); }
  if (!result || typeof result !== "object") throw new Error("サーバーが不正な応答を返しました。");
  const envelope = result as { output?: unknown; error?: unknown };
  if (!response.ok || typeof envelope.error === "string") {
    throw new Error(typeof envelope.error === "string" ? envelope.error : `処理に失敗しました（HTTP ${response.status}）。`);
  }
  if (typeof envelope.output !== "string") throw new Error("サーバー応答に処理結果がありません。");
  return envelope.output;
}
