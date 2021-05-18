const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const process = require('process');
const child_process = require('child_process');
const { SIGINT } = require('constants');

var windows = {};
var crcTable = null;
var extcontext = null;
var computer_tree = null;
var monitor_tree = null;

var makeCRCTable = function(){
    var c;
    var crcTable = [];
    for(var n =0; n < 256; n++){
        c = n;
        for(var k =0; k < 8; k++){
            c = ((c&1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
        }
        crcTable[n] = c;
    }
    return crcTable;
}

var crc32 = function(str) {
    crcTable = crcTable || makeCRCTable();
    var crc = 0 ^ (-1);

    for (var i = 0; i < str.length; i++ ) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ str.charCodeAt(i)) & 0xFF];
    }

    return (crc ^ (-1)) >>> 0;
};

function bufferstream(str) {
    var retval = {}
    retval.pos = 0
    retval.str = str
    retval.readUInt32 = function() {
        var r = this.str.readUInt32LE(this.pos);
        this.pos += 4;
        return r;
    }
    retval.readUInt16 = function() {
        var r = this.str.readUInt16LE(this.pos);
        this.pos += 2;
        return r;
    }
    retval.get = function() {
        return this.str.readUInt8(this.pos++);
    }
    retval.putback = function() {this.pos--;}
    return retval;
}

var computer_provider = {
    getChildren: function(element) {
        if ((element === undefined || element === null) && process_connection !== null) {
            let arr = [];
            for (var w in windows) if (!windows[w].isMonitor) arr.push({title: windows[w].term.title, id: w});
            return arr;
        }
        else return null;
    },
    getTreeItem: function(element) {
        var r = new vscode.TreeItem(element.title);
        r.iconPath = vscode.Uri.file(path.join(extcontext.extensionPath, 'media/computer.svg'));
        return r;
    },
    _onDidChangeTreeData: new vscode.EventEmitter(),
};
computer_provider.onDidChangeTreeData = computer_provider._onDidChangeTreeData.event;

var monitor_provider = {
    getChildren: function(element) {
        if ((element === undefined || element === null) && process_connection !== null) {
            let arr = [];
            for (var w in windows) if (windows[w].isMonitor) arr.push({title: windows[w].term.title, id: w});
            return arr;
        }
        else return null;
    },
    getTreeItem: function(element) {
        var r = new vscode.TreeItem(element.title);
        r.iconPath = vscode.Uri.file(path.join(extcontext.extensionPath, 'media/computer.svg'));
        return r;
    },
    _onDidChangeTreeData: new vscode.EventEmitter(),
}
monitor_provider.onDidChangeTreeData = monitor_provider._onDidChangeTreeData.event;

var process_connection = null;
var data_continuation = null;

function getSetting(name) {
    let config = vscode.workspace.getConfiguration(name);
    if (config.get("all") !== null) return config.get("all");
    else if (os.platform() === "win32") return config.get("windows").replace(/%([^%]+)%/g, (_, n) => process.env[n] || ('%' + n + '%'));
    else if (os.platform() === "darwin") return config.get("mac").replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'));
    else if (os.platform() === "linux") return config.get("linux").replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'));
    else return null;
}

function getDataPath() {
    let config = vscode.workspace.getConfiguration("craftos-pc");
    if (config.get("dataPath") !== null) return config.get("dataPath");
    else if (os.platform() === "win32") return "%appdata%\\CraftOS-PC".replace(/%([^%]+)%/g, (_, n) => process.env[n] || ('%' + n + '%'));
    else if (os.platform() === "darwin") return "$HOME/Library/Application Support/CraftOS-PC".replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'))
    else if (os.platform() === "linux") return "$HOME/.local/craftos-pc".replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'))
    else return null;
}

function closeAllWindows() {
    for (var k in windows) if (windows[k].panel !== undefined) windows[k].panel.dispose();
    windows = {};
    computer_provider._onDidChangeTreeData.fire(null);
    monitor_provider._onDidChangeTreeData.fire(null);
}

function connectToProcess() {
    if (process_connection !== null) return true;
    let exe_path = getSetting("craftos-pc.executablePath");
    if (exe_path === null) {
        vscode.window.showErrorMessage("Please set the path to the CraftOS-PC executable in the settings.");
        return false;
    }
    if (!fs.existsSync(exe_path)) {
        vscode.window.showErrorMessage("The CraftOS-PC executable could not be found. Check the path in the settings." + (os.platform() === "win32" ? " If you installed CraftOS-PC without administrator privileges, you will need to set the path manually. Also make sure CraftOS-PC_console.exe exists in the install directory - if not, reinstall CraftOS-PC with the Console build component enabled." : ""));
        return false;
    }
    let dir = vscode.workspace.getConfiguration("craftos-pc").get("dataPath");
    let process_options = {
        windowsHide: true
    };
    let args = vscode.workspace.getConfiguration("craftos-pc").get("additionalArguments");
    if (args !== null) {args = args.split(' '); args.push("--raw");}
    else args = ["--raw"];
    if (dir !== null) args.splice(-1, 0, "-d", dir);
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
    process_connection.on("exit", (code) => {
        vscode.window.showInformationMessage(`The CraftOS-PC worker process exited with code ${code}.`)
        process_connection = null;
        closeAllWindows();
    });
    process_connection.on("disconnect", () => {
        vscode.window.showErrorMessage(`The CraftOS-PC worker process was disconnected from the window.`)
        process_connection = null;
        closeAllWindows();
    });
    process_connection.on("close", (code) => {
        //vscode.window.showInformationMessage(`The CraftOS-PC worker process closed all IO streams with code ${code}.`)
        process_connection = null;
        closeAllWindows();
    });
    process_connection.stdout.on("data", (chunk) => {
        if (data_continuation !== null) {
            chunk = Buffer.concat([data_continuation, chunk]);
            data_continuation = null;
        }
        if (chunk.subarray(0, 4).toString() != "!CPC") console.error("Invalid message");
        else {
            var size = parseInt(chunk.subarray(4, 8).toString(), 16);
            if (size > chunk.length + 16) {
                data_continuation = chunk;
                return;
            }
            var data = Buffer.from(chunk.subarray(8, size + 8).toString(), 'base64');
            var good_checksum = parseInt(chunk.subarray(size + 8, size + 16).toString(), 16);
            var data_checksum = crc32(chunk.subarray(8, size + 8).toString());
            if (good_checksum != data_checksum) {
                console.error("Bad checksum: expected " + good_checksum.toString(16) + ", got " + data_checksum.toString(16));
                return;
            }
            var term = {}
            var stream = bufferstream(data);
            var type = stream.get();
            var id = stream.get();
            if (type == 0) {
                term.mode = stream.get();
                term.blink = stream.get() == 1;
                term.width = stream.readUInt16();
                term.height = stream.readUInt16();
                term.cursorX = stream.readUInt16();
                term.cursorY = stream.readUInt16();
                stream.readUInt32();
                term.screen = {}
                term.colors = {}
                term.pixels = {}
                if (term.mode == 0) {
                    var c = stream.get();
                    var n = stream.get();
                    for (var y = 0; y < term.height; y++) {
                        term.screen[y] = {}
                        for (var x = 0; x < term.width; x++) {
                            term.screen[y][x] = c;
                            n--;
                            if (n == 0) {
                                c = stream.get();
                                n = stream.get();
                            }
                        }
                    }
                    for (var y = 0; y < term.height; y++) {
                        term.colors[y] = {}
                        for (var x = 0; x < term.width; x++) {
                            term.colors[y][x] = c;
                            n--;
                            if (n == 0) {
                                c = stream.get();
                                n = stream.get();
                            }
                        }
                    }
                    stream.putback();
                    stream.putback();
                } else if (term.mode == 1 || term.mode == 2) {
                    var c = stream.get();
                    var n = stream.get();
                    for (var y = 0; y < term.height * 9; y++) {
                        term.pixels[y] = {}
                        for (var x = 0; x < term.width * 6; x++) {
                            term.pixels[y][x] = c;
                            n--;
                            if (n == 0) {
                                c = stream.get();
                                n = stream.get();
                            }
                        }
                    }
                    stream.putback();
                    stream.putback();
                }
                term.palette = {}
                if (term.mode == 0 || term.mode == 1) {
                    for (var i = 0; i < 16; i++) {
                        term.palette[i] = {}
                        term.palette[i].r = stream.get();
                        term.palette[i].g = stream.get();
                        term.palette[i].b = stream.get();
                    }
                } else if (term.mode == 2) {
                    for (var i = 0; i < 256; i++) {
                        term.palette[i] = {}
                        term.palette[i].r = stream.get();
                        term.palette[i].g = stream.get();
                        term.palette[i].b = stream.get();
                    }
                }
            } else if (type == 4) {
                var type2 = stream.get();
                if (type2 == 2) {
                    if (process_connection.connected) {
                        process_connection.stdin.write("\n", "utf8");
                        process_connection.disconnect();
                    } else {
                        process_connection.kill(SIGINT);
                        //vscode.window.showWarningMessage("The CraftOS-PC worker process did not close correctly. Some changes may not have been saved.")
                    }
                    closeAllWindows();
                    return;
                } else if (type2 == 1) {
                    if (windows[id].panel !== undefined) windows[id].panel.dispose();
                    delete windows[id];
                    computer_provider._onDidChangeTreeData.fire(null);
                    monitor_provider._onDidChangeTreeData.fire(null);
                    return;
                } else if (type2 == 0) {
                    stream.get();
                    term.width = stream.readUInt16();
                    term.height = stream.readUInt16();
                    term.title = "";
                    for (var c = stream.get(); c != 0; c = stream.get()) term.title += String.fromCharCode(c);
                    if (windows[id] !== undefined) windows[id].isMonitor = typeof term.title === "string" && term.title.indexOf("Monitor") !== -1;
                }
            } else if (type == 5) {
                var flags = stream.readUInt32();
                var title = "";
                for (var c = stream.get(); c != 0; c = stream.get()) title += String.fromCharCode(c);
                var message = "";
                for (var c = stream.get(); c != 0; c = stream.get()) message += String.fromCharCode(c);
                switch (flags) {
                    case 0x10: vscode.window.showErrorMessage("CraftOS-PC: " + title + ": " + message); break;
                    case 0x20: vscode.window.showWarningMessage("CraftOS-PC: " + title + ": " + message); break;
                    case 0x40: vscode.window.showInformationMessage("CraftOS-PC: " + title + ": " + message); break;
                }
            }
            if (windows[id] === undefined) windows[id] = {};
            if (windows[id].term === undefined) windows[id].term = {};
            for (var k in term) windows[id].term[k] = term[k];
            if (windows[id].isMonitor === undefined) windows[id].isMonitor = typeof windows[id].term.title === "string" && windows[id].term.title.indexOf("Monitor") !== -1;
            if (windows[id].panel !== undefined) {
                windows[id].panel.webview.postMessage(windows[id].term);
                windows[id].panel.title = windows[id].term.title || "CraftOS-PC Terminal";
            }
            if (type == 4) {
                computer_provider._onDidChangeTreeData.fire(null);
                monitor_provider._onDidChangeTreeData.fire(null);
            }
        }
    });
    process_connection.stderr.on('data', data => {
        console.error(data.toString());
    })
    vscode.window.showInformationMessage("A new CraftOS-PC worker process has been started.");
    openPanel(0, true);
}

function openPanel(id, force) {
    if (!force && (extcontext === null || windows[id] === undefined)) return;
    if (windows[id] !== undefined && windows[id].panel !== undefined) {
        windows[id].panel.reveal();
        return;
    }
    const customFont = vscode.workspace.getConfiguration("craftos-pc.customFont");
    let fontPath = customFont.get("path");
    if (fontPath !== null) {
        if (fontPath === "hdfont") {
            const execPath = getSetting("craftos-pc.executablePath");
            if (os.platform() === "win32") fontPath = execPath.replace(/\/[^\/]+$/, "/") + "hdfont.bmp";
            else if (os.platform() === "darwin" && execPath.indexOf("MacOS/craftos") !== -1) fontPath = execPath.replace(/MacOS\/[^\/]+$/, "") + "Resources/hdfont.bmp";
            else if (os.platform() == "darwin" || (os.platform() == "linux" && !fs.existsSync("/usr/share/craftos/hdfont.bmp"))) fontPath = "/usr/local/share/craftos/hdfont.bmp";
            else if (os.platform() == "linux") fontPath = "/usr/share/craftos/hdfont.bmp";
            if (!fs.existsSync(fontPath)) {
                vscode.window.showWarningMessage("The path to the HD font could not be found; the default font will be used instead. Please set the path to the HD font manually.");
                fontPath = null;
            }
        }
    }
    const panel = vscode.window.createWebviewPanel(
        'craftos-pc',
        'CraftOS-PC Terminal',
        vscode.window.activeTextEditor && vscode.window.activeTextEditor.viewColumn || vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: fontPath && [vscode.Uri.file(fontPath.replace(/\/[^\/]*$/, ""))]
        }
    );
    // Get path to resource on disk
    const onDiskPath = vscode.Uri.file(path.join(extcontext.extensionPath, 'index.html'));
    panel.iconPath = vscode.Uri.file(path.join(extcontext.extensionPath, 'media/computer.svg'));
    panel.webview.html = fs.readFileSync(onDiskPath.fsPath, 'utf8');
    panel.webview.onDidReceiveMessage(message => {
        if (typeof message !== "object" || process_connection === null) return;
        if (message.getFontPath === true && fontPath !== null) {
            panel.webview.postMessage({fontPath: panel.webview.asWebviewUri(vscode.Uri.file(fontPath)).toString(), fontScale: customFont.get("scale")});
            return;
        }
        var data = Buffer.alloc(message.data.length / 2 + 2);
        data[0] = message.type;
        data[1] = id;
        Buffer.from(message.data, 'hex').copy(data, 2)
        var b64 = data.toString('base64');
        var packet = "!CPC" + ("000" + b64.length.toString(16)).slice(-4) + b64 + ("0000000" + crc32(b64).toString(16)).slice(-8) + "\n";
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

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json
    let disposable = vscode.commands.registerCommand('craftos-pc.open', function () {
        connectToProcess();
    });

    let disposable2 = vscode.commands.registerCommand('craftos-pc.open-window', function () {
        if (process_connection === null) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }
        vscode.window.showInputBox({prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null}).then(value => openPanel(parseInt(value)));
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(disposable2);

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-config', function() {
        if (getDataPath() == null) {
            vscode.window.showErrorMessage("Please set the path to the CraftOS-PC data directory manually.");
            return;
        }
        vscode.commands.executeCommand("vscode.open", vscode.Uri.file(getDataPath() + "/config/global.json"));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-computer-data', function() {
        if (getDataPath() == null) {
            vscode.window.showErrorMessage("Please set the path to the CraftOS-PC data directory manually.");
            return;
        }
        vscode.window.showInputBox({prompt: "Enter the computer ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null}).then(value => {
            if (!fs.existsSync(getDataPath() + "/computer/" + value)) vscode.window.showErrorMessage("The computer ID provided does not exist.");
            else vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(getDataPath() + "/computer/" + value));
        })
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.close', function() {
        if (process_connection === null) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }
        process_connection.stdin.write("!CPC000CBAACAAAAAAAA3AB9B910\n", "utf8");
    }));

    context.subscriptions.push(vscode.commands.registerCommand("craftos-pc.close-window", (obj) => {
        if (process_connection === null) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }
        let id;
        if (typeof obj === "object") id = new Promise((resolve) => resolve(obj.id));
        else id = vscode.window.showInputBox({prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null});
        id.then((id) => {
            const data = Buffer.alloc(9);
            data.fill(0);
            data[0] = 4;
            data[1] = parseInt(id);
            data[2] = 1;
            const b64 = data.toString("base64");
            process_connection.stdin.write("!CPC000C" + b64 + ("0000000" + crc32(b64).toString(16)).slice(-8) + "\n");
        })
    }));

    computer_tree = vscode.window.createTreeView("craftos-computers", {"treeDataProvider": computer_provider});
    monitor_tree = vscode.window.createTreeView("craftos-monitors", {"treeDataProvider": monitor_provider});
    computer_tree.onDidChangeSelection(e => {for (var a in e.selection) openPanel(e.selection[a].id);});
    monitor_tree.onDidChangeSelection(e => {for (var a in e.selection) openPanel(e.selection[a].id);});
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {}

module.exports = {
    activate,
    deactivate
}
