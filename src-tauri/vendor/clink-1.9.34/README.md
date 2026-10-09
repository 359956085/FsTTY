# Clink 1.9.34 — FsTTY isolated build

Upstream: https://github.com/chrisant996/clink/tree/v1.9.34 (4e8ae4).
Official portable archive: https://github.com/chrisant996/clink/releases/download/v1.9.34/clink.1.9.34.4e8ae4.zip.
Clink distribution documentation: https://chrisant996.github.io/clink/clink.html.

Clink is distributed under GPL-3.0 (see LICENSE). It includes Lua, GNU Readline,
Detours, getopt and other components; source.zip contains their license notices,
complete source and the upstream credits in docs/credits.md. FsTTY includes the
complete corresponding upstream source, our isolation.patch and build.ps1 here.
No external runtime download is needed. FsTTY-specific initialization scripts are
embedded in the host binary; source copies are shipped in fstty/ alongside these materials.

FsTTY modifications: script discovery uses only the explicit private --scripts
path (no HKCU registered extensions, environment path or user profile scripts);
FSTTY_HIGHLIGHT_ONLY suppresses directory shorthand; build version records fixed
upstream 4e8ae4. No system AutoRun/PATH changes. The managed highlighted CMD uses /d so an existing system AutoRun cannot pre-inject a user Clink. All binary SHA-256 values and
upstream archive hashes are in manifest.json. Embedded extraction checks byte
identity; elevated hosts reject replaceable/reparse roots and lock private files.

Build on Windows x64 using Visual Studio 2022 C++ tools, premake5 v5.0.0-beta8,
and Git. Run build.ps1 with paths to premake5.exe and MSBuild.exe. The script
extracts the supplied source, applies isolation.patch and builds final|x64.
Only clink_x64.exe and clink_dll_x64.dll are loaded; build tools are not shipped
or run on end-user machines. Binary hashes are specific to the recorded build;
other toolchain builds can differ. Upstream portable.zip is retained in this
repository for provenance, but is not installed as a second runtime component.
