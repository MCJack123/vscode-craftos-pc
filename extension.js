const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const process = require('process');
const https = require('https');
const URL = require('url').URL;
const WebSocket = require('ws');
const child_process = require('child_process');
const { SIGINT } = require('constants');

var windows = {};
var crcTable = null;
var extcontext = null;

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
    retval.readUInt64 = function() {
        let r = Number(this.str.readBigUInt64LE(this.pos));
        this.pos += 8;
        return r;
    }
    retval.readUInt32 = function() {
        let r = this.str.readUInt32LE(this.pos);
        this.pos += 4;
        return r;
    }
    retval.readUInt16 = function() {
        let r = this.str.readUInt16LE(this.pos);
        this.pos += 2;
        return r;
    }
    retval.get = function() {
        return this.str.readUInt8(this.pos++);
    };
    retval.putback = function() {this.pos--;}
    return retval;
}

function validateURL(str) {
    try {
        let url = new URL(str);
        return url.protocol.toLowerCase() == "ws:" || url.protocol.toLowerCase() == "wss:";
    } catch (e) {return false;}
}

const computer_provider = {
    getChildren: element => {
        if ((element === undefined || element === null) && process_connection !== null) {
            let arr = [];
            for (let w in windows) if (!windows[w].isMonitor) arr.push({title: windows[w].term.title, id: w});
            return arr;
        } else return null;
    },
    getTreeItem: element => {
        let r = new vscode.TreeItem(element.title);
        r.iconPath = vscode.Uri.file(path.join(extcontext.extensionPath, 'media/computer.svg'));
        r.command = {command: "craftos-pc.open-window", title: "CraftOS-PC: Open Window", arguments: [element]};
        if (supportsFilesystem) r.contextValue = "data-available";
        return r;
    },
    _onDidChangeTreeData: new vscode.EventEmitter(),
};
computer_provider.onDidChangeTreeData = computer_provider._onDidChangeTreeData.event;

const monitor_provider = {
    getChildren: element => {
        if ((element === undefined || element === null) && process_connection !== null) {
            let arr = [];
            for (let w in windows) if (windows[w].isMonitor) arr.push({title: windows[w].term.title, id: w});
            return arr;
        }
        else return null;
    },
    getTreeItem: element => {
        let r = new vscode.TreeItem(element.title);
        r.iconPath = vscode.Uri.file(path.join(extcontext.extensionPath, 'media/monitor.svg'));
        r.command = {command: "craftos-pc.open-window", title: "CraftOS-PC: Open Window", arguments: [element]};
        return r;
    },
    _onDidChangeTreeData: new vscode.EventEmitter(),
}
monitor_provider.onDidChangeTreeData = monitor_provider._onDidChangeTreeData.event;

var process_connection = null;
var data_continuation = null;
var nextDataRequestID = 0;
var dataRequestCallbacks = {};
var isVersion11 = false;
var useBinaryChecksum = false;
var supportsFilesystem = false;
var gotMessage = false;
var didShowBetaMessage = false;

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

function closeAllWindows() {
    for (let k in windows) if (windows[k].panel !== undefined) windows[k].panel.dispose();
    windows = {};
    computer_provider._onDidChangeTreeData.fire(null);
    monitor_provider._onDidChangeTreeData.fire(null);
}

function queueDataRequest(id, type, path, path2) {
    if (process_connection === null) return new Promise((resolve, reject) => reject(new Error("Path does not exist")));
    const pathbuf = Buffer.from(path, "latin1");
    const path2buf = (typeof path2 === "string" ? Buffer.from(path2, "latin1") : null);
    const data = Buffer.alloc(5 + pathbuf.length + (typeof path2 === "string" ? path2buf.length + 1 : 0));
    data[0] = 7;
    data[1] = id;
    data[2] = type;
    data[3] = nextDataRequestID;
    nextDataRequestID = (nextDataRequestID + 1) & 0xFF;
    pathbuf.copy(data, 4);
    if (typeof path2 == "string") path2buf.copy(data, 5 + pathbuf.length);
    const b64 = data.toString('base64');
    const packet = "!CPC" + ("000" + b64.length.toString(16)).slice(-4) + b64 + ("0000000" + crc32(useBinaryChecksum ? data.toString("binary") : b64).toString(16)).slice(-8) + "\n";
    process_connection.stdin.write(packet, 'utf8');
    if ((type & 0xF1) == 0x11) {
        const data2 = Buffer.alloc(8 + path2.length);
        data2[0] = 9;
        data2[1] = id;
        data2[2] = 0;
        data2[3] = data[3];
        data2.writeInt32LE(path2.length, 4);
        path2.copy(data2, 8);
        const b642 = data2.toString('base64');
        const packet2 = (data2.length > 65535 ? "!CPD" + ("00000000000" + b642.length.toString(16)).slice(-12) : "!CPC" + ("000" + b642.length.toString(16)).slice(-4)) + b642 + ("0000000" + crc32(useBinaryChecksum ? data2.toString("binary") : b642).toString(16)).slice(-8) + "\n";
        process_connection.stdin.write(packet2, 'utf8');
    }
    return new Promise((resolve, reject) => {
        let tid = setTimeout(() => {
            delete dataRequestCallbacks[data[3]];
            console.log("Could not get info for " + path + " (request " + data[3] + ")");
            reject(new Error("Timeout"));
        }, 3000);
        dataRequestCallbacks[data[3]] = (data, err) => {
            clearTimeout(tid);
            if (!err) resolve(data);
            else reject(err);
        }
    });
}

/**
 * @implements {vscode.FileSystemProvider}
 */
class RawFileSystemProvider {
    constructor() {
        this._onDidChangeFile = new vscode.EventEmitter()
        this.onDidChangeFile = this._onDidChangeFile.event
    }
    /**
     * @param {vscode.Uri} source
     * @param {vscode.Uri} destination
     * @param {{overwrite: boolean}} options
     */
    copy(source, destination, options) {
        if (process_connection === null) throw vscode.FileSystemError.Unavailable("Computer connection not open yet");
        if (!supportsFilesystem) throw vscode.FileSystemError.Unavailable("Connected computer doesn't support filesystems");
        if (source.authority !== destination.authority) throw vscode.FileSystemError.Unavailable("Cannot move across computers");
        return queueDataRequest(parseInt(source.authority), 12, source.path, destination.path);
    }
    /**
     * @param {vscode.Uri} uri 
     */
    createDirectory(uri) {
        if (process_connection === null) throw vscode.FileSystemError.Unavailable("Computer connection not open yet");
        if (!supportsFilesystem) throw vscode.FileSystemError.Unavailable("Connected computer doesn't support filesystems");
        return queueDataRequest(parseInt(uri.authority), 10, uri.path);
    }
    /**
     * @param {vscode.Uri} uri 
     * @param {{recursive: boolean}} options
     */
    delete(uri, options) {
        // Warning: ignores options.recursive (always true)
        if (process_connection === null) throw vscode.FileSystemError.Unavailable("Computer connection not open yet");
        if (!supportsFilesystem) throw vscode.FileSystemError.Unavailable("Connected computer doesn't support filesystems");
        return queueDataRequest(parseInt(uri.authority), 11, uri.path);
    }
    /**
     * @param {vscode.Uri} uri 
     */
    readDirectory(uri) {
        if (process_connection === null) throw vscode.FileSystemError.Unavailable("Computer connection not open yet");
        if (!supportsFilesystem) throw vscode.FileSystemError.Unavailable("Connected computer doesn't support filesystems");
        return new Promise(resolve => {
            queueDataRequest(parseInt(uri.authority), 7, uri.path).then(files => {
                let arr = [];
                let promises = [];
                for (let f of files) {
                    promises.push(new Promise(resolve => queueDataRequest(parseInt(uri.authority), 1, path.join(uri.path, f)).then(isDir => {
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
        if (process_connection === null) throw vscode.FileSystemError.Unavailable("Computer connection not open yet");
        if (!supportsFilesystem) throw vscode.FileSystemError.Unavailable("Connected computer doesn't support filesystems");
        return queueDataRequest(parseInt(uri.authority), 20, uri.path).then(data => Uint8Array.from(data));
    }
    /**
     * @param {vscode.Uri} oldUri 
     * @param {vscode.Uri} newUri 
     * @param {{overwrite: boolean}} options 
     */
    rename(oldUri, newUri, options) {
        // Warning: ignores overwrite (always false)
        if (process_connection === null) throw vscode.FileSystemError.Unavailable("Computer connection not open yet");
        if (!supportsFilesystem) throw vscode.FileSystemError.Unavailable("Connected computer doesn't support filesystems");
        if (oldUri.authority !== newUri.authority) throw vscode.FileSystemError.Unavailable("Cannot move across computers");
        return queueDataRequest(parseInt(oldUri.authority), 13, oldUri.path, newUri.path);
    }
    /**
     * @param {vscode.Uri} uri 
     */
    stat(uri) {
        if (process_connection === null) throw vscode.FileSystemError.Unavailable("Computer connection not open yet");
        if (!supportsFilesystem) throw vscode.FileSystemError.Unavailable("Connected computer doesn't support filesystems");
        return queueDataRequest(parseInt(uri.authority), 8, uri.path).then(attributes => {
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
        // unimplemented
        if (process_connection === null) throw vscode.FileSystemError.Unavailable("Computer connection not open yet");
        if (!supportsFilesystem) throw vscode.FileSystemError.Unavailable("Connected computer doesn't support filesystems");
        return null;
    }
    /**
     * @param {vscode.Uri} uri 
     * @param {Uint8Array} content
     * @param {{create: boolean, overwrite: boolean}} options
     */
    writeFile(uri, content, options) {
        if (process_connection === null) throw vscode.FileSystemError.Unavailable("Computer connection not open yet");
        if (!supportsFilesystem) throw vscode.FileSystemError.Unavailable("Connected computer doesn't support filesystems");
        return queueDataRequest(parseInt(uri.authority), 21, uri.path, content);
    }
}

/**
 * @param {Buffer} chunk data
 */
function processDataChunk(chunk) {
    if (typeof chunk === "string") chunk = new Buffer(chunk, "utf8");
    if (data_continuation !== null) {
        chunk = Buffer.concat([data_continuation, chunk]);
        data_continuation = null;
    }
    while (chunk.length > 0) {
        let off;
        if (chunk.subarray(0, 4).toString() === "!CPC") off = 8;
        else if (chunk.subarray(0, 4).toString() === "!CPD" && isVersion11) off = 16;
        else {
            console.error("Invalid message");
            return;
        }
        const size = parseInt(chunk.subarray(4, off).toString(), 16);
        if (size > chunk.length + 9) {
            data_continuation = chunk;
            return;
        }
        const data = Buffer.from(chunk.subarray(off, size + off).toString(), 'base64');
        const good_checksum = parseInt(chunk.subarray(size + off, size + off + 8).toString(), 16);
        const data_checksum = crc32(useBinaryChecksum ? data.toString("binary") : chunk.subarray(off, size + off).toString());
        if (good_checksum !== data_checksum) {
            console.error("Bad checksum: expected " + good_checksum.toString(16) + ", got " + data_checksum.toString(16));
            chunk = chunk.subarray(size + 16);
            while (String.fromCharCode(chunk[0]).match(/\s/)) chunk = chunk.subarray(1);
            continue;
        }
        let term = {}
        const stream = bufferstream(data);
        const type = stream.get();
        const id = stream.get();
        if (!gotMessage && type == 4) process_connection.stdin.write("!CPC0008BgADAA==498C93D2\n"); // 0x0003
        gotMessage = true;
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
                if (process_connection.connected) {
                    process_connection.stdin.write("\n", "utf8");
                    process_connection.disconnect();
                } else {
                    process_connection.kill(SIGINT);
                    //vscode.window.showWarningMessage("The CraftOS-PC worker process did not close correctly. Some changes may not have been saved.")
                }
                closeAllWindows();
                return;
            } else if (type2 === 1) {
                if (windows[id].panel !== undefined) windows[id].panel.dispose();
                delete windows[id];
                computer_provider._onDidChangeTreeData.fire(null);
                monitor_provider._onDidChangeTreeData.fire(null);
                chunk = chunk.subarray(size + 16);
                while (String.fromCharCode(chunk[0]).match(/\s/)) chunk = chunk.subarray(1);
                continue;
            } else if (type2 === 0) {
                winid = stream.get();
                term.width = stream.readUInt16();
                term.height = stream.readUInt16();
                term.title = "";
                for (let c = stream.get(); c !== 0; c = stream.get()) term.title += String.fromCharCode(c);
                if (windows[id] !== undefined) {
                    windows[id].isMonitor = typeof term.title === "string" && term.title.indexOf("Monitor") !== -1;
                    if (winid > 0) {
                        windows[id].computerID = winid - 1;
                        windows[id].isMonitor = false;
                    } else if (typeof term.title === "string" && term.title.match(/Computer \d+$/)) {
                        windows[id].computerID = parseInt(term.title.match(/Computer (\d+)$/)[1]);
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
                case 0x10: vscode.window.showErrorMessage("CraftOS-PC: " + title + ": " + message); break;
                case 0x20: vscode.window.showWarningMessage("CraftOS-PC: " + title + ": " + message); break;
                case 0x40: vscode.window.showInformationMessage("CraftOS-PC: " + title + ": " + message); break;
            }
        } else if (type === 6) {
            const flags = stream.readUInt16();
            isVersion11 = true;
            useBinaryChecksum = (flags & 1) === 1;
            supportsFilesystem = (flags & 2) === 2;
            computer_provider._onDidChangeTreeData.fire(null);
        } else if (type === 8) {
            const reqtype = stream.get();
            const reqid = stream.get();
            if (!dataRequestCallbacks[reqid]) {
                console.log("Got stray response for request ID " + reqid + ", ignoring.");
                chunk = chunk.subarray(size + 16);
                while (String.fromCharCode(chunk[0]).match(/\s/)) chunk = chunk.subarray(1);
                continue;
            }
            switch (reqtype) {
                case 0: case 1: case 2: {
                    const ok = stream.get();
                    if (ok === 0) dataRequestCallbacks[reqid](false);
                    else if (ok === 1) dataRequestCallbacks[reqid](true);
                    else dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                    break;
                } case 3: case 5: case 6: {
                    const size = stream.readUInt32();
                    if (size === 0xFFFFFFFF) dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                    else dataRequestCallbacks[reqid](size);
                    break;
                } case 4: {
                    let str = "";
                    for (let c = stream.get(); c !== 0; c = stream.get()) str += String.fromCharCode(c);
                    if (str !== "") dataRequestCallbacks[reqid](str);
                    else dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                    break;
                } case 7: case 9: {
                    const size = stream.readUInt32();
                    if (size === 0xFFFFFFFF) dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                    else {
                        let arr = [];
                        for (let i = 0; i < size; i++) {
                            arr[i] = "";
                            for (let c = stream.get(); c !== 0; c = stream.get()) arr[i] += String.fromCharCode(c);
                        }
                        dataRequestCallbacks[reqid](arr);
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
                    if (ok === 0) dataRequestCallbacks[reqid](attr);
                    else if (ok === 1) dataRequestCallbacks[reqid](null);
                    else dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                    break;
                } case 10: case 11: case 12: case 13:
                case 16: case 17: case 18: case 19:
                case 20: case 21: case 22: case 23: {
                    let str = "";
                    for (let c = stream.get(); c !== 0; c = stream.get()) str += String.fromCharCode(c);
                    if (str === "") dataRequestCallbacks[reqid]();
                    else dataRequestCallbacks[reqid](null, new Error(str));
                    break;
                }
            }
            delete dataRequestCallbacks[reqid];
        } else if (type === 9) {
            const fail = stream.get();
            const reqid = stream.get();
            if (!dataRequestCallbacks[reqid]) {
                console.log("Got stray data response for request ID " + reqid + ", ignoring.");
                chunk = chunk.subarray(size + 16);
                while (String.fromCharCode(chunk[0]).match(/\s/)) chunk = chunk.subarray(1);
                continue;
            }
            const size = stream.readUInt32();
            const data = Buffer.alloc(size);
            stream.str.copy(data, 0, stream.pos);
            if (fail) dataRequestCallbacks[reqid](null, new Error(data.toString()));
            else dataRequestCallbacks[reqid](data);
            delete dataRequestCallbacks[reqid];
        }
        if (windows[id] === undefined) windows[id] = {};
        if (windows[id].term === undefined) windows[id].term = {};
        for (let k in term) windows[id].term[k] = term[k];
        if (windows[id].isMonitor === undefined) {
            windows[id].isMonitor = typeof windows[id].term.title === "string" && windows[id].term.title.indexOf("Monitor") !== -1;
            if (winid !== null && winid > 0) {
                windows[id].computerID = winid - 1;
                windows[id].isMonitor = false;
            } else if (typeof windows[id].term.title === "string" && windows[id].term.title.match(/Computer \d+$/)) {
                windows[id].computerID = parseInt(windows[id].term.title.match(/Computer (\d+)$/)[1]);
            }
        }
        if (windows[id].panel !== undefined) {
            windows[id].panel.webview.postMessage(windows[id].term);
            windows[id].panel.title = windows[id].term.title || "CraftOS-PC Terminal";
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
    if (process_connection !== null) return true;
    const exe_path = getSetting("craftos-pc.executablePath");
    if (exe_path === null) {
        vscode.window.showErrorMessage("Please set the path to the CraftOS-PC executable in the settings.");
        return false;
    }
    if (!fs.existsSync(exe_path)) {
        vscode.window.showErrorMessage("The CraftOS-PC executable could not be found. Check the path in the settings." + (os.platform() === "win32" ? " If you installed CraftOS-PC without administrator privileges, you will need to set the path manually. Also make sure CraftOS-PC_console.exe exists in the install directory - if not, reinstall CraftOS-PC with the Console build component enabled." : ""));
        return false;
    }
    const dir = vscode.workspace.getConfiguration("craftos-pc").get("dataPath");
    let process_options = {
        windowsHide: true
    };
    let args = vscode.workspace.getConfiguration("craftos-pc").get("additionalArguments");
    if (args !== null) {args = args.split(' '); args.push("--raw");}
    else args = ["--raw"];
    if (dir !== null) args.splice(-1, 0, "-d", dir);
    if (extra_args !== null) args = args.concat(extra_args);
    console.log("Running: " + exe_path + " " + args.join(" "));
    try {
        process_connection = child_process.spawn(exe_path, args, process_options);
    } catch (e) {
        vscode.window.showErrorMessage("The CraftOS-PC worker process could not be launched. Check the path to the executable in the settings.");
        console.error(e);
        return;
    }
    process_connection.on("error", () => {
        vscode.window.showErrorMessage("The CraftOS-PC worker process could not be launched. Check the path to the executable in the settings.");
        process_connection = null;
        closeAllWindows();
    });
    process_connection.on("exit", code => {
        vscode.window.showInformationMessage(`The CraftOS-PC worker process exited with code ${code}.`)
        process_connection = null;
        closeAllWindows();
    });
    process_connection.on("disconnect", () => {
        vscode.window.showErrorMessage(`The CraftOS-PC worker process was disconnected from the window.`)
        process_connection = null;
        closeAllWindows();
    });
    process_connection.on("close", () => {
        //vscode.window.showInformationMessage(`The CraftOS-PC worker process closed all IO streams with code ${code}.`)
        process_connection = null;
        closeAllWindows();
    });
    process_connection.stdout.on("data", processDataChunk);
    process_connection.stderr.on('data', data => {
        console.error(data.toString());
    });
    //process_connection.stdin.write("!CPC0008BgACAA==FBAC4FC2\n"); // 0x0002
    process_connection.stdin.write("!CPC0008BgADAA==498C93D2\n"); // 0x0003
    //process_connection.stdin.write("!CPC0008BgAGAA==0E2CE902\n"); // 0x0006
    //process_connection.stdin.write("!CPC0008BgAHAA==8C7C7ED3\n"); // 0x0007
    vscode.window.showInformationMessage("A new CraftOS-PC worker process has been started.");
    openPanel(0, true);
    gotMessage = false;
    data_continuation = null;
    nextDataRequestID = 0;
    dataRequestCallbacks = {};
    isVersion11 = false;
    useBinaryChecksum = false;
    supportsFilesystem = false;
}

function connectToWebSocket(url) {
    if (process_connection !== null || url === undefined) return true;
    const socket = new WebSocket(url);
    // We insert a small shim here so we don't have to rewrite the other code.
    process_connection = {
        connected: socket.readyState == WebSocket.OPEN,
        disconnect: () => socket.close(),
        kill: () => socket.close(),
        stdin: {write: data => {for (let i = 0; i < data.length; i += 65530) socket.send(data.substring(i, Math.min(i + 65530, data.length)))}}
    };
    socket.on("open", () => {
        //socket.send("!CPC0008BgACAA==FBAC4FC2\n"); // 0x0002
        //socket.send("!CPC0008BgADAA==498C93D2\n"); // 0x0003
        //socket.send("!CPC0008BgAGAA==0E2CE902\n"); // 0x0006
        socket.send("!CPC0008BgAHAA==8C7C7ED3\n"); // 0x0007
        vscode.window.showInformationMessage("Successfully connected to the WebSocket server.");
        process_connection.connected = true;
        openPanel(0, true);
    });
    socket.on("error", e => {
        if (e.message.match("certificate has expired"))
            vscode.window.showErrorMessage("A bug in VS Code is causing the connection to fail. Please go to https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error to fix it.", "Open Page", "OK").then(res => {
                if (res === "OK") return;
                vscode.env.openExternal(vscode.Uri.parse("https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error"));
            });
        else vscode.window.showErrorMessage("An error occurred while connecting to the server: " + e.message);
        process_connection = null;
        closeAllWindows();
    });
    socket.on("close", () => {
        vscode.window.showInformationMessage("Disconnected from the WebSocket server.");
        process_connection = null;
        closeAllWindows();
    });
    socket.on("message", processDataChunk);
    gotMessage = false;
    data_continuation = null;
    nextDataRequestID = 0;
    dataRequestCallbacks = {};
    isVersion11 = false;
    useBinaryChecksum = false;
    supportsFilesystem = false;
}

function openPanel(id, force) {
    if (!force && (extcontext === null || windows[id] === undefined)) return;
    if (windows[id] !== undefined && windows[id].panel !== undefined) {
        windows[id].panel.reveal();
        return;
    }
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
        'CraftOS-PC Terminal',
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
    panel.iconPath = windows[id] && windows[id].isMonitor ? vscode.Uri.file(path.join(extcontext.extensionPath, 'media/monitor.svg')) : vscode.Uri.file(path.join(extcontext.extensionPath, 'media/computer.svg'));
    panel.webview.html = fs.readFileSync(onDiskPath.fsPath, 'utf8');
    panel.webview.onDidReceiveMessage(message => {
        if (typeof message !== "object" || process_connection === null) return;
        if (message.getFontPath === true) {
            if (fontPath !== null && fontPath !== "") panel.webview.postMessage({fontPath: panel.webview.asWebviewUri(vscode.Uri.file(fontPath)).toString()});
            return;
        }
        const data = Buffer.alloc(message.data.length / 2 + 2);
        data[0] = message.type;
        data[1] = id;
        Buffer.from(message.data, 'hex').copy(data, 2)
        const b64 = data.toString('base64');
        const packet = "!CPC" + ("000" + b64.length.toString(16)).slice(-4) + b64 + ("0000000" + crc32(useBinaryChecksum ? data.toString("binary") : b64).toString(16)).slice(-8) + "\n";
        process_connection.stdin.write(packet, 'utf8');
    });
    panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active && windows[id].term !== undefined) {
            e.webviewPanel.webview.postMessage(windows[id].term);
            e.webviewPanel.title = windows[id].term.title || "CraftOS-PC Terminal";
        }
    });
    panel.onDidDispose(() => {if (windows[id].panel !== undefined) delete windows[id].panel;});
    if (windows[id] === undefined) windows[id] = {};
    windows[id].panel = panel;
    if (windows[id].term !== undefined) {
        windows[id].panel.webview.postMessage(windows[id].term);
        windows[id].panel.title = windows[id].term.title || "CraftOS-PC Terminal";
    }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "craftos-pc" is now active!');

    extcontext = context;

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open', () => {
        if (process_connection !== null) {
            vscode.window.showErrorMessage("Please close the current connection before using this command.");
            return;
        }
        return connectToProcess();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-websocket', obj => {
        if (process_connection !== null) {
            vscode.window.showErrorMessage("Please close the current connection before using this command.");
            return;
        }
        if (typeof obj === "string") return connectToWebSocket(obj);
        let wsHistory = context.globalState.get("JackMacWindows.craftos-pc/websocket-history", [""]);
        let quickPick = vscode.window.createQuickPick();
        quickPick.items = wsHistory.map(val => {return {label: val}});
        quickPick.title = "Enter the WebSocket URL:";
        quickPick.placeholder = "wss://";
        quickPick.canSelectMany = false;
        quickPick.onDidChangeValue(() => {
            wsHistory[0] = quickPick.value;
            quickPick.items = wsHistory.map(val => {return {label: val}});
        });
        quickPick.onDidAccept(() => {
            let str = quickPick.selectedItems[0].label;
            if (!validateURL(str)) vscode.window.showErrorMessage("The URL you entered is not valid.");
            else {
                wsHistory[0] = str;
                if (wsHistory.slice(1).includes(str))
                    wsHistory.splice(wsHistory.slice(1).indexOf(str)+1, 1);
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

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-new-remote', () => {
        if (process_connection !== null) {
            vscode.window.showErrorMessage("Please close the current connection before using this command.");
            return;
        }
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

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-window', obj => {
        if (process_connection === null) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }
        if (typeof obj === "object") openPanel(parseInt(obj.id));
        else vscode.window.showInputBox({prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null}).then(id => openPanel(parseInt(id)));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-config', () => {
        if (getDataPath() === null) {
            vscode.window.showErrorMessage("Please set the path to the CraftOS-PC data directory manually.");
            return;
        }
        vscode.commands.executeCommand("vscode.open", vscode.Uri.file(getDataPath() + "/config/global.json"));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-computer-data', obj => {
        if (getDataPath() === null) {
            vscode.window.showErrorMessage("Please set the path to the CraftOS-PC data directory manually.");
            return;
        }
        if (typeof obj === "object") {
            vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(getDataPath() + "/computer/" + windows[parseInt(obj.id)].computerID), {forceNewWindow: true});
        } else {
            vscode.window.showInputBox({prompt: "Enter the computer ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null}).then(value => {
                if (!fs.existsSync(getDataPath() + "/computer/" + value)) vscode.window.showErrorMessage("The computer ID provided does not exist.");
                else vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(getDataPath() + "/computer/" + value));
            });
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-remote-data', obj => {
        if (process_connection === null) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        } else if (!supportsFilesystem) {
            vscode.window.showErrorMessage("This connection does not support file system access.");
            return;
        } else if (!vscode.workspace.workspaceFile) {
            vscode.window.showWarningMessage("Due to technical limitations, opening the computer data will cause the connection to close. Please restart the connection after running this. Are you sure you want to continue?", "No", "Yes").then(opt => {
                if (opt === "No") return;
                // haha code duplication goes brrrrr
                if (typeof obj === "object") {
                    deactivate();
                    vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, null, {name: obj.title.replace(/^.*: */, ""), uri: vscode.Uri.parse(`craftos-pc://${obj.id}/`)});
                } else {
                    vscode.window.showInputBox({prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null}).then(value => {
                        if (typeof windows[value] !== "object") vscode.window.showErrorMessage("The window ID provided does not exist.");
                        else vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, null, {name: windows[value].title.replace(/^.*: */, ""), uri: vscode.Uri.parse(`craftos-pc://${value}/`)});
                    });
                }
            });
            return;
        }
        if (typeof obj === "object") {
            vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, null, {name: obj.title.replace(/^.*: */, ""), uri: vscode.Uri.parse(`craftos-pc://${obj.id}/`)});
        } else {
            vscode.window.showInputBox({prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null}).then(value => {
                if (typeof windows[value] !== "object") vscode.window.showErrorMessage("The window ID provided does not exist.");
                else vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, null, {name: windows[value].title.replace(/^.*: */, ""), uri: vscode.Uri.parse(`craftos-pc://${value}/`)});
            });
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.close', () => {
        if (process_connection === null) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }
        process_connection.stdin.write(useBinaryChecksum ? "!CPC000CBAACAAAAAAAA2C7A548B\n" : "!CPC000CBAACAAAAAAAA3AB9B910\n", "utf8");
    }));

    context.subscriptions.push(vscode.commands.registerCommand("craftos-pc.close-window", obj => {
        if (process_connection === null) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }
        let id;
        if (typeof obj === "object") id = new Promise(resolve => resolve(obj.id));
        else id = vscode.window.showInputBox({prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null});
        id.then(id => {
            const data = Buffer.alloc(9);
            data.fill(0);
            data[0] = 4;
            data[1] = parseInt(id);
            data[2] = 1;
            const b64 = data.toString("base64");
            process_connection.stdin.write("!CPC000C" + b64 + ("0000000" + crc32(useBinaryChecksum ? data.toString("binary") : b64).toString(16)).slice(-8) + "\n", "utf8");
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand("craftos-pc.kill", () => {
        if (process_connection === null) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }
        process_connection.stdin.write(useBinaryChecksum ? "!CPC000CBAACAAAAAAAA2C7A548B\n" : "!CPC000CBAACAAAAAAAA3AB9B910\n", "utf8");
        process_connection.kill(SIGINT);
        process_connection = null;
    }));

    context.subscriptions.push(vscode.commands.registerCommand("craftos-pc.run-file", path => {
        if (process_connection === null) {
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
        } else vscode.window.showErrorMessage("Please close CraftOS-PC before using this command.");
    }));

    context.subscriptions.push(vscode.workspace.registerFileSystemProvider("craftos-pc", new RawFileSystemProvider()));
    context.subscriptions.push(vscode.window.registerUriHandler({handleUri: uri => {
        vscode.commands.executeCommand("craftos-pc.open-websocket", uri.path.replace(/^\//, ""));
    }}));

    vscode.window.createTreeView("craftos-computers", {"treeDataProvider": computer_provider});
    vscode.window.createTreeView("craftos-monitors", {"treeDataProvider": monitor_provider});
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
    if (process_connection) {
        if (process_connection.connected) {
            process_connection.stdin.write(useBinaryChecksum ? "!CPC000CBAACAAAAAAAA2C7A548B\n" : "!CPC000CBAACAAAAAAAA3AB9B910\n", "utf8");
            process_connection.disconnect();
            if (process_connection.isWS) process_connection = null;
        } else {
            process_connection.kill(SIGINT);
            if (process_connection.isWS) process_connection = null;
        }
    }
    closeAllWindows();
}

module.exports = {
    activate,
    deactivate
}
