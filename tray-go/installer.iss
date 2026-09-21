#ifndef SourceDir
#define SourceDir "release\\MemoryLane-win32-x64"
#endif
#ifndef OutputDir
#define OutputDir "release"
#endif
#ifndef AppVersion
#define AppVersion "0.2.0"
#endif

[Setup]
AppId={{8C70D798-1C76-45A7-92B1-8C456BD8FA32}
AppName=MemoryLane
AppVersion={#AppVersion}
AppPublisher=MemoryLane
DefaultDirName={localappdata}\Programs\MemoryLane
DefaultGroupName=MemoryLane
OutputDir={#OutputDir}
OutputBaseFilename=MemoryLane-Setup
SetupIconFile=assets\icon.ico
UninstallDisplayIcon={app}\MemoryLane.exe
PrivilegesRequired=lowest
Compression=lzma2/ultra64
SolidCompression=yes
CloseApplications=force
RestartApplications=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Inno Setup 7+: builds a native 64-bit Setup.exe instead of the 32-bit
; stub Inno 6 always produces, regardless of ArchitecturesInstallIn64BitMode -
; matches this app being x64-only end to end (runtime, native modules,
; everything). Requires Inno Setup 7 or later to compile.
SetupArchitecture=x64

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\MemoryLane"; Filename: "{app}\MemoryLane.exe"; IconFilename: "{app}\MemoryLane.exe"
Name: "{userdesktop}\MemoryLane"; Filename: "{app}\MemoryLane.exe"; IconFilename: "{app}\MemoryLane.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Run]
Filename: "{app}\MemoryLane.exe"; Description: "Start MemoryLane"; Flags: nowait postinstall skipifsilent
