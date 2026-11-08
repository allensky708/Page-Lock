import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

class TFile {
  extension = 'md';
  constructor(path) {
    this.path = path;
    this.basename = path.replace(/\.[^.]+$/, '');
  }
}
class Plugin {
  register() {}
  registerEvent() {}
  registerDomEvent() {}
  addCommand() {}
  addRibbonIcon() {}
  addSettingTab() {}
  loadData = async () => ({});
  saveData = async () => {};
}
const obsidian = {
  Plugin,
  TFile,
  Modal: class {},
  PluginSettingTab: class {},
  Notice: class {},
  Platform: { isMobile: false },
};

const nodeRequire = createRequire(import.meta.url);
const module = { exports: {} };
runInNewContext(readFileSync(new URL('../main.js', import.meta.url), 'utf8'), {
  module,
  exports: module.exports,
  require: (name) => (name === 'obsidian' ? obsidian : nodeRequire(name)),
  console,
  Date,
  window: {},
  crypto: globalThis.crypto,
});
const NoteLock = module.exports.default;

test('canvas locks are tracked by path and applied through the read-only API', () => {
  const plugin = new NoteLock();
  plugin.settings = { ...plugin.settings, lockedCanvasPaths: ['board.canvas'] };

  let readonlyValue = null;
  const view = {
    file: { path: 'board.canvas', extension: 'canvas', basename: 'board' },
    containerEl: { querySelectorAll: () => [] },
    canvas: {
      setReadonly(value) {
        readonlyValue = value;
      },
    },
    addAction() {
      return { addClass() {} };
    },
  };

  plugin.refreshCanvasView(view);
  assert.equal(readonlyValue, true);
  assert.equal(plugin.isCanvasLocked('board.canvas'), true);

  plugin.settings.lockedCanvasPaths = [];
  plugin.refreshCanvasView(view);
  assert.equal(readonlyValue, false);
  assert.equal(plugin.isCanvasLocked('board.canvas'), false);
});
