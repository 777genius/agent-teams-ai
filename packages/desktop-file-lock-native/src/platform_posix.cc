#ifndef _WIN32

#include "platform.h"

#include <cerrno>
#include <climits>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <mutex>
#include <string>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <unordered_set>
#include <utility>
#include <vector>

#ifdef __linux__
#include <sys/random.h>
#include <sys/statfs.h>
#else
#include <sys/mount.h>
#endif

namespace desktop_file_lock {
namespace {

constexpr char kMagic[] = "agent-teams-desktop-file-lock-v3\nowner-key:";
constexpr size_t kOwnerBytes = 32;

struct Identity {
  dev_t device = 0;
  ino_t inode = 0;
};

bool Same(const Identity& left, const Identity& right) {
  return left.device == right.device && left.inode == right.inode;
}

Identity Id(const struct stat& value) { return {value.st_dev, value.st_ino}; }

Result Acquired() { return {ResultKind::kAcquired, {}}; }
Result Uncertain(const std::string& message) { return {ResultKind::kUncertain, message}; }
Result Unsupported(const std::string& message) { return {ResultKind::kUnsupported, message}; }

std::string Error(const char* operation, int number = errno) {
  return std::string(operation) + ": " + std::strerror(number);
}

bool IsHex(char value) {
  return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
}

bool RandomBytes(unsigned char* output, size_t size) {
#ifdef __linux__
  size_t offset = 0;
  while (offset < size) {
    ssize_t count = getrandom(output + offset, size - offset, 0);
    if (count > 0) {
      offset += static_cast<size_t>(count);
    } else if (count < 0 && errno != EINTR) {
      return false;
    }
  }
#else
  arc4random_buf(output, size);
#endif
  return true;
}

std::string RandomHex() {
  unsigned char bytes[16];
  if (!RandomBytes(bytes, sizeof(bytes))) return {};
  constexpr char alphabet[] = "0123456789abcdef";
  std::string result(sizeof(bytes) * 2, '0');
  for (size_t index = 0; index < sizeof(bytes); ++index) {
    result[index * 2] = alphabet[bytes[index] >> 4];
    result[index * 2 + 1] = alphabet[bytes[index] & 15];
  }
  return result;
}

bool WriteAll(int descriptor, const char* data, size_t size) {
  size_t offset = 0;
  while (offset < size) {
    ssize_t count = write(descriptor, data + offset, size - offset);
    if (count > 0) offset += static_cast<size_t>(count);
    else if (count < 0 && errno != EINTR) return false;
  }
  return true;
}

bool PwriteAll(int descriptor, const char* data, size_t size, off_t start) {
  size_t offset = 0;
  while (offset < size) {
    ssize_t count = pwrite(descriptor, data + offset, size - offset,
                           start + static_cast<off_t>(offset));
    if (count > 0) offset += static_cast<size_t>(count);
    else if (count < 0 && errno != EINTR) return false;
  }
  return true;
}

bool ReadAllAt(int descriptor, std::string* output, size_t size) {
  output->assign(size, '\0');
  size_t offset = 0;
  while (offset < size) {
    ssize_t count = pread(descriptor, output->data() + offset, size - offset,
                          static_cast<off_t>(offset));
    if (count > 0) offset += static_cast<size_t>(count);
    else if (count == 0) return false;
    else if (errno != EINTR) return false;
  }
  return true;
}

bool SplitRelativeTarget(const std::string& value, std::vector<std::string>* parents,
                         std::string* leaf) {
  if (value.empty() || value.size() > kMaxRelativeTargetBytes || value[0] == '/') return false;
  size_t offset = 0;
  std::vector<std::string> parts;
  while (offset <= value.size()) {
    size_t slash = value.find('/', offset);
    size_t end = slash == std::string::npos ? value.size() : slash;
    std::string part = value.substr(offset, end - offset);
    if (part.empty() || part == "." || part == ".." || part.find('\0') != std::string::npos) {
      return false;
    }
    parts.push_back(std::move(part));
    if (slash == std::string::npos) break;
    offset = slash + 1;
  }
  if (parts.empty()) return false;
  *leaf = std::move(parts.back());
  parts.pop_back();
  *parents = std::move(parts);
  return true;
}

int Duplicate(int descriptor) {
#ifdef F_DUPFD_CLOEXEC
  return fcntl(descriptor, F_DUPFD_CLOEXEC, 0);
#else
  return dup(descriptor);
#endif
}

bool OpenParentAt(int root, const std::vector<std::string>& components, int* output,
                  Identity* identity, std::string* failure) {
  int current = Duplicate(root);
  if (current < 0) {
    *failure = Error("duplicate scope capability");
    return false;
  }
  for (const std::string& component : components) {
    int next = openat(current, component.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int saved = errno;
    close(current);
    if (next < 0) {
      errno = saved;
      *failure = Error("open target parent capability");
      return false;
    }
    current = next;
  }
  struct stat value;
  if (fstat(current, &value) != 0 || !S_ISDIR(value.st_mode)) {
    *failure = Error("inspect target parent capability");
    close(current);
    return false;
  }
  *identity = Id(value);
  *output = current;
  return true;
}

bool IsUnsupportedLockError(int value) {
  return value == ENOLCK || value == ENOSYS || value == EOPNOTSUPP;
}

bool IsUnsupportedFilesystem(int descriptor) {
#ifdef __linux__
  struct statfs info;
  if (fstatfs(descriptor, &info) != 0) return true;
  // Fail closed for remote, FUSE, and unknown filesystems. These local implementations provide
  // kernel-visible POSIX record locks shared by all processes on the host.
  constexpr long kExt = 0xEF53;
  constexpr long kXfs = 0x58465342;
  constexpr long kBtrfs = 0x9123683E;
  constexpr long kTmpfs = 0x01021994;
  constexpr long kRamfs = 0x858458F6;
  constexpr long kOverlay = 0x794C7630;
  constexpr long kZfs = 0x2FC12FC1;
  constexpr long kF2fs = 0xF2F52010;
  constexpr long kJfs = 0x3153464A;
  return info.f_type != kExt && info.f_type != kXfs && info.f_type != kBtrfs &&
         info.f_type != kTmpfs && info.f_type != kRamfs && info.f_type != kOverlay &&
         info.f_type != kZfs && info.f_type != kF2fs && info.f_type != kJfs;
#else
  struct statfs info;
  if (fstatfs(descriptor, &info) != 0) return true;
  return std::strcmp(info.f_fstypename, "apfs") != 0 &&
         std::strcmp(info.f_fstypename, "hfs") != 0 &&
         std::strcmp(info.f_fstypename, "ufs") != 0 &&
         std::strcmp(info.f_fstypename, "msdos") != 0 &&
         std::strcmp(info.f_fstypename, "exfat") != 0;
#endif
}

std::mutex owners_mutex;
std::unordered_set<std::string> local_owners;

class PosixScope;

class PosixLease final : public PlatformLease {
 public:
  PosixLease(PosixScope* scope, int parent, Identity parent_identity,
             std::vector<std::string> parent_parts, std::string marker_name,
             int marker, Identity marker_identity, std::string owner, size_t header_size)
      : scope_(scope), parent_(parent), parent_identity_(parent_identity),
        parent_parts_(std::move(parent_parts)), marker_name_(std::move(marker_name)),
        marker_(marker), marker_identity_(marker_identity), owner_(std::move(owner)),
        header_size_(header_size) {}

  ~PosixLease() override { Close(); }
  Result AssertOwned() override;
  Result PublishRelease(const std::string& record) override;
  Result Release(bool verify) override;
  const std::string& OwnerKey() const override { return owner_; }

 private:
  friend class PosixScope;
  Result WriteRecord(char kind, const std::string& record);
  void Close();

  PosixScope* scope_;
  int parent_;
  Identity parent_identity_;
  std::vector<std::string> parent_parts_;
  std::string marker_name_;
  int marker_;
  Identity marker_identity_;
  std::string owner_;
  size_t header_size_;
};

class PosixScope final : public PlatformScope {
 public:
  PosixScope(int namespace_root, std::vector<std::string> root_parts, int anchor_parent,
             std::string anchor_name, Identity root_identity, int root)
      : namespace_root_(namespace_root), root_parts_(std::move(root_parts)),
        anchor_parent_(anchor_parent), anchor_name_(std::move(anchor_name)),
        root_identity_(root_identity), root_(root) {}
  ~PosixScope() override {
    if (root_ >= 0) close(root_);
    if (anchor_parent_ >= 0) close(anchor_parent_);
    if (namespace_root_ >= 0) close(namespace_root_);
  }

  Result TryAcquire(const std::string& relative_target, const std::string& active_marker,
                    std::unique_ptr<PlatformLease>* lease) override;

  bool VerifyRoot() const {
    struct stat current;
    struct stat held;
    int resolved = -1;
    Identity resolved_identity;
    std::string failure;
    bool path_valid = OpenParentAt(namespace_root_, root_parts_, &resolved,
                                   &resolved_identity, &failure);
    if (resolved >= 0) close(resolved);
    return path_valid && Same(root_identity_, resolved_identity) &&
           fstat(root_, &held) == 0 && S_ISDIR(held.st_mode) &&
           fstatat(anchor_parent_, anchor_name_.c_str(), &current, AT_SYMLINK_NOFOLLOW) == 0 &&
           S_ISDIR(current.st_mode) && Same(root_identity_, Id(held)) &&
           Same(root_identity_, Id(current));
  }

  bool VerifyParent(const std::vector<std::string>& parts, const Identity& expected) const {
    int current = -1;
    Identity identity;
    std::string failure;
    if (!VerifyRoot() || !OpenParentAt(root_, parts, &current, &identity, &failure)) return false;
    close(current);
    return Same(expected, identity);
  }

 private:
  int namespace_root_;
  std::vector<std::string> root_parts_;
  int anchor_parent_;
  std::string anchor_name_;
  Identity root_identity_;
  int root_;
};

bool ParseHeader(int descriptor, const struct stat& stats, std::string* owner,
                 size_t* header_size) {
  const size_t prefix_size = sizeof(kMagic) - 1;
  const size_t fixed_size = prefix_size + kOwnerBytes + 1;
  if (!S_ISREG(stats.st_mode) || stats.st_nlink != 1 || stats.st_size < 0 ||
      static_cast<uint64_t>(stats.st_size) > kMaxMarkerBytes ||
      static_cast<size_t>(stats.st_size) < fixed_size) return false;
  std::string header;
  if (!ReadAllAt(descriptor, &header, fixed_size) || header.compare(0, prefix_size, kMagic) != 0 ||
      header.back() != '\n') return false;
  *owner = header.substr(prefix_size, kOwnerBytes);
  for (char value : *owner) if (!IsHex(value)) return false;
  *header_size = fixed_size;
  return true;
}

Result PosixLease::AssertOwned() {
  if (marker_ < 0 || !scope_->VerifyRoot() ||
      !scope_->VerifyParent(parent_parts_, parent_identity_)) {
    return Uncertain("Native file-lock scope or target parent was substituted");
  }
  struct stat descriptor_stats;
  struct stat path_stats;
  if (fstat(marker_, &descriptor_stats) != 0 || !S_ISREG(descriptor_stats.st_mode) ||
      fstatat(parent_, marker_name_.c_str(), &path_stats, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(path_stats.st_mode) || !Same(marker_identity_, Id(descriptor_stats)) ||
      !Same(marker_identity_, Id(path_stats))) {
    return Uncertain("Native file-lock marker identity was lost");
  }
  std::string current_owner;
  size_t current_header_size = 0;
  if (!ParseHeader(marker_, descriptor_stats, &current_owner, &current_header_size) ||
      current_owner != owner_ || current_header_size != header_size_) {
    return Uncertain("Native file-lock immutable marker header was modified");
  }
  struct flock lock = {};
  lock.l_type = F_WRLCK;
  lock.l_whence = SEEK_SET;
  lock.l_start = 0;
  lock.l_len = 1;
  if (fcntl(marker_, F_SETLK, &lock) != 0) {
    return Uncertain(Error("reassert native file lock"));
  }
  return Acquired();
}

Result PosixLease::WriteRecord(char kind, const std::string& record) {
  Result owned = AssertOwned();
  if (owned.kind != ResultKind::kAcquired) return owned;
  std::string framed;
  framed.reserve(record.size() + 32);
  framed.push_back(kind);
  framed.append("-bytes:");
  framed.append(std::to_string(record.size()));
  framed.push_back('\n');
  framed.append(record);
  if (header_size_ + framed.size() > kMaxMarkerBytes) {
    return Unsupported("Native file-lock marker record exceeds its bounded size");
  }
  // The immutable brand/owner header is never truncated. An interrupted record remains reusable.
  if (ftruncate(marker_, static_cast<off_t>(header_size_)) != 0 ||
      !PwriteAll(marker_, framed.data(), framed.size(), static_cast<off_t>(header_size_)) ||
      ftruncate(marker_, static_cast<off_t>(header_size_ + framed.size())) != 0 ||
      fsync(marker_) != 0) {
    return Uncertain(Error("publish native file-lock record"));
  }
  return AssertOwned();
}

Result PosixLease::PublishRelease(const std::string& record) {
  if (record.size() > kMaxReleaseRecordBytes) {
    return Unsupported("Native file-lock release record exceeds 4096 bytes");
  }
  return WriteRecord('r', record);
}

void PosixLease::Close() {
  if (marker_ >= 0) {
    struct flock lock = {};
    lock.l_type = F_UNLCK;
    lock.l_whence = SEEK_SET;
    lock.l_start = 0;
    lock.l_len = 1;
    fcntl(marker_, F_SETLK, &lock);
    close(marker_);
    marker_ = -1;
  }
  if (parent_ >= 0) {
    close(parent_);
    parent_ = -1;
  }
  std::lock_guard<std::mutex> guard(owners_mutex);
  local_owners.erase(owner_);
}

Result PosixLease::Release(bool verify) {
  Result result = verify ? AssertOwned() : Acquired();
  Close();
  return result;
}

Result PosixScope::TryAcquire(const std::string& relative_target,
                              const std::string& active_marker,
                              std::unique_ptr<PlatformLease>* lease) {
  if (active_marker.size() > kMaxActiveMarkerBytes) {
    return Unsupported("Native file-lock active marker exceeds 4096 bytes");
  }
  if (!VerifyRoot()) return Uncertain("Native file-lock authority root was substituted");
  std::vector<std::string> parts;
  std::string leaf;
  if (!SplitRelativeTarget(relative_target, &parts, &leaf)) {
    return Uncertain("Native file-lock target must be a safe relative path");
  }
  std::string marker_name = leaf + ".lock";
  std::string publishing_name = marker_name + ".publishing";
  if (marker_name.size() > NAME_MAX) return Unsupported("Native file-lock marker name is too long");
  int parent = -1;
  Identity parent_identity;
  std::string failure;
  if (!OpenParentAt(root_, parts, &parent, &parent_identity, &failure)) return Uncertain(failure);
  struct stat publication;
  if (fstatat(parent, publishing_name.c_str(), &publication, AT_SYMLINK_NOFOLLOW) == 0 ||
      errno != ENOENT) {
    close(parent);
    return Uncertain("Legacy or unknown file-lock publishing artifact is present");
  }
  int marker = openat(parent, marker_name.c_str(), O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  if (marker < 0 && errno == ENOENT) {
    if (!VerifyRoot() || !VerifyParent(parts, parent_identity)) {
      close(parent);
      return Uncertain("Native file-lock target parent was substituted before publication");
    }
    std::string owner = RandomHex();
    std::string random = RandomHex();
    if (owner.empty() || random.empty()) {
      close(parent);
      return Unsupported("Secure native file-lock randomness is unavailable");
    }
    std::string temporary = ".atflv3-" + random;
    int temporary_fd = openat(parent, temporary.c_str(),
                              O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (temporary_fd < 0) {
      Result result = (errno == EACCES || errno == EROFS) ? Unsupported(Error("create marker"))
                                                          : Uncertain(Error("create marker"));
      close(parent);
      return result;
    }
    std::string content = std::string(kMagic) + owner + "\n" + "a-bytes:" +
                          std::to_string(active_marker.size()) + "\n" + active_marker;
    bool complete = WriteAll(temporary_fd, content.data(), content.size()) &&
                    fsync(temporary_fd) == 0;
    if (complete && linkat(parent, temporary.c_str(), parent, marker_name.c_str(), 0) != 0) {
      complete = errno == EEXIST;
    }
    int link_error = errno;
    close(temporary_fd);
    unlinkat(parent, temporary.c_str(), 0);
    if (!complete) {
      close(parent);
      errno = link_error;
      return IsUnsupportedLockError(errno) ? Unsupported(Error("publish marker"))
                                           : Uncertain(Error("publish marker"));
    }
    if (fsync(parent) != 0) {
      close(parent);
      return Uncertain(Error("sync marker directory"));
    }
    marker = openat(parent, marker_name.c_str(), O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  }
  if (marker < 0) {
    Result result = (errno == EACCES || errno == EROFS) ? Unsupported(Error("open marker"))
                                                        : Uncertain(Error("open marker"));
    close(parent);
    return result;
  }
  struct stat marker_stats;
  std::string owner;
  size_t header_size = 0;
  if (fstat(marker, &marker_stats) != 0 ||
      !ParseHeader(marker, marker_stats, &owner, &header_size)) {
    close(marker);
    close(parent);
    return Uncertain("Existing .lock artifact is not a complete branded V3 marker");
  }
  {
    std::lock_guard<std::mutex> guard(owners_mutex);
    if (local_owners.count(owner) != 0) {
      close(marker);
      close(parent);
      return {ResultKind::kContended, "Native file lock is held in this process"};
    }
    local_owners.insert(owner);
  }
  struct flock lock = {};
  lock.l_type = F_WRLCK;
  lock.l_whence = SEEK_SET;
  lock.l_start = 0;
  lock.l_len = 1;
  if (fcntl(marker, F_SETLK, &lock) != 0) {
    int lock_error = errno;
    {
      std::lock_guard<std::mutex> guard(owners_mutex);
      local_owners.erase(owner);
    }
    close(marker);
    close(parent);
    if (lock_error == EACCES || lock_error == EAGAIN) {
      return {ResultKind::kContended, "Native file lock is held by another process"};
    }
    return IsUnsupportedLockError(lock_error) ? Unsupported(Error("lock marker", lock_error))
                                               : Uncertain(Error("lock marker", lock_error));
  }
  auto acquired = std::make_unique<PosixLease>(this, parent, parent_identity, parts, marker_name,
                                                marker, Id(marker_stats), owner, header_size);
  Result check = acquired->AssertOwned();
  if (check.kind != ResultKind::kAcquired) return check;
  Result written = acquired->WriteRecord('a', active_marker);
  if (written.kind != ResultKind::kAcquired) return written;
  *lease = std::move(acquired);
  return Acquired();
}

Result CapturePosixScope(const std::string& authority_root,
                         std::unique_ptr<PlatformScope>* scope) {
  if (authority_root.empty() || authority_root[0] != '/' || authority_root.find('\0') != std::string::npos) {
    return Uncertain("Native file-lock authority root must be an absolute physical directory");
  }
  std::string root_path = authority_root;
  while (root_path.size() > 1 && root_path.back() == '/') root_path.pop_back();
  std::vector<std::string> root_parts;
  size_t offset = 1;
  while (offset <= root_path.size()) {
    size_t slash = root_path.find('/', offset);
    size_t end = slash == std::string::npos ? root_path.size() : slash;
    std::string part = root_path.substr(offset, end - offset);
    if (part.empty() || part == "." || part == "..") {
      return Uncertain("Authority root must not contain empty, dot, or parent components");
    }
    root_parts.push_back(std::move(part));
    if (slash == std::string::npos) break;
    offset = slash + 1;
  }
  if (root_parts.empty()) {
    return Unsupported("The filesystem root cannot be used as a replace-detecting lock scope");
  }
  int namespace_root = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (namespace_root < 0) return Uncertain(Error("open filesystem root capability"));
  std::vector<std::string> parent_parts(root_parts.begin(), root_parts.end() - 1);
  int parent = -1;
  Identity parent_identity;
  std::string traversal_failure;
  if (!OpenParentAt(namespace_root, parent_parts, &parent, &parent_identity,
                    &traversal_failure)) {
    close(namespace_root);
    return Uncertain(traversal_failure);
  }
  std::string name = root_parts.back();
  int root = openat(parent, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root < 0) {
    Result result = (errno == EACCES) ? Unsupported(Error("open authority root"))
                                      : Uncertain(Error("open authority root"));
    close(parent);
    close(namespace_root);
    return result;
  }
  struct stat stats;
  if (fstat(root, &stats) != 0 || !S_ISDIR(stats.st_mode)) {
    close(root);
    close(parent);
    close(namespace_root);
    return Uncertain("Native file-lock authority root is not a directory");
  }
  if (IsUnsupportedFilesystem(root)) {
    close(root);
    close(parent);
    close(namespace_root);
    return Unsupported("Authority root filesystem has no provable server-visible lock capability");
  }
  scope->reset(new PosixScope(namespace_root, root_parts, parent, name, Id(stats), root));
  return Acquired();
}

}  // namespace

Result CapturePlatformScope(const std::string& authority_root,
                            std::unique_ptr<PlatformScope>* scope) {
  return CapturePosixScope(authority_root, scope);
}

}  // namespace desktop_file_lock

#endif
