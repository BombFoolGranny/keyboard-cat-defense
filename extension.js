import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

let evtestHelperProcess = null; // We store helper script process here

/**
* Used to control bash script that helps spawn evtest
*/
function controlEvtest(command) {
    const encoder = new TextEncoder();
    const buffer = encoder.encode(command + "\n");

    if (evtestHelperProcess) {
        evtestHelperProcess.get_stdin_pipe().write(buffer, null);
    }
}

class KeyboardListMenu extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }
    displayEverything = false;
    waylandMode = false;
    x11mode = false;

    constructor(path) {
        super(0.0, "Keyboard cat defense");

        // add main icon
        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(path + "/cat.svg"),
            style_class: "cat-icon",
        });
        this.add_child(icon);

        // even though we remove this item in _updateKeyboardList(), we need to add it
        // if we don't, the dropdown menu won't open at all
        this.menu.addMenuItem(
            new PopupMenu.PopupMenuItem("List of connected keyboards:"),
        );

        this.menu.connect("open-state-changed", (menu, open) => {
            // when opening for the first time
            if (open && !this.initialized) {
                this._updateKeyboardList();
                this.initialized = true;
            }
        });
    }

    /**
     * Used to spawn bash script that helps spawn evtest
     */
    _startEvtestHelper() {
        const rootExecScript = `
        while read -r cmd arg; do
            case "$cmd" in
                block)
                    evtest --grab "$arg" &
                    ;;
                unblock)
                    pkill -f "evtest --grab $arg"
                    ;;
                exit)
                    pkill evtest
                    exit 0
                    ;;
            esac
        done
    `;
        evtestHelperProcess = Gio.Subprocess.new(
            ["pkexec", "bash", "-c", rootExecScript],
            Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE,
        );
    }

    /**
     * Used to create the dropdown menu for the extensions
     */
    _updateKeyboardList() {
        this.menu.removeAll();

        const waylandToggleItem = new PopupMenu.PopupSwitchMenuItem(
            "Search Wayland devices",
            this.waylandMode,
        );
        this.menu.addMenuItem(waylandToggleItem);
        waylandToggleItem.connect("toggled", (item) => {
            if (item.state) {
                this._startEvtestHelper();
            } else {
                if (evtestHelperProcess) {
                    controlEvtest(`exit`); // killing all spawned evtest processes
                    evtestHelperProcess.force_exit(); // killing helper script process
                }
            }
            this.waylandMode = item.state;
            this._updateKeyboardList();
        });
        const x11ToggleItem = new PopupMenu.PopupSwitchMenuItem(
            "Search X11 devices",
            this.x11mode,
        );
        this.menu.addMenuItem(x11ToggleItem);
        x11ToggleItem.connect("toggled", (item) => {
            this.x11mode = item.state;
            this._updateKeyboardList();
        });
        const toggleItem = new PopupMenu.PopupSwitchMenuItem(
            "Display every input device",
            this.displayEverything,
        );
        this.menu.addMenuItem(toggleItem);
        toggleItem.connect("toggled", (item) => {
            this.displayEverything = item.state;
            this._updateKeyboardList();
        });

        // Get the list of connected keyboards
        if (this.waylandMode) {
            this._getConnectedWaylandKeyboards((err, keyboards) => {
                if (err) {
                    logError(err);
                    return;
                }
                if (keyboards.length === 0) {
                    const item = new PopupMenu.PopupMenuItem(
                        "No keyboards connected",
                    );
                    item.setSensitive(false);
                    this.menu.addMenuItem(item);
                    return;
                }
                this.menu.addMenuItem(
                    new PopupMenu.PopupMenuItem(
                        "List of Wayland connected keyboards:",
                    ),
                );
                keyboards.forEach((keyboard) => {
                    const waylandKeyboardToggleItem =
                        new PopupMenu.PopupSwitchMenuItem(keyboard.name, true); // Create a toggle button for the keyboard
                    this.menu.addMenuItem(waylandKeyboardToggleItem);

                    waylandKeyboardToggleItem.connect("toggled", (item) => {
                        if (item.state) {
                            this._enableKeyboard("wayland", keyboard.id);
                        } else {
                            this._disableKeyboard("wayland", keyboard.id);
                        }

                        return Clutter.EVENT_STOP;
                    });
                });
            });
        }
        if (this.x11mode) {
            this.menu.addMenuItem(
                new PopupMenu.PopupMenuItem("List of X11 connected keyboards:"),
            );
            this._getConnectedX11Keyboards((err, keyboards) => {
                if (err) {
                    logError(err);
                    return;
                }
                if (keyboards.length === 0) {
                    const item = new PopupMenu.PopupMenuItem(
                        "No keyboards connected",
                    );
                    item.setSensitive(false);
                    this.menu.addMenuItem(item);
                    return;
                }
                keyboards.forEach((keyboard) => {
                    const x11KeyboardToggleItem =
                        new PopupMenu.PopupSwitchMenuItem(keyboard.name, true); // Create a toggle button for the keyboard

                    this.menu.addMenuItem(x11KeyboardToggleItem);

                    x11KeyboardToggleItem.connect("toggled", (item) => {
                        if (item.state) {
                            this._enableKeyboard("x11", keyboard.id);
                        } else {
                            this._disableKeyboard("x11", keyboard.id);
                        }

                        return Clutter.EVENT_STOP;
                    });
                });
            });
        }
    }

    /**
     * Used to get the list of connected Wayland devices and filter for keyboards
     * @param {function(Error, object)} callback - error and list of keyboards
     */
    _getConnectedWaylandKeyboards(callback) {
        //const command = 'pkexec libinput list-devices | grep -A1 "Device:"'
        const command = 'libinput list-devices | grep -A1 "Device:"';
        const keyboards = [];
        try {
            const proc = Gio.Subprocess.new(
                ["pkexec", "/bin/bash", "-c", command],
                Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_PIPE,
            );
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    const [, stdout, stderr] =
                        proc.communicate_utf8_finish(res);

                    if (!proc.get_successful()) callback(new Error(stderr));

                    const devicesArray = stdout.split("--");

                    for (const deviceStrings of devicesArray) {
                        if (!this.displayEverything) {
                            // make sure the name also includes the word keyboard
                            if (
                                !deviceStrings
                                    .toLowerCase()
                                    .includes("keyboard")
                            ) {
                                continue;
                            }
                        }
                        let parts = deviceStrings.split("\n");
                        parts = parts.filter((part) => part != ""); // removing every empty element from array
                        const deviceName = parts[0].split(":")[1].trim();
                        const deviceKernelPath = parts[1].split(":")[1].trim();
                        keyboards.push({
                            name: deviceName,
                            id: deviceKernelPath,
                            type: "wayland",
                        });
                    }
                    callback(null, keyboards);
                } catch (e) {
                    callback(e);
                }
            });
        } catch (e) {
            callback(e);
        }
    }

    /**
     * Used to get the list of connected devices and filter for keyboards
     * @param {function(Error, object)} callback - error and list of keyboards
     */
    _getConnectedX11Keyboards(callback) {
        const command = "xinput list";
        try {
            const proc = Gio.Subprocess.new(
                ["/bin/bash", "-c", command],
                Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_PIPE,
            );
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    const [, stdout, stderr] =
                        proc.communicate_utf8_finish(res);

                    if (!proc.get_successful()) callback(new Error(stderr));
                    const keyboards = [];
                    const lines = stdout.toString().split("\n");

                    const keyboardIdRegex = /id=(\d+)/;

                    // let masterKeyId
                    for (const line of lines) {
                        // get the master keyboard Id
                        // if (line.includes('master keyboard')) {
                        //     // if we detect the master key id
                        //     if (keyboardIdRegex.exec(line)) {
                        //         masterKeyId = keyboardIdRegex.exec(line)[1]
                        //     }
                        // }

                        const parts = line.split("\t");
                        if (!this.displayEverything) {
                            if (!line.includes("slave  keyboard")) {
                                continue;
                            }

                            // make sure the name also includes the word keyboard
                            if (!parts[0].includes("keyboard")) {
                                continue;
                            }
                        }

                        // get the device ID
                        let keyId = keyboardIdRegex.exec(line);
                        if (keyId) {
                            keyId = keyId[1];

                            // for the keyboard name, trim the white space
                            // and loose the first chars
                            const keyboardName = parts[0].trim().slice(2);
                            keyboards.push({
                                name: keyboardName,
                                id: keyId,
                                type: "x11",
                            });
                        }
                    }
                    callback(null, keyboards);
                } catch (e) {
                    callback(e);
                }
            });
        } catch (e) {
            callback(e);
        }
    }

    /**
     * Disables a keyboard
     * @param  {string} keyboardType type of keyboard device, wayland or x11
     * @param  {number} keyboardId id of a keyboard device
     */
    _disableKeyboard(keyboardType, keyboardId) {
        if (keyboardType === "wayland") {
            try {
                controlEvtest(`block ${keyboardId}`);
            } catch (e) {
                logError(e);
            }
            return;
        }
        const command = `xinput --disable ${keyboardId}`;
        const success = GLib.spawn_command_line_async(command);
        if (!success) {
            log(`Error disabling keyboard: ${stderr}`);
        }
        return;
    }

    /**
     * Enables a keyboard
     * @param  {string} keyboardType type of keyboard device, wayland or x11
     * @param  {number} keyboardId id of a keyboard device
     */
    _enableKeyboard(keyboardType, keyboardId) {
        if (keyboardType === "wayland") {
            controlEvtest(`unblock ${keyboardId}`);
            return;
        }
        const command = `xinput --enable ${keyboardId}`;
        const success = GLib.spawn_command_line_async(command);
        if (!success) {
            log(`Error enabling keyboard: ${stderr}`);
        }
        return;
    }
}

export default class extends Extension {
    enable() {
        this._indicator = new KeyboardListMenu(this.path);
        Main.panel.addToStatusArea(
            "keyboard-list-menu",
            this._indicator,
            0,
            "right",
        );
    }

    disable() {
        controlEvtest(`exit`);
        this._indicator?.destroy();
        this._indicator = null;
    }
}
