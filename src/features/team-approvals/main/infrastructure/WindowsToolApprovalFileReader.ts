import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  createToolApprovalFileContent,
  TOOL_APPROVAL_MAX_FILE_SIZE,
} from './ToolApprovalFileContent';

import type { ToolApprovalFileReaderPort } from '../../core/application/ports/TeamApprovalsPorts';
import type { ToolApprovalFileContent } from '@shared/types';

const WINDOWS_HELPER_TIMEOUT_MS = 15_000;
const WINDOWS_HELPER_MAX_OUTPUT_BYTES = Math.ceil((TOOL_APPROVAL_MAX_FILE_SIZE * 4) / 3) + 16_384;
const WINDOWS_PREVIEW_PATH_PLACEHOLDER = '__AGENT_TEAMS_APPROVAL_PREVIEW_PATH_BASE64__';
const WINDOWS_PREVIEW_STDIN_BOOTSTRAP =
  '$script = [Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($script))';

export interface WindowsPreviewHelperResult {
  exists: boolean;
  contentBase64?: string;
  truncated?: boolean;
  error?: string;
}

export interface WindowsPreviewHelperPort {
  read(filePath: string): Promise<WindowsPreviewHelperResult>;
}

const WINDOWS_PREVIEW_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$source = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace AgentTeams.SafePreview {
  public sealed class PreviewResult {
    public bool Exists;
    public byte[] Content;
    public bool Truncated;
    public string Error;
  }

  public static class Reader {
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const int ERROR_FILE_NOT_FOUND = 2;
    private const int ERROR_PATH_NOT_FOUND = 3;
    private const int MISSING_PATH_OPEN_ATTEMPTS = 2;

    private enum FileInfoByHandleClass {
      FileAttributeTagInfo = 9
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTagInfo {
      public uint FileAttributes;
      public uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation {
      public uint FileAttributes;
      public uint CreationTimeLow;
      public uint CreationTimeHigh;
      public uint LastAccessTimeLow;
      public uint LastAccessTimeHigh;
      public uint LastWriteTimeLow;
      public uint LastWriteTimeHigh;
      public uint VolumeSerialNumber;
      public uint FileSizeHigh;
      public uint FileSizeLow;
      public uint NumberOfLinks;
      public uint FileIndexHigh;
      public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
      string fileName,
      uint desiredAccess,
      uint shareMode,
      IntPtr securityAttributes,
      uint creationDisposition,
      uint flagsAndAttributes,
      IntPtr templateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(
      SafeFileHandle file,
      FileInfoByHandleClass fileInformationClass,
      out FileAttributeTagInfo fileInformation,
      uint bufferSize
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
      SafeFileHandle file,
      out ByHandleFileInformation fileInformation
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(
      SafeFileHandle file,
      StringBuilder filePath,
      uint filePathLength,
      uint flags
    );

    public static PreviewResult Read(string requestedPath, int maximumBytes) {
      string normalizedPath = Path.GetFullPath(requestedPath);
      for (int attempt = 0; attempt < MISSING_PATH_OPEN_ATTEMPTS; attempt++) {
        AssertNoReparsePoints(normalizedPath, true);
        SafeFileHandle file = OpenReadHandle(normalizedPath);
        if (file.IsInvalid) {
          int error = Marshal.GetLastWin32Error();
          file.Dispose();
          if (IsMissingPathError(error)) {
            using (SafeFileHandle parentBinding = OpenMissingParentBinding(normalizedPath)) {
              AssertNoReparsePoints(normalizedPath, true);
              if (attempt + 1 < MISSING_PATH_OPEN_ATTEMPTS) continue;
              return new PreviewResult { Exists = false, Content = new byte[0] };
            }
          }
          throw new Win32Exception(error);
        }

        using (file) {
          FileAttributeTagInfo openedInfo = GetAttributeTagInfo(file);
          if ((openedInfo.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
            return new PreviewResult {
              Exists = true,
              Content = new byte[0],
              Error = "Not a file"
            };
          }
          ByHandleFileInformation openedFileInfo = GetFileInformation(file);
          if (openedFileInfo.NumberOfLinks != 1 || !HasStableFileIndex(openedFileInfo)) {
            throw new InvalidOperationException(
              "Hard-linked files are not allowed in approval preview paths"
            );
          }

          AssertOpenedPathMatches(normalizedPath, file);

          AssertNoReparsePoints(normalizedPath, false);

          using (FileStream stream = new FileStream(file, FileAccess.Read)) {
            long initialLength = stream.Length;
            int readSize = (int)Math.Min(initialLength, maximumBytes);
            byte[] content = new byte[readSize];
            int bytesRead = 0;
            while (bytesRead < readSize) {
              int count = stream.Read(content, bytesRead, readSize - bytesRead);
              if (count == 0) break;
              bytesRead += count;
            }
            if (bytesRead != content.Length) Array.Resize(ref content, bytesRead);
            ByHandleFileInformation finalFileInfo = GetFileInformation(file);
            if (!HasStableFileInformation(openedFileInfo, finalFileInfo)) {
              throw new InvalidOperationException(
                "Approval preview path changed while the file was being read"
              );
            }
            AssertNoReparsePoints(normalizedPath, false);
            AssertOpenedPathMatches(normalizedPath, file);
            return new PreviewResult {
              Exists = true,
              Content = content,
              Truncated = stream.Length > bytesRead
            };
          }
        }
      }
      throw new InvalidOperationException("Safe approval preview could not classify the Windows path");
    }

    private static SafeFileHandle OpenReadHandle(string filePath) {
      return CreateFileW(
        filePath,
        GENERIC_READ,
        FILE_SHARE_READ,
        IntPtr.Zero,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS,
        IntPtr.Zero
      );
    }

    private static SafeFileHandle OpenMissingParentBinding(string filePath) {
      string parentPath = Path.GetDirectoryName(filePath);
      SafeFileHandle parent = CreateFileW(
        parentPath,
        0,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        IntPtr.Zero,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
        IntPtr.Zero
      );
      if (parent.IsInvalid) {
        int error = Marshal.GetLastWin32Error();
        parent.Dispose();
        throw new Win32Exception(error);
      }
      try {
        FileAttributeTagInfo info = GetAttributeTagInfo(parent);
        if (
          (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
          (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
        ) {
          throw new InvalidOperationException(
            "Safe approval preview rejected a redirected Windows path"
          );
        }
        AssertOpenedPathMatches(parentPath, parent);
        return parent;
      } catch {
        parent.Dispose();
        throw;
      }
    }

    private static bool IsMissingPathError(int error) {
      return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
    }

    private static void AssertNoReparsePoints(string filePath, bool allowMissingFinalComponent) {
      string root = Path.GetPathRoot(filePath);
      string currentPath = root;
      char[] separators = new char[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar };
      string[] segments = filePath.Substring(root.Length).Split(
        separators,
        StringSplitOptions.RemoveEmptyEntries
      );

      for (int index = 0; index < segments.Length; index++) {
        string segment = segments[index];
        currentPath = Path.Combine(currentPath, segment);
        using (SafeFileHandle component = CreateFileW(
          currentPath,
          0,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
          IntPtr.Zero,
          OPEN_EXISTING,
          FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
          IntPtr.Zero
        )) {
          if (component.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            bool isMissingFinalComponent =
              allowMissingFinalComponent &&
              index == segments.Length - 1 &&
              IsMissingPathError(error);
            if (isMissingFinalComponent) return;
            throw new Win32Exception(error);
          }
          FileAttributeTagInfo info = GetAttributeTagInfo(component);
          if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
            throw new InvalidOperationException(
              "Safe approval preview rejected a Windows reparse-point path: " + currentPath
            );
          }
        }
      }
    }

    private static FileAttributeTagInfo GetAttributeTagInfo(SafeFileHandle file) {
      FileAttributeTagInfo info;
      uint size = (uint)Marshal.SizeOf(typeof(FileAttributeTagInfo));
      if (!GetFileInformationByHandleEx(file, FileInfoByHandleClass.FileAttributeTagInfo, out info, size)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return info;
    }

    private static ByHandleFileInformation GetFileInformation(SafeFileHandle file) {
      ByHandleFileInformation info;
      if (!GetFileInformationByHandle(file, out info)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return info;
    }

    private static bool HasStableFileIndex(ByHandleFileInformation info) {
      return info.FileIndexHigh != 0 || info.FileIndexLow != 0;
    }

    private static bool HasStableFileInformation(
      ByHandleFileInformation before,
      ByHandleFileInformation after
    ) {
      return
        HasStableFileIndex(before) &&
        HasStableFileIndex(after) &&
        before.VolumeSerialNumber == after.VolumeSerialNumber &&
        before.FileIndexHigh == after.FileIndexHigh &&
        before.FileIndexLow == after.FileIndexLow &&
        before.FileSizeHigh == after.FileSizeHigh &&
        before.FileSizeLow == after.FileSizeLow &&
        before.LastWriteTimeHigh == after.LastWriteTimeHigh &&
        before.LastWriteTimeLow == after.LastWriteTimeLow &&
        before.NumberOfLinks == 1 &&
        after.NumberOfLinks == 1;
    }

    private static void AssertOpenedPathMatches(string requestedPath, SafeFileHandle file) {
      string comparisonRequestedPath = NormalizeKernelPath(requestedPath);
      string openedPath = NormalizeKernelPath(GetOpenedPath(file));
      if (!String.Equals(comparisonRequestedPath, openedPath, StringComparison.Ordinal)) {
        throw new InvalidOperationException("Safe approval preview rejected a redirected Windows path");
      }
    }

    private static string GetOpenedPath(SafeFileHandle file) {
      uint capacity = 512;
      while (true) {
        StringBuilder buffer = new StringBuilder((int)capacity);
        uint length = GetFinalPathNameByHandleW(file, buffer, capacity, 0);
        if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (length < capacity) return buffer.ToString();
        capacity = length + 1;
      }
    }

    private static string NormalizeKernelPath(string filePath) {
      const string uncPrefix = @"\\?\UNC\";
      const string devicePrefix = @"\\?\";
      if (filePath.StartsWith(uncPrefix, StringComparison.OrdinalIgnoreCase)) {
        filePath = @"\\" + filePath.Substring(uncPrefix.Length);
      } else if (filePath.StartsWith(devicePrefix, StringComparison.OrdinalIgnoreCase)) {
        filePath = filePath.Substring(devicePrefix.Length);
      }
      return NormalizeComparisonPath(filePath);
    }

    private static string NormalizeComparisonPath(string filePath) {
      string fullPath = Path.GetFullPath(filePath);
      string root = Path.GetPathRoot(fullPath);
      if (String.Equals(fullPath, root, StringComparison.OrdinalIgnoreCase)) return fullPath;
      return fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }
  }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp
  $encodedPath = '${WINDOWS_PREVIEW_PATH_PLACEHOLDER}'
  $filePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPath))
  $result = [AgentTeams.SafePreview.Reader]::Read($filePath, ${TOOL_APPROVAL_MAX_FILE_SIZE})
  [Console]::Out.Write(([pscustomobject]@{
    exists = $result.Exists
    contentBase64 = [Convert]::ToBase64String($result.Content)
    truncated = $result.Truncated
    error = $result.Error
  } | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.Write(([pscustomobject]@{
    exists = $true
    contentBase64 = ''
    truncated = $false
    error = $_.Exception.Message
  } | ConvertTo-Json -Compress))
}
`;

function resolveWindowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error('Safe Windows approval preview requires an absolute SystemRoot');
  }
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export class PowerShellWindowsPreviewHelper implements WindowsPreviewHelperPort {
  read(filePath: string): Promise<WindowsPreviewHelperResult> {
    return new Promise((resolve, reject) => {
      const encodedPath = Buffer.from(filePath, 'utf8').toString('base64');
      const previewScript = WINDOWS_PREVIEW_SCRIPT.replace(
        WINDOWS_PREVIEW_PATH_PLACEHOLDER,
        encodedPath
      );
      const encodedBootstrap = Buffer.from(WINDOWS_PREVIEW_STDIN_BOOTSTRAP, 'utf16le').toString(
        'base64'
      );
      const child = spawn(
        resolveWindowsPowerShellPath(),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedBootstrap],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;

      const finish = (error?: Error, result?: WindowsPreviewHelperResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else
          resolve(result ?? { exists: true, error: 'Windows preview helper returned no result' });
      };

      const timeout = setTimeout(() => {
        child.kill();
        finish(new Error('Safe Windows approval preview timed out'));
      }, WINDOWS_HELPER_TIMEOUT_MS);

      child.once('error', (error) => finish(error));
      child.stdin.once('error', (error) => finish(error));
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > WINDOWS_HELPER_MAX_OUTPUT_BYTES) {
          child.kill();
          finish(new Error('Windows preview helper exceeded its output limit'));
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrChunks.reduce((total, item) => total + item.length, 0) < 16_384) {
          stderrChunks.push(chunk);
        }
      });
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
          finish(new Error(stderr || `Windows preview helper exited with code ${String(code)}`));
          return;
        }
        try {
          finish(
            undefined,
            JSON.parse(Buffer.concat(stdoutChunks).toString('utf8')) as WindowsPreviewHelperResult
          );
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });

      child.stdin.end(previewScript, 'utf8');
    });
  }
}

export class WindowsToolApprovalFileReader implements ToolApprovalFileReaderPort {
  constructor(
    private readonly helper: WindowsPreviewHelperPort = new PowerShellWindowsPreviewHelper()
  ) {}

  async read(filePath: string): Promise<ToolApprovalFileContent> {
    try {
      const result = await this.helper.read(filePath);
      if (!result.exists) {
        return { content: '', exists: false, truncated: false, isBinary: false };
      }
      if (result.error) {
        return {
          content: '',
          exists: true,
          truncated: false,
          isBinary: false,
          error: result.error,
        };
      }
      return createToolApprovalFileContent(
        Buffer.from(result.contentBase64 ?? '', 'base64'),
        result.truncated ?? false
      );
    } catch (error) {
      return {
        content: '',
        exists: true,
        truncated: false,
        isBinary: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
