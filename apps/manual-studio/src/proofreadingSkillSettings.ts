import {consultationAgents} from './cliAiSettings';

type InstallResult = {path: string; already_installed: boolean};

const SKILL_DESCRIPTIONS: Record<string, string> = {
  yomiyasu: '読みやすさ・文章の明快さを整える日本語推敲スキル',
  'natural-japanese': '翻訳調を抑え、自然な日本語表現に整えるスキル',
  'japanese-tech-writing': 'マニュアルや技術文書向けの簡潔な表記に整えるスキル',
};

export function setupProofreadingSkillSettings(
  anchor: HTMLElement,
  install: (agent: string, skill: string) => Promise<InstallResult>,
) {
  const details = document.createElement('details');
  details.className = 'settings-advanced-details';
  details.innerHTML = `
    <summary>高度な設定: AI推敲スキルのインストール</summary>
    <p class="muted">AIターミナルから文章を推敲する際のガイドライン（スキル）をプロジェクトへ配置できます。</p>
    <div class="settings-grid">
      <label>対象のAI CLI <select></select></label>
      <label>推敲スキル
        <select>
          <option value="yomiyasu">yomiyasu（読みやすさ重視）</option>
          <option value="natural-japanese">natural-japanese（自然な日本語）</option>
          <option value="japanese-tech-writing">japanese-tech-writing（技術文書・マニュアル向け）</option>
        </select>
      </label>
    </div>
    <p class="muted" data-skill-desc></p>
    <p class="muted" data-destination></p>
    <div class="actions"><button type="button">プロジェクトへインストール</button><span role="status"></span></div>`;
  const [agent, skill] = details.querySelectorAll('select');
  for (const client of consultationAgents) agent.add(new Option(client.label, client.id));
  const desc = details.querySelector<HTMLElement>('[data-skill-desc]')!;
  const destination = details.querySelector<HTMLElement>('[data-destination]')!;
  const status = details.querySelector<HTMLElement>('[role="status"]')!;
  const button = details.querySelector('button')!;
  const update = () => {
    const folder = agent.value === 'claude' ? '.claude' : '.agents';
    desc.textContent = SKILL_DESCRIPTIONS[skill.value] || '';
    destination.textContent = `配置先: ${folder}/skills/${skill.value}`;
    status.textContent = '';
  };
  agent.onchange = update;
  skill.onchange = update;
  button.onclick = async () => {
    agent.disabled = skill.disabled = button.disabled = true;
    status.textContent = '配布元から取得しています…';
    try {
      const result = await install(agent.value, skill.value);
      status.textContent = result.already_installed
        ? `配置済みです（${result.path}）。`
        : `インストールしました（${result.path}）。このプロジェクトから AI を起動してください。`;
    } catch (error) {
      status.textContent = String(error);
    } finally {
      agent.disabled = skill.disabled = button.disabled = false;
    }
  };
  update();
  anchor.after(details);
}
