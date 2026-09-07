import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LocalTool, ModelConfig } from '../../api/types';
import type { TKey } from '../../i18n';

vi.mock('../../components', () => ({
  EffortPulse: () => null,
  getModelIcon: () => null,
}));

const tool: LocalTool = {
  id: 'test-tool',
  name: 'Test Tool',
  category: 'Desktop',
  installed: true,
  apiProtocol: ['openai'],
};

const models: ModelConfig[] = [
  {
    internalId: 'cloud-model',
    name: 'Cloud Model',
    baseUrl: 'https://cloud.example/v1',
    apiKey: '',
  },
  {
    internalId: 'local-server',
    name: 'Local Model',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: '',
  },
  {
    internalId: 'smart-router',
    name: 'Auto Router',
    baseUrl: 'http://127.0.0.1:53683/v1',
    apiKey: '',
  },
];

const labels: Partial<Record<TKey, string>> = {
  'agent.badge.smart': '智能',
  'agent.badge.local': '本地',
};

describe('ModelListSection', () => {
  it('renders smart, local, and cloud models as one ordered list with compact badges', async () => {
    vi.stubGlobal('__APP_EDITION__', 'full');
    const { ModelListSection } = await import('./AppManagerComponents');
    const markup = renderToStaticMarkup(
      <ModelListSection
        selectedToolData={tool}
        userModels={models}
        toolModelConfig={{}}
        selectedTool={tool.id}
        handleSelectModel={() => undefined}
        modelProtocolSelection={{}}
        setModelProtocolSelection={() => undefined}
        t={(key) => labels[key] ?? key}
      />
    );

    expect(markup).toContain('智能');
    expect(markup).toContain('本地');
    expect(markup.indexOf('Auto Router')).toBeLessThan(markup.indexOf('Local Model'));
    expect(markup.indexOf('Local Model')).toBeLessThan(markup.indexOf('Cloud Model'));
  });
});

describe('desktopParentDir', () => {
  it('returns the parent dir, or null for bare commands', async () => {
    const { desktopParentDir } = await import('./AppManagerComponents');
    expect(desktopParentDir('/usr/bin/code')).toBe('/usr/bin');
    expect(desktopParentDir('C:\\Program Files\\App\\app.exe')).toBe('C:\\Program Files\\App');
    // Bare PATH commands and module refs have no directory to reveal.
    expect(desktopParentDir('opencode')).toBeNull();
    expect(desktopParentDir('python -m module')).toBeNull();
  });
});

const menuLabels: Partial<Record<TKey, string>> = {
  'btn.launchApp': '启动应用',
  'desktopMenu.reveal': '打开文件位置',
  'desktopMenu.hideIcon': '隐藏',
  'desktopMenu.permanentDelete': '删除',
  'desktopMenu.clickToRestore': '单击图标可恢复',
  'desktopMenu.restoreAll': '全部恢复',
  'desktopMenu.deleteAll': '全部删除',
  'addApp.title': '添加应用',
  'addApp.customSection': '手动添加',
  'addApp.nameLabel': '名称',
  'addApp.namePlaceholder': '例如：我的编辑器',
  'addApp.pathLabel': '程序路径',
  'addApp.browse': '浏览…',
  'addApp.add': '添加',
  'addApp.mySection': '我添加的',
  'addApp.remove': '删除',
  'addApp.deletedSection': '已删除，点击恢复',
  'addApp.restore': '恢复',
};

describe('DesktopContextMenu', () => {
  const t = (key: TKey) => menuLabels[key] ?? key;
  const noop = () => undefined;

  it('renders launch, reveal, hide, and delete only (no uninstall)', async () => {
    const { DesktopContextMenu } = await import('./DesktopContextMenu');
    const markup = renderToStaticMarkup(
      <DesktopContextMenu
        t={t}
        x={100}
        y={100}
        canReveal
        onLaunch={noop}
        onReveal={noop}
        onHide={noop}
        onPermanentDelete={noop}
        onClose={noop}
      />
    );
    expect(markup).toContain('启动应用');
    expect(markup).toContain('打开文件位置');
    expect(markup).toContain('隐藏');
    expect(markup).toContain('删除');
    expect(markup).not.toContain('卸载应用');
  });

  it('hidden mode shows only restore and delete', async () => {
    const { DesktopContextMenu } = await import('./DesktopContextMenu');
    const markup = renderToStaticMarkup(
      <DesktopContextMenu
        t={(key: TKey) => (key === 'addApp.restore' ? '恢复' : (menuLabels[key] ?? key))}
        x={100}
        y={100}
        mode="hidden"
        canReveal={false}
        onLaunch={noop}
        onReveal={noop}
        onHide={noop}
        onPermanentDelete={noop}
        onRestore={noop}
        onClose={noop}
      />
    );
    expect(markup).toContain('恢复');
    expect(markup).toContain('删除');
    expect(markup).not.toContain('启动应用');
    expect(markup).not.toContain('打开文件位置');
    expect(markup).not.toContain('卸载应用');
  });
});

describe('customNameFromPath', () => {
  it('derives the entry name from the executable file stem', async () => {
    const { customNameFromPath } = await import('./AppManagerComponents');
    expect(customNameFromPath('/usr/bin/code')).toBe('code');
    expect(customNameFromPath('C:\\Program Files\\App\\app.exe')).toBe('app');
    expect(customNameFromPath('WeChat.lnk')).toBe('WeChat');
  });
});

describe('HiddenToolsDialog', () => {
  const t = (key: TKey) => menuLabels[key] ?? key;
  const noop = () => undefined;
  const tools: LocalTool[] = Array.from({ length: 8 }, (_, i) => ({
    id: `hidden-${i}`,
    name: `Hidden ${i}`,
    category: 'Desktop',
    installed: true,
  }));

  it('renders every hidden tool in a 7-column dialog one third of the window tall', async () => {
    const { HiddenToolsDialog } = await import('./AppManagerComponents');
    const markup = renderToStaticMarkup(
      <HiddenToolsDialog
        tools={tools}
        onRestore={noop}
        onPermanentDelete={noop}
        onRestoreAll={noop}
        onDeleteAll={noop}
        onContextMenu={noop}
        onClose={noop}
        t={t}
      />
    );
    expect(markup).toContain('grid-cols-7');
    expect(markup).toContain('h-[33vh]');
    expect(markup).toContain('overflow-y-auto');
    for (const tool of tools) expect(markup).toContain(tool.name);
    // Hint line above the grid: click an icon to restore it.
    expect(markup).toContain('单击图标可恢复');
    // × badge per icon for hard delete.
    expect(markup).toContain('aria-label="删除"');
  });

  it('shows the header batch actions for a non-empty dialog', async () => {
    const { HiddenToolsDialog } = await import('./AppManagerComponents');
    const markup = renderToStaticMarkup(
      <HiddenToolsDialog
        tools={tools}
        onRestore={noop}
        onPermanentDelete={noop}
        onRestoreAll={noop}
        onDeleteAll={noop}
        onContextMenu={noop}
        onClose={noop}
        t={t}
      />
    );
    expect(markup).toContain('aria-label="全部恢复"');
    expect(markup).toContain('aria-label="全部删除"');
    expect(markup).toContain('全部恢复');
    expect(markup).toContain('全部删除');
  });

  it('omits the header batch actions when nothing is hidden', async () => {
    const { HiddenToolsDialog } = await import('./AppManagerComponents');
    const markup = renderToStaticMarkup(
      <HiddenToolsDialog
        tools={[]}
        onRestore={noop}
        onPermanentDelete={noop}
        onRestoreAll={noop}
        onDeleteAll={noop}
        onContextMenu={noop}
        onClose={noop}
        t={t}
      />
    );
    expect(markup).not.toContain('全部恢复');
    expect(markup).not.toContain('全部删除');
    expect(markup).not.toContain('单击图标可恢复');
  });
});

describe('AddAppDialog', () => {
  const t = (key: TKey) => menuLabels[key] ?? key;
  const noop = () => undefined;

  it('renders the manual-add form, custom entries, and deleted tools', async () => {
    const { AddAppDialog } = await import('./AppManagerComponents');
    const markup = renderToStaticMarkup(
      <AddAppDialog
        customs={[{ id: 'custom-1', name: 'My Editor', path: '/usr/bin/myeditor' }]}
        deleted={[{ id: 'gone-tool', name: 'Gone Tool', category: 'Desktop', installed: true }]}
        onAdd={noop}
        onRemoveCustom={noop}
        onRestoreDeleted={noop}
        onClose={noop}
        t={t}
      />
    );
    expect(markup).toContain('添加应用');
    expect(markup).toContain('手动添加');
    expect(markup).toContain('浏览…');
    expect(markup).toContain('My Editor');
    expect(markup).toContain('/usr/bin/myeditor');
    expect(markup).toContain('Gone Tool');
    expect(markup).toContain('恢复');
  });
});
