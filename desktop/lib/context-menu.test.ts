import { describe, expect, it, vi } from 'vitest';
import { buildContextMenuTemplate, parseWorkspacePictureUrl, type ContextMenuActions } from './context-menu.js';

function createActions(): { actions: ContextMenuActions; calls: Array<[string, ...unknown[]]> } {
  const calls: Array<[string, ...unknown[]]> = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
  };
  return {
    calls,
    actions: {
      writeText: vi.fn(record('writeText')),
      copyImageAt: vi.fn(record('copyImageAt')),
      downloadURL: vi.fn(record('downloadURL')),
      openExternal: vi.fn(record('openExternal')),
      loadURL: vi.fn(record('loadURL')),
      replaceMisspelling: vi.fn(record('replaceMisspelling')),
    },
  };
}

describe('desktop context menu template builder', () => {
  it('returns an empty menu when there is nothing to act on', () => {
    const { actions } = createActions();
    const template = buildContextMenuTemplate(
      { isEditable: false, selectionText: '', mediaType: 'none', linkURL: '' },
      { appPort: 41234 },
      actions,
    );
    expect(template).toEqual([]);
  });

  it('offers Copy when non-editable text is selected', () => {
    const { actions } = createActions();
    const template = buildContextMenuTemplate(
      { isEditable: false, selectionText: 'Retry disk save cleanly', editFlags: { canCopy: true } },
      { appPort: 41234 },
      actions,
    );
    expect(template).toEqual([
      expect.objectContaining({ label: 'Copy', role: 'copy', enabled: true }),
    ]);
  });

  it('offers Cut, Copy, Paste, Select all, and spelling suggestions in editable fields', () => {
    const { actions, calls } = createActions();
    const template = buildContextMenuTemplate(
      {
        isEditable: true,
        selectionText: 'teh',
        misspelledWord: 'teh',
        dictionarySuggestions: ['the', 'tea'],
        editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      },
      { appPort: 41234 },
      actions,
    );

    expect(template.map((item) => item.type === 'separator' ? '---' : item.label)).toEqual([
      'the',
      'tea',
      '---',
      'Cut',
      'Copy',
      'Paste',
      'Select all',
    ]);

    template[0].click?.();
    expect(calls).toEqual([['replaceMisspelling', 'the']]);
  });

  it('offers picture actions for workspace pictures using &download=1 and copies workspace-relative path', () => {
    const { actions, calls } = createActions();
    const srcURL = 'http://localhost:41234/api/workspace/my-ws/documents/file?name=board-pictures%2Fsplit.png&open=1';
    expect(parseWorkspacePictureUrl(srcURL, 41234)).toEqual({
      downloadUrl: 'http://localhost:41234/api/workspace/my-ws/documents/file?name=board-pictures%2Fsplit.png&download=1',
      filePath: 'board-pictures/split.png',
    });

    const template = buildContextMenuTemplate(
      { x: 120, y: 240, mediaType: 'image', hasImageContents: true, srcURL },
      { appPort: 41234 },
      actions,
    );

    expect(template.map((item) => item.label)).toEqual([
      'Copy picture',
      'Save picture as…',
      'Copy picture address',
      'Copy file path',
    ]);

    for (const item of template) {
      item.click?.();
    }

    expect(calls).toEqual([
      ['copyImageAt', 120, 240],
      ['downloadURL', 'http://localhost:41234/api/workspace/my-ws/documents/file?name=board-pictures%2Fsplit.png&download=1'],
      ['writeText', srcURL],
      ['writeText', 'board-pictures/split.png'],
    ]);
  });

  it('includes repo prefix in workspace-relative file path when repo query parameter is present', () => {
    expect(
      parseWorkspacePictureUrl(
        'http://localhost:41234/api/workspace/ws-1/documents/file?name=docs%2Farch.png&repo=NexusFlow',
        41234,
      ),
    ).toEqual({
      downloadUrl: 'http://localhost:41234/api/workspace/ws-1/documents/file?name=docs%2Farch.png&repo=NexusFlow&download=1',
      filePath: 'NexusFlow/docs/arch.png',
    });
  });

  it('offers picture actions without Copy file path for external pictures', () => {
    const { actions, calls } = createActions();
    const srcURL = 'https://example.com/assets/diagram.png';
    const template = buildContextMenuTemplate(
      { x: 10, y: 20, mediaType: 'image', hasImageContents: true, srcURL },
      { appPort: 41234 },
      actions,
    );

    expect(template.map((item) => item.label)).toEqual([
      'Copy picture',
      'Save picture as…',
      'Copy picture address',
    ]);

    template[0].click?.();
    template[1].click?.();
    template[2].click?.();

    expect(calls).toEqual([
      ['copyImageAt', 10, 20],
      ['downloadURL', srcURL],
      ['writeText', srcURL],
    ]);
  });

  it('handles safe external links, app-shell links, and omits Open link for blocked URLs', () => {
    const ext = createActions();
    const extTemplate = buildContextMenuTemplate(
      { linkURL: 'https://example.com/docs' },
      { appPort: 41234 },
      ext.actions,
    );
    expect(extTemplate.map((i) => i.label)).toEqual(['Open link', 'Copy link address']);
    extTemplate[0].click?.();
    extTemplate[1].click?.();
    expect(ext.calls).toEqual([
      ['openExternal', 'https://example.com/docs'],
      ['writeText', 'https://example.com/docs'],
    ]);

    const app = createActions();
    const appTemplate = buildContextMenuTemplate(
      { linkURL: 'http://localhost:41234/#/workspaces/demo' },
      { appPort: 41234 },
      app.actions,
    );
    expect(appTemplate.map((i) => i.label)).toEqual(['Open link', 'Copy link address']);
    appTemplate[0].click?.();
    expect(app.calls).toEqual([['loadURL', 'http://localhost:41234/#/workspaces/demo']]);

    const docOpen = createActions();
    const docOpenUrl = 'http://localhost:41234/api/workspace/x/documents/file?name=a.html&open=1';
    const docOpenTemplate = buildContextMenuTemplate(
      { linkURL: docOpenUrl },
      { appPort: 41234 },
      docOpen.actions,
    );
    expect(docOpenTemplate.map((i) => i.label)).toEqual(['Open link', 'Copy link address']);
    docOpenTemplate[0].click?.();
    expect(docOpen.calls).toEqual([['openExternal', docOpenUrl]]);

    const blocked = createActions();
    for (const badUrl of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'http://localhost:9999/secret',
      'http://localhost:41234/api/workspace/x/documents/file?name=a.html',
    ]) {
      const blockedTemplate = buildContextMenuTemplate(
        { linkURL: badUrl },
        { appPort: 41234 },
        blocked.actions,
      );
      expect(blockedTemplate.map((i) => i.label)).not.toContain('Open link');
    }
  });

  it('rejects invalid appPort, credentialed workspace URLs, and unsafe image download schemes', () => {
    expect(parseWorkspacePictureUrl('http://localhost:0/api/workspace/ws/documents/file?name=a.png', 0)).toBeNull();
    expect(parseWorkspacePictureUrl('http://user:pass@localhost:41234/api/workspace/ws/documents/file?name=a.png', 41234)).toBeNull();

    const { actions } = createActions();
    const template = buildContextMenuTemplate(
      { mediaType: 'image', hasImageContents: true, srcURL: 'file:///etc/passwd' },
      { appPort: 41234 },
      actions,
    );
    expect(template.map((i) => i.label)).toEqual(['Copy picture', 'Copy picture address']);
  });

  it('offers Copy picture only when the image has pixels', () => {
    const { actions } = createActions();
    const srcURL = 'https://example.com/a.png';
    const withPixels = buildContextMenuTemplate({ mediaType: 'image', hasImageContents: true, srcURL }, { appPort: 41234 }, actions);
    expect(withPixels.map((i) => i.label)).toContain('Copy picture');
    for (const hasImageContents of [false, undefined]) {
      const none = buildContextMenuTemplate({ mediaType: 'image', hasImageContents, srcURL }, { appPort: 41234 }, actions);
      expect(none.map((i) => i.label)).not.toContain('Copy picture');
      expect(none.map((i) => i.label)).toContain('Copy picture address');
    }
    expect(buildContextMenuTemplate({ mediaType: 'image', hasImageContents: false }, { appPort: 41234 }, actions)).toEqual([]);
  });

  it('keeps a folder that shares the repo name: the path is the repo plus the name, as the endpoint resolves it', () => {
    expect(
      parseWorkspacePictureUrl('http://localhost:41234/api/workspace/ws-1/documents/file?name=myapp%2Flogo.png&repo=myapp', 41234)?.filePath,
    ).toBe('myapp/myapp/logo.png');
  });
});
