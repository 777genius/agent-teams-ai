#ifdef _WIN32

#define WIN32_LEAN_AND_MEAN
#define _CRT_RAND_S
#include <windows.h>
#include <winternl.h>

#include "platform.h"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace desktop_file_lock {
namespace {

constexpr char kMagic[] = "agent-teams-desktop-file-lock-v3\nowner-key:";
constexpr size_t kOwnerBytes = 32;

#ifndef FILE_RENAME_FLAG_FAIL_IF_EXISTS
#define FILE_RENAME_FLAG_FAIL_IF_EXISTS 0x00000001
#endif
#ifndef FileRenameInfoEx
#define FileRenameInfoEx static_cast<FILE_INFO_BY_HANDLE_CLASS>(22)
#endif

using NtCreateFileFn = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
                                       PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG,
                                       ULONG, ULONG, PVOID, ULONG);

bool NtNameNotFound(NTSTATUS status) {
  const auto value = static_cast<ULONG>(status);
  return value == 0xC0000034UL || value == 0xC000003AUL;
}

struct Identity {
  DWORD volume = 0;
  DWORD high = 0;
  DWORD low = 0;
};

bool Same(const Identity& left, const Identity& right) {
  return left.volume == right.volume && left.high == right.high && left.low == right.low;
}

Result Acquired() { return {ResultKind::kAcquired, {}}; }
Result Uncertain(const std::string& message) { return {ResultKind::kUncertain, message}; }
Result Unsupported(const std::string& message) { return {ResultKind::kUnsupported, message}; }

std::string WinError(const char* operation, DWORD error = GetLastError()) {
  return std::string(operation) + " (Windows error " + std::to_string(error) + ")";
}

bool Utf8(const std::string& input, std::wstring* output) {
  if (input.empty()) {
    output->clear();
    return true;
  }
  int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
                                 static_cast<int>(input.size()), nullptr, 0);
  if (size <= 0) return false;
  output->resize(size);
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
                             static_cast<int>(input.size()), output->data(), size) == size;
}

bool FileIdentity(HANDLE handle, Identity* identity, bool require_directory = false) {
  BY_HANDLE_FILE_INFORMATION info;
  if (!GetFileInformationByHandle(handle, &info)) return false;
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return false;
  if (require_directory && (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) return false;
  identity->volume = info.dwVolumeSerialNumber;
  identity->high = info.nFileIndexHigh;
  identity->low = info.nFileIndexLow;
  return true;
}

NtCreateFileFn NtCreate() {
  static NtCreateFileFn function = reinterpret_cast<NtCreateFileFn>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
  return function;
}

HANDLE OpenAt(HANDLE parent, const std::wstring& name, ACCESS_MASK access,
              ULONG disposition, ULONG options, NTSTATUS* status = nullptr) {
  if (name.empty() || name.size() > 32760 || !NtCreate()) return INVALID_HANDLE_VALUE;
  UNICODE_STRING path;
  path.Buffer = const_cast<PWSTR>(name.data());
  path.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  path.MaximumLength = path.Length;
  OBJECT_ATTRIBUTES attributes;
  InitializeObjectAttributes(&attributes, &path, OBJ_CASE_INSENSITIVE, parent, nullptr);
  IO_STATUS_BLOCK io = {};
  HANDLE handle = INVALID_HANDLE_VALUE;
  NTSTATUS result = NtCreate()(&handle, access | SYNCHRONIZE, &attributes, &io, nullptr,
                               FILE_ATTRIBUTE_NORMAL,
                               FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                               disposition, options | FILE_SYNCHRONOUS_IO_NONALERT |
                               FILE_OPEN_REPARSE_POINT, nullptr, 0);
  if (status) *status = result;
  return result >= 0 ? handle : INVALID_HANDLE_VALUE;
}

bool OpenDirectoryComponents(HANDLE base, const std::vector<std::wstring>& parts,
                             HANDLE* result, Identity* identity,
                             ACCESS_MASK final_access = FILE_LIST_DIRECTORY |
                                                        FILE_READ_ATTRIBUTES) {
  HANDLE current = INVALID_HANDLE_VALUE;
  if (!DuplicateHandle(GetCurrentProcess(), base, GetCurrentProcess(), &current, 0, FALSE,
                       DUPLICATE_SAME_ACCESS)) return false;
  for (size_t index = 0; index < parts.size(); ++index) {
    const std::wstring& part = parts[index];
    ACCESS_MASK access = index + 1 == parts.size()
                             ? final_access
                             : FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES;
    HANDLE next = OpenAt(current, part, access,
                         FILE_OPEN, FILE_DIRECTORY_FILE);
    CloseHandle(current);
    if (next == INVALID_HANDLE_VALUE) return false;
    Identity next_identity;
    if (!FileIdentity(next, &next_identity, true)) {
      CloseHandle(next);
      return false;
    }
    current = next;
  }
  if (!FileIdentity(current, identity, true)) {
    CloseHandle(current);
    return false;
  }
  *result = current;
  return true;
}

bool SplitWindowsPath(const std::wstring& value, std::vector<std::wstring>* parts) {
  size_t offset = 0;
  while (offset < value.size()) {
    while (offset < value.size() && (value[offset] == L'\\' || value[offset] == L'/')) ++offset;
    if (offset == value.size()) break;
    size_t slash = value.find_first_of(L"\\/", offset);
    size_t end = slash == std::wstring::npos ? value.size() : slash;
    std::wstring part = value.substr(offset, end - offset);
    if (part.empty() || part == L"." || part == L".." || part.find(L':') != std::wstring::npos) {
      return false;
    }
    parts->push_back(std::move(part));
    if (slash == std::wstring::npos) break;
    offset = slash + 1;
  }
  return !parts->empty();
}

bool SplitTarget(const std::string& value, std::vector<std::wstring>* parents,
                 std::wstring* leaf) {
  if (value.empty() || value.size() > kMaxRelativeTargetBytes || value[0] == '/' ||
      value[0] == '\\') return false;
  std::vector<std::wstring> parts;
  size_t offset = 0;
  while (offset <= value.size()) {
    size_t slash = value.find_first_of("/\\", offset);
    size_t end = slash == std::string::npos ? value.size() : slash;
    std::string raw = value.substr(offset, end - offset);
    std::wstring part;
    if (raw.empty() || raw == "." || raw == ".." || raw.find(':') != std::string::npos ||
        !Utf8(raw, &part)) return false;
    parts.push_back(std::move(part));
    if (slash == std::string::npos) break;
    offset = slash + 1;
  }
  *leaf = std::move(parts.back());
  parts.pop_back();
  *parents = std::move(parts);
  return true;
}

bool RandomHex(std::string* output) {
  unsigned char bytes[16];
  for (size_t offset = 0; offset < sizeof(bytes); offset += sizeof(unsigned int)) {
    unsigned int value = 0;
    if (rand_s(&value) != 0) return false;
    size_t remaining = sizeof(bytes) - offset;
    memcpy(bytes + offset, &value, remaining < sizeof(value) ? remaining : sizeof(value));
  }
  constexpr char alphabet[] = "0123456789abcdef";
  output->assign(sizeof(bytes) * 2, '0');
  for (size_t index = 0; index < sizeof(bytes); ++index) {
    (*output)[index * 2] = alphabet[bytes[index] >> 4];
    (*output)[index * 2 + 1] = alphabet[bytes[index] & 15];
  }
  return true;
}

bool WriteAll(HANDLE handle, const char* data, size_t size) {
  size_t offset = 0;
  while (offset < size) {
    DWORD chunk = static_cast<DWORD>((size - offset) > MAXDWORD ? MAXDWORD : size - offset);
    DWORD written = 0;
    if (!WriteFile(handle, data + offset, chunk, &written, nullptr) || written == 0) return false;
    offset += written;
  }
  return true;
}

bool ReadPrefix(HANDLE handle, std::string* output, size_t size) {
  LARGE_INTEGER zero = {};
  if (!SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN)) return false;
  output->assign(size, '\0');
  size_t offset = 0;
  while (offset < size) {
    DWORD read = 0;
    if (!ReadFile(handle, output->data() + offset, static_cast<DWORD>(size - offset),
                  &read, nullptr) || read == 0) return false;
    offset += read;
  }
  return true;
}

bool ParseHeader(HANDLE marker, std::string* owner, size_t* header_size) {
  BY_HANDLE_FILE_INFORMATION info;
  if (!GetFileInformationByHandle(marker, &info) || info.nNumberOfLinks != 1 ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    return false;
  }
  LARGE_INTEGER size;
  if (!GetFileSizeEx(marker, &size) || size.QuadPart < 0 ||
      static_cast<uint64_t>(size.QuadPart) > kMaxMarkerBytes) return false;
  size_t prefix = sizeof(kMagic) - 1;
  size_t fixed = prefix + kOwnerBytes + 1;
  if (static_cast<uint64_t>(size.QuadPart) < fixed) return false;
  std::string header;
  if (!ReadPrefix(marker, &header, fixed) || header.compare(0, prefix, kMagic) != 0 ||
      header.back() != '\n') return false;
  *owner = header.substr(prefix, kOwnerBytes);
  for (char value : *owner) {
    if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) return false;
  }
  *header_size = fixed;
  return true;
}

bool DeleteOnClose(HANDLE handle) {
  FILE_DISPOSITION_INFO disposition = {};
  disposition.DeleteFile = TRUE;
  return SetFileInformationByHandle(handle, FileDispositionInfo, &disposition,
                                    sizeof(disposition)) != FALSE;
}

bool RenameNoReplace(HANDLE handle, HANDLE parent, const std::wstring& name) {
  size_t bytes = sizeof(FILE_RENAME_INFO) + name.size() * sizeof(wchar_t);
  std::vector<unsigned char> storage(bytes);
  auto* info = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
  info->ReplaceIfExists = FALSE;
  info->RootDirectory = parent;
  info->FileNameLength = static_cast<DWORD>(name.size() * sizeof(wchar_t));
  memcpy(info->FileName, name.data(), info->FileNameLength);
  return SetFileInformationByHandle(handle, FileRenameInfo, info, static_cast<DWORD>(bytes)) != FALSE;
}

std::mutex owners_mutex;
std::unordered_set<std::string> local_owners;

class WindowsScope;

class WindowsLease final : public PlatformLease {
 public:
  WindowsLease(WindowsScope* scope, HANDLE parent, Identity parent_id,
               std::vector<std::wstring> parts, std::wstring marker_name, HANDLE marker,
               Identity marker_id, std::string owner, size_t header_size)
      : scope_(scope), parent_(parent), parent_id_(parent_id), parts_(std::move(parts)),
        marker_name_(std::move(marker_name)), marker_(marker), marker_id_(marker_id),
        owner_(std::move(owner)), header_size_(header_size) {}
  ~WindowsLease() override { Close(); }
  Result AssertOwned() override;
  Result PublishRelease(const std::string& record) override;
  Result Release(bool verify) override;
  const std::string& OwnerKey() const override { return owner_; }

 private:
  friend class WindowsScope;
  Result WriteRecord(char kind, const std::string& record);
  void Close();
  WindowsScope* scope_;
  HANDLE parent_;
  Identity parent_id_;
  std::vector<std::wstring> parts_;
  std::wstring marker_name_;
  HANDLE marker_;
  Identity marker_id_;
  std::string owner_;
  size_t header_size_;
};

class WindowsScope final : public PlatformScope {
 public:
  WindowsScope(HANDLE namespace_root, std::vector<std::wstring> root_parts,
               HANDLE anchor, std::wstring name, HANDLE root, Identity root_id)
      : namespace_root_(namespace_root), root_parts_(std::move(root_parts)), anchor_(anchor),
        name_(std::move(name)), root_(root), root_id_(root_id) {}
  ~WindowsScope() override {
    if (root_ != INVALID_HANDLE_VALUE) CloseHandle(root_);
    if (anchor_ != INVALID_HANDLE_VALUE) CloseHandle(anchor_);
    if (namespace_root_ != INVALID_HANDLE_VALUE) CloseHandle(namespace_root_);
  }
  Result TryAcquire(const std::string&, const std::string&,
                    std::unique_ptr<PlatformLease>*) override;
  bool VerifyRoot() const {
    HANDLE resolved = INVALID_HANDLE_VALUE;
    Identity resolved_id;
    if (!OpenDirectoryComponents(namespace_root_, root_parts_, &resolved, &resolved_id)) return false;
    CloseHandle(resolved);
    if (!Same(resolved_id, root_id_)) return false;
    HANDLE current = OpenAt(anchor_, name_, FILE_READ_ATTRIBUTES, FILE_OPEN,
                            FILE_DIRECTORY_FILE);
    if (current == INVALID_HANDLE_VALUE) return false;
    Identity id;
    bool valid = FileIdentity(current, &id, true) && Same(id, root_id_);
    CloseHandle(current);
    return valid;
  }
  bool OpenParent(const std::vector<std::wstring>& parts, HANDLE* result,
                  Identity* identity) const {
    if (parts.empty()) {
      return OpenDirectoryComponents(root_, parts, result, identity,
                                     FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES |
                                     FILE_ADD_FILE | FILE_DELETE_CHILD);
    }
    return OpenDirectoryComponents(root_, parts, result, identity,
                                   FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES |
                                   FILE_ADD_FILE | FILE_DELETE_CHILD);
  }
  bool VerifyParent(const std::vector<std::wstring>& parts, const Identity& expected) const {
    HANDLE current;
    Identity identity;
    if (!VerifyRoot() || !OpenParent(parts, &current, &identity)) return false;
    CloseHandle(current);
    return Same(identity, expected);
  }

 private:
  HANDLE namespace_root_;
  std::vector<std::wstring> root_parts_;
  HANDLE anchor_;
  std::wstring name_;
  HANDLE root_;
  Identity root_id_;
};

Result WindowsLease::AssertOwned() {
  if (marker_ == INVALID_HANDLE_VALUE || !scope_->VerifyParent(parts_, parent_id_)) {
    return Uncertain("Native file-lock root or target parent was substituted");
  }
  Identity held;
  HANDLE current = OpenAt(parent_, marker_name_, FILE_READ_ATTRIBUTES, FILE_OPEN,
                          FILE_NON_DIRECTORY_FILE);
  Identity path;
  bool valid = FileIdentity(marker_, &held) && current != INVALID_HANDLE_VALUE &&
               FileIdentity(current, &path) && Same(held, marker_id_) && Same(path, marker_id_);
  if (current != INVALID_HANDLE_VALUE) CloseHandle(current);
  if (!valid) return Uncertain("Native file-lock marker identity was lost");
  std::string current_owner;
  size_t current_header_size = 0;
  if (!ParseHeader(marker_, &current_owner, &current_header_size) ||
      current_owner != owner_ || current_header_size != header_size_) {
    return Uncertain("Native file-lock immutable marker header was modified");
  }
  return Acquired();
}

Result WindowsLease::WriteRecord(char kind, const std::string& record) {
  Result owned = AssertOwned();
  if (owned.kind != ResultKind::kAcquired) return owned;
  std::string framed(1, kind);
  framed += "-bytes:" + std::to_string(record.size()) + "\n" + record;
  if (header_size_ + framed.size() > kMaxMarkerBytes) return Unsupported("Marker record is too large");
  LARGE_INTEGER position;
  position.QuadPart = static_cast<LONGLONG>(header_size_);
  if (!SetFilePointerEx(marker_, position, nullptr, FILE_BEGIN) || !SetEndOfFile(marker_) ||
      !WriteAll(marker_, framed.data(), framed.size()) || !FlushFileBuffers(marker_)) {
    return Uncertain(WinError("publish native file-lock record"));
  }
  return AssertOwned();
}

Result WindowsLease::PublishRelease(const std::string& record) {
  if (record.size() > kMaxReleaseRecordBytes) return Unsupported("Release record exceeds 4096 bytes");
  return WriteRecord('r', record);
}

void WindowsLease::Close() {
  if (marker_ != INVALID_HANDLE_VALUE) {
    OVERLAPPED range = {};
    UnlockFileEx(marker_, 0, 1, 0, &range);
    CloseHandle(marker_);
    marker_ = INVALID_HANDLE_VALUE;
  }
  if (parent_ != INVALID_HANDLE_VALUE) {
    CloseHandle(parent_);
    parent_ = INVALID_HANDLE_VALUE;
  }
  std::lock_guard<std::mutex> guard(owners_mutex);
  local_owners.erase(owner_);
}

Result WindowsLease::Release(bool verify) {
  Result result = verify ? AssertOwned() : Acquired();
  Close();
  return result;
}

Result WindowsScope::TryAcquire(const std::string& target, const std::string& active,
                                std::unique_ptr<PlatformLease>* output) {
  if (active.size() > kMaxActiveMarkerBytes) return Unsupported("Active marker exceeds 4096 bytes");
  if (!VerifyRoot()) return Uncertain("Native file-lock authority root was substituted");
  std::vector<std::wstring> parts;
  std::wstring leaf;
  if (!SplitTarget(target, &parts, &leaf)) return Uncertain("Target must be a safe relative path");
  HANDLE parent;
  Identity parent_id;
  if (!OpenParent(parts, &parent, &parent_id)) return Uncertain(WinError("open target parent"));
  std::wstring marker_name = leaf + L".lock";
  NTSTATUS publishing_status = 0;
  HANDLE publishing = OpenAt(parent, marker_name + L".publishing", FILE_READ_ATTRIBUTES,
                              FILE_OPEN, 0, &publishing_status);
  if (publishing != INVALID_HANDLE_VALUE) {
    CloseHandle(publishing);
    CloseHandle(parent);
    return Uncertain("Legacy or unknown .publishing artifact is present");
  }
  if (!NtNameNotFound(publishing_status)) {
    CloseHandle(parent);
    return Uncertain("Cannot exclude a legacy or unknown .publishing artifact");
  }
  NTSTATUS marker_status = 0;
  HANDLE marker = OpenAt(parent, marker_name, GENERIC_READ | GENERIC_WRITE, FILE_OPEN,
                         FILE_NON_DIRECTORY_FILE, &marker_status);
  if (marker == INVALID_HANDLE_VALUE) {
    if (!NtNameNotFound(marker_status)) {
      CloseHandle(parent);
      return Uncertain("Existing .lock artifact cannot be safely inspected");
    }
    std::string owner;
    std::string random;
    if (!VerifyParent(parts, parent_id) || !RandomHex(&owner) || !RandomHex(&random)) {
      CloseHandle(parent);
      return Uncertain("Cannot safely publish native file-lock marker");
    }
    std::wstring temporary;
    Utf8(".atflv3-" + random, &temporary);
    HANDLE temporary_handle = OpenAt(parent, temporary, GENERIC_READ | GENERIC_WRITE | DELETE,
                                     FILE_CREATE, FILE_NON_DIRECTORY_FILE);
    if (temporary_handle == INVALID_HANDLE_VALUE) {
      CloseHandle(parent);
      return Unsupported(WinError("create marker temporary"));
    }
    std::string content = std::string(kMagic) + owner + "\na-bytes:" +
                          std::to_string(active.size()) + "\n" + active;
    bool written = WriteAll(temporary_handle, content.data(), content.size()) &&
                   FlushFileBuffers(temporary_handle);
    bool renamed = written && RenameNoReplace(temporary_handle, parent, marker_name);
    DWORD rename_error = renamed ? ERROR_SUCCESS : GetLastError();
    if (!renamed) DeleteOnClose(temporary_handle);
    CloseHandle(temporary_handle);
    if (!written) {
      CloseHandle(parent);
      return Uncertain(WinError("publish complete marker"));
    }
    marker = OpenAt(parent, marker_name, GENERIC_READ | GENERIC_WRITE, FILE_OPEN,
                    FILE_NON_DIRECTORY_FILE);
    if (marker == INVALID_HANDLE_VALUE && rename_error == ERROR_NOT_SUPPORTED) {
      CloseHandle(parent);
      return Unsupported(WinError("atomic no-replace marker publication", rename_error));
    }
  }
  if (marker == INVALID_HANDLE_VALUE) {
    CloseHandle(parent);
    return Uncertain(WinError("open V3 marker"));
  }
  Identity marker_id;
  std::string owner;
  size_t header_size;
  if (!FileIdentity(marker, &marker_id) || !ParseHeader(marker, &owner, &header_size)) {
    CloseHandle(marker);
    CloseHandle(parent);
    return Uncertain("Existing .lock artifact is not a complete branded V3 marker");
  }
  {
    std::lock_guard<std::mutex> guard(owners_mutex);
    if (local_owners.count(owner)) {
      CloseHandle(marker);
      CloseHandle(parent);
      return {ResultKind::kContended, "Native file lock is held in this process"};
    }
    local_owners.insert(owner);
  }
  OVERLAPPED range = {};
  if (!LockFileEx(marker, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &range)) {
    DWORD error = GetLastError();
    {
      std::lock_guard<std::mutex> guard(owners_mutex);
      local_owners.erase(owner);
    }
    CloseHandle(marker);
    CloseHandle(parent);
    if (error == ERROR_LOCK_VIOLATION || error == ERROR_IO_PENDING) {
      return {ResultKind::kContended, "Native file lock is held by another process"};
    }
    return error == ERROR_NOT_SUPPORTED ? Unsupported(WinError("lock marker", error))
                                        : Uncertain(WinError("lock marker", error));
  }
  auto lease = std::make_unique<WindowsLease>(this, parent, parent_id, parts, marker_name,
                                               marker, marker_id, owner, header_size);
  Result checked = lease->AssertOwned();
  if (checked.kind != ResultKind::kAcquired) return checked;
  Result written = lease->WriteRecord('a', active);
  if (written.kind != ResultKind::kAcquired) return written;
  *output = std::move(lease);
  return Acquired();
}

Result CaptureWindowsScope(const std::string& authority_root,
                           std::unique_ptr<PlatformScope>* output) {
  std::wstring input;
  if (!Utf8(authority_root, &input) || input.empty()) return Uncertain("Invalid UTF-8 authority root");
  DWORD needed = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
  std::wstring full(needed, L'\0');
  if (needed == 0 || GetFullPathNameW(input.c_str(), needed, full.data(), nullptr) == 0) {
    return Uncertain(WinError("resolve authority root"));
  }
  full.resize(wcslen(full.c_str()));
  while (full.size() > 3 && (full.back() == L'\\' || full.back() == L'/')) full.pop_back();
  wchar_t volume[MAX_PATH];
  if (!GetVolumePathNameW(full.c_str(), volume, MAX_PATH)) {
    return Uncertain(WinError("resolve authority-root volume"));
  }
  UINT drive_type = GetDriveTypeW(volume);
  if (drive_type != DRIVE_FIXED && drive_type != DRIVE_REMOVABLE && drive_type != DRIVE_RAMDISK) {
    return Unsupported("Authority-root volume has no proven server-visible lock capability");
  }
  size_t volume_length = wcslen(volume);
  if (full.size() < volume_length ||
      CompareStringOrdinal(full.data(), static_cast<int>(volume_length), volume,
                           static_cast<int>(volume_length), TRUE) != CSTR_EQUAL) {
    return Uncertain("Authority root is outside its resolved volume capability");
  }
  std::vector<std::wstring> root_parts;
  if (!SplitWindowsPath(full.substr(volume_length), &root_parts)) {
    return Unsupported("Volume roots cannot provide replace-detecting scope anchors");
  }
  HANDLE namespace_root = CreateFileW(volume, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                              OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                              nullptr);
  if (namespace_root == INVALID_HANDLE_VALUE) return Uncertain(WinError("open volume capability"));
  std::vector<std::wstring> parent_parts(root_parts.begin(), root_parts.end() - 1);
  HANDLE parent = INVALID_HANDLE_VALUE;
  Identity parent_id;
  if (!OpenDirectoryComponents(namespace_root, parent_parts, &parent, &parent_id)) {
    CloseHandle(namespace_root);
    return Uncertain("Authority-root parent traversal encountered a reparse or substitution");
  }
  std::wstring name = root_parts.back();
  HANDLE root = OpenAt(parent, name, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES |
                       FILE_ADD_FILE | FILE_DELETE_CHILD, FILE_OPEN, FILE_DIRECTORY_FILE);
  Identity root_id;
  if (root == INVALID_HANDLE_VALUE || !FileIdentity(root, &root_id, true)) {
    if (root != INVALID_HANDLE_VALUE) CloseHandle(root);
    CloseHandle(parent);
    CloseHandle(namespace_root);
    return Uncertain("Authority root is missing, substituted, or a reparse point");
  }
  output->reset(new WindowsScope(namespace_root, root_parts, parent, name, root, root_id));
  return Acquired();
}

}  // namespace


Result CapturePlatformScope(const std::string& authority_root,
                            std::unique_ptr<PlatformScope>* output) {
  return CaptureWindowsScope(authority_root, output);
}

}  // namespace desktop_file_lock

#endif
