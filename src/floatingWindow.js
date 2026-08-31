/**
 * Masaüstü overlay pencereleri (FAB + teklif modal) — Windows, macOS, Linux.
 * Windows'taki screen-saver alwaysOnTop / şeffaf pencere varsayımları
 * Linux ve Darwin'de kırılıyordu; platforma göre chrome burada seçilir.
 */

function platformFlags(platform = process.platform) {
  return {
    isWin: platform === 'win32',
    isMac: platform === 'darwin',
    isLinux: platform === 'linux',
  };
}

function alwaysOnTopLevel(platform = process.platform) {
  if (platform === 'darwin') return 'floating';
  if (platform === 'win32') return 'screen-saver';
  return null;
}

function overlayWindowType(platform = process.platform) {
  if (platform === 'darwin') return 'panel';
  if (platform === 'linux') return 'toolbar';
  return null;
}

function cornerBounds(workArea, width, height, margin) {
  const area = workArea || { x: 0, y: 0, width, height };
  const m = Number(margin) || 0;
  return {
    x: Math.round(area.x + Math.max(0, area.width - width - m)),
    y: Math.round(area.y + Math.max(0, area.height - height - m)),
    width,
    height,
  };
}

function centerBounds(workArea, width, height) {
  const area = workArea || { x: 0, y: 0, width, height };
  return {
    x: Math.round(area.x + Math.max(0, (area.width - width) / 2)),
    y: Math.round(area.y + Math.max(0, (area.height - height) / 2)),
    width,
    height,
  };
}

function enableLinuxTransparency(electronApp, platform = process.platform) {
  if (platform !== 'linux' || !electronApp || !electronApp.commandLine) return;
  try {
    electronApp.commandLine.appendSwitch('enable-transparent-visuals');
  } catch {
    // komut satırı anahtarı yok sayılır
  }
}

function overlayBrowserOptions({ width, height, preload, platform = process.platform }) {
  const { isMac, isLinux } = platformFlags(platform);
  const options = {
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: !isLinux,
    show: false,
    focusable: true,
    movable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  const type = overlayWindowType(platform);
  if (type) options.type = type;
  if (isMac) options.hiddenInMissionControl = true;
  return options;
}

function applyFloatingBehavior(win, platform = process.platform) {
  if (!win || (win.isDestroyed && win.isDestroyed())) return;
  const level = alwaysOnTopLevel(platform);
  try {
    if (level && platform === 'darwin') win.setAlwaysOnTop(true, level, 1);
    else if (level) win.setAlwaysOnTop(true, level);
    else win.setAlwaysOnTop(true);
  } catch {
    try {
      win.setAlwaysOnTop(true);
    } catch {
      // WM alwaysOnTop desteklemiyor olabilir
    }
  }

  try {
    if (platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    } else if (platform === 'linux') {
      win.setVisibleOnAllWorkspaces(true);
    } else {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
  } catch {
    // Linux WM / eski Electron
  }

  try {
    win.setSkipTaskbar(true);
  } catch {
    // ignore
  }
}

function showOverlay(win, { stealFocus = false, platform = process.platform } = {}) {
  if (!win || (win.isDestroyed && win.isDestroyed())) return;
  applyFloatingBehavior(win, platform);
  try {
    if (stealFocus) {
      win.show();
      if (typeof win.focus === 'function') win.focus();
    } else if (platform === 'linux') {
      if (typeof win.showInactive === 'function') win.showInactive();
      if (typeof win.isVisible === 'function' && !win.isVisible()) win.show();
    } else if (typeof win.showInactive === 'function') {
      win.showInactive();
    } else {
      win.show();
    }
  } catch {
    try {
      win.show();
    } catch {
      // ignore
    }
  }
  applyFloatingBehavior(win, platform);
}

module.exports = {
  platformFlags,
  alwaysOnTopLevel,
  overlayWindowType,
  cornerBounds,
  centerBounds,
  enableLinuxTransparency,
  overlayBrowserOptions,
  applyFloatingBehavior,
  showOverlay,
};

if (require.main === module) {
  const assert = (cond, msg) => {
    if (!cond) {
      console.error('FAIL', msg);
      process.exitCode = 1;
    } else console.log('ok', msg);
  };
  const c = cornerBounds({ x: 0, y: 0, width: 1920, height: 1080 }, 188, 64, 22);
  assert(c.x === 1920 - 188 - 22, 'corner x');
  assert(c.y === 1080 - 64 - 22, 'corner y');
  const macHiDpi = cornerBounds({ x: 0, y: 25, width: 1440, height: 875 }, 188, 64, 22);
  assert(macHiDpi.y === 25 + 875 - 64 - 22, 'mac workArea y');
  assert(alwaysOnTopLevel('darwin') === 'floating', 'mac level');
  assert(alwaysOnTopLevel('win32') === 'screen-saver', 'win level');
  assert(alwaysOnTopLevel('linux') === null, 'linux level omitted');
  assert(overlayWindowType('darwin') === 'panel', 'mac panel');
  assert(overlayWindowType('linux') === 'toolbar', 'linux toolbar');
  assert(overlayWindowType('win32') === null, 'win default type');
  const linuxOpts = overlayBrowserOptions({
    width: 10,
    height: 10,
    preload: '/tmp/x.js',
    platform: 'linux',
  });
  assert(linuxOpts.type === 'toolbar', 'linux opts type');
  assert(linuxOpts.transparent === true, 'linux still transparent');
  const macOpts = overlayBrowserOptions({
    width: 10,
    height: 10,
    preload: '/tmp/x.js',
    platform: 'darwin',
  });
  assert(macOpts.type === 'panel', 'mac opts type');
  assert(macOpts.hiddenInMissionControl === true, 'mac mission control');
  if (!process.exitCode) console.log('floatingWindow self-check passed');
}
