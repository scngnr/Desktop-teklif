/**
 * Electron DynamicFunc gövdeleri — Neon modules.code_js için.
 * context: getMacAddress, getApiBaseUrl, runRemoteCodeQuiet, executeFirmAutoStartList, ...
 */

function stub(methodName, reason) {
  return `async function DynamicFunc(context, param) {
  const methodName = ${JSON.stringify(methodName)};
  context.log("[" + methodName + "] " + ${JSON.stringify(reason || "desktop stub")});
  return {
    ok: false,
    unsupported: true,
    runtime: "desktop",
    methodName,
    reason: ${JSON.stringify(reason || "excel-vba-port-pending")},
    param: param == null ? "" : String(param),
  };
}
`;
}

const PORTS = {
  AutoStartOnExcelOpen: `async function DynamicFunc(context, param) {
  context.log("[AutoStartOnExcelOpen] desktop DynamicFunc basladi");
  const mac = await context.getMacAddress();
  if (!mac || String(mac).length < 10) {
    context.log("[AutoStartOnExcelOpen] gecersiz MAC");
    return { ok: false, error: "invalid-mac" };
  }
  let base = "";
  if (param != null && String(param).trim()) base = String(param).trim();
  if (!base) base = context.getApiBaseUrl();
  if (!base.endsWith("/")) base += "/";
  const url = base + "auto-start/" + encodeURIComponent(mac) + "/";
  context.log("[AutoStartOnExcelOpen] URL: " + url);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    context.log("[AutoStartOnExcelOpen] HTTP " + res.status);
    return { ok: false, status: res.status };
  }
  const text = await res.text();
  const result = await context.executeFirmAutoStartList(text);
  context.log("[AutoStartOnExcelOpen] tamamlandi");
  return { ok: true, result };
}
`,

  AutoStartOnDesktopOpen: `async function DynamicFunc(context, param) {
  context.log("[AutoStartOnDesktopOpen] basladi");
  const mac = await context.getMacAddress();
  if (!mac || String(mac).length < 10) {
    return { ok: false, error: "invalid-mac" };
  }
  let base = "";
  if (param != null && String(param).trim()) base = String(param).trim();
  if (!base) base = context.getApiBaseUrl();
  if (!base.endsWith("/")) base += "/";
  const url = base + "auto-start/" + encodeURIComponent(mac) + "/";
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Client": "desktop-teklif" },
  });
  if (!res.ok) return { ok: false, status: res.status };
  const text = await res.text();
  const result = await context.executeFirmAutoStartList(text);
  return { ok: true, result };
}
`,

  HeartbeatPing: `async function DynamicFunc(context, param) {
  const os = require("os");
  let base = context.getApiBaseUrl();
  if (!base.endsWith("/")) base += "/";
  const mac = await context.getMacAddress();
  const body = {
    mac,
    hostname: os.hostname(),
    userName: os.userInfo().username || "",
    excelVersion: "desktop-teklif",
    ipAddress: "",
    client: "desktop-teklif",
    platform: process.platform,
  };
  if (param && String(param).trim().startsWith("{")) {
    try { Object.assign(body, JSON.parse(String(param))); } catch (_) {}
  }
  const res = await fetch(base + "heartbeat/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client": "desktop-teklif" },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  context.log("[HeartbeatPing] status=" + res.status);
  return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
}
`,

  InstallCommandQueue: `async function DynamicFunc(context, param) {
  const fs = require("fs");
  const path = require("path");
  const dir = context.agentDir;
  fs.mkdirSync(dir, { recursive: true });
  const flag = path.join(dir, "command-queue.active");
  fs.writeFileSync(flag, new Date().toISOString(), "utf8");

  if (global.__desktopCommandQueueTimer) {
    clearInterval(global.__desktopCommandQueueTimer);
  }

  const pollOnce = async () => {
    try {
      const mac = await context.getMacAddress();
      let base = context.getApiBaseUrl();
      if (!base.endsWith("/")) base += "/";
      const res = await fetch(base + "commands/" + encodeURIComponent(mac) + "/", {
        headers: { Accept: "application/json", "X-Client": "desktop-teklif" },
      });
      if (!res.ok) return;
      const json = await res.json().catch(() => null);
      const list = (json && (json.data || json.commands || json)) || [];
      const arr = Array.isArray(list) ? list : [];
      for (const cmd of arr) {
        const status = String(cmd.status || "").toLowerCase();
        if (status && status !== "pending" && status !== "queued") continue;
        const name = cmd.module_name || cmd.moduleName || cmd.methodName;
        if (!name) continue;
        try {
          await context.runRemoteCodeQuiet(name, cmd.param);
          if (cmd.id != null) {
            await fetch(base + "commands/" + encodeURIComponent(String(cmd.id)) + "/", {
              method: "PATCH",
              headers: { "Content-Type": "application/json", "X-Client": "desktop-teklif" },
              body: JSON.stringify({ status: "done", result: "ok" }),
            }).catch(() => {});
          }
        } catch (err) {
          context.log("[InstallCommandQueue] cmd hata:", err && err.message);
          if (cmd.id != null) {
            await fetch(base + "commands/" + encodeURIComponent(String(cmd.id)) + "/", {
              method: "PATCH",
              headers: { "Content-Type": "application/json", "X-Client": "desktop-teklif" },
              body: JSON.stringify({ status: "error", error_msg: String(err && err.message || err) }),
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      context.log("[InstallCommandQueue] poll hata:", err && err.message);
    }
  };

  global.__desktopCommandQueueTimer = setInterval(pollOnce, 60000);
  setTimeout(pollOnce, 2000);
  context.log("[InstallCommandQueue] Electron poller aktif (~60sn)");
  return { ok: true, poller: true };
}
`,

  InstallTeklifAgent: `async function DynamicFunc(context, param) {
  const fs = require("fs");
  const path = require("path");
  const dir = context.agentDir;
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    installedAt: new Date().toISOString(),
    client: "desktop-teklif",
    agentDir: dir,
    note: "Desktop Teklif tray process acts as agent; COM/RegAsm Excel agent not used.",
  };
  fs.writeFileSync(path.join(dir, "desktop-agent.json"), JSON.stringify(meta, null, 2), "utf8");
  context.log("[InstallTeklifAgent] desktop agent isaretlendi");
  try { await context.runRemoteCodeQuiet("InstallCommandQueue"); } catch (_) {}
  return { ok: true, agent: "desktop-teklif", meta };
}
`,

  WatchFolderServer: `async function DynamicFunc(context, param) {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");

  let folderPath = "";
  let intervalSec = 30;
  const p = param == null ? "" : String(param).trim();
  if (p.startsWith("{")) {
    try {
      const j = JSON.parse(p);
      folderPath = j.folderPath || j.path || "";
      if (j.intervalSec) intervalSec = Number(j.intervalSec) || 30;
    } catch (_) {}
  } else if (p && !/^https?:/i.test(p)) {
    folderPath = p;
  }
  if (!folderPath) {
    const pathFile = path.join(context.agentDir, "folder-watch-path.txt");
    if (fs.existsSync(pathFile)) folderPath = fs.readFileSync(pathFile, "utf8").trim();
  }
  if (!folderPath) return { ok: false, error: "folderPath yok" };
  if (!folderPath.endsWith("\\\\") && !folderPath.endsWith("/")) folderPath += path.sep;

  const snapFile = path.join(context.agentDir, "folder-watch-snapshot.txt");
  const buildSnap = () => {
    if (!fs.existsSync(folderPath)) return "";
    const names = fs.readdirSync(folderPath).slice(0, 400);
    const parts = [];
    for (const name of names) {
      try {
        const st = fs.statSync(path.join(folderPath, name));
        if (!st.isFile()) continue;
        parts.push(name + ";" + st.size + ";" + Math.floor(st.mtimeMs / 1000));
      } catch (_) {}
    }
    return parts.join("|");
  };

  const postEvent = async (eventType, fileName, detail) => {
    const mac = await context.getMacAddress();
    let base = context.getApiBaseUrl();
    if (!base.endsWith("/")) base += "/";
    const body = {
      mac,
      hostname: os.hostname(),
      folderPath,
      eventType,
      fileName: fileName || "",
      filePath: folderPath + (fileName || ""),
      detail: detail || "",
    };
    await fetch(base + "folder-watch/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client": "desktop-teklif" },
      body: JSON.stringify(body),
    }).catch(() => {});
  };

  if (global.__desktopFolderWatchTimer) clearInterval(global.__desktopFolderWatchTimer);

  const tick = async () => {
    try {
      const neu = buildSnap();
      const old = fs.existsSync(snapFile) ? fs.readFileSync(snapFile, "utf8") : "";
      if (old && neu !== old) {
        const oldSet = new Set(old.split("|").filter(Boolean).map((x) => x.split(";")[0]));
        const newMap = new Map();
        for (const part of neu.split("|").filter(Boolean)) {
          const nm = part.split(";")[0];
          newMap.set(nm, part);
        }
        for (const [nm, part] of newMap) {
          if (!oldSet.has(nm)) await postEvent("created", nm, "Yeni dosya: " + nm);
          else {
            const oldPart = old.split("|").find((x) => x.startsWith(nm + ";"));
            if (oldPart && oldPart !== part) await postEvent("modified", nm, "Degisti: " + nm);
          }
        }
        for (const nm of oldSet) {
          if (!newMap.has(nm)) await postEvent("deleted", nm, "Silindi: " + nm);
        }
      }
      fs.mkdirSync(context.agentDir, { recursive: true });
      fs.writeFileSync(snapFile, neu, "utf8");
      await postEvent("scan", "", "alive");
    } catch (err) {
      context.log("[WatchFolderServer] tick hata:", err && err.message);
    }
  };

  global.__desktopFolderWatchTimer = setInterval(tick, Math.max(5, intervalSec) * 1000);
  await tick();
  context.log("[WatchFolderServer] izleniyor: " + folderPath);
  return { ok: true, folderPath, intervalSec };
}
`,

  CreateFolder: `async function DynamicFunc(context, param) {
  const fs = require("fs");
  const folderPath = String(param || "").trim();
  if (!folderPath) return { ok: false, error: "path bos" };
  fs.mkdirSync(folderPath, { recursive: true });
  return { ok: true, folderPath };
}
`,

  DeleteFolder: `async function DynamicFunc(context, param) {
  const fs = require("fs");
  const folderPath = String(param || "").trim();
  if (!folderPath) return { ok: false, error: "path bos" };
  fs.rmSync(folderPath, { recursive: true, force: true });
  return { ok: true, folderPath };
}
`,

  CopyFolder: `async function DynamicFunc(context, param) {
  const fs = require("fs");
  const path = require("path");
  let src = "", dst = "";
  const p = String(param || "").trim();
  if (p.startsWith("{")) {
    const j = JSON.parse(p);
    src = j.src || j.from || "";
    dst = j.dst || j.to || "";
  } else {
    const parts = p.split("|");
    src = (parts[0] || "").trim();
    dst = (parts[1] || "").trim();
  }
  if (!src || !dst) return { ok: false, error: "src|dst gerekli" };
  fs.cpSync(src, dst, { recursive: true });
  return { ok: true, src, dst };
}
`,

  ListFolderContents: `async function DynamicFunc(context, param) {
  const fs = require("fs");
  const path = require("path");
  const folderPath = String(param || "").trim();
  if (!folderPath || !fs.existsSync(folderPath)) return { ok: false, error: "klasor yok", items: [] };
  const items = fs.readdirSync(folderPath).map((name) => {
    const full = path.join(folderPath, name);
    let type = "unknown", size = 0;
    try {
      const st = fs.statSync(full);
      type = st.isDirectory() ? "dir" : "file";
      size = st.size;
    } catch (_) {}
    return { name, type, size };
  });
  return { ok: true, folderPath, items };
}
`,

  CleanTempFolder: `async function DynamicFunc(context, param) {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const { execFile } = require("child_process");
  const { promisify } = require("util");
  const execFileAsync = promisify(execFile);
  const temp = os.tmpdir();
  if (process.platform === "win32") {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", "Remove-Item -Path $env:TEMP\\* -Recurse -Force -ErrorAction SilentlyContinue"],
      { windowsHide: true, timeout: 60000 }
    ).catch(() => {});
  } else {
    for (const name of fs.readdirSync(temp)) {
      try { fs.rmSync(path.join(temp, name), { recursive: true, force: true }); } catch (_) {}
    }
  }
  return { ok: true, temp };
}
`,

  MoveFolder: `async function DynamicFunc(context, param) {
  const fs = require("fs");
  let src = "", dst = "";
  const p = String(param || "").trim();
  if (p.startsWith("{")) {
    const j = JSON.parse(p);
    src = j.src || j.from || "";
    dst = j.dst || j.to || "";
  } else {
    const parts = p.split("|");
    src = (parts[0] || "").trim();
    dst = (parts[1] || "").trim();
  }
  if (!src || !dst) return { ok: false, error: "src|dst gerekli" };
  fs.renameSync(src, dst);
  return { ok: true, src, dst };
}
`,
};

function buildCodeJs(methodName, excelHeavy) {
  if (PORTS[methodName]) return PORTS[methodName];
  if (excelHeavy) {
    return stub(methodName, "excel-only-module");
  }
  return stub(methodName, "os-module-port-pending");
}

module.exports = { PORTS, stub, buildCodeJs };
