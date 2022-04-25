# Change Log

All notable changes to the "craftos-pc" extension will be documented in this file.

## 1.1.8

* Fixed a bug causing disconnections when sending large data packets

## 1.1.6

* Added Run Script button to quickly run files in a new CraftOS-PC instance

## 1.1.5

* Added history to Open WebSocket button

## 1.1.4

* Terminal windows now automatically resize to fit the screen
* Fixed an issue causing the bug info prompt from 1.1.3 to not appear

## 1.1.3

* Added more information about VS Code "certificate has expired" bug
* Added a "CraftOS-PC: Force Close Connection" to close the connection immediately without waiting for a response
* Fixed an issue causing remote screens to go black

## 1.1.1

* Fixed mouse_up event not being sent

## 1.1.0

* Added ability to connect to WebSocket servers
* Added integration with new remote.craftos-pc.cc service (beta)
* Added support for raw mode 1.1 specification
* Added URI handler for WebSocket links
* Fixed security vulnerability in glob-parent dependency

## 1.0.2

* Fixed wrong mouse buttons being sent
* Fixed drag coordinates in the margins of the screen
* Fixed mouse drag events firing in the same cell after click

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

## 0.2.1

* Added an error message if the executable is missing
* Fixed `mouse_click` events being sent instead of `mouse_drag`

## 0.2.0

* Fixed performance issues causing high CPU usage and major slowdown
  * Render speed should now be about the same as in standard GUI mode
* Added `craftos-pc.additionalArguments` setting
* Added command to close the emulator session without having to close each window
* Fixed a bug causing CraftOS-PC to not start on Windows when a workspace is open

## 0.1.1

Fixes a bug where the wrong key events were being sent (e.g. `key_up` when pressing a key down). Also fixes `char` events being sent with modifier keys held.

Download the latest build of CraftOS-PC (from 7/27/20 or later) to fix a bug with events being sent to the wrong window, as well as a bug preventing Ctrl-R/S/T from working properly.

## 0.1.0

First public alpha release.