import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SpawnSyncOptions } from 'node:child_process';
import type { ValidatedRuntimeZipEntry } from './runtime-archive-extraction.mts';

const maximumManifestBytes = 128 * 1024 * 1024;
// Fixed code only. Dynamic paths and validated metadata never become PowerShell/C# source.
const readerSource = String.raw`
using System;
using System.IO;
using System.IO.Compression;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Text;
using System.Web.Script.Serialization;
public static class AgentTeamsRuntimeZipReader {
  public sealed class Manifest { public int version; public Entry[] entries; }
  public sealed class Entry {
    public string name; public long size; public long compressedSize;
    public uint crc32; public bool directory;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
  static extern bool CreateDirectoryW(string path, IntPtr security);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
  static extern uint GetFileAttributesW(string path);
  static string Extended(string value) {
    value = value.Replace('/', '\\');
    if (value.StartsWith(@"\\?\", StringComparison.Ordinal)) return value;
    if (value.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + value.Substring(2);
    if (value.Length >= 3 && Char.IsLetter(value[0]) && value[1] == ':' && value[2] == '\\') return @"\\?\" + value;
    throw new InvalidDataException("ZIP path must be absolute");
  }
  static FileStream Open(string path, bool write) {
    var handle = CreateFileW(Extended(path), write ? 0x40000000U : 0x80000000U, write ? 0U : 1U, IntPtr.Zero, write ? 1U : 3U, 0x08000080U, IntPtr.Zero);
    if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error, "ZIP file open failed"); }
    try { return new FileStream(handle, write ? FileAccess.Write : FileAccess.Read, 65536); }
    catch { handle.Dispose(); throw; }
  }
  static void DirectoryEntry(string path, HashSet<string> createdDirectories) {
    if (createdDirectories.Contains(path)) return;
    uint attributes = GetFileAttributesW(path);
    if (attributes == 0xffffffffU) {
      if (!CreateDirectoryW(path, IntPtr.Zero)) {
        int error = Marshal.GetLastWin32Error();
        if (error != 183) throw new Win32Exception(error, "ZIP directory creation failed");
      }
      attributes = GetFileAttributesW(path);
    }
    if (attributes == 0xffffffffU || (attributes & 0x10U) == 0 || (attributes & 0x400U) != 0)
      throw new InvalidDataException("ZIP directory is not a regular directory");
    createdDirectories.Add(path);
  }
  static string Target(string root, string name, bool directory, HashSet<string> createdDirectories) {
    var parts = new List<string>();
    foreach (string part in name.Replace('\\', '/').Split('/')) {
      if (part == "" || part == ".") continue;
      if (part == ".." || part.IndexOf(':') >= 0) throw new InvalidDataException("ZIP path escaped destination");
      parts.Add(part);
    }
    if (parts.Count == 0) throw new InvalidDataException("ZIP path escaped destination");
    string target = root;
    for (int index = 0; index < parts.Count; index++) {
      target += parts[index];
      if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("ZIP path escaped destination");
      if (index < parts.Count - 1 || directory) DirectoryEntry(target, createdDirectories);
      if (index < parts.Count - 1) target += @"\";
    }
    return target;
  }
  static readonly uint[] Table = MakeTable();
  static uint[] MakeTable() {
    uint[] result = new uint[256];
    for (uint i = 0; i < 256; i++) {
      uint c = i;
      for (int bit = 0; bit < 8; bit++) c = (c >> 1) ^ ((c & 1) == 0 ? 0U : 0xedb88320U);
      result[i] = c;
    }
    return result;
  }
  public static void Extract(string archivePath, string destination, string manifestPath) {
    const int limit = 128 * 1024 * 1024;
    var serializer = new JavaScriptSerializer { MaxJsonLength = limit };
    Manifest manifest;
    using (var file = Open(manifestPath, false)) {
      if (file.Length > limit) throw new InvalidDataException("ZIP manifest too large");
      using (var reader = new StreamReader(file, new UTF8Encoding(false, true))) manifest = serializer.Deserialize<Manifest>(reader.ReadToEnd());
    }
    if (manifest == null || manifest.version != 1 || manifest.entries == null)
      throw new InvalidDataException("Invalid ZIP manifest");
    string root = Extended(destination).TrimEnd('\\') + "\\";
    var createdDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    DirectoryEntry(Extended(destination), createdDirectories);
    using (var input = Open(archivePath, false))
    using (var archive = new ZipArchive(input, ZipArchiveMode.Read, false, new UTF8Encoding(false, true))) {
      if (archive.Entries.Count != manifest.entries.Length) throw new InvalidDataException("ZIP entry count mismatch");
      byte[] buffer = new byte[65536];
      for (int index = 0; index < manifest.entries.Length; index++) {
        var expected = manifest.entries[index];
        var entry = archive.Entries[index];
        if (expected == null || entry.FullName != expected.name || entry.Length != expected.size || entry.CompressedLength != expected.compressedSize)
          throw new InvalidDataException("ZIP entry metadata mismatch");
        string target = Target(root, expected.name, expected.directory, createdDirectories);
        using (var source = entry.Open())
        using (var output = expected.directory ? null : Open(target, true)) {
          long count = 0; uint crc = 0xffffffffU; int length;
          while ((length = source.Read(buffer, 0, buffer.Length)) != 0) {
            if (count > expected.size - length) throw new InvalidDataException("ZIP decompressed length mismatch");
            for (int i = 0; i < length; i++) crc = Table[(crc ^ buffer[i]) & 255] ^ (crc >> 8);
            if (output != null) output.Write(buffer, 0, length);
            count += length;
          }
          if (count != expected.size || ~crc != expected.crc32) throw new InvalidDataException("ZIP CRC32 or decompressed length mismatch");
        }
      }
    }
  }
}`;
const readerScript = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
${readerSource}
'@ -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.IO.Compression.dll', 'System.Web.Extensions.dll')
[AgentTeamsRuntimeZipReader]::Extract($env:AGENT_TEAMS_RUNTIME_ZIP_ARCHIVE, $env:AGENT_TEAMS_RUNTIME_ZIP_DESTINATION, $env:AGENT_TEAMS_RUNTIME_ZIP_MANIFEST)
`;

type RunReader = (command: string, args: string[], options: SpawnSyncOptions) => unknown;

/** Fixed inbox .NET reader; preflight facts authorize every output entry and its bytes. */
export function extractWindowsRuntimeZip(
  archivePath: string,
  destination: string,
  entries: readonly ValidatedRuntimeZipEntry[],
  environment: NodeJS.ProcessEnv,
  run: RunReader
): void {
  const systemRoot = environment.SystemRoot;
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:[\\/]/u.test(systemRoot))
    throw new Error('Windows runtime ZIP extraction requires an absolute SystemRoot');
  archivePath = path.resolve(archivePath);
  destination = path.resolve(destination);
  const metadata = JSON.stringify({ version: 1, entries });
  if (Buffer.byteLength(metadata) > maximumManifestBytes)
    throw new Error('Runtime ZIP manifest too large');
  const manifestPath = path.join(path.dirname(destination), `.runtime-zip-${randomUUID()}.json`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(manifestPath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, metadata);
    fs.closeSync(fd);
    fd = undefined;
    run(
      path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(readerScript, 'utf16le').toString('base64'),
      ],
      {
        shell: false,
        stdio: 'inherit',
        windowsHide: true,
        env: {
          ...environment,
          AGENT_TEAMS_RUNTIME_ZIP_ARCHIVE: archivePath,
          AGENT_TEAMS_RUNTIME_ZIP_DESTINATION: destination,
          AGENT_TEAMS_RUNTIME_ZIP_MANIFEST: manifestPath,
        },
      }
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) fs.rmSync(manifestPath, { force: true });
  }
}
