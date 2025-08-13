const child_process = require('child_process');
const { SIGINT } = require('constants');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const process = require('process');
const semver = require('semver');
const URL = require('url').URL;
const vscode = require('vscode');
const vsls = require('vsls');
const WebSocket = require('ws');

var connections = {}; // Map of connection ID to connection objects
var windows = {}; // Map of "connectionId:windowId" to window objects
var crcTable = null;
var extcontext = null;
var log = {
    name: "CraftOS-PC",
    append: function (value) { void value; },
    appendLine: function (value) { void value; },
    replace: function (value) { void value; },
    clear: () => { },
    show: () => { },
    hide: () => { },
    dispose: () => { }
};

function makeCRCTable() {
    let c;
    let crcTable = [];
    for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c;
    }
    return crcTable;
}

function crc32(str) {
    crcTable = crcTable || makeCRCTable();
    let crc = 0 ^ (-1);
    for (let i = 0; i < str.length; i++) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ str.charCodeAt(i)) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
};

function bufferstream(str) {
    let retval = {}
    retval.pos = 0
    retval.str = str
    retval.readUInt64 = function () {
        let r = Number(this.str.readBigUInt64LE(this.pos));
        this.pos += 8;
        return r;
    }
    retval.readUInt32 = function () {
        let r = this.str.readUInt32LE(this.pos);
        this.pos += 4;
        return r;
    }
    retval.readUInt16 = function () {
        let r = this.str.readUInt16LE(this.pos);
        this.pos += 2;
        return r;
    }
    retval.get = function () {
        return this.str.readUInt8(this.pos++);
    };
    retval.putback = function () { this.pos--; }
    return retval;
}

function validateURL(str) {
    try {
        let url = new URL(str);
        return url.protocol.toLowerCase() == "ws:" || url.protocol.toLowerCase() == "wss:";
    } catch (e) { return false; }
}

const computer_provider = {
    getChildren: element => {
        if (element === undefined || element === null) {
            let arr = [];
            // Build list directly from window map so guests see host windows too
            for (let w in windows) {
                if (!windows[w].isMonitor) {
                    const connectionId = w.split(":")[0];
                    const title = windows[w].term && windows[w].term.title ? windows[w].term.title : `Computer ${connectionId}`;
                    arr.push({ title: `[${connectionId}] ${title}`, id: w, connectionId: connectionId });
                }
            }
            return arr;
        } else return null;
    },
    getTreeItem: element => {
        let r = new vscode.TreeItem(element.title);
        r.iconPath = vscode.Uri.file(path.join(extcontext.extensionPath, 'media/computer.svg'));
        r.command = { command: "craftos-pc.open-window", title: "CraftOS-PC: Open Window", arguments: [element] };
        const supportsFS = (connections[element.connectionId] && connections[element.connectionId].supportsFilesystem) ||
            (isLiveShareGuest && remoteFlags[element.connectionId] && remoteFlags[element.connectionId].supportsFilesystem);
        if (supportsFS) r.contextValue = "data-available";
        return r;
    },
    _onDidChangeTreeData: new vscode.EventEmitter(),
};
computer_provider.onDidChangeTreeData = computer_provider._onDidChangeTreeData.event;

const monitor_provider = {
    getChildren: element => {
        if (element === undefined || element === null) {
            let arr = [];
            // Build list directly from window map so guests see host windows too
            for (let w in windows) {
                if (windows[w].isMonitor) {
                    const connectionId = w.split(":")[0];
                    const title = windows[w].term && windows[w].term.title ? windows[w].term.title : `Monitor ${connectionId}`;
                    arr.push({ title: `[${connectionId}] ${title}`, id: w, connectionId: connectionId });
                }
            }
            return arr;
        }
        else return null;
    },
    getTreeItem: element => {
        let r = new vscode.TreeItem(element.title);
        r.iconPath = vscode.Uri.file(path.join(extcontext.extensionPath, 'media/monitor.svg'));
        r.command = { command: "craftos-pc.open-window", title: "CraftOS-PC: Open Window", arguments: [element] };
        return r;
    },
    _onDidChangeTreeData: new vscode.EventEmitter(),
}
monitor_provider.onDidChangeTreeData = monitor_provider._onDidChangeTreeData.event;

var connections = {}; // Map of connection ID to connection objects
var nextConnectionId = 1;
var didShowBetaMessage = false;
var processFeatures = {};
/** @type vsls.LiveShare|null */
var liveshare = null;
/** @type vsls.SharedServiceProxy|null */
var vslsClient = null;
/** @type vsls.SharedService|null */
var vslsServer = null;
// Live Share guest-only flags per connection (received from host)
var remoteFlags = {}; // { [connectionId: string]: { isVersion11: boolean, useBinaryChecksum: boolean, supportsFilesystem: boolean } }
var isLiveShareGuest = false;
// Live Share guest-only connections summary (received from host)
var remoteConnections = {}; // { [connectionId: string]: { type: string, connected: boolean, supportsFilesystem: boolean, isVersion11: boolean, useBinaryChecksum: boolean } }

// Notify Live Share guests about state changes. If full is true, send the
// entire windows map. Otherwise, send a compact update for a single window.
function notifyLiveShareState(full = false, updatedWindowKey = null) {
    if (vslsServer === null) return;
    const payload = { flags: buildLiveShareFlags(), connections: buildLiveShareConnections() };
    if (full || !updatedWindowKey || !windows[updatedWindowKey]) {
        // Full state (may be large): windows + flags + connections
        payload.windows = windows;
    } else {
        // Compact update: just the latest term for the updated window
        payload.update = { id: updatedWindowKey, term: windows[updatedWindowKey].term };
    }
    vslsServer.notify("state", payload);
}

// Build per-connection feature flags for Live Share guests
function buildLiveShareFlags() {
    /** @type {Record<string, {isVersion11: boolean, useBinaryChecksum: boolean, supportsFilesystem: boolean}>} */
    const flags = {};
    for (let id in connections) {
        const conn = connections[id];
        if (!conn) continue;
        flags[id] = {
            isVersion11: !!conn.isVersion11,
            useBinaryChecksum: !!conn.useBinaryChecksum,
            supportsFilesystem: !!conn.supportsFilesystem,
        };
    }
    return flags;
}

// Build a simple connections summary for Live Share guests
function buildLiveShareConnections() {
    /** @type {Record<string, {type: string, connected: boolean, supportsFilesystem: boolean, isVersion11: boolean, useBinaryChecksum: boolean}>} */
    const summary = {};
    for (let id in connections) {
        const conn = connections[id];
        if (!conn) continue;
        const isWebSocket = conn.connection && conn.connection.connected !== undefined;
        const connected = isWebSocket ? !!conn.connection.connected : true;
        summary[id] = {
            type: isWebSocket ? 'WebSocket' : 'Process',
            connected,
            supportsFilesystem: !!conn.supportsFilesystem,
            isVersion11: !!conn.isVersion11,
            useBinaryChecksum: !!conn.useBinaryChecksum,
        };
    }
    return summary;
}

function getSetting(name) {
    const config = vscode.workspace.getConfiguration(name);
    if (config.get("all") !== null && config.get("all") !== "") return config.get("all");
    else if (os.platform() === "win32") return config.get("windows").replace(/%([^%]+)%/g, (_, n) => process.env[n] || ('%' + n + '%'));
    else if (os.platform() === "darwin") return config.get("mac").replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'));
    else if (os.platform() === "linux") return config.get("linux").replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'));
    else return null;
}

function getDataPath() {
    const config = vscode.workspace.getConfiguration("craftos-pc");
    if (config.get("dataPath") !== null && config.get("dataPath") !== "") return config.get("dataPath");
    else if (os.platform() === "win32") return "%appdata%\\CraftOS-PC".replace(/%([^%]+)%/g, (_, n) => process.env[n] || ('%' + n + '%'));
    else if (os.platform() === "darwin") return "$HOME/Library/Application Support/CraftOS-PC".replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'))
    else if (os.platform() === "linux") return "$HOME/.local/craftos-pc".replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'))
    else return null;
}

function getExecutable() {
    let path = getSetting("craftos-pc.executablePath");
    if (path !== null && fs.existsSync(path)) return path;
    if (os.platform() === "win32") {
        path = "%localappdata%\\Programs\\CraftOS-PC\\CraftOS-PC_console.exe".replace(/%([^%]+)%/g, (_, n) => process.env[n] || ('%' + n + '%'));
        if (fs.existsSync(path)) return path;
    }
    if (path !== null && os.platform() === "win32" && fs.existsSync(path.replace("_console", ""))) {
        vscode.window.showErrorMessage("The CraftOS-PC installation is missing the console version, which is required for this extension to function. Please run the installer again, making sure to check the 'Console build for raw mode' box.");
        return null;
    }
    vscode.window.showErrorMessage("The CraftOS-PC executable could not be found. Check the path in the settings. If you haven't installed CraftOS-PC yet, [download it from the official website.](https://www.craftos-pc.cc)");
    return null;
}

function closeAllWindows() {
    for (let k in windows) if (windows[k].panel !== undefined) windows[k].panel.dispose();
    windows = {};
    computer_provider._onDidChangeTreeData.fire(null);
    monitor_provider._onDidChangeTreeData.fire(null);
    notifyLiveShareState(true);
}

function closeConnection(connectionId) {
    if (!connections[connectionId]) return;

    // Close all windows for this connection
    for (let k in windows) {
        if (k.startsWith(connectionId + ":")) {
            if (windows[k].panel !== undefined) windows[k].panel.dispose();
            delete windows[k];
        }
    }

    // Close the connection
    const conn = connections[connectionId];
    if (conn.connection.connected) {
        conn.connection.stdin.write(conn.useBinaryChecksum ? "!CPC000CBAACAAAAAAAA2C7A548B\n" : "!CPC000CBAACAAAAAAAA3AB9B910\n", "utf8");
        conn.connection.disconnect();
    } else {
        conn.connection.kill(SIGINT);
    }

    delete connections[connectionId];
    computer_provider._onDidChangeTreeData.fire(null);
    monitor_provider._onDidChangeTreeData.fire(null);
    notifyLiveShareState(true);
}

function queueDataRequest(connectionId, id, type, path, path2) {
    if (!connections[connectionId] || !connections[connectionId].connection) return new Promise((resolve, reject) => reject(new Error("Connection not open")));
    const conn = connections[connectionId];
    let filedata = undefined;
    if ((type & 0xF1) === 0x11) {
        filedata = path2;
        path2 = undefined;
    }
    const pathbuf = Buffer.from(path, "latin1");
    const path2buf = (typeof path2 === "string" ? Buffer.from(path2, "latin1") : null);
    const data = Buffer.alloc(5 + pathbuf.length + (typeof path2 === "string" ? path2buf.length + 1 : 0));
    data[0] = 7;
    data[1] = id;
    data[2] = type;
    data[3] = conn.nextDataRequestID;
    conn.nextDataRequestID = (conn.nextDataRequestID + 1) & 0xFF;
    data.set(pathbuf, 4);
    if (typeof path2 === "string") data.set(path2buf, 5 + pathbuf.length);
    const b64 = data.toString('base64');
    const packet = "!CPC" + ("000" + b64.length.toString(16)).slice(-4) + b64 + ("0000000" + crc32(conn.useBinaryChecksum ? data.toString("binary") : b64).toString(16)).slice(-8) + "\n";
    conn.connection.stdin.write(packet, 'utf8');
    if (typeof filedata !== "undefined") {
        const data2 = Buffer.alloc(8 + filedata.length);
        data2[0] = 9;
        data2[1] = id;
        data2[2] = 0;
        data2[3] = data[3];
        data2.writeInt32LE(filedata.length, 4);
        data2.set(filedata, 8);
        const b642 = data2.toString('base64');
        const packet2 = (b642.length > 65535 ? "!CPD" + ("00000000000" + b642.length.toString(16)).slice(-12) : "!CPC" + ("000" + b642.length.toString(16)).slice(-4)) + b642 + ("0000000" + crc32(conn.useBinaryChecksum ? data2.toString("binary") : b642).toString(16)).slice(-8) + "\n";
        conn.connection.stdin.write(packet2, 'utf8');
    }
    return new Promise((resolve, reject) => {
        let tid = setTimeout(() => {
            delete conn.dataRequestCallbacks[data[3]];
            log.appendLine("Could not get info for " + path + " (request " + data[3] + ")");
            reject(new Error("Timeout"));
        }, 3000);
        conn.dataRequestCallbacks[data[3]] = (data, err) => {
            clearTimeout(tid);
            if (!err) resolve(data);
            else reject(err);
        }
    });
}

function checkVersion(silent) {
    const exe_path = getSetting("craftos-pc.executablePath");
    if (exe_path === null) return;
    child_process.execFile(exe_path, ["--version"], { windowsHide: true }, (err, stdout) => {
        if (err) {
            if (!silent) vscode.window.showErrorMessage("Failed to detect CraftOS-PC version (error: " + err.message + "). Please check that the path is correct and working properly.");
            return;
        }
        let version = (stdout.match(/CraftOS-PC v([\d\.]+)/) || [])[1];
        if (version === undefined || version === null) {
            if (!silent) vscode.window.showErrorMessage("Failed to detect CraftOS-PC version (error: no version number detected)." + (os.platform() === "win32" ? "Make sure the path is pointing to CraftOS-PC_console.exe, and not CraftOS-PC.exe." : ""));
            return;
        }
        log.appendLine("Detected CraftOS-PC " + version);
        const semverVersion = semver.coerce(version);
        processFeatures.debugger = semver.gt(semverVersion, "2.6.6");
        processFeatures.filesystem = semver.gte(semverVersion, "2.6.0");
        if (!silent) {
            if (version == "2.5.4" || version == "2.5.5") vscode.window.showWarningMessage("This version of CraftOS-PC crashes when using multiple windows. Update to a newer version to fix this.");
            else if (version == "2.5.1") vscode.window.showWarningMessage("This version of CraftOS-PC often crashes when using the extension. Update to a newer version to fix this.");
            else if (semver.lt(version, "2.4.0")) vscode.window.showWarningMessage("This version of CraftOS-PC does not support using multiple windows properly. Update to a newer version to fix this.");
        }
    });
}

/**
 * @implements {vscode.FileSystemProvider}
 */
class RawFileSystemProvider {
    constructor() {
        this._onDidChangeFile = new vscode.EventEmitter();
        this.onDidChangeFile = this._onDidChangeFile.event;
    }

    _getConnectionFromUri(uri) {
        // Extract connection ID from authority (e.g., "conn1-windowId" or just "windowId")
        const parts = uri.authority.split('-');
        const connectionId = parts.length > 1 ? parts[0] : '1'; // Default to connection 1 if not specified
        const windowId = parts.length > 1 ? parseInt(parts[1]) : parseInt(uri.authority);

        const conn = connections[connectionId];
        if (!conn || !conn.connection) throw vscode.FileSystemError.Unavailable("Connection not open");
        if (!conn.supportsFilesystem) throw vscode.FileSystemError.Unavailable("Connected computer doesn't support filesystems");

        return { connectionId, windowId };
    }

    /**
     * @param {vscode.Uri} source
     * @param {vscode.Uri} destination
     * @param {{overwrite: boolean}} options
     */
    copy(source, destination, options) {
        void source; void destination; void options;
        throw vscode.FileSystemError.Unavailable("Copy is not supported by CraftOS-PC filesystem");
    }
    /**
     * @param {vscode.Uri} uri 
     */
    createDirectory(uri) {
        const { connectionId, windowId } = this._getConnectionFromUri(uri);
        return queueDataRequest(connectionId, windowId, 10, uri.path);
    }
    /**
     * @param {vscode.Uri} uri 
     * @param {{recursive: boolean}} options
     */
    delete(uri, options) {
        void options;
        const { connectionId, windowId } = this._getConnectionFromUri(uri);
        return queueDataRequest(connectionId, windowId, 11, uri.path);
    }
    /**
     * @param {vscode.Uri} uri 
     */
    readDirectory(uri) {
        const { connectionId, windowId } = this._getConnectionFromUri(uri);
        return new Promise(resolve => {
            queueDataRequest(connectionId, windowId, 7, uri.path).then(files => {
                let arr = [];
                let promises = [];
                for (let f of files) {
                    promises.push(new Promise(resolve => queueDataRequest(connectionId, windowId, 1, path.join(uri.path, f)).then(isDir => {
                        arr.push([f, isDir ? vscode.FileType.Directory : vscode.FileType.File]);
                        resolve();
                    }).catch(() => {
                        arr.push([f, vscode.FileType.Unknown]);
                        resolve();
                    })));
                }
                return Promise.all(promises).then(() => {
                    arr.sort((a, b) => {
                        if (a[1] == vscode.FileType.File && b[1] == vscode.FileType.Directory) return 1;
                        else if (b[1] == vscode.FileType.File && a[1] == vscode.FileType.Directory) return -1;
                        else return a[0].localeCompare(b[0]);
                    });
                    resolve(arr);
                });
            });
        });
    }
    /**
     * @param {vscode.Uri} uri 
     */
    readFile(uri) {
        const { connectionId, windowId } = this._getConnectionFromUri(uri);
        return queueDataRequest(connectionId, windowId, 20, uri.path).then(data => Uint8Array.from(data));
    }
    /**
     * @param {vscode.Uri} oldUri 
     * @param {vscode.Uri} newUri 
     * @param {{overwrite: boolean}} options 
     */
    rename(oldUri, newUri, options) {
        void options; // overwrite ignored
        if (oldUri.authority !== newUri.authority) throw vscode.FileSystemError.Unavailable("Cannot move files between connections");
        const { connectionId, windowId } = this._getConnectionFromUri(oldUri);
        return queueDataRequest(connectionId, windowId, 13, oldUri.path, newUri.path);
    }
    /**
     * @param {vscode.Uri} uri 
     */
    stat(uri) {
        const { connectionId, windowId } = this._getConnectionFromUri(uri);
        return queueDataRequest(connectionId, windowId, 8, uri.path).then(attributes => {
            if (attributes === null) throw vscode.FileSystemError.FileNotFound(uri);
            return {
                ctime: attributes.created.getTime(),
                mtime: attributes.modified.getTime(),
                size: attributes.size,
                type: attributes.isDir ? vscode.FileType.Directory : vscode.FileType.File
            }
        });
    }
    /**
     * @param {vscode.Uri} uri 
     * @param {{excludes: string[], recursive: boolean}} options
     */
    watch(uri, options) {
        void uri; void options; // unimplemented
        return null;
    }
    /**
     * @param {vscode.Uri} uri 
     * @param {Uint8Array} content
     * @param {{create: boolean, overwrite: boolean}} options
     */
    writeFile(uri, content, options) {
        void options;
        const { connectionId, windowId } = this._getConnectionFromUri(uri);
        return queueDataRequest(connectionId, windowId, 21, uri.path, content);
    }
}

const debugAdapterFactory = {
    /**
     * @param {vscode.DebugSession} session
     */
    createDebugAdapterDescriptor: (session) => {
        if (session.configuration.request === "launch") {
            if (!processFeatures.debugger) {
                vscode.window.showErrorMessage("This version of CraftOS-PC does not support debugging. Please update to the latest version.");
                return null;
            }
            const exe_path = getSetting("craftos-pc.executablePath");
            if (exe_path === null) {
                vscode.window.showErrorMessage("Please set the path to the CraftOS-PC executable in the settings.");
                return null;
            }
            if (!fs.existsSync(exe_path)) {
                vscode.window.showErrorMessage("The CraftOS-PC executable could not be found. Check the path in the settings." + (os.platform() === "win32" ? " If you installed CraftOS-PC without administrator privileges, you will need to set the path manually. Also make sure CraftOS-PC_console.exe exists in the install directory - if not, reinstall CraftOS-PC with the Console build component enabled." : ""));
                return null;
            }
            const dir = vscode.workspace.getConfiguration("craftos-pc").get("dataPath");
            let args = vscode.workspace.getConfiguration("craftos-pc").get("additionalArguments");
            if (args !== null) { args = args.split(' '); args.push("--exec"); args.push("periphemu.create(0,'debug_adapter')") }
            else args = ["--exec", "periphemu.create(0,'debug_adapter')"];
            if (dir !== null) args.splice(0, 0, "-d", dir);
            return new vscode.DebugAdapterExecutable(exe_path, args);
        } else if (session.configuration.request === "attach") {
            return new vscode.DebugAdapterServer(session.configuration.port || 12100, session.configuration.host);
        } else return undefined;
    }
}

/**
 * @param {Buffer} chunk data
 * @param {string} connectionId
 */
function processDataChunk(connectionId, chunk) {
    if (typeof chunk === "string") chunk = new Buffer(chunk, "utf8");
    const conn = connections[connectionId];
    if (!conn) return;

    if (conn.data_continuation !== null) {
        chunk = Buffer.concat([conn.data_continuation, chunk]);
        conn.data_continuation = null;
    }
    while (chunk.length > 0) {
        let off;
        if (chunk.subarray(0, 4).toString() === "!CPC") off = 8;
        else if (chunk.subarray(0, 4).toString() === "!CPD" && conn.isVersion11) off = 16;
        else {
            log.appendLine("Invalid message");
            return;
        }
        const size = parseInt(chunk.subarray(4, off).toString(), 16);
        if (size > chunk.length + 9) {
            conn.data_continuation = chunk;
            return;
        }
        const data = Buffer.from(chunk.subarray(off, size + off).toString(), 'base64');
        const good_checksum = parseInt(chunk.subarray(size + off, size + off + 8).toString(), 16);
        const data_checksum = crc32(conn.useBinaryChecksum ? data.toString("binary") : chunk.subarray(off, size + off).toString());
        if (good_checksum !== data_checksum) {
            log.appendLine("Bad checksum: expected " + good_checksum.toString(16) + ", got " + data_checksum.toString(16));
            chunk = chunk.subarray(size + 16);
            while (String.fromCharCode(chunk[0]).match(/\s/)) chunk = chunk.subarray(1);
            continue;
        }
        let term = {}
        const stream = bufferstream(data);
        const type = stream.get();
        const id = stream.get();
        const windowKey = connectionId + ":" + id;
        if (!conn.gotMessage && type == 4) conn.connection.stdin.write("!CPC0008BgADAA==498C93D2\n"); // 0x0003
        conn.gotMessage = true;
        let winid = null;
        if (type === 0) {
            term.mode = stream.get();
            term.blink = stream.get() === 1;
            term.width = stream.readUInt16();
            term.height = stream.readUInt16();
            term.cursorX = stream.readUInt16();
            term.cursorY = stream.readUInt16();
            stream.readUInt32();
            term.screen = {}
            term.colors = {}
            term.pixels = {}
            if (term.mode === 0) {
                let c = stream.get();
                let n = stream.get();
                for (let y = 0; y < term.height; y++) {
                    term.screen[y] = {}
                    for (let x = 0; x < term.width; x++) {
                        term.screen[y][x] = c;
                        n--;
                        if (n === 0) {
                            c = stream.get();
                            n = stream.get();
                        }
                    }
                }
                for (let y = 0; y < term.height; y++) {
                    term.colors[y] = {}
                    for (let x = 0; x < term.width; x++) {
                        term.colors[y][x] = c;
                        n--;
                        if (n === 0) {
                            c = stream.get();
                            n = stream.get();
                        }
                    }
                }
                stream.putback();
                stream.putback();
            } else if (term.mode === 1 || term.mode === 2) {
                let c = stream.get();
                let n = stream.get();
                for (let y = 0; y < term.height * 9; y++) {
                    term.pixels[y] = {}
                    for (let x = 0; x < term.width * 6; x++) {
                        term.pixels[y][x] = c;
                        n--;
                        if (n === 0) {
                            c = stream.get();
                            n = stream.get();
                        }
                    }
                }
                stream.putback();
                stream.putback();
            }
            term.palette = {}
            if (term.mode === 0 || term.mode === 1) {
                for (let i = 0; i < 16; i++) {
                    term.palette[i] = {}
                    term.palette[i].r = stream.get();
                    term.palette[i].g = stream.get();
                    term.palette[i].b = stream.get();
                }
            } else if (term.mode === 2) {
                for (let i = 0; i < 256; i++) {
                    term.palette[i] = {}
                    term.palette[i].r = stream.get();
                    term.palette[i].g = stream.get();
                    term.palette[i].b = stream.get();
                }
            }
        } else if (type === 4) {
            const type2 = stream.get();
            if (type2 === 2) {
                if (conn.connection.connected) {
                    conn.connection.stdin.write("\n", "utf8");
                    conn.connection.disconnect();
                } else {
                    conn.connection.kill(SIGINT);
                    //vscode.window.showWarningMessage("The CraftOS-PC worker process did not close correctly. Some changes may not have been saved.")
                }
                closeConnection(connectionId);
                return;
            } else if (type2 === 1) {
                if (windows[windowKey] && windows[windowKey].panel !== undefined) windows[windowKey].panel.dispose();
                delete windows[windowKey];
                computer_provider._onDidChangeTreeData.fire(null);
                monitor_provider._onDidChangeTreeData.fire(null);
                notifyLiveShareState(true);
                chunk = chunk.subarray(size + 16);
                while (String.fromCharCode(chunk[0]).match(/\s/)) chunk = chunk.subarray(1);
                continue;
            } else if (type2 === 0) {
                winid = stream.get();
                term.width = stream.readUInt16();
                term.height = stream.readUInt16();
                term.title = "";
                for (let c = stream.get(); c !== 0; c = stream.get()) term.title += String.fromCharCode(c);
                if (windows[windowKey] !== undefined) {
                    windows[windowKey].isMonitor = typeof term.title === "string" && term.title.indexOf("Monitor") !== -1;
                    if (winid > 0) {
                        windows[windowKey].computerID = winid - 1;
                        windows[windowKey].isMonitor = false;
                    } else {
                        windows[windowKey].computerID = parseInt(connectionId);
                    }
                }
            }
        } else if (type === 5) {
            const flags = stream.readUInt32();
            let title = "";
            for (let c = stream.get(); c !== 0; c = stream.get()) title += String.fromCharCode(c);
            let message = "";
            for (let c = stream.get(); c !== 0; c = stream.get()) message += String.fromCharCode(c);
            switch (flags) {
                case 0x10: vscode.window.showErrorMessage(`CraftOS-PC [${connectionId}]: ${title}: ${message}`); break;
                case 0x20: vscode.window.showWarningMessage(`CraftOS-PC [${connectionId}]: ${title}: ${message}`); break;
                case 0x40: vscode.window.showInformationMessage(`CraftOS-PC [${connectionId}]: ${title}: ${message}`); break;
            }
        } else if (type === 6) {
            const flags = stream.readUInt16();
            conn.isVersion11 = true;
            conn.useBinaryChecksum = (flags & 1) === 1;
            const previousFilesystemSupport = conn.supportsFilesystem;
            conn.supportsFilesystem = (flags & 2) === 2;
            computer_provider._onDidChangeTreeData.fire(null);
            notifyLiveShareState(true);

            // Auto-connect filesystem if it's newly supported
            if (conn.supportsFilesystem && !previousFilesystemSupport) {
                // Delay the auto-connect to ensure window is created
                setTimeout(() => autoConnectFilesystem(connectionId), 1000);
            }
        } else if (type === 8) {
            const reqtype = stream.get();
            const reqid = stream.get();
            if (!conn.dataRequestCallbacks[reqid]) {
                log.appendLine("Got stray response for request ID " + reqid + ", ignoring.");
                chunk = chunk.subarray(size + 16);
                while (String.fromCharCode(chunk[0]).match(/\s/)) chunk = chunk.subarray(1);
                continue;
            }
            switch (reqtype) {
                case 0: case 1: case 2: {
                    const ok = stream.get();
                    if (ok === 0) conn.dataRequestCallbacks[reqid](false);
                    else if (ok === 1) conn.dataRequestCallbacks[reqid](true);
                    else conn.dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                    break;
                } case 3: case 5: case 6: {
                    const size = stream.readUInt32();
                    if (size === 0xFFFFFFFF) conn.dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                    else conn.dataRequestCallbacks[reqid](size);
                    break;
                } case 4: {
                    let str = "";
                    for (let c = stream.get(); c !== 0; c = stream.get()) str += String.fromCharCode(c);
                    if (str !== "") conn.dataRequestCallbacks[reqid](str);
                    else conn.dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                    break;
                } case 7: case 9: {
                    const size = stream.readUInt32();
                    if (size === 0xFFFFFFFF) conn.dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                    else {
                        let arr = [];
                        for (let i = 0; i < size; i++) {
                            arr[i] = "";
                            for (let c = stream.get(); c !== 0; c = stream.get()) arr[i] += String.fromCharCode(c);
                        }
                        conn.dataRequestCallbacks[reqid](arr);
                    }
                    break;
                } case 8: {
                    let attr = {};
                    attr.size = stream.readUInt32();
                    attr.created = new Date(stream.readUInt64());
                    attr.modified = new Date(stream.readUInt64());
                    attr.isDir = stream.get() !== 0;
                    attr.isReadOnly = stream.get() !== 0;
                    const ok = stream.get();
                    if (ok === 0) conn.dataRequestCallbacks[reqid](attr);
                    else if (ok === 1) conn.dataRequestCallbacks[reqid](null);
                    else conn.dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                    break;
                } case 10: case 11: case 12: case 13:
                case 16: case 17: case 18: case 19:
                case 20: case 21: case 22: case 23: {
                    let str = "";
                    for (let c = stream.get(); c !== 0; c = stream.get()) str += String.fromCharCode(c);
                    if (str === "") conn.dataRequestCallbacks[reqid]();
                    else conn.dataRequestCallbacks[reqid](null, new Error(str));
                    break;
                }
            }
            delete conn.dataRequestCallbacks[reqid];
        } else if (type === 9) {
            const fail = stream.get();
            const reqid = stream.get();
            if (!conn.dataRequestCallbacks[reqid]) {
                log.appendLine("Got stray data response for request ID " + reqid + ", ignoring.");
                const size = stream.readUInt32();
                chunk = chunk.subarray(size + 16);
                while (String.fromCharCode(chunk[0]).match(/\s/)) chunk = chunk.subarray(1);
                continue;
            }
            const size = stream.readUInt32();
            const data = Buffer.alloc(size);
            // Use set instead of copy to satisfy type constraints
            data.set(stream.str.subarray(stream.pos, stream.pos + size), 0);
            if (fail) conn.dataRequestCallbacks[reqid](null, new Error(data.toString()));
            else conn.dataRequestCallbacks[reqid](data);
            delete conn.dataRequestCallbacks[reqid];
        }
        if (windows[windowKey] === undefined) { windows[windowKey] = {}; }
        if (windows[windowKey].term === undefined) windows[windowKey].term = {};
        for (let k in term) windows[windowKey].term[k] = term[k];
        if (windows[windowKey].isMonitor === undefined) {
            windows[windowKey].isMonitor = typeof windows[windowKey].term.title === "string" && windows[windowKey].term.title.indexOf("Monitor") !== -1;
            if (winid !== null && winid > 0) {
                windows[windowKey].computerID = winid - 1;
                windows[windowKey].isMonitor = false;
            } else {
                windows[windowKey].computerID = parseInt(connectionId);
            }
        }
        if (windows[windowKey].panel !== undefined) {
            windows[windowKey].panel.webview.postMessage(windows[windowKey].term);
            windows[windowKey].panel.title = windows[windowKey].term.title || "CraftOS-PC Terminal";
        }
        if (vslsServer !== null) {
            // Notify Live Share guests with a compact update
            notifyLiveShareState(true);
        }
        if (type === 4) {
            computer_provider._onDidChangeTreeData.fire(null);
            monitor_provider._onDidChangeTreeData.fire(null);
        }
        chunk = chunk.subarray(size + off + 8);
        while (String.fromCharCode(chunk[0]).match(/\s/)) chunk = chunk.subarray(1);
    }
}

function connectToProcess(extra_args) {
    const connectionId = nextConnectionId.toString();
    nextConnectionId++;

    const exe_path = getExecutable();
    if (exe_path === null) {
        return false;
    }
    const dir = vscode.workspace.getConfiguration("craftos-pc").get("dataPath");
    let process_options = {
        windowsHide: true
    };
    let args = vscode.workspace.getConfiguration("craftos-pc").get("additionalArguments");
    if (args !== null) { args = args.split(' '); args.push("--raw"); }
    else args = ["--raw"];
    if (dir !== null) args.splice(-1, 0, "-d", dir);
    if (extra_args !== null) args = args.concat(extra_args);
    log.appendLine("Running: " + exe_path + " " + args.join(" "));
    try {
        const process_connection = child_process.spawn(exe_path, args, process_options);

        // Initialize connection object
        connections[connectionId] = {
            connection: process_connection,
            data_continuation: null,
            nextDataRequestID: 0,
            dataRequestCallbacks: {},
            isVersion11: false,
            useBinaryChecksum: false,
            supportsFilesystem: false,
            gotMessage: false
        };

    } catch (e) {
        vscode.window.showErrorMessage("The CraftOS-PC worker process could not be launched. Check the path to the executable in the settings.");
        log.appendLine(e);
        return;
    }
    const conn = connections[connectionId];
    conn.process.on("error", () => {
        vscode.window.showErrorMessage("The CraftOS-PC worker process could not be launched. Check the path to the executable in the settings.");
        closeConnection(connectionId);
    });
    conn.process.on("exit", code => {
        vscode.window.showInformationMessage(`The CraftOS-PC worker process [${connectionId}] exited with code ${code}.`)
        closeConnection(connectionId);
    });
    conn.process.on("disconnect", () => {
        vscode.window.showErrorMessage(`The CraftOS-PC worker process [${connectionId}] was disconnected from the window.`)
        closeConnection(connectionId);
    });
    conn.process.on("close", () => {
        //vscode.window.showInformationMessage(`The CraftOS-PC worker process closed all IO streams with code ${code}.`)
        closeConnection(connectionId);
    });
    conn.process.stdout.on("data", (chunk) => processDataChunk(connectionId, chunk));
    conn.process.stderr.on("data", data => {
        log.appendLine(`[${connectionId}] ${data.toString()}`);
    });
    //conn.process.stdin.write("!CPC0008BgACAA==FBAC4FC2\n"); // 0x0002
    conn.process.stdin.write("!CPC0008BgADAA==498C93D2\n"); // 0x0003
    //process_connection.stdin.write("!CPC0008BgAGAA==0E2CE902\n"); // 0x0006
    //process_connection.stdin.write("!CPC0008BgAHAA==8C7C7ED3\n"); // 0x0007
    vscode.window.showInformationMessage(`A new CraftOS-PC worker process [${connectionId}] has been started.`);
    openPanel(connectionId, 0, true);
    return connectionId;
}

function connectToWebSocket(url) {
    const connectionId = nextConnectionId.toString();
    nextConnectionId++;

    if (url === undefined) return false;
    const socket = new WebSocket(url);
    // We insert a small shim here so we don't have to rewrite the other code.
    const process_connection = {
        connected: socket.readyState == WebSocket.OPEN,
        disconnect: () => socket.close(),
        kill: () => socket.close(),
        stdin: { write: data => { for (let i = 0; i < data.length; i += 65530) socket.send(data.substring(i, Math.min(i + 65530, data.length))) } }
    };

    // Initialize connection object
    connections[connectionId] = {
        connection: process_connection,
        data_continuation: null,
        nextDataRequestID: 0,
        dataRequestCallbacks: {},
        isVersion11: false,
        useBinaryChecksum: false,
        supportsFilesystem: false,
        gotMessage: false
    };

    socket.on("open", () => {
        //socket.send("!CPC0008BgACAA==FBAC4FC2\n"); // 0x0002
        //socket.send("!CPC0008BgADAA==498C93D2\n"); // 0x0003
        //socket.send("!CPC0008BgAGAA==0E2CE902\n"); // 0x0006
        socket.send("!CPC0008BgAHAA==8C7C7ED3\n"); // 0x0007
        vscode.window.showInformationMessage(`Successfully connected to the WebSocket server [${connectionId}].`);
        process_connection.connected = true;
        openPanel(connectionId, 0, true);
    });
    socket.on("error", e => {
        if (e.message.match("certificate has expired"))
            vscode.window.showErrorMessage("A bug in VS Code is causing the connection to fail. Please go to https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error to fix it.", "Open Page", "OK").then(res => {
                if (res === "OK") return;
                vscode.env.openExternal(vscode.Uri.parse("https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error"));
            });
        else vscode.window.showErrorMessage("An error occurred while connecting to the server: " + e.message);
        closeConnection(connectionId);
    });
    socket.on("close", () => {
        vscode.window.showInformationMessage("Disconnected from the WebSocket server.");
        closeConnection(connectionId);
    });
    socket.on("message", (data) => {
        let chunk;
        if (data instanceof Buffer) {
            chunk = data;
        } else if (data instanceof ArrayBuffer) {
            chunk = Buffer.from(data);
        } else {
            chunk = Buffer.from(data.toString());
        }
        processDataChunk(connectionId, chunk);
    });
}

function autoConnectFilesystem(connectionId) {
    const conn = connections[connectionId];
    if (!conn || !conn.supportsFilesystem) return;

    // Check if auto-connect is enabled in settings
    const autoConnect = vscode.workspace.getConfiguration("craftos-pc").get("autoConnectFilesystem", false);
    if (!autoConnect) return;

    // Find the primary window (ID 0) for this connection
    const windowKey = connectionId + ":0";
    log.appendLine(`Looking for window: ${windowKey}`);
    log.appendLine(`Window exists: ${windows[windowKey] !== undefined}`);

    if (!windows[windowKey]) {
        log.appendLine("Primary window not found, aborting auto-connect");
        return;
    }

    log.appendLine(`Auto-connecting filesystem for connection ${connectionId} using open-remote-data command`);

    // Use the existing open-remote-data command to handle workspace management
    vscode.commands.executeCommand("craftos-pc.open-remote-data", {
        id: connectionId + ":0",
        connectionId: connectionId
    });

    log.appendLine(`=== autoConnectFilesystem completed for connection ${connectionId} ===`);
}

function openPanel(connectionId, windowId, force) {
    const windowKey = connectionId + ":" + windowId;
    if (!force && (extcontext === null || windows[windowKey] === undefined)) return;
    if (windows[windowKey] !== undefined && windows[windowKey].panel !== undefined) {
        windows[windowKey].panel.reveal();
        return;
    }

    const conn = connections[connectionId];

    const customFont = vscode.workspace.getConfiguration("craftos-pc.customFont");
    let fontPath = customFont.get("path");
    if (fontPath === "hdfont") {
        const execPath = getSetting("craftos-pc.executablePath");
        if (os.platform() === "win32") fontPath = execPath.replace(/[\/\\][^\/\\]+$/, "/") + "hdfont.bmp";
        else if (os.platform() === "darwin" && execPath.indexOf("MacOS/craftos") !== -1) fontPath = execPath.replace(/MacOS\/[^\/]+$/, "") + "Resources/hdfont.bmp";
        else if (os.platform() === "darwin" || (os.platform() === "linux" && !fs.existsSync("/usr/share/craftos/hdfont.bmp"))) fontPath = "/usr/local/share/craftos/hdfont.bmp";
        else if (os.platform() === "linux") fontPath = "/usr/share/craftos/hdfont.bmp";
        if (!fs.existsSync(fontPath)) {
            vscode.window.showWarningMessage("The path to the HD font could not be found; the default font will be used instead. Please set the path to the HD font manually.");
            fontPath = null;
        }
    }
    const panel = vscode.window.createWebviewPanel(
        'craftos-pc',
        `CraftOS-PC Terminal [${connectionId}]`,
        vscode.window.activeTextEditor && vscode.window.activeTextEditor.viewColumn || vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: (fontPath !== null && fontPath !== "") ? [vscode.Uri.file(fontPath.replace(/[\/\\][^\/\\]*$/, ""))] : null
        }
    );
    extcontext.subscriptions.push(panel);
    // Get path to resource on disk
    const onDiskPath = vscode.Uri.file(path.join(extcontext.extensionPath, 'index.html'));
    panel.iconPath = windows[windowKey] && windows[windowKey].isMonitor ? vscode.Uri.file(path.join(extcontext.extensionPath, 'media/monitor.svg')) : vscode.Uri.file(path.join(extcontext.extensionPath, 'media/computer.svg'));
    panel.webview.html = fs.readFileSync(onDiskPath.fsPath, 'utf8');
    panel.webview.onDidReceiveMessage(message => {
        if (typeof message !== "object") return;
        // Handle font path request
        if (message.getFontPath === true) {
            if (fontPath !== null && fontPath !== "") panel.webview.postMessage({ fontPath: panel.webview.asWebviewUri(vscode.Uri.file(fontPath)).toString() });
            return;
        }
        // Build packet from webview message
        const data = Buffer.alloc(message.data.length / 2 + 2);
        data[0] = message.type;
        data[1] = windowId;
        // Use set() to avoid TS lib typing issues with Buffer#copy
        data.set(Buffer.from(message.data, 'hex'), 2);
        const b64 = data.toString('base64');

        // Prefer local connection if available
        if (conn && conn.connection && conn.connection.stdin) {
            const packet = "!CPC" + ("000" + b64.length.toString(16)).slice(-4) + b64 + ("0000000" + crc32(conn.useBinaryChecksum ? data.toString("binary") : b64).toString(16)).slice(-8) + "\n";
            conn.connection.stdin.write(packet, 'utf8');
            return;
        }

        // Fallback to Live Share guest path (route to host)
        if (liveshare && vslsClient && liveshare.session && liveshare.session.role === vsls.Role.Guest) {
            const flags = remoteFlags[connectionId] || { useBinaryChecksum: false };
            const packet = "!CPC" + ("000" + b64.length.toString(16)).slice(-4) + b64 + ("0000000" + crc32(flags.useBinaryChecksum ? data.toString("binary") : b64).toString(16)).slice(-8) + "\n";
            vslsClient.notify("packet", { connectionId: connectionId, data: packet, peer: liveshare.session.peerNumber });
        }
    });
    panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active && windows[windowKey].term !== undefined) {
            e.webviewPanel.webview.postMessage(windows[windowKey].term);
            e.webviewPanel.title = windows[windowKey].term.title || "CraftOS-PC Terminal";
        }
    });
    panel.onDidDispose(() => { if (windows[windowKey].panel !== undefined) delete windows[windowKey].panel; });
    let newWindow = false;
    if (windows[windowKey] === undefined) { windows[windowKey] = {}; newWindow = true; }
    windows[windowKey].panel = panel;
    if (windows[windowKey].term !== undefined) {
        windows[windowKey].panel.webview.postMessage(windows[windowKey].term);
        windows[windowKey].panel.title = windows[windowKey].term.title || "CraftOS-PC Terminal";
    }
    if (newWindow && vslsServer !== null) {
        // Send consolidated state including flags for all connections
        notifyLiveShareState(true);
    }
}

// Helper function to get available connections for user selection
function getConnectionChoices() {
    const choices = [];
    for (let connectionId in connections) {
        choices.push({
            label: `Connection ${connectionId}`,
            description: `${Object.keys(windows).filter(k => k.startsWith(connectionId + ":")).length} windows`,
            connectionId: connectionId
        });
    }
    return choices;
}

// Helper function to get the first available connection ID
function getDefaultConnectionId() {
    const connIds = Object.keys(connections);
    return connIds.length > 0 ? connIds[0] : null;
}

// Helper function to show connection picker
async function pickConnection(prompt = "Select a connection:") {
    const choices = getConnectionChoices();
    if (choices.length === 0) {
        vscode.window.showErrorMessage("No connections available.");
        return null;
    }
    if (choices.length === 1) {
        return choices[0].connectionId;
    }
    const selected = await vscode.window.showQuickPick(choices, { placeHolder: prompt });
    return selected ? selected.connectionId : null;
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {

    log.appendLine("The CraftOS-PC extension is now active.");

    extcontext = context;

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open', () => {
        return connectToProcess();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-websocket', obj => {
        if (typeof obj === "string") return connectToWebSocket(obj);
        let wsHistory = context.globalState.get("JackMacWindows.craftos-pc/websocket-history", [""]);
        let quickPick = vscode.window.createQuickPick();
        quickPick.items = wsHistory.map(val => { return { label: val } });
        quickPick.title = "Enter the WebSocket URL:";
        quickPick.placeholder = "wss://";
        quickPick.canSelectMany = false;
        quickPick.onDidChangeValue(() => {
            wsHistory[0] = quickPick.value;
            quickPick.items = wsHistory.map(val => { return { label: val } });
        });
        quickPick.onDidAccept(() => {
            let str = quickPick.selectedItems[0].label;
            if (!validateURL(str)) vscode.window.showErrorMessage("The URL you entered is not valid.");
            else {
                wsHistory[0] = str;
                if (wsHistory.slice(1).includes(str))
                    wsHistory.splice(wsHistory.slice(1).indexOf(str) + 1, 1);
                wsHistory.unshift("");
                context.globalState.update("JackMacWindows.craftos-pc/websocket-history", wsHistory);
                connectToWebSocket(str);
            }
        });
        quickPick.show();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.clear-history', () => {
        context.globalState.update("JackMacWindows.craftos-pc/websocket-history", [""]);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.debug-connections', () => {
        let debugInfo = [];

        debugInfo.push("=== CraftOS-PC Connection Debug Info ===");
        debugInfo.push(`Total connections: ${Object.keys(connections).length}`);
        debugInfo.push(`Total windows: ${Object.keys(windows).length}`);
        debugInfo.push("");

        if (Object.keys(connections).length === 0 && !isLiveShareGuest) {
            debugInfo.push("No active connections.");
        } else {
            if (isLiveShareGuest && Object.keys(connections).length === 0) {
                debugInfo.push("Guest mode: showing remote connection summaries");
                for (let connectionId in remoteConnections) {
                    const rc = remoteConnections[connectionId];
                    debugInfo.push(`Remote Connection ${connectionId}:`);
                    debugInfo.push(`  Type: ${rc.type}`);
                    debugInfo.push(`  Connected: ${rc.connected}`);
                    debugInfo.push(`  Version 1.1: ${rc.isVersion11}`);
                    debugInfo.push(`  Binary Checksum: ${rc.useBinaryChecksum}`);
                    debugInfo.push(`  Filesystem Support: ${rc.supportsFilesystem}`);
                }
                debugInfo.push("");
            }
            for (let connectionId in connections) {
                const conn = connections[connectionId];
                debugInfo.push(`Connection ${connectionId}:`);
                debugInfo.push(`  Type: ${conn.connection.connected !== undefined ? 'WebSocket' : 'Process'}`);
                debugInfo.push(`  Connected: ${conn.connection.connected !== undefined ? conn.connection.connected : 'N/A (Process)'}`);
                debugInfo.push(`  Version 1.1: ${conn.isVersion11}`);
                debugInfo.push(`  Binary Checksum: ${conn.useBinaryChecksum}`);
                debugInfo.push(`  Filesystem Support: ${conn.supportsFilesystem}`);
                debugInfo.push(`  Got Message: ${conn.gotMessage}`);
                debugInfo.push(`  Next Data Request ID: ${conn.nextDataRequestID}`);
                debugInfo.push(`  Pending Data Requests: ${Object.keys(conn.dataRequestCallbacks).length}`);

                // List windows for this connection
                const connectionWindows = Object.keys(windows).filter(key => key.startsWith(connectionId + ":"));
                debugInfo.push(`  Windows (${connectionWindows.length}):`);

                if (connectionWindows.length === 0) {
                    debugInfo.push("    No windows");
                } else {
                    for (let windowKey of connectionWindows) {
                        const window = windows[windowKey];
                        const windowId = windowKey.split(':')[1];
                        debugInfo.push(`    Window ${windowId}:`);
                        debugInfo.push(`      Title: ${window.term && window.term.title ? window.term.title : 'No title'}`);
                        debugInfo.push(`      Is Monitor: ${window.isMonitor}`);
                        debugInfo.push(`      Computer ID: ${window.computerID !== undefined ? window.computerID : 'Unknown'}`);
                        debugInfo.push(`      Has Panel: ${window.panel !== undefined}`);
                        debugInfo.push(`      Has Term Data: ${window.term !== undefined}`);
                        if (window.term) {
                            debugInfo.push(`      Term Mode: ${window.term.mode !== undefined ? window.term.mode : 'Unknown'}`);
                            debugInfo.push(`      Screen Size: ${window.term.width}x${window.term.height}`);
                            debugInfo.push(`      Cursor: (${window.term.cursorX}, ${window.term.cursorY})`);
                        }
                    }
                }
                debugInfo.push("");
            }
        }

        debugInfo.push("=== Feature Flags ===");
        debugInfo.push(`Process Features - Debugger: ${processFeatures.debugger}`);
        debugInfo.push(`Process Features - Filesystem: ${processFeatures.filesystem}`);
        debugInfo.push("");

        debugInfo.push("=== Settings ===");
        debugInfo.push(`Executable Path: ${getSetting("craftos-pc.executablePath") || 'Not set'}`);
        debugInfo.push(`Data Path: ${getDataPath() || 'Not set'}`);
        debugInfo.push(`Auto Connect Filesystem: ${vscode.workspace.getConfiguration("craftos-pc").get("autoConnectFilesystem", false)}`);
        debugInfo.push("");

        const output = debugInfo.join('\n');

        // Log to output channel
        log.appendLine("=== DEBUG INFO REQUESTED ===");
        log.appendLine(output);
        log.show();

        // Also copy to clipboard for easy sharing
        vscode.env.clipboard.writeText(output);
        vscode.window.showInformationMessage("Debug info logged to output channel and copied to clipboard.");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-new-remote', () => {
        if (!didShowBetaMessage) {
            vscode.window.showWarningMessage("remote.craftos-pc.cc is currently in beta. Be aware that things may not work as expected. If you run into issues, please report them [on GitHub](https://github.com/MCJack123/remote.craftos-pc.cc/issues). If things break, use Shift+Ctrl+P (Shift+Cmd+P on Mac), then type 'reload window' and press Enter.");
            didShowBetaMessage = true;
        }
        https.get("https://remote.craftos-pc.cc/new", res => {
            if (Math.floor(res.statusCode / 100) !== 2) {
                vscode.window.showErrorMessage("Could not connect to remote.craftos-pc.cc: HTTP " + res.statusCode);
                res.resume();
                return;
            }
            res.setEncoding('utf8');
            let id = "";
            res.on('data', chunk => id += chunk);
            res.on('end', () => {
                vscode.env.clipboard.writeText("wget run https://remote.craftos-pc.cc/server.lua " + id);
                vscode.window.showInformationMessage("A command has been copied to the clipboard. Paste that into the ComputerCraft computer to establish the connection.");
                connectToWebSocket("wss://remote.craftos-pc.cc/" + id);
            });
        }).on('error', e => {
            if (e.message.match("certificate has expired"))
                vscode.window.showErrorMessage("A bug in VS Code is causing the connection to fail. Please go to https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error to fix it.", "Open Page", "OK").then(res => {
                    if (res === "OK") return;
                    vscode.env.openExternal(vscode.Uri.parse("https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error"));
                });
            else vscode.window.showErrorMessage("Could not connect to remote.craftos-pc.cc: " + e.message);
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.add-connection', async () => {
        const options = [
            {
                label: "$(server-process) Start Local CraftOS-PC Session",
                description: "Start a new local CraftOS-PC process",
                action: "local"
            },
            {
                label: "$(globe) Connect to WebSocket...",
                description: "Connect to a remote CraftOS-PC WebSocket server",
                action: "websocket"
            },
            {
                label: "$(cloud) Connect to remote.craftos-pc.cc (Beta)",
                description: "Create a new remote.craftos-pc.cc session",
                action: "remote"
            }
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: "Choose connection type",
            title: "Add New CraftOS-PC Connection"
        });

        if (!selected) return;

        switch (selected.action) {
            case "local":
                vscode.commands.executeCommand("craftos-pc.open");
                break;
            case "websocket":
                vscode.commands.executeCommand("craftos-pc.open-websocket");
                break;
            case "remote":
                vscode.commands.executeCommand("craftos-pc.open-new-remote");
                break;
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-window', async obj => {
        // Allow guests to open host windows even without local connections
        if (Object.keys(connections).length === 0 && !isLiveShareGuest) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }
        if (typeof obj === "object" && obj.connectionId) {
            const parts = obj.id.split(':');
            const connectionId = parts[0];
            const windowId = parseInt(parts[1]);
            openPanel(connectionId, windowId);
        } else {
            let connectionId;
            if (isLiveShareGuest && Object.keys(connections).length === 0) {
                // Build choices from windows map for guests
                const ids = Array.from(new Set(Object.keys(windows).map(k => k.split(':')[0])));
                if (ids.length === 0) {
                    vscode.window.showErrorMessage("No host windows available to open.");
                    return;
                }
                const choices = ids.map(id => ({ label: `Connection ${id}`, description: `${Object.keys(windows).filter(k => k.startsWith(id + ':')).length} windows`, connectionId: id }));
                const selected = await vscode.window.showQuickPick(choices, { placeHolder: "Select connection to open window:" });
                if (!selected) return;
                connectionId = selected.connectionId;
            } else {
                connectionId = await pickConnection("Select connection to open window:");
                if (!connectionId) return;
            }

            vscode.window.showInputBox({ prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null }).then(windowId => {
                if (windowId) openPanel(connectionId, parseInt(windowId));
            });
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-config', () => {
        if (getDataPath() === null) {
            vscode.window.showErrorMessage("Please set the path to the CraftOS-PC data directory manually.");
            return;
        }
        vscode.commands.executeCommand("vscode.open", vscode.Uri.file(getDataPath() + "/config/global.json"));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-computer-data', async obj => {
        if (getDataPath() === null) {
            vscode.window.showErrorMessage("Please set the path to the CraftOS-PC data directory manually.");
            return;
        }
        if (typeof obj === "object" && obj.connectionId) {
            const parts = obj.id.split(':');
            const connectionId = parts[0];
            const windowId = parseInt(parts[1]);
            const windowKey = connectionId + ":" + windowId;
            if (windows[windowKey] && windows[windowKey].computerID !== undefined) {
                vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(getDataPath() + "/computer/" + windows[windowKey].computerID), { forceNewWindow: true });
            } else {
                vscode.window.showErrorMessage("Computer ID not available for this window.");
            }
        } else {
            const computerIdStr = await vscode.window.showInputBox({ prompt: "Enter the computer ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null });
            if (computerIdStr) {
                if (!fs.existsSync(getDataPath() + "/computer/" + computerIdStr)) {
                    vscode.window.showErrorMessage("The computer ID provided does not exist.");
                } else {
                    vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(getDataPath() + "/computer/" + computerIdStr));
                }
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-remote-data', async obj => {
        log.appendLine("=== open-remote-data command started ===");
        log.appendLine(`Input object: ${JSON.stringify(obj)}`);
        log.appendLine(`Current connections: ${Object.keys(connections).length}`);
        log.appendLine(`Current windows: ${Object.keys(windows).length}`);

        if (Object.keys(connections).length === 0) {
            log.appendLine("ERROR: No connections available");
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }

        let connectionId, windowId;
        if (typeof obj === "object" && obj.connectionId) {
            log.appendLine("Using object parameters");
            const parts = obj.id.split(':');
            connectionId = parts[0];
            windowId = parseInt(parts[1]);
            log.appendLine(`Parsed connectionId: ${connectionId}, windowId: ${windowId}`);
        } else {
            log.appendLine("Prompting user for connection selection");
            connectionId = await pickConnection("Select connection:");
            if (!connectionId) {
                log.appendLine("User cancelled connection selection");
                return;
            }
            log.appendLine(`Selected connectionId: ${connectionId}`);

            const conn = connections[connectionId];
            log.appendLine(`Connection exists: ${conn !== undefined}`);
            log.appendLine(`Connection supports filesystem: ${conn ? conn.supportsFilesystem : 'N/A'}`);

            if (!conn.supportsFilesystem) {
                log.appendLine("ERROR: Connection does not support filesystem");
                vscode.window.showErrorMessage("This connection does not support file system access.");
                return;
            }

            const windowIdStr = await vscode.window.showInputBox({ prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null });
            if (!windowIdStr) {
                log.appendLine("User cancelled window ID input");
                return;
            }
            windowId = parseInt(windowIdStr);
            log.appendLine(`Selected windowId: ${windowId}`);

            const windowKey = connectionId + ":" + windowId;
            log.appendLine(`Checking window key: ${windowKey}`);
            log.appendLine(`Window exists: ${typeof windows[windowKey] === "object"}`);

            if (typeof windows[windowKey] !== "object") {
                log.appendLine("ERROR: Window does not exist");
                vscode.window.showErrorMessage("The window ID provided does not exist.");
                return;
            }
        }

        const windowKey = connectionId + ":" + windowId;
        log.appendLine(`Final windowKey: ${windowKey}`);
        log.appendLine(`Window object exists: ${windows[windowKey] !== undefined}`);

        if (windows[windowKey]) {
            log.appendLine(`Window has term: ${windows[windowKey].term !== undefined}`);
            if (windows[windowKey].term) {
                log.appendLine(`Window title: ${windows[windowKey].term.title || 'No title'}`);
            }
        }

        log.appendLine(`Current workspace file: ${vscode.workspace.workspaceFile || 'None'}`);
        log.appendLine(`Current workspace folders: ${vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0}`);

        if (!vscode.workspace.workspaceFile) {
            const opt = await vscode.window.showWarningMessage("Due to technical limitations, opening the computer data will cause all connections to close. Please restart the connections after running this. Are you sure you want to continue?", "No", "Yes");
            if (opt === "No") return;
            deactivate();
            log.appendLine("Creating new workspace");
            const title = windows[windowKey] && windows[windowKey].term && windows[windowKey].term.title ? windows[windowKey].term.title.replace(/^.*: */, "") : `Computer ${connectionId}`;
            log.appendLine(`Workspace title: ${title}`);
            const uri = `craftos-pc://${connectionId}-${windowId}/`;
            log.appendLine(`Workspace URI: ${uri}`);

            try {
                // vscode.commands.executeCommand('vscode.addFoldersToWorkspace', [vscode.Uri.parse(uri)])
                vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, null, { name: title, uri: vscode.Uri.parse(uri) });
                log.appendLine("Workspace created successfully");
                vscode.window.showInformationMessage(`Filesystem workspace has been created for connection ${connectionId}.`);
            } catch (error) {
                log.appendLine(`ERROR creating workspace: ${error.message}`);
                vscode.window.showErrorMessage(`Failed to create workspace: ${error.message}`);
            }
            return;
        }

        log.appendLine("Adding to existing workspace");
        const title = windows[windowKey] && windows[windowKey].term && windows[windowKey].term.title ? windows[windowKey].term.title.replace(/^.*: */, "") : `Computer ${connectionId}`;
        log.appendLine(`Folder title: ${title}`);
        const uri = `craftos-pc://${connectionId}-${windowId}/`;
        log.appendLine(`Folder URI: ${uri}`);

        try {
            vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, null, { name: title, uri: vscode.Uri.parse(uri) });
            log.appendLine("Folder added to workspace successfully");
            vscode.window.showInformationMessage(`Filesystem access has been added to the workspace for connection ${connectionId}.`);
        } catch (error) {
            log.appendLine(`ERROR adding folder to workspace: ${error.message}`);
            console.log(`ERROR adding folder to workspace: ${error.message}`);
            vscode.window.showErrorMessage(`Failed to add folder to workspace: ${error.message}`);
        }

        log.appendLine("=== open-remote-data command completed ===");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-primary-remote-data', async () => {
        const connectionId = getDefaultConnectionId();
        if (!connectionId) {
            vscode.window.showErrorMessage("No connections available.");
            return;
        }
        vscode.commands.executeCommand("craftos-pc.open-remote-data", { title: "", id: connectionId + ":0", connectionId: connectionId });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.close', async () => {
        if (Object.keys(connections).length === 0) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }

        const connectionId = await pickConnection("Select connection to close:");
        if (!connectionId) return;

        const conn = connections[connectionId];
        conn.connection.stdin.write(conn.useBinaryChecksum ? "!CPC000CBAACAAAAAAAA2C7A548B\n" : "!CPC000CBAACAAAAAAAA3AB9B910\n", "utf8");
        closeConnection(connectionId);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("craftos-pc.close-window", async obj => {
        if (Object.keys(connections).length === 0) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }

        let connectionId, windowId;
        if (typeof obj === "object" && obj.connectionId) {
            const parts = obj.id.split(':');
            connectionId = parts[0];
            windowId = parseInt(parts[1]);
        } else {
            connectionId = await pickConnection("Select connection:");
            if (!connectionId) return;

            const windowIdStr = await vscode.window.showInputBox({ prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null });
            if (!windowIdStr) return;
            windowId = parseInt(windowIdStr);
        }

        const conn = connections[connectionId];
        const data = Buffer.alloc(9);
        data.fill(0);
        data[0] = 4;
        data[1] = windowId;
        data[2] = 1;
        const b64 = data.toString("base64");
        conn.connection.stdin.write("!CPC000C" + b64 + ("0000000" + crc32(conn.useBinaryChecksum ? data.toString("binary") : b64).toString(16)).slice(-8) + "\n\n", "utf8");
    }));

    context.subscriptions.push(vscode.commands.registerCommand("craftos-pc.kill", async () => {
        if (Object.keys(connections).length === 0) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }

        const connectionId = await pickConnection("Select connection to kill:");
        if (!connectionId) return;

        const conn = connections[connectionId];
        conn.connection.stdin.write(conn.useBinaryChecksum ? "!CPC000CBAACAAAAAAAA2C7A548B\n" : "!CPC000CBAACAAAAAAAA3AB9B910\n", "utf8");
        conn.connection.kill(SIGINT);
        closeConnection(connectionId);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("craftos-pc.run-file", path => {
        if (Object.keys(connections).length > 0) {
            vscode.window.showErrorMessage("Please close all CraftOS-PC connections before using this command.");
            return;
        }

        if (!path) {
            if (vscode.window.activeTextEditor === undefined || vscode.window.activeTextEditor.document.uri.scheme !== "file") {
                vscode.window.showErrorMessage("Please open or save a file on disk before using this command.");
                return;
            }
            path = vscode.window.activeTextEditor.document.uri.fsPath;
        } else if (typeof path === "object" && path instanceof vscode.Uri) {
            if (path.scheme !== "file") {
                vscode.window.showErrorMessage("Please open or save a file on disk before using this command.");
                return;
            }
            path = path.fsPath;
        }
        return connectToProcess(["--script", path]);
    }));

    context.subscriptions.push(vscode.workspace.registerFileSystemProvider("craftos-pc", new RawFileSystemProvider()));
    context.subscriptions.push(vscode.window.registerUriHandler({
        handleUri: uri => {
            vscode.commands.executeCommand("craftos-pc.open-websocket", uri.path.replace(/^\//, ""));
        }
    }));

    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("craftos-pc", debugAdapterFactory));

    log = vscode.window.createOutputChannel("CraftOS-PC");

    let change_timer = null;
    vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("craftos-pc.executablePath")) {
            // Use a timer to debounce quick autosaves
            if (change_timer !== null) clearTimeout(change_timer);
            change_timer = setTimeout(() => { change_timer = null; checkVersion(false); }, 3000);
        }
    });

    vscode.window.createTreeView("craftos-computers", { "treeDataProvider": computer_provider });
    vscode.window.createTreeView("craftos-monitors", { "treeDataProvider": monitor_provider });

    // multi-connection live share
    vsls.getApi(context.extension.id).then(api => {
        if (api === null) return;
        liveshare = api;

        const updateSession = () => {
            if (liveshare.session.role === vsls.Role.Host) {
                isLiveShareGuest = false;
                if (vslsServer === null) {
                    liveshare.shareService("terminal").then(svc => {
                        vslsServer = svc;

                        // Route guest keystroke packets to the correct local connection
                        vslsServer.onNotify("packet", data => {
                            const d = /** @type {any} */ (data);
                            // TODO: Add actual access control (MicrosoftDocs/live-share#1716)
                            const peer = liveshare.peers.find(a => a.peerNumber == d.peer);
                            if (!peer || (peer.access !== vsls.Access.ReadWrite && peer.access !== vsls.Access.Owner)) return;
                            const targetId = d.connectionId;
                            const conn = connections[targetId];
                            if (conn && conn.connection && conn.connection.stdin) conn.connection.stdin.write(d.data, "utf8");
                        });

                        // Provide consolidated state on request
                        const sendState = () => notifyLiveShareState(true);
                        vslsServer.onNotify("get-state", sendState);
                    }).catch(err => vscode.window.showErrorMessage("Could not create Live Share service: " + err));
                }
            } else if (liveshare.session.role === vsls.Role.Guest) {
                vslsServer = null;
                if (vslsClient === null) {
                    liveshare.getSharedService("terminal").then(svc => {
                        vslsClient = svc;
                        isLiveShareGuest = true;
                        remoteFlags = {};
                        remoteConnections = {};

                        const rebuildWindows = (param) => {
                            let newwindows = {};
                            for (let id in param) newwindows[id] = { term: param[id].term, isMonitor: param[id].isMonitor, panel: windows[id] ? windows[id].panel : undefined };
                            // Dispose panels for windows that no longer exist
                            for (let id in windows) if (!newwindows[id] && windows[id].panel) windows[id].panel.dispose();
                            windows = newwindows;
                            // Refresh any open panels with the latest terminal state from host
                            for (let id in windows) {
                                if (windows[id].panel && windows[id].term) {
                                    windows[id].panel.webview.postMessage(windows[id].term);
                                    windows[id].panel.title = windows[id].term.title || "CraftOS-PC Terminal";
                                }
                            }
                            computer_provider._onDidChangeTreeData.fire(null);
                            monitor_provider._onDidChangeTreeData.fire(null);
                        };

                        // Consolidated state message; supports full windows or compact per-window updates
                        vslsClient.onNotify("state", payload => {
                            const p = /** @type {any} */ (payload);
                            if (!p) return;
                            if (p.windows) rebuildWindows(p.windows);
                            else if (p.update && p.update.id && windows[p.update.id]) {
                                // Apply compact term update to existing window
                                windows[p.update.id].term = p.update.term;
                                if (windows[p.update.id].panel && windows[p.update.id].term) {
                                    windows[p.update.id].panel.webview.postMessage(windows[p.update.id].term);
                                    windows[p.update.id].panel.title = windows[p.update.id].term.title || "CraftOS-PC Terminal";
                                }
                            }
                            if (p.flags) remoteFlags = p.flags;
                            if (p.connections) remoteConnections = p.connections;
                        });

                        // Request initial state
                        vslsClient.notify("get-state", {});
                    }).catch(err => vscode.window.showErrorMessage("Could not connect to Live Share service: " + err));
                }
            } else if (liveshare.session.role === vsls.Role.None) {
                // Tear down guest state if we were a guest
                if (vslsClient !== null) {
                    if (isLiveShareGuest) {
                        for (let id in windows) if (windows[id].panel) windows[id].panel.dispose();
                        windows = {};
                        computer_provider._onDidChangeTreeData.fire(null);
                        monitor_provider._onDidChangeTreeData.fire(null);
                        isLiveShareGuest = false;
                        remoteFlags = {};
                        remoteConnections = {};
                    }
                    vslsClient = null;
                }
                vslsServer = null;
            }
        };

        liveshare.onDidChangeSession(updateSession);
        liveshare.onDidChangePeers(() => { notifyLiveShareState(true); });
        if (liveshare.session.role !== vsls.Role.None) updateSession();
    });

    checkVersion(true);
}
// this method is called when your extension is deactivated
function deactivate() {
    for (let connectionId in connections) {
        closeConnection(connectionId);
    }
    closeAllWindows();
}

module.exports = {
    activate,
    deactivate
}
