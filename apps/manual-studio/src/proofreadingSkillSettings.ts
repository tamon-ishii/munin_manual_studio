import {consultationAgents} from './cliAiSettings';

type InstallResult = {path: string; already_installed: boolean};

export function setupProofreadingSkillSettings(
  anchor: HTMLElement,
  install: (agent: string, skill: string) => Promise<InstallResult>,
) {
  const section = document.createElement('section');
  section.className = 'card';
  section.innerHTML = `
    <h3>推敲スキルのインストール</h3>
    <label>AI クライアント <select></select></label>
    <label>推敲スキル
      <select>
        <option value="yomiyasu">yomiyasu（nanaism）</option>
        <option value="natural-japanese">natural-japanese（coji）</option>
        <option value="japanese-tech-writing">japanese-tech-writing（k16shikano）</option>
      </select>
    </label>
    <p class="muted" data-destination></p>
    <button type="button">インストール</button>
    <p role="status"></p>`;
  const [agent, skill] = section.querySelectorAll('select');
  for (const client of consultationAgents) agent.add(new Option(client.label, client.id));
  const destination = section.querySelector<HTMLElement>('[data-destination]')!;
  const status = section.querySelector<HTMLElement>('[role="status"]')!;
  const button = section.querySelector('button')!;
  const update = () => {
    const folder = agent.value === 'claude' ? '.claude' : '.agents';
    destination.textContent = `現在のプロジェクトに配置します（${folder}/skills/${skill.value}）。`;
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
  anchor.after(section);
}
