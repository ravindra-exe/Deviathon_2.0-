# Pearl Browser security baseline

- Remote tabs have Node integration disabled, context isolation enabled, sandboxing enabled, and web security enabled.
- Remote pages never receive the application preload bridge.
- IPC accepts commands only from the local chrome view and validates command shape and navigation input length.
- Ordinary navigation is limited to HTTP and HTTPS. Non-web navigation is blocked and handed to the OS only through Electron's external opener.
- Popups are denied and permission requests are denied by default.
- The local UI has a restrictive Content Security Policy.

This baseline does not provide an extension system, permission prompts, downloads policy, or persistent profile controls yet.
