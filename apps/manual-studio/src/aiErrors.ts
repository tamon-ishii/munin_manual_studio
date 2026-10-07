export interface AiErrorAdvice { title: string; action: string }
export function aiErrorAdvice(message: string): AiErrorAdvice | null {
  if (/not logged in|authentication expired|unauthorized|HTTP 401|\/login|未ログイン/i.test(message)) return { title: 'AIの認証を確認してください', action: '選択したCLIでログインし直してください。API接続の場合は「AI設定・出力」のAPIキーを確認してください。' };
  if (/AI CLI is unavailable|Failed to (?:run|spawn command in PTY).*No such file|command not found/i.test(message)) return { title: 'AI CLIが見つかりません', action: '選択したCLIをインストールし、PATHから実行できることを確認するか、「AI設定・出力」で別の接続を選んでください。' };
  if (/AI API connection failed|connection refused|HTTP (?:429|5\d\d)|fetch failed|Failed to fetch/i.test(message)) return { title: 'AIへの接続に失敗しました', action: '接続先URLとサーバーの起動状態を確認してください。混雑や利用制限の場合は時間を置いて再実行してください。' };
  if (/制限時間|タイムアウト|timed? ?out/i.test(message)) return { title: 'AIの応答が制限時間を超えました', action: '生成するタグを減らすか指示を短くして再実行してください。接続先の動作状況も確認してください。' };
  if (/AI回答|parse .*JSON|parse model content|intermediate event|empty answer|invalid answer|no answer list/i.test(message)) return { title: 'AIの回答形式が不完全です', action: '指示を短くして再実行してください。繰り返す場合は、構造化された回答に対応する別のモデルまたはCLIを選んでください。' };
  if (/AI接続は未設定/.test(message)) return { title: 'AI接続を設定してください', action: '「AI設定・出力」で接続方式とモデルを設定してください。' };
  return null;
}
