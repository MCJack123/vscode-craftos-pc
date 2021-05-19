# CraftOS-PC for VS Code README

An extension for Visual Studio Code adding a bunch of new features to help you write ComputerCraft code easier through CraftOS-PC.

## Features

* Support for built-in CraftOS-PC terminals in VS Code
* Quickly access computer data directories and the configuration

![Screenshot](media/screenshot.png)

## Requirements

* CraftOS-PC v2.3 or later (https://www.craftos-pc.cc)
  * **If on Windows, make sure to install the console version as well under Optional components in the installer**
  * If installed in a non-standard directory (such as in your user directory), make sure to set `craftos-pc.executablePath` in the settings
  * If using more than one terminal, CraftOS-PC v2.4 or later is required due to a bug in earlier versions causing multiple terminals to get the same ID

## Recommended Extensions

* [ComputerCraft by JackMacWindows (me!)](https://marketplace.visualstudio.com/items?itemName=jackmacwindows.vscode-computercraft) for ComputerCraft autocomplete
* [Lua by sumneko](https://marketplace.visualstudio.com/items?itemName=sumneko.lua) for Lua syntax highlighting & linting

## Extension Settings

This extension contributes the following settings:

* `craftos-pc.executablePath.[windows|mac|linux|all]`: Path to the CraftOS-PC executable depending on the platform. This should be an absolute path to an executable supporting console output (on Windows, this must be pointing to a copy of `CraftOS-PC_console.exe`, which is optionally available in the installer).
* `craftos-pc.dataPath`: Path to the data directory storing computer files, configuration, etc.
* `craftos-pc.additionalArguments`: Additional command-line arguments to send to CraftOS-PC, separated by spaces.
* `craftos-pc.customFont.path`: The path to a custom font, if desired. Must be a path to a valid image, or 'hdfont' to automatically find the HD font. Unlike normal CraftOS-PC, this may point to non-BMP files as well.

## Known Issues

* If a non-default size is set for terminals, this extension will not function. A fix to allow resizing terminals will be available in the future.
* Occasionally, keyboard input will stop working. To fix this, click outside the CraftOS-PC window and then back in.
* Scroll events do not report the position of the scroll. This is a limitation of JavaScript.

## Release Notes

## 1.0.1

* Fixed mouse events not being sent to the window

## 1.0.0

* Added support for custom fonts
  * Font files must be in the exact same format as ComputerCraft fonts (with the same outer padding area)
* Added close buttons to each window, as well as a global quit button
* Added buttons to open a new window with the selected computer's data directory
  * This requires either CraftOS-PC v2.5.6 or later, or computers labeled "Computer &gt;id&lt;"
* Added button to open the configuration
* Added paste event detection
* Added icons for monitors
* Updated extension icon to CraftOS-PC v2.4's new icon
* Fixed duplicate drag events being sent for the same character cell
* Fixed mouse events sending the wrong coordinates
* Fixed the computer background not being drawn properly
* Upgraded y18n and lodash to fix vulnerabilities (#3, #4)
* Reformatted code to be a bit more clean

### 0.2.1

* Added an error message if the executable is missing
* Fixed `mouse_click` events being sent instead of `mouse_drag`

### 0.2.0

* Fixed performance issues causing high CPU usage and major slowdown
  * Render speed should now be about the same as in standard GUI mode
* Added `craftos-pc.additionalArguments` setting
* Added command to close the emulator session without having to close each window
* Fixed a bug causing CraftOS-PC to not start on Windows when a workspace is open

### 0.1.1

Fixes a bug where the wrong key events were being sent (e.g. `key_up` when pressing a key down). Also fixes `char` events being sent with modifier keys held.

Download the latest build of CraftOS-PC (from 7/27/20 or later) to fix a bug with events being sent to the wrong window, as well as a bug preventing Ctrl-R/S/T from working properly.

### 0.1.0

First public alpha release.
